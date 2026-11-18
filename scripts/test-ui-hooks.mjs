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
      (this.sent ??= []).push(m);
      // Calls the stand-in hub leaves unanswered (the connection drops before the answer).
      if (o.silent?.has(m.method)) return;
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

test('連線中斷後：已送出的外部效果操作（上傳、安裝、登入…）不自動重送，改回報「無法確定有沒有完成」；一般操作照樣重送；斷線時才發出、還沒送出去的照常送', async () => {
  const { api, sockets } = standInHub({ r1: { id: 'r1', config: { title: 'kept' } } }, { silent: new Set(['attachments.upload', 'workflows.say', 'providers.install']) });
  await tick();
  const upload = api.hub.call('attachments.upload', { name: 'a.txt', data: 'eA==' });
  const say = api.hub.call('workflows.say', { id: 'r1', text: 'hi' });
  await tick();
  assert.deepEqual(sockets[0].sent.map((m) => m.method), ['attachments.upload', 'workflows.say']);
  // The connection drops before either is answered; an install is asked for while it is down (never sent).
  sockets[0].readyState = 3;
  sockets[0].onclose();
  const install = api.hub.call('providers.install', { id: 'x' });
  const outcome = upload.then(() => 'answered', (e) => e.message);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(sockets.length, 2, 'reconnected');
  assert.match(await outcome, /無法確定這個操作有沒有完成；為了不重複執行，沒有自動重送/);
  const resent = sockets[1].sent.map((m) => m.method);
  assert.ok(!resent.includes('attachments.upload'), 'the upload is not sent again');
  assert.ok(resent.includes('workflows.say'), 'an ordinary call is sent again (the hub runs it once)');
  assert.ok(resent.includes('providers.install'), 'one that never went out is sent now');
  // The hub answers them now (so nothing is left waiting).
  for (const m of sockets[1].sent) sockets[1].onmessage({ data: JSON.stringify({ id: m.id, result: null }) });
  assert.equal(await say, null);
  assert.equal(await install, null);
});

test('設定鎖讀不到時（例如 EACCES）：在時限內回報錯誤、不接手、不忙等卡住；鎖在等待中被釋放時照常儲存；活的擁有者也在時限內拒絕', { exclusive: true }, async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawn, spawnSync } = await import('node:child_process');
  const out = await build({ entryPoints: ['packages/core/src/settings.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-settings-lock2-'));
  const bundle = path.join(dir, 'settings.cjs');
  fs.writeFileSync(bundle, out.outputFiles[0].text);
  const lock = path.join(dir, 'settings.json.lock');
  const disk = () => (fs.existsSync(path.join(dir, 'settings.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')) : {});
  // In a process of its own (a hub), with reading the lock failing: it must answer, and soon.
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, started: 1, host: os.hostname(), token: 'unreadable' }));
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      `const fs = require('fs');
       const real = fs.readFileSync;
       fs.readFileSync = function (p, ...rest) {
         if (String(p).endsWith('settings.json.lock')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
         return real.call(this, p, ...rest);
       };
       const { SettingsStore } = require(${JSON.stringify(bundle)});
       const t0 = Date.now();
       try { new SettingsStore(${JSON.stringify(dir)}).set({ theme: 'dark' }); console.log(JSON.stringify({ saved: true })); }
       catch (e) { console.log(JSON.stringify({ error: e.message, ms: Date.now() - t0 })); }`,
    ],
    { encoding: 'utf8', timeout: 6500 },
  );
  assert.equal(child.error, undefined, 'it answered in time (no busy loop)');
  const said = JSON.parse(child.stdout.trim());
  assert.match(said.error ?? '', /settings lock .* cannot be read \(EACCES\): settings not saved/);
  assert.ok(said.ms < 5000, `answered by the deadline (${said.ms} ms)`);
  assert.match(fs.readFileSync(lock, 'utf8'), /"token":"unreadable"/, 'not taken over');
  assert.equal(disk().theme, undefined);
  fs.rmSync(lock);

  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  const store = new mod.exports.SettingsStore(dir);
  // Windows: a lock being removed reads as EPERM for a moment, then it is gone. That is waited out, not an error.
  const nfs = createRequire(import.meta.url)('node:fs');
  const realRead = nfs.readFileSync;
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, started: 1, host: os.hostname(), token: 'being removed' }));
  let reads = 0;
  let removed = false;
  nfs.readFileSync = function (p, ...rest) {
    if (!removed && String(p).endsWith('settings.json.lock')) {
      if (++reads === 3) {
        fs.rmSync(lock);
        removed = true;
      }
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }
    return realRead.call(this, p, ...rest);
  };
  try {
    store.set({ accent: '#123456' });
  } finally {
    nfs.readFileSync = realRead;
  }
  assert.equal(disk().accent, '#123456');
  assert.equal(fs.existsSync(lock), false);
  // A live holder that releases after a second: the change waits for it and goes through.
  const holder = (ms) =>
    spawn(process.execPath, ['-e', `
      const fs = require('fs'), os = require('os');
      fs.writeFileSync(${JSON.stringify(lock)}, JSON.stringify({ pid: process.pid, started: Math.round(Date.now() - process.uptime() * 1000), host: os.hostname(), token: 'holder' }), { flag: 'wx' });
      process.stdout.write('held');
      setTimeout(() => { fs.rmSync(${JSON.stringify(lock)}); process.exit(0); }, ${ms});`], { stdio: ['ignore', 'pipe', 'ignore'] });
  const brief = holder(1000);
  await new Promise((r) => brief.stdout.once('data', r));
  store.set({ theme: 'dark' });
  assert.equal(disk().theme, 'dark');
  assert.equal(fs.existsSync(lock), false);
  // A live holder that keeps it: refused within the limit, its process check included.
  const long = holder(30000);
  try {
    await new Promise((r) => long.stdout.once('data', r));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const t0 = Date.now();
    assert.throws(() => store.set({ theme: 'light' }), /being saved by another Aivenue/);
    const ms = Date.now() - t0;
    assert.ok(ms >= 2900 && ms < 5000, `refused after the 3 s wait (${ms} ms)`);
    assert.equal(disk().theme, 'dark');
  } finally {
    long.kill();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('設定鎖：儲存後釋放時讀鎖檔短暫失敗（EPERM）會再試並釋放；一直失敗而留下的鎖，同一個服務下一次儲存會收回，不會逾時', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const out = await build({ entryPoints: ['packages/core/src/settings.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-settings-release-'));
  const lock = path.join(dir, 'settings.json.lock');
  const disk = () => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  const store = new mod.exports.SettingsStore(dir);
  const nfs = createRequire(import.meta.url)('node:fs');
  const realRead = nfs.readFileSync;
  const failLockReads = (until) => {
    nfs.readFileSync = function (p, ...rest) {
      if (String(p).endsWith('settings.json.lock') && until()) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      return realRead.call(this, p, ...rest);
    };
  };
  try {
    // Once (the read when releasing): tried again, released.
    let failed = 0;
    failLockReads(() => failed++ < 1);
    store.set({ theme: 'dark' });
    assert.equal(failed, 2, 'read again after the failure');
    assert.equal(disk().theme, 'dark');
    assert.equal(fs.existsSync(lock), false, 'released');
    // For longer than releasing waits: the lock is left behind...
    const until = Date.now() + 1500;
    failLockReads(() => Date.now() < until);
    store.set({ theme: 'light' });
    assert.equal(disk().theme, 'light', 'the change itself was saved');
    assert.equal(fs.existsSync(lock), true, 'left behind');
    nfs.readFileSync = realRead;
    // ...and this process's next change takes it back at once.
    const t0 = Date.now();
    store.set({ accent: '#abcdef' });
    assert.ok(Date.now() - t0 < 1000, 'not waiting for its own leftover lock');
    assert.equal(disk().accent, '#abcdef');
    assert.equal(fs.existsSync(lock), false);
  } finally {
    nfs.readFileSync = realRead;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The copy buttons' clipboard (packages/ui/src/clipboard.ts) and the extension's side of it (packages/vscode/src/copy.ts),
 * bundled with stand-ins: the page's VS Code API (`globalThis.__vscodeApi`) and VS Code's clipboard (`__clipWrite`).
 */
async function loadCopy(entry) {
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'stand-ins',
        setup(b) {
          b.onResolve({ filter: /^(\.\/api|vscode)$/ }, (a) => ({ path: a.path, namespace: 'copy-stand-in' }));
          b.onLoad({ filter: /.*/, namespace: 'copy-stand-in' }, (a) => ({
            contents: a.path === 'vscode' ? 'export const env = { clipboard: { writeText: (t) => globalThis.__clipWrite(t) } };' : 'export const vscodeApi = globalThis.__vscodeApi;',
          }));
        },
      },
    ],
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  return mod.exports;
}

const COPIED_TEXT = '## 結論\n\n| 項目 | 結果 |\n|---|---|\n| 崩潰後 | 不遺失 |\n\n- 第一點\n  - 巢狀\n\n```js\nconst a = 1;\n  b();\n```\n';

test('複製（VS Code）：頁面請擴充端寫入剪貼簿，收到成功才算複製；擴充端回報失敗或 5 秒沒回應，都帶著原因失敗；別的回覆不算', async () => {
  const { mock } = await import('node:test');
  const posted = [];
  const onMessage = [];
  globalThis.window = { addEventListener: (type, fn) => type === 'message' && onMessage.push(fn) };
  globalThis.__vscodeApi = { postMessage: (m) => posted.push(m) };
  const fromExtension = (data) => onMessage.forEach((fn) => fn({ data }));
  try {
    const C = await loadCopy('packages/ui/src/clipboard.ts');
    const first = C.copyText(COPIED_TEXT);
    assert.deepEqual(posted[0], { type: 'aivenue.copy', id: 1, text: COPIED_TEXT }, 'the text as given (Markdown, line breaks)');
    let done = false;
    first.then(() => (done = true));
    fromExtension({ type: 'aivenue.copied', id: 99, ok: true });
    fromExtension({ type: 'aivenue.hub', wsUrl: 'ws://x' });
    await tick();
    assert.equal(done, false, 'not copied until the extension answers this request');
    fromExtension({ type: 'aivenue.copied', id: 1, ok: true });
    await first;
    const failed = C.copyText('x');
    fromExtension({ type: 'aivenue.copied', id: 2, ok: false, error: 'the clipboard is busy' });
    await assert.rejects(failed, /the clipboard is busy/);
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const silent = C.copyText('y');
      mock.timers.tick(5000);
      await assert.rejects(silent, /VS Code did not answer/);
    } finally {
      mock.timers.reset();
    }
  } finally {
    delete globalThis.__vscodeApi;
  }
});

test('複製（VS Code 擴充端）：用 vscode.env.clipboard.writeText 寫入原文，寫好才回覆成功；寫入失敗、不是文字、太長都回覆失敗與原因；其他訊息不理', async () => {
  const X = await loadCopy('packages/vscode/src/copy.ts');
  const clip = [];
  globalThis.__clipWrite = async (t) => {
    if (t === 'FAIL') throw new Error('access denied');
    clip.push(t);
  };
  let handler;
  const sent = [];
  let disposed = false;
  const webview = { onDidReceiveMessage: (fn) => ((handler = fn), { dispose: () => (disposed = true) }), postMessage: async (m) => (sent.push(m), true) };
  const sub = X.listenCopy(webview);
  await handler({ type: 'aivenue.copy', id: 7, text: COPIED_TEXT });
  assert.deepEqual(clip, [COPIED_TEXT]);
  assert.deepEqual(sent, [{ type: 'aivenue.copied', id: 7, ok: true }]);
  await handler({ type: 'aivenue.copy', id: 8, text: 'FAIL' });
  await handler({ type: 'aivenue.copy', id: 9, text: 42 });
  await handler({ type: 'aivenue.copy', id: 10, text: 'x'.repeat(X.COPY_MAX + 1) });
  assert.deepEqual(sent.slice(1), [
    { type: 'aivenue.copied', id: 8, ok: false, error: 'access denied' },
    { type: 'aivenue.copied', id: 9, ok: false, error: 'nothing to copy' },
    { type: 'aivenue.copied', id: 10, ok: false, error: `too long to copy (${X.COPY_MAX + 1} characters)` },
  ]);
  await handler({ type: 'aivenue.hub.moved', wsUrl: 'ws://x' });
  assert.equal(sent.length, 4, 'other messages: no answer');
  assert.deepEqual(clip, [COPIED_TEXT], 'nothing else written');
  sub.dispose();
  assert.equal(disposed, true);
});

test('複製（桌面版與瀏覽器）：用瀏覽器剪貼簿寫入原文；不允許時改用複製指令；兩者都失敗才報錯並帶原因', async () => {
  delete globalThis.__vscodeApi;
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const wrote = [];
  let allowed = true;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { clipboard: { writeText: async (t) => (allowed ? wrote.push(t) : Promise.reject(new Error('Document is not focused'))) } } });
  let commandWorks = false;
  const commanded = [];
  globalThis.document = {
    activeElement: null,
    body: { appendChild: () => undefined },
    createElement: () => ({ value: '', style: {}, setAttribute: () => undefined, select() {}, remove() {} }),
    execCommand: (c) => (commanded.push(c), commandWorks),
  };
  try {
    const B = await loadCopy('packages/ui/src/clipboard.ts');
    await B.copyText(COPIED_TEXT);
    assert.deepEqual(wrote, [COPIED_TEXT]);
    assert.deepEqual(commanded, [], 'the clipboard worked: no copy command');
    allowed = false;
    await assert.rejects(B.copyText('y'), /Document is not focused/);
    commandWorks = true;
    await B.copyText('z');
    assert.deepEqual(commanded, ['copy', 'copy']);
  } finally {
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
    delete globalThis.document;
  }
});
