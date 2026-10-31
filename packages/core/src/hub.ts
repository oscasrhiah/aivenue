import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { AttachmentStore } from './attachments';
import type { ExtensionId, PonytailLevel } from './types';
import type { AppSettings, Attachment, CapabilitiesConfig, HostInfo, InstructionRole, McpServerConfig, ProviderSpec, PushMessage, RpcRequest, RpcResponse, WorkflowConfig, WorkflowPreset } from './types';
import { CapabilityStore } from './capabilities';
import { GithubService } from './github';
import { AntigravityQuota } from './antigravityQuota';
import { probeMcpServer } from './mcpProbe';
import { MCP_PRESETS } from './mcpPresets';
import { ExtensionService } from './extensions';
import { loadCatalog } from './catalog';
import { setLocale } from './i18n';
import { SettingsStore } from './settings';
import { UsageTracker } from './usage';
import { Orchestrator } from './orchestrator';
import { BUILTIN_PROVIDERS, PROVIDER_TEMPLATES } from './providers/builtin';
import { ProviderRegistry } from './providers/registry';
import { RunStore } from './store';
import { FileSecretStore, type SecretStore } from './secrets';

/** Set by scripts/build.mjs (esbuild define). */
declare const __AIVENUE_BUILD__: string | undefined;
declare const __AIVENUE_VERSION__: string | undefined;

export interface HostHooks {
  host: HostInfo['host'];
  defaultCwd?: () => string | undefined;
  pickFolder?: () => Promise<string | undefined>;
  pickFiles?: () => Promise<string[] | undefined>;
  openPath?: (p: string) => Promise<void> | void;
  /** Run an install / sign-in line in the host's own terminal (VS Code); without it a terminal window opens. */
  openTerminal?: (req: { title: string; cwd: string; line: string; env: Record<string, string> }) => void;
  openExternal?: (url: string) => Promise<void> | void;
}

export interface HubOptions {
  /** Directory with the built UI (index.html + assets). */
  uiDir: string;
  /** Path of the bundled MCP bridge script. */
  bridgePath: string;
  /** Folder with the bundled extension skills (default: "bundled" next to the bridge script). */
  bundledDir?: string;
  dataDir?: string;
  port?: number;
  hooks: HostHooks;
  version?: string;
  /** OS-backed secret storage for API keys; defaults to a plain file store. */
  secrets?: SecretStore;
}

export interface Hub {
  url: string;
  /** URL that opens the UI with the access token. */
  uiUrl: string;
  token: string;
  port: number;
  orchestrator: Orchestrator;
  close(): Promise<void>;
}

const GITHUB_MCP_ID = 'github';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const isDir = (p: unknown) => {
  try {
    return typeof p === 'string' && path.isAbsolute(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Files the OS would execute when "opened". */
const RUNNABLE = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|msi|msp|scr|lnk|url|reg|jar|cpl|pif|application|appref-ms|sh|command|app)$/i;

/** Constant-time token check. */
const tokenOk = (given: string | null, token: string) => {
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function defaultDataDir(): string {
  if (process.env.AIVENUE_HOME) return process.env.AIVENUE_HOME;
  const dir = path.join(os.homedir(), '.aivenue');
  // The app used to be called AgentHub: carry its data folder over once.
  const legacy = path.join(os.homedir(), '.agenthub');
  if (!fs.existsSync(dir) && fs.existsSync(legacy)) {
    try {
      fs.renameSync(legacy, dir);
    } catch {
      fs.cpSync(legacy, dir, { recursive: true });
    }
  }
  return dir;
}

export async function startHub(opts: HubOptions): Promise<Hub> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  const token = randomBytes(24).toString('hex');
  const clients = new Set<WebSocket>();
  const push = (m: PushMessage) => {
    const msg = JSON.stringify({ push: m });
    for (const c of clients) if (c.readyState === c.OPEN) c.send(msg);
  };

  const settings = new SettingsStore(dataDir);
  setLocale(settings.get().locale);
  const secrets = opts.secrets ?? new FileSecretStore(dataDir);
  const registry = new ProviderRegistry(dataDir, secrets, () => push({ topic: 'providers', data: registry.list() }));
  registry.terminalHook = opts.hooks.openTerminal;
  await registry.ready;
  const pushUsage = (refresh?: boolean) =>
    usage
      .summary(registry.specs(), { refresh })
      .then((data) => push({ topic: 'usage', data }))
      .catch(() => undefined);
  const usage = new UsageTracker(dataDir, () => void pushUsage());
  usage.antigravity = new AntigravityQuota(secrets, () => void pushUsage(true));
  // Official quotas change even when nothing runs here (other devices, the CLI itself): re-read every 5 minutes.
  const usageTimer = setInterval(() => void pushUsage(true), 5 * 60 * 1000);
  usageTimer.unref();
  // A first reading, so auto assignment knows current quotas right away.
  void pushUsage(true);
  registry.catalogLoader = () => loadCatalog(dataDir);
  const capabilities = new CapabilityStore(dataDir, secrets);
  const capsState = () => ({ config: capabilities.get(), skills: capabilities.listSkills() });
  const capsChanged = () => {
    const data = capsState();
    push({ topic: 'capabilities', data });
    return data;
  };
  // GitHub: the CLI's browser sign-in serves git push, `gh` and the GitHub MCP server alike.
  const github = new GithubService(registry, (data) => push({ topic: 'github', data }));
  usage.githubToken = () => github.getToken();
  capabilities.ghToken = () => github.getToken();
  void github.check().catch(() => undefined);
  const githubMcpOn = () => capabilities.get().mcpServers.some((s) => s.id === GITHUB_MCP_ID && s.enabled);
  const store = new RunStore(dataDir);
  const attachments = new AttachmentStore(dataDir);
  // Built-in extensions (Ponytail, Agent Skills, Graphify, OmniRoute): off until the user turns them on.
  const extensions = new ExtensionService({ dataDir, bundledDir: opts.bundledDir ?? path.join(path.dirname(opts.bridgePath), 'bundled'), capabilities, registry, secrets, onChange: (data) => push({ topic: 'extensions', data }) });
  void extensions.init().catch(() => undefined);
  let baseUrl = '';
  const orchestrator = new Orchestrator({
    registry,
    store,
    usage,
    capabilities,
    attachments,
    dataDir,
    bridgePath: opts.bridgePath,
    hubUrl: () => baseUrl,
    push,
    github: () => github.promptInfo(githubMcpOn()),
    servedBy: (provider, model, from, to) => (provider === 'omniroute' ? extensions.servedBy(model ?? registry.defaults(provider).model, from, to) : Promise.resolve(undefined)),
  });
  // Settings → General: how long kept CLIs stay idle after their workflow ended.
  orchestrator.setCliIdleMinutes(settings.get().cliIdleMinutes ?? 5);
  // Workflows an update or a restart cut off go on by themselves (Settings → General can turn it off).
  if (settings.get().autoResume !== false) setTimeout(() => orchestrator.autoResume(), 3000);
  void registry.checkAll();

  const methods: Record<string, (p: any) => unknown> = {
    'host.info': (): HostInfo => ({
      host: opts.hooks.host,
      defaultCwd: opts.hooks.defaultCwd?.(),
      dataDir,
      version: opts.version ?? (typeof __AIVENUE_VERSION__ === 'string' ? __AIVENUE_VERSION__ : '0.1.0'),
      build: typeof __AIVENUE_BUILD__ === 'string' ? __AIVENUE_BUILD__ : 'dev',
      canPickFolder: !!opts.hooks.pickFolder,
      canPickFiles: !!opts.hooks.pickFiles,
      secureSecrets: registry.secureSecrets,
    }),
    'host.pickFolder': () => opts.hooks.pickFolder?.(),
    // Folders only: on the desktop, opening a file path would run it if it is a program or script.
    'host.openPath': (p: { path: string }) => {
      if (!isDir(p.path)) throw new Error('only folders can be opened');
      return opts.hooks.openPath?.(p.path);
    },
    'host.openExternal': (p: { url: string }) => {
      if (!/^https?:\/\//.test(p.url)) throw new Error('only http(s) links can be opened');
      return opts.hooks.openExternal?.(p.url);
    },
    'settings.get': () => settings.get(),
    'settings.set': (p: { patch: Partial<AppSettings> }) => {
      const v = settings.set(p.patch);
      setLocale(v.locale);
      if (p.patch.cliIdleMinutes !== undefined) orchestrator.setCliIdleMinutes(v.cliIdleMinutes ?? 5);
      push({ topic: 'settings', data: v });
      if (p.patch.locale) void registry.checkAll();
      return v;
    },
    'usage.get': (p?: { refresh?: boolean }) => usage.summary(registry.specs(), { refresh: p?.refresh }),
    // Antigravity's quota needs a Google sign-in of its own (the CLI's stays in the OS keyring).
    'quota.antigravity.status': () => usage.antigravity!.status(),
    'quota.antigravity.connect': () => usage.antigravity!.connect(opts.hooks.openExternal),
    'quota.antigravity.disconnect': async () => {
      await usage.antigravity!.disconnect();
      void pushUsage(true);
    },
    'attachments.upload': (p: { name: string; mime: string; data: string }) => attachments.saveUpload(p.name, p.mime, p.data),
    'attachments.pick': async () => {
      const files = await opts.hooks.pickFiles?.();
      return files?.length ? attachments.importFiles(files) : [];
    },
    'attachments.discard': (p: { attachment: Attachment }) => attachments.discard(p.attachment),
    'files.read': (p: { path: string }) => orchestrator.readOutput(p.path),
    'files.open': (p: { path: string; reveal?: boolean }) => {
      if (!orchestrator.isOutputFile(p.path)) throw new Error('not an output of any run');
      // Programs and scripts an agent wrote are shown in their folder, never run by a click.
      const runnable = opts.hooks.host === 'desktop' && RUNNABLE.test(p.path);
      return opts.hooks.openPath?.(p.reveal || runnable ? path.dirname(p.path) : p.path);
    },
    'capabilities.get': () => capsState(),
    'capabilities.saveServer': async (p: { server: McpServerConfig; secrets?: Record<string, string> }) => {
      await capabilities.saveServer(p.server, p.secrets);
      return capsChanged();
    },
    'capabilities.deleteServer': async (p: { id: string }) => {
      await capabilities.deleteServer(p.id);
      return capsChanged();
    },
    'capabilities.testServer': async (p: { id: string }) => probeMcpServer(await capabilities.resolveServer(p.id)),
    'extensions.list': () => extensions.list(),
    'extensions.setEnabled': (p: { id: ExtensionId; enabled: boolean }) => extensions.setEnabled(p.id, !!p.enabled),
    'extensions.setOptions': (p: { id: ExtensionId; level?: PonytailLevel; skill?: string; on?: boolean }) => extensions.setOptions(p),
    'extensions.retry': (p: { id: ExtensionId }) => extensions.retry(p.id),
    'extensions.refresh': () => extensions.refreshOmni(true),
    'extensions.omniPassword': () => extensions.omniPassword(),
    'extensions.omniCandidates': (p: { model: string }) => extensions.omniCandidates(p.model),
    'extensions.omniPin': (p: { model: string }) => extensions.omniPin(p.model),
    'extensions.omniConnect': (p: { provider: string; apiKey: string }) => extensions.omniConnect(p),
    'extensions.omniDisconnect': (p: { id: string }) => extensions.omniDisconnect(p.id),
    'extensions.omniTest': (p: { id: string }) => extensions.omniTest(p.id),
    'capabilities.presets': () => MCP_PRESETS.map(({ id, name, zh, en, docsUrl }) => ({ id, name, zh, en, docsUrl })),
    'capabilities.addPreset': async (p: { id: string; headed?: boolean }) => {
      const preset = MCP_PRESETS.find((x) => x.id === p.id);
      if (!preset) throw new Error(`unknown preset ${p.id}`);
      await capabilities.saveServer(preset.build({ headed: !!p.headed }));
      return capsChanged();
    },
    'github.status': (p?: { refresh?: boolean }) => (p?.refresh ? github.check() : github.status()),
    'github.install': () => github.install(),
    'github.login': () => github.login(),
    'github.logout': () => github.logout(),
    // GitHub's official MCP server, authorized with the GitHub CLI's sign-in (read when an agent starts).
    'github.enableMcp': async (p: { write?: boolean }) => {
      if (!github.status().auth.loggedIn) throw new Error('Sign in to GitHub first');
      await capabilities.saveServer({
        id: GITHUB_MCP_ID,
        name: 'GitHub',
        enabled: true,
        transport: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: { Authorization: { ghToken: true, prefix: 'Bearer ' }, ...(p?.write ? {} : { 'X-MCP-Readonly': 'true' }) },
        description: p?.write ? 'GitHub (read and write; agents ask you before external actions)' : 'GitHub (read-only)',
      });
      return capsChanged();
    },
    'capabilities.setInstructions': (p: { instructions: CapabilitiesConfig['instructions'] }) => {
      capabilities.setInstructions(p.instructions);
      return capsChanged();
    },
    'skills.read': (p: { name: string }) => capabilities.readSkill(p.name),
    'skills.save': (p: { name: string; content: string }) => {
      capabilities.saveSkill(p.name, p.content);
      return capsChanged();
    },
    'skills.delete': (p: { name: string }) => {
      capabilities.deleteSkill(p.name);
      return capsChanged();
    },
    'skills.set': (p: { name: string; enabled?: boolean; roles?: InstructionRole[] }) => {
      capabilities.setSkill(p.name, { enabled: p.enabled, roles: p.roles });
      return capsChanged();
    },
    'skills.import': async () => {
      const folder = await opts.hooks.pickFolder?.();
      if (!folder) return null;
      const name = capabilities.importSkill(folder);
      capsChanged();
      return name;
    },
    'skills.openFolder': (p: { name?: string }) => {
      if (p.name && !/^[\w.-]+$/.test(p.name)) throw new Error('invalid skill name');
      return opts.hooks.openPath?.(p.name ? path.join(capabilities.skillsDir, p.name) : capabilities.skillsDir);
    },
    'providers.list': () => registry.list(),
    'providers.templates': () => ({ templates: PROVIDER_TEMPLATES, builtins: BUILTIN_PROVIDERS }),
    // Re-check = everything: sign-in, the model lists (read again from the CLIs) and, for the whole page, usage and live quotas.
    'providers.refresh': async (p: { id?: string }) => {
      if (p?.id) {
        registry.forgetModels(p.id);
        await registry.checkAuth(p.id);
      } else {
        for (const s of registry.specs()) registry.forgetModels(s.id);
        await Promise.all([registry.checkAll(), usage.summary(registry.specs(), { refresh: true }).catch(() => undefined)]);
      }
      return registry.list();
    },
    'providers.login': (p: { id: string; option?: string }) => registry.login(p.id, p.option),
    'providers.logout': (p: { id: string }) => registry.logout(p.id),
    'providers.install': (p: { id: string }) => registry.install(p.id),
    'providers.uninstall': (p: { id: string }) => registry.uninstall(p.id),
    'providers.save': (p: { spec: ProviderSpec }) => {
      registry.upsert(p.spec);
      void registry.checkAuth(p.spec.id);
      return registry.list();
    },
    'providers.delete': (p: { id: string }) => registry.remove(p.id),
    'providers.setOrder': (p: { ids: string[] }) => registry.setOrder(p.ids),
    'providers.addAccount': (p: { id: string; name: string }) => registry.addAccount(p.id, p.name),
    'providers.removeAccount': (p: { id: string; deleteData?: boolean }) => registry.removeAccount(p.id, !!p.deleteData),
    'providers.reset': (p: { id: string }) => {
      registry.reset(p.id);
      void registry.checkAuth(p.id);
    },
    'providers.test': (p: { id: string }) => orchestrator.testProvider(p.id),
    'providers.setAuthMode': (p: { id: string; mode: 'subscription' | 'api'; baseUrl?: string }) => registry.setAuthMode(p.id, p.mode, p.baseUrl),
    'providers.setApiKey': (p: { id: string; key?: string }) => registry.setApiKey(p.id, p.key),
    // A failed read must not empty the menus (the registry falls back; this only guards an unexpected error).
    'providers.models': (p: { id: string; refresh?: boolean }) =>
      registry.listModels(p.id, p.refresh).catch((e) => {
        console.warn(`[models] ${p.id}: ${(e as Error).message}`);
        return (registry.get(p.id)?.models ?? []).map((id) => ({ id }));
      }),
    'catalog.list': (p: { refresh?: boolean }) => loadCatalog(dataDir, p?.refresh),
    'catalog.add': async (p: { providerId?: string; key?: string; model?: string; extraEnv?: Record<string, string>; custom?: { name: string; baseURL: string; model: string } }) => {
      const cp = p.providerId ? (await loadCatalog(dataDir)).find((x) => x.id === p.providerId) : undefined;
      return registry.addFromCatalog(cp, p);
    },
    'providers.setDefaults': (p: { id: string; model?: string; effort?: string }) => registry.setDefaults(p.id, p.model, p.effort),
    'presets.list': () => store.loadPresets(),
    'presets.save': (p: { preset: WorkflowPreset }) => {
      const list = store.loadPresets().filter((x) => x.id !== p.preset.id);
      list.push(p.preset);
      store.savePresets(list);
      return list;
    },
    'presets.delete': (p: { id: string }) => {
      const list = store.loadPresets().filter((x) => x.id !== p.id);
      store.savePresets(list);
      return list;
    },
    'assign.preview': (p: { config: Pick<WorkflowConfig, 'assignment' | 'attachments'> }) => orchestrator.autoAssignment(p.config),
    'workflows.list': () => orchestrator.summaries(),
    'workflows.get': (p: { id: string }) => orchestrator.runs.get(p.id) ?? null,
    'workflows.start': (p: { config: WorkflowConfig }) => orchestrator.start(p.config).id,
    'workflows.cancel': (p: { id: string }) => orchestrator.cancel(p.id),
    'workflows.pause': (p: { id: string }) => orchestrator.pause(p.id),
    'workflows.resume': (p: { id: string; note?: string }) => orchestrator.resume(p.id, p.note),
    'workflows.resumeInterrupted': (p: { id: string }) => orchestrator.resumeInterrupted(p.id),
    'workflows.say': (p: { id: string; text: string; attachments?: Attachment[] }) => orchestrator.interject(p.id, p.text ?? '', p.attachments ?? []),
    'workflows.continueDenied': (p: { id: string; deniedId: string }) => orchestrator.continueDenied(p.id, p.deniedId),
    'workflows.edit': (p: { id: string; goal: string; config?: WorkflowConfig }) => orchestrator.editAndResend(p.id, p.goal, p.config),
    'workflows.updateConfig': (p: { id: string; patch: Parameters<Orchestrator['updateConfig']>[1]; restart?: boolean }) => {
      orchestrator.updateConfig(p.id, p.patch, !!p.restart);
      return true;
    },
    'workflows.compactShared': (p: { id: string }) => (orchestrator.compactSharedNow(p.id), true),
    'workflows.organizeShared': async (p: { id: string }) => (await orchestrator.organizeSharedNow(p.id), true),
    'workflows.compactAgent': (p: { id: string; agentId: string }) => (orchestrator.compactAgentNow(p.id, p.agentId), true),
    'workflows.contextAsk': (p: { id: string; action: 'compact' | 'later' | 'mute' }) => (orchestrator.answerContextAsk(p.id, p.action), true),
    'workflows.compactFailed': (p: { id: string; pick?: { provider: string; model?: string; effort?: string } }) => (orchestrator.answerCompactFailed(p.id, p.pick), true),
    'workflows.decide': (p: { id: string; decisionId: string; optionId: string; text?: string }) => orchestrator.decide(p.id, p.decisionId, p.optionId, p.text),
    'workflows.approve': (p: { id: string; approvalId: string; decision: 'allow' | 'always' | 'deny'; message?: string }) => orchestrator.approve(p.id, p.approvalId, p.decision, p.message),
    'workflows.worktree': (p: { id: string; action: 'apply' | 'discard' | 'keep' }) => orchestrator.worktreeAction(p.id, p.action),
    'workflows.delete': (p: { id: string }) => orchestrator.delete(p.id),
    'agents.events': (p: { workflowId: string; agentId: string }) => orchestrator.events(p.workflowId, p.agentId),
    'agents.stop': (p: { workflowId: string; agentId: string }) => (orchestrator.stopAgent(p.workflowId, p.agentId), true),
    'agents.close': (p: { workflowId: string; agentId: string }) => (orchestrator.closeAgent(p.workflowId, p.agentId), true),
    'agents.rerun': (p: { workflowId: string; agentId: string; provider?: string }) => orchestrator.rerunAgent(p.workflowId, p.agentId, p.provider),
    'agents.switchTargets': (p: { workflowId: string; agentId: string }) => orchestrator.switchTargets(p.workflowId, p.agentId),
    'workflows.search': (p: { id: string; query: Parameters<Orchestrator['search']>[1] }) => orchestrator.search(p.id, p.query ?? {}),
    'workflows.preflight': (p: { config: WorkflowConfig }) => orchestrator.preflight(p.config),
    'workflows.export': (p: { id: string; mask?: boolean }) => orchestrator.exportRun(p.id, p.mask !== false),
    'workflows.distilSkill': (p: { id: string }) => orchestrator.distilSkill(p.id),
    'resources.gpus': () => orchestrator.gpus(),
    'resources.gpuDetail': () => orchestrator.gpuDetail(),
    'processes.inspect': (p: { workflowId: string; pid: number }) => orchestrator.inspectProcess(p.workflowId, p.pid),
    'workflows.sharedContext': (p: { id: string }) => orchestrator.sharedContext(p.id),
  };

  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 5_000_000) reject(new Error('body too large'));
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });

  const json = (res: http.ServerResponse, code: number, data: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // MCP bridge API (authenticated by the per-agent session secret)
    if (url.pathname.startsWith('/bridge/')) {
      const secret = String(req.headers['x-aivenue-session'] ?? '');
      try {
        if (url.pathname === '/bridge/tools' && req.method === 'GET') return json(res, 200, { tools: orchestrator.toolsFor(secret) });
        if (url.pathname === '/bridge/servers' && req.method === 'GET') return json(res, 200, { servers: orchestrator.proxyServersFor(secret) });
        if (url.pathname === '/bridge/call' && req.method === 'POST') {
          const body = JSON.parse(await readBody(req));
          const text = await orchestrator.callTool(secret, String(body.name), body.arguments ?? {});
          return json(res, 200, { text });
        }
        return json(res, 404, { error: 'not found' });
      } catch (e) {
        return json(res, 200, { error: (e as Error).message });
      }
    }
    // Attachment files (thumbnails / downloads). Same token as the UI socket.
    if (url.pathname === '/file') {
      const p = url.searchParams.get('path') ?? '';
      if (!tokenOk(url.searchParams.get('token'), token) || !(attachments.servable(p) || orchestrator.isOutputFile(p))) {
        res.writeHead(403);
        return res.end();
      }
      return fs.readFile(p, (err, data) => {
        if (err) {
          res.writeHead(404);
          return res.end();
        }
        const ext = path.extname(p).toLowerCase();
        const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' }[ext];
        // Only images render inline; everything else downloads (never served as active content).
        res.writeHead(200, { 'content-type': type ?? 'application/octet-stream', 'content-disposition': type ? 'inline' : `attachment; filename="${encodeURIComponent(path.basename(p))}"`, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=3600' });
        res.end(data);
      });
    }
    // Static UI. Only the shell knows the token, which the page needs to open the socket.
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const root = path.resolve(opts.uiDir);
    const file = path.resolve(root, '.' + path.posix.normalize(rel));
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('not found');
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        // Even if agent text ever got rendered as HTML, it could not run scripts or send data elsewhere.
        'content-security-policy': [
          `default-src 'self'`,
          `script-src 'self'`,
          `style-src 'self' 'unsafe-inline'`,
          `img-src 'self' data: blob:`,
          `connect-src 'self' ws://127.0.0.1:${port} http://127.0.0.1:${port}`,
          `object-src 'none'`,
          `base-uri 'none'`,
          `form-action 'none'`,
          `frame-ancestors 'none'`,
        ].join('; '),
      });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/ws' || !tokenOk(url.searchParams.get('token'), token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('message', async (raw) => {
      let req: RpcRequest;
      try {
        req = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const reply = (r: RpcResponse) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(r));
      const fn = methods[req.method];
      if (!fn) return reply({ id: req.id, error: `unknown method: ${req.method}` });
      try {
        const result = await fn(req.params ?? {});
        reply({ id: req.id, result: result ?? null });
      } catch (e) {
        reply({ id: req.id, error: (e as Error).message });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;

  return {
    url: baseUrl,
    uiUrl: `${baseUrl}/?token=${token}`,
    token,
    port,
    orchestrator,
    close: () =>
      new Promise((resolve) => {
        // Stop agent processes so no CLI keeps running after the app exits; the workflows stay resumable.
        orchestrator.suspendAll();
        clearInterval(usageTimer);
        orchestrator.shutdown();
        extensions.shutdown();
        for (const c of clients) c.close();
        wss.close();
        server.close(() => resolve());
      }),
  };
}
