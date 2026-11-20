import * as fs from 'node:fs';
import * as path from 'node:path';
import { capture } from './proc';
import { L } from './i18n';
import { addGitExclude, driveOrHome } from './graphify';
import type { CodeGraphStatus } from './types';

export type { CodeGraphStatus };

/*
 * CodeGraph (https://github.com/colbymchenry/codegraph, MIT): a local code index (symbols, calls, imports) per project in
 * <project>/.codegraph/. Aivenue installs a pinned version into its own tools folder with npm (no PATH change, no admin,
 * no agent wiring: `codegraph install` is never run), keeps each working folder's index up to date with one-shot
 * `codegraph init` / `codegraph sync` runs, and answers the agents' CodeGraph tools with one-shot CLI queries (the same
 * output as its MCP tools). Its MCP server is not used: in direct mode only one may serve a project at a time (a second
 * one exits on the writer lock), and the alternative is its long-running shared daemon with a file watcher.
 */

/** The version Aivenue installs (released 2026-10-03; 1.6.3 was too new to pin). */
export const CODEGRAPH_VERSION = '1.6.2';
export const CODEGRAPH_PACKAGE = '@colbymchenry/codegraph';

/**
 * The environment of every CodeGraph process Aivenue starts: no telemetry (DO_NOT_TRACK also turns off its daily update
 * check), no bundle download, no shared daemon and no file watcher (Aivenue runs one-shot commands and syncs itself).
 */
export const CODEGRAPH_ENV: Record<string, string> = {
  DO_NOT_TRACK: '1',
  CODEGRAPH_TELEMETRY: '0',
  CODEGRAPH_NO_UPDATE_CHECK: '1',
  CODEGRAPH_NO_DOWNLOAD: '1',
  CODEGRAPH_NO_DAEMON: '1',
  CODEGRAPH_NO_WATCH: '1',
};

/** Where Aivenue installs it (npm --prefix) and the script that starts it (npm's launcher for the platform bundle). */
export const codegraphDir = (toolsDir: string) => path.join(toolsDir, 'codegraph');
export const codegraphShim = (toolsDir: string) => path.join(codegraphDir(toolsDir), 'node_modules', '@colbymchenry', 'codegraph', 'npm-shim.js');

const BUILD_TIMEOUT_MS = 10 * 60000;
const DEBOUNCE_MS = 10000;
const LOOKUP_TIMEOUT_MS = 60000;
const MAX_OUTPUT = 16000;

const keyOf = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const indexFile = (cwd: string) => path.join(cwd, '.codegraph', 'codegraph.db');


export interface CodeGraphOptions {
  active: () => boolean;
  /** The CodeGraph launcher (codegraphShim), or a stand-in in tests. */
  command: () => string;
  onChange?: (s: CodeGraphStatus) => void;
  timeoutMs?: number;
  debounceMs?: number;
  home?: string;
  log?: (line: string) => void;
}

interface Folder {
  cwd: string;
  state: CodeGraphStatus['state'];
  indexedAt?: number;
  files?: number;
  symbols?: number;
  edges?: number;
  lastError?: string;
  reason?: string;
  startedAt?: number;
  running?: Promise<CodeGraphStatus>;
  next?: { reason: string; promise: Promise<CodeGraphStatus>; resolve: (s: CodeGraphStatus) => void };
  timer?: NodeJS.Timeout;
  excluded?: boolean;
}

/** The agent tools Aivenue offers for CodeGraph, and the CLI command each one runs. */
export const CODEGRAPH_TOOLS = ['codegraph_explore', 'codegraph_node', 'codegraph_search', 'codegraph_callers', 'codegraph_callees', 'codegraph_impact'] as const;
export type CodeGraphTool = (typeof CODEGRAPH_TOOLS)[number];

/** The CLI arguments for one tool call (the CLI prints what the MCP tool of the same name returns). */
export function codegraphArgs(tool: CodeGraphTool, a: Record<string, unknown>, cwd: string): string[] | string {
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string).trim() : a[k] === undefined || a[k] === null ? '' : String(a[k]).trim());
  const file = s('file') ? ['--file', s('file')] : [];
  const need = (k: string) => (s(k) ? undefined : `Give "${k}".`);
  switch (tool) {
    case 'codegraph_explore':
      return need('query') ?? ['explore', s('query'), '--path', cwd];
    case 'codegraph_node':
      return need('name') ?? ['node', s('name'), '--path', cwd, ...file];
    case 'codegraph_search':
      return need('query') ?? ['query', s('query'), '--path', cwd, '--limit', String(Math.min(50, Number(a.limit) || 20)), ...(s('kind') ? ['--kind', s('kind')] : [])];
    case 'codegraph_callers':
    case 'codegraph_callees':
      return need('symbol') ?? [tool === 'codegraph_callers' ? 'callers' : 'callees', s('symbol'), '--path', cwd, '--limit', String(Math.min(100, Number(a.limit) || 30)), ...file];
    case 'codegraph_impact':
      return need('symbol') ?? ['impact', s('symbol'), '--path', cwd, '--depth', String(Math.min(5, Math.max(1, Number(a.depth) || 2))), ...file];
  }
}

/**
 * The CodeGraph index of the folders workflows work in: built when missing (`codegraph init -y`), brought up to date
 * otherwise (`codegraph sync`), one run at a time per folder, requests made during one folded into a single follow-up.
 */
export class CodeGraphService {
  private folders = new Map<string, Folder>();

  constructor(private o: CodeGraphOptions) {}

  active(): boolean {
    return this.o.active();
  }

  /** The folder has an index agents can query. */
  indexed(cwd: string): boolean {
    return fs.existsSync(indexFile(cwd));
  }

  private folder(cwd: string): Folder {
    const key = keyOf(cwd);
    let f = this.folders.get(key);
    if (!f) this.folders.set(key, (f = { cwd: path.resolve(cwd), state: 'idle' }));
    return f;
  }

  status(cwd: string): CodeGraphStatus {
    const f = this.folders.get(keyOf(cwd));
    return {
      cwd: path.resolve(cwd),
      active: this.o.active(),
      indexed: this.indexed(cwd),
      state: f?.state ?? 'idle',
      indexedAt: f?.indexedAt,
      files: f?.files,
      symbols: f?.symbols,
      edges: f?.edges,
      lastError: f?.lastError,
      reason: f?.reason,
      startedAt: f?.state === 'building' ? f.startedAt : undefined,
    };
  }

  private emit(f: Folder) {
    this.o.onChange?.(this.status(f.cwd));
  }

  private refusal(cwd: string): string | undefined {
    const where = driveOrHome(cwd, this.o.home);
    if (where === 'drive') return L(`不為整個磁碟建立 CodeGraph 索引（${cwd}）：請開啟專案資料夾`, `No CodeGraph index for a whole drive (${cwd}): open a project folder`);
    if (where === 'home') return L(`不為家目錄建立 CodeGraph 索引（${cwd}）：請開啟專案資料夾`, `No CodeGraph index for the home folder (${cwd}): open a project folder`);
    return undefined;
  }

  /** Build or update the folder's index; resolves when the run that covers this request ended. */
  ensure(cwd: string, reason: string): Promise<CodeGraphStatus> {
    const f = this.folder(cwd);
    if (f.timer) {
      clearTimeout(f.timer);
      f.timer = undefined;
    }
    if (!this.o.active()) return Promise.resolve(this.status(cwd));
    const why = this.refusal(path.resolve(cwd));
    if (why) {
      if (f.lastError !== why) {
        this.o.log?.(`[codegraph] ${f.cwd}: ${why}`);
        Object.assign(f, { state: 'failed', lastError: why, reason });
        this.emit(f);
      }
      return Promise.resolve(this.status(cwd));
    }
    if (!f.running) return this.launch(f, reason);
    if (!f.next) {
      let resolve!: (s: CodeGraphStatus) => void;
      const promise = new Promise<CodeGraphStatus>((r) => (resolve = r));
      f.next = { reason, promise, resolve };
    }
    return f.next.promise;
  }

  private launch(f: Folder, reason: string): Promise<CodeGraphStatus> {
    const p = this.build(f, reason).finally(() => {
      f.running = undefined;
      const n = f.next;
      f.next = undefined;
      if (n) void this.launch(f, n.reason).then(n.resolve);
    });
    f.running = p;
    return p;
  }

  /** An update after agents changed files: later, once, however many turns asked within the wait. */
  schedule(cwd: string, reason = 'edit'): void {
    if (!this.o.active() || this.refusal(path.resolve(cwd))) return;
    const f = this.folder(cwd);
    if (f.timer) clearTimeout(f.timer);
    f.timer = setTimeout(() => {
      f.timer = undefined;
      void this.ensure(cwd, reason);
    }, this.o.debounceMs ?? DEBOUNCE_MS);
    f.timer.unref?.();
  }

  scheduled(cwd: string): boolean {
    return !!this.folders.get(keyOf(cwd))?.timer;
  }

  private run(cwd: string, args: string[], timeoutMs: number) {
    return capture(this.o.command(), args, { cwd, timeoutMs, env: CODEGRAPH_ENV });
  }

  private async build(f: Folder, reason: string): Promise<CodeGraphStatus> {
    const timeoutMs = this.o.timeoutMs ?? BUILD_TIMEOUT_MS;
    Object.assign(f, { state: 'building', reason, startedAt: Date.now() });
    this.emit(f);
    const t0 = Date.now();
    try {
      // -y: no prompts (it is a background run); init builds the whole index in the same step.
      const args = this.indexed(f.cwd) ? ['sync', f.cwd] : ['init', '-y', f.cwd];
      const r = await this.run(f.cwd, args, timeoutMs);
      if (r.code === 0 && this.indexed(f.cwd)) {
        const st = await this.run(f.cwd, ['status', '--json', f.cwd], 60000);
        let counts: Partial<Folder> = {};
        try {
          const j = JSON.parse(st.stdout.slice(st.stdout.indexOf('{'))) as { fileCount?: number; nodeCount?: number; edgeCount?: number; lastIndexed?: string };
          counts = { files: j.fileCount, symbols: j.nodeCount, edges: j.edgeCount, indexedAt: j.lastIndexed ? Date.parse(j.lastIndexed) : Date.now() };
        } catch {
          counts = { indexedAt: Date.now() };
        }
        Object.assign(f, { state: 'idle', lastError: undefined, ...counts });
        if (!f.excluded) {
          f.excluded = true;
          await addGitExclude(f.cwd, '.codegraph/', 'the CodeGraph index it builds', this.o.log);
        }
      } else {
        const timedOut = Date.now() - t0 >= timeoutMs;
        const lines = `${r.stdout}\n${r.stderr}`.split(/\r?\n/).map((l) => l.replace(/^[│┌└◆●◇\s]+/, '').trim()).filter(Boolean);
        Object.assign(f, {
          state: 'failed',
          lastError: timedOut
            ? L(`CodeGraph 超過 ${Math.round(timeoutMs / 60000)} 分鐘沒有完成，已停止`, `CodeGraph did not finish within ${Math.round(timeoutMs / 60000)} minutes and was stopped`)
            : r.error
              ? L(`無法執行 CodeGraph：${r.error}`, `Could not run CodeGraph: ${r.error}`)
              : clip(lines.slice(-3).join(' '), 400) || L(`CodeGraph 結束代碼 ${r.code}`, `CodeGraph exited with code ${r.code}`),
        });
      }
    } catch (e) {
      Object.assign(f, { state: 'failed', lastError: (e as Error).message });
    }
    f.startedAt = undefined;
    if (f.state !== 'idle') this.o.log?.(`[codegraph] ${f.cwd}: ${f.state}: ${f.lastError ?? ''}`);
    this.emit(f);
    return this.status(f.cwd);
  }

  /** An agent's CodeGraph tool call, answered by the CLI. A failure is said in the answer, with the way on. */
  async lookup(cwd: string, tool: CodeGraphTool, a: Record<string, unknown>): Promise<string> {
    const args = codegraphArgs(tool, a, cwd);
    if (typeof args === 'string') return args;
    const t0 = Date.now();
    const r = await this.run(cwd, args, LOOKUP_TIMEOUT_MS);
    const out = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim();
    const text = out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n… (${out.length - MAX_OUTPUT} more characters cut; ask a narrower question)` : out;
    if (r.code === 0) return text || 'CodeGraph has no answer for this. Fall back to normal source search (rg / grep / reading files).';
    const why = Date.now() - t0 >= LOOKUP_TIMEOUT_MS ? `CodeGraph did not answer within ${LOOKUP_TIMEOUT_MS / 1000} s` : r.error ?? `CodeGraph exited with code ${r.code}`;
    return `${why}.${text ? `\n${clip(text, 2000)}` : ''}\nFall back to normal source search (rg / grep / reading files) and say in your report that CodeGraph was not used.`;
  }

  shutdown(): void {
    for (const f of this.folders.values()) if (f.timer) clearTimeout(f.timer);
  }
}
