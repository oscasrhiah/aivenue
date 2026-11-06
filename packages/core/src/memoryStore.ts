import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { maskText } from './bundle';
import { lockName, withOsLock } from './osLock';
import type { CheckoutVerification, MemoryEvidence, MemoryKind, MemorySource, ProjectMemory } from './types';

/**
 * One project's long-term memory (docs/memory-phase1.md §5–6), shared by every hub on this computer (the app and the
 * VS Code extension): an append-only log under an OS lock, a snapshot bound to the log's generation, a queue of
 * masked candidates with their op ids fixed before the first attempt, and deletions that leave nothing behind even
 * when the process dies half way.
 */

export interface MemoryCandidate {
  /** Fixed by the caller before the first attempt, so a retry never writes twice. */
  opId?: string;
  kind: MemoryKind;
  text: string;
  conditions?: string;
  environment?: string;
  check?: { command: string; expectExit: number };
  source: MemorySource;
  evidence?: MemoryEvidence[];
  lifecycle: 'candidate' | 'active';
  approvedBy?: 'auto' | 'user';
  /**
   * The user creating it on purpose (not something taken from a workflow's records): a deletion's tombstone does
   * not stop it, since the user may deliberately remember again what they deleted. Taking from records stays blocked.
   */
  explicit?: boolean;
}

/** What happened to one queued candidate. */
export type QueueOutcome = { status: 'added' | 'merged'; memoryId: string } | { status: 'held'; memoryId: string } | { status: 'rejected' | 'conflict' };

/** What the workflow may change by itself; everything else (text, conditions, check, lock, approval) is the user's. */
const AUTO_FIELDS = new Set<string>(['lifecycle', 'supersededBy']);

/**
 * A change to a memory. `null` clears a field (it survives JSON, which drops `undefined`: a field left out is
 * unchanged, a field sent as null is removed).
 */
export type MemoryPatch = Partial<Pick<ProjectMemory, 'text' | 'lifecycle' | 'approvedBy' | 'locked' | 'supersededBy'>> & {
  conditions?: string | null;
  environment?: string | null;
  check?: ProjectMemory['check'] | null;
};

/** The fields a patch may clear with null. */
const CLEARABLE = ['conditions', 'environment', 'check', 'supersededBy'] as const;

interface Tombstone {
  memoryId: string;
  contentHash: string;
  sourceRefs: string[];
  deletedAt: number;
}

interface DeleteIntent extends Tombstone {
  newGeneration: number;
}

type Op =
  | { op: 'add'; data: { memory: ProjectMemory; req: string } }
  | { op: 'merge'; data: { id: string; source: MemorySource; evidence: MemoryEvidence[]; req: string } }
  | { op: 'update'; data: { id: string; patch: MemoryPatch; byUser: boolean; suspectSecret?: boolean } }
  | { op: 'counts'; data: { ids: string[]; at: number } };

type LogRecord = Op & { seq: number; opId: string; ts: number; crc: string };

/** Each checkout's verification of each memory (docs §2), bound to the log's generation. */
interface CheckoutFile {
  generation: number;
  states: Record<string, Record<string, CheckoutVerification>>;
}

interface QueueEntry {
  opId: string;
  ts: number;
  candidate: MemoryCandidate;
}

export class MemoryCorruptError extends Error {}

/** An op id that already stands for a different request. */
export class MemoryOpConflictError extends Error {
  constructor(readonly opId: string) {
    super('op id was already used for a different change');
  }
}

/** Test hook: die at a named step, as a crash would (docs §10). */
const crashAt = (step: string) => {
  if (process.env.AIVENUE_MEM_CRASH_AT === step) process.exit(99);
};

/** JSON with object keys sorted at every level (arrays keep their order; undefined fields are left out, as JSON does). */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : stableJson(x))).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** What a verification vouches for. Sources, locks and counts are left out: adding a source does not undo a check. */
export function memoryContentDigest(m: Pick<ProjectMemory, 'kind' | 'text' | 'conditions' | 'environment' | 'check'>): string {
  const check = m.check && { command: normalize(m.check.command), expectExit: m.check.expectExit };
  return createHash('sha1').update(stableJson([m.kind, normalize(m.text), normalize(m.conditions), normalize(m.environment), check])).digest('hex').slice(0, 16);
}

const hashOf = (v: unknown) => createHash('sha1').update(stableJson(v)).digest('hex').slice(0, 16);

/** What an op asked for: a retry with the same op id must ask for the same thing (field order does not matter). */
const digestOf = (r: Op) => (r.op === 'add' || r.op === 'merge' ? r.data.req : hashOf([r.op, r.data]));

/** A candidate as it was asked for (masked, without its op id): not what it became (a new id, a time). */
const requestDigest = (c: MemoryCandidate) => {
  const { opId: _opId, ...rest } = c;
  return hashOf(['candidate', rest]);
};

const crcOf = (r: Omit<LogRecord, 'crc'>) => createHash('sha1').update(JSON.stringify([r.seq, r.opId, r.ts, r.op, r.data])).digest('hex').slice(0, 10);

/** Only line endings and the ends: punctuation, case, paths, commands and arguments stay as they are. */
export const normalize = (s?: string) => (s ?? '').replace(/\r\n?/g, '\n').trim();

export const dedupeKey = (m: { kind: MemoryKind; text: string; conditions?: string; environment?: string }) =>
  JSON.stringify([m.kind, normalize(m.text), normalize(m.conditions), normalize(m.environment)]);

const contentHash = (m: { kind: MemoryKind; text: string }) => createHash('sha256').update(`${m.kind}\0${normalize(m.text)}`).digest('hex');

export const sourceRef = (s: MemorySource) => `${s.workflowId}:${s.noteId ?? s.eventRef ?? ''}`;

function maskCandidate(c: MemoryCandidate): MemoryCandidate {
  const m = (s?: string) => (s === undefined ? undefined : maskText(s).text);
  return {
    ...c,
    text: m(c.text)!,
    conditions: m(c.conditions),
    environment: m(c.environment),
    check: c.check && { ...c.check, command: m(c.check.command)! },
    evidence: c.evidence?.map((e) => ({ ...e, summary: m(e.summary)!, environment: m(e.environment) })),
  };
}

const secretsLeft = (parts: (string | undefined)[]) => maskText(parts.filter(Boolean).join('\n')).count > 0;

function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function appendDurable(file: string, text: string) {
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

const readText = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

const readJson = <T>(file: string, fallback: T): T => {
  const t = readText(file);
  return t ? (JSON.parse(t) as T) : fallback;
};

/** Queue lines. Only a torn last line (no newline: its writer died before enqueue returned) is dropped. */
function parseQueue(text: string): { entries: QueueEntry[]; goodBytes: number; torn: boolean } {
  const entries: QueueEntry[] = [];
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    if (nl < 0) return { entries, goodBytes: Buffer.byteLength(text.slice(0, pos)), torn: true };
    const line = text.slice(pos, nl);
    if (line.trim()) {
      let e: QueueEntry | undefined;
      try {
        e = JSON.parse(line);
      } catch {
        e = undefined;
      }
      if (!e?.opId || !e.candidate) throw new MemoryCorruptError(`project memory queue is damaged at byte ${pos}`);
      entries.push(e);
    }
    pos = nl + 1;
  }
  return { entries, goodBytes: Buffer.byteLength(text), torn: false };
}

interface ParsedLog {
  generation: number;
  records: LogRecord[];
  /** Bytes up to the end of the last whole, valid record. */
  goodBytes: number;
  /** A torn or damaged last line follows. */
  torn: boolean;
}

function parseLog(text: string): ParsedLog {
  if (!text) return { generation: 0, records: [], goodBytes: 0, torn: false };
  const records: LogRecord[] = [];
  let generation = 0;
  let pos = 0;
  let first = true;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl < 0 ? text.length : nl;
    const line = text.slice(pos, end);
    let ok = nl >= 0;
    let rec: (LogRecord & { type?: string; generation?: number }) | undefined;
    if (ok) {
      try {
        rec = JSON.parse(line);
      } catch {
        ok = false;
      }
    }
    if (ok && first) {
      ok = rec?.type === 'header' && typeof rec.generation === 'number';
      if (ok) generation = rec!.generation!;
    } else if (ok) {
      ok = !!rec && rec.crc === crcOf(rec);
      if (ok) records.push(rec!);
    }
    if (!ok) {
      // Only the very last line may be torn (a write cut short); anything before it is damage, not a crash.
      if (text.slice(end + 1).trim()) throw new MemoryCorruptError(`project memory log is damaged at byte ${pos}`);
      return { generation, records, goodBytes: Buffer.byteLength(text.slice(0, pos)), torn: true };
    }
    first = false;
    pos = end + 1;
  }
  return { generation, records, goodBytes: Buffer.byteLength(text), torn: false };
}

function apply(mems: Map<string, ProjectMemory>, r: Op & { ts: number }) {
  if (r.op === 'add') mems.set(r.data.memory.id, structuredClone(r.data.memory));
  else if (r.op === 'merge') {
    const m = mems.get(r.data.id);
    if (!m) return;
    if (!m.sources.some((s) => sourceRef(s) === sourceRef(r.data.source))) m.sources.push(r.data.source);
    for (const e of r.data.evidence) if (!m.evidence.some((x) => x.eventRef === e.eventRef)) m.evidence.push(e);
    m.version++;
    m.updatedAt = r.ts;
  } else if (r.op === 'update') {
    const m = mems.get(r.data.id);
    if (!m) return;
    for (const [k, v] of Object.entries(r.data.patch)) {
      if (v === null) delete (m as unknown as Record<string, unknown>)[k];
      else if (v !== undefined) (m as unknown as Record<string, unknown>)[k] = v;
    }
    if (r.data.byUser) m.editedByUser = true;
    if (r.data.suspectSecret !== undefined) m.suspectSecret = r.data.suspectSecret || undefined;
    m.version++;
    m.updatedAt = r.ts;
  } else if (r.op === 'counts') {
    for (const id of r.data.ids) {
      const m = mems.get(id);
      if (!m) continue;
      m.injectedCount++;
      m.lastInjectedAt = r.data.at;
    }
  }
}

const touches = (r: LogRecord, id: string) => (r.op === 'add' ? r.data.memory.id === id : r.op === 'counts' ? false : r.data.id === id);

export class MemoryStore {
  readonly dir: string;
  private readonly lock: string;
  private generation = -1;
  private seq = 0;
  private mems = new Map<string, ProjectMemory>();
  /** op id → digest of what it did. */
  private opIds = new Map<string, string>();

  constructor(
    dataDir: string,
    readonly projectId: string,
  ) {
    if (!/^[\w-]+$/.test(projectId)) throw new Error('invalid project id');
    this.dir = path.join(dataDir, 'memory', projectId);
    this.lock = lockName(dataDir, projectId);
  }

  private file = (name: string) => path.join(this.dir, name);

  /** Where this hub has read up to: a new generation means a deletion rewrote the log. */
  progress(): { generation: number; seq: number } {
    return { generation: this.generation, seq: this.seq };
  }

  /** Catch up with the log (another hub may have written). Reads without the lock: a torn last line is skipped. */
  refresh(): boolean {
    if (fs.existsSync(this.file('delete-intent.json'))) {
      // A deletion is under way or was cut short: show nothing of the old state until it is finished.
      this.reset();
      return true;
    }
    const log = parseLog(readText(this.file('log.jsonl')));
    const last = log.records[log.records.length - 1]?.seq ?? 0;
    if (log.generation === this.generation && last === this.seq) return false;
    this.load(log);
    return true;
  }

  list(): ProjectMemory[] {
    this.refresh();
    return [...this.mems.values()].map((m) => structuredClone(m));
  }

  get(id: string): ProjectMemory | undefined {
    this.refresh();
    const m = this.mems.get(id);
    return m && structuredClone(m);
  }

  private reset() {
    this.generation = -1;
    this.seq = 0;
    this.mems = new Map();
    this.opIds = new Map();
  }

  private load(log: ParsedLog) {
    const snap = readJson<{ generation: number; upto: number; memories: ProjectMemory[]; ops: Record<string, string> } | undefined>(this.file('snapshot.json'), undefined);
    const mems = new Map<string, ProjectMemory>();
    const opIds = new Map<string, string>();
    let from = 0;
    if (snap && snap.generation === log.generation && log.records.some((r) => r.seq === snap.upto)) {
      for (const m of snap.memories) mems.set(m.id, m);
      for (const [o, d] of Object.entries(snap.ops ?? {})) opIds.set(o, d);
      from = snap.upto;
    }
    for (const r of log.records) {
      if (r.seq <= from) continue;
      apply(mems, r);
      opIds.set(r.opId, digestOf(r));
    }
    this.generation = log.generation;
    this.seq = log.records[log.records.length - 1]?.seq ?? 0;
    this.mems = mems;
    this.opIds = opIds;
  }

  /** Under the lock: finish a cut-short deletion, drop leftover temp files and a torn last line, then read it all. */
  private recover() {
    fs.mkdirSync(this.dir, { recursive: true });
    for (const f of fs.readdirSync(this.dir)) if (f.endsWith('.tmp')) fs.rmSync(this.file(f), { force: true });
    const intent = readJson<DeleteIntent | undefined>(this.file('delete-intent.json'), undefined);
    if (intent) this.finishDelete(intent);
    const logFile = this.file('log.jsonl');
    let text = readText(logFile);
    if (!text) {
      writeAtomic(logFile, JSON.stringify({ type: 'header', generation: 1 }) + '\n');
      text = readText(logFile);
    }
    const log = parseLog(text);
    if (log.torn) {
      fs.truncateSync(logFile, log.goodBytes);
      if (log.goodBytes === 0) writeAtomic(logFile, JSON.stringify({ type: 'header', generation: 1 }) + '\n');
    }
    this.load(log.goodBytes === 0 ? parseLog(readText(logFile)) : log);
  }

  private locked<T>(fn: () => T): Promise<T> {
    return withOsLock(this.lock, () => {
      this.recover();
      return fn();
    });
  }

  private append(op: Op, opId: string) {
    const rec = { ...op, seq: this.seq + 1, opId, ts: Date.now() } as Omit<LogRecord, 'crc'>;
    const full = { ...rec, crc: crcOf(rec) } as LogRecord;
    appendDurable(this.file('log.jsonl'), JSON.stringify(full) + '\n');
    apply(this.mems, full);
    this.opIds.set(opId, digestOf(op));
    this.seq = full.seq;
  }

  private maybeSnapshot(force = false) {
    const snap = readJson<{ generation: number; upto: number } | undefined>(this.file('snapshot.json'), undefined);
    if (!force && snap && snap.generation === this.generation && this.seq - snap.upto < 50) return;
    writeAtomic(this.file('snapshot.json'), JSON.stringify({ generation: this.generation, upto: this.seq, memories: [...this.mems.values()], ops: Object.fromEntries(this.opIds) }));
  }

  private tombstones(): Tombstone[] {
    return readJson<Tombstone[]>(this.file('tombstones.json'), []);
  }

  /** Masked first, then queued with its op id: nothing unmasked is ever written. Returns the op id. */
  async enqueue(c: MemoryCandidate): Promise<string> {
    const entry: QueueEntry = { opId: c.opId ?? randomUUID(), ts: Date.now(), candidate: maskCandidate(c) };
    const req = requestDigest(entry.candidate);
    await this.locked(() => {
      const file = this.file('queue.jsonl');
      const q = parseQueue(readText(file));
      // The same op id may come again (a retry) only with the same request.
      const applied = this.opIds.get(entry.opId);
      const queued = q.entries.find((e) => e.opId === entry.opId);
      if ((applied !== undefined && applied !== req) || (queued && requestDigest(queued.candidate) !== req)) throw new MemoryOpConflictError(entry.opId);
      if (applied !== undefined || queued) return; // a retry of something already queued or applied
      if (q.torn) fs.truncateSync(file, q.goodBytes);
      appendDurable(file, JSON.stringify(entry) + '\n');
    });
    return entry.opId;
  }

  /** Apply what is queued: each op id at most once, nothing a deletion ruled out, duplicates merged into one memory. */
  /** The workflows that have candidates waiting in the queue. */
  queuedWorkflows(): string[] {
    return [...new Set(parseQueue(readText(this.file('queue.jsonl'))).entries.map((e) => e.candidate.source.workflowId))];
  }

  /**
   * Apply what is queued: each op id at most once, nothing a deletion ruled out, duplicates merged into one memory.
   * `o.workflows` limits it to the candidates of those workflows (a running workflow's are still being collected:
   * it may yet take them back); the others stay queued.
   */
  async processQueue(o: { workflows?: (workflowId: string) => boolean } = {}): Promise<{ added: string[]; merged: string[]; rejected: string[]; conflicts: string[]; held: string[]; byOp: Record<string, QueueOutcome> }> {
    return this.locked(() => {
      const out = { added: [] as string[], merged: [] as string[], rejected: [] as string[], conflicts: [] as string[], held: [] as string[], byOp: {} as Record<string, QueueOutcome> };
      /** Waiting for the user: the same memory is locked, so nothing is added to it until it is unlocked. */
      const keep: QueueEntry[] = [];
      const { entries } = parseQueue(readText(this.file('queue.jsonl')));
      if (!entries.length) return out;
      const dead = this.tombstones();
      const deadHashes = new Set(dead.map((t) => t.contentHash));
      const deadSources = new Set(dead.flatMap((t) => t.sourceRefs));
      for (const entry of entries) {
        const { opId, candidate } = entry;
        if (o.workflows && !o.workflows(candidate.source.workflowId)) {
          keep.push(entry);
          continue;
        }
        const req = requestDigest(candidate);
        const did = this.opIds.get(opId);
        if (did !== undefined) {
          if (did !== req) (out.conflicts.push(opId), (out.byOp[opId] = { status: 'conflict' }));
          continue;
        }
        if ((!candidate.explicit && deadHashes.has(contentHash(candidate))) || deadSources.has(sourceRef(candidate.source))) {
          out.rejected.push(opId);
          out.byOp[opId] = { status: 'rejected' };
          continue;
        }
        const key = dedupeKey(candidate);
        const same = [...this.mems.values()].find((m) => dedupeKey(m) === key);
        if (same?.locked) {
          keep.push(entry);
          out.held.push(opId);
          out.byOp[opId] = { status: 'held', memoryId: same.id };
        } else if (same) {
          this.append({ op: 'merge', data: { id: same.id, source: candidate.source, evidence: candidate.evidence ?? [], req } }, opId);
          out.merged.push(same.id);
          out.byOp[opId] = { status: 'merged', memoryId: same.id };
        } else {
          const suspect = secretsLeft([candidate.text, candidate.conditions, candidate.environment, candidate.check?.command, ...(candidate.evidence ?? []).map((e) => e.summary)]);
          const now = Date.now();
          const memory: ProjectMemory = {
            id: `m_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
            kind: candidate.kind,
            text: candidate.text,
            conditions: candidate.conditions,
            environment: candidate.environment,
            check: candidate.check,
            sources: [candidate.source],
            evidence: candidate.evidence ?? [],
            lifecycle: suspect ? 'candidate' : candidate.lifecycle,
            approvedBy: suspect || candidate.lifecycle === 'candidate' ? undefined : (candidate.approvedBy ?? 'auto'),
            suspectSecret: suspect || undefined,
            injectedCount: 0,
            feedback: { useful: 0, wrong: 0 },
            createdAt: now,
            updatedAt: now,
            version: 1,
          };
          this.append({ op: 'add', data: { memory, req } }, opId);
          out.added.push(memory.id);
          out.byOp[opId] = { status: 'added', memoryId: memory.id };
        }
        crashAt('after-apply');
      }
      writeAtomic(this.file('queue.jsonl'), keep.map((e) => JSON.stringify(e) + '\n').join(''));
      this.maybeSnapshot();
      return out;
    });
  }

  /** Take back candidates still waiting in the queue (a workflow switched to read-only or off). Returns how many. */
  async dropQueued(workflowId: string): Promise<number> {
    return this.locked(() => {
      const file = this.file('queue.jsonl');
      const { entries } = parseQueue(readText(file));
      const keep = entries.filter((e) => e.candidate.source.workflowId !== workflowId);
      if (keep.length !== entries.length) writeAtomic(file, keep.map((e) => JSON.stringify(e) + '\n').join(''));
      return entries.length - keep.length;
    });
  }

  /** Queue and apply at once. */
  async add(c: MemoryCandidate) {
    const opId = await this.enqueue({ ...c, opId: c.opId ?? randomUUID() });
    const r = await this.processQueue();
    if (r.conflicts.includes(opId)) throw new MemoryOpConflictError(opId);
    return { opId, ...r };
  }

  /** A change the user (or the workflow, for lifecycle) makes; refused when someone changed it since `version`. */
  async update(id: string, patch: MemoryPatch, o: { version?: number; byUser?: boolean; opId?: string } = {}): Promise<ProjectMemory> {
    return this.locked(() => {
      for (const [k, v] of Object.entries(patch)) if (v === null && !(CLEARABLE as readonly string[]).includes(k)) throw new Error(`${k} cannot be cleared`);
      if (patch.text !== undefined && !String(patch.text).trim()) throw new Error('text cannot be empty');
      const masked: MemoryPatch = { ...patch };
      for (const k of ['text', 'conditions', 'environment'] as const) if (typeof masked[k] === 'string') masked[k] = maskText(masked[k]!).text;
      if (masked.check) masked.check = { ...masked.check, command: maskText(masked.check.command).text };
      const op: Op = { op: 'update', data: { id, patch: masked, byUser: !!o.byUser, suspectSecret: maskText([patch.text, patch.conditions, patch.environment].filter(Boolean).join('\n')).count > 0 || undefined } };
      const opId = o.opId ?? randomUUID();
      // A retry of an op that already went through: done, whatever the version is now.
      const did = this.opIds.get(opId);
      if (did !== undefined) {
        if (did !== digestOf(op)) throw new MemoryOpConflictError(opId);
        const cur = this.mems.get(id);
        if (!cur) throw new Error('memory not found');
        return structuredClone(cur);
      }
      const m = this.mems.get(id);
      if (!m) throw new Error('memory not found');
      if (o.version !== undefined && o.version !== m.version) throw new Error('memory changed since it was read');
      if (!o.byUser) {
        const other = Object.keys(patch).filter((k) => !AUTO_FIELDS.has(k));
        if (other.length) throw new Error(`only the user may change ${other.join(', ')}`);
        if (m.locked) throw new Error('memory is locked by the user');
      }
      this.append(op, opId);
      this.maybeSnapshot();
      return structuredClone(this.mems.get(id)!);
    });
  }

  /** How each memory stands in one checkout, as last recorded (states of deleted memories are gone). */
  checkoutStates(checkoutId: string): Record<string, CheckoutVerification> {
    const f = readJson<CheckoutFile | undefined>(this.file('checkouts.json'), undefined);
    const states = f?.states?.[checkoutId] ?? {};
    this.refresh();
    return Object.fromEntries(Object.entries(states).filter(([id]) => this.mems.has(id)).map(([id, v]) => [id, structuredClone(v)]));
  }

  /**
   * Record what a verification event showed for a memory in one checkout (other checkouts are not touched). Refused
   * (false) for an event older than the recorded one, the same event again, or a check of what the memory no longer
   * says: an event arriving late never replaces a newer state.
   */
  async setCheckoutState(checkoutId: string, memoryId: string, v: CheckoutVerification): Promise<boolean> {
    return this.locked(() => {
      const m = this.mems.get(memoryId);
      if (!m) throw new Error('memory not found');
      if (v.contentDigest !== memoryContentDigest(m)) return false;
      const f = readJson<CheckoutFile | undefined>(this.file('checkouts.json'), undefined);
      const states = f?.states ?? {};
      const cur = states[checkoutId]?.[memoryId];
      if (cur && (v.at < cur.at || (v.at === cur.at && v.evidenceRef === cur.evidenceRef))) return false;
      (states[checkoutId] ??= {})[memoryId] = { ...v, actual: maskText(v.actual).text, expected: maskText(v.expected).text };
      writeAtomic(this.file('checkouts.json'), JSON.stringify({ generation: this.generation, states }));
      return true;
    });
  }

  /** Count that these memories went into a prompt (not in read-only mode). */
  async countInjected(ids: string[]) {
    if (!ids.length) return;
    await this.locked(() => {
      this.append({ op: 'counts', data: { ids, at: Date.now() } }, randomUUID());
      this.maybeSnapshot();
    });
  }

  /**
   * Forget a memory for good: every version leaves the log, snapshot, queue and checkout states, and a tombstone
   * (no text) keeps its sources and its content from coming back. Survives a crash at any step (docs §6).
   */
  async delete(id: string): Promise<boolean> {
    return this.locked(() => {
      const m = this.mems.get(id);
      if (!m) return false;
      const intent: DeleteIntent = { memoryId: id, contentHash: contentHash(m), sourceRefs: m.sources.map(sourceRef), deletedAt: Date.now(), newGeneration: this.generation + 1 };
      writeAtomic(this.file('delete-intent.json'), JSON.stringify(intent));
      crashAt('delete:intent');
      this.finishDelete(intent);
      this.load(parseLog(readText(this.file('log.jsonl'))));
      return true;
    });
  }

  /** Each step can run again: a restart after a crash re-runs them all. */
  private finishDelete(intent: DeleteIntent) {
    const { newGeneration, ...tomb } = intent;
    const stones = this.tombstones();
    if (!stones.some((t) => t.memoryId === tomb.memoryId)) writeAtomic(this.file('tombstones.json'), JSON.stringify([...stones, tomb]));
    crashAt('delete:tombstone');

    const logFile = this.file('log.jsonl');
    // Damage throws (MemoryCorruptError) and leaves the files and the intent as they are: never rewrite from a log
    // that could not be read, or every other memory would go with it.
    const log = parseLog(readText(logFile));
    const kept = log.records.filter((r) => !touches(r, tomb.memoryId));
    writeAtomic(logFile, [JSON.stringify({ type: 'header', generation: newGeneration }), ...kept.map((r) => JSON.stringify(r))].join('\n') + '\n');
    crashAt('delete:log');

    const mems = new Map<string, ProjectMemory>();
    const ops: Record<string, string> = {};
    for (const r of kept) (apply(mems, r), (ops[r.opId] = digestOf(r)));
    writeAtomic(this.file('snapshot.json'), JSON.stringify({ generation: newGeneration, upto: kept[kept.length - 1]?.seq ?? 0, memories: [...mems.values()], ops }));
    crashAt('delete:snapshot');

    const deadSources = new Set(tomb.sourceRefs);
    const queue = parseQueue(readText(this.file('queue.jsonl'))).entries.filter((e) => contentHash(e.candidate) !== tomb.contentHash && !deadSources.has(sourceRef(e.candidate.source)));
    writeAtomic(this.file('queue.jsonl'), queue.map((e) => JSON.stringify(e) + '\n').join(''));
    crashAt('delete:queue');

    const checkouts = readJson<CheckoutFile | undefined>(this.file('checkouts.json'), undefined);
    if (checkouts) {
      for (const states of Object.values(checkouts.states ?? {})) delete states[tomb.memoryId];
      writeAtomic(this.file('checkouts.json'), JSON.stringify({ generation: newGeneration, states: checkouts.states ?? {} }));
    }
    crashAt('delete:checkouts');

    fs.rmSync(this.file('delete-intent.json'), { force: true });
  }
}
