import type { ChildProcess } from 'node:child_process';
import { killTree } from './proc';

/**
 * CLI processes kept running between turns of the same session (for CLIs that read one message per
 * stdin line). A process is reused only for the same session with the same launch settings.
 * While the workflow that uses it has not ended (it may be waiting for a quota to reset), it is never closed for being
 * idle, so the conversation goes on without reading everything again; after the workflow ends it is closed after
 * `idleMs` without a new turn (0: never).
 */
export interface PooledCli {
  /** Launch settings (model, mode, folder, MCP servers…): a turn with different ones needs a new process. */
  fingerprint: string;
  sessionId: string;
  child: ChildProcess;
  /** Bridge session the process was started with; re-pointed to whichever agent uses it next. */
  secret: string;
  busy: boolean;
  /** Line handlers of the turn in progress. */
  onLine?: (line: string) => void;
  onStderr?: (line: string) => void;
  onExit?: (code: number | null) => void;
  idle?: NodeJS.Timeout;
  /** Runs once when the process is closed (temp files, bridge session). */
  cleanup: () => void;
  /** The workflow using it: kept while that workflow has not ended. */
  owner?: string;
}

export class CliPool {
  private entries = new Map<string, PooledCli>();

  constructor(
    private idleMs = 5 * 60 * 1000,
    /** Whether a workflow is still going (running, paused, waiting for the user). */
    private isActive: (owner: string) => boolean = () => false,
  ) {}

  /** How long a process may stay idle after its workflow ended (0: until Aivenue closes). Applies to idle ones now. */
  setIdleMs(ms: number) {
    this.idleMs = Math.max(0, ms);
    for (const e of this.entries.values()) if (!e.busy) this.arm(e);
  }

  /** A workflow ended: the idle countdown of its processes starts now. */
  ownerEnded(owner: string) {
    for (const e of this.entries.values()) if (e.owner === owner && !e.busy) this.arm(e);
  }

  private arm(e: PooledCli) {
    clearTimeout(e.idle);
    e.idle = undefined;
    if (!this.idleMs) return;
    e.idle = setTimeout(() => {
      // Its workflow still runs (e.g. waiting for a quota reset): keep it, look again later.
      if (e.owner && this.isActive(e.owner)) this.arm(e);
      else this.close(e);
    }, this.idleMs);
    e.idle.unref?.();
  }

  /** A live, idle process for this session with the same launch settings, marked busy. */
  take(sessionId: string, fingerprint: string): PooledCli | undefined {
    const e = this.entries.get(sessionId);
    if (!e || e.busy || e.child.exitCode !== null || e.child.killed) return undefined;
    if (e.fingerprint !== fingerprint) {
      // Settings changed (model, permission…): this process can't serve the session any more.
      this.close(e);
      return undefined;
    }
    clearTimeout(e.idle);
    e.busy = true;
    return e;
  }

  /** Keep a process for later turns; it starts idle. */
  add(e: PooledCli) {
    const old = this.entries.get(e.sessionId);
    if (old && old !== e) this.close(old);
    this.entries.set(e.sessionId, e);
    e.child.once('close', () => this.forget(e));
    this.release(e);
  }

  release(e: PooledCli) {
    e.busy = false;
    e.onLine = e.onStderr = e.onExit = undefined;
    this.arm(e);
  }

  close(e: PooledCli) {
    clearTimeout(e.idle);
    try {
      e.child.stdin?.end();
    } catch {
      // already closed
    }
    killTree(e.child);
    this.forget(e);
  }

  closeAll() {
    for (const e of [...this.entries.values()]) this.close(e);
  }

  /** Close these sessions' processes and wait (up to 5 s) until they exited, so their folder is no longer in use. */
  async closeSessions(sessionIds: Iterable<string>): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const id of sessionIds) {
      const e = this.entries.get(id);
      if (!e) continue;
      if (e.child.exitCode === null) waits.push(new Promise((r) => e.child.once('exit', () => r())));
      this.close(e);
    }
    if (waits.length) await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, 5000))]);
  }

  get size(): number {
    return this.entries.size;
  }

  private forget(e: PooledCli) {
    if (this.entries.get(e.sessionId) === e) this.entries.delete(e.sessionId);
    const done = e.cleanup;
    e.cleanup = () => undefined;
    done();
  }
}
