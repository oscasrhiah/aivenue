import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentRole, CapabilitiesConfig, ConfigValue, InstructionRole, McpServerConfig, SkillInfo } from './types';
import type { SecretStore } from './secrets';
import { L } from './i18n';

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

function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
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

  constructor(dataDir: string, private secrets: SecretStore) {
    this.file = path.join(dataDir, 'capabilities.json');
    this.skillsDir = path.join(dataDir, 'skills');
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

  // ---------- role instructions ----------

  setInstructions(instructions: CapabilitiesConfig['instructions']) {
    const clean: CapabilitiesConfig['instructions'] = {};
    for (const [k, v] of Object.entries(instructions)) if (v?.trim()) clean[k as InstructionRole] = v.trim();
    this.cfg.instructions = clean;
    this.save();
  }

  instructionsFor(role: AgentRole): string | undefined {
    if (role === 'test') return undefined;
    const parts = [this.cfg.instructions.all, this.cfg.instructions[role as InstructionRole]].filter((x): x is string => !!x?.trim());
    return parts.length ? parts.join('\n\n') : undefined;
  }

  // ---------- skills ----------

  listSkills(): SkillInfo[] {
    const out: SkillInfo[] = [];
    for (const e of fs.readdirSync(this.skillsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = path.join(this.skillsDir, e.name);
      const file = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      const st = this.cfg.skills[e.name];
      out.push({ name: e.name, description: fm.description ?? '', path: file, enabled: st?.enabled ?? true, roles: st?.roles, files: countFiles(dir) });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  readSkill(name: string): string {
    if (!NAME_RE.test(name)) throw new Error('invalid skill name');
    return fs.readFileSync(path.join(this.skillsDir, name, 'SKILL.md'), 'utf8');
  }

  /** Create or update a skill from its SKILL.md content. */
  saveSkill(name: string, content: string) {
    if (!NAME_RE.test(name)) throw new Error(L('名稱只能包含英數字、- 和 _', 'Name may only contain letters, digits, - and _'));
    const fm = parseFrontmatter(content);
    if (!fm.description) throw new Error(L('SKILL.md 開頭需要 frontmatter，至少包含 description', 'SKILL.md must start with frontmatter containing at least a description'));
    const dir = path.join(this.skillsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
  }

  /** Copy a skill folder (one containing SKILL.md) into the library. */
  importSkill(folder: string): string {
    if (!fs.existsSync(path.join(folder, 'SKILL.md'))) throw new Error(L('這個資料夾裡沒有 SKILL.md', 'This folder has no SKILL.md'));
    const fm = parseFrontmatter(fs.readFileSync(path.join(folder, 'SKILL.md'), 'utf8'));
    const name = (fm.name || path.basename(folder)).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!NAME_RE.test(name)) throw new Error('invalid skill name');
    fs.cpSync(folder, path.join(this.skillsDir, name), { recursive: true });
    return name;
  }

  deleteSkill(name: string) {
    if (!NAME_RE.test(name)) throw new Error('invalid skill name');
    fs.rmSync(path.join(this.skillsDir, name), { recursive: true, force: true });
    delete this.cfg.skills[name];
    this.save();
  }

  setSkill(name: string, patch: { enabled?: boolean; roles?: InstructionRole[] }) {
    const cur = this.cfg.skills[name] ?? { enabled: true };
    this.cfg.skills[name] = { enabled: patch.enabled ?? cur.enabled, roles: patch.roles ?? cur.roles };
    this.save();
  }

  /**
   * Skills index for a role. Every CLI can read files, so skills are offered by reference:
   * the agent sees name + description and reads SKILL.md itself when a skill is relevant.
   */
  skillsBlock(role: AgentRole): string {
    if (role === 'test') return '';
    const skills = this.listSkills().filter((s) => s.enabled && (!s.roles?.length || s.roles.includes(role as InstructionRole)));
    if (!skills.length) return '';
    return [
      '',
      'SKILLS: The user provides these skills. When one is relevant to what you are doing, read its SKILL.md first and follow it (files next to SKILL.md may be referenced by it):',
      ...skills.map((s) => `- ${s.name}: ${s.description || '(no description)'} — ${s.path}`),
    ].join('\n');
  }
}
