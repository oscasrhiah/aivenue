/**
 * The shared memory of a workflow as numbered entries that later compactions update, replace or retract — instead of
 * rewriting one summary every time (docs/next-task-skills-integration.md, context-compression item 3). Pure logic:
 * the compactor proposes operations; this checks them and applies what holds.
 *
 * - A source must be in this batch, the entry must exist and be active, the version must be the current one: the
 *   program checks that much; the meaning stays the model's, with its sources and reason kept.
 * - Updating, replacing or retracting on weak evidence (anything an agent wrote, whatever kind it gave it) is not
 *   applied: it is recorded as a conflict on the old entry, which stays. The user's constraints change only on the
 *   user's own recorded words.
 * - What the batch did not process (not covered, or only cited by rejected operations) stays pending for the next.
 * - An item whose content could not be read again ("missing") is no source for any operation and stays pending,
 *   marked so, until its content is found: the model saying it covered it does not remove it.
 * - Rendering picks entries by importance (constraints, open points, decisions, to do, where, done), newest first only
 *   within a section; what does not fit is named, not dropped.
 */

export type MemorySection = 'constraint' | 'open' | 'decision' | 'todo' | 'where' | 'done';
export const SECTIONS: MemorySection[] = ['constraint', 'open', 'decision', 'todo', 'where', 'done'];
const TITLES: Record<MemorySection, string> = {
  constraint: "The user's constraints",
  open: 'Open problems, open decisions, points not confirmed',
  decision: 'Decisions',
  todo: 'Still to do',
  where: 'Where things are (files, commands, settings)',
  done: 'Done so far',
};

export interface MemoryConflict {
  reason: string;
  sources: string[];
  cycle: number;
  /** What the entry would have become (a replacement's text). */
  proposed?: string;
}

export interface MemoryEntry {
  id: string;
  section: MemorySection;
  text: string;
  /** Material refs it rests on: "n:<note id>", "a:<agent id>", "legacy". */
  sources: string[];
  version: number;
  /** The compaction it was added in, and the last one that changed it. */
  cycle: number;
  updatedCycle?: number;
  /** The latest time of the material it rests on (for staleness). */
  at: number;
  status: 'active' | 'superseded' | 'retracted' | 'merged';
  /** The entry that replaced or absorbed it. */
  by?: string;
  reason?: string;
  reasonSources?: string[];
  conflicts?: MemoryConflict[];
}

/** One item of the material a compaction works from. */
export interface MaterialItem {
  ref: string;
  /**
   * Judged by where it really comes from, not by what an agent called it: user: the user's own message in the records;
   * strong: what Aivenue itself observed (a check it saw run); weak: anything an agent wrote (notes of any kind, results).
   */
  strength: 'user' | 'strong' | 'weak';
  ts: number;
  text: string;
  /** The message (workflow) whose records it came from. */
  runId?: string;
  /** Left pending before items were saved whole, and not found again: its content cannot be read. */
  missing?: boolean;
}

/**
 * One item left pending, in either form it may be saved in: a whole copy (current), or a bare ref (older versions).
 * The one place that tells the two apart.
 */
export function readPending(p: MaterialItem | string): { ref: string; copy?: MaterialItem } {
  return typeof p === 'string' ? { ref: p } : { ref: p.ref, copy: p };
}

/** Whether `ref` is among the items left pending. */
export function isPending(pending: (MaterialItem | string)[] | undefined, ref: string): boolean {
  return !!pending?.some((p) => readPending(p).ref === ref);
}

export interface MemoryOp {
  op: 'add' | 'update' | 'supersede' | 'retract' | 'conflict' | 'merge';
  id?: string;
  ids?: string[];
  version?: number;
  section?: string;
  text?: string;
  sources?: string[];
  reason?: string;
}

export interface MemoryOps {
  ops: MemoryOp[];
  /** The batch items the model processed (kept, or found nothing in worth keeping). */
  covered: string[];
}

/** The compactor's reply as operations: a JSON object (bare or in a ```json block); undefined when there is none. */
export function parseMemoryOps(text: string): MemoryOps | undefined {
  const candidates = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object' && Array.isArray(v.ops)) {
        const ops = v.ops.filter((o: any) => o && typeof o === 'object' && typeof o.op === 'string');
        const covered = Array.isArray(v.covered) ? v.covered.filter((x: unknown) => typeof x === 'string') : [];
        return { ops, covered };
      }
    } catch {
      // not this one
    }
  }
  return undefined;
}

export interface ApplyResult {
  entries: MemoryEntry[];
  accepted: { op: MemoryOp; id: string }[];
  rejected: { op: MemoryOp; why: string }[];
  /** Replacements or retractions on weak evidence, recorded as conflicts instead. */
  conflicted: { op: MemoryOp; id: string; why: string }[];
  /** Batch refs this compaction is done with, and those left for the next one. */
  processed: string[];
  pending: string[];
  nextId: number;
}

const str = (v: unknown, n = 2000) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

export function applyMemoryOps(entries: MemoryEntry[], ops: MemoryOps, batch: MaterialItem[], o: { cycle: number; nextId: number }): ApplyResult {
  const list: MemoryEntry[] = entries.map((e) => ({ ...e, sources: [...e.sources], ...(e.conflicts ? { conflicts: [...e.conflicts] } : {}) }));
  const byId = new Map(list.map((e) => [e.id, e]));
  const items = new Map(batch.map((b) => [b.ref, b]));
  let nextId = o.nextId;
  const accepted: ApplyResult['accepted'] = [];
  const rejected: ApplyResult['rejected'] = [];
  const conflicted: ApplyResult['conflicted'] = [];
  const usedOk = new Set<string>();
  const usedBad = new Set<string>();
  const newId = () => `M${nextId++}`;
  const latest = (refs: string[]) => Math.max(0, ...refs.map((r) => items.get(r)?.ts ?? 0));
  const isProtected = (e: MemoryEntry) => e.section === 'constraint';
  const strong = (refs: string[], e?: MemoryEntry) =>
    e && isProtected(e) ? refs.some((r) => items.get(r)?.strength === 'user') : refs.some((r) => ['user', 'strong'].includes(items.get(r)?.strength ?? ''));
  const reject = (op: MemoryOp, why: string) => {
    rejected.push({ op, why });
    for (const r of op.sources ?? []) usedBad.add(r);
  };
  for (const op of ops.ops) {
    const sources = (Array.isArray(op.sources) ? op.sources : []).filter((s): s is string => typeof s === 'string');
    const outside = sources.filter((s) => !items.has(s));
    const text = str(op.text);
    const reason = str(op.reason, 600);
    // A source whose content could not be read again is evidence of nothing, for any operation.
    const unreadable = sources.filter((s) => items.get(s)?.missing);
    if (unreadable.length) {
      reject(op, `source(s) whose content cannot be read: ${unreadable.join(', ')}`);
      continue;
    }
    if (op.op === 'merge') {
      const ids = (Array.isArray(op.ids) ? op.ids : []).filter((x): x is string => typeof x === 'string');
      const merged = ids.map((id) => byId.get(id));
      if (ids.length < 2 || merged.some((e) => !e || e.status !== 'active')) {
        reject(op, 'merge needs two or more active entries');
        continue;
      }
      if (merged.some((e) => isProtected(e!))) {
        reject(op, "the user's constraints are not merged");
        continue;
      }
      const allowed = new Set([...items.keys(), ...merged.flatMap((e) => e!.sources)]);
      if (!text || sources.some((s) => !allowed.has(s))) {
        reject(op, !text ? 'no text' : 'a source is neither in this batch nor in the merged entries');
        continue;
      }
      const id = newId();
      const section = SECTIONS.includes(op.section as MemorySection) ? (op.section as MemorySection) : merged[0]!.section;
      const keep = [...new Set([...merged.flatMap((e) => e!.sources), ...sources])];
      const e: MemoryEntry = { id, section, text, sources: keep, version: 1, cycle: o.cycle, at: Math.max(...merged.map((m) => m!.at), latest(sources)), status: 'active' };
      for (const m of merged) Object.assign(m!, { status: 'merged', by: id, reason: reason || 'merged' });
      list.push(e);
      byId.set(id, e);
      accepted.push({ op, id });
      for (const r of sources) usedOk.add(r);
      continue;
    }
    if (!sources.length) {
      reject(op, 'no source');
      continue;
    }
    if (outside.length) {
      reject(op, `source(s) not in this batch: ${outside.join(', ')}`);
      continue;
    }
    if (op.op === 'add') {
      const section = op.section as MemorySection;
      if (!SECTIONS.includes(section) || !text) {
        reject(op, !text ? 'no text' : `unknown section "${op.section}"`);
        continue;
      }
      const id = newId();
      const e: MemoryEntry = { id, section, text, sources, version: 1, cycle: o.cycle, at: latest(sources), status: 'active' };
      list.push(e);
      byId.set(id, e);
      accepted.push({ op, id });
      for (const r of sources) usedOk.add(r);
      continue;
    }
    const e = op.id ? byId.get(op.id) : undefined;
    if (!e || e.status !== 'active') {
      reject(op, e ? `${e.id} is ${e.status}` : `no entry ${op.id ?? '(none given)'}`);
      continue;
    }
    if (op.op === 'conflict') {
      if (!reason) {
        reject(op, 'no reason');
        continue;
      }
      (e.conflicts ??= []).push({ reason, sources, cycle: o.cycle, ...(text ? { proposed: text } : {}) });
      accepted.push({ op, id: e.id });
      for (const r of sources) usedOk.add(r);
      continue;
    }
    if (op.version !== e.version) {
      reject(op, `${e.id} is at version ${e.version}, not ${op.version ?? '(none given)'}`);
      continue;
    }
    if (!reason && op.op !== 'update') {
      reject(op, 'no reason');
      continue;
    }
    if (op.op === 'update') {
      if (!text) {
        reject(op, 'no text');
        continue;
      }
      // An update can change what an entry says as much as a replacement: the same evidence rule holds.
      if (!strong(sources, e)) {
        const why = isProtected(e) ? "a constraint of the user's changes only on the user's word" : 'only weak evidence (an inference or an agent\'s account)';
        conflicted.push({ op, id: e.id, why });
        (e.conflicts ??= []).push({ reason: reason || 'proposed change', sources, cycle: o.cycle, proposed: text });
        for (const r of sources) usedOk.add(r);
        continue;
      }
      Object.assign(e, { text, sources: [...new Set([...e.sources, ...sources])], version: e.version + 1, updatedCycle: o.cycle, at: Math.max(e.at, latest(sources)) });
      if (reason) Object.assign(e, { reason, reasonSources: sources });
      accepted.push({ op, id: e.id });
      for (const r of sources) usedOk.add(r);
      continue;
    }
    if (op.op === 'supersede' || op.op === 'retract') {
      if (op.op === 'supersede' && !text) {
        reject(op, 'no replacement text');
        continue;
      }
      // Weak evidence does not undo an entry: the contradiction is recorded, the entry stays.
      if (!strong(sources, e)) {
        const why = isProtected(e) ? "a constraint of the user's changes only on the user's word" : 'only weak evidence (an inference or an agent\'s account)';
        conflicted.push({ op, id: e.id, why });
        (e.conflicts ??= []).push({ reason, sources, cycle: o.cycle, ...(text ? { proposed: text } : {}) });
        for (const r of sources) usedOk.add(r);
        continue;
      }
      if (op.op === 'retract') {
        Object.assign(e, { status: 'retracted', reason, reasonSources: sources });
        accepted.push({ op, id: e.id });
      } else {
        const id = newId();
        const section = SECTIONS.includes(op.section as MemorySection) ? (op.section as MemorySection) : e.section;
        const n: MemoryEntry = { id, section, text, sources, version: 1, cycle: o.cycle, at: latest(sources), status: 'active' };
        Object.assign(e, { status: 'superseded', by: id, reason, reasonSources: sources });
        list.push(n);
        byId.set(id, n);
        accepted.push({ op, id });
      }
      for (const r of sources) usedOk.add(r);
      continue;
    }
    reject(op, `unknown operation "${op.op}"`);
  }
  // Done with: what the model says it covered or what an applied operation used — unless only a rejected one cited it.
  const covered = new Set([...ops.covered.filter((r) => items.has(r)), ...usedOk]);
  // One whose content cannot be read is never done with: nothing was read of it, whatever the model says it covered.
  const processed = [...items.keys()].filter((r) => !items.get(r)!.missing && covered.has(r) && (usedOk.has(r) || !usedBad.has(r)));
  const pending = [...items.keys()].filter((r) => !processed.includes(r));
  return { entries: list, accepted, rejected, conflicted, processed, pending, nextId };
}

/**
 * The entries as the shared memory text, within `budget` tokens: by importance, newest first within a section.
 * Marks conflicts and what Aivenue sees as outdated; names what did not fit.
 */
export function renderMemory(
  entries: MemoryEntry[],
  budget: number,
  o: { tokens: (s: string) => number; lastEdit?: number; openIssueIds?: Set<string>; knownIssueIds?: Set<string> },
): { text: string; shown: string[]; omitted: string[] } {
  const active = entries.filter((e) => e.status === 'active');
  const order = (e: MemoryEntry) => SECTIONS.indexOf(e.section);
  const ranked = [...active].sort((a, b) => order(a) - order(b) || (b.updatedCycle ?? b.cycle) - (a.updatedCycle ?? a.cycle) || b.at - a.at);
  const line = (e: MemoryEntry) => {
    const marks: string[] = [];
    if (o.lastEdit && e.at && o.lastEdit > e.at && /\b(pass(es|ed)?|green|succeed(s|ed)?|ok|works)\b|✓|通過/i.test(e.text)) marks.push('STALE: files changed since; re-verify');
    const closed = [...e.text.matchAll(/\b[RV]\d{1,3}\b/g)].map((m) => m[0]).filter((id) => o.knownIssueIds?.has(id) && !o.openIssueIds?.has(id));
    if (closed.length) marks.push(`${closed.join(', ')} no longer open: confirm this entry`);
    for (const c of e.conflicts ?? []) marks.push(`CONFLICT (cycle ${c.cycle}, ${c.sources.join(', ')}): ${c.reason}${c.proposed ? ` — proposed: ${c.proposed.slice(0, 200)}` : ''}`);
    return `- ${e.id} ${e.text}${marks.length ? ` [${marks.join('; ')}]` : ''} (sources: ${e.sources.join(', ')}; cycle ${e.updatedCycle ?? e.cycle}, v${e.version})`;
  };
  const shown: MemoryEntry[] = [];
  let used = 0;
  for (const e of ranked) {
    const size = o.tokens(line(e)) + 1;
    if (used + size > budget - 60) continue;
    shown.push(e);
    used += size;
  }
  const omitted = ranked.filter((e) => !shown.includes(e)).map((e) => e.id);
  const parts = SECTIONS.map((s) => {
    const es = shown.filter((e) => e.section === s);
    return es.length ? `## ${TITLES[s]}\n${es.map(line).join('\n')}` : '';
  }).filter(Boolean);
  if (omitted.length) parts.push(`(${omitted.length} entr${omitted.length === 1 ? 'y' : 'ies'} left out for space: ${omitted.join(', ')} — read_context {} has the full shared memory)`);
  return { text: parts.join('\n\n'), shown: shown.map((e) => e.id), omitted };
}

/** Every entry for read_context: the active ones and the history (replaced, retracted, merged) with why and from what. */
export function memoryHistory(entries: MemoryEntry[]): string {
  const gone = entries.filter((e) => e.status !== 'active');
  if (!gone.length) return '';
  return `SHARED MEMORY HISTORY (no longer in the prompt):\n${gone.map((e) => `- ${e.id} [${e.status}${e.by ? ` by ${e.by}` : ''}${e.reason ? `: ${e.reason}` : ''}${e.reasonSources?.length ? ` (${e.reasonSources.join(', ')})` : ''}] ${e.text}`).join('\n')}`;
}
