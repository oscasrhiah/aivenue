import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from './lib/test-shard.mjs';
import { build } from 'esbuild';

// The project graph Aivenue keeps (packages/core/src/graphify.ts): the real service and the real process helpers, with a
// stand-in `graphify` script; and the orchestrator's hooks (start, after a turn that changed files, end) with stand-in
// agents and a stand-in service.
const bundled = await build({
  stdin: {
    contents: `export { GraphifyService, parseRebuilt } from './packages/core/src/graphify';
      export { graphUsage, GRAPH_COMMAND, BUILD_COMMAND, SEARCH_COMMAND } from './packages/core/src/graphUsage';
      export { extensionSummary, extensionUse } from './packages/ui/src/extensionUse';
      export { mainPart } from './packages/ui/src/graphView';
      export { Orchestrator } from './packages/core/src/orchestrator';
      export { RunStore } from './packages/core/src/store';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent',
  plugins: [{ name: 'stand-in agent', setup(b) { b.onLoad({ filter: /[\\/]agentRunner\.ts$/ }, () => ({ contents: 'export async function runAgent(o) { return globalThis.__fakeAgent(o); }' })); } }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const { GraphifyService, parseRebuilt, Orchestrator, RunStore, mainPart, extensionSummary, extensionUse, graphUsage, GRAPH_COMMAND, BUILD_COMMAND, SEARCH_COMMAND } = mod.exports;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-graphify-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The stand-in graphify: `update <dir>`; what it does comes from <dir>/stub.json; every start and end is logged in
// <dir>/calls.log, so overlapping builds would show.
const stubDir = tmp();
const STUB = path.join(stubDir, 'graphify-stub.cjs');
fs.writeFileSync(
  STUB,
  `const fs = require('fs'), path = require('path');
const [cmd, dir] = process.argv.slice(2);
if (cmd === 'query' || cmd === 'path' || cmd === 'explain') {
  const rest = process.argv.slice(3);
  if (rest[0] === 'ambiguous') { console.log('Ambiguous: alpha, alpha2'); process.exit(3); }
  console.log('NODE ' + cmd + ':' + rest.join('|') + ' cwd=' + path.basename(process.cwd()) + ' ' + 'x'.repeat(Number(process.env.STUB_LONG || 0)));
  process.exit(0);
}
if (cmd !== 'update') process.exit(9);
let ctl = {};
try { ctl = JSON.parse(fs.readFileSync(path.join(dir, 'stub.json'), 'utf8')); } catch {}
const log = path.join(dir, 'calls.log');
fs.appendFileSync(log, 'start ' + Date.now() + '\\n');
const finish = (code) => { fs.appendFileSync(log, 'end ' + Date.now() + '\\n'); process.exit(code); };
console.log('Re-extracting code files in ' + dir + ' (no LLM needed)...');
setTimeout(() => {
  const mode = ctl.mode || 'ok';
  if (mode === 'hang') return setInterval(() => {}, 1000);
  if (mode === 'fail') { console.error('boom: the parser crashed'); return finish(2); }
  if (mode === 'refuse') {
    console.error('[graphify] WARNING: new graph has 3 nodes but existing graph.json has 9. Refusing to overwrite — you may be missing chunk files. Pass --force to override.');
    console.error('Nothing to update or rebuild failed — check output above.');
    return finish(1);
  }
  const n = ctl.nodes || 7;
  const nodes = Array.from({ length: n }, (_, i) => ({ id: 'n' + i, label: 'node' + i, community: i % 2, community_name: 'c' + (i % 2), file_type: 'code', source_file: 'src/f' + i + '.ts', source_location: 'L' + (i + 1) }));
  const links = nodes.slice(1).map((x, i) => ({ source: 'n0', target: x.id, relation: 'calls' }));
  fs.mkdirSync(path.join(dir, 'graphify-out'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'graphify-out', 'graph.json'), JSON.stringify({ directed: true, graph: { graphify_version: '0.0-stub' }, nodes, links }));
  if (!ctl.noLine) console.log('[graphify watch] Rebuilt: ' + n + ' nodes, ' + links.length + ' edges, 2 communities');
  finish(0);
}, ctl.delayMs ?? 30);
`,
);

function project(ctl = {}, { git } = {}) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'stub.json'), JSON.stringify(ctl));
  if (git) execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}
const calls = (dir) => {
  try {
    return fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
function service(o = {}) {
  const pushed = [];
  const s = new GraphifyService({ active: () => o.active ?? true, onChange: (st) => pushed.push(st), command: STUB, timeoutMs: o.timeoutMs, debounceMs: o.debounceMs, home: o.home ?? path.join(os.tmpdir(), 'not-the-home'), log: () => undefined });
  return { s, pushed };
}

test('Rebuilt 行讀出節點、邊與群組數', () => {
  assert.deepEqual(parseRebuilt('[graphify watch] Rebuilt: 581 nodes, 2484 edges, 20 communities'), { nodes: 581, edges: 2484, communities: 20 });
  assert.deepEqual(parseRebuilt('Rebuilt: 1 node, 0 edges'), { nodes: 1, edges: 0, communities: undefined });
  assert.equal(parseRebuilt('Nothing to update'), undefined);
});

test('同一個資料夾一次只建一個；建立中再要求的合成一次後續建立', async () => {
  const dir = project({ delayMs: 300 });
  const { s, pushed } = service();
  const first = s.ensure(dir, 'start');
  await sleep(50);
  const b = s.ensure(dir, 'edit');
  const c = s.ensure(dir, 'edit');
  const d = s.ensure(dir, 'rebuild');
  assert.equal(b, c);
  assert.equal(c, d);
  const r1 = await first;
  assert.equal(r1.state, 'idle');
  // The follow-up has not ended when the first did.
  assert.equal(calls(dir).filter((l) => l.startsWith('end')).length, 1);
  const r2 = await d;
  assert.equal(r2.state, 'idle');
  assert.equal(r2.reason, 'edit');
  const log = calls(dir);
  assert.equal(log.length, 4, log.join('\n'));
  assert.deepEqual(log.map((l) => l.split(' ')[0]), ['start', 'end', 'start', 'end']);
  // Each build was said as building and then as done.
  assert.deepEqual(pushed.filter((p) => p.cwd === path.resolve(dir)).map((p) => p.state), ['building', 'idle', 'building', 'idle']);
  // Nothing waits any more: the next request starts a build at once.
  await s.ensure(dir, 'end');
  assert.equal(calls(dir).length, 6);
});

test('狀態：建好後有節點、邊、群組數與時間；沒有 Rebuilt 行時從 graph.json 讀', async () => {
  const dir = project({ nodes: 9 });
  const { s } = service();
  const st = await s.ensure(dir, 'start');
  assert.equal(st.state, 'idle');
  assert.equal(st.exists, true);
  assert.equal(st.active, true);
  assert.equal(st.nodes, 9);
  assert.equal(st.edges, 8);
  assert.equal(st.communities, 2);
  assert.ok(st.builtAt > Date.now() - 60000);
  const dir2 = project({ nodes: 5, noLine: true });
  const st2 = await s.ensure(dir2, 'start');
  assert.equal(st2.nodes, 5);
  assert.equal(st2.edges, 4);
  assert.equal(st2.communities, 2);
  // A hub that did not build it: the counts once graph.json is read (said in a push).
  const fresh = service();
  const before = fresh.s.status(dir);
  assert.equal(before.exists, true);
  assert.ok(before.builtAt);
  await sleep(200);
  assert.equal(fresh.pushed.at(-1)?.nodes, 9);
  assert.equal(fresh.s.status(dir).nodes, 9);
});

test('逾時與失敗：狀態是 failed，說出原因；圖譜外掛沒開時不執行', async () => {
  const hang = project({ mode: 'hang' });
  const { s } = service({ timeoutMs: 500 });
  const t = await s.ensure(hang, 'start');
  assert.equal(t.state, 'failed');
  assert.match(t.lastError, /沒有完成|did not finish/);
  const bad = project({ mode: 'fail' });
  const f = await s.ensure(bad, 'start');
  assert.equal(f.state, 'failed');
  assert.match(f.lastError, /boom: the parser crashed/);
  assert.equal(f.exists, false);
  const off = project();
  const o = service({ active: false });
  const st = await o.s.ensure(off, 'start');
  assert.equal(st.active, false);
  assert.equal(st.state, 'idle');
  assert.deepEqual(calls(off), []);
  o.s.schedule(off);
  assert.equal(o.s.scheduled(off), false);
});

test('節點變少被 graphify 拒絕覆寫：狀態是 refused，原本的圖譜不動，也不自動加 --force', async () => {
  const dir = project({ nodes: 9 });
  const { s } = service();
  await s.ensure(dir, 'start');
  const before = fs.readFileSync(path.join(dir, 'graphify-out', 'graph.json'), 'utf8');
  fs.writeFileSync(path.join(dir, 'stub.json'), JSON.stringify({ mode: 'refuse' }));
  const r = await s.ensure(dir, 'edit');
  assert.equal(r.state, 'refused');
  assert.match(r.lastError, /--force/);
  assert.match(r.lastError, /Refusing to overwrite/);
  assert.equal(fs.readFileSync(path.join(dir, 'graphify-out', 'graph.json'), 'utf8'), before);
  // The graph it kept still counts.
  assert.equal(r.exists, true);
});

test('git 專案：建好後把 graphify-out/ 加進本機的 exclude 檔一次，不改 .gitignore', async () => {
  const dir = project({}, { git: true });
  const exclude = path.join(dir, '.git', 'info', 'exclude');
  const had = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.writeFileSync(exclude, had + 'mine.log'); // no newline at the end
  const { s } = service();
  await s.ensure(dir, 'start');
  await s.ensure(dir, 'edit');
  // Another hub (Aivenue restarted) finds it already there.
  await service().s.ensure(dir, 'start');
  const text = fs.readFileSync(exclude, 'utf8');
  assert.equal(text.match(/^graphify-out\/$/gm)?.length, 1, text);
  assert.match(text, /^mine\.log$/m);
  assert.equal(fs.existsSync(path.join(dir, '.gitignore')), false);
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' });
  assert.doesNotMatch(status, /graphify-out/);
  // Not a git folder: nothing written, no error.
  const plain = project();
  assert.equal((await s.ensure(plain, 'start')).state, 'idle');
});

test('不為磁碟根目錄或家目錄建立圖譜，並說明原因', async () => {
  const home = project();
  const { s } = service({ home });
  const h = await s.ensure(home, 'start');
  assert.equal(h.state, 'failed');
  assert.match(h.lastError, /家目錄|home folder/);
  assert.deepEqual(calls(home), []);
  const root = path.parse(home).root;
  const r = await s.ensure(root, 'start');
  assert.equal(r.state, 'failed');
  assert.match(r.lastError, /整個磁碟|whole drive/);
  s.schedule(root);
  assert.equal(s.scheduled(root), false);
});

test('改檔後的更新延後合併：連續幾次只建一次', async () => {
  const dir = project();
  const { s } = service({ debounceMs: 150 });
  s.schedule(dir);
  await sleep(50);
  s.schedule(dir);
  s.schedule(dir);
  assert.equal(s.scheduled(dir), true);
  await sleep(600);
  assert.equal(s.scheduled(dir), false);
  assert.equal(calls(dir).filter((l) => l.startsWith('start')).length, 1);
  // An update asked for directly takes the place of one still waiting.
  s.schedule(dir);
  await s.ensure(dir, 'end');
  assert.equal(s.scheduled(dir), false);
  await sleep(300);
  assert.equal(calls(dir).filter((l) => l.startsWith('start')).length, 2);
});

test('給視窗的圖：太大時只送連結最多的節點與它們之間的連線，並說出總數', async () => {
  const dir = project({ nodes: 30 });
  const { s } = service();
  await s.ensure(dir, 'start');
  const all = await s.graph(dir);
  assert.equal(all.capped, false);
  assert.equal(all.nodes.length, 30);
  assert.equal(all.totalNodes, 30);
  assert.equal(all.graphifyVersion, '0.0-stub');
  assert.equal(all.nodes.find((n) => n.id === 'n0').degree, 29);
  assert.equal(all.nodes[3].source_location, 'L4');
  const part = await s.graph(dir, 10);
  assert.equal(part.capped, true);
  assert.equal(part.nodes.length, 10);
  assert.equal(part.totalNodes, 30);
  assert.equal(part.totalLinks, 29);
  assert.ok(part.nodes.some((n) => n.id === 'n0'));
  const kept = new Set(part.nodes.map((n) => n.id));
  assert.ok(part.links.every((l) => kept.has(l.source) && kept.has(l.target)));
  assert.equal(part.links.length, 9);
  await assert.rejects(s.graph(project()), /還沒有圖譜|no graph yet/);
});

// ---------- the orchestrator's hooks ----------

const spec = (id) => ({ id, name: id, command: id, run: { args: [] }, output: 'text' });
function orchestrator(graphify, graphifyWaitMs) {
  const dir = tmp();
  const cwd = path.join(dir, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const ids = ['fake'];
  const orch = new Orchestrator({
    registry: { get: (id) => (ids.includes(id) ? spec(id) : undefined), quotaCaps: () => ({}), setQuotaCap() {}, list: () => ids.map((id) => ({ spec: spec(id), installed: true, auth: { state: 'logged_in' } })), specs: () => ids.map(spec), defaults: () => ({}), runAuth: async () => undefined, listModels: async () => [], noteContext: () => undefined },
    store: new RunStore(path.join(dir, 'home')),
    usage: { recordRun() {}, recordError() {}, recordUsage() {}, cachedSummary: () => [], summary: async (specs) => specs.map((s) => ({ providerId: s.id })) },
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
    graphify,
    graphifyWaitMs,
  });
  return { orch, cwd };
}
const config = (cwd) => ({
  title: 't',
  goal: 'change a file',
  cwd,
  plan: { enabled: false, author: { provider: 'fake' }, reviewer: null, maxRounds: 1, humanGate: false },
  implement: { enabled: true, author: { provider: 'fake' }, reviewer: null, maxRounds: 1, humanGate: false },
  subagents: { enabled: false, allowed: [], maxDepth: 1, maxConcurrent: 1 },
  verify: { enabled: false },
  permission: 'auto',
});
async function finished(orch, id) {
  const end = Date.now() + 20000;
  while (['running', 'paused'].includes(orch.runs.get(id).status)) {
    if (Date.now() > end) throw new Error('still running');
    await sleep(30);
  }
  await orch.executions.get(id);
  return orch.runs.get(id);
}
/** The executor writes a file with its edit tool, then hands in its work. */
function agents(order) {
  globalThis.__fakeAgent = async (o) => {
    order.push('agent');
    if (o.edits !== false) {
      fs.writeFileSync(path.join(o.cwd, 'a.txt'), 'x');
      o.onEvent({ seq: 1, ts: Date.now(), kind: 'tool', tool: { id: 'e1', name: 'apply_patch', category: 'edit', title: 'a.txt', status: 'ok', output: '' }, files: ['a.txt'] }, false);
    }
    await o.orch.callTool(o.bridge?.env?.AIVENUE_SESSION, 'submit_work', { summary: 'done' });
    return { lastSeq: 2, exitCode: 0, resumed: false, finalText: 'done' };
  };
}

test('工作流開始時先更新圖譜，等它完成才讓第一個 agent 開始；改檔後在背景排更新，結束時再更新一次', async () => {
  const order = [];
  const seen = [];
  const graphify = {
    active: () => true,
    ensure: async (cwd, reason) => {
      seen.push(['ensure', reason, cwd]);
      if (reason === 'start') {
        await sleep(150);
        order.push('graph built');
      }
      return { cwd, state: 'idle', active: true, exists: true, nodes: 42, edges: 50, communities: 3 };
    },
    schedule: (cwd, reason) => seen.push(['schedule', reason, cwd]),
  };
  const { orch, cwd } = orchestrator(graphify);
  agents(order);
  const run = orch.start(config(cwd));
  const pass = globalThis.__fakeAgent;
  globalThis.__fakeAgent = (o) => pass({ ...o, cwd, orch });
  const done = await finished(orch, run.id);
  assert.equal(done.status, 'completed', done.error);
  assert.deepEqual(order.slice(0, 2), ['graph built', 'agent']);
  assert.ok(done.log.some((l) => /專案圖譜已更新：42 個節點|Project graph updated: 42 nodes/.test(l.text)), done.log.map((l) => l.text).join('\n'));
  // Quiet lines: in the run log, not in the chat.
  assert.ok(done.log.filter((l) => /圖譜|graph/i.test(l.text)).every((l) => !l.chat));
  assert.deepEqual(seen.map(([k, r]) => `${k}:${r}`), ['ensure:start', 'schedule:edit', 'ensure:end']);
  assert.ok(seen.every(([, , c]) => c === cwd));
});

test('圖譜更新太久：等到上限就讓 agent 先開始，更新在背景完成後再記一行', async () => {
  const order = [];
  let release;
  const graphify = {
    active: () => true,
    ensure: (cwd, reason) => (reason === 'start' ? new Promise((r) => (release = () => r({ cwd, state: 'idle', active: true, exists: true, nodes: 7 }))) : Promise.resolve({ cwd, state: 'idle', active: true, exists: true })),
    schedule: () => undefined,
  };
  const { orch, cwd } = orchestrator(graphify, 100);
  agents(order);
  const pass = globalThis.__fakeAgent;
  globalThis.__fakeAgent = (o) => pass({ ...o, cwd, orch, edits: false });
  const t0 = Date.now();
  const run = orch.start(config(cwd));
  const done = await finished(orch, run.id);
  assert.equal(done.status, 'completed', done.error);
  assert.ok(Date.now() - t0 < 5000);
  assert.deepEqual(order, ['agent']);
  assert.ok(done.log.some((l) => /還在更新|still updating/.test(l.text)));
  release();
  await sleep(50);
  assert.ok(orch.runs.get(run.id).log.some((l) => /專案圖譜已更新：7 個節點|Project graph updated: 7 nodes/.test(l.text)));
});

test('Graphify 沒開：工作流不碰圖譜', async () => {
  const seen = [];
  const graphify = { active: () => false, ensure: async () => seen.push('ensure'), schedule: () => seen.push('schedule') };
  const { orch, cwd } = orchestrator(graphify);
  agents([]);
  const pass = globalThis.__fakeAgent;
  globalThis.__fakeAgent = (o) => pass({ ...o, cwd, orch });
  const run = orch.start(config(cwd));
  const done = await finished(orch, run.id);
  assert.equal(done.status, 'completed', done.error);
  assert.deepEqual(seen, []);
  assert.ok(!done.log.some((l) => /圖譜/.test(l.text)));
});

test('hub 的圖譜方法只接受對話的工作資料夾', () => {
  const { orch, cwd } = orchestrator(undefined);
  assert.equal(orch.isRunFolder(cwd), false);
  orch.runs.set('r1', { id: 'r1', config: { cwd }, agents: {}, log: [] });
  assert.equal(orch.isRunFolder(cwd), true);
  assert.equal(orch.isRunFolder(path.join(cwd, '..')), false);
  orch.runs.set('r2', { id: 'r2', config: { cwd: path.join(cwd, 'copy') }, worktree: { origCwd: path.join(cwd, 'orig'), cwd: path.join(cwd, 'copy') }, agents: {}, log: [] });
  assert.equal(orch.isRunFolder(path.join(cwd, 'orig')), true);
  if (process.platform === 'win32') assert.equal(orch.isRunFolder(cwd.toUpperCase()), true);
});

// ---------- the graph tools agents get, and how much each agent used the graph ----------

test('查圖次數的規則和 graphify-usage.mjs 一樣（包含它自己的檢查）', () => {
  // The script's own assertions.
  assert.ok(GRAPH_COMMAND.test('cd x && graphify query "a"') && !GRAPH_COMMAND.test('echo graphify-out/x') && BUILD_COMMAND.test('graphify update .'));
  assert.ok(SEARCH_COMMAND.test('git log | grep x') && !SEARCH_COMMAND.test('npm test'));
  assert.ok(GRAPH_COMMAND.test('graphify.exe explain "Hub"') && GRAPH_COMMAND.test('(graphify path "A" "B")'));
  assert.ok(!GRAPH_COMMAND.test('mygraphify query x') && !BUILD_COMMAND.test('graphify updater'));
  const tool = (id, category, title, extra = {}) => ({ kind: 'tool', tool: { id, name: extra.name ?? 'bash', category, title, status: 'ok', ...extra } });
  const events = [
    tool('1', 'command', 'rg startHub'),
    tool('2', 'read', 'src/hub.ts'),
    // The same call twice: its last version counts (here it became a graph query).
    tool('3', 'command', 'npm test'),
    tool('3', 'command', 'x', { input: JSON.stringify({ command: 'graphify query "who calls startHub"' }) }),
    tool('4', 'search', 'Grep: push'),
    tool('5', 'command', 'graphify update .'),
    tool('6', 'hub', 'Query the graph: hub', { name: 'mcp__aivenue__graph_query' }),
    tool('7', 'command', 'npm test'),
    tool('8', 'edit', 'src/a.ts'),
    { kind: 'message', text: 'hi' },
  ];
  assert.deepEqual(graphUsage(events), { graph: 2, build: 1, search: 3, before: 2 });
  // Never looked anything up: every search is "before" (the window shows — instead).
  assert.deepEqual(graphUsage([tool('1', 'command', 'cat a.txt'), tool('2', 'read', 'b')]), { graph: 0, build: 0, search: 2, before: 2 });
  // Aivenue's graph tools by their plain name too; other hub tools are not lookups.
  assert.equal(graphUsage([tool('1', 'hub', 'x', { name: 'graph_explain' }), tool('2', 'hub', 'x', { name: 'read_context' })]).graph, 1);
  assert.deepEqual(graphUsage([]), { graph: 0, build: 0, search: 0, before: 0 });
});

test('查圖工具：在資料夾裡執行 graphify query／path／explain 並回傳文字；名稱不明確時照樣回答', async () => {
  const dir = project();
  const { s } = service();
  assert.match(await s.lookup(dir, ['query', 'who calls hub']), new RegExp(`NODE query:who calls hub cwd=${path.basename(dir)}`));
  assert.match(await s.lookup(dir, ['path', 'A', 'B']), /NODE path:A\|B/);
  assert.match(await s.lookup(dir, ['explain', 'ambiguous']), /Ambiguous[\s\S]*exit 3/);
  assert.match(await s.lookup(dir, ['explain', ' ']), /Give the name/);
  process.env.STUB_LONG = '40000';
  try {
    const long = await s.lookup(dir, ['query', 'q']);
    assert.ok(long.length < 17000);
    assert.match(long, /more characters cut/);
  } finally {
    delete process.env.STUB_LONG;
  }
  const broken = new GraphifyService({ active: () => true, onChange() {}, command: path.join(dir, 'no-such-graphify.cjs') });
  assert.match(await broken.lookup(dir, ['query', 'q']), /Fall back to normal source search/);
});

test('agent 只在資料夾有圖譜且 Graphify 開著時拿到查圖工具，呼叫會在工作資料夾查', async () => {
  const looked = [];
  let active = true;
  const graphify = {
    active: () => active,
    ensure: async (cwd) => ({ cwd, state: 'idle', active: true, exists: true }),
    schedule: () => undefined,
    lookup: async (cwd, args) => (looked.push([cwd, ...args]), 'NODE hub [src=src/hub.ts loc=L1]'),
  };
  const { orch, cwd } = orchestrator(graphify);
  const seen = [];
  globalThis.__fakeAgent = async (o) => {
    const secret = o.bridge?.env?.AIVENUE_SESSION;
    seen.push(orch.toolsFor(secret).map((t) => t.name).filter((n) => n.startsWith('graph_')));
    if (seen.length === 2) seen.push(await orch.callTool(secret, 'graph_query', { question: 'who calls hub' }), await orch.callTool(secret, 'graph_path', { from: 'a', to: 'b' }), await orch.callTool(secret, 'graph_explain', { node: 'hub' }));
    await orch.callTool(secret, 'submit_work', { summary: 'done' });
    return { lastSeq: 1, exitCode: 0, resumed: false, finalText: 'done' };
  };
  const first = await finished(orch, orch.start(config(cwd)).id);
  assert.equal(first.status, 'completed', first.error);
  // No graph in the folder yet: no graph tools.
  assert.deepEqual(seen[0], []);
  fs.mkdirSync(path.join(cwd, 'graphify-out'));
  fs.writeFileSync(path.join(cwd, 'graphify-out', 'graph.json'), '{"nodes":[],"links":[]}');
  const second = await finished(orch, orch.start(config(cwd)).id);
  assert.equal(second.status, 'completed', second.error);
  assert.deepEqual(seen[1], ['graph_query', 'graph_path', 'graph_explain']);
  assert.equal(seen[2], 'NODE hub [src=src/hub.ts loc=L1]');
  assert.deepEqual(looked, [[cwd, 'query', 'who calls hub'], [cwd, 'path', 'a', 'b'], [cwd, 'explain', 'hub']]);
  // Graphify turned off: gone again, even with the graph there.
  active = false;
  await finished(orch, orch.start(config(cwd)).id);
  assert.deepEqual(seen.at(-1), []);
});

test('回合標頭的 Graphify 次數也算 Aivenue 的查圖工具', () => {
  const ev = (id, tool) => ({ seq: Number(id), ts: 1, kind: 'tool', tool: { id, status: 'ok', output: '', ...tool } });
  const events = [ev('1', { name: 'mcp__aivenue__graph_query', category: 'hub', title: 'Query the graph: who calls hub' }), ev('2', { name: 'bash', category: 'command', title: 'graphify path "A" "B"' }), ev('3', { name: 'read_context', category: 'hub', title: 'Read context' })];
  assert.equal(extensionSummary(events).graphify, 2);
  assert.deepEqual(extensionUse(events[0]), { kind: 'graphify', action: 'query', arg: 'who calls hub' });
});

test('圖譜視窗第一次縮放到最大的相連部分，零散的小群組不算', () => {
  const n = (id) => ({ id, label: id, degree: 0 });
  const nodes = ['a', 'b', 'c', 'd', 'x', 'y', 'z'].map(n);
  const links = [
    { source: 'a', target: 'b', relation: 'calls' },
    { source: 'c', target: 'b', relation: 'calls' },
    { source: 'd', target: 'c', relation: 'imports' },
    { source: 'x', target: 'y', relation: 'calls' },
    { source: 'a', target: 'gone', relation: 'calls' },
  ];
  assert.deepEqual(mainPart({ nodes, links }), ['a', 'b', 'c', 'd']);
  assert.deepEqual(mainPart({ nodes: [n('solo')], links: [] }), ['solo']);
  assert.deepEqual(mainPart({ nodes: [], links: [] }), []);
});

test('OpenCode 的程式碼模式一次呼叫好幾個工具：裡面的查圖工具也算查圖', () => {
  const code = (c) => JSON.stringify({ code: c });
  const tool = (id, category, name, input) => ({ kind: 'tool', tool: { id, name, category, title: name, status: 'ok', input } });
  // As seen in a real OpenCode run: the event is named after its first tool (report_progress).
  const events = [
    tool('1', 'read', 'read', '{}'),
    tool('2', 'hub', 'report_progress', code('const [p1,p2] = await Promise.all([ tools.aivenue.report_progress({step_id:"1"}), tools.aivenue.graph_query({question:"where"}) ]);')),
    tool('3', 'other', 'execute', code('await tools.aivenue.graph_path({from:"a",to:"b"}); await tools.aivenue.graph_explain({node:"x"});')),
    tool('4', 'hub', 'search_records', code('await tools.aivenue.search_records({q:"graph_query"})')),
    tool('5', 'search', 'grep', '{}'),
  ];
  assert.deepEqual(graphUsage(events), { graph: 3, build: 0, search: 2, before: 1 });
  assert.equal(extensionSummary(events).graphify, 3);
});
