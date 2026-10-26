import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ArgGroup, AuthMode, CatalogProvider, ModelInfo, ProviderInfo, ProviderSpec } from '../types';
import { capture, childPath, openTerminal, resolveCommand, specCommand, takesEffort, terminalLine, type TerminalRequest } from '../proc';
import type { SecretStore } from '../secrets';
import { L } from '../i18n';
import { BUILTIN_PROVIDERS, RETIRED_BUILTINS } from './builtin';
import { lookupModel } from '../modelContext';

interface StoredProviders {
  /** User specs; a spec with a built-in id overrides that built-in. */
  providers: ProviderSpec[];
  /** Built-in ids the user removed. */
  hidden: string[];
  /** Per-provider user choices that are not part of the spec. */
  settings: Record<string, { authMode: AuthMode; baseUrl?: string; defaultModel?: string; defaultEffort?: string }>;
  /** Extra accounts of tools that can run several side by side (spec.accounts). */
  accounts: { providerId: string; slug: string; name: string }[];
}

/** Environment that points a CLI at an extra account's config folder (empty for the default account). */
export function accountEnv(spec: ProviderSpec): Record<string, string> {
  return spec.accountOf && spec.accounts && spec.accountHome ? { [spec.accounts.env]: spec.accountHome } : {};
}

/** A path under the CLI's default config folder, moved into an extra account's folder. */
function inAccount(p: string, spec: ProviderSpec): string {
  if (!spec.accountOf || !spec.accounts || !spec.accountHome) return p;
  const home = spec.accounts.home.replace(/[\\/]+$/, '');
  return p.startsWith(home) ? path.join(spec.accountHome, p.slice(home.length)) : p;
}

export interface RunAuth {
  env: Record<string, string>;
  args: ArgGroup[];
  settingsExtra?: Record<string, unknown>;
}

const keyName = (id: string) => `apikey:${id}`;
const unknownProvider = (id: string) => L(`未知的供應商：${id}`, `Unknown provider: ${id}`);

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export function validateSpec(spec: ProviderSpec): string | undefined {
  if (!spec || typeof spec !== 'object') return L('設定必須是 JSON 物件', 'The spec must be a JSON object');
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(spec.id ?? '')) return L('id 只能包含英數字、- 和 _', 'id may only contain letters, digits, - and _');
  if (!spec.name) return L('缺少 name', 'name is required');
  if (!spec.command) return L('缺少 command', 'command is required');
  if (!spec.run || !Array.isArray(spec.run.common)) return L('run.common 必須是參數群組陣列，例如 [["-p"], ["--model", "{model}"]]', 'run.common must be an array of arg groups, e.g. [["-p"], ["--model", "{model}"]]');
  if (!['stdin', 'arg'].includes(spec.run.prompt)) return L('run.prompt 必須是 "stdin" 或 "arg"', 'run.prompt must be "stdin" or "arg"');
  const formats = ['claude-stream', 'codex-jsonl', 'gemini-stream', 'agy-stream', 'opencode-json', 'copilot-json', 'text'];
  if (!formats.includes(spec.output)) return L(`output 必須是 ${formats.join(' / ')} 之一`, `output must be one of ${formats.join(' / ')}`);
  return undefined;
}

/** The model / effort a CLI uses when none is given, read from its own config file (e.g. Codex's config.toml). */
function readConfigDefaults(c: NonNullable<ProviderSpec['configDefaults']>): { model?: string; effort?: string } {
  try {
    const text = fs.readFileSync(c.file.startsWith('~') ? path.join(os.homedir(), c.file.slice(1)) : c.file, 'utf8');
    // Only top-level keys: stop at the first [table].
    const top = text.split(/^\s*\[/m)[0];
    const pick = (re?: string) => (re ? new RegExp(re, 'm').exec(top)?.[1] : undefined);
    return { model: pick(c.model), effort: pick(c.effort) };
  } catch {
    return {};
  }
}

/**
 * Install command wrapped for the terminal window: says what is happening (a global npm install prints
 * nothing for minutes), shows npm's download activity, and ends with a clear success / failure line.
 */
/** Provider ids and account slugs used as folder names. */
const SAFE_SLUG = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

/** The install command for this OS. */
export function installCommand(spec: Pick<ProviderSpec, 'install' | 'installOn'>): string | undefined {
  return spec.installOn?.[process.platform as 'win32' | 'darwin' | 'linux'] ?? spec.install;
}

/**
 * How to remove what the install command put there: winget, npm and Homebrew installs can be undone by the same tool.
 * Install scripts (curl … | sh) have no matching uninstall, so none is offered.
 */
export function uninstallCommand(spec: Pick<ProviderSpec, 'install' | 'installOn'>): string | undefined {
  const cmd = installCommand(spec)?.trim();
  if (!cmd || /[|;&]/.test(cmd)) return undefined;
  let m = /^winget\s+install\s+(?:--id\s+)?(\S+)/.exec(cmd);
  if (m) return `winget uninstall --id ${m[1]} -e`;
  m = /^npm(?:\.cmd)?\s+(?:i|install)\s+(?:-g|--global)\s+(\S+)$/.exec(cmd);
  if (m) return `npm uninstall -g ${m[1].replace(/(.)@[^/@]*$/, '$1')}`;
  m = /^brew\s+install\s+(\S+)$/.exec(cmd);
  if (m) return `brew uninstall ${m[1]}`;
  return undefined;
}

/** The uninstall command, only when the CLI found was put there by that tool (not, say, a native installer). */
function installedBy(cmd: string | undefined, found: string): string | undefined {
  if (!cmd) return undefined;
  const tool = cmd.split(/\s+/)[0];
  // npm's bin links on Linux/macOS point into node_modules.
  try {
    found = `${found} ${fs.realpathSync(found)}`;
  } catch {
    // keep the path as found
  }
  const ok = tool === 'winget' ? /[\\/]WinGet[\\/]/i.test(found) : tool === 'npm' ? /[\\/]npm[\\/]|node_modules|npm-global|[\\/]\.?nvm[\\/]/i.test(found) : tool === 'brew' ? /homebrew|Cellar|linuxbrew/i.test(found) : false;
  return ok ? cmd : undefined;
}

export function installLine(name: string, cmd: string): string {
  const isNpm = /^npm(\.cmd)?\s+(i|install)\b/.test(cmd.trim());
  const run = isNpm ? `${cmd} --loglevel=http --foreground-scripts` : cmd;
  const start = L(`正在安裝 ${name}：${cmd}`, `Installing ${name}: ${cmd}`);
  const wait = L('下載與安裝可能需要幾分鐘，請不要關閉這個視窗。', 'Download and install can take a few minutes; keep this window open.');
  const ok = L('✓ 安裝完成，可以關閉這個視窗，回到 Aivenue 按「重新檢查」。', '✓ Installed. You can close this window and press Re-check in Aivenue.');
  const fail = L('✗ 安裝失敗，請看上面的錯誤訊息。', '✗ Install failed; see the error above.');
  // Echoed text must not contain anything cmd.exe would act on (a provider name from the online catalog, say).
  const e = (s: string) => s.replace(/[&|<>^%!"()\r\n]/g, ' ');
  if (process.platform === 'win32') return `echo ${e(start)} & echo ${e(wait)} & echo. & ${run} && (echo. & echo ${e(ok)}) || (echo. & echo ${e(fail)})`;
  return posixInstallLine(cmd, run, isNpm, [start, wait], ok, fail);
}

/**
 * POSIX shell line for an install: checks the needed tool first, and for npm whether its global folder is
 * writable (a system Node.js needs sudo there), printing what to do instead of npm's bare EACCES error.
 */
export function posixInstallLine(cmd: string, run: string, isNpm: boolean, intro: string[], ok: string, fail: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const say = (...lines: string[]) => lines.map((l) => `echo ${q(l)}`).join('; ');
  const ifElse = (cond: string, then: string, otherwise: string) => `if ${cond}; then ${then}; else ${otherwise}; fi`;
  const absent = (tool: string) => `! command -v ${tool} >/dev/null 2>&1`;
  const attempt = (afterFail: string) => ifElse(run, `echo; ${say(ok)}`, `echo; ${say(fail)}${afterFail ? `; ${afterFail}` : ''}`);
  const head = `${say(...intro)}; echo`;
  if (!isNpm) {
    const tool = /^\s*(curl|wget|brew)\b/.exec(cmd)?.[1];
    if (!tool) return `${head}; ${attempt('')}`;
    const hint = say(L(`✗ 找不到 ${tool}，請先用系統的套件管理員安裝它，再按一次「安裝」。`, `✗ ${tool} was not found. Install it with your system's package manager, then press Install again.`));
    return `${head}; ${ifElse(absent(tool), hint, attempt(''))}`;
  }
  const noNpm = say(L('✗ 找不到 npm：請先安裝 Node.js 22 以上（建議用 nvm：https://github.com/nvm-sh/nvm ），再按一次「安裝」。', '✗ npm was not found. Install Node.js 22 or newer (nvm is recommended: https://github.com/nvm-sh/nvm), then press Install again.'));
  const needsSudo = [
    say(L('✗ npm 的全域安裝資料夾需要管理員權限，所以沒有開始安裝：', "✗ npm's global folder needs administrator rights, so nothing was installed:")),
    'echo "    $AIV_W"',
    say(
      L('可以擇一處理：', 'Pick one:'),
      L('  1. 改用 nvm 安裝 Node.js（不需要 sudo，最推薦）：https://github.com/nvm-sh/nvm', '  1. Install Node.js with nvm (no sudo needed, recommended): https://github.com/nvm-sh/nvm'),
      L('  2. 把 npm 全域資料夾改到家目錄，再回到 Aivenue 按一次「安裝」：', "  2. Move npm's global folder into your home folder, then press Install again in Aivenue:"),
      '       mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global',
      L('     並把這行加到 ~/.bashrc 或 ~/.zshrc：export PATH="$HOME/.npm-global/bin:$PATH"', '     and add this line to ~/.bashrc or ~/.zshrc: export PATH="$HOME/.npm-global/bin:$PATH"'),
      L(`  3. 或在這個視窗自己執行：sudo ${cmd}`, `  3. Or run it yourself in this window: sudo ${cmd}`),
    ),
  ].join('; ');
  const eaccesAfter = say(L('如果上面的錯誤有 EACCES 或 permission denied：建議改用 nvm 安裝 Node.js，或執行 npm config set prefix ~/.npm-global 後再試一次。', 'If the error above says EACCES or permission denied: install Node.js with nvm, or run npm config set prefix ~/.npm-global and try again.'));
  const findFolder = `AIV_P="$(npm config get prefix)"; ${ifElse('[ -d "$AIV_P/lib/node_modules" ]', 'AIV_W="$AIV_P/lib/node_modules"', 'AIV_W="$AIV_P"')}`;
  return `${head}; ${ifElse(absent('npm'), noNpm, `${findFolder}; ${ifElse('[ ! -w "$AIV_W" ]', needsSudo, attempt(eaccesAfter))}`)}`;
}

export class ProviderRegistry {
  private file: string;
  private stored: StoredProviders = { providers: [], hidden: [], settings: {}, accounts: [] };
  /** Each extra account's config folder lives here: <dataDir>/accounts/<provider>/<slug>. */
  private accountsDir: string;
  private auth = new Map<string, ProviderInfo['auth']>();
  private keyed = new Set<string>();
  private onChange: () => void;
  readonly ready: Promise<void>;
  /** Context sizes the CLIs reported while running ("<provider> <model>" → tokens): they beat the catalog. */
  private measuredFile: string;
  private measured: Record<string, number> = {};

  constructor(dataDir: string, private secrets: SecretStore, onChange: () => void) {
    this.file = path.join(dataDir, 'providers.json');
    this.measuredFile = path.join(dataDir, 'model-context.json');
    try {
      this.measured = JSON.parse(fs.readFileSync(this.measuredFile, 'utf8'));
    } catch {
      // none measured yet
    }
    this.accountsDir = path.join(dataDir, 'accounts');
    this.onChange = onChange;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.stored = {
        providers: Array.isArray(raw.providers) ? raw.providers : [],
        hidden: Array.isArray(raw.hidden) ? raw.hidden : [],
        settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : {},
        accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
      };
    } catch {
      // first run
    }
    this.ready = secrets
      .keys()
      .then((keys) => {
        for (const k of keys) if (k.startsWith('apikey:')) this.keyed.add(k.slice(7));
      })
      .catch(() => undefined);
  }

  get secureSecrets(): boolean {
    return this.secrets.secure;
  }

  authMode(id: string): AuthMode {
    return this.stored.settings[id]?.authMode === 'api' ? 'api' : 'subscription';
  }

  async setAuthMode(id: string, mode: AuthMode, baseUrl?: string): Promise<void> {
    const spec = this.get(id);
    if (!spec) throw new Error(unknownProvider(id));
    if (mode === 'api' && !spec.apiKey) throw new Error(L(`${spec.name} 沒有設定 API 模式（請在進階設定加入 apiKey 欄位）`, `${spec.name} has no API mode (add an apiKey field in the advanced settings)`));
    if (baseUrl && !/^https?:\/\//.test(baseUrl)) throw new Error(L('Base URL 必須以 http:// 或 https:// 開頭', 'Base URL must start with http:// or https://'));
    this.stored.settings[id] = { ...this.stored.settings[id], authMode: mode, baseUrl: baseUrl?.trim() || undefined };
    this.save();
    await this.checkAuth(id);
  }

  /** Default model / reasoning effort used when a role does not choose its own. */
  setDefaults(id: string, model?: string, effort?: string) {
    if (!this.get(id)) throw new Error(unknownProvider(id));
    const cur = this.stored.settings[id] ?? { authMode: 'subscription' };
    this.stored.settings[id] = { ...cur, defaultModel: model?.trim() || undefined, defaultEffort: effort?.trim() || undefined };
    this.save();
    this.onChange();
  }

  defaults(id: string): { model?: string; effort?: string } {
    const s = this.stored.settings[id];
    const spec = this.get(id);
    const fromCli = spec?.configDefaults ? readConfigDefaults(spec.configDefaults) : {};
    return { model: s?.defaultModel ?? spec?.defaultModel ?? fromCli.model, effort: s?.defaultEffort ?? fromCli.effort };
  }

  /** Set by the hub: loads the models.dev catalog. */
  catalogLoader?: () => Promise<CatalogProvider[]>;

  /** Set by the extensions: models of a provider an extension runs (OmniRoute), and whether it is usable right now. */
  extensionModels?: (id: string) => Promise<ModelInfo[] | undefined>;
  extensionAuth?: (id: string) => Promise<ProviderInfo['auth'] | undefined>;

  /**
   * Add a provider from the catalog (subscription plan / pay-as-you-go API / local), or a custom
   * OpenAI-compatible endpoint. It runs through OpenCode; the key stays in Aivenue's secret store.
   */
  async addFromCatalog(cp: CatalogProvider | undefined, input: { key?: string; model?: string; extraEnv?: Record<string, string>; custom?: { name: string; baseURL: string; model: string } }): Promise<string> {
    const base = BUILTIN_PROVIDERS.find((b) => b.id === 'opencode')!;
    const custom = input.custom;
    if (!cp && !custom) throw new Error('unknown catalog provider');
    if (custom && !/^https?:\/\//.test(custom.baseURL)) throw new Error(L('Base URL 必須以 http:// 或 https:// 開頭', 'Base URL must start with http:// or https://'));
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'custom';
    const pid = custom ? `custom-${slug(custom.name)}` : cp!.id;
    const kind = custom ? (/localhost|127\.0\.0\.1/.test(custom.baseURL) ? 'local' : 'api') : cp!.kind;
    const providerCfg = custom
      ? { npm: '@ai-sdk/openai-compatible', name: custom.name, options: { baseURL: custom.baseURL, apiKey: '{env:AIVENUE_API_KEY}' }, models: { [custom.model]: { name: custom.model } } }
      : { options: { apiKey: '{env:AIVENUE_API_KEY}' } };
    const name = custom ? custom.name : cp!.name;
    const what = kind === 'plan' ? L('訂閱方案', 'subscription plan') : kind === 'local' ? L('本機模型', 'local models') : L('按量計費 API', 'pay-as-you-go API');
    const firstModel = cp?.models[0]?.id;
    // Adding the same plan / API again (another key) is another account, not a replacement.
    let id = `api-${pid}`;
    let n = 1;
    while (this.get(id)) id = `api-${pid}-${++n}`;
    const spec: ProviderSpec = {
      ...base,
      id,
      name: n > 1 ? `${name}（${n}）` : name,
      accountOf: n > 1 ? `api-${pid}` : undefined,
      description: L(`${name} — ${what}，透過 OpenCode 執行`, `${name} — ${what}, run through OpenCode`),
      login: undefined,
      logout: undefined,
      status: {},
      docsUrl: cp?.doc ?? base.docsUrl,
      apiKey: {
        env: 'AIVENUE_API_KEY',
        extraEnv: input.extraEnv && Object.keys(input.extraEnv).length ? input.extraEnv : undefined,
        settingsExtra: { provider: { [pid]: providerCfg } },
        note: cp ? L(`金鑰對應 ${cp.env[0] ?? 'API key'}${cp.api ? `；端點 ${cp.api}` : ''}`, `Key for ${cp.env[0] ?? 'API key'}${cp.api ? `; endpoint ${cp.api}` : ''}`) : custom!.baseURL,
      },
      modelSource: custom ? undefined : { type: 'catalog', providerId: pid },
      models: custom ? [`${pid}/${custom.model}`] : undefined,
      defaultModel: input.model ? (input.model.includes('/') && !cp?.models.some((m) => m.id === input.model) ? input.model : `${pid}/${input.model}`) : custom ? `${pid}/${custom.model}` : firstModel ? `${pid}/${firstModel}` : undefined,
      catalog: { providerId: pid, kind },
      profile: { plan: 4, review: 4, code: 4, speed: 4, vision: cp ? cp.models.some((m) => m.vision) : false, pdf: false },
    };
    this.upsert(spec);
    this.stored.settings[spec.id] = { ...this.stored.settings[spec.id], authMode: 'api' };
    this.save();
    // Local servers usually need no key, but OpenCode still expects one to be set.
    await this.setApiKey(spec.id, input.key?.trim() || (kind === 'local' ? 'not-needed' : undefined));
    return spec.id;
  }

  private modelCache = new Map<string, { at: number; models: ModelInfo[] }>();

  /** Models the provider offers: from the CLI's own cache/command when possible, else the preset list. */
  async listModels(id: string, refresh = false): Promise<ModelInfo[]> {
    const spec = this.get(id);
    if (!spec) throw new Error(unknownProvider(id));
    const hit = this.modelCache.get(id);
    if (hit && !refresh && Date.now() - hit.at < 10 * 60000) return hit.models;
    const fallback = (spec.models ?? []).map((m) => ({ id: m, efforts: spec.efforts }));
    let models: ModelInfo[] = [];
    try {
      const src = spec.modelSource;
      if (src?.type === 'extension') {
        models = (await this.extensionModels?.(spec.accountOf ?? spec.id)) ?? [];
      } else if (src?.type === 'catalog') {
        const cp = (await this.catalogLoader?.())?.find((p) => p.id === src.providerId);
        models = (cp?.models ?? []).map((m) => ({
          id: `${src.providerId}/${m.id}`,
          label: m.name,
          description: [m.free && 'free', m.vision && 'vision', m.reasoning && 'reasoning'].filter(Boolean).join(' · '),
          efforts: spec.efforts,
          context: m.context,
          contextSource: m.context ? ('catalog' as const) : undefined,
          free: m.free,
          inputs: m.inputs,
        }));
      } else if (src?.type === 'codex-cache') {
        // An extra account may not have its own cache yet; the model list is the same for every account.
        const homes = [accountEnv(spec).CODEX_HOME, process.env.CODEX_HOME, path.join(os.homedir(), '.codex')].filter((h): h is string => !!h);
        const file = homes.map((h) => path.join(h, 'models_cache.json')).find((f) => fs.existsSync(f)) ?? path.join(homes[homes.length - 1], 'models_cache.json');
        const json = JSON.parse(fs.readFileSync(file, 'utf8'));
        models = (json.models ?? [])
          .filter((m: any) => m.slug && m.visibility !== 'hide')
          .sort((a: any, b: any) => (a.priority ?? 99) - (b.priority ?? 99))
          .map((m: any) => ({
            id: m.slug,
            label: m.display_name,
            description: m.description,
            efforts: (m.supported_reasoning_levels ?? []).map((l: any) => l.effort).filter(Boolean),
            defaultEffort: m.default_reasoning_level,
            context: m.context_window || undefined,
            inputs: Array.isArray(m.input_modalities) ? m.input_modalities : undefined,
            contextSource: m.context_window ? ('cli' as const) : undefined,
          }));
      } else if (src?.type === 'command') {
        const r = await capture(specCommand(spec), src.args, { timeoutMs: 30000 });
        // One model per line: "<id>  <label>" (tab / 2+ spaces / " - " separated); the id must look like a slug.
        for (const line of (r.stdout || '').split(/\r?\n/)) {
          const m = /^\s*[*>\-•]?\s*([a-z0-9][\w.\-:/]*\w)(?:(?:\t+|\s{2,}|\s+[-–|]\s+)(.+))?\s*$/i.exec(line);
          if (m && /\d|-/.test(m[1]) && !/^(fetching|error|available|usage)$/i.test(m[1])) models.push({ id: m[1], label: m[2]?.trim(), efforts: spec.efforts });
        }
      }
    } catch {
      // fall back to the preset list
    }
    if (!models.length) models = fallback;
    // Models that refuse a reasoning effort offer none, so the UI shows no effort choice for them.
    models = models.map((m) => (takesEffort(spec, m.id) ? m : { ...m, efforts: [], defaultEffort: undefined }));
    models = await this.withContext(spec, models);
    this.modelCache.set(id, { at: Date.now(), models });
    return models;
  }

  /** Fill in each model's context size: what a run measured, else the models.dev catalog. */
  private async withContext(spec: ProviderSpec, models: ModelInfo[]): Promise<ModelInfo[]> {
    const base = spec.accountOf ? (this.get(spec.accountOf) ?? spec) : spec;
    const providers = base.contextCatalog ?? (base.catalog ? [base.catalog.providerId] : []);
    const catalog = await this.catalogLoader?.().catch(() => undefined);
    return models.map((m) => {
      const seen = this.measured[`${base.id} ${m.id}`];
      if (seen) m = { ...m, context: seen, contextSource: 'measured' };
      if ((m.context && m.inputs) || !catalog) return m;
      const found = lookupModel(catalog, providers, m.id);
      return {
        ...m,
        ...(!m.context && found.context ? { context: found.context, contextSource: 'catalog' as const } : {}),
        inputs: m.inputs ?? found.inputs,
      };
    });
  }

  /** Read the provider's model list again next time (its source changed). */
  forgetModels(id: string) {
    this.modelCache.delete(id);
  }

  /** A run reported its model's context size: remember it for the model menus. */
  noteContext(id: string, model: string | undefined, window: number | undefined) {
    const spec = this.get(id);
    if (!spec || !model || !window) return;
    const key = `${spec.accountOf ?? spec.id} ${model}`;
    if (this.measured[key] === window) return;
    this.measured[key] = window;
    this.modelCache.delete(spec.accountOf ?? spec.id);
    this.modelCache.delete(id);
    try {
      fs.writeFileSync(this.measuredFile, JSON.stringify(this.measured, null, 2));
    } catch {
      // read-only data folder: keep it for this session
    }
  }

  async setApiKey(id: string, key: string | undefined): Promise<void> {
    if (!this.get(id)) throw new Error(unknownProvider(id));
    if (key?.trim()) {
      await this.secrets.set(keyName(id), key.trim());
      this.keyed.add(id);
    } else {
      await this.secrets.delete(keyName(id));
      this.keyed.delete(id);
    }
    await this.checkAuth(id);
  }

  /** Environment/args a run needs for the provider's selected auth mode. */
  async runAuth(id: string): Promise<RunAuth> {
    const spec = this.get(id);
    if (!spec || this.authMode(id) !== 'api' || !spec.apiKey) return { env: {}, args: [] };
    const key = await this.secrets.get(keyName(id));
    if (!key) throw new Error(L(`${spec.name} 設定為 API 模式，但尚未輸入 API 金鑰`, `${spec.name} is in API mode but no API key has been entered`));
    const env: Record<string, string> = { ...(spec.apiKey.extraEnv ?? {}), [spec.apiKey.env]: key };
    const baseUrl = this.stored.settings[id]?.baseUrl;
    if (baseUrl && spec.apiKey.baseUrlEnv) env[spec.apiKey.baseUrlEnv] = baseUrl;
    return { env, args: spec.apiKey.args ?? [], settingsExtra: spec.apiKey.settingsExtra };
  }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.stored, null, 2));
  }

  specs(): ProviderSpec[] {
    const out: ProviderSpec[] = [];
    for (const b of BUILTIN_PROVIDERS) {
      if (this.stored.hidden.includes(b.id)) continue;
      out.push(this.stored.providers.find((p) => p.id === b.id) ?? b);
    }
    for (const p of this.stored.providers) if (!BUILTIN_PROVIDERS.some((b) => b.id === p.id) && !RETIRED_BUILTINS.includes(p.id)) out.push(p);
    // Each extra account runs the same tool with its own config folder, as a provider of its own.
    for (const a of this.stored.accounts) {
      const base = out.find((s) => s.id === a.providerId && s.accounts);
      if (!base?.accounts || !SAFE_SLUG.test(a.slug) || !SAFE_SLUG.test(a.providerId)) continue;
      const home = path.join(this.accountsDir, a.providerId, a.slug);
      const acc: ProviderSpec = {
        ...structuredClone(base),
        id: `${a.providerId}~${a.slug}`,
        name: `${base.name}（${a.name}）`,
        accountOf: base.id,
        accountName: a.name,
        accountHome: home,
      };
      acc.run.env = { ...(acc.run.env ?? {}), [base.accounts.env]: home };
      if (acc.status) {
        acc.status.files = acc.status.files?.map((f) => inAccount(f, acc));
        acc.status.fileContains = acc.status.fileContains?.map((fc) => ({ ...fc, path: inAccount(fc.path, acc) }));
      }
      if (acc.configDefaults) acc.configDefaults = { ...acc.configDefaults, file: inAccount(acc.configDefaults.file, acc) };
      out.push(acc);
    }
    return out;
  }

  /** Add another account of a tool that supports several (its own sign-in, used side by side). */
  addAccount(providerId: string, name: string): string {
    const base = this.get(providerId);
    if (!base?.accounts || base.accountOf) throw new Error(L('這個工具不支援多個帳號', 'This tool does not support several accounts'));
    const clean = name.trim().slice(0, 40);
    if (!clean) throw new Error(L('請輸入帳號名稱', 'Enter a name for the account'));
    // Folder-safe id; names without Latin letters (e.g. 「第二個」) get a numbered one.
    let slug = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'account-1';
    for (let i = 2; this.stored.accounts.some((a) => a.providerId === providerId && a.slug === slug); i++) slug = `${slug.replace(/-\d+$/, '')}-${i}`;
    this.stored.accounts.push({ providerId, slug, name: clean });
    fs.mkdirSync(path.join(this.accountsDir, providerId, slug), { recursive: true });
    this.save();
    const id = `${providerId}~${slug}`;
    void this.checkAuth(id).catch(() => undefined);
    this.onChange();
    return id;
  }

  /** Remove an extra account; `deleteData` also deletes its config folder (its sign-in and history). */
  removeAccount(id: string, deleteData: boolean): void {
    const spec = this.get(id);
    const account = this.stored.accounts.find((a) => `${a.providerId}~${a.slug}` === id);
    if (!spec?.accountOf || !account) throw new Error(L('這不是額外加入的帳號', 'This is not an extra account'));
    this.stored.accounts = this.stored.accounts.filter((a) => a !== account);
    delete this.stored.settings[id];
    this.auth.delete(id);
    this.save();
    // The folder comes from the stored account (never from a spec), and must be exactly accounts/<provider>/<slug>.
    const dir = path.join(this.accountsDir, account.providerId, account.slug);
    const rel = path.relative(this.accountsDir, dir).split(path.sep);
    if (deleteData && SAFE_SLUG.test(account.providerId) && SAFE_SLUG.test(account.slug) && rel.length === 2 && !rel.includes('..')) {
      // A CLI that just exited may still hold its database files for a moment: retry, then try again later.
      const remove = () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      try {
        remove();
      } catch {
        setTimeout(() => {
          try {
            remove();
          } catch {
            // left for the user to delete; the account itself is already gone
          }
        }, 10000).unref?.();
      }
    }
    this.onChange();
  }

  get(id: string): ProviderSpec | undefined {
    return this.specs().find((s) => s.id === id);
  }

  list(): ProviderInfo[] {
    return this.specs().map((spec) => {
      const builtin = BUILTIN_PROVIDERS.find((b) => b.id === spec.id);
      const resolved = resolveCommand(specCommand(spec));
      return {
        spec,
        builtin: !!builtin,
        customized: !!builtin && this.stored.providers.some((p) => p.id === spec.id),
        installed: !!resolved,
        resolvedPath: resolved?.display,
        installCommand: installCommand(spec),
        // Only when the CLI found is the one that command installed (not, say, the CLI inside OpenCode Desktop).
        uninstallCommand: resolved && specCommand(spec) === spec.command ? installedBy(uninstallCommand(spec), resolved.display) : undefined,
        auth: this.auth.get(spec.id) ?? { state: 'unknown' },
        authMode: this.authMode(spec.id),
        hasApiKey: this.keyed.has(spec.id),
        baseUrl: this.stored.settings[spec.id]?.baseUrl,
        defaultModel: this.stored.settings[spec.id]?.defaultModel,
        defaultEffort: this.stored.settings[spec.id]?.defaultEffort,
      };
    });
  }

  upsert(spec: ProviderSpec): void {
    const err = validateSpec(spec);
    if (err) throw new Error(err);
    // Account fields are derived from the stored accounts, never taken from a saved spec.
    spec = { ...spec };
    delete spec.accountOf;
    delete spec.accountHome;
    delete spec.accountName;
    this.stored.providers = this.stored.providers.filter((p) => p.id !== spec.id).concat(spec);
    this.stored.hidden = this.stored.hidden.filter((h) => h !== spec.id);
    this.save();
    this.onChange();
  }

  remove(id: string): void {
    this.stored.providers = this.stored.providers.filter((p) => p.id !== id);
    if (BUILTIN_PROVIDERS.some((b) => b.id === id) && !this.stored.hidden.includes(id)) this.stored.hidden.push(id);
    this.auth.delete(id);
    this.save();
    this.onChange();
  }

  /** Drop the user's override of a built-in (and un-hide it). */
  reset(id: string): void {
    this.stored.providers = this.stored.providers.filter((p) => p.id !== id);
    this.stored.hidden = this.stored.hidden.filter((h) => h !== id);
    this.save();
    this.onChange();
  }

  async checkAuth(id: string): Promise<ProviderInfo['auth']> {
    const spec = this.get(id);
    if (!spec) throw new Error(unknownProvider(id));
    this.auth.set(id, { state: 'checking' });
    this.onChange();
    const result = await this.evaluateAuth(spec);
    this.auth.set(id, { ...result, checkedAt: Date.now() });
    this.onChange();
    return this.auth.get(id)!;
  }

  async checkAll(): Promise<void> {
    await Promise.all(this.specs().map((s) => this.checkAuth(s.id).catch(() => undefined)));
  }

  private async evaluateAuth(spec: ProviderSpec): Promise<ProviderInfo['auth']> {
    if (!resolveCommand(specCommand(spec))) return { state: 'logged_out', detail: L('尚未安裝', 'Not installed') };
    if (spec.modelSource?.type === 'extension') {
      const ext = await this.extensionAuth?.(spec.id);
      if (ext) return ext;
    }
    if (this.authMode(spec.id) === 'api') {
      return this.keyed.has(spec.id) ? { state: 'logged_in', detail: L('API 模式：金鑰已設定', 'API mode: key saved') } : { state: 'logged_out', detail: L('API 模式：尚未輸入金鑰', 'API mode: no key yet') };
    }
    const st = spec.status;
    if (!st) return { state: 'unknown', detail: L('未設定登入狀態檢查方式', 'No login status check configured') };
    if (st.ready) return { state: 'logged_in', detail: L('可直接使用（不需登入）', 'Ready (no sign-in needed)') };
    for (const e of st.env ?? []) if (process.env[e]) return { state: 'logged_in', detail: L(`使用環境變數 ${e}`, `Using environment variable ${e}`) };
    for (const f of st.files ?? []) if (fs.existsSync(expandHome(f))) return { state: 'logged_in', detail: L(`找到 ${f}`, `Found ${f}`) };
    for (const fc of st.fileContains ?? []) {
      try {
        if (fs.readFileSync(expandHome(fc.path), 'utf8').includes(fc.text)) return { state: 'logged_in', detail: L(`${fc.path} 已設定登入方式`, `Sign-in configured in ${fc.path}`) };
      } catch {
        // missing
      }
    }
    if (st.args) {
      const r = await capture(specCommand(spec), st.args, { timeoutMs: 20000, env: accountEnv(spec) });
      const out = r.stdout + '\n' + r.stderr;
      if (r.error) return { state: 'unknown', detail: r.error };
      // JSON status commands may exit non-zero when signed out; don't show their raw output.
      // Signed-out output is often noise (warnings, hints); show a plain line unless it looks like a real error.
      const signedOut = (): ProviderInfo['auth'] => ({ state: 'logged_out', detail: st.jsonPath || !/error|failed|denied|not found/i.test(out) ? L('尚未登入', 'Not signed in') : out.trim().slice(0, 200) });
      if (r.code !== 0) return signedOut();
      if (st.stdoutIncludes && !out.includes(st.stdoutIncludes)) return signedOut();
      if (st.jsonPath) {
        try {
          const json = JSON.parse(r.stdout);
          const v = getPath(json, st.jsonPath);
          if (!v) return { state: 'logged_out', detail: L('尚未登入', 'Not signed in') };
          const method = getPath(json, 'authMethod');
          return { state: 'logged_in', detail: typeof method === 'string' ? L(`登入方式：${method}`, `Signed in with ${method}`) : undefined };
        } catch {
          return { state: 'unknown', detail: L('無法解析狀態輸出', 'Could not parse the status output') };
        }
      }
      return { state: 'logged_in', detail: out.trim().split('\n')[0]?.slice(0, 120) };
    }
    return { state: 'logged_out', detail: L('尚未登入', 'Not signed in') };
  }

  /** Open a terminal running the CLI's own login flow; it opens the provider's official sign-in page. */
  login(id: string): void {
    const spec = this.get(id);
    if (!spec) throw new Error(unknownProvider(id));
    const cmd = resolveCommand(specCommand(spec));
    if (!cmd) throw new Error(L(`尚未安裝 ${spec.name}，請先安裝`, `${spec.name} is not installed yet`));
    this.terminal({ title: `${L('登入', 'Sign in')} ${spec.name}`, command: cmd, args: spec.login?.args ?? [], env: accountEnv(spec) }, [specCommand(spec), ...(spec.login?.args ?? [])].join(' '));
    this.pollAuth(id);
  }

  /**
   * Where install / sign-in commands run: the host's own terminal when it has one (VS Code's integrated
   * terminal, which also works over Remote SSH), else a new terminal window.
   */
  terminalHook?: (req: { title: string; cwd: string; line: string; env: Record<string, string> }) => void;

  /** Run a line in the host's terminal (VS Code) or a new terminal window; `plain` is what to show if neither works. */
  terminal(req: TerminalRequest, plain: string): void {
    if (this.terminalHook) {
      // With the well-known install folders on PATH, so a CLI installed a moment ago is found.
      const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
      this.terminalHook({ title: req.title, cwd: req.cwd || os.homedir(), line: terminalLine(req), env: { ...(req.env ?? {}), [pathKey]: childPath() } });
      return;
    }
    try {
      openTerminal(req);
    } catch (e) {
      throw new Error(`${(e as Error).message}. ${L('請自己在終端機執行：', 'Run this in a terminal yourself: ')}${plain}`);
    }
  }

  logout(id: string): void {
    const spec = this.get(id);
    if (!spec?.logout) throw new Error(L('此供應商沒有設定登出指令', 'This provider has no logout command'));
    const cmd = resolveCommand(specCommand(spec));
    if (!cmd) throw new Error(L(`尚未安裝 ${spec.name}`, `${spec.name} is not installed`));
    this.terminal({ title: `${L('登出', 'Sign out')} ${spec.name}`, command: cmd, args: spec.logout.args, env: accountEnv(spec) }, [specCommand(spec), ...spec.logout.args].join(' '));
    this.pollAuth(id);
  }

  /** Remove the CLI with the tool that installed it (in a terminal, so the user sees what happens). */
  uninstall(id: string): void {
    const spec = this.get(id);
    const cmd = spec && uninstallCommand(spec);
    if (!spec || !cmd) throw new Error(L('此供應商沒有可用的解除安裝指令', 'This provider has no uninstall command'));
    const start = L(`正在解除安裝 ${spec.name}：${cmd}`, `Uninstalling ${spec.name}: ${cmd}`);
    const ok = L('✓ 已解除安裝，可以關閉這個視窗。登入資料與設定沒有刪除。', '✓ Uninstalled; you can close this window. Sign-in data and settings were kept.');
    const fail = L('✗ 解除安裝失敗，請看上面的錯誤訊息。', '✗ Uninstall failed; see the error above.');
    const e = (t: string) => t.replace(/[&|<>^%!"()\r\n]/g, ' ');
    const raw = process.platform === 'win32' ? `echo ${e(start)} & echo. & ${cmd} && (echo. & echo ${e(ok)}) || (echo. & echo ${e(fail)})` : `echo '${start}'; echo; if ${cmd}; then echo; echo '${ok}'; else echo; echo '${fail}'; fi`;
    this.terminal({ title: `${L('解除安裝', 'Uninstall')} ${spec.name}`, raw }, cmd);
    this.pollAuth(id);
  }

  install(id: string): void {
    const spec = this.get(id);
    const cmd = spec && installCommand(spec);
    if (!spec || !cmd) throw new Error(L('此供應商沒有設定安裝指令', 'This provider has no install command'));
    this.terminal({ title: `${L('安裝', 'Install')} ${spec.name}`, raw: installLine(spec.name, cmd) }, cmd);
    this.pollAuth(id);
  }

  /** After login/install we re-check every few seconds for a while so the UI flips by itself. */
  private pollAuth(id: string) {
    let n = 0;
    const initial = this.auth.get(id)?.state;
    const timer = setInterval(async () => {
      n++;
      const spec = this.get(id);
      const before = this.auth.get(id)?.state;
      const r = spec ? await this.evaluateAuth(spec).catch(() => undefined) : undefined;
      if (r) {
        this.auth.set(id, { ...r, checkedAt: Date.now() });
        if (r.state !== before) this.onChange();
      }
      if (n >= 60 || !spec || (r && r.state !== initial)) {
        clearInterval(timer);
        this.onChange();
      }
    }, 4000);
  }
}
