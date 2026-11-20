// Drive the throwaway VS Code through its debugging port: open "Aivenue: open in an editor tab" from the command
// palette, then find the Aivenue page (the webview context with window.__AIVENUE__) among the frames and ask its hub for host.info and the
// workflow list, like scripts/linux-accept/app-check.mjs does for the desktop app.
//   node vscode-check.mjs <port> <out.json> <shot.png>
import * as fs from 'node:fs';

const [port, out, shot] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
function cdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const contexts = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.method === 'Runtime.executionContextCreated') contexts.push(msg.params.context);
    if (msg.id && pending.has(msg.id)) (pending.get(msg.id)(msg), pending.delete(msg.id));
  };
  const ready = new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return { ready, send, contexts, close: () => ws.close() };
}
const key = async (c, k, code, vk, mods = 0) => {
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
};

const wb = (await targets()).find((t) => t.type === 'page' && t.url.includes('workbench.html'));
if (!wb) throw new Error('no VS Code window');
const w = cdp(wb.webSocketDebuggerUrl);
await w.ready;
// The command from the palette, by id and else by its title; Esc first (a dialog or the chat view's input would take the
// keys). Asked again while no tab shows up: right after start the palette may open before the extension's commands exist.
const TITLES = ['aivenue.openInEditor', '在編輯器分頁中開啟 Aivenue'];
let attempt = 0;
const openTab = async () => {
  await w.send('Page.bringToFront');
  await sleep(700);
  await key(w, 'Escape', 'Escape', 27);
  await sleep(500);
  await key(w, 'F1', 'F1', 112);
  await sleep(1200);
  await w.send('Input.insertText', { text: TITLES[attempt++ % TITLES.length] });
  await sleep(1500);
  await key(w, 'Enter', 'Enter', 13);
};
await openTab();

// Aivenue's editor tab is a VS Code webview: its page is a context inside a vscode-webview:// frame (the extension loads
// the UI from its own files and only talks to the hub over its socket), never a target of its own at http://127.0.0.1.
// That page is the context with window.__AIVENUE__ (the boot script the extension writes into the webview).
const findPage = async () => {
  for (const t of (await targets()).filter((x) => x.type === 'iframe' && x.url.startsWith('vscode-webview://') && x.webSocketDebuggerUrl)) {
    const f = cdp(t.webSocketDebuggerUrl);
    await f.ready;
    await f.send('Runtime.enable');
    await sleep(800);
    for (const c of f.contexts) {
      const r = await f.send('Runtime.evaluate', { expression: '!!window.__AIVENUE__', contextId: c.id, returnByValue: true });
      if (r.result?.result?.value) return { frame: f, contextId: c.id, url: t.url };
    }
    f.close();
  }
  return undefined;
};
let page;
const deadline = Date.now() + 90_000;
let asked = Date.now();
while (!page && Date.now() < deadline) {
  await sleep(1500);
  page = await findPage();
  if (!page && Date.now() - asked > 15_000) {
    await openTab();
    asked = Date.now();
  }
}
const shotRes = await w.send('Page.captureScreenshot', { format: 'png' });
if (shotRes.result?.data) fs.writeFileSync(shot, Buffer.from(shotRes.result.data, 'base64'));
if (!page) {
  fs.writeFileSync(out, JSON.stringify({ error: 'no Aivenue page', targets: (await targets()).map((t) => [t.type, t.url.slice(0, 120)]) }, null, 1));
  process.exit(1);
}
const p = page.frame;
const IN_PAGE = `(async () => {
  const url = window.__AIVENUE__?.wsUrl ?? \`ws://\${location.host}/ws?token=\${new URLSearchParams(location.search).get('token') ?? sessionStorage.getItem('aivenue.token') ?? ''}\`;
  const ws = new WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws')); });
  let n = 0; const wait = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
  const call = (method, params = {}) => new Promise((r) => { const id = 700 + (++n); wait.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const info = await call('host.info');
  const list = await call('workflows.list');
  ws.close();
  return JSON.stringify({ info: info.result ?? info, list: list.result ?? list });
})()`;
const r = await p.send('Runtime.evaluate', { expression: IN_PAGE, contextId: page.contextId, awaitPromise: true, returnByValue: true });
let res;
try { res = JSON.parse(r.result?.result?.value ?? '{}'); } catch { res = { raw: r }; }
const info = res.info ?? {};
const runs = JSON.stringify(res.list ?? '').match(/\d{14}-acc\d{3}/g) ?? [];
fs.writeFileSync(out, JSON.stringify({ page: page.url.replace(/\?.*$/, ''), version: info.version, build: info.build, dataDir: info.dataDir, host: info.host, runs: [...new Set(runs)], rawInfoKeys: Object.keys(info) }, null, 1));
w.close(); p.close();
process.exit(info.version ? 0 : 1);
