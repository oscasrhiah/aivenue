import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const isWin = process.platform === 'win32';

export interface ResolvedCommand {
  /** Executable to spawn directly (never through a shell). */
  file: string;
  /** Arguments that must precede the user's arguments (e.g. the script path for node shims). */
  prefixArgs: string[];
  /** Human readable location. */
  display: string;
}

/** PATH used for child processes: the current PATH plus well-known install dirs. */
export function childPath(): string {
  const parts = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const extra: string[] = [];
  if (isWin) {
    if (process.env.APPDATA) extra.push(path.join(process.env.APPDATA, 'npm'));
    extra.push('C:\\Program Files\\nodejs', 'C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\GitHub CLI');
    if (process.env.LOCALAPPDATA) {
      extra.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd'));
      // winget "portable" installs (e.g. Antigravity CLI) put their command aliases here.
      extra.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
      extra.push(path.join(process.env.LOCALAPPDATA, 'agy', 'bin'));
    }
    // Freshly installed tools are in the registry PATH but not in an already-running app's env.
    extra.push(...readWindowsRegistryPath());
  } else {
    extra.push('/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.npm-global', 'bin'), path.join(os.homedir(), '.volta', 'bin'));
    // Apps started from the desktop don't get the PATH set in ~/.bashrc / ~/.zshrc (nvm, fnm, ~/.local/bin...).
    extra.push(...readLoginShellPath());
  }
  for (const e of extra) if (!parts.some((p) => p.toLowerCase() === e.toLowerCase())) parts.push(e);
  return parts.join(path.delimiter);
}

/** Read PATH again from the registry / login shell (after installing a tool while the app runs). */
export function refreshPathCache(): void {
  shellPathCache = undefined;
  registryPathCache = undefined;
}

let shellPathCache: string[] | undefined;
/** PATH as the user's login shell sets it (read once; empty when it can't be read within 3 s). */
function readLoginShellPath(): string[] {
  if (shellPathCache) return shellPathCache;
  shellPathCache = [];
  try {
    const shell = process.env.SHELL || '/bin/bash';
    const out = execFileSync(shell, ['-ilc', 'printf "__AIVENUE__%s__AIVENUE__" "$PATH"'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /__AIVENUE__(.*)__AIVENUE__/.exec(out);
    if (m) shellPathCache = m[1].split(':').filter(Boolean);
  } catch {
    // no usable shell
  }
  return shellPathCache;
}

let registryPathCache: string[] | undefined;
function readWindowsRegistryPath(): string[] {
  if (registryPathCache) return registryPathCache;
  registryPathCache = [];
  for (const key of ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
      if (m) {
        const expanded = m[1].trim().replace(/%([^%]+)%/g, (_, v: string) => process.env[v] ?? `%${v}%`);
        registryPathCache.push(...expanded.split(';').filter(Boolean));
      }
    } catch {
      // key missing or reg.exe unavailable
    }
  }
  return registryPathCache;
}

export function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Electron/VS Code may set this; it would make spawned `node` behave like Electron.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const p = childPath();
  if (isWin) {
    for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k];
    env.Path = p;
  } else {
    env.PATH = p;
  }
  return { ...env, ...extra };
}

function findOnPath(name: string): string | undefined {
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : undefined;
  const dirs = childPath().split(path.delimiter);
  const exts = isWin ? ['.exe', '.cmd', '.bat', '.com', ''] : [''];
  const hasExt = isWin && /\.(exe|cmd|bat|com|js|cjs|mjs)$/i.test(name);
  for (const dir of dirs) {
    for (const ext of hasExt ? [''] : exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

let nodeCache: string | undefined;
export function findNode(): string | undefined {
  if (nodeCache) return nodeCache;
  nodeCache = findOnPath('node');
  return nodeCache;
}

/**
 * Resolve a command name to something we can spawn without a shell.
 * npm installs `.cmd` shims on Windows; spawning those needs cmd.exe, which mangles
 * quoting, so we read the shim and spawn its target (an .exe or `node script.js`) directly.
 */
export function resolveCommand(command: string): ResolvedCommand | undefined {
  const found = findOnPath(command);
  if (!found) return undefined;
  if (/\.(js|cjs|mjs)$/i.test(found)) {
    const node = findNode();
    return node ? { file: node, prefixArgs: [found], display: found } : undefined;
  }
  if (isWin && /\.(cmd|bat)$/i.test(found)) {
    try {
      const text = fs.readFileSync(found, 'utf8');
      const targets = [...text.matchAll(/"%(?:dp0|~dp0)%\\?([^"]+)"/gi)].map((m) => m[1]).filter((t) => !/^node(\.exe)?$/i.test(t));
      const target = targets[targets.length - 1];
      if (target) {
        const abs = path.join(path.dirname(found), target);
        if (/\.exe$/i.test(abs) && fs.existsSync(abs)) return { file: abs, prefixArgs: [], display: found };
        // A .js file, or an extensionless script with a node shebang (e.g. npm's opencode bin).
        const nodeScript = /\.(js|cjs|mjs)$/i.test(abs) || (!path.extname(abs) && /^#!.*\bnode\b/.test(readHead(abs)));
        if (nodeScript && fs.existsSync(abs)) {
          const local = path.join(path.dirname(found), 'node.exe');
          const node = fs.existsSync(local) ? local : findNode();
          if (node) return { file: node, prefixArgs: [abs], display: found };
        }
      }
    } catch {
      // fall through
    }
    // Unknown shim layout: run through cmd.exe as a last resort.
    return { file: process.env.ComSpec || 'cmd.exe', prefixArgs: ['/d', '/s', '/c', found], display: found };
  }
  return { file: found, prefixArgs: [], display: found };
}

/** The executable to use for a provider: the first existing `commandPaths` entry, else `command`. */
export function specCommand(spec: { command: string; commandPaths?: string[] }): string {
  for (const p of spec.commandPaths ?? []) {
    const abs = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
    if (fs.existsSync(abs)) return abs;
  }
  return spec.command;
}

/** Whether the CLI accepts a reasoning effort for this model (some models behind one CLI refuse the flag). */
export function takesEffort(spec: { noEffortModels?: string }, model?: string): boolean {
  if (!spec.noEffortModels || !model) return true;
  try {
    return !new RegExp(spec.noEffortModels, 'i').test(model);
  } catch {
    return true;
  }
}

function readHead(file: string): string {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(200);
      return buf.subarray(0, fs.readSync(fd, buf, 0, 200, 0)).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** Characters cmd.exe acts on even inside quotes, or that end a quoted argument. */
const CMD_UNSAFE = /[&|<>^%!"\r\n]/;

export function spawnResolved(cmd: ResolvedCommand, args: string[], opts: SpawnOptions): ChildProcess {
  // The cmd.exe fallback would run text after `&` or `|` in an argument (a model name, a file name...) as a command.
  if (cmd.prefixArgs[0] === '/d' && /cmd(\.exe)?$/i.test(cmd.file)) {
    const bad = args.find((a) => CMD_UNSAFE.test(a));
    if (bad !== undefined) throw new Error(`${path.basename(cmd.display)} can only be started through cmd.exe, and an argument contains characters cmd.exe would interpret: ${bad.slice(0, 80)}`);
  }
  return spawn(cmd.file, [...cmd.prefixArgs, ...args], { windowsHide: true, ...opts });
}

export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (isWin) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

export interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Run a command to completion and capture output (used for status checks, git). */
export function capture(command: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string; env?: Record<string, string> } = {}): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const resolved = resolveCommand(command);
    if (!resolved) {
      resolve({ code: null, stdout: '', stderr: '', error: `command not found: ${command}` });
      return;
    }
    const child = spawnResolved(resolved, args, { cwd: opts.cwd, env: childEnv(opts.env), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => killTree(child), opts.timeoutMs ?? 20000);
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin?.end(opts.input ?? '');
  });
}

function quoteWin(arg: string): string {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

function quotePosix(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Open a visible terminal window running a command, so the user can finish an
 * interactive login (the CLI itself opens the browser and lets the user pick Google, email, ...).
 * `raw` is a full shell command line (used for install commands).
 */
export interface TerminalRequest {
  title: string;
  cwd?: string;
  command?: ResolvedCommand;
  args?: string[];
  /** A full shell command line (cmd.exe syntax on Windows, sh elsewhere). */
  raw?: string;
  env?: Record<string, string>;
}

/** The shell line a terminal should run: cmd.exe syntax on Windows, sh elsewhere (with the env exported). */
export function terminalLine(opts: TerminalRequest): string {
  if (isWin) return opts.raw ?? [opts.command!.file, ...opts.command!.prefixArgs, ...(opts.args ?? [])].map(quoteWin).join(' ');
  // POSIX terminals may not pass the environment on (a terminal server), so it is exported in the line too.
  const exports = Object.entries(opts.env ?? {})
    .map(([k, v]) => `export ${k}=${quotePosix(v)}; `)
    .join('');
  return exports + (opts.raw ?? [opts.command!.file, ...opts.command!.prefixArgs, ...(opts.args ?? [])].map(quotePosix).join(' '));
}

export function openTerminal(opts: TerminalRequest): void {
  const cwd = opts.cwd || os.homedir();
  const env = childEnv(opts.env);
  const line = terminalLine(opts);
  if (isWin) {
    const title = opts.title.replace(/"/g, "'");
    spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `start "${title}" cmd.exe /k "${line}"`], {
      cwd,
      env,
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    }).unref();
    return;
  }
  if (process.platform === 'darwin') {
    const script = `cd ${quotePosix(cwd)}; ${line}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    spawn('osascript', ['-e', `tell application "Terminal" to do script "${script}"`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  for (const term of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) {
    if (findOnPath(term)) {
      const args = term === 'gnome-terminal' ? ['--', 'bash', '-lc', `${line}; exec bash`] : ['-e', 'bash', '-lc', `${line}; exec bash`];
      spawn(term, args, { cwd, env, detached: true, stdio: 'ignore' }).unref();
      return;
    }
  }
  throw new Error('No terminal window could be opened (looked for x-terminal-emulator, gnome-terminal, konsole, xterm)');
}
