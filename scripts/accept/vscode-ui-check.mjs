// The chat page inside a real VS Code webview, with OpenCode's free model by default (no other agent's quota). With
// ACC_PROVIDER=codex~<name> and ACC_ACCOUNT_DIR set to that extra account's folder (e.g. ~/.aivenue/accounts/codex/
// <name>), Codex runs as that extra account, as in Aivenue: the isolated AIVENUE_HOME lists the account and links its
// folder (a junction, removed at the end; nothing is copied). ACC_PROVIDER=codex with CODEX_HOME set to an account's
// folder runs Codex under it as the default account. Never point either at the user's main account unless told to:
//   node vscode-ui-check.mjs <aivenue.vsix> <out dir> [<VS Code folder>]
// A throwaway VS Code profile (user data and extensions folders) and an isolated AIVENUE_HOME: the user's own VS Code
// and ~/.aivenue are never touched. One window, project folder "proj"; Aivenue in an editor tab (wide) and in the
// secondary side bar (narrow), in VS Code's light and dark themes. Two real chats: one that runs a check, fixes the
// code and edits after the check (its summary asked for as a Markdown table); one that waits on a question. For each
// place, theme and scene, a window screenshot and checks inside the webview:
//  - Lucide icons drawn, no emoji or text-symbol icon left in a button;
//  - the result card's verification states apart (with their reasons) and the "agent's own words" tag;
//  - agents' Markdown drawn: no raw table rows or code fences; a table in the reply is a table;
//  - the waiting state and its question in view: the agent's answers to pick from, "Other", a box, nothing sent yet;
//  - the folder path: a button the keyboard reaches; when cut, it opens to the whole path;
//  - every message's time shown (the user's, the timeline's lines); an agent's turn shows how long it took from 10 s up,
//    its start and end in that time's tooltip and its activity log;
//  - nothing past the webview's width, no control cut by its box or drawn over another;
//  - the hub killed while a follow-up is being written: the extension starts it again, the page connects to the new
//    port by itself, is not reloaded, and keeps the unsent text and the chat shown.
// PASS / FAIL lines, and JSON + screenshots in <out dir>.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareOutDir } from './out-dir.mjs';

const [vsix, outArg, codeDirArg] = process.argv.slice(2);
if (!vsix || !outArg) {
  console.error('usage: node vscode-ui-check.mjs <aivenue.vsix> <out dir> [<VS Code folder>]');
  process.exit(2);
}
const OUT = path.resolve(outArg);
const codeDir = codeDirArg ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code');
const codeExe = path.join(codeDir, 'Code.exe');
const codeCli = path.join(codeDir, 'bin', 'code.cmd');
const PORT = Number(process.env.ACC_PORT || 9341);
const PROVIDER = process.env.ACC_PROVIDER || 'opencode';
const MODEL = process.env.ACC_MODEL ?? process.env.WAKE_MODEL ?? (PROVIDER === 'opencode' ? 'opencode/deepseek-v4.1-flash-free' : undefined);
const author = { provider: PROVIDER, ...(MODEL ? { model: MODEL } : {}) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
let fails = 0;
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  if (!ok) fails++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`);
};
async function until(fn, what, ms = 60_000, every = 1000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(every);
  }
}

// Emptied only when new, empty or an earlier output folder of an acceptance script (see out-dir.mjs).
prepareOutDir(OUT, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
const ud = path.join(OUT, 'vscode-user');
const ext = path.join(OUT, 'vscode-ext');
const home = path.join(OUT, 'aivenue-home');
const proj = path.join(OUT, 'proj');
for (const d of [ud, ext, home, proj]) fs.mkdirSync(d, { recursive: true });
// An extra account (provider~slug): listed in the isolated home, its folder linked in where Aivenue keeps it.
const accountMatch = /^([a-z0-9_-]+)~([a-z0-9_.-]+)$/i.exec(PROVIDER);
const accountDir = process.env.ACC_ACCOUNT_DIR ? path.resolve(process.env.ACC_ACCOUNT_DIR) : undefined;
let accountLink;
if (accountMatch) {
  if (!accountDir || !fs.existsSync(accountDir)) {
    console.error(`ACC_PROVIDER=${PROVIDER} is an extra account: set ACC_ACCOUNT_DIR to its folder.`);
    process.exit(2);
  }
  const [, providerId, slug] = accountMatch;
  fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({ providers: [], hidden: [], settings: {}, accounts: [{ providerId, slug, name: slug }] }, null, 2));
  fs.mkdirSync(path.join(home, 'accounts', providerId), { recursive: true });
  accountLink = path.join(home, 'accounts', providerId, slug);
  fs.symlinkSync(accountDir, accountLink, 'junction');
}
fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
const settingsFile = path.join(ud, 'User', 'settings.json');
// No telemetry prompt, welcome page, workspace-trust or Copilot sign-in dialog (a fresh profile opens one over the
// window and it takes every key).
const settings = (theme) => ({ 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'chat.disableAIFeatures': true, 'workbench.colorTheme': theme });
fs.writeFileSync(settingsFile, JSON.stringify(settings('Default Light Modern')));
const env = { ...process.env, AIVENUE_HOME: home, AIVENUE_HUB_GRACE_MS: '8000' };
delete env.ELECTRON_RUN_AS_NODE;
// cmd /s /c "<line>": /s drops the outer quotes only, so the line keeps its own quoted paths (VS Code's has spaces).
const cli = (args) => spawnSync('cmd.exe', ['/d', '/s', '/c', `""${codeCli}" ${args.map((a) => `"${a}"`).join(' ')}"`], { env, encoding: 'utf8', windowsVerbatimArguments: true, timeout: 120_000 });
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// ---------- CDP ----------
const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
function cdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const contexts = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.method === 'Runtime.executionContextCreated') contexts.push(msg.params.context);
    if (msg.method === 'Runtime.executionContextDestroyed') {
      const i = contexts.findIndex((c) => c.id === msg.params.executionContextId);
      if (i >= 0) contexts.splice(i, 1);
    }
    if (msg.id && pending.has(msg.id)) (pending.get(msg.id)(msg), pending.delete(msg.id));
  };
  const ready = new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  return { ready, send, contexts, close: () => ws.close() };
}
const key = async (c, k, code, vk, mods = 0) => {
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
};
/** Run a command from the window's command palette (Esc first: a dialog would take the keys). */
async function palette(w, text) {
  await w.send('Page.bringToFront');
  await sleep(700);
  await key(w, 'Escape', 'Escape', 27);
  await sleep(500);
  await key(w, 'F1', 'F1', 112);
  await sleep(1200);
  await w.send('Input.insertText', { text });
  await sleep(1500);
  await key(w, 'Enter', 'Enter', 13);
}

/** Every Aivenue webview in the window: its own connection to the hub, and its width. */
const SETUP = `(async () => {
  if (window.__acc) return true;
  const ws = new WebSocket(window.__AIVENUE__.wsUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let n = 0; const wait = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
  window.__acc = { call: (method, params = {}) => new Promise((r) => { const id = 9000 + (++n); wait.set(id, r); ws.send(JSON.stringify({ id, method, params, op: 'acc-' + Date.now() + '-' + n })); }) };
  return true;
})()`;
async function frames() {
  const found = [];
  for (const t of (await targets()).filter((x) => x.type === 'iframe' && x.url.startsWith('vscode-webview://'))) {
    const f = cdp(t.webSocketDebuggerUrl);
    await f.ready;
    await f.send('Runtime.enable');
    await sleep(800);
    for (const c of f.contexts) {
      const r = await f.send('Runtime.evaluate', { expression: '!!window.__AIVENUE__?.wsUrl', contextId: c.id, returnByValue: true });
      if (!r.result?.result?.value) continue;
      const evaluate = async (expression) => {
        const res = await f.send('Runtime.evaluate', { expression, contextId: c.id, awaitPromise: true, returnByValue: true });
        if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'evaluation failed');
        return res.result?.result?.value;
      };
      await evaluate(SETUP);
      const call = async (method, params) => evaluate(`window.__acc.call(${JSON.stringify(method)}, ${JSON.stringify(params ?? {})})`);
      found.push({ target: t.id, evaluate, call, width: await evaluate('window.innerWidth') });
    }
  }
  return found;
}

const goalChecks = [
  '這是驗收測試，請完全照步驟做，每一步都用終端機指令或編輯工具真的做。',
  "1. 建立 slug.js：module.exports = (s) => s.trim().toLowerCase().replace(/\\s+/g, '_');（故意用底線）",
  "2. 建立 slug.test.js：const assert = require('node:assert'); const slug = require('./slug'); assert.strictEqual(slug(' Hello World '), 'hello-world'); console.log('slug: 1 check passed');",
  '3. 執行 node slug.test.js（會失敗）。',
  "4. 把 slug.js 的底線改成連字號 '-'，再執行一次 node slug.test.js（應該通過）。",
  '5. 測試通過之後，再用編輯工具在 slug.js 最上面加一行註解 // slug helper（之後不要再跑測試）。',
  '6. 提交（submit_work）。摘要先用一句話說明，再用 Markdown 表格列出每一步（欄位：步驟、動作、結果），最後附上 slug.js 的最終內容（程式碼區塊）。',
].join('\n');
const goalAsk = [
  '這是驗收測試，請完全照步驟做。',
  '1. 先用 Aivenue 的 ask_user 工具問使用者：「新模組要叫什麼名字？」選項 ["alpha", "beta"]。問完立刻結束這一回合，不要做其他事。',
  '2. 使用者回答後，在工作資料夾建立 <回答>.txt，內容一行 OK，然後提交（submit_work）。',
].join('\n');
const cfg = (cwd, goal, title) => ({
  title,
  goal,
  userText: goal,
  cwd,
  plan: { enabled: false, author, reviewer: null, maxRounds: 1, humanGate: false },
  implement: { enabled: true, author, reviewer: null, maxRounds: 1, humanGate: false },
  verify: { enabled: false, by: 'planner', repeatLimit: 1 },
  subagents: { enabled: false, allowed: [], maxDepth: 1, maxConcurrent: 1 },
  assignment: { mode: 'manual' },
  permission: 'auto',
  isolation: 'none',
  memory: { mode: 'off' },
});

/** What a scene shows, read inside the webview: icons, leftover symbol icons, states, the folder path, overflow. */
const INSPECT = `(() => {
  const W = document.documentElement.clientWidth;
  const clipped = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p); if (/(hidden|auto|scroll|clip)/.test(s.overflowX) && p.getBoundingClientRect().right <= W + 0.5) return true; } return false; };
  const past = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.right <= W + 0.5 || clipped(el)) continue;
    past.push((typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : el.tagName.toLowerCase()) + ' +' + Math.round(r.right - W) + 'px');
  }
  // Controls a clipping parent cuts, or drawn over one another: what a count past the window does not see (a composer
  // with rounded, clipped corners hides what overflows it). Floating controls (absolute, fixed) and scrolled content
  // are left out.
  const floating = (e) => { for (let p = e; p && p !== document.body; p = p.parentElement) if (/^(absolute|fixed)$/.test(getComputedStyle(p).position)) return true; return false; };
  const ctl = [...document.querySelectorAll('button, a[href], [role="button"]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && !floating(e); });
  const nameOf = (e) => (typeof e.className === 'string' && e.className ? '.' + e.className.split(' ')[0] : e.tagName.toLowerCase()) + (e.textContent.trim() ? ' "' + e.textContent.trim().slice(0, 12) + '"' : '');
  const cutControls = [];
  for (const e of ctl) {
    const r = e.getBoundingClientRect();
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll)/.test(s.overflowX + ' ' + s.overflowY)) break;
      if (/(hidden|clip)/.test(s.overflowX)) {
        const q = p.getBoundingClientRect();
        if (r.right > q.right + 1 || r.left < q.left - 1) cutControls.push(nameOf(e) + ' cut by ' + nameOf(p));
        break;
      }
    }
  }
  /** The part of a control in view: its box cut by every ancestor that clips or scrolls (none: hidden). */
  const shown = (e) => {
    let { left, top, right, bottom } = e.getBoundingClientRect();
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const q = p.getBoundingClientRect();
      left = Math.max(left, q.left); top = Math.max(top, q.top); right = Math.min(right, q.right); bottom = Math.min(bottom, q.bottom);
    }
    return right - left > 1 && bottom - top > 1 ? { left, top, right, bottom } : null;
  };
  const vis = ctl.map(shown);
  const overlaps = [];
  for (let i = 0; i < ctl.length; i++)
    for (let j = i + 1; j < ctl.length; j++) {
      const a = ctl[i], b = ctl[j];
      if (a.contains(b) || b.contains(a)) continue;
      // Only what is in view: a control scrolled out of its scrolling box is not drawn over anything.
      const r = vis[i], q = vis[j];
      if (!r || !q) continue;
      if (Math.min(r.right, q.right) - Math.max(r.left, q.left) > 2 && Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top) > 2) overlaps.push(nameOf(a) + ' over ' + nameOf(b));
    }
  // Symbols that used to be icons: none should be left in the label of a button or a pill. What a button only shows of
  // an agent's work (a command, a path, a note, code) is the agent's text, not the button's label: left out.
  const SYMBOL = /[\\u{1F300}-\\u{1FAFF}]|[☰＋⚙«✎✏✕✓✗▾▸↑❚▶■⚠✦↓⋯⇄○✳⏸⏺⎿➜↺↻✻✋●◦⚡🛑❓↳✅]/u;
  const ownLabel = (e) => { const c = e.cloneNode(true); c.querySelectorAll('code, pre, .md, .tl-arg, .note-text, .check-cmd').forEach((x) => x.remove()); return c.textContent.trim(); };
  const leftovers = [...document.querySelectorAll('button, a.icon-btn, .pill-btn, .side-link, .ext-chip, .vstate, .badge')].map(ownLabel).filter((s) => SYMBOL.test(s));
  const btn = document.querySelector('.run-cwd-btn');
  const pathEl = document.querySelector('.run-cwd-path');
  return {
    width: W,
    bg: getComputedStyle(document.body).backgroundColor,
    lucide: document.querySelectorAll('svg.lucide').length,
    leftovers: leftovers.slice(0, 8),
    states: [...document.querySelectorAll('.vstate-row')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim()),
    selfTag: !!document.querySelector('.self-tag'),
    waiting: !!document.querySelector('.decision') && /等待你的決定|Waiting for your decision/.test(document.body.innerText),
    // The agent's question: its answers to pick from, "Other" last, the box, and nothing sent before a pick.
    question: (() => {
      const q = document.querySelector('.decision.question');
      if (!q) return null;
      const choices = [...q.querySelectorAll('.answer-choice')];
      const send = [...q.querySelectorAll('button')].find((b) => /送出回答|Send the answer/.test(b.textContent));
      return { choices: choices.map((c) => c.innerText.trim()), radios: q.querySelectorAll('input[type=radio]').length, other: /其他|Other/.test(choices.at(-1)?.innerText ?? ''), box: !!q.querySelector('textarea'), sendDisabled: !!send?.disabled,
        // Before a pick no answer may look picked (its dot drawn): a native radio once showed as a filled dot.
        looksPicked: [...q.querySelectorAll('input[type=radio]')].filter((r) => r.checked || getComputedStyle(r, '::before').transform !== 'matrix(0, 0, 0, 0, 0, 0)').length };
    })(),
    cwd: btn ? { focusable: btn.tabIndex >= 0 && !btn.disabled, cut: pathEl.scrollWidth > pathEl.clientWidth + 1, expandable: btn.getAttribute('aria-expanded') !== null, text: pathEl.textContent } : null,
    past: past.slice(0, 10),
    pastCount: past.length,
    cutControls: cutControls.slice(0, 10),
    overlaps: overlaps.slice(0, 10),
    // Agents' Markdown drawn, not shown as source: no table delimiter row or code fence left in the text.
    rawMarkdown: [...document.querySelectorAll('.md')].map((e) => e.innerText).filter((t) => /^\\s*\\|?\\s*:?-{3,}:?\\s*\\|/m.test(t) || /^\\s*\`\`\`/m.test(t)).map((t) => t.slice(0, 60)),
    tables: document.querySelectorAll('.md table').length,
    // Every message shows when it was said: the user's, the timeline's lines. An agent's turn shows how long it took from
    // 10 s up — "4 分 58 秒", never "0s", a clock-like "4:58" or "用時" — with its start (and end) as that time's tooltip;
    // a shorter turn shows none. Each turn's head carries its length in seconds (data-took-s), so every turn is checked.
    times: (() => {
      const heads = [...document.querySelectorAll('.turn-meta')];
      const bad = [];
      let shown = 0;
      for (const h of heads) {
        const s = h.dataset.tookS === undefined ? undefined : Number(h.dataset.tookS);
        const tm = h.querySelector('time.turn-time');
        if (/\\b0s\\b|\\b\\d{1,2}:\\d{2}\\b|用時|(^|\\D)0 秒/.test(h.textContent)) bad.push('head: ' + h.textContent.trim().slice(0, 60));
        if (tm) {
          shown++;
          const iso = tm.getAttribute('datetime') ?? '';
          if (!/^PT\\d+S$/.test(iso) || (s !== undefined && iso !== 'PT' + s + 'S')) bad.push('datetime ' + iso + ' for ' + s + ' s');
          if (!/開始|Started/.test(tm.title)) bad.push('title: ' + tm.title);
          if (!/^\\d+ (秒|分|小時)|^\\d+[smh]\\b/.test(tm.textContent.trim())) bad.push('text: ' + tm.textContent.trim());
        }
        if (s !== undefined && s >= 10 && !tm) bad.push('no time on a turn of ' + s + ' s');
        if (s !== undefined && s < 10 && tm) bad.push('a time on a turn of ' + s + ' s');
      }
      return { user: document.querySelectorAll('.user-actions time.msg-time').length, lines: document.querySelectorAll('.divider time.msg-time').length, turns: heads.length, measured: heads.filter((h) => h.dataset.tookS !== undefined).length, shown, bad: bad.slice(0, 8) };
    })(),
    scrollX: document.documentElement.scrollWidth > W,
  };
})()`;
/** Open the cut folder path from the keyboard's point of view: focus the button, press it (Enter does the same on a button). */
const OPEN_CWD = `(async () => {
  const btn = document.querySelector('.run-cwd-btn');
  if (!btn) return null;
  btn.focus();
  const focused = document.activeElement === btn;
  btn.click();
  await new Promise((r) => setTimeout(r, 300));
  const p = document.querySelector('.run-cwd-path');
  const r = { focused, expanded: btn.getAttribute('aria-expanded'), whole: !!document.querySelector('.run-cwd.whole'), fits: p.scrollWidth <= p.clientWidth + 1 };
  btn.click();
  await new Promise((r) => setTimeout(r, 200));
  r.closedAgain = btn.getAttribute('aria-expanded') === 'false' && !document.querySelector('.run-cwd.whole');
  return r;
})()`;

/** This throwaway VS Code's processes, and its hub (never the user's VS Code). */
function ourCode() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Code.exe' -and $_.CommandLine -like '*${ud.replace(/'/g, "''")}*' } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8' });
  return r.stdout.split(/\s+/).filter(Boolean).map(Number);
}
function hubProcesses() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${ext.replace(/'/g, "''")}*hub.cjs*' } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8' });
  return r.stdout.split(/\s+/).filter(Boolean).map(Number);
}
const shots = [];
const missing = [];
/**
 * A window screenshot. A window that is minimized (or covered, despite the flags it was started with) draws nothing
 * and the capture would wait for ever: after 15 s it is skipped and said so; the checks read the page, not the picture.
 */
const shot = async (w, name) => {
  const s = await Promise.race([w.send('Page.captureScreenshot', { format: 'png' }), sleep(15_000).then(() => undefined)]);
  if (s?.result?.data) {
    fs.writeFileSync(path.join(OUT, name), Buffer.from(s.result.data, 'base64'));
    shots.push(name);
  } else {
    missing.push(name);
    console.log(`  WARN  no screenshot ${name}: the window draws nothing (minimized or covered); the checks still ran`);
  }
};

let code;
try {
  log(`installing ${vsix}`);
  const inst = cli(['--user-data-dir', ud, '--extensions-dir', ext, '--install-extension', path.resolve(vsix), '--force']);
  check('extension installed in the throwaway profile', inst.status === 0, (inst.stdout + inst.stderr).trim().split('\n').slice(-1)[0]);

  log('window');
  // Keep drawing when another window covers this one (screenshots), and do not slow its pages down in the background.
  code = spawn(codeExe, ['--user-data-dir', ud, '--extensions-dir', ext, `--remote-debugging-port=${PORT}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--new-window', '--disable-workspace-trust', proj], { env, detached: true, stdio: 'ignore' });
  code.unref();
  const wbt = await until(async () => (await targets()).find((t) => t.type === 'page' && t.url.includes('workbench.html') && t.title.includes('proj')), 'the window', 90_000);
  const w = cdp(wbt.webSocketDebuggerUrl);
  await w.ready;
  await sleep(4000);

  log('Aivenue in an editor tab');
  await palette(w, 'aivenue.openInEditor');
  const [E] = await until(async () => {
    const f = await frames();
    return f.length ? f : undefined;
  }, 'the Aivenue editor tab', 120_000, 3000);
  const info = (await E.call('host.info')).result;
  check('opened in an editor tab, in this window\'s project', info?.host === 'vscode' && same(info.defaultCwd, proj), { host: info?.host, defaultCwd: info?.defaultCwd });
  await until(async () => (await E.call('providers.list')).result?.find((p) => p.spec.id === PROVIDER && p.installed), `${PROVIDER} installed`, 30_000);

  log(`two real chats (${PROVIDER}${MODEL ? ` ${MODEL}` : ''})`);
  const slugDir = path.join(proj, 'slug');
  const askDir = path.join(proj, 'naming');
  fs.mkdirSync(slugDir, { recursive: true });
  fs.mkdirSync(askDir, { recursive: true });
  const slugId = (await E.call('workflows.start', { config: cfg(slugDir, goalChecks, '修正 slug 函式並跑測試') })).result;
  const askId = (await E.call('workflows.start', { config: cfg(askDir, goalAsk, '新模組命名') })).result;
  await until(async () => (await E.call('workflows.get', { id: askId })).result?.pending, 'the question', 300_000, 2000);
  const slugRun = await until(async () => {
    const r = (await E.call('workflows.get', { id: slugId })).result;
    return ['completed', 'failed', 'incomplete', 'cancelled'].includes(r?.status) && r;
  }, 'the slug chat to end', 600_000, 3000);
  fs.writeFileSync(path.join(OUT, 'run-slug.json'), JSON.stringify(slugRun, null, 1));
  check('the slug chat completed', slugRun.status === 'completed', slugRun.status);
  const checksSeen = slugRun.stages.implement?.rounds?.at(-1)?.submission?.checks ?? [];
  log('checks recorded', JSON.stringify(checksSeen.map((c) => [c.command, c.outcome, !!c.outdated, (c.earlier ?? []).map((e) => e.outcome)])));
  // Whether the agent's reply has a Markdown table (asked for; the model may still not write one).
  const slugText = [...Object.values(slugRun.agents).map((a) => a.finalText ?? ''), slugRun.stages.implement?.rounds?.at(-1)?.submission?.summary ?? ''].join('\n');
  const agentTable = /^\s*\|?\s*:?-{3,}:?\s*\|/m.test(slugText);
  log('the reply has a Markdown table:', agentTable);

  /** Show a scene in a webview: its hash; for a result, the card's top scrolled into view. */
  const show = async (F, hash, card) => {
    await F.evaluate(`location.hash = ${JSON.stringify('#/' + hash)}`);
    await sleep(2500);
    if (card) {
      await F.evaluate(`(() => { const el = document.querySelector('.final-result'); if (!el) return; let p = el.parentElement; while (p && !(p.scrollHeight > p.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(p).overflowY))) p = p.parentElement; const box = p ?? document.scrollingElement; box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 8; })()`);
      await sleep(800);
    }
  };
  const scenes = [
    ['new', 'new', false],
    ['result', `run/${slugId}`, true],
    ['waiting', `run/${askId}`, false],
  ];
  const report = [];
  const inspectAll = async (place, F, theme) => {
    await w.send('Page.bringToFront');
    for (const [name, hash, card] of scenes) {
      await show(F, hash, card);
      const r = await F.evaluate(INSPECT);
      const file = `${place}-${theme}-${name}.png`;
      await shot(w, file);
      report.push({ place, theme, scene: name, file, ...r });
      check(`${place} · ${theme} · ${name}: Lucide icons, no symbol icon left in a button`, r.lucide >= 5 && r.leftovers.length === 0, { lucide: r.lucide, leftovers: r.leftovers });
      check(`${place} · ${theme} · ${name}: nothing past the webview's ${r.width}px`, r.pastCount === 0 && !r.scrollX, r.past);
      check(`${place} · ${theme} · ${name}: no control cut by its box or drawn over another`, !r.cutControls.length && !r.overlaps.length, { cut: r.cutControls, over: r.overlaps });
      if (name === 'result') check(`${place} · ${theme} · result: verification states apart, with reasons; "agent 自述" tag`, r.states.length > 0 && r.selfTag && !r.states.some((s) => /未驗證/.test(s)), r.states);
      if (name !== 'new') check(`${place} · ${theme} · ${name}: agents' Markdown drawn (no raw table rows or code fences)`, r.rawMarkdown.length === 0, { tables: r.tables, raw: r.rawMarkdown });
      if (name === 'result' && agentTable) check(`${place} · ${theme} · result: the agent's Markdown table is drawn as a table`, r.tables > 0, r.tables);
      if (name === 'waiting') check(`${place} · ${theme} · waiting: "等待你的決定" and the question in view`, r.waiting);
      // An agent's turn no longer shows a clock time: how long it took, from 10 s up, with its start as the tooltip. Every
      // turn that started is measured (one not started yet has no length); none has a time it should not have, or lacks
      // one it should.
      if (name !== 'new') check(`${place} · ${theme} · ${name}: every message shows its time (the user's, the timeline's); each agent turn shows how long it took from 10 s up, its start in the tooltip`, r.times.user > 0 && r.times.lines > 0 && r.times.turns > 0 && r.times.measured > 0 && r.times.bad.length === 0, r.times);
      if (name === 'waiting')
        check(
          `${place} · ${theme} · waiting: the question lists the agent's answers and "Other", with a box; nothing sent before a pick`,
          !!r.question && r.question.radios >= 3 && r.question.radios === r.question.choices.length && r.question.other && r.question.box && r.question.sendDisabled && r.question.looksPicked === 0,
          r.question,
        );
      if (name !== 'new') {
        check(`${place} · ${theme} · ${name}: the folder path is a button the keyboard reaches`, !!r.cwd?.focusable, r.cwd);
        if (r.cwd?.cut) {
          const o = await F.evaluate(OPEN_CWD);
          check(`${place} · ${theme} · ${name}: the cut path opens to the whole path, and closes again`, o?.focused && o.expanded === 'true' && o.whole && o.fits && o.closedAgain, o);
        }
      }
    }
  };

  await inspectAll('editor', E, 'light');

  log('dark theme');
  fs.writeFileSync(settingsFile, JSON.stringify(settings('Default Dark Modern')));
  await sleep(3500);
  await inspectAll('editor', E, 'dark');
  const bgL = report.find((r) => r.place === 'editor' && r.theme === 'light')?.bg;
  const bgD = report.find((r) => r.place === 'editor' && r.theme === 'dark')?.bg;
  check("the webview follows VS Code's theme", bgL && bgD && bgL !== bgD, { light: bgL, dark: bgD });

  log('Aivenue in the side bar (narrow)');
  await palette(w, 'aivenue.open');
  const S = await until(async () => (await frames()).find((f) => f.target !== E.target), 'the side bar view', 60_000, 3000);
  log('side bar width', S.width);
  check('the side bar view is narrow', S.width < 600, S.width);
  await inspectAll('side', S, 'dark');
  fs.writeFileSync(settingsFile, JSON.stringify(settings('Default Light Modern')));
  await sleep(3500);
  await inspectAll('side', S, 'light');
  fs.writeFileSync(path.join(OUT, 'scenes.json'), JSON.stringify(report, null, 1));

  // The waiting chat is not needed any more.
  await E.call('workflows.cancel', { id: askId });

  // The hub crashes and the extension starts it again (another port): the page is not rebuilt, so what was being
  // written and the chat shown stay, and it works on with the new hub.
  log('the hub stops and comes back');
  await E.evaluate(`location.hash = ${JSON.stringify('#/run/' + slugId)}`);
  await sleep(2000);
  const unsent = '還沒送出的追問：記得也跑型別檢查';
  await E.evaluate(`(() => {
    window.__notReloaded = 42;
    const ta = document.querySelector('.composer textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(unsent)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta.value;
  })()`);
  const portBefore = await E.evaluate('new URL(window.__AIVENUE__.wsUrl).port');
  const before = hubProcesses();
  for (const pid of before) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
  const after = await until(async () => {
    const now = hubProcesses().filter((p) => !before.includes(p));
    return now.length ? now : undefined;
  }, 'a new hub', 60_000, 1000).catch(() => []);
  check('the hub killed, the extension starts a new one', after.length > 0, { before, after });
  const back = await until(async () => {
    const r = await E.evaluate(`({ open: !!document.querySelector('.conn.open'), port: new URL(window.__AIVENUE__.wsUrl).port })`).catch(() => undefined);
    return r?.open && r.port !== portBefore ? r : undefined;
  }, 'the page on the new hub', 60_000, 1000).catch(() => undefined);
  const kept = await E.evaluate(`({ notReloaded: window.__notReloaded === 42, text: document.querySelector('.composer textarea')?.value, hash: location.hash, turns: document.querySelectorAll('.turn').length })`).catch((e) => ({ error: e.message }));
  check('after the hub came back: the page connected to the new port by itself', !!back, { portBefore, back });
  check('after the hub came back: the page was not reloaded; the unsent text and the chat shown are kept', kept.notReloaded && kept.text === unsent && kept.hash === `#/run/${slugId}` && kept.turns > 0, kept);
  await shot(w, 'editor-after-hub-restart');

  log('closing the window');
  await palette(w, 'workbench.action.closeWindow');
  const stopped = await until(async () => hubProcesses().length === 0, 'the hub to stop', 60_000, 1000).catch(() => false);
  check('with the window closed, the hub stops by itself', stopped, hubProcesses());
} catch (e) {
  check('check ran to the end', false, e.message);
} finally {
  for (const pid of ourCode()) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
  for (const pid of hubProcesses()) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
  // The link only (the account's folder stays as it is).
  if (accountLink) {
    try {
      fs.unlinkSync(accountLink);
    } catch (e) {
      console.error(`Could not remove the link ${accountLink}: ${e.message}`);
    }
  }
  fs.writeFileSync(path.join(OUT, 'ui-check.json'), JSON.stringify({ provider: PROVIDER, model: MODEL ?? '(provider default)', codexHome: process.env.CODEX_HOME ?? null, accountDir: accountMatch ? accountDir : null, minutes: ((Date.now() - t0) / 60000).toFixed(1), results, shots, missingShots: missing }, null, 1));
  log(`${fails} failed`);
  process.exit(fails ? 1 : 0);
}
