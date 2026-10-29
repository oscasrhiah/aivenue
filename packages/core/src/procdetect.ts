import { execFile } from 'node:child_process';
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

/** Waiting on a job, not starting one. */
const WAITING = /\b(until|while)\b[\s\S]*\bsleep\b|\bwait_for\b|\bpgrep\b|\bkill\b|\bpkill\b/i;

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
function logOf(cmd: string): string | undefined {
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
  if (!flagged && (!LAUNCH.test(cmd) || WAITING.test(cmd))) return undefined;
  return { key: keyOf(cmd), log: logOf(cmd), pid: pidFromOutput(output), command: cmd };
}

/** A PID the command printed. */
export function pidFromOutput(output?: string): number | undefined {
  const o = output ?? '';
  const m = /\b(?:pid|PID|Id)\s*[:=]?\s*(\d{2,8})\b/.exec(o) ?? /^\[\d+\]\s+(\d{2,8})\s*$/m.exec(o) ?? /^\s*(\d{2,8})\s*$/m.exec(o);
  const n = m ? Number(m[1]) : NaN;
  return n > 1 ? n : undefined;
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
