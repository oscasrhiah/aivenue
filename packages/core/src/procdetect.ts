import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Background jobs an agent starts by itself (without track_process), found from the commands it runs: `nohup … &`,
 * `setsid`, a new terminal window, tmux/screen, Start-Process, or a CLI's own "run in background". Aivenue then finds
 * the process and tracks it like a registered one, so the user sees it in the progress panel and the Agent map.
 */

const flat = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** A shell line that starts something and returns without waiting for it. */
const LAUNCH =
  /\bnohup\b|\bsetsid\b|\bdisown\b|(^|[^&|>0-9])&\s*($|;|\n|echo\b|disown\b|sleep\b|wait\b|pid=|PID=)|\b(gnome-terminal|x-terminal-emulator|konsole|xterm|tilix|alacritty|kitty|wezterm|terminator|mate-terminal|xfce4-terminal)\b|\btmux\s+new(-session)?\b[^\n]*\s-d\b|\bscreen\s+-\w*d\w*m|\bStart-Process\b|^start\s+(""|\/b\b)/i;

/** Stopping or looking for a job, not starting one. */
const NOT_A_LAUNCH = /^\s*(kill|pkill|pgrep|killall|wait)\b/i;

/** What a launch line runs: the script or program to look for in the process list. */
function keyOf(cmd: string): string | undefined {
  const script = /(?:^|[\s"'=(])((?:[\w./~-]*\/)?[\w.-]+\.(?:py|sh|bash|js|mjs|cjs|ts|rb|pl|jl|r|lua|exe|bat|ps1))\b/i.exec(cmd)?.[1];
  if (script) return script.replace(/^.*\//, '');
  // `nohup python -m pkg.train …` / `setsid ./run …`: the module or the program after the wrapper.
  const mod = /\s-m\s+([\w.]+)/.exec(cmd)?.[1];
  if (mod) return mod;
  const after = /\b(?:nohup|setsid|-e|--|-Command|-FilePath)\s+["']?([^\s"'&;|]+)/i.exec(cmd)?.[1];
  return after && !/^(bash|sh|zsh|cmd|powershell|pwsh|python3?|node|env)$/i.test(after) ? after.replace(/^.*[\\/]/, '') : undefined;
}

/** Where its output goes: `> train.log`, `>> out.txt 2>&1`, `| tee run.log`, `-RedirectStandardOutput x.log`. */
export function logOf(cmd: string): string | undefined {
  const m = /(?:^|[^0-9&])>>?\s*["']?([^\s"'&;|]+)|\btee\s+(?:-a\s+)?["']?([^\s"'&;|]+)|-RedirectStandard(?:Output|Error)\s+["']?([^\s"']+)/i.exec(cmd);
  const f = m?.[1] ?? m?.[2] ?? m?.[3];
  return f && !/^\/dev\/(null|stdout|stderr)$/.test(f) && !/^(nul|\$null)$/i.test(f) ? f : undefined;
}

export interface Launch {
  /** What to look for in the process list. */
  key?: string;
  log?: string;
  /** The PID the command printed (`echo $!`, `[1] 12345`, `PID 12345`). */
  pid?: number;
  command: string;
}

/** The background job a finished command started, if it started one. `input` is the tool's raw input (its flags). */
export function backgroundLaunch(command: string, output?: string, input?: string): Launch | undefined {
  const cmd = flat(command);
  if (!cmd) return undefined;
  const flagged = /"run_in_background"\s*:\s*true/.test(input ?? '');
  // "nohup python train.py > log 2>&1 & sleep 10; tail log" starts a job, even though it also waits a little.
  if (!flagged && (!LAUNCH.test(cmd) || NOT_A_LAUNCH.test(cmd))) return undefined;
  return { key: keyOf(cmd), log: logOf(cmd), pid: pidFromOutput(output), command: cmd };
}

/** A PID the command printed. */
export function pidFromOutput(output?: string): number | undefined {
  const o = output ?? '';
  const m = /\b(?:pid|PID|Id)\s*[:=]?\s*(\d{2,8})\b/.exec(o) ?? /^\[\d+\]\s+(\d{2,8})\s*$/m.exec(o) ?? /^\s*(\d{2,8})\s*$/m.exec(o);
  const n = m ? Number(m[1]) : NaN;
  return n > 1 ? n : undefined;
}

/** A running process's command line (undefined when it is gone or cannot be read). */
export async function commandOf(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === 'linux') return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ') || undefined;
    if (process.platform === 'win32') {
      const { stdout } = await run('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Math.round(pid)}").CommandLine`], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      return stdout.trim() || undefined;
    }
    const { stdout } = await run('ps', ['-o', 'args=', '-p', String(Math.round(pid))], { encoding: 'utf8', timeout: 15000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The folder a process runs in (Linux only; undefined elsewhere). */
export function processCwd(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return undefined;
  }
}

/** `dir` is `root` or inside it. */
export function isInside(root: string, dir: string): boolean {
  const r = path.relative(path.resolve(root), path.resolve(dir));
  return !r.startsWith('..') && !path.isAbsolute(r);
}

/** Running processes whose command line contains `key` (newest PID first), not counting Aivenue's own shell. */
export async function findProcesses(key: string): Promise<{ pid: number; command: string }[]> {
  if (!key || key.length < 3) return [];
  try {
    const rows: { pid: number; command: string }[] = [];
    if (process.platform === 'win32') {
      const { stdout: out } = await run('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }'], { encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
      for (const l of out.split(/\r?\n/)) {
        const [pid, ...rest] = l.split('\t');
        if (Number(pid) && rest.join('\t')) rows.push({ pid: Number(pid), command: rest.join('\t') });
      }
    } else {
      const { stdout: out } = await run('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 15000, maxBuffer: 32 * 1024 * 1024 });
      for (const l of out.split('\n')) {
        const m = /^\s*(\d+)\s+(.*)$/.exec(l);
        if (m) rows.push({ pid: Number(m[1]), command: m[2] });
      }
    }
    const k = key.toLowerCase();
    // The job itself before the shell or terminal that started it (newest first in each); never a search for it.
    const shell = (c: string) => /^(\S*[\\/])?(bash|sh|zsh|dash|fish|cmd|powershell|pwsh|gnome-terminal\S*|xterm|konsole|tmux|screen)(\.exe)?\b/i.test(c);
    return rows
      .filter((r) => r.pid !== process.pid && r.command.toLowerCase().includes(k) && !/\b(grep|pgrep|rg|ps -eo|Get-CimInstance)\b/i.test(r.command))
      .sort((a, b) => Number(shell(a.command)) - Number(shell(b.command)) || b.pid - a.pid);
  } catch {
    return [];
  }
}
