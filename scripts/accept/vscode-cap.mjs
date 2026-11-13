// Settings → Capabilities inside the VS Code extension's webview (Aivenue opened in an editor tab by vscode-check.mjs):
// finds the webview frame running Aivenue, opens the pane there, checks the new sections and saves screenshots of the
// VS Code window.   node vscode-cap.mjs <port> <expected commit> <out dir>
import * as fs from 'node:fs';
import * as path from 'node:path';

const [port, wantCommit, outDir] = process.argv.slice(2);
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
const list = await targets();
const wbT = list.find((t) => t.type === 'page' && t.url.includes('workbench.html'));
const frames = list.filter((x) => x.type === 'iframe' && x.url.startsWith('vscode-webview://'));
const wb = cdp(wbT.webSocketDebuggerUrl);
await wb.ready;
let ctx;
let f;
for (const t of frames) {
  f = cdp(t.webSocketDebuggerUrl);
  await f.ready;
  await f.send('Runtime.enable');
  await sleep(1500);
  for (const c of f.contexts) {
    const p = await f.send('Runtime.evaluate', { expression: '!!window.__AIVENUE__ || !!document.querySelector(".side-list, .compact-bar, .settings")', contextId: c.id, returnByValue: true });
    if (p.result?.result?.value) {
      ctx = c.id;
      break;
    }
  }
  if (ctx) break;
}
if (!ctx) {
  console.log('  FAIL  no Aivenue frame in the VS Code webviews');
  process.exit(1);
}
const evaluate = async (expression) => {
  const res = await f.send('Runtime.evaluate', { expression, contextId: ctx, awaitPromise: true, returnByValue: true });
  if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'evaluation failed');
  return res.result?.result?.value;
};
const HUB = `(async () => {
  const url = window.__AIVENUE__?.wsUrl ?? \`ws://\${location.host}/ws?token=\${new URLSearchParams(location.search).get('token') ?? sessionStorage.getItem('aivenue.token') ?? ''}\`;
  const ws = new WebSocket(url);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const info = await new Promise((r) => { ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id === 901) r(m); }); ws.send(JSON.stringify({ id: 901, method: 'host.info' })); });
  ws.close();
  const v = info.result ?? info;
  return { version: v.version, build: v.build, dataDir: v.dataDir, host: v.host };
})()`;
const PANE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  location.hash = '#/settings/capabilities';
  for (let i = 0; i < 60 && !document.querySelector('.settings-body .builtin-skills'); i++) await sleep(250);
  await sleep(500);
  const sections = [...document.querySelectorAll('.settings-body section.cap')].map((s) => ({
    title: s.querySelector('h3')?.innerText.trim() ?? '',
    lists: [...s.querySelectorAll('.clist.builtin-skills')].map((l) => [...l.querySelectorAll('.crow-name')].map((n) => n.innerText.trim())),
    switches: [...s.querySelectorAll('.clist.builtin-skills input[type=checkbox]')].map((i) => ({ label: i.getAttribute('aria-label'), checked: i.checked, disabled: i.disabled })),
    labels: [...s.querySelectorAll('.block-label')].map((b) => b.innerText.trim()),
    roles: [...(s.querySelector('.clist.builtin-skills')?.querySelectorAll(':scope > .crow') ?? [])].map((c) => [...c.querySelectorAll('.tag')].map((t) => t.innerText.trim())),
  }));
  const extensions = [...document.querySelectorAll('.settings-body .ext-card')].map((c) => {
    const sw = c.querySelector('.ext-head input[type=checkbox]');
    const head = c.querySelector('.ext-head b')?.innerText ?? '';
    const r = c.getBoundingClientRect();
    return { icon: (head.match(/^[^A-Za-z]+/)?.[0] ?? '').trim(), name: head.replace(/^[^A-Za-z]+/, '').trim(), checked: sw?.checked ?? null, disabled: sw?.disabled ?? null, left: Math.round(r.left), right: Math.round(r.right) };
  });
  document.querySelector('.settings-body h2')?.scrollIntoView({ block: 'start' });
  await sleep(400);
  const se = document.scrollingElement;
  const body = document.querySelector('.settings-body');
  return { extensions, buildLine: document.querySelector('.build-info')?.innerText.replace(/\\s+/g, ' ').trim() ?? null, sections, width: innerWidth, pageOverflow: se.scrollWidth - se.clientWidth, bodyOverflow: body ? body.scrollWidth - body.clientWidth : null };
})()`;
let fails = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => (fails++, console.log(`  FAIL  ${m}`));
const chk = (m, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(`${m} (${JSON.stringify(got)})`) : bad(`${m}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
const hub = await evaluate(HUB);
ok(`hub answered: version ${hub.version}, build ${hub.build}, host ${hub.host}, data folder ${hub.dataDir}`);
chk('build commit', String(hub.build).split('-')[0], wantCommit.slice(0, 7));
chk('host', hub.host, 'vscode');
chk('version', hub.version, process.env.WANT_VERSION ?? '(WANT_VERSION not set)');
if (process.env.WANT_DATA_DIR) chk('data folder is the one given (AIVENUE_HOME)', path.resolve(String(hub.dataDir)).toLowerCase(), path.resolve(process.env.WANT_DATA_DIR).toLowerCase());
const pane = await evaluate(PANE);
await sleep(500);
const shot = async (file) => {
  const s = await wb.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, file), Buffer.from(s.result.data, 'base64'));
};
await shot('vscode-capabilities.png');
await evaluate(`(async () => { document.querySelector('.settings-body .ext-card')?.closest('section')?.scrollIntoView({ block: 'start' }); await new Promise((r) => setTimeout(r, 400)); })()`);
await shot('vscode-extensions.png');
await evaluate(`(async () => { const h = [...document.querySelectorAll('.settings-body section.cap h3')].find((x) => /按需使用的內建 Skill|Built-in skills used on demand/.test(x.innerText)); h?.closest('section')?.scrollIntoView({ block: 'start' }); await new Promise((r) => setTimeout(r, 400)); })()`);
await shot('vscode-skills.png');
const either = (zh, en) => (s) => s === zh || s === en;
const find = (is) => pane.sections.find((x) => is(x.title));
const at = `VS Code editor tab (${pane.width}px)`;
chk(`${at}: build line in Settings shows the same build`, pane.buildLine?.includes(String(hub.build)), true);
chk(`${at}: section "內建擴充", the four extension cards`, pane.extensions.map((x) => x.name), ['Ponytail', 'Agent Skills', 'Graphify', 'OmniRoute']);
chk(`${at}: extension switches, off in a clean AIVENUE_HOME and usable`, pane.extensions.map((x) => `${x.name}:${x.checked ? 'on' : 'off'}${x.disabled ? ':disabled' : ''}`), ['Ponytail:off', 'Agent Skills:off', 'Graphify:off', 'OmniRoute:off']);
chk(`${at}: Ponytail icon`, pane.extensions[0]?.icon ?? null, '🎀');
chk(`${at}: every extension card inside the window`, pane.extensions.every((x) => x.left >= 0 && x.right <= pane.width), true);
chk(`${at}: section "按需使用的內建 Skill"`, find(either('按需使用的內建 Skill', 'Built-in skills used on demand'))?.lists[0] ?? null, ['gh-fix-ci', 'gh-address-comments', 'security-audit']);
const pack = find(either('可開關的內建 Skill', 'Built-in skills you can turn on'));
chk(`${at}: section "可開關的內建 Skill", its four skills`, pack?.lists[0] ?? null, ['improve-codebase-architecture + codebase-design', 'diagnosing-bugs', 'gha-security-review', 'web-design-guidelines']);
chk(`${at}: four switches, off by default and usable`, pack?.switches.map((x) => `${x.label}:${x.checked ? 'on' : 'off'}${x.disabled ? ':disabled' : ''}`) ?? null, ['improve-codebase-architecture + codebase-design:off', 'diagnosing-bugs:off', 'gha-security-review:off', 'web-design-guidelines:off']);
chk(`${at}: roles each one is offered to`, pack?.roles.map((r) => r.length) ?? null, [1, 2, 1, 1]);
chk(`${at}: "設計參考（不會載入）", three names`, pack ? [either('設計參考（不會載入）', 'Design references (not loaded)')(pack.labels[0] ?? ''), pack.lists[1]] : null, [true, ['impeccable', 'frontend-testing-debugging', 'accessibility-inspect']]);
chk(`${at}: "共用 Skills" still there`, Boolean(find(either('共用 Skills', 'Shared skills'))), true);
chk(`${at}: no sideways scrolling (page, pane)`, [pane.pageOverflow <= 0, (pane.bodyOverflow ?? 0) <= 0], [true, true]);
fs.writeFileSync(path.join(outDir, 'vscode-capabilities.json'), JSON.stringify({ hub, pane }, null, 1));
console.log(`  ${fails ? 'FAIL' : 'PASS'}  vscode: ${fails} failed`);
wb.close();
f.close();
process.exit(fails ? 1 : 0);
