import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentRole, CapabilitiesConfig, ConfigValue, InstructionRole, McpServerConfig, ProjectSkillInfo, SkillApproval, SkillInfo, SkillReview, SkillScan } from './types';
import type { SecretStore } from './secrets';
import { L } from './i18n';
import { SCAN_RULES_VERSION, scanSkill, skillHash } from './skillScan';

/** A server needs the GitHub sign-in, which is missing. */
class NeedsGithub extends Error {}

/** A shared MCP server with secrets resolved, ready to hand to one agent run. */
export interface ResolvedMcpServer {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env: Record<string, string>;
  /** Env var names whose values are secret (Codex passes them via env_vars instead of the command line). */
  secretEnv: string[];
  url?: string;
  headers: Record<string, string>;
  secretHeaders: string[];
  /** Extra fields for the config entry (e.g. {"trust": true}). */
  extra?: Record<string, unknown>;
}

const EMPTY: CapabilitiesConfig = { mcpServers: [], instructions: {}, skills: {} };
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const secretKey = (server: string, kind: 'env' | 'header', key: string) => `mcp:${server}:${kind}:${key}`;

export function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    // YAML block scalars ("description: >" / "|"): the indented lines that follow.
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i].trim());
      value = block.filter(Boolean).join(value.startsWith('|') ? '\n' : ' ');
    }
    out[kv[1]] = value.replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

/** A skill an extension adds to the index for one role (its files stay in the extension's folder). */
export interface ExtraSkill {
  name: string;
  description: string;
  path: string;
  /** Read and follow it from the start (e.g. Ponytail), not only when it looks relevant. */
  always?: string;
  /** For an always-on skill: its instructions, put in the prompt so no agent skips reading them. */
  body?: string;
  /** What SKILL.md covers (its section headings), so an agent can judge it without opening it. */
  outline?: string;
}

/** The section headings of a SKILL.md, short enough for the skills index. */
export function skillOutline(file: string): string {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  const heads = [...text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').matchAll(/^#{2,3}\s+(.+?)\s*#*\r?$/gm)].map((m) => m[1].replace(/[*_`]/g, '').trim()).filter(Boolean);
  const out = heads.slice(0, 8).join('; ');
  return out.length > 220 ? out.slice(0, 217) + '…' : out + (heads.length > 8 ? '; …' : '');
}

function countFiles(dir: string): number {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  return n;
}

/**
 * Capabilities every agent gets regardless of vendor: shared MCP servers, a skills library
 * (Agent Skills format: <name>/SKILL.md with name/description frontmatter) and per-role instructions.
 */
export class CapabilityStore {
  private file: string;
  readonly skillsDir: string;
  private cfg: CapabilitiesConfig;

  /** The GitHub CLI's signed-in token, for servers configured with { ghToken: true }. */
  ghToken?: () => Promise<string | undefined>;
  /** Set by the extensions: their skills for a role, and rules that depend on the working folder. */
  extraSkills?: (role: AgentRole) => ExtraSkill[];
  extraRules?: (role: AgentRole, cwd?: string) => string;

  /** Where a re-imported skill is copied and scanned before it replaces the library's copy. */
  private stagingDir: string;
  /** Skills waiting for approval: kept out of the library, which CLIs are given and may search for skills. */
  readonly reviewDir: string;
  private scanner: (dir: string) => SkillScan;
  /** Scans by content hash: the same content is not scanned twice. */
  private scans = new Map<string, SkillScan>();

  constructor(dataDir: string, private secrets: SecretStore, o: { scan?: (dir: string) => SkillScan } = {}) {
    this.file = path.join(dataDir, 'capabilities.json');
    this.skillsDir = path.join(dataDir, 'skills');
    this.stagingDir = path.join(dataDir, 'skill-staging');
    this.reviewDir = path.join(dataDir, 'skill-review');
    this.scanner = o.scan ?? ((dir) => scanSkill(dir));
    fs.mkdirSync(this.skillsDir, { recursive: true });
    try {
      this.cfg = { ...EMPTY, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch {
      this.cfg = structuredClone(EMPTY);
    }
  }

  get(): CapabilitiesConfig {
    return this.cfg;
  }

  private save() {
    fs.writeFileSync(this.file, JSON.stringify(this.cfg, null, 2));
  }

  // ---------- MCP servers ----------

  async saveServer(server: McpServerConfig, secretValues: Record<string, string> = {}): Promise<void> {
    if (!NAME_RE.test(server.id)) throw new Error(L('名稱只能包含英數字、- 和 _', 'Name may only contain letters, digits, - and _'));
    if (server.id === 'aivenue') throw new Error(L('「aivenue」是保留名稱', '"aivenue" is reserved'));
    if (server.transport === 'stdio' && !server.command?.trim()) throw new Error(L('stdio 伺服器需要指令', 'A stdio server needs a command'));
    if (server.transport === 'http' && !/^https?:\/\//.test(server.url ?? '')) throw new Error(L('HTTP 伺服器需要 http(s) 網址', 'An HTTP server needs an http(s) URL'));
    // Secret values arrive separately ("env:NAME" / "header:NAME") and go to the secret store.
    for (const [k, v] of Object.entries(secretValues)) {
      const [kind, key] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)] as ['env' | 'header', string];
      if (v) await this.secrets.set(secretKey(server.id, kind, key), v);
    }
    const prev = this.cfg.mcpServers.find((s) => s.id === server.id);
    // Drop secrets that are no longer referenced.
    for (const [kind, map] of [['env', prev?.env], ['header', prev?.headers]] as const) {
      const next = kind === 'env' ? server.env : server.headers;
      for (const [k, v] of Object.entries(map ?? {})) if (typeof v === 'object' && !(next && typeof next[k] === 'object')) await this.secrets.delete(secretKey(server.id, kind, k));
    }
    this.cfg.mcpServers = this.cfg.mcpServers.filter((s) => s.id !== server.id).concat(server);
    this.save();
  }

  async deleteServer(id: string): Promise<void> {
    const s = this.cfg.mcpServers.find((x) => x.id === id);
    for (const [k, v] of Object.entries(s?.env ?? {})) if (typeof v === 'object') await this.secrets.delete(secretKey(id, 'env', k));
    for (const [k, v] of Object.entries(s?.headers ?? {})) if (typeof v === 'object') await this.secrets.delete(secretKey(id, 'header', k));
    this.cfg.mcpServers = this.cfg.mcpServers.filter((x) => x.id !== id);
    this.save();
  }

  /** Enabled servers for one provider, with secret values filled in. */
  async serversFor(providerId: string): Promise<ResolvedMcpServer[]> {
    const out: ResolvedMcpServer[] = [];
    for (const s of this.cfg.mcpServers) {
      if (!s.enabled || (s.providers?.length && !s.providers.includes(providerId))) continue;
      // A server that needs the GitHub sign-in is left out while nobody is signed in.
      const r = await this.resolve(s).catch((e) => (e instanceof NeedsGithub ? undefined : Promise.reject(e)));
      if (r) out.push(r);
    }
    return out;
  }

  /** One server by id (enabled or not), for testing its configuration. */
  async resolveServer(id: string): Promise<ResolvedMcpServer> {
    const s = this.cfg.mcpServers.find((x) => x.id === id);
    if (!s) throw new Error(`unknown MCP server: ${id}`);
    return this.resolve(s);
  }

  private async resolve(s: McpServerConfig): Promise<ResolvedMcpServer> {
    const fill = async (map: Record<string, ConfigValue> | undefined, kind: 'env' | 'header') => {
      const values: Record<string, string> = {};
      const secret: string[] = [];
      for (const [k, v] of Object.entries(map ?? {})) {
        if (typeof v === 'string') values[k] = v;
        else if ('ghToken' in v) {
          const token = await this.ghToken?.();
          if (!token) throw new NeedsGithub(L('需要先在「能力 → GitHub」登入 GitHub', 'Sign in to GitHub first (Capabilities → GitHub)'));
          values[k] = (v.prefix ?? '') + token;
          secret.push(k);
        } else {
          const val = await this.secrets.get(secretKey(s.id, kind, k));
          if (val !== undefined) {
            values[k] = val;
            secret.push(k);
          }
        }
      }
      return { values, secret };
    };
    const env = await fill(s.env, 'env');
    const headers = await fill(s.headers, 'header');
    return { name: s.id, transport: s.transport, command: s.command, args: s.args ?? [], env: env.values, secretEnv: env.secret, url: s.url, headers: headers.values, secretHeaders: headers.secret };
  }

  setExtensions(extensions: CapabilitiesConfig['extensions']) {
    this.cfg.extensions = extensions;
    this.save();
  }

  // ---------- role instructions ----------

  setInstructions(instructions: CapabilitiesConfig['instructions']) {
    const clean: CapabilitiesConfig['instructions'] = {};
    for (const [k, v] of Object.entries(instructions)) if (v?.trim()) clean[k as InstructionRole] = v.trim();
    this.cfg.instructions = clean;
    this.save();
  }

  instructionsFor(role: AgentRole): string | undefined {
    if (role === 'test' || role === 'compactor') return undefined;
    const parts = [this.cfg.instructions.all, this.cfg.instructions[role as InstructionRole]].filter((x): x is string => !!x?.trim());
    return parts.length ? parts.join('\n\n') : undefined;
  }

  // ---------- skills ----------

  /**
   * Whether a folder's current content may be loaded: the approval must be for this very content (its hash). Read
   * now, from the files, whenever skills are listed or offered — a file changed after approval undoes it.
   */
  private review(dir: string, approved?: SkillApproval): SkillReview {
    let hash: string;
    try {
      hash = skillHash(dir);
    } catch (e) {
      return { state: 'failed', scan: { status: 'failed', rules: SCAN_RULES_VERSION, at: Date.now(), findings: [], error: (e as Error).message } };
    }
    let scan = this.scans.get(hash);
    if (!scan) {
      try {
        scan = this.scanner(dir);
      } catch (e) {
        scan = { status: 'failed', rules: SCAN_RULES_VERSION, at: Date.now(), hash, findings: [], error: (e as Error).message };
      }
      this.scans.set(hash, scan);
    }
    const base = { hash, scan, ...(approved ? { approvedAt: approved.at, by: approved.by } : {}) };
    if (approved?.hash === hash) return { state: 'approved', ...base };
    return { state: scan.status === 'failed' ? 'failed' : approved ? 'changed' : 'pending', ...base };
  }

  /** Where a skill's folder is now: the library (approved) or the review area (waiting); undefined when neither. */
  folderOf(name: string): string | undefined {
    if (!NAME_RE.test(name)) throw new Error('invalid skill name');
    for (const root of [this.skillsDir, this.reviewDir]) {
      const dir = path.join(root, name);
      if (fs.existsSync(path.join(dir, 'SKILL.md'))) return dir;
    }
    return undefined;
  }

  /** Replace `to` with `from` (a folder), putting `to` back when the move fails. */
  private moveFolder(from: string, to: string) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const old = `${to}.old-${randomUUID().slice(0, 8)}`;
    if (fs.existsSync(to)) fs.renameSync(to, old);
    try {
      fs.renameSync(from, to);
    } catch (e) {
      if (fs.existsSync(old)) fs.renameSync(old, to);
      throw e;
    }
    fs.rmSync(old, { recursive: true, force: true });
  }

  /**
   * The library folder is handed to the CLIs (`--add-dir`), and some of them load skills found at its root on their
   * own (Claude Code: `.claude/skills`; Copilot: `.github/skills`). So it holds approved content only: a skill there
   * whose files are not the approved version (put in by hand, or changed after approval) moves to the review area,
   * which no CLI is given; so does anything at its root starting with a dot, other than the extensions' `.bundled`.
   */
  private settleLibrary() {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const from = path.join(this.skillsDir, e.name);
      try {
        if (e.name.startsWith('.')) {
          if (e.name === '.bundled') continue;
          this.moveFolder(from, path.join(this.reviewDir, '.misplaced', `${e.name}-${Date.now()}`));
          continue;
        }
        if (!e.isDirectory() || !NAME_RE.test(e.name) || !fs.existsSync(path.join(from, 'SKILL.md'))) continue;
        if (this.review(from, this.cfg.skills[e.name]?.approved).state !== 'approved') this.moveFolder(from, path.join(this.reviewDir, e.name));
      } catch {
        // Could not move it (a file in use): it stays where it is, and is still not offered (skillsBlock checks again).
      }
    }
  }

  listSkills(): SkillInfo[] {
    this.settleLibrary();
    const out: SkillInfo[] = [];
    const seen = new Set<string>();
    for (const root of [this.skillsDir, this.reviewDir]) {
      if (!fs.existsSync(root)) continue;
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        // Only skill folders (not ".bundled", the extensions' own copies, nor what was moved aside).
        if (!e.isDirectory() || !NAME_RE.test(e.name) || seen.has(e.name)) continue;
        const dir = path.join(root, e.name);
        const file = path.join(dir, 'SKILL.md');
        if (!fs.existsSync(file)) continue;
        seen.add(e.name);
        const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
        const st = this.cfg.skills[e.name];
        const review = this.review(dir, st?.approved);
        // Only the library's copy may count as approved: the review area is never handed to a CLI.
        const inLibrary = root === this.skillsDir;
        out.push({ name: e.name, description: fm.description ?? '', path: file, enabled: st?.enabled ?? true, roles: st?.roles, files: countFiles(dir), review: inLibrary || review.state !== 'approved' ? review : { ...review, state: 'pending' } });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Approve the content the user looked at (`hash`) and turn the skill on: it moves from the review area into the
   * library. Refused when the files changed since, when they could not be scanned, or when there are findings the
   * user did not confirm.
   */
  approveSkill(name: string, hash: string, acceptFindings = false) {
    const dir = this.folderOf(name);
    if (!dir) throw new Error(L('找不到這個 skill', 'Skill not found'));
    const st = this.cfg.skills[name];
    const approved = this.approval(this.review(dir, st?.approved), hash, acceptFindings);
    const target = path.join(this.skillsDir, name);
    if (path.resolve(dir) !== path.resolve(target)) this.moveFolder(dir, target);
    this.cfg.skills[name] = { ...st, enabled: true, approved };
    this.save();
  }

  private approval(r: SkillReview, hash: string, acceptFindings: boolean): SkillApproval {
    if (r.hash !== hash) throw new Error(L('檔案在你檢查之後又變了：請重新檢查目前的內容再啟用', 'The files changed after you looked at them: check the current content again before turning it on'));
    if (r.state === 'failed' || r.scan?.status === 'failed') throw new Error(L(`無法掃描，維持停用：${r.scan?.error ?? ''}`, `It could not be scanned, so it stays off: ${r.scan?.error ?? ''}`));
    const findings = (r.scan?.findings.length ?? 0) + (r.scan?.more ?? 0);
    if (findings && !acceptFindings) throw new Error(L(`有 ${findings} 處需要注意：請先看過並確認`, `${findings} finding(s) need a look: review and confirm them first`));
    return { hash, at: Date.now(), by: 'user', ...(findings ? { findings } : {}) };
  }

  // ---------- project skills (<cwd>/.aivenue/skills) ----------

  private projectKey(dir: string) {
    const r = path.resolve(dir);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  }

  /** Project skills Aivenue has seen (pending ones included), with the state of their current content. */
  listProjectSkills(): ProjectSkillInfo[] {
    const out: ProjectSkillInfo[] = [];
    for (const p of Object.values(this.cfg.projectSkills ?? {})) {
      const file = path.join(p.dir, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      out.push({ dir: p.dir, name: p.name, description: fm.description ?? '', path: file, cwd: p.cwd, review: this.review(p.dir, p.approved) });
    }
    return out.sort((a, b) => a.dir.localeCompare(b.dir));
  }

  approveProjectSkill(dir: string, hash: string, acceptFindings = false) {
    const p = this.cfg.projectSkills?.[this.projectKey(dir)];
    if (!p || !fs.existsSync(path.join(p.dir, 'SKILL.md'))) throw new Error(L('找不到這個專案 skill', 'Project skill not found'));
    p.approved = this.approval(this.review(p.dir, p.approved), hash, acceptFindings);
    this.save();
  }

  /** Stop loading a project skill (its approval is dropped; the files stay). */
  disableProjectSkill(dir: string) {
    const p = this.cfg.projectSkills?.[this.projectKey(dir)];
    if (!p) return;
    delete p.approved;
    this.save();
  }

  /** The current hash of a project skill folder and whether that content is approved (undefined: no such folder). */
  projectSkillState(dir: string): { hash?: string; approved: boolean } | undefined {
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) return undefined;
    const p = this.cfg.projectSkills?.[this.projectKey(dir)];
    const r = this.review(dir, p?.approved);
    return { hash: r.hash, approved: r.state === 'approved' };
  }

  /**
   * Aivenue wrote this project skill itself (rules distilled from a workflow): trust what it wrote — unless the
   * folder held content that was not approved before (`before`), which stays to be checked.
   */
  trustProjectSkill(dir: string, before: { approved: boolean } | undefined) {
    if (before && !before.approved) return;
    const key = this.projectKey(dir);
    const all = (this.cfg.projectSkills ??= {});
    const p = (all[key] ??= { dir: path.resolve(dir), name: path.basename(dir), cwd: path.resolve(dir, '..', '..', '..'), seenAt: Date.now() });
    p.approved = { hash: skillHash(dir), at: Date.now(), by: 'aivenue' };
    this.save();
  }

  /** The project skills that may be loaded; the others are recorded as seen, for the user to check. */
  private loadableProjectSkills(cwd: string): ExtraSkill[] {
    const dir = path.join(cwd, '.aivenue', 'skills');
    if (!fs.existsSync(dir)) return [];
    const out: ExtraSkill[] = [];
    let changed = false;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const sdir = path.join(dir, e.name);
      const file = path.join(sdir, 'SKILL.md');
      if (!e.isDirectory() || !fs.existsSync(file)) continue;
      const key = this.projectKey(sdir);
      const all = (this.cfg.projectSkills ??= {});
      if (!all[key]) {
        all[key] = { dir: path.resolve(sdir), name: e.name, cwd: path.resolve(cwd), seenAt: Date.now() };
        changed = true;
      }
      if (this.review(sdir, all[key].approved).state !== 'approved') continue;
      const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      out.push({ name: e.name, description: `[PROJECT] ${fm.description ?? ''}`, path: file, outline: skillOutline(file) });
    }
    if (changed) this.save();
    return out;
  }

  readSkill(name: string): string {
    const dir = this.folderOf(name);
    if (!dir) throw new Error(L('找不到這個 skill', 'Skill not found'));
    return fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  }

  /** Create or update a skill from its SKILL.md content. */
  saveSkill(name: string, content: string) {
    if (!NAME_RE.test(name)) throw new Error(L('名稱只能包含英數字、- 和 _', 'Name may only contain letters, digits, - and _'));
    const fm = parseFrontmatter(content);
    if (!fm.description) throw new Error(L('SKILL.md 開頭需要 frontmatter，至少包含 description', 'SKILL.md must start with frontmatter containing at least a description'));
    const where = this.folderOf(name);
    const dir = where ?? path.join(this.skillsDir, name);
    const cur = this.cfg.skills[name];
    // The editor's own skill stays trusted (as before): a new one, or one it wrote whose files nobody changed since
    // (in the library). Editing the SKILL.md of an imported skill — or of one waiting in the review area — does not
    // approve its other files.
    const ours = !where || (cur?.origin === 'editor' && path.resolve(where) === path.resolve(path.join(this.skillsDir, name)) && this.review(dir, cur.approved).state === 'approved');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
    if (ours) {
      this.cfg.skills[name] = { ...cur, enabled: cur?.enabled ?? true, origin: 'editor', approved: { hash: skillHash(dir), at: Date.now(), by: 'editor' } };
      this.save();
    }
  }

  /**
   * Bring in a skill folder (one containing SKILL.md): copied to a staging folder and scanned there first, then put
   * whole into the review area, where it waits for the user's approval; an earlier copy of the same name (in the
   * library or the review area) is replaced, none of its files left. When copying or scanning fails, the earlier copy
   * and its state stay as they were.
   */
  importSkill(folder: string): string {
    if (!fs.existsSync(path.join(folder, 'SKILL.md'))) throw new Error(L('這個資料夾裡沒有 SKILL.md', 'This folder has no SKILL.md'));
    const fm = parseFrontmatter(fs.readFileSync(path.join(folder, 'SKILL.md'), 'utf8'));
    const name = (fm.name || path.basename(folder)).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!NAME_RE.test(name)) throw new Error('invalid skill name');
    fs.mkdirSync(this.stagingDir, { recursive: true });
    const stage = path.join(this.stagingDir, `${name}-${randomUUID().slice(0, 8)}`);
    const old = `${stage}.old`;
    const oldLibrary = `${stage}.old-library`;
    const library = path.join(this.skillsDir, name);
    const target = path.join(this.reviewDir, name);
    try {
      // Links are copied as links, never followed.
      fs.cpSync(folder, stage, { recursive: true, verbatimSymlinks: true });
      let scan: SkillScan;
      try {
        scan = this.scanner(stage);
      } catch (e) {
        throw new Error(L(`掃描失敗：${(e as Error).message}`, `the scan failed: ${(e as Error).message}`));
      }
      if (scan.status === 'failed') throw new Error(L(`掃描失敗：${scan.error ?? ''}`, `the scan failed: ${scan.error ?? ''}`));
      // Both earlier copies aside, the new one in; any failure puts them back.
      fs.mkdirSync(this.reviewDir, { recursive: true });
      if (fs.existsSync(target)) fs.renameSync(target, old);
      try {
        if (fs.existsSync(library)) fs.renameSync(library, oldLibrary);
        fs.renameSync(stage, target);
      } catch (e) {
        if (fs.existsSync(oldLibrary) && !fs.existsSync(library)) fs.renameSync(oldLibrary, library);
        if (fs.existsSync(old) && !fs.existsSync(target)) fs.renameSync(old, target);
        throw e;
      }
      if (scan.hash) this.scans.set(scan.hash, scan);
    } catch (e) {
      fs.rmSync(stage, { recursive: true, force: true });
      throw new Error(L(`匯入失敗，原本的版本與狀態沒有變動：${(e as Error).message}`, `Import failed; the existing version and its state are unchanged: ${(e as Error).message}`));
    }
    fs.rmSync(old, { recursive: true, force: true });
    fs.rmSync(oldLibrary, { recursive: true, force: true });
    const cur = this.cfg.skills[name];
    // A new version waits for approval (the previous approval was for other content).
    this.cfg.skills[name] = { enabled: cur?.enabled ?? true, ...(cur?.roles ? { roles: cur.roles } : {}), origin: 'imported' };
    this.save();
    return name;
  }

  deleteSkill(name: string) {
    if (!NAME_RE.test(name)) throw new Error('invalid skill name');
    fs.rmSync(path.join(this.skillsDir, name), { recursive: true, force: true });
    fs.rmSync(path.join(this.reviewDir, name), { recursive: true, force: true });
    delete this.cfg.skills[name];
    this.save();
  }

  /** The switch and the roles; the approval and where the skill came from stay. */
  setSkill(name: string, patch: { enabled?: boolean; roles?: InstructionRole[] }) {
    const cur = this.cfg.skills[name] ?? { enabled: true };
    this.cfg.skills[name] = { ...cur, enabled: patch.enabled ?? cur.enabled, roles: patch.roles ?? cur.roles };
    this.save();
  }

  /**
   * Skills index for a role. Every CLI can read files, so skills are offered by reference:
   * the agent sees name + description and reads SKILL.md itself when a skill is relevant.
   */
  skillsBlock(role: AgentRole, cwd?: string): string {
    if (role === 'test' || role === 'compactor') return '';
    // Only what is switched on AND whose current files are the approved version (checked now, from the files).
    const own = this.listSkills().filter((s) => s.enabled && s.review.state === 'approved' && (!s.roles?.length || s.roles.includes(role as InstructionRole)));
    // The advisor only judges: extensions add nothing to it.
    const extra = role === 'advisor' ? [] : (this.extraSkills?.(role) ?? []);
    const names = new Set(own.map((s) => s.name));
    // The project's own skills (<cwd>/.aivenue/skills) come first: they outrank general ones.
    const project = role === 'advisor' || !cwd ? [] : this.loadableProjectSkills(cwd);
    const skills: ExtraSkill[] = [...project, ...own.filter((s) => !project.some((p) => p.name === s.name)).map((s) => ({ name: s.name, description: s.description, path: s.path, outline: skillOutline(s.path) })), ...extra.filter((s) => !names.has(s.name) && !project.some((p) => p.name === s.name))];
    const always = skills.filter((s) => s.always);
    const rules = role === 'advisor' ? '' : (this.extraRules?.(role, cwd) ?? '');
    if (!skills.length && !rules) return '';
    return [
      '',
      ...(skills.length
        ? [
            'SKILLS: The user wrote or chose these skills: tested ways of doing particular kinds of work (steps, conventions, checks, pitfalls) that you would otherwise have to work out yourself. Whether to use one is your call. Reading one costs a single file read, so when a skill touches the kind of work in front of you — even partly — it is usually worth opening its SKILL.md before you start; if it turns out not to fit, ignore it and go on. Files next to SKILL.md may be referenced by it. Each entry: name, what it is for, what it covers, where it is.',
            ...skills.flatMap((s) => [`- ${s.name}: ${s.always ? `[ALWAYS ON: ${s.always}] ` : ''}${s.description || '(no description)'} — ${s.path}`, ...(s.outline ? [`    covers: ${s.outline}`] : [])]),
            'Reading a skill is not following it: when you apply one, call the Aivenue tool `report_skill_use` {name, version?, reason, deliverables, verification, verified} — once applied, and again with verified=true after you checked it. If two skills conflict, the order is: the user\'s instructions, then project skills (in the working folder), then the skills above in the order listed; follow the higher one and say in report_skill_use which one you set aside and why.',
          ]
        : []),
      // Always-on skills come with their instructions: an agent may not open a file it was only pointed at.
      ...always.flatMap((s) => [`ALWAYS ON — ${s.name} (${s.always}): follow these instructions for this whole task, within the rules above (Aivenue's tools and output formats still come first):`, s.body ?? `Read ${s.path} before you start.`]),
      ...(rules ? [rules] : []),
    ].join('\n');
  }
}

/** One line for a resumed conversation: the skills are still there (the full index came in its first turn). */
export function skillsReminder(block: string): string {
  const names = [...block.matchAll(/^- ([\w.-]+): /gm)].map((m) => m[1]);
  return names.length ? `\nSKILLS (listed in full earlier in this conversation) are still available: ${names.join(', ')}. Open one's SKILL.md if it fits what you are doing now.` : '';
}

