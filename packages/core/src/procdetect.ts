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
  /** The script it runs, as written (with its folders). */
  script?: string;
  /** The folder the line ran in (launchFolder), when known. */
  cwd?: string;
  command: string;
}

/** A line that hands quoted text to a shell to run: `bash -c "…"`, `cmd /c "…"`, `powershell -Command "…"`, `iex "…"`. */
const SHELL_PAYLOAD = /\b(?:ba|z|da|k)?sh\s+(?:-\w+\s+)*-\w*c\b|\bcmd(?:\.exe)?\s+\/[ck]\b|\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*\s-(?:c|command|encodedcommand)\b|\b(?:Invoke-Expression|iex)\b/i;

/**
 * The part of a command its shell runs. Left out: a heredoc's body (`cat > a.mjs <<'EOF' … EOF`, `python - <<EOF`) and
 * a PowerShell here-string (`@' … '@`), which are data written to a file or a program's input; and quoted text, an
 * argument, unless the line hands it to a shell. (A script being written that mentions `Start-Process` or `nohup …
 * &` in its text starts nothing.)
 */
export function shellText(command: string): string {
  const s = withoutHeredocs(command);
  // Whether a shell is handed quoted text is read outside the quotes: `echo "Invoke-Expression Start-Process x"`
  // only prints those words.
  const outside = s.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
  return SHELL_PAYLOAD.test(outside) ? s : outside;
}

/** A command without the bodies of its heredocs (`<<'EOF' … EOF`) and PowerShell here-strings (`@' … '@`). */
export function withoutHeredocs(command: string): string {
  return command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\r?\n|$)/g, '<<HEREDOC').replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, '@HERE@');
}

/** The background job a finished command started, if it started one. `input` is the tool's raw input (its flags). */
export function backgroundLaunch(command: string, output?: string, input?: string): Launch | undefined {
  const cmd = flat(command);
  if (!cmd) return undefined;
  const flagged = /"run_in_background"\s*:\s*true/.test(input ?? '');
  // "nohup python train.py > log 2>&1 & sleep 10; tail log" starts a job, even though it also waits a little.
  const ran = flat(shellText(command));
  if (!flagged && (!LAUNCH.test(ran) || NOT_A_LAUNCH.test(ran))) return undefined;
  return { key: keyOf(cmd), script: scriptOf(cmd), log: logOf(cmd), pid: pidFromOutput(output), command: cmd };
}

/** A PID the command printed. */
export function pidFromOutput(output?: string): number | undefined {
  const o = output ?? '';
  const m = /\b(?:pid|PID|Id)\s*[:=]?\s*(\d{2,8})\b/.exec(o) ?? /^\[\d+\]\s+(\d{2,8})\s*$/m.exec(o) ?? /^\s*(\d{2,8})\s*$/m.exec(o);
  const n = m ? Number(m[1]) : NaN;
  return n > 1 ? n : undefined;
}

/** The script a launch line runs, as written (with its folders), when it names one. */
export function scriptOf(cmd: string): string | undefined {
  return /(?:^|[\s"'=(])((?:[A-Za-z]:)?(?:[\w.~-]*[\\/])*[\w.-]+\.(?:py|sh|bash|js|mjs|cjs|ts|rb|pl|jl|r|lua|exe|bat|ps1))\b/i.exec(cmd)?.[1];
}

/** A command line as its words (quoted words kept whole, quotes taken off). */
function words(line: string): string[] {
  return (line.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^(["'])([\s\S]*)\1$/, '$2'));
}

const INTERPRETER = /^(node|nodejs|python[\d.]*|pythonw|py|bash|sh|zsh|dash|ruby|perl|php|deno|bun|tsx|ts-node|pwsh|powershell|rscript|julia|lua|java)$/i;
/** Options that give the interpreter code inline: then it runs no script file. */
const INLINE = /^(-e|-c|-p|-i|--eval|--print|-Command|-EncodedCommand|-ec)$/i;

/** A path as the platform writes it (Git Bash's `/c/x` is `C:\x` on Windows). */
function native(p: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    const m = /^\/([A-Za-z])(\/.*)?$/.exec(p);
    if (m) return `${m[1].toUpperCase()}:${(m[2] ?? '/').replace(/\//g, '\\')}`;
  }
  return p;
}

/**
 * The folder a launch line ran in: the tool call's own working folder (`workdir`, `cwd`), else `base` (the workflow's
 * folder); a single `cd` / `pushd` / `Set-Location` in the line moves it. Undefined when it cannot be told (several
 * changes of folder, `cd -`, a variable or `~`).
 */
export function launchFolder(command: string, input: string | undefined, base: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const P = platform === 'win32' ? path.win32 : path.posix;
  let dir = base;
  try {
    const i = input ? JSON.parse(input) : undefined;
    const given = [i?.workdir, i?.cwd, i?.directory, i?.working_directory].find((x) => typeof x === 'string' && x.trim());
    if (given) dir = P.resolve(native(base, platform), native(given.trim(), platform));
  } catch {
    // not JSON: the workflow's folder
  }
  const moves = [...command.matchAll(/(?:^|&&|;|\n|\|\|)\s*(?:cd|chdir|pushd|Set-Location|sl)\s+(?:-(?:Path|LiteralPath)\s+)?("[^"]*"|'[^']*'|[^\s;&|]+)/gi)].map((m) => m[1].replace(/^(["'])([\s\S]*)\1$/, '$2'));
  if (!moves.length) return dir;
  if (moves.length > 1 || /^(-|~)|\$|%/.test(moves[0])) return undefined;
  return P.resolve(native(dir, platform), native(moves[0], platform));
}

/**
 * Whether a process runs the script a launch started: the script its command line runs (as its program, or the file
 * an interpreter runs, see scriptToken) is the same file as the launch's, both resolved to full paths: the launch's
 * against the folder it ran in, the process's against its own folder (`cwd`, readable on Linux) unless the command
 * line names it in full. Without both, or for a module (`-m`) or a program the launch named without a script file, it
 * cannot be told: false (the launch stays unconfirmed). Paths compare without case on Windows and macOS only.
 */
export function sameScript(proc: { command: string; cwd?: string }, launch: { key: string; script?: string; cwd?: string }, platform: NodeJS.Platform = process.platform): boolean {
  const token = scriptToken(proc.command, launch.key);
  if (!token || !launch.script) return false;
  const P = platform === 'win32' ? path.win32 : path.posix;
  const full = (p: string, base?: string) => {
    const n = native(p, platform);
    if (P.isAbsolute(n)) return P.normalize(n);
    return base ? P.resolve(native(base, platform), n) : undefined;
  };
  const want = full(launch.script, launch.cwd);
  const got = full(token, proc.cwd);
  if (!want || !got) return false;
  return platform === 'win32' || platform === 'darwin' ? want.toLowerCase() === got.toLowerCase() : want === got;
}

/**
 * The script a process runs, as its command line writes it, when it is the launch's (`key`, its file name): the
 * program itself, or the script file an interpreter runs (its first argument that is not an option; `pwsh -File`). A
 * name only in another argument or in inline code (-e / -c) is not run as a script: undefined.
 */
export function scriptToken(commandLine: string, key: string): string | undefined {
  const w = words(commandLine);
  if (!w.length || !key) return undefined;
  const base = (p: string) => p.replace(/^.*[\\/]/, '').toLowerCase();
  const plain = (p: string) => base(p).replace(/\.(exe|cmd|bat)$/i, '');
  const k = key.toLowerCase();
  if (plain(w[0]) === k.replace(/\.(exe|cmd|bat)$/i, '')) return w[0];
  if (!INTERPRETER.test(plain(w[0]))) return undefined;
  for (let i = 1; i < w.length; i++) {
    const a = w[i];
    if (INLINE.test(a) || a === '-m') return undefined;
    if (/^-(File|f)$/i.test(a)) return base(w[i + 1] ?? '') === k ? w[i + 1] : undefined;
    if (a.startsWith('-')) continue;
    return base(a) === k ? a : undefined;
  }
  return undefined;
}

/** A running process's command line and when it started (undefined when it is gone or cannot be read). */
export async function processInfo(pid: number): Promise<{ command: string; startedAt?: number } | undefined> {
  const id = Math.round(pid);
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run('powershell', ['-NoProfile', '-Command', `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${id}"; if ($p) { "$($p.CreationDate.ToUniversalTime().ToString('o'))\`t$($p.CommandLine)" }`], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      const [when, ...rest] = stdout.trim().split('\t');
      const command = rest.join('\t').trim();
      return command ? { command, startedAt: Date.parse(when) || undefined } : undefined;
    }
    const { stdout } = await run('ps', ['-o', 'lstart=,args=', '-p', String(id)], { encoding: 'utf8', timeout: 15000 });
    const m = /^\s*(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(stdout.trim());
    return m ? { command: m[2], startedAt: Date.parse(m[1]) || undefined } : stdout.trim() ? { command: stdout.trim() } : undefined;
  } catch {
    return undefined;
  }
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

/**
 * Running processes whose command line contains `key` (newest PID first), with when each started, not counting
 * Aivenue's own shell. Only candidates: whether one runs a launch is for sameScript to tell.
 */
export async function findProcesses(key: string): Promise<{ pid: number; command: string; startedAt?: number }[]> {
  if (!key || key.length < 3) return [];
  try {
    const rows: { pid: number; command: string; startedAt?: number }[] = [];
    if (process.platform === 'win32') {
      const { stdout: out } = await run(
        'powershell',
        ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | ForEach-Object { $d = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }; \"$($_.ProcessId)`t$d`t$($_.CommandLine)\" }"],
        { encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      );
      for (const l of out.split(/\r?\n/)) {
        const [pid, when, ...rest] = l.split('\t');
        if (Number(pid) && rest.join('\t')) rows.push({ pid: Number(pid), command: rest.join('\t'), startedAt: Date.parse(when) || undefined });
      }
    } else {
      const { stdout: out } = await run('ps', ['-eo', 'pid=,lstart=,args='], { encoding: 'utf8', timeout: 15000, maxBuffer: 32 * 1024 * 1024 });
      for (const l of out.split('\n')) {
        const m = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(l);
        if (m) rows.push({ pid: Number(m[1]), command: m[3], startedAt: Date.parse(m[2]) || undefined });
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
