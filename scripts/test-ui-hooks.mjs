import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from './lib/test-shard.mjs';
import { build } from 'esbuild';

/*
 * The UI's data hooks (packages/ui/src/api.ts) as a page uses them, without a browser: React is a stand-in that keeps
 * each useState value in a list and runs the effects when asked; the hub is a stand-in WebSocket that answers calls
 * and sends pushes. What a page shows comes from these values.
 */

const REACT = `
export const useState = (init) => {
  const i = globalThis.hookIndex++;
  if (!(i in globalThis.hookStates)) globalThis.hookStates[i] = typeof init === 'function' ? init() : init;
  return [globalThis.hookStates[i], (v) => { globalThis.hookStates[i] = typeof v === 'function' ? v(globalThis.hookStates[i]) : v; }];
};
export const useEffect = (f) => { globalThis.hookEffects.push(f); };
export const useMemo = (f) => f();
export const useRef = (v) => ({ current: v });
export const useSyncExternalStore = () => undefined;
`;

const bundled = await build({
  entryPoints: ['packages/ui/src/api.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent',
  plugins: [
    {
      name: 'hooks',
      setup(b) {
        b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'stand-in' }));
        b.onLoad({ filter: /.*/, namespace: 'stand-in' }, () => ({ contents: REACT }));
        b.onLoad({ filter: /[\\/]ui[\\/]src[\\/]util\.ts$/ }, () => ({ contents: 'export const setPickedColors = () => {};' }));
      },
    },
  ],
});

/**
 * A hub that answers workflows.get with `runs[id]` and lets the test push. `vscode`: the page is in a VS Code webview
 * (acquireVsCodeApi; what it posts to the extension is kept, and the extension's messages are sent with `message`).
 */
function standInHub(runs, o = {}) {
  const sockets = [];
  const posted = [];
  const onMessage = [];
  globalThis.window = { __AIVENUE__: { wsUrl: 'ws://127.0.0.1:1/ws?token=t' }, addEventListener: (type, fn) => type === 'message' && onMessage.push(fn) };
  if (o.vscode) globalThis.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m) });
  else delete globalThis.acquireVsCodeApi;
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      sockets.push(this);
      queueMicrotask(() => this.onopen?.());
    }
    send(text) {
      const m = JSON.parse(text);
      const result = m.method === 'workflows.get' ? (runs[m.params?.id] ?? null) : m.method === 'workflows.list' ? Object.values(runs).map((r) => ({ id: r.id, title: r.config.title })) : null;
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: m.id, result }) }));
    }
    close() {
      this.readyState = 3;
      queueMicrotask(() => this.onclose?.());
    }
  };
  globalThis.hookIndex = 0;
  globalThis.hookStates = [];
  globalThis.hookEffects = [];
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  return {
    api: mod.exports,
    sockets,
    posted,
    push: (topic, data) => sockets.at(-1).onmessage({ data: JSON.stringify({ push: { topic, data } }) }),
    fromExtension: (data) => onMessage.forEach((fn) => fn({ data })),
  };
}
const tick = () => new Promise((r) => setTimeout(r, 10));

test('另一個視窗刪除對話：已開著這段對話的頁面清掉它並得知已刪除，不只是側欄清單', async () => {
  const run = { id: 'r1', config: { title: 'deleted conversation' } };
  const { api, push } = standInHub({ r1: run });
  // The page: its workflow (hook state 0) and whether it was deleted (hook state 1); the sidebar list (state 2).
  globalThis.hookIndex = 0;
  api.useWorkflow('r1');
  api.useDeleted('r1');
  api.useWorkflows();
  for (const f of globalThis.hookEffects.splice(0)) f();
  await tick();
  assert.equal(globalThis.hookStates[0]?.id, 'r1');
  assert.equal(globalThis.hookStates[1], false);
  // Another window deletes another chat: nothing changes here.
  push('deleted', { id: 'other' });
  await tick();
  assert.equal(globalThis.hookStates[0]?.id, 'r1');
  assert.equal(globalThis.hookStates[1], false);
  // Then this one (the hub tells every window, then sends the new list).
  push('deleted', { id: 'r1' });
  push('workflows', []);
  await tick();
  assert.equal(globalThis.hookStates[0], null, 'the open page no longer holds the deleted workflow');
  assert.equal(globalThis.hookStates[1], true, 'the page knows it was deleted');
  assert.deepEqual(globalThis.hookStates[2], []);
});

test('側欄收合存在設定裡（不是頁面自己的 localStorage）：App 與 VS Code 各自一份，改一邊不動另一邊；重新開啟後讀回', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const out = await build({ entryPoints: ['packages/core/src/settings.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  const { SettingsStore } = mod.exports;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-settings-'));
  const s = new SettingsStore(dir);
  s.set({ sidebarHidden: { app: true } });
  s.set({ sidebarHidden: { vscode: false } });
  assert.deepEqual(s.get().sidebarHidden, { app: true, vscode: false });
  // A new start (the app's page then comes from a hub on another port): read back from the data folder.
  assert.deepEqual(new SettingsStore(dir).get().sidebarHidden, { app: true, vscode: false });
  assert.throws(() => s.set({ sidebarHidden: { app: 'yes' } }), /sidebarHidden/);
  assert.throws(() => s.set({ sidebarHidden: { other: true } }), /sidebarHidden/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('App 與 VS Code 兩個 hub 各有一個設定存放，寫同一個 settings.json：一邊存的不會被另一邊較舊的副本蓋掉；讀得到對方的修改；殘留的鎖會被接手', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const out = await build({ entryPoints: ['packages/core/src/settings.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  const { SettingsStore } = mod.exports;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-settings-two-'));
  // Both hubs start from the same file, each with its own copy.
  const app = new SettingsStore(dir);
  const vscode = new SettingsStore(dir);
  app.set({ sidebarHidden: { app: true } });
  vscode.set({ sidebarHidden: { vscode: true } });
  const disk = () => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.deepEqual(disk().sidebarHidden, { app: true, vscode: true }, "the app's side was not overwritten");
  app.set({ theme: 'dark' });
  assert.deepEqual(disk().sidebarHidden, { app: true, vscode: true });
  assert.equal(vscode.get().theme, 'dark', "the other hub's change is read");
  assert.deepEqual(new SettingsStore(dir).get().sidebarHidden, { app: true, vscode: true });
  // A lock left by a hub that stopped while saving.
  const lock = path.join(dir, 'settings.json.lock');
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  vscode.set({ sidebarHidden: { vscode: false } });
  assert.deepEqual(disk().sidebarHidden, { app: true, vscode: false });
  assert.equal(fs.existsSync(lock), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('VS Code 背景服務換了連接埠：頁面不重新載入，直接連到新位址；等待中的呼叫重送過去；舊的重連計時不會多開一條連線', async () => {
  const { api, sockets, posted, fromExtension } = standInHub({ r1: { id: 'r1', config: { title: 'kept' } } }, { vscode: true });
  await tick();
  assert.equal(sockets.length, 1);
  // The hub dies: the socket closes and a retry is scheduled; a call made now waits.
  sockets[0].readyState = 3;
  sockets[0].onclose();
  const waiting = api.hub.call('workflows.get', { id: 'r1' });
  // The extension says where the hub is now; the page connects there and answers.
  const moved = 'ws://127.0.0.1:2/ws?token=new&window=w';
  fromExtension({ type: 'aivenue.hub', wsUrl: moved });
  assert.equal((await waiting)?.config?.title, 'kept', 'the waiting call answered by the hub at the new address');
  assert.equal(sockets.at(-1).url, moved);
  assert.deepEqual(posted, [{ type: 'aivenue.hub.moved', wsUrl: moved }]);
  // The retry scheduled before the move does not open another connection.
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(sockets.length, 2);
  // An address on another host is not taken.
  fromExtension({ type: 'aivenue.hub', wsUrl: 'ws://evil.example:9/ws?token=x' });
  await tick();
  assert.equal(sockets.length, 2);
  assert.equal(posted.length, 1);
});

test('設定鎖：另一個程序還活著時，不管拿著鎖多久都不搶，這邊的修改逾時報錯、不會蓋掉對方；對方結束或 PID 被別的程序重用時才接手；只刪自己的鎖', { exclusive: true }, async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawn } = await import('node:child_process');
  const out = await build({ entryPoints: ['packages/core/src/settings.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  const { SettingsStore } = mod.exports;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-settings-lock-'));
  const lock = path.join(dir, 'settings.json.lock');
  const disk = () => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  const store = new SettingsStore(dir);
  store.set({ sidebarHidden: { app: true } });
  // Another process holds the lock (as a hub that stalls between reading and writing), with its own name in it.
  const holder = spawn(process.execPath, ['-e', `
    const fs = require('fs'), os = require('os');
    fs.writeFileSync(${JSON.stringify(lock)}, JSON.stringify({ pid: process.pid, started: Math.round(Date.now() - process.uptime() * 1000), host: os.hostname(), token: 'holder' }), { flag: 'wx' });
    process.stdout.write('held');
    setTimeout(() => {}, 60000);`], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise((r) => holder.stdout.once('data', r));
    // Older than any time limit: still not taken while its owner lives.
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const t0 = Date.now();
    assert.throws(() => store.set({ sidebarHidden: { vscode: true } }), /being saved by another Aivenue/);
    assert.ok(Date.now() - t0 >= 2900, 'it waited first');
    assert.match(fs.readFileSync(lock, 'utf8'), /"token":"holder"/, "the holder's lock is untouched");
    assert.deepEqual(disk().sidebarHidden, { app: true }, 'nothing written over');
    // The holder ends without releasing: its lock is taken over.
    holder.kill();
    await new Promise((r) => holder.once('exit', r));
    store.set({ sidebarHidden: { vscode: true } });
    assert.deepEqual(disk().sidebarHidden, { app: true, vscode: true });
    assert.equal(fs.existsSync(lock), false, 'released after the change');
  } finally {
    try {
      holder.kill();
    } catch {}
  }
  // A lock whose PID now belongs to another process (started at another time): its owner is gone.
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: other.pid, started: 1, host: os.hostname(), token: 'long gone' }));
    store.set({ theme: 'dark' });
    assert.equal(disk().theme, 'dark');
    assert.equal(fs.existsSync(lock), false);
  } finally {
    other.kill();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
