// Acceptance of one running Aivenue window (started with --remote-debugging-port, a fresh AIVENUE_HOME): reads the
// version and build from its own hub, opens Settings → Capabilities, and checks the sections this build adds, at the
// window's own width and at a narrow one; then every Settings tab at the width of the VS Code side bar (290px), which
// must fit without scrolling sideways. Saves a screenshot of each and the read-back JSON.
//   WANT_VERSION=<expected version> [WANT_DATA_DIR=<AIVENUE_HOME>] node capabilities-check.mjs <port> <expected commit (7+)> <out dir> [<name>]
// Prints one PASS / FAIL line per check; exits 1 when any check fails.
import * as fs from 'node:fs';
import * as path from 'node:path';

const [port, wantCommit, outDir, name = 'app'] = process.argv.slice(2);
if (!port || !wantCommit || !outDir) {
  console.error('usage: node capabilities-check.mjs <port> <expected commit> <out dir> [<name>]');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + 90_000;
let page;
while (!page && Date.now() < deadline) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    page = list.find((t) => t.type === 'page' && /^(http:\/\/127\.0\.0\.1|vscode-webview)/.test(t.url) && t.webSocketDebuggerUrl);
  } catch {
    // not up yet
  }
  if (!page) await sleep(1000);
}
if (!page) {
  console.log('  FAIL  no Aivenue window on the debugging port');
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) (pending.get(msg.id)(msg), pending.delete(msg.id));
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'evaluation failed');
  return res.result?.result?.value;
};

// The hub's own answer: version and build of the background service.
const HUB = `(async () => {
  const url = window.__AIVENUE__?.wsUrl ?? \`\${location.protocol === 'https:' ? 'wss' : 'ws'}://\${location.host}/ws?token=\${new URLSearchParams(location.search).get('token') ?? sessionStorage.getItem('aivenue.token') ?? ''}\`;
  const ws = new WebSocket(url);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const info = await new Promise((r) => {
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id === 901) r(m); });
    ws.send(JSON.stringify({ id: 901, method: 'host.info' }));
  });
  ws.close();
  const v = info.result ?? info;
  return { version: v.version, build: v.build, dataDir: v.dataDir, host: v.host ?? v.kind ?? null };
})()`;
// What Settings → Capabilities shows: every section's title, its lists of names, its switches, the build line.
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
    // The roles of the first list's skills (the switchable ones; the design references have none).
    roles: [...(s.querySelector('.clist.builtin-skills')?.querySelectorAll(':scope > .crow') ?? [])].map((c) => [...c.querySelectorAll('.tag')].map((t) => t.innerText.trim())),
  }));
  // The four built-in extension cards (section "內建擴充"): name, switch, and whether the card fits in the window.
  const extensions = [...document.querySelectorAll('.settings-body .ext-card')].map((c) => {
    const sw = c.querySelector('.ext-head input[type=checkbox]');
    const r = c.getBoundingClientRect();
    const head = c.querySelector('.ext-head b')?.innerText ?? '';
    return { icon: (head.match(/^[^A-Za-z]+/)?.[0] ?? '').trim(), name: head.replace(/^[^A-Za-z]+/, '').trim(), checked: sw?.checked ?? null, disabled: sw?.disabled ?? null, left: Math.round(r.left), right: Math.round(r.right) };
  });
  // Back to the top of the pane, so the first screenshot shows the heading and the extension cards.
  document.querySelector('.settings-body h2')?.scrollIntoView({ block: 'start' });
  await sleep(400);
  const se = document.scrollingElement;
  const body = document.querySelector('.settings-body');
  return {
    extensions,
    hash: location.hash,
    lang: document.documentElement.lang || navigator.language,
    buildLine: document.querySelector('.build-info')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
    heading: document.querySelector('.settings-body h2')?.innerText.trim() ?? null,
    sections,
    width: innerWidth,
    pageOverflow: se.scrollWidth - se.clientWidth,
    bodyOverflow: body ? body.scrollWidth - body.clientWidth : null,
  };
})()`;

let fails = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => (fails++, console.log(`  FAIL  ${m}`));
const chk = (m, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(`${m} (${JSON.stringify(got)})`) : bad(`${m}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

let hub;
while (Date.now() < deadline) {
  try {
    hub = await evaluate(HUB);
    if (hub?.version) break;
  } catch {
    // the page is still loading
  }
  await sleep(1500);
}
const result = { hub, views: {} };
const either = (zh, en) => (s) => s === zh || s === en;
const ON_DEMAND = either('按需使用的內建 Skill', 'Built-in skills used on demand');
const PACK = either('可開關的內建 Skill', 'Built-in skills you can turn on');
// Round D: the label without brackets; 「不會載入」 a quiet note beside it.
const SHARED = either('共用 Skill', 'Shared skills');

if (!hub?.version) bad('the hub answered host.info');
else {
  ok(`hub answered: version ${hub.version}, build ${hub.build}, data folder ${hub.dataDir}`);
  if (process.env.WANT_DATA_DIR) chk('data folder is the one given (AIVENUE_HOME)', path.resolve(String(hub.dataDir)).toLowerCase(), path.resolve(process.env.WANT_DATA_DIR).toLowerCase());
  chk('build commit', String(hub.build).split('-')[0], wantCommit.slice(0, 7));
  // The expected version is given by the caller (WANT_VERSION); a run without it fails here instead of passing quietly.
  chk('version', hub.version, process.env.WANT_VERSION ?? '(WANT_VERSION not set)');
}

// The window as it opened, then a narrow one (the pane must fit without scrolling sideways).
for (const [view, width] of [['wide', null], ['narrow', 420]]) {
  if (width) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(800);
  }
  let pane;
  try {
    pane = await evaluate(PANE);
  } catch (e) {
    bad(`${view}: read Settings → Capabilities (${e.message})`);
    continue;
  }
  result.views[view] = pane;
  try {
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(outDir, `${name}-capabilities-${view}.png`), Buffer.from(s.result.data, 'base64'));
    // The extension cards, scrolled to the top of the window (at 420px the top screenshot shows only the first card).
    await evaluate(`(async () => { document.querySelector('.settings-body .ext-card')?.closest('section')?.scrollIntoView({ block: 'start' }); await new Promise((r) => setTimeout(r, 400)); })()`);
    const s1 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(outDir, `${name}-extensions-${view}.png`), Buffer.from(s1.result.data, 'base64'));
    // And the new sections themselves, scrolled to the top of the window.
    await evaluate(`(async () => { const h = [...document.querySelectorAll('.settings-body section.cap h3')].find((x) => /按需使用的內建 Skill|Built-in skills used on demand/.test(x.innerText)); h?.closest('section')?.scrollIntoView({ block: 'start' }); await new Promise((r) => setTimeout(r, 400)); })()`);
    const s2 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(outDir, `${name}-skills-${view}.png`), Buffer.from(s2.result.data, 'base64'));
  } catch (e) {
    pane.screenshotError = String(e);
  }
  const at = `${view} (${pane.width}px)`;
  const find = (is) => pane.sections.find((x) => is(x.title));
  chk(`${at}: build line in Settings shows the same build`, pane.buildLine?.includes(String(hub?.build)), true);
  chk(`${at}: section "內建擴充", the four extension cards`, pane.extensions.map((x) => x.name), ['Ponytail', 'Agent Skills', 'Graphify', 'OmniRoute']);
  chk(`${at}: extension switches, off in a clean AIVENUE_HOME and usable`, pane.extensions.map((x) => `${x.name}:${x.checked ? 'on' : 'off'}${x.disabled ? ':disabled' : ''}`), ['Ponytail:off', 'Agent Skills:off', 'Graphify:off', 'OmniRoute:off']);
  // No icon before the name since UI round C (emoji icons are gone; the name says it). Before: 🎀, and earlier 🪮,
  // which showed as an empty box on Ubuntu 20.04.
  chk(`${at}: no emoji icon before an extension's name`, pane.extensions.map((x) => x.icon), ['', '', '', '']);
  chk(`${at}: every extension card inside the window`, pane.extensions.every((x) => x.left >= 0 && x.right <= pane.width), true);
  const onDemand = find(ON_DEMAND);
  chk(`${at}: section "按需使用的內建 Skill"`, onDemand?.lists[0] ?? null, ['gh-fix-ci', 'gh-address-comments', 'security-audit']);
  const pack = find(PACK);
  chk(`${at}: section "可開關的內建 Skill", its four skills`, pack?.lists[0] ?? null, ['improve-codebase-architecture + codebase-design', 'diagnosing-bugs', 'gha-security-review', 'web-design-guidelines']);
  chk(`${at}: four switches, off by default and usable`, pack?.switches.map((x) => `${x.label}:${x.checked ? 'on' : 'off'}${x.disabled ? ':disabled' : ''}`) ?? null, ['improve-codebase-architecture + codebase-design:off', 'diagnosing-bugs:off', 'gha-security-review:off', 'web-design-guidelines:off']);
  chk(`${at}: roles each one is offered to`, pack?.roles.map((r) => r.length) ?? null, [1, 2, 1, 1]);
  chk(`${at}: no "設計參考" list any more (removed in 0.4.3: none of them could be offered to agents)`, pack ? [pack.labels.length, pack.lists.length] : null, [0, 1]);
  chk(`${at}: "共用 Skill" still there`, Boolean(find(SHARED)), true);
  chk(`${at}: no sideways scrolling (page, pane)`, [pane.pageOverflow <= 0, (pane.bodyOverflow ?? 0) <= 0], [true, true]);
}
// Every Settings tab at the width of the VS Code side bar (Aivenue in the secondary side bar is about 290px wide): no
// sideways scrolling, nothing sticking out of the pane, and a setting's own text not squeezed beside its control (it
// used to wrap one or two characters a line, the control pushing the row past the edge).
// A tab is measured only once it is the one shown: the tab link Settings marks as selected and the pane's own heading
// must both be that tab's. Every tab has a pane, so waiting for "a pane" could measure the previous tab again.
const SIDE_WIDTH = 290;
const SIDE_TABS = {
  general: ['一般', 'General'],
  providers: ['供應商與帳號', 'Providers & accounts'],
  capabilities: ['能力', 'Capabilities'],
  usage: ['用量', 'Usage'],
  memory: ['記憶', 'Memory'],
};
// go = false: do not switch to the tab (the control below).
const SIDE = (tab, go = true) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const want = ${JSON.stringify(SIDE_TABS[tab])};
  const shown = () => {
    const link = document.querySelector('.settings-nav a.active')?.getAttribute('href') ?? null;
    const heading = document.querySelector('.settings-body .pane .pane-head h2')?.innerText.trim() ?? null;
    return { link, heading, ok: link === '#/settings/${tab}' && want.includes(heading) };
  };
  if (${go}) location.hash = '#/settings/${tab}';
  let s = shown();
  for (let i = 0; i < 40 && !s.ok; i++) {
    await sleep(250);
    s = shown();
  }
  if (!s.ok) return { notShown: s };
  await sleep(1500);
  // Still that tab once it has settled.
  s = shown();
  if (!s.ok) return { notShown: s };
  const se = document.scrollingElement;
  const body = document.querySelector('.settings-body');
  if (!body) return { missing: true };
  const right = body.getBoundingClientRect().left + body.clientWidth;
  // A box inside something the user can scroll sideways (a table, a code block) may be wider than the pane; one cut
  // off by overflow: hidden is not (the list cards clip their rows, so a button pushed past the edge just disappears).
  // Boxes nobody sees do not count (the custom colour's own picker is transparent inside its swatch).
  const clipped = (e) => { for (let p = e.parentElement; p && p !== body; p = p.parentElement) if (/auto|scroll/.test(getComputedStyle(p).overflowX)) return true; return false; };
  const name = (e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).join('.') : '');
  const out = [...body.querySelectorAll('*')].filter((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.right > right + 1 && cs.visibility !== 'hidden' && cs.opacity !== '0' && !clipped(e); });
  const settings = [...body.querySelectorAll('section.setting')].map((s) => {
    const text = s.firstElementChild;
    return { title: s.querySelector('.setting-title')?.innerText.trim() ?? '', textWidth: Math.round(text?.getBoundingClientRect().width ?? 0), overflow: s.scrollWidth - s.clientWidth };
  });
  return { shown: s, width: innerWidth, pageOverflow: se.scrollWidth - se.clientWidth, bodyOverflow: body.scrollWidth - body.clientWidth, out: out.slice(0, 8).map((e) => name(e) + ' → ' + Math.round(e.getBoundingClientRect().right - right) + 'px'), outCount: out.length, settings };
})()`;
await send('Emulation.setDeviceMetricsOverride', { width: SIDE_WIDTH, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(800);
result.sideBar = {};
for (const tab of Object.keys(SIDE_TABS)) {
  const at = `side bar (${SIDE_WIDTH}px), Settings → ${tab}`;
  let v;
  try {
    v = await evaluate(SIDE(tab));
  } catch (e) {
    bad(`${at}: read the page (${e.message})`);
    continue;
  }
  result.sideBar[tab] = v;
  try {
    await evaluate(`(async () => { document.querySelector('.settings-body')?.scrollTo(0, 0); await new Promise((r) => setTimeout(r, 300)); })()`);
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(outDir, `${name}-sidebar-${tab}.png`), Buffer.from(s.result.data, 'base64'));
  } catch (e) {
    v.screenshotError = String(e);
  }
  if (v.notShown) {
    bad(`${at}: that tab is the one shown before measuring (selected tab ${v.notShown.link}, heading "${v.notShown.heading}"); not measured`);
    continue;
  }
  if (v.missing) {
    bad(`${at}: the settings pane is there`);
    continue;
  }
  ok(`${at}: that tab is the one shown (selected tab ${v.shown.link}, heading "${v.shown.heading}")`);
  chk(`${at}: no sideways scrolling (page, pane)`, [v.pageOverflow <= 0, v.bodyOverflow <= 0], [true, true]);
  chk(`${at}: nothing sticks out of the pane`, v.out, []);
  if (v.settings.length) {
    chk(`${at}: every setting fits (no row wider than the pane)`, v.settings.filter((x) => x.overflow > 0).map((x) => x.title), []);
    chk(`${at}: each setting's text has room (at least 160px wide, not squeezed beside its control)`, v.settings.filter((x) => x.textWidth < 160).map((x) => `${x.title}: ${x.textWidth}px`), []);
  }
}
// Control: the check itself. Ask for a tab that is not the one shown, without switching to it, as when a switch fails:
// it must come back as not shown and never be measured. If a stale page passed here, the results above could not be
// trusted either.
try {
  const current = await evaluate(`document.querySelector('.settings-nav a.active')?.getAttribute('href') ?? null`);
  const other = Object.keys(SIDE_TABS).find((t) => `#/settings/${t}` !== current);
  const c = await evaluate(SIDE(other, false));
  result.sideBar.control = { asked: other, current, ...c };
  chk(`side bar (${SIDE_WIDTH}px), control: ${other} asked for while ${current} stays shown (a failed switch) is reported as not shown, not measured`, [Boolean(c.notShown), 'pageOverflow' in c], [true, false]);
} catch (e) {
  bad(`side bar (${SIDE_WIDTH}px), control: ran (${e.message})`);
}
await send('Emulation.clearDeviceMetricsOverride');
fs.writeFileSync(path.join(outDir, `${name}-capabilities.json`), JSON.stringify(result, null, 1));
console.log(`  ${fails ? 'FAIL' : 'PASS'}  ${name}: ${fails} failed; screenshots and JSON in ${outDir}`);
process.exit(fails ? 1 : 0);
