// Connects to a running Aivenue (started with --remote-debugging-port) and reports, from its own host, the version,
// build and data folder, and the workflows it lists; saves a screenshot of the window.
//   node scripts/linux-accept/app-check.mjs <port> <out.json> <shot.png>
import * as fs from 'node:fs';

const [port, out, shot] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + 90_000;
let page;
while (!page && Date.now() < deadline) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    page = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1') && t.webSocketDebuggerUrl);
  } catch {
    // not up yet
  }
  if (!page) await sleep(1000);
}
if (!page) throw new Error('no Aivenue window on the debugging port');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) (pending.get(msg.id)(msg), pending.delete(msg.id));
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const IN_PAGE = `(async () => {
  const url = window.__AIVENUE__?.wsUrl ?? \`\${location.protocol === 'https:' ? 'wss' : 'ws'}://\${location.host}/ws?token=\${new URLSearchParams(location.search).get('token') ?? sessionStorage.getItem('aivenue.token') ?? ''}\`;
  const ws = new WebSocket(url);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const call = (id, method, params) => new Promise((r) => {
    const h = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', h); r(m); } };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const info = await call(777, 'host.info');
  const list = await call(778, 'workflows.list');
  ws.close();
  const v = info.result ?? info;
  const l = list.result ?? list;
  return { version: v.version, build: v.build, dataDir: v.dataDir, runs: Array.isArray(l) ? l.map((x) => x.id) : l, sidebar: document.querySelector('.side-list')?.innerText ?? null };
})()`;
let result;
while (Date.now() < deadline) {
  const res = await send('Runtime.evaluate', { expression: IN_PAGE, awaitPromise: true, returnByValue: true });
  result = res.result?.result?.value;
  if (result?.version) break;
  result = { error: res.result?.exceptionDetails?.exception?.description ?? JSON.stringify(res).slice(0, 500) };
  await sleep(1500);
}
await sleep(1500);
try {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shot, Buffer.from(s.result.data, 'base64'));
} catch (e) {
  result.screenshotError = String(e);
}
fs.writeFileSync(out, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result));
process.exit(result?.version ? 0 : 1);
