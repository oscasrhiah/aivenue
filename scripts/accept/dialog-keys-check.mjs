// Keyboard acceptance of the shared dialog keys (Kit useDialogKeys) in one running Aivenue window (started with
// --remote-debugging-port, a fresh AIVENUE_HOME), with real key presses sent through the debugging protocol: Tab and
// Shift+Tab never take the focus out of the dialog on top, also when a control Tab skips (tabIndex -1) comes last or
// has the focus; Esc closes only the dialog on top and the focus goes back into the one under it.
// Dialogs: the workflow settings window, the whole-computer-access confirmation opened from it, and the provider
// editor of Settings → Providers (an editor that keeps typed input).
//   node dialog-keys-check.mjs <port> <expected commit (7+)> <out dir> [<name>]
// Prints one PASS / FAIL line per check; exits 1 when any check fails.
import * as fs from 'node:fs';

const [port, , outDir, name = 'app'] = process.argv.slice(2);
if (!port || !outDir) {
  console.error('usage: node dialog-keys-check.mjs <port> <expected commit> <out dir> [<name>]');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const results = [];
const check = (label, ok, detail) => {
  if (!ok) failed++;
  results.push({ label, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: ${label}${detail === undefined ? '' : ` (${JSON.stringify(detail)})`}`);
};

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
const ev = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? 'evaluation failed');
  return res.result?.result?.value;
};
const press = async (key, code, vk, shift = false) => {
  const modifiers = shift ? 8 : 0;
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
  await sleep(120);
};
const tab = (shift = false) => press('Tab', 'Tab', 9, shift);

// Where the focus is: inside the dialog on top or not, and a short name of the focused element.
const WHERE = `(() => {
  const all = [...document.querySelectorAll('.modal')];
  const top = all[all.length - 1];
  const a = document.activeElement;
  const what = !a || a === document.body ? 'body' : (a.getAttribute('aria-label') || a.innerText || a.value || a.placeholder || a.tagName).trim().replace(/\\s+/g, ' ').slice(0, 40);
  return { modals: all.length, top: top?.className ?? null, inside: !!top && top.contains(a), self: a === top, what, tabIndex: a?.tabIndex ?? null, pageFocus: document.hasFocus() };
})()`;
const where = () => ev(WHERE);
// Every focus a run of presses visits, and whether each was inside the dialog on top.
async function walk(count, shift) {
  const seen = [];
  for (let i = 0; i < count; i++) {
    await tab(shift);
    seen.push(await where());
  }
  return seen;
}
const allInside = (seen) => seen.every((s) => s.inside);
const out = (seen) => seen.filter((s) => !s.inside).map((s) => s.what);

const shot = async (file) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) fs.writeFileSync(`${outDir}/${file}`, Buffer.from(r.result.data, 'base64'));
};

try {
  await send('Page.bringToFront');
  // The window may be behind other windows while this runs: keys and focus behave as in the window in front.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  // 1. The workflow settings window, from the new-conversation page.
  await ev(`location.hash = '#/new'`);
  await sleep(1500);
  const opened = await ev(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // The folder button opens the settings window (the one in view; a narrow composer folds it into its summary).
    const sel = '.composer .wf-folder, .composer .pill-btn, .home-composer .pill-btn, .pill-btn';
    for (let i = 0; i < 40 && !document.querySelector(sel); i++) await sleep(250);
    const all = [...document.querySelectorAll(sel)];
    const b = all.find((e) => e.getBoundingClientRect().width > 0) ?? all[0];
    b?.focus(); b?.click();
    for (let i = 0; i < 40 && !document.querySelector('.modal'); i++) await sleep(100);
    return !!document.querySelector('.modal');
  })()`);
  check("the workflow settings window opens from the composer's folder button", opened);
  if (!opened) throw new Error('no dialog');
  await sleep(500);
  const start = await where();
  check('opening it moves the focus into it', start.inside, start);

  // How many stops Tab really reaches in it (the page counts the same way as a person pressing Tab would see).
  const stops = await ev(`(() => {
    const top = [...document.querySelectorAll('.modal')].pop();
    return [...top.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')].filter((el) => el.tabIndex >= 0 && !el.matches(':disabled') && el.getClientRects().length).length;
  })()`);
  const forward = await walk(stops + 3, false);
  check(`Tab ${stops + 3} times (${stops} stops): the focus stays in the window and wraps around`, allInside(forward) && forward.every((s) => !s.self) && new Set(forward.map((s) => s.what)).size >= Math.min(stops, 10), { out: out(forward), stops });
  const back = await walk(stops + 3, true);
  check(`Shift+Tab ${stops + 3} times: the focus stays in the window and moves`, allInside(back) && back.every((s) => !s.self) && new Set(back.map((s) => s.what)).size >= Math.min(stops, 10), { out: out(back) });
  check('no Tab stop is a control with tabIndex -1', [...forward, ...back].every((s) => s.tabIndex >= 0), [...forward, ...back].filter((s) => s.tabIndex < 0).map((s) => s.what));

  // A control Tab skips placed after the last stop (an option the arrow keys reach, as in the segmented choices and
  // radio lists): before the fix it was taken for the last stop, so Tab from the real last one left the window.
  await ev(`(() => {
    const top = [...document.querySelectorAll('.modal')].pop();
    const b = document.createElement('button');
    b.type = 'button'; b.tabIndex = -1; b.id = 'acc-skipped'; b.textContent = 'acc skipped option';
    top.appendChild(b);
    top.focus();
  })()`);
  await tab(true);
  const last = await where();
  check('with a tabIndex -1 control last: Shift+Tab from the window itself goes to the real last stop, not to that control', last.inside && !last.self && last.what !== 'acc skipped option', last);
  await tab(false);
  const wrapped = await where();
  check('with a tabIndex -1 control last: Tab from the real last stop wraps to the first, inside the window', wrapped.inside && !wrapped.self && wrapped.what !== 'acc skipped option', wrapped);
  // The focus on that skipped control itself (a click or the arrow keys put it there): Tab and Shift+Tab stay inside.
  await ev(`document.getElementById('acc-skipped').focus()`);
  await tab(false);
  const fromSkippedF = await where();
  await ev(`document.getElementById('acc-skipped').focus()`);
  await tab(true);
  const fromSkippedB = await where();
  check('the focus on that tabIndex -1 control: Tab and Shift+Tab stay in the window', fromSkippedF.inside && fromSkippedB.inside && ![fromSkippedF, fromSkippedB].some((x) => x.self || x.what === 'acc skipped option'), { tab: fromSkippedF, shiftTab: fromSkippedB });
  await ev(`document.getElementById('acc-skipped')?.remove()`);

  // An option of a radio list that is not the chosen one (tabIndex -1), focused: Tab goes on inside the window.
  const option = await ev(`(() => {
    const top = [...document.querySelectorAll('.modal')].pop();
    const o = [...top.querySelectorAll('[role="radio"]')].find((r) => r.tabIndex < 0 && r.getClientRects().length);
    o?.focus();
    return o ? o.innerText.trim().slice(0, 30) : null;
  })()`);
  if (option) {
    await tab(false);
    const a = await where();
    await ev(`(() => { const top = [...document.querySelectorAll('.modal')].pop(); [...top.querySelectorAll('[role="radio"]')].find((r) => r.tabIndex < 0 && r.getClientRects().length)?.focus(); })()`);
    await tab(true);
    const b = await where();
    check(`a radio option Tab skips (${option}), focused: Tab and Shift+Tab stay in the window`, a.inside && b.inside, { tab: a, shiftTab: b });
  } else check('a radio option with tabIndex -1 found in the window', false);
  await shot(`${name}-roles.png`);

  // 2. The whole-computer-access confirmation, opened from the window (a dialog over a dialog).
  const confirm = await ev(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const top = [...document.querySelectorAll('.modal')].pop();
    const o = [...top.querySelectorAll('[role="radio"]')].find((r) => /完整電腦存取|Whole computer/.test(r.innerText));
    if (!o) return 'no option';
    o.focus(); o.click();
    for (let i = 0; i < 30 && !document.querySelector('.modal.full-confirm'); i++) await sleep(100);
    return document.querySelector('.modal.full-confirm') ? 'open' : 'not open';
  })()`);
  check('choosing whole-computer access asks first', confirm === 'open', confirm);
  if (confirm === 'open') {
    const in0 = await where();
    check('the confirmation takes the focus', in0.inside && /full-confirm/.test(in0.top), in0);
    // A screen reader names it by its question and reads what it allows and what still holds when the focus comes in.
    const aria = await ev(`(() => {
      const d = document.querySelector('.modal.full-confirm');
      const text = (ids) => (ids ?? '').split(/\\s+/).filter(Boolean).map((i) => document.getElementById(i)?.innerText.trim() ?? null);
      return { role: d.getAttribute('role'), name: text(d.getAttribute('aria-labelledby')), description: text(d.getAttribute('aria-describedby')) };
    })()`);
    check(
      'the confirmation is an alertdialog named by its question and described by the risks and what still holds',
      aria.role === 'alertdialog' && aria.name.length === 1 && /完整電腦存取|whole-computer/i.test(aria.name[0] ?? '') && aria.description.length === 3 && aria.description.every((d) => d && d.length > 5) && /仍然有效|Still in place/.test(aria.description[2]),
      aria,
    );
    const f = await walk(6, false);
    const b = await walk(6, true);
    check('in the confirmation, Tab and Shift+Tab never reach the window under it or the page', allInside(f) && allInside(b) && [...f, ...b].every((s) => /full-confirm/.test(s.top)), { out: out([...f, ...b]) });
    await shot(`${name}-full-confirm.png`);
    await press('Escape', 'Escape', 27);
    await sleep(300);
    const after = await where();
    check('Esc closes only the confirmation; the focus goes back into the workflow settings window', after.modals === 1 && after.inside && !/full-confirm/.test(after.top ?? ''), after);
  }
  await press('Escape', 'Escape', 27);
  await sleep(400);
  const closed = await where();
  check('Esc closes the workflow settings window', closed.modals === 0, closed);

  // 3. The provider editor (keeps typed input; its fields and buttons are the last stops).
  await ev(`location.hash = '#/settings/providers'`);
  await sleep(1500);
  const editor = await ev(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 40 && ![...document.querySelectorAll('button')].some((b) => /^(新增|Add)$/.test(b.innerText.trim())); i++) await sleep(250);
    const add = [...document.querySelectorAll('button')].find((b) => /^(新增|Add)$/.test(b.innerText.trim()));
    if (!add) return 'no add button';
    add.focus(); add.click();
    for (let i = 0; i < 30 && !document.querySelector('.modal'); i++) await sleep(100);
    return document.querySelector('.modal') ? 'open' : 'not open';
  })()`);
  check('Settings → Providers → Add opens its editor', editor === 'open', editor);
  if (editor === 'open') {
    await sleep(400);
    const f = await walk(30, false);
    const b = await walk(30, true);
    check('in the provider editor, Tab 30 times and Shift+Tab 30 times stay in it', allInside(f) && allInside(b), { out: out([...f, ...b]), visited: new Set(f.map((s) => s.what)).size });
    await shot(`${name}-provider-editor.png`);
    await press('Escape', 'Escape', 27);
    await sleep(400);
    const gone = await where();
    check('Esc closes the provider editor and the focus goes back to Add', gone.modals === 0 && /^(新增|Add)$/.test(gone.what), gone);
  }
} catch (e) {
  check('check ran to the end', false, e.message);
}
fs.writeFileSync(`${outDir}/${name}-dialog-keys.json`, JSON.stringify(results, null, 2));
console.log(`  ${failed ? 'FAIL' : 'PASS'}  ${name}: ${failed} failed`);
ws.close();
process.exit(failed ? 1 : 0);
