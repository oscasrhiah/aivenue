import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { test } from './lib/test-shard.mjs';
import { build } from 'esbuild';

// The bundled Agent Skills and impeccable: the pinned upstream copies (packages/core/bundled/README.md), who each skill is
// offered to, and impeccable's install folder, environment and uninstall (no real npm or engine: proc.ts is stubbed).
const BUNDLED = path.join(process.cwd(), 'packages', 'core', 'bundled');
const bundled = await build({
  stdin: { contents: `export { ExtensionService, markRunnable, omniModelGone } from './packages/core/src/extensions'; export { impeccableEngine } from './packages/core/src/impeccable';`, resolveDir: process.cwd() },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent',
  plugins: [
    {
      name: 'no processes',
      setup(b) {
        b.onLoad({ filter: /[\\/]proc\.ts$/ }, () => ({
          // The impeccable engine answers its handshake when its file exists; every other command fails.
          contents: `import * as fs from 'node:fs';
            export async function capture(cmd, args) { return args && args[0] === 'engine-probe' && fs.existsSync(cmd) ? { code: 0, stdout: 'impeccable-engine 0.1.18', stderr: '' } : { code: 1, stdout: '', stderr: '' }; }
            export function refreshPathCache() {} export function childEnv() { return {}; } export function findNode() {}
            export function killTree() {} export function resolveCommand(c) { return { file: c, prefixArgs: [], display: c }; }
            export function spawnResolved() { throw new Error('no processes in this test'); }`,
        }));
      },
    },
  ],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const { ExtensionService } = mod.exports;

test('Agent Skills 是上游 222bf92 的版本：26 個 Skill，含 accessibility-engineering 與它連結的角色說明', () => {
  const dir = path.join(BUNDLED, 'agent-skills');
  const skills = fs.readdirSync(path.join(dir, 'skills')).filter((d) => fs.existsSync(path.join(dir, 'skills', d, 'SKILL.md'))).sort();
  assert.equal(skills.length, 26);
  assert.ok(skills.includes('accessibility-engineering'));
  for (const s of skills) assert.match(fs.readFileSync(path.join(dir, 'skills', s, 'SKILL.md'), 'utf8'), new RegExp(`^---\\r?\\nname: ${s}\\r?\\n`), s);
  assert.ok(fs.existsSync(path.join(dir, 'agents', 'accessibility-auditor.md')));
  assert.ok(fs.existsSync(path.join(dir, 'LICENSE')));
  assert.match(fs.readFileSync(path.join(BUNDLED, 'README.md'), 'utf8'), /agent-skills\/` \| https:\/\/github\.com\/addyosmani\/agent-skills \| `222bf920f0d3ac8ce9badf51cd7c60709050c1e0`/);
});

test('accessibility-engineering 交給實作者和程式碼審查者，預設開啟；問答型與 meta Skill 仍預設關閉', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-skills-'));
  const cfg = {};
  const caps = { skillsDir: path.join(data, 'skills'), get: () => ({ extensions: cfg }), setExtensions: (next) => Object.assign(cfg, next) };
  const s = new ExtensionService({ dataDir: data, bundledDir: BUNDLED, capabilities: caps, registry: {}, secrets: {}, onChange() {} });
  await s.setEnabled('agent-skills', true);
  const list = s.list().find((x) => x.id === 'agent-skills').skills;
  assert.equal(list.length, 26);
  const a11y = list.find((k) => k.name === 'accessibility-engineering');
  assert.deepEqual([...a11y.roles].sort(), ['code_reviewer', 'executor']);
  assert.equal(a11y.enabled, true);
  assert.match(a11y.description, /WCAG 2\.2 AA/);
  for (const off of ['interview-me', 'idea-refine', 'constraint-driven-development', 'using-agent-skills', 'context-engineering', 'doubt-driven-development']) assert.equal(list.find((k) => k.name === off).enabled, false, off);
  // Offered to the roles it is mapped to, and only those.
  assert.ok(caps.extraSkills('executor').some((k) => k.name === 'accessibility-engineering'));
  assert.ok(caps.extraSkills('code_reviewer').some((k) => k.name === 'accessibility-engineering'));
  assert.ok(!caps.extraSkills('planner').some((k) => k.name === 'accessibility-engineering'));
  fs.rmSync(data, { recursive: true, force: true });
});

const { impeccableEngine } = mod.exports;

test('impeccable 是上游 skill-v4.8.0 的 Skill 檔：啟動器、引擎版本、授權與換行', () => {
  const dir = path.join(BUNDLED, 'impeccable');
  const skill = path.join(dir, 'skills', 'impeccable');
  assert.match(fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8'), /^---\r?\nname: impeccable\r?\n[\s\S]*version: 4\.8\.0/);
  assert.equal(fs.readFileSync(path.join(skill, 'scripts', 'VERSION'), 'utf8').trim(), '0.1.18');
  assert.match(fs.readFileSync(path.join(skill, 'scripts', 'engine-checksums.txt'), 'utf8'), /^0\.1\.18 impeccable-windows-x64\.exe [0-9a-f]{64}$/m);
  // cmd.exe needs CRLF in the batch launcher; sh needs LF in the other one.
  const cmd = fs.readFileSync(path.join(skill, 'scripts', 'impeccable.cmd'), 'utf8');
  assert.ok(cmd.includes('\r\n') && !/[^\r]\n/.test(cmd), 'impeccable.cmd keeps CRLF');
  assert.ok(!fs.readFileSync(path.join(skill, 'scripts', 'impeccable'), 'utf8').includes('\r'), 'the sh launcher keeps LF');
  for (const f of ['LICENSE', 'NOTICE.md']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.match(fs.readFileSync(path.join(BUNDLED, 'README.md'), 'utf8'), /\| `impeccable\/` \| https:\/\/github\.com\/pbakaus\/impeccable .*\| `414603bf14c7a344edb466bb1f85690c77ce8b7d` \| Apache-2\.0/);
});

test('impeccable：預設關閉；裝好後交給實作者與程式碼審查者，指令帶關閉使用統計的環境，解除安裝只刪 Aivenue 的副本', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-impeccable-'));
  const cfg = {};
  const caps = { skillsDir: path.join(data, 'skills'), get: () => ({ extensions: cfg }), setExtensions: (next) => Object.assign(cfg, next) };
  const s = new ExtensionService({ dataDir: data, bundledDir: BUNDLED, capabilities: caps, registry: {}, secrets: {}, onChange() {} });
  const tools = path.join(data, 'tools', 'impeccable');
  const row = () => s.list().find((x) => x.id === 'impeccable');
  assert.equal(row().enabled, false);
  assert.equal(caps.extraEnv(), undefined);
  assert.ok(!caps.extraSkills('executor').some((k) => k.name === 'impeccable'));

  // What npm would have installed: the package and this platform's engine.
  const engine = impeccableEngine(path.join(data, 'tools'));
  assert.ok(engine.startsWith(path.join(tools, 'node_modules', '@impeccable') + path.sep), engine);
  fs.mkdirSync(path.dirname(engine), { recursive: true });
  fs.writeFileSync(engine, '');
  fs.mkdirSync(path.join(tools, 'node_modules', 'impeccable'), { recursive: true });
  fs.writeFileSync(path.join(tools, 'node_modules', 'impeccable', 'package.json'), JSON.stringify({ name: 'impeccable', version: '4.8.0' }));
  await s.setEnabled('impeccable', true);
  for (let i = 0; i < 50 && row().state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(row().state, 'ready');
  assert.equal(row().version, '4.8.0');
  assert.equal(row().installed, true);

  // The skill copy sits in Aivenue's skills folder, offered to the implementer and the code reviewer only, with the rule.
  const copy = path.join(caps.skillsDir, '.bundled', 'impeccable', 'skills', 'impeccable', 'SKILL.md');
  assert.ok(fs.existsSync(copy));
  for (const role of ['executor', 'code_reviewer']) {
    assert.deepEqual(caps.extraSkills(role).filter((k) => k.name === 'impeccable').map((k) => k.path), [copy], role);
    assert.match(caps.extraRules(role, data), /IMPECCABLE \(design skill\)[\s\S]*do not run live, generate, hooks, pin, install, component-review or build-phase[\s\S]*~\/\.impeccable\/component-reviews/);
  }
  for (const role of ['planner', 'plan_reviewer', 'subagent']) {
    assert.ok(!caps.extraSkills(role).some((k) => k.name === 'impeccable'), role);
    assert.doesNotMatch(caps.extraRules(role, data), /IMPECCABLE/, role);
  }

  // The agents' commands: Aivenue's engine, telemetry and update checks off, impeccable's own files in the tools folder.
  const env = caps.extraEnv();
  assert.equal(env.IMPECCABLE_BIN, engine);
  for (const k of ['DO_NOT_TRACK', 'IMPECCABLE_NO_TELEMETRY', 'IMPECCABLE_NO_UPDATE_CHECK', 'IMPECCABLE_NO_STALENESS_CHECK']) assert.equal(env[k], '1', k);
  for (const k of ['IMPECCABLE_HOME', 'IMPECCABLE_UPDATE_CACHE', 'IMPECCABLE_STALENESS_CACHE']) assert.ok(env[k].startsWith(tools + path.sep), k);
  assert.match(env.IMPECCABLE_SEED_SALT, /^[0-9a-f]{32}$/);
  const saved = JSON.parse(fs.readFileSync(path.join(tools, 'aivenue-settings.json'), 'utf8'));
  assert.equal(saved.telemetry, false);
  assert.equal(saved.seedSalt, env.IMPECCABLE_SEED_SALT, 'the salt is kept between runs');
  assert.equal(caps.extraEnv().IMPECCABLE_SEED_SALT, env.IMPECCABLE_SEED_SALT);

  // Off: nothing offered, no environment; the install stays until uninstalled.
  await s.setEnabled('impeccable', false);
  assert.equal(caps.extraEnv(), undefined);
  assert.ok(!caps.extraSkills('executor').some((k) => k.name === 'impeccable'));
  assert.equal(row().installed, true);
  const outside = path.join(data, 'project-file.txt');
  fs.writeFileSync(outside, 'mine');
  await s.uninstall('impeccable');
  assert.ok(!fs.existsSync(tools));
  assert.ok(!fs.existsSync(path.join(caps.skillsDir, '.bundled', 'impeccable')));
  assert.ok(fs.existsSync(outside));
  assert.equal(row().installed, false);
  assert.equal(row().enabled, false);
  fs.rmSync(data, { recursive: true, force: true });
});

test('開啟 impeccable 或 CodeGraph 時，安裝開始前顯示「準備安裝…」，不會閃過「尚未安裝」的錯誤', async () => {
  for (const id of ['impeccable', 'codegraph']) {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), `aivenue-${id}-`));
    const cfg = {};
    const seen = [];
    const caps = { skillsDir: path.join(data, 'skills'), get: () => ({ extensions: cfg }), setExtensions: (next) => Object.assign(cfg, next) };
    const s = new ExtensionService({ dataDir: data, bundledDir: BUNDLED, capabilities: caps, registry: {}, secrets: {}, onChange: (list) => seen.push(list.find((x) => x.id === id)) });
    const first = (await s.setEnabled(id, true)).find((x) => x.id === id);
    for (let i = 0; i < 50 && s.list().find((x) => x.id === id).state === 'working'; i++) await new Promise((r) => setTimeout(r, 10));
    const shown = seen.filter((x) => x.enabled);
    assert.ok(shown.length > 0, id);
    assert.equal(shown[0].state, 'working', `${id}: ${JSON.stringify(shown[0])}`);
    assert.equal(shown[0].message, '準備安裝…');
    assert.ok(['working', 'error'].includes(first.state), id);
    assert.ok(!shown.some((x) => /尚未安裝/.test(x.message ?? '')), `${id}: ${JSON.stringify(shown.map((x) => [x.state, x.message]))}`);
    // The stub has no Node.js: the install ends with its real error, not "not installed".
    assert.equal(s.list().find((x) => x.id === id).state, 'error');
    assert.match(s.list().find((x) => x.id === id).message, /Node\.js/);
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('複製到 Aivenue 的 Skill 資料夾後，scripts/ 底下以 #! 開頭的檔案設成可執行（Windows 不動，資料檔不動）', () => {
  const { markRunnable } = mod.exports;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-runnable-'));
  const put = (rel, text, mode = 0o644) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
    fs.chmodSync(path.join(dir, rel), mode);
  };
  put('impeccable/skills/impeccable/scripts/impeccable', '#!/bin/sh\necho hi\n');
  put('impeccable/skills/impeccable/scripts/impeccable.cmd', '@echo off\r\n');
  put('impeccable/skills/impeccable/scripts/data/font-index.json', '{}');
  put('impeccable/skills/impeccable/SKILL.md', '#!not a script outside scripts/\n');
  put('agent-skills/skills/accessibility-engineering/scripts/audit-a11y.sh', '#!/usr/bin/env bash\n');
  assert.deepEqual(markRunnable(dir, 'win32'), []);
  const done = markRunnable(dir, 'linux').map((p) => path.relative(dir, p).split(path.sep).join('/')).sort();
  assert.deepEqual(done, ['agent-skills/skills/accessibility-engineering/scripts/audit-a11y.sh', 'impeccable/skills/impeccable/scripts/impeccable']);
  if (process.platform !== 'win32') {
    const mode = (rel) => fs.statSync(path.join(dir, rel)).mode & 0o777;
    assert.equal(mode('impeccable/skills/impeccable/scripts/impeccable'), 0o755);
    assert.equal(mode('agent-skills/skills/accessibility-engineering/scripts/audit-a11y.sh'), 0o755);
    assert.equal(mode('impeccable/skills/impeccable/scripts/impeccable.cmd'), 0o644);
    assert.equal(mode('impeccable/skills/impeccable/scripts/data/font-index.json'), 0o644);
    assert.equal(mode('impeccable/skills/impeccable/SKILL.md'), 0o644);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Linux 套件的檔案權限：程式本體與內建 Skill 的 scripts/ 裡以 #! 開頭的檔案是 0755，其他是 0644', async () => {
  const { fileMode, EXEC } = await import('./lib/linux-modes.mjs');
  for (const n of EXEC) assert.equal(fileMode(n, Buffer.from('\x7fELF')), 0o755, n);
  assert.equal(fileMode('resources/aivenue', Buffer.from('#!')), 0o644, 'EXEC names count at the top of the package only');
  // Every file of the bundled skills, where the package puts them.
  const shebang = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const rel = 'resources/app.asar.unpacked/dist/bundled/' + path.relative(BUNDLED, p).split(path.sep).join('/');
        const head = fs.readFileSync(p).subarray(0, 2);
        const mode = fileMode(rel, head);
        const runnable = head.toString('latin1') === '#!' && rel.split('/').slice(4, -1).includes('scripts');
        assert.equal(mode, runnable ? 0o755 : 0o644, rel);
        if (runnable) shebang.push(rel.slice('resources/app.asar.unpacked/dist/bundled/'.length));
      }
    }
  };
  walk(BUNDLED);
  for (const want of ['impeccable/skills/impeccable/scripts/impeccable', 'agent-skills/skills/accessibility-engineering/scripts/audit-a11y.sh', 'agent-skills/skills/constraint-driven-development/scripts/quality-gate.mjs']) assert.ok(shebang.includes(want), want);
  assert.equal(fileMode('resources/app.asar.unpacked/dist/bundled/impeccable/skills/impeccable/scripts/impeccable.cmd', Buffer.from('@e')), 0o644);
});

test('OmniRoute：免費池的候選全是免登入來源時，選單不列這個池；有一個能用的候選就列；全部列出，免費的排前面並標出', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-omni-'));
  const cfg = { omniroute: { onlyChecked: false } };
  const caps = { skillsDir: path.join(data, 'skills'), get: () => ({ extensions: cfg }), setExtensions: (next) => Object.assign(cfg, next) };
  const s = new ExtensionService({ dataDir: data, bundledDir: BUNDLED, capabilities: caps, registry: { forgetModels() {}, checkAuth: async () => undefined }, secrets: {}, onChange() {} });
  const noauth = (model) => ({ provider: 'cloudflare-playground', connectionId: 'noauth', model, modelStr: model, excluded: false, reachable: true, breakerState: 'CLOSED' });
  // What the user's OmniRoute answered: only Antigravity connected, both free pools made of no-sign-in sources.
  const pools = { 'best-free': [noauth('cfp/zai-org/glm-5.2'), { ...noauth('unc/qwen'), provider: 'uncloseai' }], 'coding:free': [noauth('cfp/openai/gpt-oss-20b'), { provider: 'groq', connectionId: 'c1', model: 'groq/llama', modelStr: 'groq/llama', reachable: true, breakerState: 'CLOSED' }] };
  s.omniFetch = async (p) =>
    p.startsWith('/v1/models')
      ? { data: [{ id: 'auto/best-free', owned_by: 'combo' }, { id: 'auto/coding:free', owned_by: 'combo' }, { id: 'antigravity/gemini', owned_by: 'antigravity' }, { id: 'openrouter/qwen/qwen3-coder:free', owned_by: 'openrouter' }, { id: 'openrouter/anthropic/claude-x', owned_by: 'openrouter' }, { id: 'nvidia/moonshotai/kimi-k3', owned_by: 'nvidia' }, { id: 'auto/best', owned_by: 'combo' }] }
      : p === '/api/providers'
        ? { connections: [{ provider: 'antigravity', isActive: true }, { provider: 'openrouter', isActive: true }, { provider: 'nvidia', isActive: true }] }
        : p === '/api/free-models'
          ? { models: [{ provider: 'nvidia', modelId: 'moonshotai/kimi-k3', freeType: 'one-time-initial' }, { provider: 'openrouter', modelId: 'anthropic/claude-x', freeType: 'discontinued' }] }
          : { candidates: pools[p.split('/')[3]] ?? [] };
  s.syncOmniProvider = () => undefined;
  s.omni = { url: 'http://127.0.0.1:1', ready: true, connections: [], models: [], at: 0, candidates: new Set() };
  await s.refreshOmni(true);
  const ids = s.usableOmniModels().map((m) => m.id);
  assert.ok(!ids.includes('auto/best-free'), ids.join());
  assert.ok(ids.includes('auto/coding:free'), ids.join());
  assert.ok(ids.includes('antigravity/gemini'), ids.join());
  // Every model is listed, the free ones first and marked: a :free id, or a model in OmniRoute's free-tier catalog (a
  // discontinued entry does not count).
  const free = Object.fromEntries((await s.omniModels()).map((m) => [m.id, m.free]));
  assert.equal(free['omniroute/openrouter/qwen/qwen3-coder:free'], true);
  assert.equal(free['omniroute/nvidia/moonshotai/kimi-k3'], true);
  assert.equal(free['omniroute/openrouter/anthropic/claude-x'], false);
  assert.ok(ids.indexOf('openrouter/qwen/qwen3-coder:free') < ids.indexOf('openrouter/anthropic/claude-x'), ids.join());
});

test('OmniRoute 接 OpenRouter：開授權頁（PKCE＋state），回呼帶對的 state 才換金鑰並交給 OmniRoute；錯的 state 不換', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-or-'));
  const cfg = {};
  const caps = { skillsDir: path.join(data, 'skills'), get: () => ({ extensions: cfg }), setExtensions: (next) => Object.assign(cfg, next) };
  cfg.omniroute = { enabled: true };
  const opened = [];
  const s = new ExtensionService({ dataDir: data, bundledDir: BUNDLED, capabilities: caps, registry: {}, secrets: {}, onChange() {}, openExternal: (u) => opened.push(u) });
  s.omni = { url: 'http://127.0.0.1:1', ready: true, connections: [], models: [], at: Date.now(), candidates: new Set() };
  const connected = [];
  s.omniConnect = async (p) => (connected.push(p), []);
  const realFetch = globalThis.fetch;
  const exchanged = [];
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://openrouter.ai/api/v1/auth/keys') {
      exchanged.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ key: 'sk-or-test' }), { status: 200 });
    }
    return realFetch(url, init);
  };
  try {
    await s.omniOpenRouter();
    assert.equal(opened.length, 1);
    const auth = new URL(opened[0]);
    assert.equal(auth.origin + auth.pathname, 'https://openrouter.ai/auth');
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    const cb = new URL(auth.searchParams.get('callback_url'));
    assert.equal(cb.hostname, 'localhost');
    const at = `http://127.0.0.1:${cb.port}/callback`;
    assert.equal((await realFetch(`${at}?code=x&state=wrong`)).status, 400);
    assert.equal(exchanged.length, 0);
    assert.equal(s.list().find((x) => x.id === 'omniroute').omniroute?.openrouter?.state ?? s.orAuth.state, 'waiting');
    assert.equal((await realFetch(`${at}?code=c1&state=${auth.searchParams.get('state')}`)).status, 200);
    for (let i = 0; i < 50 && !connected.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(exchanged[0].code, 'c1');
    // The verifier hashes to the challenge sent to the sign-in page.
    const { createHash } = await import('node:crypto');
    assert.equal(createHash('sha256').update(exchanged[0].code_verifier).digest('base64url'), auth.searchParams.get('code_challenge'));
    assert.deepEqual(connected, [{ provider: 'openrouter', apiKey: 'sk-or-test' }]);
    assert.equal(s.orAuth, undefined);
    // Done: the callback no longer answers.
    await assert.rejects(realFetch(`${at}?code=c2&state=${auth.searchParams.get('state')}`));
  } finally {
    globalThis.fetch = realFetch;
    s.orAuth?.stop?.();
  }
});

test('OmniRoute 連線測試：新連線一開始停用、沒有模型，OmniRoute 自己的測試通過後才列出模型；Aivenue 重讀清單再用免費模型跑 agent 測試', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-omnitest-'));
  const cfg = {};
  const caps = { skillsDir: path.join(data, 'skills'), get: () => ({ extensions: cfg }), setExtensions: (next) => Object.assign(cfg, next) };
  const s = new ExtensionService({ dataDir: data, bundledDir: BUNDLED, capabilities: caps, registry: { forgetModels() {}, checkAuth: async () => undefined }, secrets: {}, onChange() {} });
  let active = false;
  const asked = [];
  // What a real OmniRoute does: the connection is inactive until /test passes, and only active connections list models.
  s.omniFetch = async (p, init = {}) => {
    if (init.headers?.['x-omniroute-connection']) init.onHeaders?.(new Headers({ 'x-omniroute-selected-connection-id': init.headers['x-omniroute-connection'] }));
    if (p === '/api/providers') return { connections: [{ id: 'c1', provider: 'openrouter', isActive: active }] };
    if (p.startsWith('/v1/models')) return { data: active ? [{ id: 'openrouter/auto', owned_by: 'openrouter' }, { id: 'openrouter/qwen/qwen3-coder:free', owned_by: 'openrouter' }] : [] };
    if (p === '/api/providers/c1/test') return ((active = true), { valid: true });
    if (p === '/v1/chat/completions') return (asked.push(init.body.model), { choices: [{ message: { tool_calls: [{}] } }] });
    return { candidates: [] };
  };
  s.syncOmniProvider = () => undefined;
  s.omni = { url: 'http://127.0.0.1:1', ready: true, connections: [], models: [], at: 0, candidates: new Set() };
  await s.refreshOmni(true);
  await s.omniTest('c1');
  assert.deepEqual(asked, ['openrouter/qwen/qwen3-coder:free']);
  const row = s.list().find((x) => x.id === 'omniroute').omniroute.connected.find((c) => c.id === 'c1');
  assert.equal(row.test.state, 'ok', JSON.stringify(row.test));
});

test('OmniRoute 連線測試：第一個模型回 410（已不提供），換下一個測試，並把它從選單拿掉；金鑰錯誤這類就不換', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-omnigone-'));
  const cfg = {};
  const caps = { skillsDir: path.join(data, 'skills'), get: () => ({ extensions: cfg }), setExtensions: (next) => Object.assign(cfg, next) };
  const s = new ExtensionService({ dataDir: data, bundledDir: BUNDLED, capabilities: caps, registry: { forgetModels() {}, checkAuth: async () => undefined }, secrets: {}, onChange() {} });
  const asked = [];
  s.omniFetch = async (p, init = {}) => {
    if (init.headers?.['x-omniroute-connection']) init.onHeaders?.(new Headers({ 'x-omniroute-selected-connection-id': init.headers['x-omniroute-connection'] }));
    if (p === '/api/providers') return { connections: [{ id: 'n1', provider: 'nvidia', isActive: true }] };
    if (p.startsWith('/v1/models')) return { data: [{ id: 'nvidia/moonshotai/kimi-k3', owned_by: 'nvidia' }, { id: 'nvidia/deepseek-ai/deepseek-v4-pro-0813', owned_by: 'nvidia' }] };
    if (p === '/api/providers/n1/test') return { valid: true };
    if (p === '/api/free-models') return { models: [{ provider: 'nvidia', modelId: 'moonshotai/kimi-k3', freeType: 'one-time-initial' }, { provider: 'nvidia', modelId: 'deepseek-ai/deepseek-v4-pro-0813', freeType: 'one-time-initial' }] };
    if (p === '/v1/chat/completions') {
      asked.push(init.body.model);
      if (init.body.model.endsWith('kimi-k3')) throw new Error('[410]: upstream error');
      return { choices: [{ message: { tool_calls: [{}] } }] };
    }
    return { candidates: [] };
  };
  s.syncOmniProvider = () => undefined;
  s.omni = { url: 'http://127.0.0.1:1', ready: true, connections: [], models: [], at: 0, candidates: new Set() };
  await s.refreshOmni(true);
  await s.omniTest('n1');
  assert.deepEqual(asked, ['nvidia/moonshotai/kimi-k3', 'nvidia/deepseek-ai/deepseek-v4-pro-0813']);
  const row = s.list().find((x) => x.id === 'omniroute').omniroute.connected[0];
  assert.equal(row.test.state, 'ok');
  assert.equal(row.test.model, 'nvidia/deepseek-ai/deepseek-v4-pro-0813');
  const ids = s.usableOmniModels().map((m) => m.id);
  assert.ok(!ids.includes('nvidia/moonshotai/kimi-k3'), ids.join());
  assert.ok(ids.includes('nvidia/deepseek-ai/deepseek-v4-pro-0813'), ids.join());
  const { omniModelGone } = mod.exports;
  assert.equal(omniModelGone('Invalid API key [401]'), false);
  assert.equal(omniModelGone('[404]: model not found'), true);
});

test('OmniRoute 連線測試：先請 OmniRoute 向供應商同步模型清單，再挑模型（改名後的新模型會被用到）', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-omnisync-'));
  const cfg = {};
  const caps = { skillsDir: path.join(data, 'skills'), get: () => ({ extensions: cfg }), setExtensions: (next) => Object.assign(cfg, next) };
  const s = new ExtensionService({ dataDir: data, bundledDir: BUNDLED, capabilities: caps, registry: { forgetModels() {}, checkAuth: async () => undefined }, secrets: {}, onChange() {} });
  let synced = false;
  const calls = [];
  // Before the sync OmniRoute still lists the old name; the provider's own list has the new one.
  s.omniFetch = async (p, init = {}) => {
    if (init.headers?.['x-omniroute-connection']) init.onHeaders?.(new Headers({ 'x-omniroute-selected-connection-id': init.headers['x-omniroute-connection'] }));
    calls.push(p);
    if (p === '/api/providers') return { connections: [{ id: 'n1', provider: 'nvidia', isActive: true }] };
    if (p.startsWith('/v1/models')) return { data: [{ id: synced ? 'nvidia/moonshotai/kimi-k3.1-pro' : 'nvidia/moonshotai/kimi-k3', owned_by: 'nvidia' }] };
    if (p === '/api/providers/n1/test') return { valid: true };
    if (p === '/api/providers/n1/sync-models') return ((synced = true), { ok: true });
    if (p === '/api/free-models') return { models: [{ provider: 'nvidia', modelId: 'moonshotai/kimi-k3', freeType: 'one-time-initial' }, { provider: 'nvidia', modelId: 'moonshotai/kimi-k3.1-pro', freeType: 'one-time-initial' }] };
    if (p === '/v1/chat/completions') return { model: init.body.model, choices: [{ message: { tool_calls: [{}] } }] };
    return { candidates: [] };
  };
  s.syncOmniProvider = () => undefined;
  s.omni = { url: 'http://127.0.0.1:1', ready: true, connections: [], models: [], at: 0, candidates: new Set() };
  await s.refreshOmni(true);
  await s.omniTest('n1');
  assert.ok(calls.indexOf('/api/providers/n1/sync-models') < calls.indexOf('/v1/chat/completions'), calls.join());
  assert.equal(s.list().find((x) => x.id === 'omniroute').omniroute.connected[0].test.model, 'nvidia/moonshotai/kimi-k3.1-pro');
});

/** A service with a fake OmniRoute: `answer(path, init)` returns what OmniRoute would. */
const fakeOmni = async (answer, cfg = { omniroute: { onlyChecked: false } }) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-omnifake-'));
  const caps = { skillsDir: path.join(data, 'skills'), get: () => ({ extensions: cfg }), setExtensions: (next) => Object.assign(cfg, next) };
  const s = new ExtensionService({ dataDir: data, bundledDir: BUNDLED, capabilities: caps, registry: { forgetModels() {}, checkAuth: async () => undefined }, secrets: {}, onChange() {} });
  s.omniFetch = async (p, init = {}) => {
    // Like OmniRoute 3.8.52: a request pinned to a connection is answered by it, and the answer says so.
    const pinned = init.headers?.['x-omniroute-connection'];
    if (pinned) init.onHeaders?.(new Headers({ 'x-omniroute-selected-connection-id': pinned }));
    return (await answer(p, init)) ?? { candidates: [] };
  };
  s.syncOmniProvider = () => undefined;
  s.omni = { url: 'http://127.0.0.1:1', ready: true, connections: [], models: [], at: 0, candidates: new Set() };
  await s.refreshOmni(true);
  return s;
};

test('OmniRoute 連線測試：沒有能確認免費的模型時不自動打付費模型，回報並等使用者按「用付費模型測試」', async () => {
  const asked = [];
  const s = await fakeOmni((p, init) => {
    if (p === '/api/providers') return { connections: [{ id: 'g1', provider: 'groq', isActive: true }] };
    if (p.startsWith('/v1/models')) return { data: [{ id: 'groq/llama-big', owned_by: 'groq', pricing: { prompt: '0' } }] };
    if (p === '/api/providers/g1/test') return { valid: true };
    if (p === '/api/free-models') return { models: [] };
    if (p === '/v1/chat/completions') return (asked.push(init.body.model), { choices: [{ message: { tool_calls: [{}] } }] });
  });
  await s.omniTest('g1');
  // An input price of 0 alone (output unknown) does not make it free.
  assert.deepEqual(asked, []);
  const row = () => s.list().find((x) => x.id === 'omniroute').omniroute.connected[0];
  assert.equal(row().test.state, 'fail');
  assert.equal(row().test.noFree, true);
  await s.omniTest('g1', { paid: true });
  assert.deepEqual(asked, ['groq/llama-big']);
  assert.equal(row().test.state, 'ok');
});

test('OmniRoute 退役模型只對那個連線、只到下一次成功同步；同步失敗時保留舊清單並記下沒有更新', async () => {
  let syncFails = false;
  let gone = true;
  const s = await fakeOmni((p, init) => {
    if (p === '/api/providers') return { connections: [{ id: 'n1', provider: 'nvidia', isActive: true }] };
    if (p.startsWith('/v1/models')) return { data: [{ id: 'nvidia/a', owned_by: 'nvidia' }, { id: 'nvidia/b', owned_by: 'nvidia' }] };
    if (p === '/api/providers/n1/test') return { valid: true };
    if (p === '/api/free-models') return { models: [{ provider: 'nvidia', modelId: 'a', freeType: 'recurring-daily' }, { provider: 'nvidia', modelId: 'b', freeType: 'recurring-daily' }] };
    if (p === '/api/providers/n1/sync-models') {
      if (syncFails) throw new Error('upstream timeout');
      return { ok: true };
    }
    if (p === '/v1/chat/completions') {
      if (init.body.model === 'nvidia/a' && gone) throw new Error('[404]: model not found');
      return { choices: [{ message: { tool_calls: [{}] } }] };
    }
  });
  await s.omniTest('n1');
  assert.ok(!s.usableOmniModels().some((m) => m.id === 'nvidia/a'));
  // The provider has it again: a failed sync keeps it out (and says the list was not updated)…
  gone = false;
  syncFails = true;
  await s.omniSyncAll();
  assert.ok(!s.usableOmniModels().some((m) => m.id === 'nvidia/a'));
  const sync = s.list().find((x) => x.id === 'omniroute').omniroute.connected[0].sync;
  assert.equal(sync.ok, false);
  assert.match(sync.message, /upstream timeout/);
  // …a successful one lets it back in.
  syncFails = false;
  await s.omniSyncAll();
  assert.ok(s.usableOmniModels().some((m) => m.id === 'nvidia/a'));
});

/** OpenRouter's sign-in with the key exchange held until `release()`. */
const heldSignIn = async (s, connected) => {
  const realFetch = globalThis.fetch;
  let release;
  const held = new Promise((r) => (release = r));
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://openrouter.ai/api/v1/auth/keys') {
      await held;
      return new Response(JSON.stringify({ key: 'sk-or-held' }), { status: 200 });
    }
    return realFetch(url, init);
  };
  const opened = [];
  s.o.openExternal = (u) => opened.push(u);
  s.omniConnect = async (p) => (connected.push(p), []);
  await s.omniOpenRouter();
  const auth = new URL(opened.at(-1));
  const cb = new URL(auth.searchParams.get('callback_url'));
  const res = await realFetch(`http://127.0.0.1:${cb.port}/callback?code=c&state=${auth.searchParams.get('state')}`);
  assert.equal(res.status, 200);
  return { release, restore: () => (globalThis.fetch = realFetch), realFetch };
};

test('OpenRouter 授權：換金鑰途中關掉 OmniRoute，換回的金鑰不會接上', async () => {
  const cfg = { omniroute: { enabled: true } };
  const s = await fakeOmni(() => undefined, cfg);
  s.stopOmni = () => (s.omni = undefined);
  const connected = [];
  const h = await heldSignIn(s, connected);
  try {
    await s.setEnabled('omniroute', false);
    h.release();
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(connected, []);
    assert.equal(s.orAuth, undefined);
  } finally {
    h.restore();
  }
});

test('OpenRouter 授權：換金鑰途中開始了新一輪授權，舊的那輪換回的金鑰不會接上', async () => {
  const cfg = { omniroute: { enabled: true } };
  const s = await fakeOmni(() => undefined, cfg);
  const connected = [];
  const h = await heldSignIn(s, connected);
  try {
    const opened = [];
    s.o.openExternal = (u) => opened.push(u);
    await s.omniOpenRouter();
    h.release();
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(connected, []);
    // The new sign-in is still the one waiting.
    assert.equal(s.orAuth.state, 'waiting');
    assert.equal(s.orAuth.url, opened[0]);
  } finally {
    s.orAuth?.stop?.();
    h.restore();
  }
});

test('OmniRoute 免費判定：明示的非零價格優先於名稱；免費目錄只採信明確的免費類型', async () => {
  const asked = [];
  const s = await fakeOmni((p, init) => {
    if (p === '/api/providers') return { connections: [{ id: 'o1', provider: 'openrouter', isActive: true }] };
    if (p.startsWith('/v1/models'))
      return {
        data: [
          { id: 'openrouter/x/coder:free', owned_by: 'openrouter', pricing: { prompt: '0.000002', completion: '0.000004' } },
          { id: 'openrouter/x/freeform', owned_by: 'openrouter' },
          { id: 'openrouter/x/untyped', owned_by: 'openrouter' },
          { id: 'openrouter/x/gone', owned_by: 'openrouter' },
        ],
      };
    if (p === '/api/providers/o1/test') return { valid: true };
    if (p === '/api/free-models') return { models: [{ provider: 'openrouter', modelId: 'x/untyped' }, { provider: 'openrouter', modelId: 'x/gone', freeType: 'discontinued' }] };
    if (p === '/v1/chat/completions') return (asked.push(init.body.model), { choices: [{ message: { tool_calls: [{}] } }] });
  });
  const free = Object.fromEntries((await s.omniModels()).map((m) => [m.id, m.free]));
  assert.equal(free['omniroute/openrouter/x/coder:free'], false);
  assert.equal(free['omniroute/openrouter/x/freeform'], false);
  assert.equal(free['omniroute/openrouter/x/untyped'], false);
  assert.equal(free['omniroute/openrouter/x/gone'], false);
  await s.omniTest('o1');
  assert.deepEqual(asked, []);
  assert.equal(s.list().find((x) => x.id === 'omniroute').omniroute.connected[0].test.noFree, true);
});

test('OmniRoute 付費測試：一次確認最多送一筆付費請求，模型失效就回報', async () => {
  const asked = [];
  const s = await fakeOmni((p, init) => {
    if (p === '/api/providers') return { connections: [{ id: 'g1', provider: 'groq', isActive: true }] };
    if (p.startsWith('/v1/models')) return { data: ['a', 'b', 'c'].map((n) => ({ id: `groq/${n}`, owned_by: 'groq' })) };
    if (p === '/api/providers/g1/test') return { valid: true };
    if (p === '/api/free-models') return { models: [] };
    // The sync does not reach the provider, so the gone model stays marked.
    if (p === '/api/providers/g1/sync-models') throw new Error('offline');
    if (p === '/v1/chat/completions') {
      asked.push(init.body.model);
      throw new Error('[410]: model gone');
    }
  });
  await s.omniTest('g1', { paid: true });
  assert.equal(asked.length, 1);
  const t = s.list().find((x) => x.id === 'omniroute').omniroute.connected[0].test;
  assert.equal(t.state, 'fail');
  // Pressing again tries the next one, again only one.
  await s.omniTest('g1', { paid: true });
  assert.equal(asked.length, 2);
  assert.notEqual(asked[0], asked[1]);
});

test('OmniRoute 選單：兩條連線提供同一模型，只有一條失效時仍列出；兩條都失效才拿掉', async () => {
  const dead = new Set();
  const s = await fakeOmni((p, init) => {
    if (p === '/api/providers') return { connections: [{ id: 'n1', provider: 'nvidia', isActive: true }, { id: 'n2', provider: 'nvidia', isActive: true }] };
    if (p.startsWith('/v1/models')) return { data: [{ id: 'nvidia/a', owned_by: 'nvidia' }] };
    if (/\/test$/.test(p)) return { valid: true };
    if (p === '/api/free-models') return { models: [{ provider: 'nvidia', modelId: 'a', freeType: 'recurring-daily' }] };
    if (/sync-models$/.test(p)) throw new Error('offline');
    if (p === '/v1/chat/completions') {
      // OmniRoute serves through the pinned connection and says so.
      const conn = init.headers['x-omniroute-connection'];
      init.onHeaders(new Headers({ 'x-omniroute-selected-connection-id': conn }));
      if (dead.has(conn)) throw new Error('[404]: model not found');
      return { choices: [{ message: { tool_calls: [{}] } }] };
    }
  });
  const listed = () => s.usableOmniModels().some((m) => m.id === 'nvidia/a');
  dead.add('n1');
  await s.omniTest('n1');
  assert.ok(listed());
  dead.add('n2');
  await s.omniTest('n2');
  assert.ok(!listed());
});

test('OmniRoute 刷新：途中停用或重啟，舊的回覆不寫進目前的服務', async () => {
  let release;
  const held = new Promise((r) => (release = r));
  let hold = false;
  const s = await fakeOmni(async (p) => {
    if (hold && p === '/api/providers') await held;
    if (p === '/api/providers') return { connections: [{ id: 'old', provider: 'nvidia', isActive: true }] };
    if (p.startsWith('/v1/models')) return { data: [{ id: 'nvidia/old', owned_by: 'nvidia' }] };
  });
  hold = true;
  // Stopped mid-way: nothing is written and nothing throws.
  let pending = s.refreshOmni(true);
  s.omni = undefined;
  release();
  await pending;
  assert.equal(s.omni, undefined);
  // Restarted mid-way: the new instance keeps its own lists.
  let release2;
  const held2 = new Promise((r) => (release2 = r));
  s.omniFetch = async (p) => {
    await held2;
    return p === '/api/providers' ? { connections: [{ id: 'old', provider: 'nvidia', isActive: true }] } : p.startsWith('/v1/models') ? { data: [{ id: 'nvidia/old', owned_by: 'nvidia' }] } : { candidates: [] };
  };
  const first = { url: 'http://127.0.0.1:1', ready: true, connections: [], models: [], at: 0, candidates: new Set() };
  s.omni = first;
  pending = s.refreshOmni(true);
  const fresh = { url: 'http://127.0.0.1:2', ready: true, connections: [], models: [], at: 0, candidates: new Set() };
  s.omni = fresh;
  release2();
  await pending;
  assert.deepEqual(fresh.models, []);
  assert.deepEqual(fresh.connections, []);
  assert.equal(fresh.at, 0);
});

test('OmniRoute 連線測試：指定要測的連線，並核對 OmniRoute 實際用的連線；用了別條就不算這把金鑰的結果', async () => {
  const sent = [];
  let served;
  let fails = false;
  const s = await fakeOmni((p, init) => {
    if (p === '/api/providers') return { connections: [{ id: 'n1', provider: 'nvidia', isActive: true }, { id: 'n2', provider: 'nvidia', isActive: true }] };
    if (p.startsWith('/v1/models')) return { data: [{ id: 'nvidia/a', owned_by: 'nvidia' }, { id: 'nvidia/b', owned_by: 'nvidia' }] };
    if (/\/test$/.test(p)) return { valid: true };
    if (p === '/api/free-models') return { models: ['a', 'b'].map((modelId) => ({ provider: 'nvidia', modelId, freeType: 'recurring-daily' })) };
    if (/sync-models$/.test(p)) throw new Error('offline');
    if (p === '/v1/chat/completions') {
      sent.push(init.headers['x-omniroute-connection']);
      if (served !== undefined) init.onHeaders(new Headers(served ? { 'x-omniroute-selected-connection-id': served } : {}));
      if (fails) throw new Error('[410]: model gone');
      return { choices: [{ message: { tool_calls: [{}] } }] };
    }
  });
  const test = (id) => s.list().find((x) => x.id === 'omniroute').omniroute.connected.find((c) => c.id === id).test;
  // Asked for n1, OmniRoute says n2 answered: not a pass for n1.
  served = 'n2';
  await s.omniTest('n1');
  assert.deepEqual(sent, ['n1']);
  assert.equal(test('n1').state, 'fail');
  assert.match(test('n1').message, /n2/);
  // n2's 410 is not n1's: nothing is marked gone for n1 and no other model is tried.
  fails = true;
  await s.omniTest('n1');
  assert.deepEqual(sent, ['n1', 'n1']);
  assert.equal(s.omniGone.get('n1'), undefined);
  // OmniRoute does not say, and another connection serves the model: not confirmed.
  fails = false;
  served = null;
  await s.omniTest('n1');
  assert.equal(test('n1').state, 'fail');
  // It says n1 answered: a pass for n1.
  served = 'n1';
  await s.omniTest('n1');
  assert.equal(test('n1').state, 'ok');
});

test('OmniRoute 刷新：讀清單逾時時保留上次成功的模型與連線並顯示刷新失敗，恢復後清掉提示', async () => {
  let down = false;
  let model = 'nvidia/a';
  const s = await fakeOmni((p) => {
    if (down && (p === '/api/providers' || p.startsWith('/v1/models') || p.startsWith('/v1/auto-combo'))) throw new Error('The operation was aborted due to timeout');
    if (p === '/api/providers') return { connections: [{ id: 'n1', provider: 'nvidia', isActive: true }] };
    if (p.startsWith('/v1/models')) return { data: [{ id: model, owned_by: 'nvidia' }] };
  });
  const st = () => s.list().find((x) => x.id === 'omniroute').omniroute;
  assert.ok(s.usableOmniModels().some((m) => m.id === 'nvidia/a'));
  down = true;
  await s.refreshOmni(true);
  assert.ok(s.usableOmniModels().some((m) => m.id === 'nvidia/a'));
  assert.equal(st().connections, 1);
  assert.match(st().refresh.message, /timeout/);
  down = false;
  model = 'nvidia/b';
  await s.refreshOmni(true);
  assert.equal(st().refresh, undefined);
  assert.deepEqual(s.usableOmniModels().map((m) => m.id), ['nvidia/b']);
});

test('OmniRoute 連線測試：只有一條連線、閘道回 404 卻沒回報連線時，算無法確認，不判定模型下架', async () => {
  const asked = [];
  const s = await fakeOmni((p, init) => {
    if (p === '/api/providers') return { connections: [{ id: 'n1', provider: 'nvidia', isActive: true }] };
    if (p.startsWith('/v1/models')) return { data: [{ id: 'nvidia/a', owned_by: 'nvidia' }, { id: 'nvidia/b', owned_by: 'nvidia' }] };
    if (p === '/api/providers/n1/test') return { valid: true };
    if (p === '/api/free-models') return { models: ['a', 'b'].map((modelId) => ({ provider: 'nvidia', modelId, freeType: 'recurring-daily' })) };
    if (/sync-models$/.test(p)) throw new Error('offline');
    if (p === '/v1/chat/completions') {
      asked.push(init.body.model);
      init.onHeaders(new Headers());
      throw new Error('[404]: model not found');
    }
  });
  await s.omniTest('n1');
  assert.equal(asked.length, 1);
  assert.equal(s.omniGone.get('n1'), undefined);
  assert.ok(s.usableOmniModels().some((m) => m.id === asked[0]));
  const t = s.list().find((x) => x.id === 'omniroute').omniroute.connected[0].test;
  assert.equal(t.state, 'fail');
  assert.match(t.message, /無法確認|could not be confirmed/);
});

test('OmniRoute 刷新：免費目錄逾時時，候選清單成功變成空的那個池仍會更新（從選單拿掉）', async () => {
  let pool = [{ provider: 'groq', connectionId: 'c1', model: 'groq/llama', modelStr: 'groq/llama', reachable: true, breakerState: 'CLOSED' }];
  let catalogDown = false;
  const s = await fakeOmni((p) => {
    if (p === '/api/free-models') {
      if (catalogDown) throw new Error('The operation was aborted due to timeout');
      return { models: [] };
    }
    if (p === '/api/providers') return { connections: [{ id: 'c1', provider: 'groq', isActive: true }] };
    if (p.startsWith('/v1/models')) return { data: [{ id: 'auto/coding:free', owned_by: 'combo' }, { id: 'groq/llama', owned_by: 'groq' }] };
    if (p.startsWith('/v1/auto-combo/coding:free')) return { candidates: pool };
    if (p.startsWith('/v1/auto-combo/')) return { candidates: [] };
  });
  const ids = () => s.usableOmniModels().map((m) => m.id);
  assert.ok(ids().includes('auto/coding:free'), ids().join());
  catalogDown = true;
  pool = [];
  await s.refreshOmni(true);
  assert.ok(!ids().includes('auto/coding:free'), ids().join());
  assert.match(s.list().find((x) => x.id === 'omniroute').omniroute.refresh.message, /free-models/);
});

test('OmniRoute 連線測試：模型等不到回應（免費模型排隊）時換下一個模型，不判定下架，也不算這把金鑰的錯', async () => {
  const asked = [];
  const s = await fakeOmni((p) => {
    if (p === '/api/providers') return { connections: [{ id: 'n1', provider: 'nvidia', isActive: true }] };
    if (p.startsWith('/v1/models')) return { data: [{ id: 'nvidia/google/gemma-4-31b-it', owned_by: 'nvidia' }, { id: 'nvidia/openai/gpt-oss-120b', owned_by: 'nvidia' }] };
    if (p === '/api/providers/n1/test') return { valid: true };
    if (p === '/api/free-models') return { models: ['google/gemma-4-31b-it', 'openai/gpt-oss-120b'].map((modelId) => ({ provider: 'nvidia', modelId, freeType: 'one-time-initial' })) };
  });
  const answer = s.omniFetch;
  s.omniFetch = async (p, init = {}) => {
    if (p !== '/v1/chat/completions') return answer(p, init);
    asked.push(init.body.model);
    // The first model never answers: the wait runs out before any response (no headers).
    if (init.body.model.includes('gemma')) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    init.onHeaders(new Headers({ 'x-omniroute-selected-connection-id': 'n1' }));
    return { choices: [{ message: { tool_calls: [{}] } }] };
  };
  await s.omniTest('n1');
  assert.deepEqual(asked, ['nvidia/google/gemma-4-31b-it', 'nvidia/openai/gpt-oss-120b']);
  const t = s.list().find((x) => x.id === 'omniroute').omniroute.connected[0].test;
  assert.equal(t.state, 'ok');
  assert.equal(t.model, 'nvidia/openai/gpt-oss-120b');
  assert.equal(s.omniGone.get('n1'), undefined);
});

test('OmniRoute 連線測試：使用者選了測試用的模型（NVIDIA 的金鑰可能只能用某些模型），就只測那個模型並記住；選回自動就照免費規則', async () => {
  const asked = [];
  const cfg = { omniroute: { enabled: true } };
  const s = await fakeOmni((p, init) => {
    if (p === '/api/providers') return { connections: [{ id: 'n1', provider: 'nvidia', isActive: true }] };
    if (p.startsWith('/v1/models')) return { data: [{ id: 'nvidia/google/gemma-4-31b-it', owned_by: 'nvidia' }, { id: 'nvidia/moonshotai/kimi-k3.1-pro', owned_by: 'nvidia' }] };
    if (p === '/api/providers/n1/test') return { valid: true };
    if (p === '/api/free-models') return { models: [{ provider: 'nvidia', modelId: 'google/gemma-4-31b-it', freeType: 'one-time-initial' }] };
    if (p === '/v1/chat/completions') return (asked.push(init.body.model), { choices: [{ message: { tool_calls: [{}] } }] });
  }, cfg);
  const row = () => s.list().find((x) => x.id === 'omniroute').omniroute.connected[0];
  assert.deepEqual(row().models, ['nvidia/google/gemma-4-31b-it', 'nvidia/moonshotai/kimi-k3.1-pro']);
  await s.omniTest('n1', { model: 'nvidia/moonshotai/kimi-k3.1-pro' });
  assert.deepEqual(asked, ['nvidia/moonshotai/kimi-k3.1-pro']);
  assert.equal(row().testModel, 'nvidia/moonshotai/kimi-k3.1-pro');
  assert.equal(row().test.state, 'ok');
  // Remembered: a plain re-check uses it again.
  await s.omniTest('n1');
  assert.deepEqual(asked.slice(1), ['nvidia/moonshotai/kimi-k3.1-pro']);
  // Back to automatic: the free one.
  await s.omniTest('n1', { model: null });
  assert.equal(asked.at(-1), 'nvidia/google/gemma-4-31b-it');
  assert.equal(row().testModel, undefined);
});

test('OmniRoute 模型的推理強度：沒標會不會思考的（NVIDIA 同步來的 Kimi）也能選；明確標成不會思考的才不給', async () => {
  const s = await fakeOmni((p) => {
    if (p === '/api/providers') return { connections: [{ id: 'n1', provider: 'nvidia', isActive: true }] };
    if (p.startsWith('/v1/models')) return { data: [{ id: 'nvidia/moonshotai/kimi-k3.1-pro', owned_by: 'nvidia' }, { id: 'nvidia/x/plain', owned_by: 'nvidia', capabilities: { reasoning: false } }] };
  });
  const efforts = Object.fromEntries((await s.omniModels()).map((m) => [m.id, m.efforts]));
  assert.deepEqual(efforts['omniroute/nvidia/moonshotai/kimi-k3.1-pro'], ['low', 'medium', 'high']);
  assert.deepEqual(efforts['omniroute/nvidia/x/plain'], []);
});

test('OmniRoute 選單：每個模型標出來源（Gemini AI Studio、OpenRouter、NVIDIA NIM），測試通過的標「已測試可用」排前面，非免費的自動組合排最後', async () => {
  const s = await fakeOmni((p) => {
    if (p === '/api/providers') return { connections: [{ id: 'g1', provider: 'gemini', isActive: true }, { id: 'o1', provider: 'openrouter', isActive: true }, { id: 'n1', provider: 'nvidia', isActive: true }] };
    if (p.startsWith('/v1/models'))
      return {
        data: [
          { id: 'auto/claude-opus', owned_by: 'combo' },
          { id: 'gemini/gemini-3-flash-preview', owned_by: 'gemini' },
          { id: 'openrouter/qwen/qwen3-coder:free', owned_by: 'openrouter' },
          { id: 'nvidia/moonshotai/kimi-k3.1-pro', owned_by: 'nvidia' },
        ],
      };
    if (p === '/api/providers/g1/test') return { valid: true };
    if (/sync-models$/.test(p)) return { ok: true };
    if (p === '/api/free-models') return { models: [{ provider: 'gemini', modelId: 'gemini-3-flash-preview', freeType: 'recurring-daily' }] };
    if (p === '/v1/chat/completions') return { choices: [{ message: { tool_calls: [{}] } }] };
  });
  await s.omniTest('g1');
  const models = await s.omniModels();
  const label = Object.fromEntries(models.map((m) => [m.id, m.label]));
  assert.match(label['omniroute/gemini/gemini-3-flash-preview'], /已測試可用.*Gemini AI Studio · gemini-3-flash-preview/);
  assert.match(label['omniroute/openrouter/qwen/qwen3-coder:free'], /^OpenRouter · qwen\/qwen3-coder:free$/);
  assert.match(label['omniroute/nvidia/moonshotai/kimi-k3.1-pro'], /^NVIDIA NIM · moonshotai\/kimi-k3.1-pro$/);
  assert.match(label['omniroute/auto/claude-opus'], /OmniRoute 自動組合/);
  const ids = models.map((m) => m.id);
  assert.equal(ids[0], 'omniroute/gemini/gemini-3-flash-preview');
  assert.equal(ids.at(-1), 'omniroute/auto/claude-opus');
});

test('OmniRoute 模型逐一測試：只測這家的免費模型（NVIDIA 的都算），記住結果；選單預設只列免費且測試通過的，關掉篩選就全列', async () => {
  const asked = [];
  const cfg = { omniroute: { enabled: true } };
  const s = await fakeOmni((p, init) => {
    if (p === '/api/providers') return { connections: [{ id: 'n1', provider: 'nvidia', isActive: true }, { id: 'o1', provider: 'openrouter', isActive: true }] };
    if (p.startsWith('/v1/models'))
      return {
        data: [
          { id: 'auto/best-free', owned_by: 'combo' },
          { id: 'auto/claude-opus', owned_by: 'combo' },
          { id: 'nvidia/z-ai/glm-5.3-flash', owned_by: 'nvidia' },
          { id: 'nvidia/google/gemma-4-31b-it', owned_by: 'nvidia' },
          { id: 'openrouter/anthropic/claude-opus-5', owned_by: 'openrouter' },
        ],
      };
    if (p.startsWith('/v1/auto-combo/best-free')) return { candidates: [{ provider: 'nvidia', connectionId: 'n1', model: 'nvidia/z-ai/glm-5.3-flash', modelStr: 'nvidia/z-ai/glm-5.3-flash', reachable: true, breakerState: 'CLOSED' }] };
    if (p === '/v1/chat/completions') {
      asked.push(init.body.model);
      if (init.body.model.includes('gemma')) return { choices: [{ message: { content: 'hello' } }] };
      return { choices: [{ message: { tool_calls: [{}] } }] };
    }
  }, cfg);
  const row = () => s.list().find((x) => x.id === 'omniroute').omniroute;
  // Every NVIDIA model is a free endpoint; OpenRouter's paid one is not checked.
  assert.deepEqual(row().connected.find((c) => c.id === 'n1').freeModels, ['nvidia/z-ai/glm-5.3-flash', 'nvidia/google/gemma-4-31b-it']);
  // Nothing checked yet: only the free pool is in the menu.
  assert.deepEqual(s.usableOmniModels().map((m) => m.id), ['auto/best-free']);
  await s.omniCheckModels('n1');
  assert.deepEqual(asked.sort(), ['nvidia/google/gemma-4-31b-it', 'nvidia/z-ai/glm-5.3-flash']);
  assert.equal(row().checks['nvidia/z-ai/glm-5.3-flash'].state, 'ok');
  assert.equal(row().checks['nvidia/google/gemma-4-31b-it'].state, 'fail');
  assert.deepEqual(s.usableOmniModels().map((m) => m.id), ['auto/best-free', 'nvidia/z-ai/glm-5.3-flash']);
  // Kept on disk for the next start.
  const again = new ExtensionService({ dataDir: s.o.dataDir, bundledDir: BUNDLED, capabilities: s.o.capabilities, registry: s.o.registry, secrets: {}, onChange() {} });
  assert.equal(again.checks()['nvidia/z-ai/glm-5.3-flash'].state, 'ok');
  // The filter off: every model again.
  await s.omniOnlyChecked(false);
  assert.equal(row().onlyChecked, false);
  assert.ok(s.usableOmniModels().some((m) => m.id === 'openrouter/anthropic/claude-opus-5'));
});
