import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from './lib/test-shard.mjs';
import { build } from 'esbuild';

/*
 * Every VS Code window shares one hub (packages/vscode/src/daemon.ts): one record of the chats, live in every window,
 * and one runner per workflow. These tests run the real hub (its WebSocket, OS lock and operation log) with windows
 * played by sockets: a control channel (packages/vscode/src/sharedHub.ts, as the extension opens it) and a webview
 * connection each. Agents are stand-ins; no CLI or model runs.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A provider list with one stand-in that is always ready. */
const FAKE_REGISTRY = `
const spec = (id) => ({ id, name: id, command: id, run: { args: [] }, output: 'text' });
export const accountEnv = () => ({});
export const installLine = (name, cmd) => cmd;
export const posixInstallLine = (cmd) => cmd;
export class ProviderRegistry {
  constructor(dataDir, secrets) {
    this.secrets = secrets;
    this.ready = Promise.resolve(secrets.keys()).then(() => undefined);
  }
  get secureSecrets() { return true; }
  list() { return ['fake'].map((id) => ({ spec: spec(id), builtin: false, customized: false, installed: true, auth: { state: 'logged_in', checkedAt: 1 }, authMode: 'cli', hasApiKey: false, modelsVersion: 0 })); }
  specs() { return ['fake'].map(spec); }
  get(id) { return id === 'fake' ? spec(id) : undefined; }
  defaults() { return {}; }
  async checkAll() {}
  async checkAuth() { return { state: 'logged_in', checkedAt: 1 }; }
  async settledAuth() { return { state: 'logged_in', checkedAt: 1 }; }
  quotaCaps() { return {}; }
  setQuotaCap() {}
  async listModels() { return []; }
  noteContext() {}
  async runAuth() {}
  forgetModels() {}
}`;
/** GitHub status without running git or gh. */
const FAKE_GITHUB = `
export class GithubService {
  constructor() {}
  async check() { return this.status(); }
  status() { return { git: { installed: false }, gh: { installed: false }, auth: { loggedIn: false }, gitCredential: false, checkedAt: 0 }; }
  promptInfo() { return undefined; }
  getToken() { return undefined; }
}`;
const fakes = {
  name: 'fakes',
  setup(b) {
    b.onLoad({ filter: /[\\/]core[\\/]src[\\/]agentRunner\.ts$/ }, () => ({ contents: 'export async function runAgent(o) { return globalThis.__fakeAgent(o); }', loader: 'js' }));
    b.onLoad({ filter: /[\\/]core[\\/]src[\\/]providers[\\/]registry\.ts$/ }, () => ({ contents: FAKE_REGISTRY, loader: 'js' }));
    b.onLoad({ filter: /[\\/]core[\\/]src[\\/]github\.ts$/ }, () => ({ contents: FAKE_GITHUB, loader: 'js' }));
  },
};
const common = { bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', external: ['bufferutil', 'utf-8-validate'], plugins: [fakes] };

const bundled = await build({
  ...common,
  stdin: {
    contents: `export { startHub, HubBusyError, WindowRegistry } from './packages/core/src/index';
export { ensureHub, openChannel, readEndpoint, endpointFile } from './packages/vscode/src/sharedHub';
export { holdOsLock, lockName } from './packages/core/src/osLock';`,
    resolveDir: root,
  },
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', '__dirname', bundled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports, root);
const { startHub, HubBusyError, WindowRegistry, ensureHub, openChannel, readEndpoint, endpointFile, holdOsLock, lockName } = mod.exports;

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `aivenue-share-${name}-`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(40);
  }
}

/** A UI folder with an index.html (the hub serves it; these tests only use the socket). */
const uiDir = tmp('ui');
fs.writeFileSync(path.join(uiDir, 'index.html'), '<html><head></head><body></body></html>');

/** The shared VS Code hub, in this process (what daemon.ts starts in its own). */
async function sharedHub(dir) {
  const windows = new WindowRegistry();
  const hub = await startHub({ uiDir, bridgePath: path.join(root, 'bridge.cjs'), dataDir: dir, version: 'test', secrets: windows.secretStore({}), hooks: windows.hooks(), windows });
  return { hub, windows, ep: { port: hub.port, token: hub.token, pid: process.pid, build: 'test', version: 'test', startedAt: Date.now() } };
}

/** A VS Code window's control channel: its project folder, and what the hub asked it to do. */
async function windowOf(ep, id, cwd) {
  // A window's project folder exists.
  fs.mkdirSync(cwd, { recursive: true });
  const asked = [];
  const ch = await openChannel(ep, id, {
    pickFolder: () => (asked.push('pickFolder'), path.join(cwd, 'picked')),
    pickFiles: () => (asked.push('pickFiles'), []),
    openPath: (p) => void asked.push(`openPath ${p}`),
    openExternal: (u) => void asked.push(`openExternal ${u}`),
    openTerminal: () => void asked.push('openTerminal'),
    'secrets.set': (k) => void asked.push(`secrets.set ${k}`),
    'secrets.delete': (k) => void asked.push(`secrets.delete ${k}`),
  });
  ch.state({ cwd });
  await sleep(30);
  return { ch, asked, cwd, id };
}

/** A window's webview: RPC calls (each with an operation id, as the UI sends them) and the pushes it receives. */
class View {
  constructor(ep, windowId) {
    this.ep = ep;
    this.windowId = windowId;
    this.seq = 0;
    this.pending = new Map();
    this.pushes = [];
    this.open();
  }
  open() {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.ep.port}/ws?token=${this.ep.token}&window=${encodeURIComponent(this.windowId)}`);
    this.ready = new Promise((r, j) => {
      this.ws.onopen = r;
      this.ws.onerror = j;
    });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.push) return void this.pushes.push(m.push);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
    };
  }
  /** `op`: the operation id (default: a new one per call, as the UI makes them). */
  async call(method, params = {}, op = `${this.windowId}-${++this.seq}`) {
    await this.ready;
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, op }));
    });
  }
  /** Send without waiting for the answer (it may be lost: the socket closes right after). */
  async fire(method, params, op) {
    await this.ready;
    this.ws.send(JSON.stringify({ id: ++this.seq, method, params, op }));
  }
  last(topic) {
    return [...this.pushes].reverse().find((p) => p.topic === topic)?.data;
  }
  close() {
    this.ws.close();
  }
  async reconnect() {
    this.open();
    await this.ready;
  }
}

const cfg = (cwd, over = {}) => ({
  title: 'shared',
  goal: 'do it',
  cwd,
  plan: { enabled: false, author: { provider: 'fake' }, reviewer: null, maxRounds: 1, humanGate: false },
  implement: { enabled: true, author: { provider: 'fake' }, reviewer: null, maxRounds: 1, humanGate: false },
  subagents: { enabled: false, allowed: [], maxDepth: 1, maxConcurrent: 1 },
  permission: 'auto',
  memory: { mode: 'off' },
  ...over,
});

/**
 * Stand-in implementer: each turn is recorded; `hold` keeps a turn going until released (as a long job); then it hands
 * in its work through the hub's tool API.
 */
function agents(hub, o = {}) {
  const turns = [];
  let release;
  const released = new Promise((r) => (release = r));
  globalThis.__fakeAgent = async (opts) => {
    const n = turns.push({ prompt: opts.prompt }) ;
    const secret = opts.bridge?.env?.AIVENUE_SESSION;
    const done = { lastSeq: (opts.seqStart ?? 0) + 1, exitCode: 0, resumed: false, finalText: 'done' };
    if (o.turn) {
      const r = await o.turn(n, opts, secret);
      if (r) return r;
      return done;
    }
    if (o.hold) await Promise.race([released, new Promise((r) => opts.signal?.addEventListener('abort', r))]);
    if (opts.signal?.aborted) return { ...done, exitCode: 1, finalText: '', error: 'Cancelled' };
    await hub.orchestrator.callTool(secret, 'submit_work', { summary: `turn ${n}` });
    return done;
  };
  return { turns, release: () => release() };
}
const status = async (view, id) => (await view.call('workflows.get', { id }))?.status;

test('兩個 VS Code 視窗同時開著：同一份對話清單、即時同步；工作只由共用的 hub 執行一次', async () => {
  const dir = tmp('two');
  const { hub, ep } = await sharedHub(dir);
  try {
    const a = await windowOf(ep, 'win-a', path.join(dir, 'projA'));
    const b = await windowOf(ep, 'win-b', path.join(dir, 'projB'));
    const va = new View(ep, a.id);
    const vb = new View(ep, b.id);
    const fake = agents(hub, { hold: true });
    const id = await va.call('workflows.start', { config: cfg(a.cwd) });
    // B sees it at once, running.
    await until(() => vb.last('workflows')?.some((w) => w.id === id), 'B to see the new chat');
    assert.equal(await status(vb, id), 'running');
    assert.equal(hub.status().windows, 2);
    fake.release();
    await until(async () => (await status(va, id)) === 'completed', 'completion');
    await until(() => vb.last('workflows')?.find((w) => w.id === id)?.status === 'completed', 'B to see it completed');
    assert.equal(fake.turns.length, 1, 'one run of the agent');
    // Both list the same chats.
    assert.deepEqual((await va.call('workflows.list')).map((w) => w.id), (await vb.call('workflows.list')).map((w) => w.id));
  } finally {
    await hub.close();
  }
});

test('第二個視窗晚加入：看到進行中的工作，不把它標成中斷、不重跑；也不能再起第二個 VS Code hub', async () => {
  const dir = tmp('late');
  const { hub, ep } = await sharedHub(dir);
  try {
    const a = await windowOf(ep, 'win-a', path.join(dir, 'projA'));
    const va = new View(ep, a.id);
    const fake = agents(hub, { hold: true });
    const id = await va.call('workflows.start', { config: cfg(a.cwd) });
    await until(() => fake.turns.length === 1, 'the agent to start');
    // A second window joins while it runs.
    const b = await windowOf(ep, 'win-b', path.join(dir, 'projB'));
    const vb = new View(ep, b.id);
    assert.equal(await status(vb, id), 'running');
    assert.ok((await vb.call('workflows.list')).some((w) => w.id === id && w.status === 'running'));
    // What the old per-window hubs did: a second hub for the same data folder. Refused, so nothing is run twice.
    const windows = new WindowRegistry();
    await assert.rejects(startHub({ uiDir, bridgePath: 'x', dataDir: dir, secrets: windows.secretStore({}), hooks: windows.hooks(), windows }), (e) => e instanceof HubBusyError);
    await sleep(3500); // past the hub's auto-resume
    assert.equal(fake.turns.length, 1);
    fake.release();
    await until(async () => (await status(vb, id)) === 'completed', 'completion');
    assert.equal(fake.turns.length, 1, 'still one run');
  } finally {
    await hub.close();
  }
});

test('在另一個視窗回答 agent 的問題：交給執行者、兩邊同步；另一個視窗再回答被拒，重送同一個操作只算一次', async () => {
  const dir = tmp('answer');
  const { hub, ep } = await sharedHub(dir);
  try {
    const a = await windowOf(ep, 'win-a', path.join(dir, 'projA'));
    const b = await windowOf(ep, 'win-b', path.join(dir, 'projB'));
    const va = new View(ep, a.id);
    const vb = new View(ep, b.id);
    const fake = agents(hub, {
      turn: async (n, opts, secret) => {
        if (n === 1) {
          await hub.orchestrator.callTool(secret, 'ask_user', { question: 'Which one?', options: ['left', 'right'] });
          await new Promise((r) => opts.signal?.addEventListener('abort', r));
          return { lastSeq: 1, exitCode: 1, resumed: false, finalText: '', error: 'Cancelled' };
        }
        await hub.orchestrator.callTool(secret, 'submit_work', { summary: 'went right' });
      },
    });
    const id = await va.call('workflows.start', { config: cfg(a.cwd) });
    const pending = await until(async () => (await vb.call('workflows.get', { id }))?.pending, 'the question');
    // B answers; the same operation sent again (a reconnect) gets the same answer and is not run twice.
    const op = 'win-b-answer-1';
    await vb.call('workflows.decide', { id, decisionId: pending.id, optionId: 'answer:1' }, op);
    await vb.call('workflows.decide', { id, decisionId: pending.id, optionId: 'answer:1' }, op);
    // A answers the same question a moment later: already answered.
    await assert.rejects(va.call('workflows.decide', { id, decisionId: pending.id, optionId: 'answer:0' }), /已經失效|no longer pending/);
    await until(async () => (await status(va, id)) === 'completed', 'completion');
    const run = await va.call('workflows.get', { id });
    assert.equal(run.log.filter((l) => /你的回答|Your answer/.test(l.text)).length, 1);
    assert.match(run.log.find((l) => /你的回答|Your answer/.test(l.text)).text, /right/);
    assert.equal(fake.turns.length, 2, 'the question turn and the answered one');
    // A's view was told: the question is gone there too.
    await until(() => va.pushes.some((p) => p.topic === 'workflow' && p.data.id === id && !p.data.pending && p.data.status !== 'waiting_human'), 'A to see the answer');
  } finally {
    await hub.close();
  }
});

test('改名與刪除：在任一個視窗做，其他視窗立刻更新', async () => {
  const dir = tmp('rename');
  const { hub, ep } = await sharedHub(dir);
  try {
    const a = await windowOf(ep, 'win-a', path.join(dir, 'projA'));
    const b = await windowOf(ep, 'win-b', path.join(dir, 'projB'));
    const va = new View(ep, a.id);
    const vb = new View(ep, b.id);
    agents(hub);
    const id = await va.call('workflows.start', { config: cfg(a.cwd) });
    await until(async () => (await status(va, id)) === 'completed', 'completion');
    await va.call('workflows.rename', { id, title: 'Renamed in A' });
    await until(() => vb.last('workflows')?.find((w) => w.id === id)?.title === 'Renamed in A', 'B to see the new name');
    await vb.call('workflows.delete', { id });
    await until(() => va.last('workflows') && !va.last('workflows').some((w) => w.id === id), 'A to see it deleted');
    assert.equal(await va.call('workflows.get', { id }), null);
    // A's page open on it is told it was deleted (not only the list); a follow-up from A is refused, not started as a
    // new conversation without what came before.
    assert.ok(va.pushes.some((p) => p.topic === 'deleted' && p.data?.id === id), 'A told the workflow was deleted');
    await assert.rejects(va.call('workflows.start', { config: cfg(a.cwd, { continueFrom: id, goal: 'and one more thing' }) }), /已經刪除|was deleted/);
    assert.equal((await va.call('workflows.list')).length, 0);
  } finally {
    await hub.close();
  }
});

test('同時操作：兩個視窗同時對同一段對話送出追問，只會開始一則；同時停止也只停一次', async () => {
  const dir = tmp('race');
  const { hub, ep } = await sharedHub(dir);
  try {
    const a = await windowOf(ep, 'win-a', path.join(dir, 'projA'));
    const b = await windowOf(ep, 'win-b', path.join(dir, 'projB'));
    const va = new View(ep, a.id);
    const vb = new View(ep, b.id);
    const fake = agents(hub, { hold: true });
    fake.release();
    const first = await va.call('workflows.start', { config: cfg(a.cwd) });
    await until(async () => (await status(va, first)) === 'completed', 'the first message');
    // Both windows send a follow-up of the same message at the same moment.
    const held = agents(hub, { hold: true });
    const sent = await Promise.allSettled([
      va.call('workflows.start', { config: cfg(a.cwd, { continueFrom: first, title: 'from A' }) }),
      vb.call('workflows.start', { config: cfg(a.cwd, { continueFrom: first, title: 'from B' }) }),
    ]);
    const ok = sent.filter((s) => s.status === 'fulfilled');
    assert.equal(ok.length, 1, JSON.stringify(sent.map((s) => s.reason?.message ?? s.value)));
    assert.match(sent.find((s) => s.status === 'rejected').reason.message, /已經有一則訊息在處理中|already has a message being handled/);
    const second = ok[0].value;
    await until(() => held.turns.length === 1, 'the follow-up to start');
    // Both stop it at once: stopped once, nothing else runs.
    await Promise.all([va.call('workflows.cancel', { id: second }), vb.call('workflows.cancel', { id: second })]);
    await until(async () => ['cancelled', 'incomplete', 'failed', 'completed'].includes(await status(va, second)), 'the stop');
    await sleep(300);
    assert.equal(held.turns.length, 1);
    const thread = (await va.call('workflows.list')).filter((w) => (w.threadId ?? w.id) === first);
    assert.equal(thread.length, 2, 'the first message and one follow-up');
  } finally {
    await hub.close();
  }
});

test('關閉一個視窗：其他視窗的工作照常進行；那個視窗沒做完的對話框不會卡住 hub', async () => {
  const dir = tmp('close');
  const { hub, ep } = await sharedHub(dir);
  try {
    const a = await windowOf(ep, 'win-a', path.join(dir, 'projA'));
    const b = await windowOf(ep, 'win-b', path.join(dir, 'projB'));
    const va = new View(ep, a.id);
    const vb = new View(ep, b.id);
    const fake = agents(hub, { hold: true });
    const id = await vb.call('workflows.start', { config: cfg(b.cwd) });
    await until(() => fake.turns.length === 1, 'the agent to start');
    // A asked the hub for a folder dialog of its own and closes before answering it.
    const slow = await openChannel(ep, 'win-c', { pickFolder: () => new Promise(() => {}) });
    const vc = new View(ep, 'win-c');
    const dialog = vc.call('host.pickFolder');
    await sleep(100);
    slow.close();
    await assert.rejects(dialog, /已經關閉|has closed/);
    // Window A closes (its view and its channel) while B's work runs.
    va.close();
    a.ch.close();
    await until(() => hub.status().windows === 1, 'one window left');
    assert.equal(await status(vb, id), 'running');
    fake.release();
    await until(async () => (await status(vb, id)) === 'completed', 'completion');
    assert.equal(fake.turns.length, 1);
  } finally {
    await hub.close();
  }
});

test('斷線重連：重新取得最新狀態與完整事件，不漏不重複；斷線前送出、重連後重送的操作只執行一次', async () => {
  const dir = tmp('reconnect');
  const { hub, ep } = await sharedHub(dir);
  try {
    const a = await windowOf(ep, 'win-a', path.join(dir, 'projA'));
    const va = new View(ep, a.id);
    let say;
    const said = new Promise((r) => (say = r));
    let agentId;
    const fake = agents(hub, {
      turn: async (n, opts, secret) => {
        agentId = opts.agentId;
        let seq = opts.seqStart ?? 0;
        const emit = (text) => opts.onEvent({ seq: ++seq, ts: Date.now(), kind: 'message', text }, false);
        emit('before 1');
        emit('before 2');
        await said;
        for (let i = 1; i <= 5; i++) emit(`while away ${i}`);
        await hub.orchestrator.callTool(secret, 'submit_work', { summary: 'done' });
        return { lastSeq: seq, exitCode: 0, resumed: false, finalText: 'done' };
      },
    });
    const id = await va.call('workflows.start', { config: cfg(a.cwd) });
    const run = await until(async () => {
      const r = await va.call('workflows.get', { id });
      return Object.keys(r?.agents ?? {}).length && r;
    }, 'the agent');
    const aid = Object.keys(run.agents)[0];
    await until(async () => (await va.call('agents.events', { workflowId: id, agentId: aid })).length >= 2, 'first events');
    // A message sent just as the connection drops: its answer is lost, then the UI sends it again.
    await va.fire('workflows.say', { id, text: 'also add tests' }, 'win-a-say-1');
    // The hub got it (another window sees it), and the connection drops before its answer arrives.
    const watcher = new View(ep, 'win-watch');
    await until(async () => ((await watcher.call('workflows.get', { id }))?.userMessages ?? []).length === 1, 'the message to arrive');
    va.close();
    // Meanwhile the agent goes on: these events reach A only through the reload after it reconnects.
    say();
    await until(async () => (await status(watcher, id)) === 'completed', 'completion while A is away');
    await va.reconnect();
    // The UI sends the unanswered call again, with the same operation id: answered, not run again.
    await va.call('workflows.say', { id, text: 'also add tests' }, 'win-a-say-1');
    // The latest state first, then what follows: every event once, in order.
    await until(async () => (await status(va, id)) === 'completed', 'completion');
    const events = await va.call('agents.events', { workflowId: id, agentId: aid });
    const texts = events.filter((e) => e.kind === 'message').map((e) => e.text);
    for (const t of ['before 1', 'before 2', 'while away 1', 'while away 5']) assert.ok(texts.includes(t), `${t}: ${JSON.stringify(texts)}`);
    const seqs = events.map((e) => e.seq);
    assert.equal(new Set(seqs).size, seqs.length, 'no event twice');
    const after = await va.call('workflows.get', { id });
    assert.equal((after.userMessages ?? []).filter((m) => m.text === 'also add tests').length, 1, 'the message once');
    assert.equal(fake.turns.length >= 1, true);
  } finally {
    await hub.close();
  }
});

test('工作目錄：新對話用發起視窗的專案；在別的視窗看不會改變；選資料夾等操作回到發起的視窗', async () => {
  const dir = tmp('cwd');
  const { hub, ep } = await sharedHub(dir);
  try {
    const a = await windowOf(ep, 'win-a', path.join(dir, 'projA'));
    const b = await windowOf(ep, 'win-b', path.join(dir, 'projB'));
    const va = new View(ep, a.id);
    const vb = new View(ep, b.id);
    agents(hub);
    assert.equal((await va.call('host.info')).defaultCwd, a.cwd);
    assert.equal((await vb.call('host.info')).defaultCwd, b.cwd);
    // The folder dialog opens in the window that asked.
    assert.equal(await vb.call('host.pickFolder'), path.join(b.cwd, 'picked'));
    assert.deepEqual([a.asked, b.asked], [[], ['pickFolder']]);
    fs.mkdirSync(a.cwd, { recursive: true });
    await va.call('host.openPath', { path: a.cwd });
    assert.deepEqual(a.asked, [`openPath ${a.cwd}`]);
    // A chat of A's project, watched and followed up from B: still A's folder.
    const id = await va.call('workflows.start', { config: cfg(a.cwd) });
    await until(async () => (await status(vb, id)) === 'completed', 'completion');
    b.ch.state({ cwd: path.join(dir, 'projB2') });
    await sleep(50);
    assert.equal((await vb.call('workflows.get', { id })).config.cwd, a.cwd);
    assert.equal((await vb.call('host.info')).defaultCwd, path.join(dir, 'projB2'));
  } finally {
    await hub.close();
  }
});

test('App 與 VS Code 分流：App 的 hub 列不出、也讀不到 VS Code 對話的紀錄、事件和附件', async () => {
  const dir = tmp('sides');
  const { hub, ep } = await sharedHub(dir);
  const app = await startHub({ uiDir, bridgePath: 'x', dataDir: dir, hooks: { host: 'desktop' } });
  try {
    const a = await windowOf(ep, 'win-a', path.join(dir, 'projA'));
    const va = new View(ep, a.id);
    agents(hub, { turn: async (n, opts, secret) => { opts.onEvent({ seq: (opts.seqStart ?? 0) + 1, ts: Date.now(), kind: 'message', text: 'working' }, false); await hub.orchestrator.callTool(secret, 'submit_work', { summary: 'done' }); return { lastSeq: (opts.seqStart ?? 0) + 1, exitCode: 0, resumed: false, finalText: 'done' }; } });
    const id = await va.call('workflows.start', { config: cfg(a.cwd) });
    await until(async () => (await status(va, id)) === 'completed', 'completion');
    const aid = Object.keys((await va.call('workflows.get', { id })).agents)[0];
    assert.ok((await va.call('agents.events', { workflowId: id, agentId: aid })).length > 0);
    // An attachment of the VS Code chat.
    const file = path.join(dir, 'runs', id, 'attachments', 'shot.png');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'png');
    const get = (port, token) => fetch(`http://127.0.0.1:${port}/file?token=${token}&path=${encodeURIComponent(file)}`).then((r) => r.status);
    assert.equal(await get(hub.port, hub.token), 200);
    // The app.
    const vapp = new View({ port: app.port, token: app.token }, 'app');
    assert.ok(!(await vapp.call('workflows.list')).some((w) => w.id === id));
    assert.equal(await vapp.call('workflows.get', { id }), null);
    await assert.rejects(vapp.call('agents.events', { workflowId: id, agentId: aid }), /找不到工作流|Workflow not found/);
    assert.equal(await get(app.port, app.token), 403);
  } finally {
    await app.close();
    await hub.close();
  }
});

test('操作只執行一次，hub 重新啟動之後也一樣（操作紀錄存在資料資料夾）', async () => {
  const dir = tmp('oplog');
  let { hub, ep } = await sharedHub(dir);
  agents(hub);
  const a = await windowOf(ep, 'win-a', path.join(dir, 'projA'));
  let va = new View(ep, a.id);
  const id = await va.call('workflows.start', { config: cfg(a.cwd) });
  await until(async () => (await status(va, id)) === 'completed', 'completion');
  const first = await va.call('workflows.rename', { id, title: 'first name' }, 'op-rename');
  await hub.close();
  ({ hub, ep } = await sharedHub(dir));
  try {
    await windowOf(ep, 'win-a', path.join(dir, 'projA'));
    va = new View(ep, 'win-a');
    // The same operation again (sent before the restart, answered never): its first answer, not a second rename.
    const again = await va.call('workflows.rename', { id, title: 'second name' }, 'op-rename');
    assert.deepEqual(again, first);
    assert.equal((await va.call('workflows.get', { id })).config.title, 'first name');
    // A new operation runs.
    await va.call('workflows.rename', { id, title: 'second name' });
    assert.equal((await va.call('workflows.get', { id })).config.title, 'second name');
  } finally {
    await hub.close();
  }
});

// ---------- the hub as its own process (dist/hub.cjs), as the extension starts it ----------

/** daemon.ts with stand-in agents: each turn is logged; a turn waits for a "release" file, then hands in its work. */
async function daemonScript(dir) {
  const out = await build({
    ...common,
    entryPoints: [path.join(root, 'packages/vscode/src/daemon.ts')],
    banner: {
      js: `globalThis.__fakeAgent = async (o) => {
  const fs = require('fs'), path = require('path');
  fs.appendFileSync(process.env.FAKE_LOG, 'turn\\n');
  const release = path.join(path.dirname(process.env.FAKE_LOG), 'release');
  while (!fs.existsSync(release) && !o.signal?.aborted) await new Promise((r) => setTimeout(r, 50));
  const done = { lastSeq: (o.seqStart ?? 0) + 1, exitCode: 0, resumed: false, finalText: 'done' };
  if (o.signal?.aborted) return { ...done, exitCode: 1, finalText: '', error: 'Cancelled' };
  await fetch(o.bridge.env.AIVENUE_URL + '/bridge/call', { method: 'POST', headers: { 'content-type': 'application/json', 'x-aivenue-session': o.bridge.env.AIVENUE_SESSION }, body: JSON.stringify({ name: 'submit_work', arguments: { summary: 'done' } }) });
  return done;
};`,
    },
  });
  const file = path.join(dir, 'hub-under-test.cjs');
  fs.writeFileSync(file, out.outputFiles[0].text);
  // daemon.ts serves the UI next to itself.
  fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ui', 'index.html'), '<html><head></head><body></body></html>');
  return file;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test(
  '共用 hub 是獨立程序：兩個視窗同時啟動只會有一個 hub；hub 被強制結束後重新啟動，進行中的工作只恢復一次；視窗全關後 hub 自己結束',
  { timeout: 120_000 },
  async () => {
    const dir = tmp('daemon');
    const home = path.join(dir, 'home');
    const script = await daemonScript(dir);
    const fakeLog = path.join(dir, 'turns.log');
    fs.writeFileSync(fakeLog, '');
    const env = { ...process.env, AIVENUE_HOME: home, AIVENUE_HUB_GRACE_MS: '1500', FAKE_LOG: fakeLog };
    let spawned = 0;
    const start = () => {
      spawned++;
      const child = spawn(process.execPath, [script], { env, detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      child.stdin.end(JSON.stringify({ version: 'test', secrets: {} }));
      child.unref();
    };
    const turns = () => fs.readFileSync(fakeLog, 'utf8').split('\n').filter(Boolean).length;
    const pids = [];
    try {
      // Two windows start at the same moment; each may start a hub. One serves both.
      const [cha, chb] = await Promise.all([
        ensureHub({ dataDir: home, windowId: 'win-a', handlers: {}, spawn: start, timeoutMs: 30_000 }),
        ensureHub({ dataDir: home, windowId: 'win-b', handlers: {}, spawn: start, timeoutMs: 30_000 }),
      ]);
      pids.push(cha.endpoint.pid);
      assert.equal(cha.endpoint.pid, chb.endpoint.pid, 'one hub for both windows');
      cha.state({ cwd: path.join(dir, 'proj') });
      const st = await cha.control('status');
      assert.equal(st.windows, 2);
      await sleep(1000);
      // Every hub process started either serves or has exited (it found the first one's lock).
      const log = fs.readFileSync(path.join(home, 'logs', 'vscode-hub.log'), 'utf8');
      assert.equal((log.match(/serving on port/g) ?? []).length, 1, log);
      assert.equal((log.match(/another hub serves/g) ?? []).length, spawned - 1, log);
      // A workflow, from window A.
      fs.mkdirSync(path.join(dir, 'proj'), { recursive: true });
      const va = new View(cha.endpoint, 'win-a');
      const id = await va.call('workflows.start', { config: cfg(path.join(dir, 'proj')) });
      await until(() => turns() === 1, 'the agent to start');
      // On disk as running (saves are batched for a moment), as a workflow cut off by a crash is.
      await until(() => { try { return JSON.parse(fs.readFileSync(path.join(home, 'runs', id, 'run.json'), 'utf8')).status === 'running'; } catch { return false; } }, 'the workflow saved as running');
      va.close();
      // The hub is killed (a crash): both windows lose it and connect again, starting a new one.
      process.kill(cha.endpoint.pid, 'SIGKILL');
      await until(() => !alive(cha.endpoint.pid), 'the hub to end');
      const [na, nb] = await Promise.all([
        ensureHub({ dataDir: home, windowId: 'win-a', handlers: {}, spawn: start, timeoutMs: 30_000 }),
        ensureHub({ dataDir: home, windowId: 'win-b', handlers: {}, spawn: start, timeoutMs: 30_000 }),
      ]);
      pids.push(na.endpoint.pid);
      assert.equal(na.endpoint.pid, nb.endpoint.pid);
      assert.notEqual(na.endpoint.pid, cha.endpoint.pid);
      // The interrupted workflow resumes once (one more turn), not once per window.
      await until(() => turns() === 2, 'the resumed turn', 20_000);
      fs.writeFileSync(path.join(dir, 'release'), '');
      const vb = new View(na.endpoint, 'win-b');
      await until(async () => (await status(vb, id)) === 'completed', 'completion', 20_000);
      await sleep(4000); // past another auto-resume window
      assert.equal(turns(), 2, 'resumed once only');
      vb.close();
      // Both windows close: the hub stops by itself after the grace period, and removes its endpoint file.
      na.close();
      nb.close();
      await until(() => !alive(na.endpoint.pid), 'the hub to stop after the last window', 15_000);
      assert.equal(fs.existsSync(endpointFile(home)), false);
      assert.equal(readEndpoint(home), undefined);
    } finally {
      for (const pid of pids) if (alive(pid)) process.kill(pid);
    }
  },
);

test('回覆成功的那一刻，改變已經在磁碟上（不等 400 ms 後的存檔）：執行中追加的訊息、改名', async () => {
  const dir = tmp('answered-on-disk');
  const { hub, ep } = await sharedHub(dir);
  const fake = agents(hub, { hold: true });
  try {
    const a = await windowOf(ep, 'win-a', path.join(dir, 'projA'));
    const va = new View(ep, a.id);
    const id = await va.call('workflows.start', { config: cfg(a.cwd) });
    await until(() => fake.turns.length === 1, 'the agent to start');
    const disk = () => JSON.parse(fs.readFileSync(path.join(dir, 'runs', id, 'run.json'), 'utf8'));
    const { store } = hub.orchestrator.d;
    const run = hub.orchestrator.runs.get(id);
    // Nothing waiting to be saved: what is on disk when an answer arrives is all a crash right then would leave.
    store.saveNow(run);
    await va.call('workflows.say', { id, text: 'CRITICAL_USER_REQUEST' });
    assert.deepEqual((disk().userMessages ?? []).map((m) => m.text), ['CRITICAL_USER_REQUEST']);
    store.saveNow(run);
    await va.call('workflows.rename', { id, title: 'renamed before the answer' });
    assert.equal(disk().config.title, 'renamed before the answer');
  } finally {
    fake.release();
    await hub.close();
  }
});

test(
  'hub 回覆成功後立刻被強制結束：執行中追加的訊息和改名都已在磁碟上；重新啟動後重送同一個操作，不重複也不遺失',
  { timeout: 120_000 },
  async () => {
    const dir = tmp('crash-after-answer');
    const home = path.join(dir, 'home');
    const script = await daemonScript(dir);
    const fakeLog = path.join(dir, 'turns.log');
    fs.writeFileSync(fakeLog, '');
    const env = { ...process.env, AIVENUE_HOME: home, AIVENUE_HUB_GRACE_MS: '1500', FAKE_LOG: fakeLog };
    const start = () => {
      const child = spawn(process.execPath, [script], { env, detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      child.stdin.end(JSON.stringify({ version: 'test', secrets: {} }));
      child.unref();
    };
    const turns = () => fs.readFileSync(fakeLog, 'utf8').split('\n').filter(Boolean).length;
    const onDisk = (id) => JSON.parse(fs.readFileSync(path.join(home, 'runs', id, 'run.json'), 'utf8'));
    const pids = [];
    try {
      const ch = await ensureHub({ dataDir: home, windowId: 'win-a', handlers: {}, spawn: start, timeoutMs: 30_000 });
      pids.push(ch.endpoint.pid);
      fs.mkdirSync(path.join(dir, 'proj'), { recursive: true });
      ch.state({ cwd: path.join(dir, 'proj') });
      const va = new View(ch.endpoint, 'win-a');
      const id = await va.call('workflows.start', { config: cfg(path.join(dir, 'proj')) });
      await until(() => turns() === 1, 'the agent to start');
      await until(() => { try { return onDisk(id).status === 'running'; } catch { return false; } }, 'the workflow saved as running');
      // Answered as done; then the hub dies at once (no shutdown, no pending save gets its turn).
      const said = await va.call('workflows.say', { id, text: 'CRITICAL_USER_REQUEST' }, 'crash-say');
      const renamed = await va.call('workflows.rename', { id, title: 'renamed before the crash' }, 'crash-rename');
      process.kill(ch.endpoint.pid, 'SIGKILL');
      await until(() => !alive(ch.endpoint.pid), 'the hub to end');
      va.close();
      ch.close();
      // What the window was told is on disk.
      const saved = onDisk(id);
      assert.deepEqual((saved.userMessages ?? []).map((m) => m.text), ['CRITICAL_USER_REQUEST']);
      assert.equal(saved.config.title, 'renamed before the crash');
      // A new hub; the window sends both operations again (it never knew they arrived): answered as before, not run twice.
      const nc = await ensureHub({ dataDir: home, windowId: 'win-a', handlers: {}, spawn: start, timeoutMs: 30_000 });
      pids.push(nc.endpoint.pid);
      const vb = new View(nc.endpoint, 'win-a');
      assert.deepEqual(await vb.call('workflows.say', { id, text: 'CRITICAL_USER_REQUEST' }, 'crash-say'), said);
      assert.deepEqual(await vb.call('workflows.rename', { id, title: 'renamed before the crash' }, 'crash-rename'), renamed);
      const now = await vb.call('workflows.get', { id });
      assert.deepEqual((now.userMessages ?? []).map((m) => m.text), ['CRITICAL_USER_REQUEST']);
      assert.equal(now.config.title, 'renamed before the crash');
      fs.writeFileSync(path.join(dir, 'release'), '');
      vb.close();
      nc.close();
    } finally {
      for (const pid of pids) if (alive(pid)) process.kill(pid);
    }
  },
);

test(
  '共用 hub 當掉後：新的 hub 啟動時舊的鎖還沒被系統放開，它會讓出；視窗會再啟動一次，最後仍然連上（完整測試中重現的競爭）',
  { timeout: 90_000 },
  async () => {
    const dir = tmp('respawn');
    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { recursive: true });
    const script = await daemonScript(dir);
    const env = { ...process.env, AIVENUE_HOME: home, AIVENUE_HUB_GRACE_MS: '1500', FAKE_LOG: path.join(dir, 'turns.log') };
    // The crashed hub: its address file is still there (nothing answers), and its lock is not released yet.
    fs.writeFileSync(endpointFile(home), JSON.stringify({ pid: 999999, port: 1, token: 'x', build: 'dev', version: 'test', startedAt: Date.now() }));
    const held = await holdOsLock(lockName(home, 'hub-vscode'));
    assert.ok(held, 'the test holds the hub lock');
    let spawned = 0;
    const start = () => {
      spawned++;
      const child = spawn(process.execPath, [script], { env, detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      child.stdin.end(JSON.stringify({ version: 'test', secrets: {} }));
      child.unref();
    };
    const log = () => {
      try {
        return fs.readFileSync(path.join(home, 'logs', 'vscode-hub.log'), 'utf8');
      } catch {
        return '';
      }
    };
    let ch;
    try {
      const connecting = ensureHub({ dataDir: home, windowId: 'win-a', handlers: {}, spawn: start, timeoutMs: 30_000 });
      // The hub started first finds the lock and steps aside; then the system releases the dead hub's lock.
      await until(() => /another hub serves/.test(log()), 'the first hub to step aside', 20_000);
      await held.release();
      ch = await connecting;
      assert.ok(spawned >= 2, `started again (${spawned})`);
      assert.equal((log().match(/serving on port/g) ?? []).length, 1, log());
      assert.equal((await ch.control('status')).windows, 1);
    } finally {
      ch?.close();
      const ep = readEndpoint(home);
      if (ep && alive(ep.pid)) process.kill(ep.pid);
    }
  },
);
