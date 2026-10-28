import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { AgentRole, OmniCandidate, OmniTest, ExtensionId, ExtensionsConfig, ExtensionSkill, ExtensionStatus, InstructionRole, ModelInfo, PonytailLevel, ProviderInfo, ProviderSpec } from './types';
import { type CapabilityStore, type ExtraSkill, parseFrontmatter } from './capabilities';
import { capture, childEnv, findNode, killTree, refreshPathCache, resolveCommand, spawnResolved, type CaptureResult } from './proc';
import type { ProviderRegistry } from './providers/registry';
import { BUILTIN_PROVIDERS } from './providers/builtin';
import type { SecretStore } from './secrets';
import { L } from './i18n';

const isWin = process.platform === 'win32';
const WRITERS: InstructionRole[] = ['planner', 'executor', 'subagent'];
const REVIEWERS: InstructionRole[] = ['plan_reviewer', 'code_reviewer'];

/** Ponytail: the main skill for everyone who writes, its review skill for code review, the reports on request. */
const PONYTAIL: Record<string, { roles: InstructionRole[]; always?: boolean }> = {
  ponytail: { roles: [...WRITERS, 'plan_reviewer'], always: true },
  'ponytail-review': { roles: ['code_reviewer'], always: true },
  'ponytail-audit': { roles: ['executor', 'subagent', 'code_reviewer'] },
  'ponytail-debt': { roles: ['executor', 'code_reviewer'] },
};

/**
 * Agent Skills (Addy Osmani): who gets each skill by default. Off by default: skills that interview the user
 * (a headless agent cannot ask), the meta skill about invoking skills (Aivenue lists them itself), and the ones
 * that spawn their own review loops on every decision.
 */
const AGENT_SKILLS: Record<string, { roles: InstructionRole[]; off?: 'interactive' | 'heavy' | 'meta' }> = {
  'api-and-interface-design': { roles: ['planner', 'executor', 'plan_reviewer'] },
  'browser-testing-with-devtools': { roles: ['executor', 'subagent'] },
  'ci-cd-and-automation': { roles: ['executor'] },
  'code-review-and-quality': { roles: ['code_reviewer'] },
  'code-simplification': { roles: ['executor', 'code_reviewer'] },
  'constraint-driven-development': { roles: ['planner'], off: 'interactive' },
  'context-engineering': { roles: ['planner'], off: 'meta' },
  'debugging-and-error-recovery': { roles: ['executor', 'subagent'] },
  'deprecation-and-migration': { roles: ['planner', 'executor'] },
  'documentation-and-adrs': { roles: ['planner', 'executor'] },
  'doubt-driven-development': { roles: ['planner', 'executor'], off: 'heavy' },
  'frontend-ui-engineering': { roles: ['executor'] },
  'git-workflow-and-versioning': { roles: ['executor'] },
  'idea-refine': { roles: ['planner'], off: 'interactive' },
  'incremental-implementation': { roles: ['executor'] },
  'interview-me': { roles: ['planner'], off: 'interactive' },
  'observability-and-instrumentation': { roles: ['executor'] },
  'performance-optimization': { roles: ['executor', 'code_reviewer'] },
  'planning-and-task-breakdown': { roles: ['planner', 'plan_reviewer'] },
  'security-and-hardening': { roles: ['executor', 'code_reviewer', 'plan_reviewer'] },
  'shipping-and-launch': { roles: ['planner', 'executor'] },
  'source-driven-development': { roles: ['planner', 'executor', 'subagent'] },
  'spec-driven-development': { roles: ['planner', 'plan_reviewer'] },
  'test-driven-development': { roles: ['executor', 'code_reviewer'] },
  'using-agent-skills': { roles: ['planner'], off: 'meta' },
};

const PONYTAIL_LEVEL: Record<PonytailLevel, string> = {
  lite: 'level lite — build what was asked; name the smaller option in one line',
  full: 'level full',
  ultra: 'level ultra — also push back on any part of the request the need does not justify',
};

const OMNI_PROVIDER = 'omniroute';
const OMNI_PORT = 20128;
const OMNI_EFFORTS = ['low', 'medium', 'high'];

/** How a step usually goes: its share of the install (from–to %), its usual length, and how many output lines it prints. */
interface Estimate {
  from: number;
  to: number;
  ms: number;
  lines?: number;
}
/** npm install of OmniRoute: about four minutes on a fresh machine (its output line count varies too much to use). */
const NPM_EST: Estimate = { from: 0, to: 90, ms: 240000 };
const FREE_POOLS = ['auto/best-free', 'auto/coding:free'];
const MAX_OMNI_MODELS = 120;

interface OmniModel {
  id: string;
  name?: string;
  owned_by?: string;
  context_length?: number;
  capabilities?: { tool_calling?: boolean; reasoning?: boolean; thinking?: boolean; vision?: boolean };
  input_modalities?: string[];
  pricing?: { prompt?: string; input?: number };
}

/** A graph is a shortcut, never a dependency: when it fails, the work goes on with plain search. */
const GRAPH_FALLBACK = 'If a graphify command fails, times out or returns nothing useful, do not stop or retry it repeatedly: fall back to normal source search (rg / grep / glob, reading files) and say in your report that the graph was not used.';

/**
 * Built-in extensions, all off until the user turns them on:
 * - Ponytail and Agent Skills: skills shipped with the app, offered to the roles they suit.
 * - Graphify: a skill plus the `graphify` command (installed with uv), and a rule to query the graph when one exists.
 * - OmniRoute: a local AI gateway (installed from npm, run in the background) that agents use as a provider through OpenCode.
 */
export class ExtensionService {
  private skillsRoot: string;
  private toolsDir: string;
  private work = new Map<ExtensionId, { message?: string; error?: string; since?: number }>();
  private graphifyVersion?: string;
  private omni?: { child?: ChildProcess; url: string; ready: boolean; connections: OmniConnection[]; models: OmniModel[]; at: number; candidates: Set<string> };
  private omniStarting?: Promise<void>;
  /** Result of the agent check per OmniRoute connection. */
  private omniTests = new Map<string, OmniTest>();

  constructor(
    private o: {
      dataDir: string;
      /** Where the app keeps the bundled skills (outside any asar archive). */
      bundledDir: string;
      capabilities: CapabilityStore;
      registry: ProviderRegistry;
      secrets: SecretStore;
      onChange: (s: ExtensionStatus[]) => void;
    },
  ) {
    // Inside the skills folder, so every CLI that may read skills can read these too; the dot keeps them out of the user's list.
    this.skillsRoot = path.join(o.capabilities.skillsDir, '.bundled');
    this.toolsDir = path.join(o.dataDir, 'tools');
    o.capabilities.extraSkills = (role) => this.skillsFor(role);
    o.capabilities.extraRules = (role, cwd) => this.rulesFor(role, cwd);
    o.registry.extensionModels = (id) => (id === OMNI_PROVIDER ? this.omniModels() : Promise.resolve(undefined));
    o.registry.extensionAuth = (id) => (id === OMNI_PROVIDER ? this.omniAuth() : Promise.resolve(undefined));
  }

  /** At startup: copy the skills of enabled extensions, check tools, start OmniRoute when it is on. */
  async init(): Promise<void> {
    for (const id of ['ponytail', 'agent-skills', 'graphify'] as const) if (this.cfg()[id]?.enabled) this.syncSkills(id);
    if (this.cfg().graphify?.enabled) void this.checkGraphify().then(() => this.changed());
    if (this.cfg().omniroute?.enabled) void this.startOmni().catch(() => undefined);
  }

  private cfg(): ExtensionsConfig {
    return this.o.capabilities.get().extensions ?? {};
  }

  private save(next: ExtensionsConfig) {
    this.o.capabilities.setExtensions(next);
    this.changed();
  }

  private changed() {
    this.o.onChange(this.list());
  }

  // ---------- status ----------

  list(): ExtensionStatus[] {
    const c = this.cfg();
    const st = (id: ExtensionId, ready: boolean, extra: Partial<ExtensionStatus> = {}): ExtensionStatus => {
      const w = this.work.get(id);
      const enabled = !!c[id]?.enabled;
      const notReady = id === 'graphify' ? L('graphify 尚未安裝', 'graphify is not installed') : L('OmniRoute 沒有在執行', 'OmniRoute is not running');
      return {
        id,
        enabled,
        state: !enabled ? 'off' : w?.error ? 'error' : w?.message ? 'working' : ready ? 'ready' : 'error',
        message: !enabled ? undefined : (w?.error ?? w?.message ?? (ready ? undefined : notReady)),
        progress: w?.message && !w.error ? { since: this.progress.get(id)?.since ?? w.since, line: this.progress.get(id)?.line, percent: this.percent(id) } : undefined,
        ...extra,
      };
    };
    const omni = this.omni;
    return [
      st('ponytail', true, { level: c.ponytail?.level ?? 'full', skills: this.skillList('ponytail') }),
      st('agent-skills', true, { skills: this.skillList('agent-skills') }),
      st('graphify', !!this.graphifyVersion, { version: this.graphifyVersion }),
      st('omniroute', !!omni?.ready, {
        version: this.omniVersion(),
        omniroute: omni?.ready
          ? {
              url: `${omni.url}/v1`,
              dashboardUrl: omni.url,
              connections: omni.connections.length,
              models: this.usableOmniModels().length,
              free: this.usableOmniModels().filter((m) => this.omniFree(m)).length,
              connected: omni.connections.map((c) => ({ id: c.id ?? '', provider: c.provider ?? '', name: c.providerSpecificData?.nodeName ?? c.name, active: c.isActive !== false, test: c.id ? this.omniTests.get(c.id) : undefined })),
            }
          : undefined,
      }),
    ];
  }

  async setEnabled(id: ExtensionId, enabled: boolean): Promise<ExtensionStatus[]> {
    const c = this.cfg();
    this.save({ ...c, [id]: { ...c[id], enabled } });
    if (id === 'omniroute') {
      if (enabled) void this.startOmni().catch(() => undefined);
      else this.stopOmni(true);
    } else if (enabled) {
      this.syncSkills(id);
      if (id === 'graphify') void this.installGraphify();
    }
    this.changed();
    return this.list();
  }

  setOptions(p: { id: ExtensionId; level?: PonytailLevel; skill?: string; on?: boolean }): ExtensionStatus[] {
    const c = this.cfg();
    if (p.id === 'ponytail' && p.level) this.save({ ...c, ponytail: { enabled: !!c.ponytail?.enabled, ...c.ponytail, level: p.level } });
    if (p.id === 'agent-skills' && p.skill) {
      const cur = c['agent-skills'] ?? { enabled: false };
      this.save({ ...c, 'agent-skills': { ...cur, skills: { ...cur.skills, [p.skill]: !!p.on } } });
    }
    return this.list();
  }

  // ---------- bundled skills ----------

  /** Copy an extension's skills next to the user's (again when the app ships a different copy). */
  private syncSkills(id: 'ponytail' | 'agent-skills' | 'graphify') {
    const from = path.join(this.o.bundledDir, id);
    const to = path.join(this.skillsRoot, id);
    if (!fs.existsSync(from)) return;
    const stamp = bundleStamp(from);
    const stampFile = path.join(to, '.aivenue-stamp');
    try {
      if (fs.readFileSync(stampFile, 'utf8') === stamp) return;
    } catch {
      // not copied yet
    }
    fs.rmSync(to, { recursive: true, force: true });
    fs.mkdirSync(to, { recursive: true });
    fs.cpSync(from, to, { recursive: true });
    fs.writeFileSync(stampFile, stamp);
  }

  /** name → description of one extension's skills (from the copy, else the bundle). */
  private readSkills(id: 'ponytail' | 'agent-skills' | 'graphify'): { name: string; description: string; path: string }[] {
    const root = [path.join(this.skillsRoot, id, 'skills'), path.join(this.o.bundledDir, id, 'skills')].find((d) => fs.existsSync(d));
    if (!root) return [];
    const out: { name: string; description: string; path: string }[] = [];
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, e.name, 'SKILL.md');
      if (!e.isDirectory() || !fs.existsSync(file)) continue;
      out.push({ name: e.name, description: brief(parseFrontmatter(fs.readFileSync(file, 'utf8')).description ?? ''), path: path.join(this.skillsRoot, id, 'skills', e.name, 'SKILL.md') });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private skillList(id: 'ponytail' | 'agent-skills'): ExtensionSkill[] {
    const picked = this.cfg()['agent-skills']?.skills ?? {};
    return this.readSkills(id).map((s) => {
      if (id === 'ponytail') return { name: s.name, description: s.description, roles: PONYTAIL[s.name]?.roles ?? WRITERS, enabled: true };
      const d = AGENT_SKILLS[s.name] ?? { roles: WRITERS };
      return { name: s.name, description: s.description, roles: d.roles, enabled: picked[s.name] ?? !d.off, interactive: d.off === 'interactive' };
    });
  }

  private skillsFor(role: AgentRole): ExtraSkill[] {
    const c = this.cfg();
    const r = role as InstructionRole;
    const out: ExtraSkill[] = [];
    if (c.ponytail?.enabled) {
      const level = PONYTAIL_LEVEL[c.ponytail.level ?? 'full'];
      for (const s of this.readSkills('ponytail')) {
        const d = PONYTAIL[s.name];
        if (d?.roles.includes(r)) out.push({ ...s, ...(d.always ? { always: `Ponytail, ${level}`, body: skillBody(s.path) } : {}) });
      }
    }
    if (c['agent-skills']?.enabled) for (const s of this.skillList('agent-skills')) if (s.enabled && s.roles.includes(r)) out.push(this.readSkills('agent-skills').find((x) => x.name === s.name)!);
    if (c.graphify?.enabled && this.graphifyVersion) out.push(...this.readSkills('graphify'));
    return out;
  }

  // ---------- install progress ----------

  /** When the current install step began and the last line its tool printed, per extension. */
  private progress = new Map<ExtensionId, { since: number; line?: string; lines: number; est?: Estimate }>();

  /**
   * An estimated percentage: the step's share of the whole install, filled by elapsed time against its usual
   * length (or by output lines, e.g. npm's fetches, when that is further), never past 95% of the step.
   */
  private percent(id: ExtensionId): number | undefined {
    const p = this.progress.get(id);
    if (!p?.est) return undefined;
    const done = Math.min(0.95, Math.max((Date.now() - p.since) / p.est.ms, p.est.lines ? p.lines / p.est.lines : 0));
    return Math.round(p.est.from + (p.est.to - p.est.from) * done);
  }

  /** Mark a step without a running command (e.g. waiting for OmniRoute to answer). */
  private phase(id: ExtensionId, est: Estimate) {
    this.progress.set(id, { since: Date.now(), lines: 0, est });
    this.tick();
  }

  /** Push the status every 2 s while something installs, so the percentage moves even when the tool is quiet. */
  private ticker?: NodeJS.Timeout;
  private tick() {
    this.ticker ??= setInterval(() => {
      if (!this.progress.size) {
        clearInterval(this.ticker);
        this.ticker = undefined;
      }
      this.changed();
    }, 2000);
  }
  private progressTimer?: NodeJS.Timeout;

  /** Run an install command, passing its output on as progress (the latest line, at most twice a second). */
  private live(id: ExtensionId, command: string, args: string[], timeoutMs: number, est?: Estimate): Promise<CaptureResult> {
    return new Promise((resolve) => {
      const resolved = resolveCommand(command);
      if (!resolved) return resolve({ code: null, stdout: '', stderr: '', error: `command not found: ${command}` });
      const p = { since: Date.now(), line: undefined as string | undefined, lines: 0, est };
      this.progress.set(id, p);
      this.tick();
      const child = spawnResolved(resolved, args, { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const onData = (chunk: Buffer, to: 'out' | 'err') => {
        const text = chunk.toString();
        if (to === 'out') stdout += text;
        else stderr += text;
        // eslint-disable-next-line no-control-regex
        const last = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean).pop();
        if (last) p.line = last.slice(0, 160);
        p.lines += text.split('\n').length - 1;
        this.progressTimer ??= setTimeout(() => ((this.progressTimer = undefined), this.changed()), 500);
      };
      child.stdout?.on('data', (d: Buffer) => onData(d, 'out'));
      child.stderr?.on('data', (d: Buffer) => onData(d, 'err'));
      const timer = setTimeout(() => killTree(child), timeoutMs);
      const done = (r: CaptureResult) => {
        clearTimeout(timer);
        this.progress.delete(id);
        resolve(r);
      };
      child.on('error', (e) => done({ code: null, stdout, stderr, error: e.message }));
      child.on('close', (code) => done({ code, stdout, stderr }));
    });
  }

  // ---------- Graphify ----------

  private async checkGraphify(): Promise<boolean> {
    refreshPathCache();
    // The first run after an install compiles Python files (slow with antivirus scanning).
    const r = await capture('graphify', ['--version'], { timeoutMs: 120000 });
    this.graphifyVersion = r.code === 0 ? (/(\d+\.\d+(?:\.\d+)?)/.exec(r.stdout + r.stderr)?.[1] ?? 'installed') : undefined;
    return !!this.graphifyVersion;
  }

  /** Install uv (when missing) and then the graphify command with it. No admin rights needed. */
  private async installGraphify(): Promise<void> {
    if (this.work.get('graphify')?.message) return;
    const step = (message: string) => (this.work.set('graphify', { message, since: Date.now() }), this.changed());
    try {
      step(L('檢查 graphify…', 'Checking graphify…'));
      if (await this.checkGraphify()) return;
      if ((await capture('uv', ['--version'], { timeoutMs: 20000 })).code !== 0) {
        step(L('安裝 uv（Python 套件管理工具，約 1 分鐘）…', 'Installing uv (Python package manager, about a minute)…'));
        // Astral's official installers; they put uv in ~/.local/bin for this user only.
        const r = isWin
          ? await this.live('graphify', 'powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://astral.sh/uv/install.ps1 | iex'], 5 * 60000, { from: 0, to: 30, ms: 60000 })
          : await this.live('graphify', 'sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'], 5 * 60000, { from: 0, to: 30, ms: 60000 });
        refreshPathCache();
        if ((await capture('uv', ['--version'], { timeoutMs: 20000 })).code !== 0) throw new Error(L(`uv 安裝失敗：${tail(r.stderr || r.stdout || r.error)}`, `Could not install uv: ${tail(r.stderr || r.stdout || r.error)}`));
      }
      step(L('用 uv 安裝 graphify（會一併下載 Python，約 1–3 分鐘）…', 'Installing graphify with uv (downloads Python too, 1–3 minutes)…'));
      // tree-sitter 0.25.2 沒有 Python 3.15 wheel，指定已有預編譯套件的版本。
      // --force: take over graphify.exe left by an earlier or half-finished install.
      const r = await this.live('graphify', 'uv', ['tool', 'install', '--force', '--upgrade', '--python', '3.12', 'graphifyy'], 15 * 60000, { from: 30, to: 99, ms: 90000 });
      if (!(await this.checkGraphify())) {
        const detail = (r.stderr || r.stdout || r.error || L('沒有輸出', 'no output')).trim().slice(0, 3000);
        throw new Error(L(`graphify 安裝失敗：${detail}`, `Could not install graphify: ${detail}`));
      }
      this.work.delete('graphify');
    } catch (e) {
      this.work.set('graphify', { error: (e as Error).message });
    } finally {
      if (!this.work.get('graphify')?.error) this.work.delete('graphify');
      this.changed();
    }
  }

  /** Retry a failed install (or start one for an extension that needs a tool). */
  async retry(id: ExtensionId): Promise<ExtensionStatus[]> {
    this.work.delete(id);
    if (id === 'graphify') void this.installGraphify();
    if (id === 'omniroute') void this.startOmni().catch(() => undefined);
    this.changed();
    return this.list();
  }

  /** Graphify's rule: query the graph when the folder has one; otherwise say how to build one. */
  private rulesFor(role: AgentRole, cwd?: string): string {
    if (!this.cfg().graphify?.enabled || !this.graphifyVersion) return '';
    const graph = cwd ? path.join(cwd, 'graphify-out', 'graph.json') : '';
    if (graph && fs.existsSync(graph)) {
      const rule = readText(path.join(this.skillsRoot, 'graphify', 'always-on.md')) || readText(path.join(this.o.bundledDir, 'graphify', 'always-on.md'));
      // The /graphify line is for chat apps; Aivenue agents read the skill file instead.
      return `\nGRAPHIFY (knowledge graph of this folder):\n${rule.replace(/^## graphify\s*/m, '').replace(/^When the user types `\/graphify`.*$/m, '').trim()}\n${GRAPH_FALLBACK}`;
    }
    if (role === 'plan_reviewer' || role === 'code_reviewer') return '';
    return '\nGRAPHIFY: the `graphify` command is installed. Before exploring a large or unfamiliar codebase you may build a code graph with `graphify update .` (local parsing, no API cost; it writes graphify-out/ — add that folder to .gitignore unless the project already tracks it), then use `graphify query "<question>"`, `graphify path "<A>" "<B>"` and `graphify explain "<concept>"` instead of broad greps. Only build it when you are allowed to write files.\n' + GRAPH_FALLBACK;
  }

  // ---------- OmniRoute ----------

  private omniDir = () => path.join(this.toolsDir, 'omniroute');
  private omniBin = () => path.join(this.omniDir(), 'node_modules', 'omniroute', 'bin', 'omniroute.mjs');

  private omniVersion(): string | undefined {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.omniDir(), 'node_modules', 'omniroute', 'package.json'), 'utf8')).version;
    } catch {
      return undefined;
    }
  }

  /** The key agents use, and the dashboard password: made once, kept in the secret store. */
  private async omniSecret(kind: 'apiKey' | 'password'): Promise<string> {
    const key = `omniroute:${kind}`;
    let v = await this.o.secrets.get(key);
    if (!v) {
      v = kind === 'apiKey' ? `aiv-${randomBytes(24).toString('hex')}` : randomBytes(15).toString('base64url');
      await this.o.secrets.set(key, v);
    }
    return v;
  }

  /** For the "copy password" button: the user signs in to the dashboard themselves. */
  async omniPassword(): Promise<string> {
    return this.omniSecret('password');
  }

  startOmni(): Promise<void> {
    this.omniStarting ??= this.doStartOmni().finally(() => (this.omniStarting = undefined));
    return this.omniStarting;
  }

  private async doStartOmni(): Promise<void> {
    const step = (message: string) => (this.work.set('omniroute', { message, since: Date.now() }), this.changed());
    try {
      const node = findNode();
      if (!node) throw new Error(L('需要 Node.js 22.22 以上或 24：請先安裝 Node.js', 'OmniRoute needs Node.js 22.22+ or 24: install Node.js first'));
      const v = (await capture(node, ['--version'])).stdout.trim().replace(/^v/, '');
      const [maj, min] = v.split('.').map(Number);
      if (!(maj === 22 ? min >= 22 : maj >= 24 && maj < 27)) throw new Error(L(`OmniRoute 需要 Node.js 22.22 以上或 24–26，目前是 ${v}`, `OmniRoute needs Node.js 22.22+ or 24–26; this computer has ${v}`));
      if (!fs.existsSync(this.omniBin())) {
        step(L('下載並安裝 OmniRoute（約 500 MB，需要幾分鐘）…', 'Downloading and installing OmniRoute (about 500 MB, a few minutes)…'));
        fs.mkdirSync(this.omniDir(), { recursive: true });
        // npm's own script next to node: the npm.cmd shim goes through cmd.exe, which breaks on "C:\Program Files".
        const npmCli = path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
        const args = ['install', '--prefix', this.omniDir(), 'omniroute', '--no-audit', '--no-fund', '--loglevel', 'http'];
        const r = fs.existsSync(npmCli) ? await this.live('omniroute', node, [npmCli, ...args], 20 * 60000, NPM_EST) : await this.live('omniroute', 'npm', args, 20 * 60000, NPM_EST);
        if (!fs.existsSync(this.omniBin())) throw new Error(L(`OmniRoute 安裝失敗：${tail(r.stderr || r.stdout || r.error)}`, `Could not install OmniRoute: ${tail(r.stderr || r.stdout || r.error)}`));
      }
      const apiKey = await this.omniSecret('apiKey');
      const port = this.cfg().omniroute?.port ?? OMNI_PORT;
      const url = `http://127.0.0.1:${port}`;
      // Already running (another Aivenue window started it, or it survived a restart): use it.
      if (!(await omniUp(url, apiKey))) {
        const usePort = (await portFree(port)) ? port : await freePort();
        if (usePort !== this.cfg().omniroute?.port) this.save({ ...this.cfg(), omniroute: { enabled: true, ...this.cfg().omniroute, port: usePort } });
        step(L('啟動 OmniRoute…', 'Starting OmniRoute…'));
        this.phase('omniroute', { from: 90, to: 99, ms: 30000 });
        const dataDir = path.join(this.toolsDir, 'omniroute-data');
        fs.mkdirSync(dataDir, { recursive: true });
        const { spawn } = await import('node:child_process');
        const child = spawn(node, [this.omniBin(), 'serve', '--no-open', '--no-tray', '--port', String(usePort)], {
          cwd: this.omniDir(),
          windowsHide: true,
          detached: !isWin,
          stdio: ['ignore', 'ignore', 'pipe'],
          env: childEnv({
            DATA_DIR: dataDir,
            PORT: String(usePort),
            // Only this computer: OmniRoute's default would listen on every network interface.
            OMNIROUTE_SERVER_HOST: '127.0.0.1',
            OMNIROUTE_API_KEY: apiKey,
            INITIAL_PASSWORD: await this.omniSecret('password'),
            OMNIROUTE_NO_UPDATE_NOTIFIER: '1',
          }),
        });
        let err = '';
        child.stderr?.on('data', (d) => (err = (err + d).slice(-2000)));
        child.on('exit', () => {
          if (this.omni?.child === child) this.omni = undefined;
          this.changed();
        });
        this.omni = { child, url: `http://127.0.0.1:${usePort}`, ready: false, connections: [], models: [], at: 0, candidates: new Set() };
        for (let i = 0; i < 90 && !(await omniUp(this.omni.url, apiKey)); i++) {
          if (child.exitCode !== null) throw new Error(L(`OmniRoute 無法啟動：${tail(err)}`, `OmniRoute did not start: ${tail(err)}`));
          await sleep(1000);
        }
        if (!(await omniUp(this.omni.url, apiKey))) throw new Error(L('OmniRoute 在 90 秒內沒有回應', 'OmniRoute did not answer within 90 seconds'));
      } else this.omni = { url, ready: false, connections: [], models: [], at: 0, candidates: new Set() };
      this.omni.ready = true;
      await this.refreshOmni(true);
      this.work.delete('omniroute');
    } catch (e) {
      this.work.set('omniroute', { error: (e as Error).message });
      throw e;
    } finally {
      this.progress.delete('omniroute');
      this.changed();
    }
  }

  /** Stop OmniRoute if this app started it; `remove` also takes it out of the provider list. */
  stopOmni(remove = false) {
    if (this.omni?.child) killTree(this.omni.child);
    this.omni = undefined;
    this.work.delete('omniroute');
    if (remove && this.o.registry.get(OMNI_PROVIDER)) this.o.registry.remove(OMNI_PROVIDER);
  }

  private async omniFetch<T>(p: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    if (!this.omni) throw new Error('OmniRoute is not running');
    const res = await fetch(this.omni.url + p, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${await this.omniSecret('apiKey')}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs ?? 15000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(omniError(text) || `OmniRoute ${p}: HTTP ${res.status}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  // ---------- free providers (the user signs up and pastes a key) ----------

  /** Connect an upstream provider with the user's own key, then check it can run an agent. */
  async omniConnect(p: { provider: string; apiKey: string }): Promise<ExtensionStatus[]> {
    const key = p.apiKey.trim();
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(p.provider) || !key) throw new Error(L('請貼上 API 金鑰', 'Paste an API key'));
    if (!this.omni?.ready) await this.startOmni();
    const r = await this.omniFetch<{ connection?: { id: string } }>('/api/providers', { method: 'POST', body: { provider: p.provider, apiKey: key, name: `${p.provider} (Aivenue)` } });
    await this.refreshOmni(true);
    const id = r?.connection?.id ?? this.omni?.connections.find((c) => c.provider === p.provider)?.id;
    if (id) await this.omniTest(id);
    return this.list();
  }

  async omniDisconnect(id: string): Promise<ExtensionStatus[]> {
    await this.omniFetch(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    this.omniTests.delete(id);
    await this.refreshOmni(true);
    return this.list();
  }

  /**
   * Can this connection run an agent? One request the size of an agent's opening prompt (about 24,000 characters)
   * that must come back as a tool call: catches bad keys, short context, low per-minute token caps and no tool support.
   */
  async omniTest(id: string): Promise<ExtensionStatus[]> {
    const conn = this.omni?.connections.find((c) => c.id === id);
    if (!conn) throw new Error(L('找不到這個連線', 'Connection not found'));
    const names = new Set([conn.provider, conn.providerSpecificData?.prefix].filter(Boolean));
    const models = (this.omni?.models ?? []).filter((m) => names.has(m.owned_by ?? '') && m.capabilities?.tool_calling !== false && !m.id.startsWith('auto/'));
    // A free model first: that is what the user connected it for.
    const model = models.find((m) => this.omniFree(m)) ?? models[0];
    this.omniTests.set(id, { state: 'testing', at: Date.now() });
    this.changed();
    // OmniRoute's own check first: it tells a wrong key apart from everything else.
    const own = await this.omniFetch<{ valid?: boolean; error?: string }>(`/api/providers/${encodeURIComponent(id)}/test`, { method: 'POST', body: {}, timeoutMs: 60000 }).catch((e) => ({ valid: false, error: (e as Error).message }));
    if (own?.valid === false) {
      const why = /invalid api key|unauthor|401/i.test(own.error ?? '') ? L('金鑰無效：請確認貼上的是完整的 API 金鑰', 'The key was rejected: check you pasted the whole API key') : (own.error ?? L('連線失敗', 'Connection failed'));
      this.omniTests.set(id, { state: 'fail', at: Date.now(), message: why });
      this.changed();
      return this.list();
    }
    if (!model) {
      this.omniTests.set(id, { state: 'fail', at: Date.now(), message: L('OmniRoute 沒有列出這家可以呼叫工具的模型', 'OmniRoute lists no tool-calling model for this provider') });
      this.changed();
      return this.list();
    }
    const filler = 'This line stands in for the instructions and tool descriptions a coding agent receives. '.repeat(270);
    try {
      const r = await this.omniFetch<{ choices?: { message?: { tool_calls?: unknown[]; content?: string } }[] }>('/v1/chat/completions', {
        method: 'POST',
        timeoutMs: 120000,
        body: {
          model: model.id,
          max_tokens: 200,
          messages: [
            { role: 'system', content: filler },
            { role: 'user', content: 'Call the ping tool with ok=true. Do not answer in text.' },
          ],
          tools: [{ type: 'function', function: { name: 'ping', description: 'Reply to a connectivity check.', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } } }],
          tool_choice: 'required',
        },
      });
      const called = !!r?.choices?.[0]?.message?.tool_calls?.length;
      this.omniTests.set(id, called ? { state: 'ok', at: Date.now(), model: model.id } : { state: 'fail', at: Date.now(), model: model.id, message: L('模型有回答，但沒有呼叫工具：可能不適合當 agent', 'The model answered but did not call the tool; it may not suit an agent') });
    } catch (e) {
      this.omniTests.set(id, { state: 'fail', at: Date.now(), model: model.id, message: (e as Error).message.slice(0, 400) });
    }
    this.changed();
    return this.list();
  }

  /** Read OmniRoute's connected providers and models again, and update the provider agents use. */
  async refreshOmni(force = false): Promise<ExtensionStatus[]> {
    if (!this.omni?.ready) {
      if (this.cfg().omniroute?.enabled) await this.startOmni().catch(() => undefined);
      return this.list();
    }
    if (!force && Date.now() - this.omni.at < 30000) return this.list();
    const [models, providers] = await Promise.all([
      this.omniFetch<{ data: OmniModel[] }>('/v1/models?prefix=alias').catch(() => ({ data: [] as OmniModel[] })),
      this.omniFetch<{ connections: OmniConnection[] }>('/api/providers').catch(() => ({ connections: [] as OmniConnection[] })),
    ]);
    this.omni.models = models.data ?? [];
    this.omni.connections = providers.connections ?? [];
    // What the free pools can route to right now: those models go in the menus too.
    const pools = await Promise.all(FREE_POOLS.map((p) => this.fetchCandidates(p)));
    this.omni.candidates = new Set(pools.flat().filter((c) => c.state === 'ok' || c.state === 'cooldown').map((c) => c.id.slice(OMNI_PROVIDER.length + 1)));
    this.omni.at = Date.now();
    this.o.registry.forgetModels(OMNI_PROVIDER);
    this.syncOmniProvider();
    void this.o.registry.checkAuth(OMNI_PROVIDER).catch(() => undefined);
    this.changed();
    return this.list();
  }

  /** Models an agent can use: routing aliases (auto/…) and tool-calling models of the providers connected in OmniRoute. */
  private usableOmniModels(): OmniModel[] {
    const omni = this.omni;
    if (!omni) return [];
    // Models name their provider by id ("groq") or, for custom endpoints, by the prefix the user gave it.
    const connected = new Set(omni.connections.filter((c) => c.isActive !== false).flatMap((c) => [c.provider, c.providerId, c.providerSpecificData?.prefix].filter((x): x is string => typeof x === 'string')));
    const pinned = new Set(this.cfg().omniroute?.pinned ?? []);
    const ok = omni.models.filter((m) => m.capabilities?.tool_calling !== false && (m.owned_by === 'combo' || connected.has(m.owned_by ?? '') || omni.candidates.has(m.id) || pinned.has(m.id)));
    // Routing aliases first (auto/best-free on top), then models picked from a pool, then the rest by name.
    const rank = (m: OmniModel) => (m.id === 'auto/best-free' ? 0 : m.id.startsWith('auto/') ? (/free/.test(m.id) ? 1 : 2) : pinned.has(m.id) ? 3 : 4);
    // The list rides in an environment variable (OpenCode's config): keep it well under Windows' 32K limit.
    return ok.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id)).slice(0, MAX_OMNI_MODELS);
  }

  /** The models an auto pool (auto/best-free…) may route to right now, in OmniRoute's order. */
  async omniCandidates(model: string): Promise<OmniCandidate[]> {
    await this.refreshOmni();
    return this.fetchCandidates(model.replace(new RegExp(`^${OMNI_PROVIDER}/`), '').replace(/#.*$/, ''));
  }

  private async fetchCandidates(pool: string): Promise<OmniCandidate[]> {
    const channel = pool.replace(/^auto\//, '');
    if (!this.omni?.ready || !pool.startsWith('auto/') || /[/?#]/.test(channel)) return [];
    const r = await this.omniFetch<{ candidates?: OmniPoolEntry[] }>(`/v1/auto-combo/${channel}/candidates`).catch(() => ({ candidates: [] as OmniPoolEntry[] }));
    const seen = new Set<string>();
    const out: OmniCandidate[] = [];
    for (const c of r.candidates ?? []) {
      const id = c.modelStr ?? c.model;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const cooling = c.connectionCooldown || c.modelLocked || (c.breakerState && c.breakerState !== 'CLOSED');
      // No-sign-in pools (Cloudflare Playground…) cap a request at about 6,000 characters: far too little for a coding agent.
      const state = c.excluded || c.reachable === false ? 'excluded' : c.connectionId === 'noauth' ? 'limited' : cooling ? 'cooldown' : 'ok';
      out.push({ id: `${OMNI_PROVIDER}/${id}`, provider: c.provider ?? '', state });
    }
    return out;
  }

  /** Keep one model from a pool in the menus (the user picked it to use on its own). */
  async omniPin(model: string): Promise<void> {
    const id = model.replace(new RegExp(`^${OMNI_PROVIDER}/`), '');
    const c = this.cfg();
    const pinned = [...new Set([...(c.omniroute?.pinned ?? []), id])];
    this.save({ ...c, omniroute: { enabled: !!c.omniroute?.enabled, ...c.omniroute, pinned } });
    await this.refreshOmni(true);
  }

  private omniFree(m: OmniModel): boolean {
    return /free/i.test(m.id) || m.pricing?.prompt === '0' || m.pricing?.input === 0;
  }

  private async omniModels(): Promise<ModelInfo[]> {
    await this.refreshOmni();
    return this.usableOmniModels().map((m) => ({
      id: `${OMNI_PROVIDER}/${m.id}`,
      label: m.id.startsWith('auto/') ? undefined : m.name,
      description: m.owned_by === 'combo' ? L('OmniRoute 自動挑選的模型組合', 'A model pool OmniRoute picks from') : m.owned_by,
      context: m.context_length || undefined,
      contextSource: m.context_length ? 'cli' : undefined,
      efforts: m.capabilities?.reasoning || m.capabilities?.thinking ? OMNI_EFFORTS : [],
      free: this.omniFree(m),
      inputs: Array.isArray(m.input_modalities) ? m.input_modalities : m.capabilities?.vision ? ['text', 'image'] : undefined,
    }));
  }

  private async omniAuth(): Promise<ProviderInfo['auth']> {
    if (!this.cfg().omniroute?.enabled) return { state: 'logged_out', detail: L('在「能力 → 內建擴充」開啟 OmniRoute', 'Turn OmniRoute on under Capabilities → Built-in extensions') };
    if (!this.omni?.ready) return { state: 'logged_out', detail: this.work.get('omniroute')?.error ?? L('OmniRoute 尚未啟動', 'OmniRoute is not running') };
    if (!this.omni.connections.length) return { state: 'logged_out', detail: L('還沒有連接任何供應商：OmniRoute 內建的免登入免費模型每次最多約 6,000 字元，跑不動 coding agent。請到 OmniRoute 管理頁用自己的帳號連接免費供應商（例如 Gemini、Groq、OpenRouter）。', 'No provider connected yet: OmniRoute’s built-in no-sign-in free models take about 6,000 characters per request, too little for a coding agent. Connect free providers with your own accounts (e.g. Gemini, Groq, OpenRouter) in the OmniRoute dashboard.') };
    return { state: 'logged_in', detail: L(`已連接 ${this.omni.connections.length} 個供應商`, `${this.omni.connections.length} providers connected`) };
  }

  /** The OmniRoute provider: OpenCode pointed at the local gateway, with every usable model and its effort variants. */
  private syncOmniProvider() {
    if (!this.omni) return;
    const base = BUILTIN_PROVIDERS.find((b) => b.id === 'opencode')!;
    const usable = this.usableOmniModels();
    const variants = Object.fromEntries(OMNI_EFFORTS.map((e) => [e, { reasoningEffort: e }]));
    const models = Object.fromEntries(usable.map((m) => [m.id, { ...(m.context_length ? { limit: { context: m.context_length, output: 32000 } } : {}), variants }]));
    const spec: ProviderSpec = {
      ...base,
      id: OMNI_PROVIDER,
      name: 'OmniRoute',
      description: L('OmniRoute 本機 AI 閘道（透過 OpenCode 執行）：自動挑選可用的免費模型，額度用完會換下一家', 'OmniRoute local AI gateway (run through OpenCode): picks a free model that works and moves on when one runs out'),
      contextCatalog: undefined,
      docsUrl: 'https://github.com/diegosouzapw/OmniRoute',
      install: undefined,
      login: undefined,
      logout: undefined,
      status: {},
      run: { ...base.run, common: (base.run.common ?? []).map((g) => (g[0] === '--model' ? ['--model', '{modelEffort}'] : g)) },
      apiKey: {
        env: 'AIVENUE_API_KEY',
        settingsExtra: { provider: { [OMNI_PROVIDER]: { npm: '@ai-sdk/openai-compatible', name: 'OmniRoute', options: { baseURL: `${this.omni.url}/v1`, apiKey: '{env:AIVENUE_API_KEY}' }, models } } },
        note: `${this.omni.url}/v1`,
      },
      modelSource: { type: 'extension' },
      models: usable.map((m) => `${OMNI_PROVIDER}/${m.id}`),
      defaultModel: `${OMNI_PROVIDER}/auto/best-free`,
      efforts: OMNI_EFFORTS,
      catalog: undefined,
      quota: undefined,
      profile: { plan: 2, review: 2, code: 3, speed: 3, vision: false, pdf: false, helperOnly: true },
    };
    const prev = this.o.registry.get(OMNI_PROVIDER);
    if (JSON.stringify(prev) !== JSON.stringify(spec)) this.o.registry.upsert(spec);
    void this.omniSecret('apiKey').then(async (k) => {
      if (this.o.registry.authMode(OMNI_PROVIDER) !== 'api') await this.o.registry.setAuthMode(OMNI_PROVIDER, 'api');
      if (!this.o.registry.list().find((p) => p.spec.id === OMNI_PROVIDER)?.hasApiKey) await this.o.registry.setApiKey(OMNI_PROVIDER, k);
    });
  }

  /**
   * Which models actually answered an OmniRoute agent between two times (OmniRoute's call log). With other
   * OmniRoute agents running at the same time, calls cannot be told apart, so theirs may show up too.
   */
  async servedBy(model: string | undefined, from: number, to: number): Promise<string[] | undefined> {
    if (!this.omni?.ready) return undefined;
    const want = (model ?? `${OMNI_PROVIDER}/auto/best-free`).replace(/#.*$/, '').replace(new RegExp(`^${OMNI_PROVIDER}/`), '');
    const logs = await this.omniFetch<OmniCall[]>('/api/usage/call-logs?limit=300').catch(() => [] as OmniCall[]);
    const out = new Set<string>();
    for (const c of Array.isArray(logs) ? logs : []) {
      const t = Date.parse(c.timestamp ?? '');
      if (!(t >= from - 2000 && t <= to + 2000) || !c.status || c.status >= 400) continue;
      const asked = c.comboName ?? c.requestedModel ?? c.model;
      if (asked !== want && c.model !== want && !want.endsWith(`/${c.model}`)) continue;
      // A custom endpoint's provider id is a generated one: show the prefix the user gave it instead.
      const conn = this.omni.connections.find((x) => x.provider === c.provider);
      const via = conn?.providerSpecificData?.prefix || c.provider;
      if (c.model) out.add(via && via !== 'auto' ? `${via}/${c.model}` : c.model);
    }
    return out.size ? [...out] : undefined;
  }

  shutdown() {
    this.stopOmni();
  }
}

interface OmniConnection {
  id?: string;
  name?: string;
  provider?: string;
  providerId?: string;
  isActive?: boolean;
  providerSpecificData?: { prefix?: string; nodeName?: string };
}

interface OmniPoolEntry {
  provider?: string;
  model?: string;
  modelStr?: string;
  excluded?: boolean;
  reachable?: boolean;
  breakerState?: string;
  connectionCooldown?: boolean;
  modelLocked?: boolean;
  connectionId?: string;
}

interface OmniCall {
  timestamp?: string;
  status?: number;
  model?: string;
  requestedModel?: string | null;
  comboName?: string | null;
  provider?: string;
}

async function omniUp(url: string, key: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/v1/models?limit=1`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

/** Names and sizes of every file: changes when the app ships different skills. */
function bundleStamp(dir: string): string {
  const parts: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else parts.push(`${path.relative(dir, p)}:${fs.statSync(p).size}`);
    }
  };
  walk(dir);
  return parts.join('\n');
}

/** OmniRoute's error body ({error: {message}} or {error: "..."}) as one line. */
function omniError(body: string): string {
  try {
    const j = JSON.parse(body);
    const e = j?.error;
    return String((typeof e === 'string' ? e : (e?.message ?? j?.message)) ?? '').slice(0, 400);
  } catch {
    return body.slice(0, 200);
  }
}

/** A SKILL.md without its frontmatter. */
function skillBody(file: string): string | undefined {
  return readText(file).replace(/^---[\s\S]*?\n---\s*/, '').trim() || undefined;
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** A skill's description cut to its first sentences (about 200 characters): every agent of a role reads the whole index. */
function brief(d: string): string {
  if (d.length <= 220) return d;
  const sentences = d.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [d];
  let out = '';
  for (const s of sentences) {
    if (out && (out + s).length > 220) break;
    out += s;
  }
  return out.trim().slice(0, 260);
}

const tail = (s?: string) => (s ?? '').trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 400) || L('沒有輸出', 'no output');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
