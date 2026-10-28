import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConditionWait } from './types';
import { childEnv } from './proc';

/** A GPU as nvidia-smi reports it. */
export interface GpuInfo {
  index: number;
  name: string;
  memUsedMB: number;
  memTotalMB: number;
  util: number;
  /** Held by an Aivenue agent (any workflow, any Aivenue window on this computer). */
  lockedBy?: { workflowId: string; agentId: string; since: number };
}

interface LockFile {
  workflowId: string;
  agentId: string;
  pid: number;
  since: number;
}

const isWin = process.platform === 'win32';

/**
 * GPU locks and condition waits for agents that run training or evaluation jobs.
 * - Locks are files under <dataDir>/locks, so two workflows (or two Aivenue windows) never take the same GPU.
 *   A lock whose Aivenue process is gone is stale and is taken over.
 * - A wait checks a shell condition every few seconds until it holds or times out. It lives in the run (persisted),
 *   so after a restart the agent continues it with the same wait id. When it also asks for GPUs, the lock is taken
 *   only after the condition holds — re-checked under the lock — so nobody else grabs the card in between.
 */
export class ResourceManager {
  private dir: string;

  /** `query`: nvidia-smi's CSV output (replaced in tests). */
  constructor(dataDir: string, private query: () => string = nvidiaSmi) {
    this.dir = path.join(dataDir, 'locks');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  gpus(): GpuInfo[] {
    let out = '';
    try {
      out = this.query();
    } catch {
      return [];
    }
    return out
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => {
        const [index, name, used, total, util] = l.split(',').map((x) => x.trim());
        const g: GpuInfo = { index: Number(index), name, memUsedMB: Number(used), memTotalMB: Number(total), util: Number(util) };
        const lock = this.readLock(g.index);
        if (lock) g.lockedBy = { workflowId: lock.workflowId, agentId: lock.agentId, since: lock.since };
        return g;
      });
  }

  private lockPath(i: number) {
    return path.join(this.dir, `gpu-${i}.json`);
  }

  private readLock(i: number): LockFile | undefined {
    try {
      const l = JSON.parse(fs.readFileSync(this.lockPath(i), 'utf8')) as LockFile;
      if (pidAlive(l.pid)) return l;
      fs.rmSync(this.lockPath(i), { force: true });
    } catch {
      // no lock
    }
    return undefined;
  }

  /**
   * Take `count` free GPUs for an agent: not locked, at most `maxUsedMB` memory in use and `maxUtil` % busy.
   * Returns their indices, or undefined when not enough are free right now.
   */
  acquire(owner: { workflowId: string; agentId: string }, count: number, o: { maxUsedMB?: number; maxUtil?: number } = {}): number[] | undefined {
    const free = this.gpus().filter((g) => !g.lockedBy && g.memUsedMB <= (o.maxUsedMB ?? 1024) && g.util <= (o.maxUtil ?? 20));
    if (free.length < count) return undefined;
    const taken: number[] = [];
    for (const g of free) {
      if (taken.length >= count) break;
      try {
        // "wx": fails if another workflow wrote the lock first.
        fs.writeFileSync(this.lockPath(g.index), JSON.stringify({ ...owner, pid: process.pid, since: Date.now() } satisfies LockFile), { flag: 'wx' });
        taken.push(g.index);
      } catch {
        // someone else got it
      }
    }
    if (taken.length < count) {
      for (const i of taken) fs.rmSync(this.lockPath(i), { force: true });
      return undefined;
    }
    return taken;
  }

  /** Release an agent's GPUs (or a whole workflow's, without agentId; only `only` when given). */
  release(workflowId: string, agentId?: string, only?: number[]): number[] {
    const freed: number[] = [];
    for (const f of fs.readdirSync(this.dir)) {
      const m = /^gpu-(\d+)\.json$/.exec(f);
      if (!m) continue;
      try {
        const l = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as LockFile;
        if (l.workflowId === workflowId && (!agentId || l.agentId === agentId) && (!only || only.includes(Number(m[1])))) {
          fs.rmSync(path.join(this.dir, f), { force: true });
          freed.push(Number(m[1]));
        }
      } catch {
        // gone
      }
    }
    return freed;
  }

  newWait(agentId: string, a: { check: string; contains?: string; interval_sec?: number; timeout_min?: number; gpus?: number }): ConditionWait {
    const now = Date.now();
    return {
      id: `w-${randomUUID().slice(0, 8)}`,
      agentId,
      check: a.check,
      contains: a.contains || undefined,
      intervalSec: Math.min(600, Math.max(5, Math.round(a.interval_sec ?? 30))),
      timeoutAt: now + Math.min(7 * 24 * 60, Math.max(1, a.timeout_min ?? 60)) * 60000,
      startedAt: now,
      gpus: a.gpus ? Math.max(1, Math.round(a.gpus)) : undefined,
      state: 'waiting',
    };
  }

  /** Run the condition once (60 s at most). */
  check(w: ConditionWait, cwd: string): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) => {
      // shell: cmd.exe on Windows (with its quoting rules), /bin/sh elsewhere.
      const child = spawn(w.check, { shell: true, cwd, env: childEnv(), windowsHide: true });
      let out = '';
      const timer = setTimeout(() => child.kill(), 60000);
      child.stdout?.on('data', (d) => (out += d));
      child.stderr?.on('data', (d) => (out += d));
      child.on('error', (e) => (clearTimeout(timer), resolve({ ok: false, output: e.message })));
      child.on('close', (code) => {
        clearTimeout(timer);
        const output = out.trim().slice(-2000);
        resolve({ ok: code === 0 && (!w.contains || output.includes(w.contains)), output });
      });
    });
  }
}

function nvidiaSmi(): string {
  return execFileSync('nvidia-smi', ['--query-gpu=index,name,memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Stop a background process and its children (one an agent registered for Aivenue to clean up). */
export function killPid(pid: number): void {
  if (!pidAlive(pid)) return;
  if (isWin) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
  }
}
