// Two real VS Code windows on one shared Aivenue hub, with OpenCode only (a free model; no other agent's quota):
//   node vscode-two-windows.mjs <aivenue.vsix> <out dir> [<VS Code folder>]
// A throwaway VS Code profile (user data and extensions folders) and an isolated AIVENUE_HOME: the user's own VS Code
// and ~/.aivenue are never touched. Window A opens project A, window B project B; each opens Aivenue in an editor tab.
// Checks, with PASS / FAIL lines and JSON + screenshots in <out dir>:
//  1. one hub process serves both windows; each window's new chats start in its own project;
//  2. a chat started in A shows in B at once; its agent asks a question, B answers, A sees the answer, A's own answer to
//     the same question is refused; the agent goes on once, in A's folder;
//  3. renamed in B, the new name shows in A's sidebar;
//  4. a chat started in B keeps running when window A is closed, and completes;
//  5. every workflow ran its agent once per turn it needed (no rerun), and kept its own folder;
//  6. with every window closed, the hub stops by itself.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareOutDir } from './out-dir.mjs';

const [vsix, outArg, codeDirArg] = process.argv.slice(2);
if (!vsix || !outArg) {
  console.error('usage: node vscode-two-windows.mjs <aivenue.vsix> <out dir> [<VS Code folder>]');
  process.exit(2);
}
const OUT = path.resolve(outArg);
const codeDir = codeDirArg ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code');
const codeExe = path.join(codeDir, 'Code.exe');
const codeCli = path.join(codeDir, 'bin', 'code.cmd');
const PORT = Number(process.env.ACC_PORT || 9339);
const MODEL = process.env.WAKE_MODEL || 'opencode/deepseek-v4.1-flash-free';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// One folder, however written: VS Code reports a lower-case drive letter, Node an upper-case one (Windows paths ignore case).
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
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
const projA = path.join(OUT, 'projA');
const projB = path.join(OUT, 'projB');
for (const d of [ud, ext, home, projA, projB]) fs.mkdirSync(d, { recursive: true });
// No telemetry prompt, no welcome page, no workspace-trust dialog in the throwaway profile; no Copilot sign-in dialog
// either (a fresh profile opens one over the window, and it takes every key).
fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'chat.disableAIFeatures': true }));
const env = { ...process.env, AIVENUE_HOME: home, AIVENUE_HUB_GRACE_MS: '8000' };
delete env.ELECTRON_RUN_AS_NODE;
// cmd /s /c "<line>": /s drops the outer quotes only, so the line keeps its own quoted paths (VS Code's has spaces).
const cli = (args) => spawnSync('cmd.exe', ['/d', '/s', '/c', `""${codeCli}" ${args.map((a) => `"${a}"`).join(' ')}"`], { env, encoding: 'utf8', windowsVerbatimArguments: true, timeout: 120_000 });

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
/** Run a command from a window's command palette. */
async function palette(w, text) {
  await w.send('Page.bringToFront');
  await sleep(700);
  // Close whatever dialog is open first (a welcome dialog would take the keys meant for the palette).
  await key(w, 'Escape', 'Escape', 27);
  await sleep(500);
  await key(w, 'F1', 'F1', 112);
  await sleep(1200);
  await w.send('Input.insertText', { text });
  await sleep(1500);
  await key(w, 'Enter', 'Enter', 13);
}

/** In an Aivenue webview: a connection of its own to the hub, as that window (its wsUrl carries the window id). */
const SETUP = `(async () => {
  if (window.__acc) return true;
  const ws = new WebSocket(window.__AIVENUE__.wsUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let n = 0; const wait = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
  window.__acc = { call: (method, params = {}) => new Promise((r) => { const id = 9000 + (++n); wait.set(id, r); ws.send(JSON.stringify({ id, method, params, op: 'acc-' + Date.now() + '-' + n })); }) };
  return true;
})()`;

/** Find the Aivenue webview frame of each window, keyed by that window's project folder. */
async function frames() {
  const found = {};
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
      const info = (await call('host.info')).result;
      const wsUrl = await evaluate('window.__AIVENUE__.wsUrl');
      found[info.defaultCwd] = { f, evaluate, call, info, windowId: new URL(wsUrl.replace(/^ws/, 'http')).searchParams.get('window') };
    }
  }
  return found;
}

const goalAsk = [
  'This is an acceptance test. Follow these steps exactly.',
  '1. First call the Aivenue tool ask_user with question "Which name?" and options ["alpha", "beta"]. Then END YOUR TURN at once, doing nothing else.',
  '2. When the user has answered, create a file named <answer>.txt (for example beta.txt) in the working folder, containing the single line OK.',
  '3. Then submit your work (submit_work) with a summary that names the file you created.',
].join('\n');
const goalSlow = [
  'This is an acceptance test. Follow these steps exactly.',
  "1. Run this exact command in the working folder and wait for it to finish (about 40 seconds): node -e \"setTimeout(() => require('fs').writeFileSync('slow-done.txt', 'ok'), 40000)\"",
  '2. Then submit your work (submit_work) with a summary that says slow-done.txt exists.',
].join('\n');
const cfg = (cwd, goal, title) => ({
  title,
  goal,
  cwd,
  plan: { enabled: false, author: { provider: 'opencode', model: MODEL }, reviewer: null, maxRounds: 1, humanGate: false },
  implement: { enabled: true, author: { provider: 'opencode', model: MODEL }, reviewer: null, maxRounds: 1, humanGate: false },
  verify: { enabled: false, by: 'planner', repeatLimit: 1 },
  subagents: { enabled: false, allowed: [], maxDepth: 1, maxConcurrent: 1 },
  assignment: { mode: 'manual' },
  permission: 'auto',
  isolation: 'none',
  memory: { mode: 'off' },
});

/** Hub processes (dist/hub.cjs) of this throwaway VS Code (not the query itself: its own command line names hub.cjs too). */
function hubProcesses() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${ext.replace(/'/g, "''")}*hub.cjs*' } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8' });
  return r.stdout.split(/\s+/).filter(Boolean).map(Number);
}
/** This throwaway VS Code's own processes (never the user's VS Code). */
function ourCode() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Code.exe' -and $_.CommandLine -like '*${ud.replace(/'/g, "''")}*' } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8' });
  return r.stdout.split(/\s+/).filter(Boolean).map(Number);
}
const shot = async (w, name) => {
  const s = await w.send('Page.captureScreenshot', { format: 'png' });
  if (s.result?.data) fs.writeFileSync(path.join(OUT, name), Buffer.from(s.result.data, 'base64'));
};

let code;
try {
  log(`installing ${vsix}`);
  const inst = cli(['--user-data-dir', ud, '--extensions-dir', ext, '--install-extension', path.resolve(vsix), '--force']);
  check('extension installed in the throwaway profile', inst.status === 0, (inst.stdout + inst.stderr).trim().split('\n').slice(-1)[0]);

  log('window A');
  code = spawn(codeExe, ['--user-data-dir', ud, '--extensions-dir', ext, `--remote-debugging-port=${PORT}`, '--new-window', '--disable-workspace-trust', projA], { env, detached: true, stdio: 'ignore' });
  code.unref();
  const pageOf = async (folder) => (await targets()).find((t) => t.type === 'page' && t.url.includes('workbench.html') && t.title.includes(path.basename(folder)));
  const wbA = await until(() => pageOf(projA), 'window A', 90_000);
  log('window B');
  cli(['--user-data-dir', ud, '--extensions-dir', ext, '--new-window', '--disable-workspace-trust', projB]);
  const wbB = await until(() => pageOf(projB), 'window B', 90_000);
  const wa = cdp(wbA.webSocketDebuggerUrl);
  const wb = cdp(wbB.webSocketDebuggerUrl);
  await Promise.all([wa.ready, wb.ready]);
  await sleep(4000);
  log('opening Aivenue in both windows');
  await palette(wa, 'aivenue.openInEditor');
  await sleep(3000);
  await palette(wb, 'aivenue.openInEditor');
  const pick = (f, folder) => Object.entries(f).find(([cwd]) => same(cwd, folder))?.[1];
  let seen = [];
  const fr = await until(async () => {
    const f = await frames();
    seen = Object.keys(f);
    return pick(f, projA) && pick(f, projB) ? f : undefined;
  }, 'the Aivenue view in both windows', 120_000, 3000).catch(async (e) => {
    // What the windows showed instead, for the diagnosis.
    await shot(wa, 'window-A-no-view.png');
    await shot(wb, 'window-B-no-view.png');
    throw new Error(`${e.message}; views found for: ${JSON.stringify(seen)}`);
  });
  const A = pick(fr, projA);
  const B = pick(fr, projB);

  // 1. One hub; each window's own project.
  const hubs = hubProcesses();
  const ep = JSON.parse(fs.readFileSync(path.join(home, 'vscode-hub.json'), 'utf8'));
  check('one hub process serves both windows', hubs.length === 1 && hubs[0] === ep.pid, { hubs, endpointPid: ep.pid });
  check('each window starts new chats in its own project', same(A.info.defaultCwd, projA) && same(B.info.defaultCwd, projB) && A.windowId !== B.windowId, { A: A.info.defaultCwd, B: B.info.defaultCwd });
  const oc = await until(async () => (await A.call('providers.list')).result?.find((p) => p.spec.id === 'opencode' && p.installed), 'OpenCode installed', 30_000);
  log('opencode', JSON.stringify(oc.auth));

  // 2. Started in A, shown in B; asked, answered in B.
  log('chat 1 (question) from window A');
  const id1 = (await A.call('workflows.start', { config: cfg(A.info.defaultCwd, goalAsk, 'two-windows: question') })).result;
  check('a chat started in A is listed in B at once', await until(async () => (await B.call('workflows.list')).result?.some((w) => w.id === id1), 'B lists it', 10_000, 300).catch(() => false));
  const sidebarHas = (side, text) => side.evaluate(`[...document.querySelectorAll('.side-item-title')].some((e) => e.innerText.includes(${JSON.stringify(text)}))`);
  check("B's sidebar shows it", await until(() => sidebarHas(B, 'two-windows: question'), "B's sidebar", 10_000, 300).catch(() => false));
  const pending = await until(async () => (await B.call('workflows.get', { id: id1 })).result?.pending, 'the question', 300_000, 2000).catch(() => undefined);
  check('the agent asked its question (seen from B)', !!pending, pending?.message?.slice(0, 80));
  if (pending) {
    const beta = pending.options.find((o) => /beta/i.test(o.label)) ?? pending.options[1];
    const answered = await B.call('workflows.decide', { id: id1, decisionId: pending.id, optionId: beta.id });
    check('B answers it', !answered.error, answered.error);
    const late = await A.call('workflows.decide', { id: id1, decisionId: pending.id, optionId: pending.options[0].id });
    check("A's answer to the same question is refused (already answered)", !!late.error, late.error);
    check('A sees the question answered', await until(async () => !(await A.call('workflows.get', { id: id1 })).result?.pending, "A's view", 10_000, 300).catch(() => false));
  }
  const run1 = await until(async () => {
    const r = (await A.call('workflows.get', { id: id1 })).result;
    return ['completed', 'failed', 'incomplete', 'cancelled'].includes(r?.status) && r;
  }, 'chat 1 to end', 600_000, 3000);
  fs.writeFileSync(path.join(OUT, 'run-question.json'), JSON.stringify(run1, null, 1));
  check('chat 1 completed', run1.status === 'completed', run1.status);
  const ex1 = Object.values(run1.agents).filter((a) => a.role === 'executor');
  check('its agent ran once per turn it needed: the question turn and the answered one', ex1.length === 1 && (ex1[0].promptTurns ?? []).length === 2, ex1.map((a) => (a.promptTurns ?? []).length));
  check("beta.txt was written in A's project, not B's", fs.existsSync(path.join(projA, 'beta.txt')) && !fs.existsSync(path.join(projB, 'beta.txt')), fs.readdirSync(projA));
  check("chat 1 kept A's folder", same(run1.config.cwd, projA), run1.config.cwd);

  // 3. Renamed in B, shown in A.
  await B.call('workflows.rename', { id: id1, title: 'renamed in window B' });
  check("renamed in B, the name shows in A's sidebar", await until(() => sidebarHas(A, 'renamed in window B'), "A's sidebar", 10_000, 300).catch(() => false));
  await shot(wa, 'window-A.png');
  await shot(wb, 'window-B.png');

  // 4. Started in B; window A closes meanwhile.
  log('chat 2 (slow) from window B');
  const id2 = (await B.call('workflows.start', { config: cfg(B.info.defaultCwd, goalSlow, 'two-windows: slow') })).result;
  await until(async () => (await B.call('workflows.get', { id: id2 })).result?.agents && Object.keys((await B.call('workflows.get', { id: id2 })).result.agents).length, 'chat 2 agent', 120_000, 1000);
  await sleep(8000);
  log('closing window A');
  await palette(wa, 'workbench.action.closeWindow');
  await until(async () => !(await pageOf(projA)), 'window A closed', 30_000);
  await sleep(2000);
  const after = hubProcesses();
  check('closing window A leaves the hub running', after.length === 1 && after[0] === ep.pid, after);
  check('chat 2 is still running after A closed', (await B.call('workflows.get', { id: id2 })).result?.status === 'running', (await B.call('workflows.get', { id: id2 })).result?.status);
  const run2 = await until(async () => {
    const r = (await B.call('workflows.get', { id: id2 })).result;
    return ['completed', 'failed', 'incomplete', 'cancelled'].includes(r?.status) && r;
  }, 'chat 2 to end', 600_000, 3000);
  fs.writeFileSync(path.join(OUT, 'run-slow.json'), JSON.stringify(run2, null, 1));
  check('chat 2 completed after window A closed', run2.status === 'completed', run2.status);
  const ex2 = Object.values(run2.agents).filter((a) => a.role === 'executor');
  check('its agent ran once (no rerun)', ex2.length === 1 && (ex2[0].promptTurns ?? []).length === 1, ex2.map((a) => (a.promptTurns ?? []).length));
  check("slow-done.txt in B's project", fs.existsSync(path.join(projB, 'slow-done.txt')));
  const hubLog = fs.readFileSync(path.join(home, 'logs', 'vscode-hub.log'), 'utf8');
  fs.writeFileSync(path.join(OUT, 'vscode-hub.log'), hubLog);
  check('one hub served the whole time', (hubLog.match(/serving on port/g) ?? []).length === 1, hubLog.trim().split('\n'));
  await shot(wb, 'window-B-after-A-closed.png');

  // 6. Every window closed: the hub stops by itself.
  log('closing window B');
  await palette(wb, 'workbench.action.closeWindow');
  const stopped = await until(async () => hubProcesses().length === 0, 'the hub to stop', 60_000, 1000).catch(() => false);
  check('with every window closed, the hub stops by itself', stopped, hubProcesses());
  check('it removed its endpoint file', !fs.existsSync(path.join(home, 'vscode-hub.json')));
} catch (e) {
  check('acceptance ran to the end', false, (e).message);
} finally {
  for (const pid of ourCode()) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
  for (const pid of hubProcesses()) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
  fs.writeFileSync(path.join(OUT, 'two-windows.json'), JSON.stringify({ model: MODEL, minutes: ((Date.now() - t0) / 60000).toFixed(1), results }, null, 1));
  log(`${fails} failed`);
  process.exit(fails ? 1 : 0);
}
