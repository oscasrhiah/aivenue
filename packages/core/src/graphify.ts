import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { capture } from './proc';
import { L } from './i18n';
import type { GraphifyStatus, GraphLink, GraphNode, GraphPayload } from './types';

/** Most nodes the graph window gets at once; a bigger graph is sent as its most connected nodes, and says so. */
export const GRAPH_MAX_NODES = 2000;
/** `graphify update` of a big project: parsing is local, but a first build of a large tree takes minutes. */
const BUILD_TIMEOUT_MS = 10 * 60000;
/** Changes from agent turns close together make one update. */
const DEBOUNCE_MS = 10000;

export interface GraphifyOptions {
  /** Graphify is on and its command is installed: nothing is built otherwise. */
  active: () => boolean;
  /** A folder's status changed (pushed to the pages as the `graphify` topic). */
  onChange: (s: GraphifyStatus) => void;
  /** The graphify command (tests give a stand-in script). */
  command?: string;
  timeoutMs?: number;
  debounceMs?: number;
  /** The user's home folder (tests give their own). */
  home?: string;
  log?: (line: string) => void;
}

interface Folder {
  cwd: string;
  state: GraphifyStatus['state'];
  builtAt?: number;
  nodes?: number;
  edges?: number;
  communities?: number;
  lastError?: string;
  reason?: string;
  startedAt?: number;
  running?: Promise<GraphifyStatus>;
  /** One follow-up asked for while a build ran: every request made meanwhile waits for it. */
  next?: { reason: string; promise: Promise<GraphifyStatus>; resolve: (s: GraphifyStatus) => void };
  timer?: NodeJS.Timeout;
}

const graphFile = (cwd: string) => path.join(cwd, 'graphify-out', 'graph.json');
const keyOf = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** "[graphify watch] Rebuilt: 581 nodes, 2484 edges, 20 communities" → the three numbers. */
export function parseRebuilt(out: string): { nodes: number; edges: number; communities?: number } | undefined {
  const m = /Rebuilt:\s*(\d+)\s*nodes?,\s*(\d+)\s*edges?(?:,\s*(\d+)\s*communit)?/i.exec(out);
  return m ? { nodes: Number(m[1]), edges: Number(m[2]), communities: m[3] === undefined ? undefined : Number(m[3]) } : undefined;
}

interface Parsed {
  stamp: string;
  nodes: GraphNode[];
  links: GraphLink[];
  communities: number;
  version?: string;
}

/**
 * Builds and reads the Graphify graph of the folders workflows work in: `graphify update <folder>` (local parsing, no
 * model), one build at a time per folder, requests made during a build folded into one follow-up.
 */
export class GraphifyService {
  private folders = new Map<string, Folder>();
  /** Repositories whose local exclude file already lists graphify-out/ (checked once each). */
  private excluded = new Set<string>();
  private parsed = new Map<string, Parsed>();
  private reading = new Set<string>();

  constructor(private o: GraphifyOptions) {}

  active(): boolean {
    return this.o.active();
  }

  private folder(cwd: string): Folder {
    const key = keyOf(cwd);
    let f = this.folders.get(key);
    if (!f) this.folders.set(key, (f = { cwd: path.resolve(cwd), state: 'idle' }));
    return f;
  }

  /** The folder's graph as it stands: the last build here, else what graphify-out/graph.json says. */
  status(cwd: string): GraphifyStatus {
    const f = this.folders.get(keyOf(cwd));
    const dir = path.resolve(cwd);
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(graphFile(dir));
    } catch {
      // no graph yet
    }
    const s: GraphifyStatus = {
      cwd: dir,
      active: this.o.active(),
      exists: !!st?.isFile(),
      state: f?.state ?? 'idle',
      builtAt: f?.builtAt,
      nodes: f?.nodes,
      edges: f?.edges,
      communities: f?.communities,
      lastError: f?.lastError,
      reason: f?.reason,
      startedAt: f?.state === 'building' ? f.startedAt : undefined,
    };
    // Built before this hub started, or written since by someone else (an agent running graphify): the file's time, and
    // its counts once read.
    if (st?.isFile() && (s.builtAt === undefined || st.mtimeMs > s.builtAt + 1000)) {
      Object.assign(s, { builtAt: st.mtimeMs, nodes: undefined, edges: undefined, communities: undefined });
      const p = this.parsed.get(keyOf(dir));
      if (p && p.stamp === `${st.mtimeMs}:${st.size}`) Object.assign(s, { nodes: p.nodes.length, edges: p.links.length, communities: p.communities });
      // Not read yet: read it once in the background and say the counts then.
      else if (!this.reading.has(keyOf(dir))) {
        this.reading.add(keyOf(dir));
        void this.read(dir)
          .then(() => this.o.onChange(this.status(dir)))
          .catch(() => undefined)
          .finally(() => this.reading.delete(keyOf(dir)));
      }
    }
    return s;
  }

  private emit(f: Folder) {
    this.o.onChange(this.status(f.cwd));
  }

  /** Why Aivenue builds no graph here: a whole drive or the home folder would mean parsing everything on it. */
  private refusal(cwd: string): string | undefined {
    const p = path.resolve(cwd);
    const root = path.parse(p).root;
    if (keyOf(p) === keyOf(root)) return L(`不為整個磁碟建立圖譜（${p}）：請開啟專案資料夾`, `No graph for a whole drive (${p}): open a project folder`);
    if (keyOf(p) === keyOf(this.o.home ?? os.homedir())) return L(`不為家目錄建立圖譜（${p}）：請開啟專案資料夾`, `No graph for the home folder (${p}): open a project folder`);
    return undefined;
  }

  /**
   * Update the folder's graph. Resolves when the build that covers this request ended: the one running (if it started
   * after the request) or the single follow-up every request made during a build shares.
   */
  ensure(cwd: string, reason: string): Promise<GraphifyStatus> {
    const f = this.folder(cwd);
    // This build covers a pending debounced one.
    if (f.timer) {
      clearTimeout(f.timer);
      f.timer = undefined;
    }
    if (!this.o.active()) return Promise.resolve(this.status(cwd));
    const why = this.refusal(cwd);
    if (why) {
      if (f.lastError !== why) {
        this.o.log?.(`[graphify] ${f.cwd}: ${why}`);
        Object.assign(f, { state: 'failed', lastError: why, reason });
        this.emit(f);
      }
      return Promise.resolve(this.status(cwd));
    }
    if (!f.running) return this.launch(f, reason);
    if (!f.next) {
      let resolve!: (s: GraphifyStatus) => void;
      const promise = new Promise<GraphifyStatus>((r) => (resolve = r));
      f.next = { reason, promise, resolve };
    }
    return f.next.promise;
  }

  private launch(f: Folder, reason: string): Promise<GraphifyStatus> {
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
    if (!this.o.active() || this.refusal(cwd)) return;
    const f = this.folder(cwd);
    if (f.timer) clearTimeout(f.timer);
    f.timer = setTimeout(() => {
      f.timer = undefined;
      void this.ensure(cwd, reason);
    }, this.o.debounceMs ?? DEBOUNCE_MS);
    f.timer.unref?.();
  }

  /** Whether an update is waiting for its debounce (tests). */
  scheduled(cwd: string): boolean {
    return !!this.folders.get(keyOf(cwd))?.timer;
  }

  private async build(f: Folder, reason: string): Promise<GraphifyStatus> {
    const timeoutMs = this.o.timeoutMs ?? BUILD_TIMEOUT_MS;
    Object.assign(f, { state: 'building', reason, startedAt: Date.now() });
    this.emit(f);
    const t0 = Date.now();
    try {
      const r = await capture(this.o.command ?? 'graphify', ['update', f.cwd], { cwd: f.cwd, timeoutMs, env: { GRAPHIFY_NO_TIPS: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
      const out = `${r.stdout}\n${r.stderr}`;
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const refusedLine = lines.find((l) => /refusing to overwrite/i.test(l));
      if (refusedLine) {
        // graphify keeps the old graph when the new one has fewer nodes; only --force overrides that, and that is the user's call.
        Object.assign(f, {
          state: 'refused',
          lastError: L(`graphify 保留了原本的圖譜，因為新的圖節點比較少。確認沒有誤刪檔案後，可在專案資料夾執行 graphify update . --force 覆寫。${clip(refusedLine, 240)}`, `graphify kept the old graph because the new one has fewer nodes. If no files were deleted by mistake, run graphify update . --force in the project folder to overwrite it. ${clip(refusedLine, 240)}`),
        });
      } else if (r.code === 0) {
        let counts: { nodes?: number; edges?: number; communities?: number } | undefined = parseRebuilt(out);
        if (counts?.communities === undefined) {
          const p = await this.read(f.cwd).catch(() => undefined);
          if (p) counts = { nodes: counts?.nodes ?? p.nodes.length, edges: counts?.edges ?? p.links.length, communities: p.communities };
        }
        let builtAt = Date.now();
        try {
          builtAt = fs.statSync(graphFile(f.cwd)).mtimeMs;
        } catch {
          // graphify said it finished; its time is now
        }
        Object.assign(f, { state: 'idle', builtAt, lastError: undefined, ...counts });
        await this.exclude(f.cwd);
      } else {
        const timedOut = Date.now() - t0 >= timeoutMs;
        const tail = clip(lines.filter((l) => !/^Re-extracting|^Tip:/i.test(l)).slice(-3).join(' '), 400);
        Object.assign(f, {
          state: 'failed',
          lastError: timedOut
            ? L(`graphify 超過 ${Math.round(timeoutMs / 60000)} 分鐘沒有完成，已停止`, `graphify did not finish within ${Math.round(timeoutMs / 60000)} minutes and was stopped`)
            : r.error
              ? L(`無法執行 graphify：${r.error}`, `Could not run graphify: ${r.error}`)
              : tail || L(`graphify 結束代碼 ${r.code}`, `graphify exited with code ${r.code}`),
        });
      }
    } catch (e) {
      Object.assign(f, { state: 'failed', lastError: (e as Error).message });
    }
    f.startedAt = undefined;
    if (f.state !== 'idle') this.o.log?.(`[graphify] ${f.cwd}: ${f.state}: ${f.lastError ?? ''}`);
    this.emit(f);
    return this.status(f.cwd);
  }

  /**
   * In a git repository: graphify-out/ in its local exclude file (`git rev-parse --git-path info/exclude`, which a
   * worktree shares with its repository), once. .gitignore is the project's own and is never touched.
   */
  private async exclude(cwd: string): Promise<void> {
    const key = keyOf(cwd);
    if (this.excluded.has(key)) return;
    this.excluded.add(key);
    try {
      const r = await capture('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd, timeoutMs: 15000 });
      const rel = r.stdout.trim();
      if (r.code !== 0 || !rel) return;
      const file = path.resolve(cwd, rel);
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        // not there yet
      }
      if (/^\/?graphify-out\/?\s*$/m.test(text)) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}# Aivenue: the Graphify graph it builds\ngraphify-out/\n`);
    } catch (e) {
      this.o.log?.(`[graphify] ${cwd}: could not add graphify-out/ to the git exclude file: ${(e as Error).message}`);
    }
  }

  /** graph.json read and trimmed to what the window shows, kept until the file changes. */
  private async read(cwd: string): Promise<Parsed> {
    const file = graphFile(cwd);
    const st = await fs.promises.stat(file);
    const stamp = `${st.mtimeMs}:${st.size}`;
    const key = keyOf(cwd);
    const cached = this.parsed.get(key);
    if (cached?.stamp === stamp) return cached;
    const raw = JSON.parse(await fs.promises.readFile(file, 'utf8')) as { nodes?: Record<string, unknown>[]; links?: Record<string, unknown>[]; edges?: Record<string, unknown>[]; graph?: { graphify_version?: string } };
    const links: GraphLink[] = (raw.links ?? raw.edges ?? []).map((l) => ({ source: String(l.source), target: String(l.target), relation: String(l.relation ?? '') }));
    const degree = new Map<string, number>();
    for (const l of links) {
      degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
      degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
    }
    const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
    const nodes: GraphNode[] = (raw.nodes ?? []).map((n) => ({
      id: String(n.id),
      label: str(n.label) ?? String(n.id),
      community: typeof n.community === 'number' ? n.community : undefined,
      community_name: str(n.community_name),
      file_type: str(n.file_type),
      source_file: str(n.source_file),
      source_location: str(n.source_location),
      degree: degree.get(String(n.id)) ?? 0,
    }));
    const communities = new Set(nodes.map((n) => n.community).filter((c) => c !== undefined)).size;
    const p: Parsed = { stamp, nodes, links, communities, version: raw.graph?.graphify_version };
    this.parsed.set(key, p);
    return p;
  }

  /** The graph for the window: all of it, or its `max` most connected nodes and the links between them. */
  async graph(cwd: string, max = GRAPH_MAX_NODES): Promise<GraphPayload> {
    let p: Parsed;
    try {
      p = await this.read(cwd);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(L('這個資料夾還沒有圖譜', 'This folder has no graph yet'));
      throw new Error(L(`讀不到圖譜：${(e as Error).message}`, `Could not read the graph: ${(e as Error).message}`));
    }
    const capped = p.nodes.length > max;
    const nodes = capped ? [...p.nodes].sort((a, b) => b.degree - a.degree).slice(0, max) : p.nodes;
    const keep = new Set(nodes.map((n) => n.id));
    const links = capped ? p.links.filter((l) => keep.has(l.source) && keep.has(l.target)) : p.links;
    const st = this.status(cwd);
    return { cwd: path.resolve(cwd), nodes, links, totalNodes: p.nodes.length, totalLinks: p.links.length, communities: p.communities, builtAt: st.builtAt, graphifyVersion: p.version, capped };
  }

  /**
   * An agent's graph lookup (graph_query / graph_path / graph_explain): `graphify query|path|explain …` in the folder,
   * its answer as text. A failure is said in the answer (with the way on: plain search), never thrown at the agent.
   */
  async lookup(cwd: string, args: string[]): Promise<string> {
    if (args.slice(1).some((a) => !a.trim())) return 'Give the name or question to look up.';
    const timeoutMs = 60000;
    const t0 = Date.now();
    const r = await capture(this.o.command ?? 'graphify', args, { cwd, timeoutMs, env: { GRAPHIFY_NO_TIPS: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    const out = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim();
    const MAX = 16000;
    const text = out.length > MAX ? `${out.slice(0, MAX)}\n… (${out.length - MAX} more characters cut; ask a narrower question)` : out;
    if (r.code === 0) return text || 'The graph has no answer for this. Fall back to normal source search (rg / grep / reading files).';
    // 3: the name is ambiguous (graphify lists the candidates); 4: no matching node.
    if (r.code === 3 || r.code === 4) return `${text}\n(graphify exit ${r.code}: ${r.code === 3 ? 'the name is ambiguous, pick one of the candidates' : 'no matching node'})`;
    const why = Date.now() - t0 >= timeoutMs ? `graphify did not answer within ${timeoutMs / 1000} s` : r.error ?? `graphify exited with code ${r.code}`;
    return `${why}.${text ? `\n${clip(text, 2000)}` : ''}\nFall back to normal source search (rg / grep / reading files) and say in your report that the graph was not used.`;
  }

  shutdown(): void {
    for (const f of this.folders.values()) if (f.timer) clearTimeout(f.timer);
  }
}
