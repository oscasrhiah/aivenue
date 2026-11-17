import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentEvent, RunHost, WorkflowPreset, WorkflowRun, WorkflowSummary } from './types';
import { requestContext } from './windows';

/** How long a run remembers the client operations that changed it (as the operation log), how many, how large an answer. */
const OP_KEEP_MS = 10 * 60_000;
const OP_MAX_PER_RUN = 20;
const OP_RESULT_MAX = 16 * 1024;

/** Run and agent ids are used as folder and file names. */
const SAFE_ID = /^[A-Za-z0-9][\w-]{0,79}$/;

const isInside = (parent: string, child: string) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** Persists workflow runs (run.json) and per-agent event logs (events/<agentId>.jsonl). */
export class RunStore {
  private runsDir: string;
  private presetsFile: string;
  private events = new Map<string, AgentEvent[]>();
  private saveTimers = new Map<string, NodeJS.Timeout>();
  /** Set at app shutdown: what is on disk then stays, later saves (the stopping of its agents) are dropped. */
  private frozen = false;

  /**
   * `host`: whose conversations these are. The desktop app (and its browser preview) and the VS Code extension each
   * run their own hub on the same data folder; each lists, resumes and writes only its own workflows, so neither shows
   * the other's chats nor marks the other's running ones as interrupted. A workflow saved before this was recorded
   * belongs to the app.
   */
  constructor(dataDir: string, readonly host: RunHost = 'app') {
    this.runsDir = path.join(dataDir, 'runs');
    this.presetsFile = path.join(dataDir, 'presets.json');
    fs.mkdirSync(this.runsDir, { recursive: true });
  }

  /** The folder of a workflow's records (deleted with it): for files kept beside run.json, such as CI logs. */
  dirOf(id: string): string {
    return this.runDir(id);
  }

  private runDir(id: string) {
    if (!SAFE_ID.test(id)) throw new Error(`invalid id ${id}`);
    return path.join(this.runsDir, id);
  }

  loadAll(): WorkflowRun[] {
    const out: WorkflowRun[] = [];
    for (const id of fs.readdirSync(this.runsDir)) {
      try {
        if (!SAFE_ID.test(id)) continue;
        const run = JSON.parse(fs.readFileSync(path.join(this.runDir(id), 'run.json'), 'utf8')) as WorkflowRun;
        // Another host's workflow (the VS Code extension's, or the app's): not this hub's to list, resume or write.
        if ((run.host ?? 'app') !== this.host) continue;
        // The folder name is the id: an id inside the file must not point anywhere else.
        run.id = id;
        if (run.worktree && !isInside(path.join(path.dirname(this.runsDir), 'worktrees'), run.worktree.path)) run.worktree = undefined;
        for (const o of run.ops ?? []) if (Date.now() - o.at < OP_KEEP_MS) this.opIndex.set(o.op, o);
        if (run.status === 'running' || run.status === 'paused' || run.status === 'waiting_human') {
          // Kept so it can be resumed where it stopped (by itself, or when the user continues a paused one).
          run.interruptedFrom = run.status;
          run.interruptedAt = Date.now();
          run.status = 'interrupted';
          run.pending = undefined;
          for (const a of Object.values(run.agents)) if (a.status === 'running' || a.status === 'paused' || a.status === 'queued') a.status = 'cancelled';
          this.saveNow(run);
        }
        out.push(run);
      } catch {
        // corrupt or partial run dir
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  save(run: WorkflowRun): void {
    this.markOp(run);
    if (this.frozen || this.saveTimers.has(run.id)) return;
    this.waiting.set(run.id, run);
    this.saveTimers.set(
      run.id,
      setTimeout(() => {
        this.saveTimers.delete(run.id);
        this.saveNow(run);
      }, 400),
    );
  }

  // ---------- client operations, kept with the runs they changed ----------
  /*
   * A client operation (`op`, see opLog.ts) that changes a run is recorded in that run's own run.json, with its answer
   * once it is done, in the same write as the change. The hub's operation log is a second file written after it: if
   * the hub stops between the two, a resend of the operation finds it here and gets its answer instead of running again
   * (a message added twice, a run started twice).
   */
  private activeOps = new Map<string, Set<WorkflowRun>>();
  private opIndex = new Map<string, NonNullable<WorkflowRun['ops']>[number]>();

  /** An operation starts: the runs saved while it runs (within its request) are the ones it changed. */
  beginOp(op: string): void {
    this.activeOps.set(op, new Set());
  }

  /**
   * It ended: its answer (or error) goes into each run it changed, saved with the change. Answers too large to keep are
   * left out (a resend is then refused as already done, not run again).
   */
  endOp(op: string, result: { value?: unknown; error?: string }): void {
    const runs = this.activeOps.get(op);
    this.activeOps.delete(op);
    if (!runs?.size) return;
    const kept = result.error === undefined && JSON.stringify(result.value ?? null).length <= OP_RESULT_MAX;
    for (const run of runs) {
      const entry = run.ops?.find((o) => o.op === op);
      if (!entry) continue;
      entry.done = true;
      if (result.error !== undefined) entry.error = result.error.slice(0, 500);
      else if (kept) entry.result = result.value ?? null;
      this.opIndex.set(op, entry);
      this.save(run);
    }
  }

  /** What a run records of an operation (done or cut off), for a resend the operation log does not know. */
  appliedOp(op: string): NonNullable<WorkflowRun['ops']>[number] | undefined {
    const o = this.opIndex.get(op);
    return o && Date.now() - o.at < OP_KEEP_MS ? o : undefined;
  }

  private markOp(run: WorkflowRun) {
    const op = requestContext.getStore()?.op;
    const runs = op ? this.activeOps.get(op) : undefined;
    if (!op || !runs || runs.has(run)) return;
    runs.add(run);
    const now = Date.now();
    const list = (run.ops ?? []).filter((o) => now - o.at < OP_KEEP_MS && o.op !== op).slice(-(OP_MAX_PER_RUN - 1));
    const entry = { op, at: now };
    run.ops = [...list, entry];
    this.opIndex.set(op, entry);
  }

  /** Runs changed but not written yet (their save is still waiting). */
  private waiting = new Map<string, WorkflowRun>();

  /**
   * Write now every run whose save is waiting. Before an operation is answered (and kept as done): what the user was
   * told happened must be on disk, so a hub that stops right after loses nothing a repeat of the operation would not
   * bring back.
   */
  flush(): void {
    for (const run of [...this.waiting.values()]) this.saveNow(run);
  }

  saveNow(run: WorkflowRun): void {
    this.markOp(run);
    if (this.frozen) return;
    const t = this.saveTimers.get(run.id);
    if (t) {
      clearTimeout(t);
      this.saveTimers.delete(run.id);
    }
    this.waiting.delete(run.id);
    fs.mkdirSync(this.runDir(run.id), { recursive: true });
    const file = path.join(this.runDir(run.id), 'run.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(run));
    fs.renameSync(file + '.tmp', file);
  }

  /** App shutdown: write what is waiting to be saved, then keep the files as they are. */
  freeze(runs: WorkflowRun[]): void {
    for (const r of runs) if (this.saveTimers.has(r.id)) this.saveNow(r);
    this.frozen = true;
  }

  appendEvent(runId: string, agentId: string, e: AgentEvent, isUpdate: boolean): void {
    const key = `${runId}/${agentId}`;
    let list = this.events.get(key);
    if (!list) {
      list = [];
      this.events.set(key, list);
    }
    if (isUpdate) {
      const i = list.findIndex((x) => x.seq === e.seq);
      if (i >= 0) list[i] = { ...e };
    } else list.push({ ...e });
    const dir = path.join(this.runDir(runId), 'events');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFile(path.join(dir, `${agentId}.jsonl`), JSON.stringify(e) + '\n', () => undefined);
  }

  getEvents(runId: string, agentId: string): AgentEvent[] {
    if (!SAFE_ID.test(runId) || !SAFE_ID.test(agentId)) return [];
    const key = `${runId}/${agentId}`;
    const mem = this.events.get(key);
    if (mem) return mem;
    try {
      const bySeq = new Map<number, AgentEvent>();
      for (const line of fs.readFileSync(path.join(this.runDir(runId), 'events', `${agentId}.jsonl`), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const e = JSON.parse(line) as AgentEvent;
        bySeq.set(e.seq, e);
      }
      return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    } catch {
      return [];
    }
  }

  /** Free in-memory event lists of a finished run (they stay on disk). */
  release(runId: string): void {
    for (const k of [...this.events.keys()]) if (k.startsWith(runId + '/')) this.events.delete(k);
  }

  delete(runId: string): void {
    this.release(runId);
    // A save still waiting would write the run back after it was deleted.
    const t = this.saveTimers.get(runId);
    if (t) clearTimeout(t);
    this.saveTimers.delete(runId);
    this.waiting.delete(runId);
    fs.rmSync(this.runDir(runId), { recursive: true, force: true });
  }

  static summary(run: WorkflowRun): WorkflowSummary {
    return { id: run.id, threadId: run.config.threadId ?? run.id, replacedBy: run.replacedBy, title: run.config.title, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt, cwd: run.config.cwd };
  }

  loadPresets(): WorkflowPreset[] {
    try {
      return JSON.parse(fs.readFileSync(this.presetsFile, 'utf8'));
    } catch {
      return [];
    }
  }

  savePresets(presets: WorkflowPreset[]): void {
    fs.writeFileSync(this.presetsFile, JSON.stringify(presets, null, 2));
  }
}
