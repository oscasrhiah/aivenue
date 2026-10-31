import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentEvent, WorkflowPreset, WorkflowRun, WorkflowSummary } from './types';

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

  constructor(dataDir: string) {
    this.runsDir = path.join(dataDir, 'runs');
    this.presetsFile = path.join(dataDir, 'presets.json');
    fs.mkdirSync(this.runsDir, { recursive: true });
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
        // The folder name is the id: an id inside the file must not point anywhere else.
        run.id = id;
        if (run.worktree && !isInside(path.join(path.dirname(this.runsDir), 'worktrees'), run.worktree.path)) run.worktree = undefined;
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
    if (this.frozen || this.saveTimers.has(run.id)) return;
    this.saveTimers.set(
      run.id,
      setTimeout(() => {
        this.saveTimers.delete(run.id);
        this.saveNow(run);
      }, 400),
    );
  }

  saveNow(run: WorkflowRun): void {
    if (this.frozen) return;
    const t = this.saveTimers.get(run.id);
    if (t) {
      clearTimeout(t);
      this.saveTimers.delete(run.id);
    }
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
