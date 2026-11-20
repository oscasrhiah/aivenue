import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { test } from './lib/test-shard.mjs';
import { build } from 'esbuild';

// CodeGraph as a built-in extension: the index service with the real process helpers and a stand-in `codegraph`
// script; the extension (install, telemetry off, uninstall, the agents' rules) with the process boundary replaced; and
// the orchestrator offering and answering its tools.
const load = async (contents, plugins = []) => {
  const b = await build({ stdin: { contents, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', plugins });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', b.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  return mod.exports;
};
const real = await load(
  `export { CodeGraphService, codegraphArgs, CODEGRAPH_ENV, CODEGRAPH_TOOLS, CODEGRAPH_VERSION } from './packages/core/src/codegraph';
   export { Orchestrator } from './packages/core/src/orchestrator';
   export { RunStore } from './packages/core/src/store';
   export { graphUsage, graphLookupsByTool } from './packages/core/src/graphUsage';
   export { extensionSummary, extensionUse } from './packages/ui/src/extensionUse';`,
  [{ name: 'stand-in agent', setup(b) { b.onLoad({ filter: /[\\/]agentRunner\.ts$/ }, () => ({ contents: 'export async function runAgent(o) { return globalThis.__fakeAgent(o); }' })); } }],
);
const { CodeGraphService, codegraphArgs, CODEGRAPH_ENV, CODEGRAPH_TOOLS, CODEGRAPH_VERSION, Orchestrator, RunStore, graphUsage, graphLookupsByTool, extensionSummary, extensionUse } = real;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-codegraph-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The stand-in codegraph: every call logged with the environment that matters; init/sync/status/lookups answered.
const STUB = path.join(tmp(), 'codegraph-stub.cjs');
fs.writeFileSync(
  STUB,
  `const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const at = args.indexOf('--path');
const dir = at >= 0 ? args[at + 1] : args[args.length - 1];
let ctl = {};
try { ctl = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'stub.json'), 'utf8')); } catch {}
const keys = ['DO_NOT_TRACK', 'CODEGRAPH_TELEMETRY', 'CODEGRAPH_NO_UPDATE_CHECK', 'CODEGRAPH_NO_DOWNLOAD', 'CODEGRAPH_NO_DAEMON', 'CODEGRAPH_NO_WATCH'];
fs.appendFileSync(path.join(process.cwd(), 'calls.log'), JSON.stringify({ args, env: Object.fromEntries(keys.map((k) => [k, process.env[k]])) }) + '\\n');
const cmd = args[0];
setTimeout(() => {
  if (ctl.fail && (cmd === 'init' || cmd === 'sync')) { console.error('◆  Error: parser crashed'); process.exit(3); }
  if (cmd === 'init') { fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true }); fs.writeFileSync(path.join(dir, '.codegraph', 'codegraph.db'), ''); console.log('◆  Indexed 3 files'); process.exit(0); }
  if (cmd === 'sync') { console.log('◆  Synced 1 changed files'); process.exit(0); }
  if (cmd === 'status') { console.log(JSON.stringify({ initialized: true, fileCount: 3, nodeCount: 42, edgeCount: 99, lastIndexed: '2026-11-20T10:00:00.000Z' })); process.exit(0); }
  if (cmd === 'callers' && args[1] === 'boom') { console.error('no such symbol'); process.exit(1); }
  console.log('ANSWER ' + args.join(' | '));
  process.exit(0);
}, ctl.delayMs ?? 20);
`,
);
const project = (ctl = {}, { git } = {}) => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'stub.json'), JSON.stringify(ctl));
  if (git) execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
};
const calls = (dir) => {
  try {
    return fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const service = (o = {}) => {
  const pushed = [];
  return { s: new CodeGraphService({ active: () => o.active ?? true, command: () => STUB, onChange: (x) => pushed.push(x), debounceMs: o.debounceMs, home: o.home ?? path.join(os.tmpdir(), 'not-home'), timeoutMs: o.timeoutMs, log: () => undefined }), pushed };
};

test('建立索引：沒有索引時 init -y，之後 sync；狀態有檔案與符號數；每次都關掉使用統計、背景程式與監看', async () => {
  const dir = project({}, { git: true });
  const { s, pushed } = service();
  const a = await s.ensure(dir, 'start');
  assert.equal(a.state, 'idle');
  assert.equal(a.indexed, true);
  assert.equal(a.files, 3);
  assert.equal(a.symbols, 42);
  assert.equal(a.edges, 99);
  const b = await s.ensure(dir, 'edit');
  assert.equal(b.reason, 'edit');
  const log = calls(dir);
  assert.deepEqual(log.map((c) => c.args[0]), ['init', 'status', 'sync', 'status']);
  assert.deepEqual(log[0].args, ['init', '-y', path.resolve(dir)]);
  for (const c of log) assert.deepEqual(c.env, { DO_NOT_TRACK: '1', CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1', CODEGRAPH_NO_DOWNLOAD: '1', CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_WATCH: '1' });
  assert.deepEqual(pushed.map((p) => p.state), ['building', 'idle', 'building', 'idle']);
  // .codegraph/ in the local exclude file, once.
  const exclude = fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.match(/^\.codegraph\/$/gm)?.length, 1, exclude);
  assert.equal(fs.existsSync(path.join(dir, '.gitignore')), false);
});

test('同一個資料夾一次只跑一個；建立中再要求的合成一次；改檔後的延後更新只跑一次', async () => {
  const dir = project({ delayMs: 250 });
  const { s } = service({ debounceMs: 120 });
  const first = s.ensure(dir, 'start');
  await sleep(30);
  const b = s.ensure(dir, 'edit');
  assert.equal(b, s.ensure(dir, 'end'));
  await first;
  await b;
  assert.deepEqual(calls(dir).filter((c) => c.args[0] !== 'status').map((c) => c.args[0]), ['init', 'sync']);
  s.schedule(dir);
  s.schedule(dir);
  assert.equal(s.scheduled(dir), true);
  await sleep(900);
  assert.equal(calls(dir).filter((c) => c.args[0] === 'sync').length, 2);
});

test('失敗、沒開、家目錄與磁碟根目錄：不建索引並說明原因', async () => {
  const bad = project({ fail: true });
  const { s } = service();
  const f = await s.ensure(bad, 'start');
  assert.equal(f.state, 'failed');
  assert.match(f.lastError, /parser crashed/);
  const off = project();
  assert.equal((await service({ active: false }).s.ensure(off, 'start')).active, false);
  assert.deepEqual(calls(off), []);
  const home = project();
  const h = service({ home });
  assert.match((await h.s.ensure(home, 'start')).lastError, /家目錄|home folder/);
  assert.match((await h.s.ensure(path.parse(home).root, 'start')).lastError, /整個磁碟|whole drive/);
  assert.deepEqual(calls(home), []);
});

test('工具呼叫對應的 CLI 指令：缺參數時直接說明；失敗時請 agent 改用一般搜尋', async () => {
  const cwd = path.resolve('C:/p');
  assert.deepEqual(codegraphArgs('codegraph_explore', { query: 'how X works' }, cwd), ['explore', 'how X works', '--path', cwd]);
  assert.deepEqual(codegraphArgs('codegraph_callers', { symbol: 'start', file: 'a.ts' }, cwd), ['callers', 'start', '--path', cwd, '--limit', '30', '--file', 'a.ts']);
  assert.deepEqual(codegraphArgs('codegraph_callees', { symbol: 'start', limit: 500 }, cwd), ['callees', 'start', '--path', cwd, '--limit', '100']);
  assert.deepEqual(codegraphArgs('codegraph_impact', { symbol: 'x', depth: 9 }, cwd), ['impact', 'x', '--path', cwd, '--depth', '5']);
  assert.deepEqual(codegraphArgs('codegraph_search', { query: 'Hub', kind: 'class' }, cwd), ['query', 'Hub', '--path', cwd, '--limit', '20', '--kind', 'class']);
  assert.deepEqual(codegraphArgs('codegraph_node', { name: 'start' }, cwd), ['node', 'start', '--path', cwd]);
  assert.match(codegraphArgs('codegraph_callers', {}, cwd), /Give "symbol"/);
  assert.deepEqual([...CODEGRAPH_TOOLS], ['codegraph_explore', 'codegraph_node', 'codegraph_search', 'codegraph_callers', 'codegraph_callees', 'codegraph_impact']);
  const dir = project();
  const { s } = service();
  assert.match(await s.lookup(dir, 'codegraph_callers', { symbol: 'capture' }), /^ANSWER callers \| capture \| --path/);
  assert.match(await s.lookup(dir, 'codegraph_callers', { symbol: 'boom' }), /exited with code 1[\s\S]*no such symbol[\s\S]*Fall back to normal source search/);
  assert.match(await s.lookup(dir, 'codegraph_explore', { query: ' ' }), /Give "query"/);
  // Lookups run with telemetry off too.
  assert.ok(calls(dir).every((c) => c.env.DO_NOT_TRACK === '1' && c.env.CODEGRAPH_TELEMETRY === '0'));
  assert.equal(CODEGRAPH_VERSION, '1.6.2');
  assert.equal(CODEGRAPH_ENV.DO_NOT_TRACK, '1');
});

test('查圖次數也算 CodeGraph：工具、程式碼模式裡的呼叫與 codegraph 指令；init／sync 算建圖；標頭說是哪些工具', () => {
  const tool = (id, category, name, extra = {}) => ({ kind: 'tool', tool: { id, name, category, title: extra.title ?? name, status: 'ok', ...extra } });
  const events = [
    tool('1', 'search', 'grep'),
    tool('2', 'hub', 'mcp__aivenue__codegraph_callers', { title: 'CodeGraph 誰呼叫: start' }),
    tool('3', 'hub', 'report_progress', { input: JSON.stringify({ code: 'await tools.aivenue.report_progress({}); await tools.aivenue.codegraph_explore({query:"x"}); await tools.aivenue.graph_query({question:"y"});' }) }),
    tool('4', 'command', 'bash', { title: 'codegraph impact startHub --depth 2' }),
    tool('5', 'command', 'bash', { title: 'codegraph sync .' }),
    tool('6', 'read', 'read'),
    tool('7', 'command', 'bash', { title: 'graphify query "a"' }),
  ];
  assert.deepEqual(graphUsage(events), { graph: 5, build: 1, search: 2, before: 1 });
  assert.deepEqual(Object.fromEntries(graphLookupsByTool(events)), { codegraph_callers: 1, codegraph_explore: 1, graph_query: 1, 'codegraph impact': 1, 'graphify query': 1 });
  const sum = extensionSummary(events);
  assert.equal(sum.codegraph, 4);
  assert.equal(sum.graphify, 2);
  assert.deepEqual(sum.codegraphTools.sort(), ['codegraph impact', 'codegraph sync', 'codegraph_callers', 'codegraph_explore']);
  assert.deepEqual(extensionUse(events[1]), { kind: 'codegraph', action: 'callers', arg: 'start' });
  // The Graphify script's own cases still hold.
  assert.deepEqual(graphUsage([tool('1', 'command', 'bash', { title: 'npm test' })]), { graph: 0, build: 0, search: 0, before: 0 });
});

// ---------- the extension: install, telemetry, uninstall, rules ----------

const ext = await load(`export { ExtensionService } from './packages/core/src/extensions'; export { setCapture } from './packages/core/src/proc';`, [
  {
    name: 'process boundary',
    setup(b) {
      b.onLoad({ filter: /[\\/]proc\.ts$/ }, () => ({
        contents: `
        export let capture;
        export function setCapture(fn) { capture = fn; }
        export function refreshPathCache() {}
        export function childEnv() { return {}; }
        export function findNode() { return 'node'; }
        export function killTree() {}
        export function resolveCommand(c) { return { file: c, prefixArgs: [], display: c }; }
        import { EventEmitter } from 'node:events';
        export function spawnResolved(cmd, args) {
          const child = new EventEmitter();
          const stream = () => Object.assign(new EventEmitter(), { setEncoding() { return this; } });
          child.stdout = stream(); child.stderr = stream();
          Promise.resolve(capture(cmd.file, args, {})).then((r) => { if (r.stdout) child.stdout.emit('data', r.stdout); child.emit('close', r.code); });
          return child;
        }`,
      }));
    },
  },
]);
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

function extension(cfg) {
  const dataDir = tmp();
  const caps = { skillsDir: path.join(dataDir, 'skills'), get: () => ({ extensions: cfg }), setExtensions: (next) => Object.assign(cfg, next) };
  const s = new ext.ExtensionService({ dataDir, bundledDir: path.join(process.cwd(), 'packages', 'core', 'bundled'), capabilities: caps, registry: {}, secrets: {}, onChange() {} });
  const shim = path.join(dataDir, 'tools', 'codegraph', 'node_modules', '@colbymchenry', 'codegraph', 'npm-shim.js');
  return { s, caps, dataDir, shim };
}

test('開啟 CodeGraph：用 npm 把固定版本裝進 Aivenue 的工具資料夾，再關掉它自己的使用統計；不執行 codegraph install', async () => {
  const cfg = { codegraph: { enabled: false } };
  const { s, dataDir, shim } = extension(cfg);
  const seen = [];
  ext.setCapture(async (cmd, args, opts) => {
    seen.push({ cmd, args, env: opts?.env });
    if (cmd !== shim && (/npm/.test(cmd) || args.some((a) => /npm-cli/.test(a)))) {
      fs.mkdirSync(path.dirname(shim), { recursive: true });
      fs.writeFileSync(shim, '');
      return ok('added 2 packages');
    }
    if (cmd === shim) return fs.existsSync(shim) ? ok('1.6.2') : { code: null, stdout: '', stderr: '', error: 'not found' };
    return ok();
  });
  await s.setEnabled('codegraph', true);
  for (let i = 0; i < 50 && s.list().find((x) => x.id === 'codegraph').state !== 'ready'; i++) await sleep(20);
  const st = s.list().find((x) => x.id === 'codegraph');
  assert.equal(st.state, 'ready', st.message);
  assert.equal(st.version, '1.6.2');
  assert.equal(st.installed, true);
  assert.equal(s.codegraphReady(), true);
  const npm = seen.find((c) => c.cmd !== shim && (/npm/.test(c.cmd) || c.args.some((a) => /npm-cli/.test(a))));
  assert.deepEqual(npm.args.filter((a) => !/npm-cli/.test(a)).slice(0, 3), ['install', '--prefix', path.join(dataDir, 'tools', 'codegraph')]);
  assert.ok(npm.args.includes('@colbymchenry/codegraph@1.6.2'));
  const tele = seen.find((c) => c.args[0] === 'telemetry');
  assert.deepEqual(tele.args, ['telemetry', 'off']);
  assert.equal(tele.env.DO_NOT_TRACK, '1');
  assert.ok(!seen.some((c) => c.args.includes('install') && c.cmd === shim), 'codegraph install (agent wiring) is never run');
  // Uninstall: the copy is gone and the extension is off; the setting says so.
  await s.uninstall('codegraph');
  assert.equal(fs.existsSync(path.join(dataDir, 'tools', 'codegraph')), false);
  const after = s.list().find((x) => x.id === 'codegraph');
  assert.equal(after.enabled, false);
  assert.equal(after.installed, false);
  assert.equal(s.codegraphReady(), false);
  await assert.rejects(s.uninstall('graphify'), /CodeGraph/);
});

test('agent 的規則：有索引才提到 CodeGraph；和 Graphify 圖譜都在時說明分工，並保留退路', async () => {
  const cfg = { graphify: { enabled: true }, codegraph: { enabled: true } };
  const { s, caps, shim } = extension(cfg);
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(shim, '');
  ext.setCapture(async (cmd) => (cmd === 'graphify' ? ok('graphify 0.9.95') : ok('1.6.2')));
  await s.init();
  for (let i = 0; i < 50 && !(s.codegraphReady() && s.graphifyReady()); i++) await sleep(20);
  const cwd = tmp();
  assert.doesNotMatch(caps.extraRules('executor', cwd), /CODEGRAPH/);
  fs.mkdirSync(path.join(cwd, '.codegraph'));
  fs.writeFileSync(path.join(cwd, '.codegraph', 'codegraph.db'), '');
  const one = caps.extraRules('executor', cwd);
  assert.match(one, /CODEGRAPH \(precise code index/);
  assert.match(one, /codegraph_callers/);
  assert.match(one, /If a CodeGraph tool fails/);
  assert.doesNotMatch(one, /both CodeGraph and a Graphify graph/);
  fs.mkdirSync(path.join(cwd, 'graphify-out'));
  fs.writeFileSync(path.join(cwd, 'graphify-out', 'graph.json'), '{}');
  const both = caps.extraRules('code_reviewer', cwd);
  assert.match(both, /both CodeGraph and a Graphify graph: use CodeGraph for precise code relations/);
  assert.match(both, /Graphify \(graph_query, graph_path, graph_explain\) for the overview/);
  assert.match(both, /fall back to normal source search/);
});

// ---------- the orchestrator offers and answers the tools ----------

const spec = (id) => ({ id, name: id, command: id, run: { args: [] }, output: 'text' });
test('agent 只在 CodeGraph 開著且資料夾有索引時拿到 CodeGraph 工具；開始時和 Graphify 一起更新，改檔後與結束時也更新', async () => {
  const dir = tmp();
  const cwd = path.join(dir, 'proj');
  fs.mkdirSync(cwd);
  const seen = [];
  let active = true;
  const codegraph = {
    active: () => active,
    indexed: (c) => fs.existsSync(path.join(c, '.codegraph', 'codegraph.db')),
    ensure: async (c, reason) => (seen.push(`ensure:${reason}`), { cwd: c, active: true, indexed: true, state: 'idle', files: 3, symbols: 42 }),
    schedule: (c, reason) => seen.push(`schedule:${reason}`),
    lookup: async (c, tool, a) => (seen.push(`lookup:${tool}:${JSON.stringify(a)}:${c === cwd}`), 'ANSWER'),
  };
  const ids = ['fake'];
  const orch = new Orchestrator({
    registry: { get: (id) => (ids.includes(id) ? spec(id) : undefined), quotaCaps: () => ({}), setQuotaCap() {}, list: () => ids.map((id) => ({ spec: spec(id), installed: true, auth: { state: 'logged_in' } })), specs: () => ids.map(spec), defaults: () => ({}), runAuth: async () => undefined, listModels: async () => [], noteContext: () => undefined },
    store: new RunStore(path.join(dir, 'home')),
    usage: { recordRun() {}, recordError() {}, recordUsage() {}, cachedSummary: () => [], summary: async (specs) => specs.map((x) => ({ providerId: x.id })) },
    capabilities: { serversFor: async () => [], skillsBlock: () => '', instructionsFor: () => undefined, skillsDir: dir },
    attachments: { prepare: async (a) => ({ attachments: a ?? [], warnings: [] }), adopt: (_id, a) => a ?? [], runDir: () => dir },
    dataDir: path.join(dir, 'home'),
    bridgePath: 'bridge.js',
    hubUrl: () => 'http://127.0.0.1:1',
    push: () => undefined,
    gpuQuery: () => {
      throw new Error('no GPU');
    },
    gpuSmi: () => {
      throw new Error('no GPU');
    },
    codegraph,
  });
  const offered = [];
  globalThis.__fakeAgent = async (o) => {
    const secret = o.bridge?.env?.AIVENUE_SESSION;
    offered.push(orch.toolsFor(secret).map((t) => t.name).filter((n) => n.startsWith('codegraph_')));
    if (offered.length === 2) offered.push(await orch.callTool(secret, 'codegraph_callers', { symbol: 'start' }));
    fs.writeFileSync(path.join(cwd, 'a.txt'), String(offered.length));
    o.onEvent({ seq: 1, ts: Date.now(), kind: 'tool', tool: { id: 'e1', name: 'apply_patch', category: 'edit', title: 'a.txt', status: 'ok', output: '' }, files: ['a.txt'] }, false);
    await orch.callTool(secret, 'submit_work', { summary: 'done' });
    return { lastSeq: 2, exitCode: 0, resumed: false, finalText: 'done' };
  };
  const config = { title: 't', goal: 'g', cwd, plan: { enabled: false, author: { provider: 'fake' }, reviewer: null, maxRounds: 1, humanGate: false }, implement: { enabled: true, author: { provider: 'fake' }, reviewer: null, maxRounds: 1, humanGate: false }, subagents: { enabled: false, allowed: [], maxDepth: 1, maxConcurrent: 1 }, verify: { enabled: false }, permission: 'auto' };
  const finished = async (id) => {
    for (let i = 0; i < 400 && ['running', 'paused'].includes(orch.runs.get(id).status); i++) await sleep(25);
    await orch.executions.get(id);
    return orch.runs.get(id);
  };
  const first = await finished(orch.start(config).id);
  assert.equal(first.status, 'completed', first.error);
  assert.deepEqual(offered[0], [], 'no index yet: no CodeGraph tools');
  assert.ok(first.log.some((l) => /CodeGraph 索引已更新：42 個符號|CodeGraph index updated: 42 symbols/.test(l.text)), first.log.map((l) => l.text).join('\n'));
  fs.mkdirSync(path.join(cwd, '.codegraph'));
  fs.writeFileSync(path.join(cwd, '.codegraph', 'codegraph.db'), '');
  const second = await finished(orch.start(config).id);
  assert.equal(second.status, 'completed', second.error);
  assert.deepEqual(offered[1], ['codegraph_explore', 'codegraph_node', 'codegraph_search', 'codegraph_callers', 'codegraph_callees', 'codegraph_impact']);
  assert.equal(offered[2], 'ANSWER');
  assert.ok(seen.includes('lookup:codegraph_callers:{"symbol":"start"}:true'));
  assert.deepEqual(seen.filter((x) => !x.startsWith('lookup')), ['ensure:start', 'schedule:edit', 'ensure:end', 'ensure:start', 'schedule:edit', 'ensure:end']);
  active = false;
  await finished(orch.start(config).id);
  assert.deepEqual(offered.at(-1), []);
});
