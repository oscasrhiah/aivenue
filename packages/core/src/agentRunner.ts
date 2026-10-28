import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { AgentEvent, ArgGroup, ModeKey, PermissionLevel, ProviderSpec } from './types';
import { capture, childEnv, killTree, resolveCommand, spawnResolved, specCommand, takesEffort } from './proc';
import { createParser, type EventDraft } from './providers/parsers';
import { L } from './i18n';
import type { ResolvedMcpServer } from './capabilities';
import type { CliPool, PooledCli } from './cliPool';

export interface BridgeLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface RunAgentOptions {
  spec: ProviderSpec;
  prompt: string;
  cwd: string;
  mode: 'write' | 'readonly';
  model?: string;
  /** Reasoning effort ({effort}). */
  effort?: string;
  resumeSessionId?: string;
  /** How to launch the Aivenue MCP bridge for this agent (omit to run without hub tools). */
  bridge?: BridgeLaunch;
  tmpDir: string;
  onEvent: (e: AgentEvent, isUpdate: boolean) => void;
  signal: AbortSignal;
  /** Continue event numbering (when one agent node spans several CLI invocations). */
  seqStart?: number;
  /** API-key mode: extra environment / args / settings for this run. */
  auth?: { env: Record<string, string>; args: ArgGroup[]; settingsExtra?: Record<string, unknown> };
  /** Shared MCP servers configured in Aivenue. */
  mcpServers?: ResolvedMcpServer[];
  /** User's instructions for this role. */
  systemPrompt?: string;
  /** Skills library folder, made readable for CLIs that confine file access ({skillsDir}). */
  skillsDir?: string;
  /** Folder with the run's attachments ({attachDir}). */
  attachDir?: string;
  /** Folders outside `cwd` the agent may read (spec.run.extraDir / extraDirEnv). */
  extraDirs?: string[];
  /** Attached images for CLIs with native image input (spec.run.images). */
  images?: string[];
  /** The user's permission level (default "auto"). */
  permission?: PermissionLevel;
  /**
   * Keep the CLI running after the turn (only for specs with run.persistent). `secret` is this turn's bridge
   * session; `onReuse` is called with the session of an already-running process when one is reused,
   * `onClose` when a kept process finally closes.
   */
  keepAlive?: { pool: CliPool; secret: string; onReuse: (secret: string) => void; onClose: (secret: string) => void; /** The workflow using it (kept while it runs). */ owner?: string };
  /** A text-only call (the context compactor): no built-in tools, where the CLI can turn them off (spec.run.noTools). */
  noTools?: boolean;
  /** The CLI's own advisor model ({advisorModel}, spec.run.advisor), e.g. Claude Code's --advisor. */
  advisorModel?: string;
}

/** Mode used for a permission level; reviewers ("readonly") never get more than the level allows. */
export function modeKeyFor(level: PermissionLevel | undefined, mode: 'write' | 'readonly'): ModeKey {
  if (level === 'plan') return 'plan';
  if (level === 'ask') return 'ask';
  // Planners and reviewers must not edit; at this level they don't run commands either.
  if (level === 'edit') return mode === 'readonly' ? 'plan' : 'edit';
  // Read-only roles (planners, reviewers, advisors) stay read-only with whole-computer access too.
  if (level === 'full') return mode === 'readonly' ? 'readonly' : 'full';
  return mode === 'readonly' ? 'readonly' : 'write';
}

const FALLBACK: Record<ModeKey, ModeKey[]> = {
  plan: ['plan', 'readonly', 'write'],
  ask: ['ask', 'edit', 'write'],
  edit: ['edit', 'write'],
  readonly: ['readonly', 'write'],
  write: ['write'],
  full: ['full', 'write'],
};

function pickMode<T>(table: Partial<Record<ModeKey, T>> | undefined, key: ModeKey): T | undefined {
  for (const k of FALLBACK[key]) if (table?.[k] !== undefined) return table[k];
  return undefined;
}

export interface RunAgentResult {
  lastSeq: number;
  exitCode: number | null;
  sessionId?: string;
  resumed: boolean;
  finalText: string;
  error?: string;
  /** The CLI is still running for later turns (its bridge session must stay valid). */
  keptAlive?: boolean;
}

export function renderGroups(groups: ArgGroup[] | undefined, tokens: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const g of groups ?? []) {
    let ok = true;
    const rendered = g.map((a) =>
      a.replace(/\{(\w+)\}/g, (m, k: string) => {
        if (!(k in tokens)) return m;
        const v = tokens[k];
        if (v === undefined || v === '') ok = false;
        return v ?? '';
      }),
    );
    if (ok) out.push(...rendered);
  }
  return out;
}

const tomlString = (s: string) => JSON.stringify(s);

/** Two env values that are JSON objects (e.g. OPENCODE_PERMISSION) are merged; otherwise the new one wins. */
function mergeJsonEnv(current: string | undefined, add: string): string {
  try {
    const a = current ? JSON.parse(current) : {};
    const b = JSON.parse(add);
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) return JSON.stringify({ ...a, ...b });
  } catch {
    // not JSON
  }
  return add;
}

/**
 * Keep an "aivenue" stdio entry in a CLI's own MCP config file ({"mcpServers": {...}}).
 * Only that entry is touched; the file is rewritten only when the entry changed.
 */
export function ensureRegistration(file: string, entry: { command: string; args: string[] }) {
  const p = file.startsWith('~') ? path.join(os.homedir(), file.slice(1)) : file;
  let json: Record<string, any> = {};
  try {
    const text = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
    // CLIs may create an empty file before any server is configured.
    json = text.trim() ? JSON.parse(text) : {};
  } catch (e) {
    // Missing file is fine; never overwrite a file we could not parse.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot update ${p}: ${(e as Error).message}`);
  }
  const want = { command: entry.command, args: entry.args };
  const cur = json.mcpServers?.aivenue;
  // Entry written under the app's former name.
  const legacy = json.mcpServers?.agenthub !== undefined;
  if (!legacy && cur && cur.command === want.command && JSON.stringify(cur.args) === JSON.stringify(want.args)) return;
  const { agenthub: _old, ...rest } = json.mcpServers ?? {};
  json.mcpServers = { ...rest, aivenue: { ...(cur ?? {}), ...want } };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(json, null, 2));
}

/**
 * Make sure a CLI's settings file allows the given permission rules (e.g. Antigravity's `mcp(aivenue/*)`),
 * so headless modes that cannot prompt still let the agent call Aivenue's tools.
 * Only missing rules are appended; the file is never rewritten when unparsable.
 */
export function ensurePermissionRules(file: string, allow: string[]) {
  const p = file.startsWith('~') ? path.join(os.homedir(), file.slice(1)) : file;
  let json: Record<string, any> = {};
  try {
    const text = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
    json = text.trim() ? JSON.parse(text) : {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot update ${p}: ${(e as Error).message}`);
  }
  const cur: string[] = Array.isArray(json.permissions?.allow) ? json.permissions.allow : [];
  const missing = allow.filter((r) => !cur.includes(r));
  if (!missing.length) return;
  json.permissions = { ...(json.permissions ?? {}), allow: [...cur, ...missing] };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(json, null, 2));
}

const helpCache = new Map<string, Promise<string>>();
/** Flags newer CLI versions added (OpenCode's --standalone): checked against --help even when not marked "?". */
const LATER_FLAGS = ['--standalone'];

/**
 * Flags written "?--flag" are only passed when the installed CLI knows them (its --help mentions them): older
 * versions of a CLI (e.g. OpenCode before --standalone) otherwise refuse to start.
 */
async function dropUnsupported(spec: ProviderSpec, raw: string[]): Promise<string[]> {
  // Providers saved before a flag became optional (OpenCode-based ones added from the catalog) carry it plainly.
  const args = raw.map((a) => (LATER_FLAGS.includes(a) ? `?${a}` : a));
  if (!args.some((a) => a.startsWith('?--'))) return args;
  const cmd = specCommand(spec);
  // Help of the subcommand used (e.g. "opencode run --help").
  const sub = (spec.run.fresh ?? []).flat().filter((a) => !a.startsWith('-') && !a.includes('{'));
  const key = `${resolveCommand(cmd)?.display ?? cmd} ${sub.join(' ')}`;
  if (!helpCache.has(key)) helpCache.set(key, capture(cmd, [...sub, '--help'], { timeoutMs: 20000 }).then((r) => r.stdout + r.stderr));
  const help = await helpCache.get(key)!;
  const out: string[] = [];
  for (const a of args) {
    if (!a.startsWith('?--')) out.push(a);
    else if (help.split(/[\s,=[\]]+/).includes(a.slice(1))) out.push(a.slice(1));
  }
  return out;
}

export async function runAgent(o: RunAgentOptions): Promise<RunAgentResult> {
  const { spec } = o;
  const resolved = resolveCommand(specCommand(spec));
  let seq = o.seqStart ?? 0;
  const events: AgentEvent[] = [];
  const emit = (d: EventDraft): number => {
    const e: AgentEvent = { ...d, seq: ++seq, ts: Date.now() };
    events.push(e);
    o.onEvent(e, false);
    return e.seq;
  };
  if (!resolved) {
    const error = L(`找不到 ${spec.name} 的執行檔「${spec.command}」，請先在「供應商」頁面安裝`, `Cannot find the ${spec.name} executable "${spec.command}". Install it on the Providers page first.`);
    emit({ kind: 'error', text: error });
    return { lastSeq: seq, exitCode: null, finalText: '', error, resumed: false };
  }

  const canResume = !!(o.resumeSessionId && spec.run.resume && spec.capabilities?.resume !== false);
  const tokens: Record<string, string | undefined> = {
    cwd: o.cwd,
    homeDir: os.homedir(),
    model: o.model,
    // Left out for models that refuse it (e.g. Claude through Antigravity), whatever was saved or assigned.
    effort: takesEffort(spec, o.model) ? o.effort : undefined,
    // "model#effort", for CLIs that pick the effort as a variant of the model (OpenCode).
    modelEffort: o.model && takesEffort(spec, o.model) && o.effort ? `${o.model}#${o.effort}` : o.model,
    sessionId: canResume ? o.resumeSessionId : undefined,
    newSessionId: canResume ? undefined : randomUUID(),
    prompt: spec.run.prompt === 'arg' ? o.prompt : undefined,
    mcpConfigFile: undefined,
    mcpCommandToml: undefined,
    mcpArgsToml: undefined,
    mcpEnvToml: undefined,
    systemPrompt: undefined,
    skillsDir: undefined,
    attachDir: undefined,
    mcpConfigJson: undefined,
    approvalTool: undefined,
    advisorModel: o.advisorModel,
  };

  // ---- MCP servers: the Aivenue bridge plus the user's shared servers ----
  const supportsMcp = spec.capabilities?.mcp !== false;
  const servers: ResolvedMcpServer[] = [];
  const secretProcessEnv: Record<string, string> = {};
  if (supportsMcp && o.bridge && spec.mcpRegistration) {
    // Static registration: the bridge inherits this run's session from the CLI's environment
    // and proxies the shared servers itself.
    ensureRegistration(spec.mcpRegistration.file, { command: o.bridge.command, args: o.bridge.args });
    if (spec.mcpRegistration.permissions) ensurePermissionRules(spec.mcpRegistration.permissions.file, spec.mcpRegistration.permissions.allow);
    Object.assign(secretProcessEnv, o.bridge.env, { AIVENUE_PROXY: '1' });
  } else {
    // With mcpFlags (Codex) the session secret goes through the environment, not the visible command line.
    if (supportsMcp && o.bridge) servers.push({ name: 'aivenue', transport: 'stdio', command: o.bridge.command, args: o.bridge.args, env: o.bridge.env, secretEnv: spec.mcpFlags ? Object.keys(o.bridge.env).filter((k) => k === 'AIVENUE_SESSION') : [], headers: {}, secretHeaders: [] });
    if (supportsMcp) servers.push(...(o.mcpServers ?? []));
  }

  let mcpFile: string | undefined;
  if (servers.length || o.auth?.settingsExtra) {
    fs.mkdirSync(o.tmpDir, { recursive: true });
    mcpFile = path.join(o.tmpDir, `mcp-${randomUUID()}.json`);
    const config: Record<string, unknown> = { ...(o.auth?.settingsExtra ?? {}) };
    if (servers.length && spec.mcpConfigFormat === 'opencode') {
      const entries: Record<string, unknown> = {};
      for (const s of servers) {
        entries[s.name] =
          s.transport === 'http'
            ? { type: 'remote', url: s.url, headers: s.headers, enabled: true }
            : { type: 'local', command: [s.command, ...(s.args ?? [])], environment: s.env, enabled: true };
      }
      config.mcp = entries;
    } else if (servers.length) {
      const entries: Record<string, unknown> = {};
      for (const s of servers) {
        const base =
          s.transport === 'http'
            ? spec.mcpHttpStyle === 'gemini'
              ? { httpUrl: s.url, headers: s.headers }
              : { type: 'http', url: s.url, headers: s.headers }
            : { command: s.command, args: s.args ?? [], env: s.env };
        entries[s.name] = { ...base, ...(spec.mcpServerExtra ?? {}) };
      }
      config.mcpServers = entries;
    }
    // Temp file with the run's MCP setup (may hold secrets); deleted when the run ends.
    fs.writeFileSync(mcpFile, JSON.stringify(config, null, 2), { mode: 0o600 });
    tokens.mcpConfigFile = mcpFile;
    tokens.mcpConfigJson = JSON.stringify(config);
  }

  const toml = {
    table: (o2: Record<string, string>) => `{${Object.entries(o2).map(([k, v]) => `${JSON.stringify(k)}=${tomlString(v)}`).join(',')}}`,
    list: (a: string[]) => `[${a.map(tomlString).join(',')}]`,
  };
  const serverTokens = (s: ResolvedMcpServer, index: number): Record<string, string | undefined> => {
    const plainEnv = Object.fromEntries(Object.entries(s.env).filter(([k]) => !s.secretEnv.includes(k)));
    const plainHeaders = Object.fromEntries(Object.entries(s.headers).filter(([k]) => !s.secretHeaders.includes(k)));
    // Secrets reach Codex through its own environment (env_vars / env_http_headers), never its command line.
    // CLIs configured through the temp file don't need them in their environment, where their shell could read them.
    if (spec.mcpFlags) for (const k of s.secretEnv) secretProcessEnv[k] = s.env[k];
    const envHeaders: Record<string, string> = {};
    s.secretHeaders.forEach((h, i) => {
      const v = `AIVENUE_MCP_H${index}_${i}`;
      if (spec.mcpFlags) secretProcessEnv[v] = s.headers[h];
      envHeaders[h] = v;
    });
    return {
      mcpName: s.name,
      mcpCommandToml: s.transport === 'stdio' && s.command ? tomlString(s.command) : undefined,
      mcpArgsToml: s.transport === 'stdio' ? toml.list(s.args ?? []) : undefined,
      mcpEnvToml: s.transport === 'stdio' && Object.keys(plainEnv).length ? toml.table(plainEnv) : undefined,
      mcpEnvVarsToml: s.secretEnv.length ? toml.list(s.secretEnv) : undefined,
      mcpUrlToml: s.transport === 'http' && s.url ? tomlString(s.url) : undefined,
      mcpHeadersToml: Object.keys(plainHeaders).length ? toml.table(plainHeaders) : undefined,
      mcpEnvHeadersToml: Object.keys(envHeaders).length ? toml.table(envHeaders) : undefined,
    };
  };
  const mcpArgs: string[] = [];
  servers.forEach((s, i) => {
    const st = serverTokens(s, i);
    if (spec.mcpFlags) mcpArgs.push(...renderGroups(spec.mcpFlags, { ...tokens, ...st }));
    // Legacy tokens (user specs written before mcpFlags existed) refer to the Aivenue bridge.
    if (s.name === 'aivenue') Object.assign(tokens, { mcpCommandToml: st.mcpCommandToml, mcpArgsToml: st.mcpArgsToml, mcpEnvToml: st.mcpEnvToml ?? '{}' });
  });

  // ---- role instructions & skills ----
  let prompt = o.prompt;
  const instructions = o.systemPrompt?.trim();
  if (instructions) {
    if (spec.run.systemPrompt?.length) tokens.systemPrompt = instructions;
    else prompt = `INSTRUCTIONS FROM THE USER (always follow these):\n${instructions}\n\n---\n\n${prompt}`;
  }
  tokens.skillsDir = o.skillsDir;
  tokens.attachDir = o.attachDir;
  const modeKey = modeKeyFor(o.permission, o.mode);
  // The approval tool only exists when the bridge is attached.
  tokens.approvalTool = modeKey === 'ask' && o.bridge && spec.capabilities?.mcp !== false ? 'mcp__aivenue__approval_prompt' : undefined;
  if (spec.run.prompt === 'arg') tokens.prompt = prompt;

  // Native image input only on a fresh session; a resumed one already has the images.
  const imageArgs = canResume ? [] : (o.images ?? []).flatMap((image) => renderGroups(spec.run.images, { ...tokens, image }));

  const extraDirs = o.extraDirs ?? [];
  const extraDirArgs = extraDirs.flatMap((extraDir) => renderGroups(spec.run.extraDir, { ...tokens, extraDir }));

  const rawArgs = [
    ...renderGroups(canResume ? spec.run.resume : spec.run.fresh, tokens),
    ...imageArgs,
    ...renderGroups(spec.run.systemPrompt, tokens),
    ...renderGroups(spec.run.common, tokens),
    ...extraDirArgs,
    ...renderGroups(spec.run.advisor, tokens),
    ...(o.noTools ? renderGroups(spec.run.noTools, tokens) : []),
    ...mcpArgs,
    ...renderGroups(pickMode(spec.modes, modeKey), tokens),
    ...renderGroups(o.auth?.args, tokens),
    ...renderGroups(spec.run.tail, tokens),
  ];
  const args = await dropUnsupported(spec, rawArgs);
  const extraEnv: Record<string, string> = { ...secretProcessEnv, ...(o.auth?.env ?? {}), ...(pickMode(spec.modeEnv, modeKey) ?? {}) };
  for (const [k, v] of Object.entries(spec.run.env ?? {})) {
    const r = renderGroups([[v]], tokens);
    if (r.length) extraEnv[k] = r[0];
  }
  if (extraDirs.length) for (const [k, v] of Object.entries(spec.run.extraDirEnv ?? {})) extraEnv[k] = mergeJsonEnv(extraEnv[k], v);

  // ---- keep-alive: CLIs that take one message per stdin line stay running between turns of a session ----
  const persistent = o.keepAlive && spec.run.persistent && spec.run.prompt === 'stdin' ? spec.run.persistent : undefined;
  const fingerprint = persistent
    ? JSON.stringify([spec.id, o.model ?? '', o.effort ?? '', modeKey, o.cwd, (o.mcpServers ?? []).map((s) => s.name).sort(), instructions ?? '', Object.keys(o.auth?.env ?? {}).sort(), !!o.bridge, o.advisorModel ?? '', extraDirs])
    : '';
  const pooled = persistent && canResume ? o.keepAlive!.pool.take(o.resumeSessionId!, fingerprint) : undefined;
  if (persistent && !pooled) args.push(...renderGroups(persistent.args, tokens));

  emit({ kind: 'prompt', text: instructions && tokens.systemPrompt ? `[--append-system-prompt]\n${instructions}\n\n---\n\n${prompt}` : prompt });
  emit({
    kind: 'info',
    text: pooled
      ? `↻ ${spec.command} ${L('（沿用執行中的 CLI，不重新啟動）', '(reusing the running CLI, no restart)')}`
      : `${canResume ? '↻' : '$'} ${spec.command} ${args.map((a) => (a.length > 60 ? a.slice(0, 57) + '…' : a)).join(' ')}`,
  });

  let turnEnded: (() => void) | undefined;
  const parser = createParser(spec.output, {
    emit: (d) => {
      const s = emit(d);
      // In keep-alive mode the process does not exit after a turn: its result event ends the turn.
      if (d.kind === 'result' || d.kind === 'error') turnEnded?.();
      return s;
    },
    updateTool(target, patch, files) {
      const e = events.find((x) => x.seq === target);
      if (!e?.tool) return;
      e.tool = { ...e.tool, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as AgentEvent['tool'];
      if (files?.length) e.files = files;
      o.onEvent(e, true);
    },
  }, o.cwd);

  if (persistent) {
    if (pooled && mcpFile) fs.rm(mcpFile, { force: true }, () => undefined);
    if (pooled) {
      o.keepAlive!.onReuse(pooled.secret);
      // A follow-up message (another workflow) now uses it.
      if (o.keepAlive!.owner) pooled.owner = o.keepAlive!.owner;
    }
    const keep = o.keepAlive!;
    const entry: PooledCli =
      pooled ??
      ({
        fingerprint,
        sessionId: '',
        child: spawnResolved(resolved, args, { cwd: o.cwd, env: childEnv(extraEnv), stdio: ['pipe', 'pipe', 'pipe'] }),
        secret: keep.secret,
        owner: keep.owner,
        busy: true,
        cleanup: () => {
          if (mcpFile) fs.rm(mcpFile, { force: true }, () => undefined);
          keep.onClose(keep.secret);
        },
      } satisfies PooledCli);
    if (!pooled) {
      // Lines go to whichever turn currently owns the process.
      readline.createInterface({ input: entry.child.stdout! }).on('line', (l) => entry.onLine?.(l));
      readline.createInterface({ input: entry.child.stderr! }).on('line', (l) => entry.onStderr?.(l));
      entry.child.on('close', (code) => entry.onExit?.(code));
      entry.child.on('error', (e) => {
        emit({ kind: 'error', text: L(`無法啟動：${e.message}`, `Failed to start: ${e.message}`) });
        entry.onExit?.(null);
      });
      entry.child.stdin?.on('error', () => undefined);
    }
    let stderrTail = '';
    entry.onLine = (l) => {
      try {
        parser.line(l);
      } catch (err) {
        emit({ kind: 'stderr', text: `[parser] ${(err as Error).message}: ${l.slice(0, 200)}` });
      }
    };
    entry.onStderr = (l) => {
      if (!l.trim()) return;
      stderrTail = (stderrTail + '\n' + l).slice(-4000);
      emit({ kind: 'stderr', text: l });
    };
    const outcome = await new Promise<{ exited: boolean; code: number | null }>((resolve) => {
      let done = false;
      const fin = (v: { exited: boolean; code: number | null }) => {
        if (done) return;
        done = true;
        o.signal.removeEventListener('abort', onAbort);
        resolve(v);
      };
      const onAbort = () => killTree(entry.child);
      o.signal.addEventListener('abort', onAbort);
      turnEnded = () => setImmediate(() => fin({ exited: false, code: null }));
      entry.onExit = (code) => fin({ exited: true, code });
      entry.child.stdin?.write(persistent.stdinTemplate.replace('{promptJson}', () => JSON.stringify(prompt)) + '\n');
    });
    turnEnded = undefined;
    const sessionId = parser.sessionId ?? (canResume ? o.resumeSessionId : tokens.newSessionId);
    let error = parser.error;
    if (o.signal.aborted) error = L('已取消', 'Cancelled');
    else if (outcome.exited && outcome.code !== 0 && !error) error = `${L('結束代碼', 'Exit code')} ${outcome.code}${stderrTail ? `: ${stderrTail.trim().split('\n').slice(-3).join(' / ')}` : ''}`;
    const alive = !outcome.exited && entry.child.exitCode === null && !o.signal.aborted && !!sessionId;
    if (alive) {
      entry.sessionId = sessionId!;
      if (pooled) keep.pool.release(entry);
      else keep.pool.add(entry);
    } else if (pooled) keep.pool.close(entry);
    else {
      killTree(entry.child);
      entry.cleanup();
    }
    return { lastSeq: seq, exitCode: outcome.exited ? outcome.code : null, sessionId, resumed: canResume, finalText: parser.finalText(), error, keptAlive: alive };
  }

  const child = spawnResolved(resolved, args, { cwd: o.cwd, env: childEnv(extraEnv), stdio: ['pipe', 'pipe', 'pipe'] });
  const onAbort = () => killTree(child);
  o.signal.addEventListener('abort', onAbort);

  let stderrTail = '';
  const rlOut = readline.createInterface({ input: child.stdout! });
  rlOut.on('line', (l) => {
    try {
      parser.line(l);
    } catch (err) {
      emit({ kind: 'stderr', text: `[parser] ${(err as Error).message}: ${l.slice(0, 200)}` });
    }
  });
  const rlErr = readline.createInterface({ input: child.stderr! });
  rlErr.on('line', (l) => {
    if (!l.trim()) return;
    stderrTail = (stderrTail + '\n' + l).slice(-4000);
    emit({ kind: 'stderr', text: l });
  });

  child.stdin?.on('error', () => undefined);
  if (spec.run.prompt === 'stdin') child.stdin?.end(spec.run.stdinTemplate ? spec.run.stdinTemplate.replace('{promptJson}', () => JSON.stringify(prompt)) + '\n' : prompt);
  else child.stdin?.end();

  const exitCode = await new Promise<number | null>((resolve) => {
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      resolve(code);
    };
    child.on('error', (e) => {
      emit({ kind: 'error', text: L(`無法啟動：${e.message}`, `Failed to start: ${e.message}`) });
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
  await new Promise((r) => setImmediate(r));
  parser.end();
  o.signal.removeEventListener('abort', onAbort);
  if (mcpFile) fs.rm(mcpFile, { force: true }, () => undefined);

  let error = parser.error;
  if (o.signal.aborted) error = L('已取消', 'Cancelled');
  else if (exitCode !== 0 && !error) error = `${L('結束代碼', 'Exit code')} ${exitCode}${stderrTail ? `: ${stderrTail.trim().split('\n').slice(-3).join(' / ')}` : ''}`;
  const presetSession = canResume ? o.resumeSessionId : JSON.stringify(spec.run.fresh ?? []).includes('{newSessionId}') ? tokens.newSessionId : undefined;
  return { lastSeq: seq, exitCode, sessionId: parser.sessionId ?? presetSession, resumed: canResume, finalText: parser.finalText(), error };
}
