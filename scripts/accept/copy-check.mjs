// The copy buttons, pressed in the real apps on fixed conversations (copy-fixtures.mjs; no model is called):
//  - VS Code: Aivenue in the secondary side bar and in an editor tab. Each button is clicked with the mouse (an input
//    event, not a script's click()); the clipboard is then pasted into a plain-text file in VS Code (paste.txt: select
//    all, paste, save) and the file is compared with the expected text, character by character: the reply (Traditional
//    Chinese, a table, a nested list, a multi-line code block), the code block alone, the final result and the review
//    report. Then, on selected text, whether Ctrl+C and the context menu's Copy put it on the clipboard (the reported
//    problem), recorded as found.
//  - The desktop app (Electron, from this checkout; or a packaged Aivenue.exe given as DESK_EXE, e.g. the portable or
//    the unpacked app of a candidate): the same buttons, the system clipboard compared; Ctrl+C recorded.
// A throwaway VS Code profile, Electron profile and AIVENUE_HOME: the user's own are never touched. The system clipboard
// is used: its text is kept first and put back at the end (anything else on it, such as an image, is not).
//   [DESK_EXE=<packaged Aivenue.exe>] node copy-check.mjs <aivenue.vsix> <out dir> [<VS Code folder>]
// Without DESK_EXE, run `npm run build` first (the desktop app then runs from packages/desktop/dist). PASS / FAIL lines, JSON, screenshots
// and the pasted files in <out dir>.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODE, REPLY, writeFixtures } from './copy-fixtures.mjs';
import { prepareOutDir } from './out-dir.mjs';

const [vsix, outArg, codeDirArg] = process.argv.slice(2);
if (!vsix || !outArg) {
  console.error('usage: node copy-check.mjs <aivenue.vsix> <out dir> [<VS Code folder>]');
  process.exit(2);
}
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(outArg);
const codeDir = codeDirArg ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code');
const codeExe = path.join(codeDir, 'Code.exe');
const codeCli = path.join(codeDir, 'bin', 'code.cmd');
const PORT = Number(process.env.ACC_PORT || 9351);
const DESK_PORT = PORT + 1;
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
/** What was seen, not judged (the reported Ctrl+C and context-menu problem). */
const observed = [];
const note = (name, detail) => {
  observed.push({ name, ...detail });
  console.log(`  NOTE  ${name}: ${JSON.stringify(detail)}`);
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

prepareOutDir(OUT, REPO);
const ud = path.join(OUT, 'vscode-user');
const ext = path.join(OUT, 'vscode-ext');
const home = path.join(OUT, 'aivenue-home');
const proj = path.join(OUT, 'proj');
const deskHome = path.join(OUT, 'desktop-home');
const deskProj = path.join(OUT, 'desktop-proj');
const deskUser = path.join(OUT, 'electron-user');
for (const d of [ud, ext, home, proj, deskHome, deskProj, deskUser]) fs.mkdirSync(d, { recursive: true });

// ---------- the system clipboard (PowerShell; text through UTF-8 files, never the console) ----------
const clipFile = path.join(OUT, 'clip.tmp');
function getClip() {
  fs.rmSync(clipFile, { force: true });
  spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', `$c = Get-Clipboard -Raw; if ($null -eq $c) { $c = '' }; [IO.File]::WriteAllText('${clipFile.replace(/'/g, "''")}', $c, [Text.UTF8Encoding]::new($false))`], { encoding: 'utf8' });
  return fs.existsSync(clipFile) ? fs.readFileSync(clipFile, 'utf8') : '';
}
function setClip(text) {
  fs.writeFileSync(clipFile, text, 'utf8');
  spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', `Set-Clipboard -Value ([IO.File]::ReadAllText('${clipFile.replace(/'/g, "''")}', [Text.Encoding]::UTF8))`], { encoding: 'utf8' });
}
const lf = (s) => s.replace(/\r\n/g, '\n');
const kept = getClip();
/** Text this check selected and copied itself (Ctrl+C, the context menu). */
const ownTexts = new Set();
/** Whether the clipboard holds what this check put there (a sentinel, a fixture, its own selection), not someone's copy. */
const ownClip = (s, exp) => /SENTINEL/.test(s) || Object.values(exp).some((x) => lf(s) === x) || ownTexts.has(lf(s).trim()) || s === '';

// ---------- the expected texts ----------
const fixtures = await writeFixtures(home, proj, 'vscode');
const deskFixtures = await writeFixtures(deskHome, deskProj, 'app');
const { build } = createRequire(path.join(REPO, 'package.json'))('esbuild');
const rt = await build({ entryPoints: [path.join(REPO, 'packages/ui/src/reviewText.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
const rtMod = { exports: {} };
new Function('require', 'module', 'exports', rt.outputFiles[0].text)(createRequire(import.meta.url), rtMod, rtMod.exports);
const zh = (z) => z;
const reviewOf = (run) => run.stages.implement.rounds.at(-1).review;
const expected = (f) => ({ reply: REPLY, code: CODE, result: REPLY, review: rtMod.exports.reviewMarkdown(zh, reviewOf(f.review), f.review.reviewTarget) });
fs.writeFileSync(path.join(OUT, 'expected-review.md'), expected(fixtures).review);

// ---------- CDP ----------
const targets = async (port) => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
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
  const evaluate = async (expression, contextId) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) });
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'evaluation failed');
    return res.result?.result?.value;
  };
  return { ready, send, evaluate, contexts, close: () => ws.close() };
}
const key = async (c, k, code, vk, mods = 0) => {
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
};
const CTRL = 2;
/** A mouse click at page coordinates: an input event, as a person's click is. */
async function click(c, x, y, button = 'left') {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
}
const shots = [];
async function shot(c, name) {
  const s = await Promise.race([c.send('Page.captureScreenshot', { format: 'png' }), sleep(15_000).then(() => undefined)]);
  if (s?.result?.data) {
    fs.writeFileSync(path.join(OUT, name), Buffer.from(s.result.data, 'base64'));
    shots.push(name);
  }
}

/**
 * In a page (the desktop window, or a VS Code webview's own frame): show a chat, find what to press. `at(selector)`:
 * the element scrolled into view, its centre in the page, its label and state.
 */
// Scrolled into view until it stays put (the chat scrolls itself while it settles), and only once the point is the
// element itself (nothing drawn over it): `hit` says whether that was reached.
const AT = (selector, nth = 0) => `(async () => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})][${nth}];
  if (!el) return null;
  const label = el.getAttribute('aria-label') ?? el.textContent.trim().slice(0, 40);
  let last;
  for (let i = 0; i < 30; i++) {
    // As a person scrolls (the wheel): the chat keeps a scroll it did not make itself at the bottom.
    document.querySelector('.thread')?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
    el.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 200));
    const r = el.getBoundingClientRect();
    const p = { x: r.x + Math.min(r.width / 2, 40), y: r.y + r.height / 2, w: r.width, h: r.height };
    const at = document.elementFromPoint(p.x, p.y);
    const still = last && Math.abs(last.x - p.x) < 1 && Math.abs(last.y - p.y) < 1;
    last = p;
    if (still && at && (at === el || el.contains(at))) return { ...p, label, cls: el.className, hit: true };
  }
  const at = document.elementFromPoint(last.x, last.y);
  return { ...last, label, cls: el.className, hit: false, over: at ? at.tagName + '.' + at.className : null };
})()`;
const STATE = (selector, nth = 0) => `[...document.querySelectorAll(${JSON.stringify(selector)})][${nth}]?.className ?? ''`;
/** Select an element's text in the page (for Ctrl+C and the context menu); its text as the selection reads. */
const SELECT = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return sel.toString();
})()`;
const BUTTONS = [
  // [what, selector, expected key]
  ['the reply in the activity log (複製回覆)', '.tx-msg > .copy-row .copy-btn', 'reply'],
  ['the code block alone (複製程式碼)', '.final-result:not(.review-result) .final-text .md-code .code-copy', 'code'],
  ['the final result (複製結果)', '.final-result:not(.review-result) .final-head .copy-btn', 'result'],
  ['the review report (複製審查報告)', '.review-result .final-head .copy-btn', 'review'],
];

/** This throwaway VS Code's processes and its hub, the desktop app started here (never the user's own). */
function ours(like) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${like.replace(/'/g, "''")}*' } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8' });
  return r.stdout.split(/\s+/).filter(Boolean).map(Number);
}
const stop = (like) => {
  for (const pid of ours(like)) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
};

// ---------- VS Code ----------
fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
// No telemetry prompt, welcome page or trust dialog; a pasted text kept as it is (no reformatting, LF line ends, no final
// newline added, no trailing space removed), so the saved file is the clipboard's text.
fs.writeFileSync(
  path.join(ud, 'User', 'settings.json'),
  JSON.stringify({
    'security.workspace.trust.enabled': false,
    'workbench.startupEditor': 'none',
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoUpdate': false,
    'chat.disableAIFeatures': true,
    'files.eol': '\n',
    'files.insertFinalNewline': false,
    'files.trimTrailingWhitespace': false,
    'files.trimFinalNewlines': false,
    'editor.formatOnPaste': false,
    'editor.autoIndentOnPaste': false,
    'editor.pasteAs.enabled': false,
    'window.restoreWindows': 'none',
  }),
);
const pasteFile = path.join(proj, 'paste.txt');
fs.writeFileSync(pasteFile, '');
const env = { ...process.env, AIVENUE_HOME: home, AIVENUE_HUB_GRACE_MS: '8000' };
delete env.ELECTRON_RUN_AS_NODE;
const cli = (args) => spawnSync('cmd.exe', ['/d', '/s', '/c', `""${codeCli}" ${args.map((a) => `"${a}"`).join(' ')}"`], { env, encoding: 'utf8', windowsVerbatimArguments: true, timeout: 120_000 });

async function palette(w, text) {
  await w.send('Page.bringToFront');
  await sleep(600);
  await key(w, 'Escape', 'Escape', 27);
  await sleep(400);
  await key(w, 'F1', 'F1', 112);
  await sleep(1200);
  await w.send('Input.insertText', { text });
  await sleep(1500);
  await key(w, 'Enter', 'Enter', 13);
  await sleep(1500);
}

/** Aivenue's webviews in the window: the frame's target, its page context, its width, and where it sits in the window. */
async function webviews(w) {
  const found = [];
  for (const t of (await targets(PORT)).filter((x) => x.type === 'iframe' && x.url.startsWith('vscode-webview://'))) {
    const f = cdp(t.webSocketDebuggerUrl);
    await f.ready;
    await f.send('Runtime.enable');
    await sleep(800);
    for (const c of f.contexts) {
      const ok = await f.evaluate('!!window.__AIVENUE__?.wsUrl', c.id).catch(() => false);
      if (!ok) continue;
      const evaluate = (e) => f.evaluate(e, c.id);
      found.push({ url: t.url, f, evaluate, width: await evaluate('window.innerWidth') });
    }
  }
  // Where each one's frame is in the window: its outer iframe (same URL), and the inner frame inside it.
  for (const v of found) {
    v.offset = async () =>
      w.evaluate(`(() => {
        const outer = [...document.querySelectorAll('iframe')].find((i) => i.src === ${JSON.stringify(v.url)});
        if (!outer) return null;
        const r = outer.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })()`);
  }
  return found;
}

/** Click a button in a webview with the mouse: its place in the frame, plus the frame's place in the window. */
async function clickIn(w, v, selector, button = 'left', at) {
  const p = at ?? (await v.evaluate(AT(selector)));
  if (!p) return undefined;
  await sleep(300);
  const o = await v.offset();
  if (!o) return undefined;
  // The webview's own page sits in an inner frame that fills the outer one (VS Code's webview host).
  await click(w, o.x + p.x, o.y + p.y, button);
  return p;
}

/** Paste the clipboard into paste.txt in VS Code (select all, paste, save) and read the file. */
async function pasteInVsCode(w) {
  cli(['--user-data-dir', ud, '--extensions-dir', ext, '-r', pasteFile]);
  await sleep(2500);
  await palette(w, 'workbench.action.focusActiveEditorGroup');
  await key(w, 'a', 'KeyA', 65, CTRL);
  await sleep(300);
  await key(w, 'v', 'KeyV', 86, CTRL);
  await sleep(1200);
  await key(w, 's', 'KeyS', 83, CTRL);
  await sleep(1500);
  return fs.readFileSync(pasteFile, 'utf8');
}

let vscodeRan = false;
try {
  log(`installing ${vsix}`);
  const inst = cli(['--user-data-dir', ud, '--extensions-dir', ext, '--install-extension', path.resolve(vsix), '--force']);
  check('extension installed in the throwaway profile', inst.status === 0, (inst.stdout + inst.stderr).trim().split('\n').slice(-1)[0]);
  const code = spawn(codeExe, ['--user-data-dir', ud, '--extensions-dir', ext, `--remote-debugging-port=${PORT}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--new-window', '--disable-workspace-trust', proj], { env, detached: true, stdio: 'ignore' });
  code.unref();
  const wbt = await until(async () => (await targets(PORT)).find((t) => t.type === 'page' && t.url.includes('workbench.html') && t.title.includes('proj')), 'the window', 90_000);
  const w = cdp(wbt.webSocketDebuggerUrl);
  await w.ready;
  await w.send('Runtime.enable');
  await sleep(4000);
  vscodeRan = true;

  for (const place of ['sidebar', 'editor']) {
    log(`Aivenue in the ${place === 'sidebar' ? 'secondary side bar' : 'editor tab'}`);
    await palette(w, place === 'sidebar' ? 'aivenue.open' : 'aivenue.openInEditor');
    const all = await until(async () => {
      const f = await webviews(w);
      return f.length >= (place === 'sidebar' ? 1 : 2) ? f : undefined;
    }, `Aivenue in the ${place}`, 120_000, 3000);
    // The side bar is the narrow one; the editor tab the wide one.
    const v = all.sort((a, b) => a.width - b.width)[place === 'sidebar' ? 0 : all.length - 1];
    const exp = expected(fixtures);
    for (const [what, selector, which] of BUTTONS) {
      const run = which === 'review' ? fixtures.review : fixtures.reply;
      await v.evaluate(`location.hash = ${JSON.stringify(`#/run/${run.id}`)}`);
      await sleep(2500);
      // The reply's own copy button is in its activity log.
      if (which === 'reply') await v.evaluate(`(() => { const b = document.querySelector('.turn .activity-toggle[aria-expanded="false"]'); b?.click(); return !!b; })()`);
      await sleep(1200);
      setClip(`SENTINEL ${place} ${which}`);
      const aim = await v.evaluate(AT(selector));
      if (!aim?.hit) {
        check(`VS Code ${place}: ${what} — the button is there, in view, not covered`, false, aim ?? selector);
        continue;
      }
      const p = await clickIn(w, v, selector, 'left', aim);
      const state = await until(async () => {
        const s = await v.evaluate(STATE(selector));
        return /\b(copied|failed)\b/.test(s) && s;
      }, 'the button to answer', 10_000, 300).catch(() => 'no answer');
      await shot(w, `vscode-${place}-${which}.png`);
      const clip = getClip();
      const pasted = await pasteInVsCode(w);
      fs.writeFileSync(path.join(OUT, `pasted-vscode-${place}-${which}.txt`), pasted);
      check(`VS Code ${place}: ${what} — the button says copied (its name is "${p.label}")`, /\bcopied\b/.test(state), state);
      check(`VS Code ${place}: ${what} — pasted into a plain-text file, character by character the same`, pasted === exp[which], pasted === exp[which] ? `${pasted.length} characters` : { got: pasted.slice(0, 200), want: exp[which].slice(0, 200) });
      note(`VS Code ${place}: ${what} — the clipboard's line ends`, { crlf: /\r\n/.test(clip), sameAfterLf: lf(clip) === exp[which], copiedFromOutside: !ownClip(clip, exp) });
      if (place === 'editor') await palette(w, 'aivenue.openInEditor');
    }

    // The reported problem: Ctrl+C and the context menu's Copy on text selected in the page.
    await v.evaluate(`location.hash = ${JSON.stringify(`#/run/${fixtures.reply.id}`)}`);
    await sleep(2500);
    const para = '.final-result:not(.review-result) .final-text .md > p';
    // Ctrl+C: a click in the text (the webview takes the keys), the paragraph selected, Ctrl+C.
    setClip(`SENTINEL ${place} ctrl-c`);
    const pp = await v.evaluate(AT(para));
    await clickIn(w, v, para, 'left', pp);
    const selected = await v.evaluate(SELECT(para));
    ownTexts.add((selected ?? "").trim());
    await sleep(300);
    await key(w, 'c', 'KeyC', 67, CTRL);
    await sleep(1200);
    const afterCtrlC = getClip();
    note(`VS Code ${place}: Ctrl+C on selected text`, { aimed: pp?.hit, selected, clipboard: afterCtrlC.slice(0, 120), copied: lf(afterCtrlC).trim() === selected.trim(), problemReproduced: lf(afterCtrlC).trim() !== selected.trim(), copiedFromOutside: !ownClip(afterCtrlC, exp) && lf(afterCtrlC).trim() !== selected.trim() });
    // The context menu: the paragraph selected, a right-click on it (in view, not covered), Copy.
    setClip(`SENTINEL ${place} context-menu`);
    const rp = await v.evaluate(AT(para));
    await v.evaluate(SELECT(para));
    await clickIn(w, v, para, 'right', rp);
    await sleep(1200);
    const stillSelected = await v.evaluate('getSelection().toString()');
    await shot(w, `vscode-${place}-context-menu.png`);
    const menu = await w.evaluate(`[...document.querySelectorAll('.context-view .monaco-menu .action-item .action-label')].map((a) => { const r = a.getBoundingClientRect(); return { text: a.textContent.trim(), x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: a.classList.contains('disabled') }; })`);
    const copyItem = (menu ?? []).find((m) => /^(Copy|複製)$/.test(m.text));
    if (copyItem && !copyItem.disabled) {
      await click(w, copyItem.x, copyItem.y);
      await sleep(1200);
    } else await key(w, 'Escape', 'Escape', 27);
    const menuOpen = await w.evaluate(`!!document.querySelector('.context-view .monaco-menu')`);
    const afterMenu = getClip();
    note(`VS Code ${place}: the context menu's Copy on selected text`, { aimed: rp?.hit, selectedAfterRightClick: stillSelected, menu: (menu ?? []).map((m) => m.text + (m.disabled ? ' (disabled)' : '')), menuClosedAfterClick: !menuOpen, clipboard: afterMenu.slice(0, 120), copied: lf(afterMenu).trim() === selected.trim(), problemReproduced: lf(afterMenu).trim() !== selected.trim(), copiedFromOutside: !ownClip(afterMenu, exp) && lf(afterMenu).trim() !== selected.trim() });
  }
  await palette(w, 'workbench.action.closeWindow');
  await sleep(3000);
} catch (e) {
  check('VS Code: the check ran to the end', false, e.message);
} finally {
  stop(ud);
  stop(`${ext}`);
}
if (!vscodeRan) check('VS Code started', false);

// ---------- the desktop app ----------
let desk;
try {
  const deskExe = process.env.DESK_EXE ? path.resolve(process.env.DESK_EXE) : undefined;
  log(`the desktop app${deskExe ? `: ${deskExe}` : ' (from this checkout)'}`);
  note('desktop app started', deskExe ? { packaged: deskExe } : { fromCheckout: path.join(REPO, 'packages', 'desktop') });
  const app = deskExe ? [deskExe, []] : [path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe'), [path.join(REPO, 'packages', 'desktop')]];
  desk = spawn(app[0], [...app[1], `--remote-debugging-port=${DESK_PORT}`, `--user-data-dir=${deskUser}`], { env: { ...env, AIVENUE_HOME: deskHome }, detached: true, stdio: 'ignore', cwd: REPO });
  desk.unref();
  const page = await until(async () => (await targets(DESK_PORT)).find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url)), 'the desktop window', 90_000);
  const d = cdp(page.webSocketDebuggerUrl);
  await d.ready;
  await d.send('Runtime.enable');
  await sleep(4000);
  const exp = expected(deskFixtures);
  for (const [what, selector, which] of BUTTONS) {
    const run = which === 'review' ? deskFixtures.review : deskFixtures.reply;
    await d.evaluate(`location.hash = ${JSON.stringify(`#/run/${run.id}`)}`);
    await sleep(2500);
    if (which === 'reply') await d.evaluate(`(() => { const b = document.querySelector('.turn .activity-toggle[aria-expanded="false"]'); b?.click(); return !!b; })()`);
    await sleep(1200);
    setClip(`SENTINEL desktop ${which}`);
    const p = await d.evaluate(AT(selector));
    if (!p?.hit) {
      check(`desktop: ${what} — the button is there, in view, not covered`, false, p ?? selector);
      continue;
    }
    await sleep(300);
    await click(d, p.x, p.y);
    const state = await until(async () => {
      const s = await d.evaluate(STATE(selector));
      return /\b(copied|failed)\b/.test(s) && s;
    }, 'the button to answer', 10_000, 300).catch(() => 'no answer');
    await shot(d, `desktop-${which}.png`);
    const clip = getClip();
    fs.writeFileSync(path.join(OUT, `clipboard-desktop-${which}.txt`), clip);
    check(`desktop: ${what} — the button says copied (its name is "${p.label}")`, /\bcopied\b/.test(state), state);
    check(`desktop: ${what} — the system clipboard has the text (line ends aside)`, lf(clip) === exp[which], lf(clip) === exp[which] ? `${clip.length} characters${/\r\n/.test(clip) ? ', CRLF line ends' : ''}` : { got: clip.slice(0, 200), want: exp[which].slice(0, 200) });
  }
  // Ctrl+C on selected text, as in VS Code.
  await d.evaluate(`location.hash = ${JSON.stringify(`#/run/${deskFixtures.reply.id}`)}`);
  await sleep(2500);
  const para = '.final-result:not(.review-result) .final-text .md > p';
  const pp = await d.evaluate(AT(para));
  setClip('SENTINEL desktop ctrl-c');
  await click(d, pp.x, pp.y);
  const selected = await d.evaluate(SELECT(para));
  ownTexts.add((selected ?? "").trim());
  await key(d, 'c', 'KeyC', 67, CTRL);
  await sleep(1200);
  const afterCtrlC = getClip();
  note('desktop: Ctrl+C on selected text', { selected, clipboard: afterCtrlC.slice(0, 120), copied: lf(afterCtrlC).trim() === selected.trim() });
} catch (e) {
  check('desktop: the check ran to the end', false, e.message);
} finally {
  stop(deskUser);
  // The user's clipboard text, as it was — unless they copied something themselves meanwhile (that stays).
  const now = getClip();
  const allExp = { ...expected(fixtures), ...Object.fromEntries(Object.entries(expected(deskFixtures)).map(([k, v]) => [`d-${k}`, v])) };
  if (ownClip(now, allExp)) setClip(kept);
  else note('the clipboard at the end', { left: 'as it was: something else was copied there during the check, so the earlier text was not put back' });
  fs.rmSync(clipFile, { force: true });
  fs.writeFileSync(path.join(OUT, 'copy-check.json'), JSON.stringify({ minutes: ((Date.now() - t0) / 60000).toFixed(1), results, observed, shots, fixtures: { vscode: [fixtures.reply.id, fixtures.review.id], desktop: [deskFixtures.reply.id, deskFixtures.review.id] } }, null, 1));
  log(`${fails} failed`);
  process.exit(fails ? 1 : 0);
}
