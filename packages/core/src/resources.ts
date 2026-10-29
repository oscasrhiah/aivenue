import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CheckShell, ConditionWait, GpuDetail } from './types';
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

  /** Every GPU with temperature, power and the processes running on it (nvidia-smi). */
  gpuDetail(): GpuDetail[] {
    const smi = (args: string[]) => {
      try {
        return execFileSync('nvidia-smi', args, { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        return '';
      }
    };
    const rows = (out: string) => out.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(',').map((x) => x.trim()));
    const num = (x?: string) => (x && Number.isFinite(Number(x)) ? Number(x) : undefined);
    const gpus = rows(smi(['--query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw,pci.bus_id', '--format=csv,noheader,nounits']));
    const apps = rows(smi(['--query-compute-apps=gpu_bus_id,pid,process_name,used_memory', '--format=csv,noheader,nounits']));
    return gpus.map(([index, name, used, total, util, temp, power, bus]) => {
      const lock = this.readLock(Number(index));
      return {
        index: Number(index),
        name,
        memUsedMB: Number(used),
        memTotalMB: Number(total),
        util: Number(util),
        tempC: num(temp),
        powerW: num(power),
        lockedBy: lock ? { workflowId: lock.workflowId, agentId: lock.agentId, since: lock.since } : undefined,
        apps: apps.filter((a) => a[0] === bus).map(([, pid, pname, mem]) => ({ pid: Number(pid), name: pname, memMB: num(mem) })),
      };
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

  newWait(agentId: string, a: { check: string; contains?: string; interval_sec?: number; timeout_min?: number; gpus?: number; shell?: string }): ConditionWait {
    const now = Date.now();
    return {
      id: `w-${randomUUID().slice(0, 8)}`,
      agentId,
      check: a.check,
      shell: checkShell(a.check, a.shell),
      contains: a.contains || undefined,
      intervalSec: Math.min(600, Math.max(5, Math.round(a.interval_sec ?? 30))),
      timeoutAt: now + Math.min(7 * 24 * 60, Math.max(1, a.timeout_min ?? 60)) * 60000,
      startedAt: now,
      gpus: a.gpus ? Math.max(1, Math.round(a.gpus)) : undefined,
      state: 'waiting',
    };
  }

  /**
   * Run the condition once (60 s at most), in the wait's shell. `broken`: the check itself could not run (a syntax
   * error, an unknown command), so waiting longer would never help.
   */
  check(w: ConditionWait, cwd: string): Promise<{ ok: boolean; output: string; broken?: boolean }> {
    return new Promise((resolve) => {
      const shell = w.shell ?? checkShell(w.check);
      const bash = shell === 'bash' && process.platform === 'win32' ? findGitBash() : undefined;
      const child =
        shell === 'powershell'
          ? spawn(process.platform === 'win32' ? 'powershell' : 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', w.check], { cwd, env: childEnv(), windowsHide: true })
          : shell === 'bash'
            ? spawn(bash ?? 'bash', ['-c', w.check], { cwd, env: childEnv(), windowsHide: true })
            : // cmd.exe on Windows (its quoting rules), /bin/sh elsewhere.
              spawn(w.check, { shell: true, cwd, env: childEnv(), windowsHide: true });
      let out = '';
      const timer = setTimeout(() => child.kill(), 60000);
      child.stdout?.on('data', (d) => (out += d));
      child.stderr?.on('data', (d) => (out += d));
      child.on('error', (e) => (clearTimeout(timer), resolve({ ok: false, output: e.message, broken: true })));
      child.on('close', (code) => {
        clearTimeout(timer);
        const output = out.trim().slice(-2000);
        // PowerShell prints False (and still exits 0) for a test that does not hold, e.g. Test-Path.
        const falsy = shell === 'powershell' && /(^|\n)\s*False\s*$/.test(output);
        const ok = code === 0 && !falsy && (!w.contains || output.includes(w.contains));
        resolve({ ok, output, broken: !ok && CHECK_BROKEN.test(output) });
      });
    });
  }
}

/** What a shell prints when the command itself is wrong, not when the condition is false. */
const CHECK_BROKEN = /ParserError|Unterminated string|unexpected EOF|syntax error|unexpected token|is not recognized as (an internal|the name)|command not found|CommandNotFoundException|The filename, directory name, or volume label syntax is incorrect/i;

let gitBash: string | null | undefined;

/** Git for Windows' bash (not WSL's): the shell most agent CLIs run their commands in on Windows. */
export function findGitBash(): string | undefined {
  if (gitBash !== undefined) return gitBash ?? undefined;
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean) as string[];
  const candidates = [process.env.CLAUDE_CODE_GIT_BASH_PATH, ...pf.map((d) => path.join(d, 'Git', 'bin', 'bash.exe'))];
  try {
    // Next to git.exe: <Git>\cmd\git.exe → <Git>\bin\bash.exe.
    const git = execFileSync('where', ['git'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0]?.trim();
    if (git) candidates.push(path.join(path.dirname(path.dirname(git)), 'bin', 'bash.exe'));
  } catch {
    // no git on PATH
  }
  gitBash = candidates.find((c) => c && fs.existsSync(c)) ?? null;
  return gitBash ?? undefined;
}

const POWERSHELL_SYNTAX = /\b(Test-Path|Get-[A-Z]\w+|Select-String|Where-Object|ForEach-Object|Start-Sleep|Write-(Output|Host)|Measure-Object)\b|\$env:|\$\w+\.\w+\(|\s-(match|notmatch|like|notlike|contains)\s|\$(true|false|null)\b/i;
const CMD_SYNTAX = /^\s*(if\s+(not\s+)?exist\b|findstr\b|type\s)|%\w+%/i;

/**
 * The shell a wait's check runs in: the one the agent named, else the one its syntax belongs to. On Windows plain
 * POSIX-looking commands go to Git Bash when it is there (agents write bash), else PowerShell; elsewhere /bin/sh.
 */
export function checkShell(check: string, asked?: string): CheckShell {
  const a = (asked ?? '').toLowerCase();
  if (a === 'bash' || a === 'powershell' || a === 'cmd' || a === 'sh') return a === 'cmd' && process.platform !== 'win32' ? 'sh' : (a as CheckShell);
  if (a === 'pwsh') return 'powershell';
  if (POWERSHELL_SYNTAX.test(check)) return 'powershell';
  if (process.platform !== 'win32') return 'sh';
  if (CMD_SYNTAX.test(check)) return 'cmd';
  return findGitBash() ? 'bash' : 'powershell';
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
