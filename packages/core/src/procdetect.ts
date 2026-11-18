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

/** A command line's steps and the separator after each (`&&`, `||`, `;`, `|`, a new line, or '' at the end), quotes kept. */
function steps(command: string): { text: string; sep: string }[] {
  const out: { text: string; sep: string }[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      out.push({ text: cur, sep: two });
      cur = '';
      i++;
    } else if (ch === '&' && !/[<>]$/.test(cur) && command[i + 1] !== '>') {
      // A lone & (not && or a redirect like 2>&1, &>): what is before it runs in the background.
      out.push({ text: cur, sep: '&' });
      cur = '';
    } else if (ch === ';' || ch === '|' || ch === '\n') {
      out.push({ text: cur, sep: ch });
      cur = '';
    } else cur += ch;
  }
  out.push({ text: cur, sep: '' });
  return out;
}

/** A step that is only a change of folder (`cd x`, `pushd x`, `Set-Location -Path x`): its target, as written. */
const CD_STEP = /^\s*(?:cd|chdir|pushd|Set-Location|sl)\s+(?:-(?:Path|LiteralPath)\s+)?("[^"]*"|'[^']*'|[^\s&]+)\s*$/i;

/** Wrappers that run the command after them: `nohup`, `setsid`, `exec`, `time`, `nice -n 5`, `stdbuf -oL` (`env`: unwrap). */
const WRAPPER = /^\s*(?:nohup|setsid(?:\s+-\w+)*|exec|time|nice(?:\s+-n\s*-?\d+)?|stdbuf(?:\s+-\w+)*)\s+/i;
/** One of GNU env's options or a `NAME=value` before its command; group 1: the folder of `-C x` / `--chdir=x`. */
const ENV_ARG = /^\s+(?:-[iv0]+|--ignore-environment|--null|--debug|--?|(?:-u\s*|--unset[=\s]\s*)(?:"[^"]*"|'[^']*'|[^\s"']+)|(?:-C\s*|--chdir[=\s]\s*)("[^"]*"|'[^']*'|[^\s"']+)|\w+=(?:"[^"]*"|'[^']*'|[^\s"'])*)(?=\s)/;

/** A step without its wrappers (`nohup`, `env A=1`, …), and the folders its `env -C` gives, as written. */
function unwrap(step: string): { text: string; dirs: string[] } {
  let text = step;
  const dirs: string[] = [];
  for (;;) {
    const w = WRAPPER.exec(text);
    if (w) {
      text = text.slice(w[0].length);
      continue;
    }
    const e = /^\s*env(?=\s)/.exec(text);
    if (!e) break;
    text = text.slice(e[0].length);
    for (let a = ENV_ARG.exec(text); a; a = ENV_ARG.exec(text)) {
      if (a[1] !== undefined) dirs.push(a[1]);
      text = text.slice(a[0].length);
    }
  }
  return { text: text.replace(/&\s*$/, ''), dirs };
}

/** A line's words, quotes kept (`-WorkingDirectory:'C:\my dir'` is one word). */
const rawWords = (s: string) => s.match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) ?? [];
const unquote = (w: string) => w.replace(/"([^"]*)"|'([^']*)'/g, '$1$2');

/**
 * Start-Process's parameters (pwsh 7 and Windows PowerShell 5.1, common ones included) and their aliases. PowerShell
 * also takes any prefix of a name that fits only one (`-Wo` is -WorkingDirectory; `-W` fits several and fails).
 */
const SP_PARAMS = ['FilePath', 'ArgumentList', 'Credential', 'WorkingDirectory', 'LoadUserProfile', 'NoNewWindow', 'PassThru', 'RedirectStandardError', 'RedirectStandardInput', 'RedirectStandardOutput', 'Verb', 'WindowStyle', 'Wait', 'UseNewEnvironment', 'Environment', 'Verbose', 'Debug', 'ErrorAction', 'WarningAction', 'InformationAction', 'ProgressAction', 'ErrorVariable', 'WarningVariable', 'InformationVariable', 'OutVariable', 'OutBuffer', 'PipelineVariable', 'WhatIf', 'Confirm'].map((p) => p.toLowerCase());
const SP_ALIAS: Record<string, string> = { pspath: 'filepath', path: 'filepath', args: 'argumentlist', runas: 'credential', lup: 'loaduserprofile', nnw: 'nonewwindow', rse: 'redirectstandarderror', rsi: 'redirectstandardinput', rso: 'redirectstandardoutput', vb: 'verbose', db: 'debug', ea: 'erroraction', wa: 'warningaction', infa: 'informationaction', proga: 'progressaction', ev: 'errorvariable', wv: 'warningvariable', iv: 'informationvariable', ov: 'outvariable', ob: 'outbuffer', pv: 'pipelinevariable', wi: 'whatif', cf: 'confirm' };
/** The ones that take no value. */
const SP_SWITCH = new Set(['loaduserprofile', 'nonewwindow', 'passthru', 'wait', 'usenewenvironment', 'verbose', 'debug', 'whatif', 'confirm']);

/**
 * What `Start-Process` (or `saps`, or `start`: PowerShell's alias, or cmd's own) runs, as a command line, and the folder
 * it gives the process (-WorkingDirectory, or cmd's `start /D`), as written. `unsure`: its parameters cannot be read (a
 * name that fits none or several, a splat, more than two positional values): which folder it starts in is unknown.
 * Undefined: not such a step.
 */
function startOf(text: string): { run: string; dir?: string; unsure?: boolean } | undefined {
  const m = /^\s*(Start-Process|saps|start)\s+/i.exec(text);
  if (!m) return undefined;
  const ws = rawWords(text.slice(m[0].length));
  if (/^start$/i.test(m[1])) {
    const c = cmdStart(ws);
    if (c) return c;
  }
  // PowerShell: `a, b` and `a ,b` are one list (one value).
  const vs: string[] = [];
  for (const w of ws) {
    const last = vs[vs.length - 1];
    if (last !== undefined && (last.endsWith(',') || w.startsWith(','))) vs[vs.length - 1] = last + w;
    else vs.push(w);
  }
  const named: Record<string, string> = {};
  const positional: string[] = [];
  let unsure = false;
  for (let i = 0; i < vs.length; i++) {
    const w = vs[i];
    if (w.startsWith('@')) unsure = true;
    // A redirect of the cmdlet's own output (`2>&1`, `*> out.txt`, `> $null`): not one of its parameters.
    if (/^[\d*]?>>?/.test(w)) {
      if (/^[\d*]?>>?$/.test(w)) i++;
      continue;
    }
    const p = /^-([A-Za-z]+)(?::([\s\S]*))?$/.exec(w);
    if (!p) {
      positional.push(w);
      continue;
    }
    const n = p[1].toLowerCase();
    const fits = SP_PARAMS.includes(n) ? [n] : SP_ALIAS[n] ? [SP_ALIAS[n]] : SP_PARAMS.filter((x) => x.startsWith(n));
    if (fits.length !== 1) {
      unsure = true;
      continue;
    }
    if (SP_SWITCH.has(fits[0])) continue;
    const v = p[2] !== undefined ? p[2] : vs[++i];
    if (v === undefined) unsure = true;
    else named[fits[0]] = v;
  }
  // FilePath and ArgumentList may be given by position (0 and 1).
  for (const n of ['filepath', 'argumentlist']) if (named[n] === undefined && positional.length) named[n] = positional.shift()!;
  if (positional.length || named.filepath === undefined) unsure = true;
  const args = unquote((named.argumentlist ?? '').replace(/\s*,\s*/g, ' '));
  return { run: `"${unquote(named.filepath ?? '')}" ${args}`, dir: named.workingdirectory, unsure };
}

/** cmd's `start ["title"] [/D folder] [/B /MIN /WAIT …] program args`: undefined when the words do not read as one. */
function cmdStart(ws: string[]): { run: string; dir?: string; unsure?: boolean } | undefined {
  let i = 0;
  // A quoted first word is cmd's window title (PowerShell's `start "C:\x y\node.exe"` is its program).
  if (ws[0] === '""' || (/^["']/.test(ws[0] ?? '') && (ws[1] ?? '').startsWith('/'))) i = 1;
  else if (!(ws[0] ?? '').startsWith('/')) return undefined;
  let dir: string | undefined;
  let unsure = false;
  for (; i < ws.length && ws[i].startsWith('/'); i++) {
    const d = /^\/d([\s\S]*)$/i.exec(ws[i]);
    if (d) dir = d[1] || ws[++i];
    else if (/^\/(node|affinity)$/i.test(ws[i])) i++;
    else if (!/^\/(b|i|min|max|wait|low|normal|high|realtime|abovenormal|belownormal|separate|shared|machine(:\w+)?)$/i.test(ws[i])) unsure = true;
  }
  if (i >= ws.length) unsure = true;
  return { run: `"${unquote(ws[i] ?? '')}" ${ws.slice(i + 1).map(unquote).join(' ')}`, dir, unsure };
}

/**
 * Whether a step runs `key` (a script's or program's file name): the step without its wrappers, or what `Start-Process`
 * / `start` would run, has it as its program or as the script its interpreter runs (scriptToken).
 */
function runsScript(step: string, key: string): boolean {
  const { text } = unwrap(step);
  return scriptToken(startOf(text)?.run ?? text, key) !== undefined;
}

/**
 * The folders a launch step itself gives what it starts, in order, as written: `env -C x` / `--chdir=x`,
 * Start-Process's -WorkingDirectory, cmd's `start /D x`. Undefined: its own options cannot be read (startOf).
 */
function ownFolders(step: string): string[] | undefined {
  const { text, dirs } = unwrap(step);
  const s = startOf(text);
  if (s?.unsure) return undefined;
  return s?.dir !== undefined ? [...dirs, s.dir] : dirs;
}

/**
 * The folder a launch line ran in, by the shell's own rules, or undefined when that cannot be shown. It starts from
 * the tool call's own working folder (`workdir`, `cwd`), else `base` (the workflow's folder). A `cd` before the launch
 * moves it only when the launch runs only if that cd did: the cd starts the line or follows `;`, a new line or `&&`,
 * and only `&&` lies between it and the launch (`cd x && nohup … &`). A cd that may have been skipped or have failed
 * while the launch still ran (`true || cd x && …`, `cd x; nohup …`), one in a pipeline or sent to the background,
 * `popd`, a cd to `-`, `~` or a variable, or a line that groups commands (`( … )`, `{ … }`) leaves the folder unknown.
 * A cd after the launch does not matter. The folder the launch step itself gives what it starts comes last and wins
 * (Start-Process -WorkingDirectory, cmd's `start /D`, `env -C`): a full path whatever came before, a relative one
 * from the folder before the step. One that cannot be read (a variable, `~`, `%X%`, an expression, a Start-Process
 * parameter that fits none or several) leaves it unknown. `launched`: what the launch runs (its script or program), to
 * find its step.
 */
export function launchFolder(command: string, input: string | undefined, base: string, platform: NodeJS.Platform = process.platform, launched?: string): string | undefined {
  const P = platform === 'win32' ? path.win32 : path.posix;
  let dir: string | undefined = base;
  try {
    const i = input ? JSON.parse(input) : undefined;
    const given = [i?.workdir, i?.cwd, i?.directory, i?.working_directory].find((x) => typeof x === 'string' && x.trim());
    if (given) dir = P.resolve(native(base, platform), native(given.trim(), platform));
  } catch {
    // not JSON: the workflow's folder
  }
  const start = dir;
  const parts = steps(command);
  const blank = (t: string) => t.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
  // The step that launches: the one that runs it (as its program, or the script its interpreter runs, after nohup,
  // setsid, env…, or through Start-Process), not one that only names it (`echo job.js`). One that also goes to the
  // background wins over a foreground run of the same; none, or two that cannot be told apart: unknown.
  const name = launched?.replace(/^.*[\\/]/, '');
  if (!name) return undefined;
  const runs = parts.map((p, i) => ({ i, bg: p.sep === '&' || LAUNCH.test(p.text) })).filter((x) => runsScript(parts[x.i].text, name));
  const bg = runs.filter((x) => x.bg);
  const candidates = bg.length ? bg : runs;
  if (!candidates.length) return undefined;
  // Several steps run it: one folder only when they all start in the same one.
  const folders = candidates.map((c) => folderOf(c.i));
  return folders.every((f) => f !== undefined && f === folders[0]) ? folders[0] : undefined;

  /** The folder what the step at `k` starts runs in: the one before it, then the step's own (ownFolders). */
  function folderOf(k: number): string | undefined {
    const own = ownFolders(parts[k].text);
    if (!own || /[(){}]/.test(blank(parts[k].text))) return undefined;
    let dir = folderBefore(k);
    for (const raw of own) dir = moveTo(dir, raw);
    return dir;
  }

  /**
   * `dir` moved to `raw` (a folder as written): a full path whatever `dir` was, a relative one from `dir`. Undefined when
   * it cannot be read: a variable, `%X%`, `~`, `-`, an expression or splat, and on Windows `D:x` (relative to that
   * drive's own folder) or `/x` that is not Git Bash's `/c/…` (Git Bash and PowerShell read it differently).
   */
  function moveTo(dir: string | undefined, raw: string): string | undefined {
    const to = native(unquote(raw), platform);
    if (!to || /[$`%]/.test(raw) || /[()@]/.test(raw.replace(/"[^"]*"|'[^']*'/g, '')) || /^[~-]/.test(to)) return undefined;
    if (platform === 'win32') {
      if (/^[A-Za-z]:(?![\\/])/.test(to) || /^\/(?!\/)/.test(to)) return undefined;
      // `\x`: from the root of the current drive.
      if (/^\\(?!\\)/.test(to)) return dir ? P.resolve(native(dir, platform), to) : undefined;
    }
    if (P.isAbsolute(to)) return P.resolve(to);
    return dir ? P.resolve(native(dir, platform), to) : undefined;
  }

  /** The folder the step at `k` starts in. */
  function folderBefore(k: number): string | undefined {
    let dir: string | undefined = start;
    if (parts.slice(0, k + 1).some((p) => /[(){}]/.test(blank(p.text)))) return undefined;
    for (let j = 0; j < k; j++) {
      const before = j > 0 ? parts[j - 1].sep : '';
      const text = parts[j].text;
      if (/^\s*popd\b/i.test(text)) return undefined;
      // Not a step that is only a cd: no effect on the folder.
      const cd = CD_STEP.exec(text);
      if (!cd) continue;
      // Piped or sent to the background: a subshell of its own, no effect on the steps after it.
      if (parts[j].sep === '|' || parts[j].sep === '&') continue;
      // It runs for sure when reached (it starts the line or follows ;, a new line, & or &&), and the launch runs only
      // if it worked (only && after it).
      const certain = ['', ';', '\n', '&', '&&'].includes(before) && parts.slice(j, k).every((p) => p.sep === '&&');
      if (!certain) return undefined;
      dir = moveTo(dir, cd[1]);
      if (!dir) return undefined;
    }
    return dir;
  }
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
