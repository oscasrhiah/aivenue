import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// 效率基準跑法（scripts/bench/run.mjs）本身的測試：用替身 CLI／hub，不呼叫任何模型。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bench = path.join(root, 'scripts', 'bench');
// Everything loaded asynchronously comes before the first test is registered: a top-level await between tests would
// let the earlier tests (and the cleanup below) run before the later ones exist, e.g. when a filter skips the first ones.
const B = await import(new URL('./bench/run.mjs', import.meta.url).href);
const PILOT = await import(new URL('./bench/pilot.mjs', import.meta.url).href);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-benchtest-'));

/** Run the benchmark with the stand-ins; returns its report. */
function runBench(args, env = {}, status = 0) {
  const out = fs.mkdtempSync(path.join(work, 'out-'));
  const pids = path.join(out, 'pids');
  const r = spawnSync(process.execPath, [path.join(bench, 'run.mjs'), '--go', '--repeat', '1', '--out', out, ...args], {
    env: { ...process.env, BENCH_OPENCODE_CLI: path.join(bench, 'test-doubles', 'fake-opencode.mjs'), FAKE_PIDS: pids, ...env },
    encoding: 'utf8',
    timeout: 180000,
  });
  assert.equal(r.status, status, r.stdout + r.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const started = fs.existsSync(pids) ? fs.readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number) : [];
  return { report, started, stdout: r.stdout, out };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

test('成功要隱藏驗收與可見測試都過：可見測試失敗時不算解題成功', () => {
  const dir = path.join(work, 'accept');
  fs.cpSync(path.join(bench, 'fixture'), dir, { recursive: true });
  fs.cpSync(path.join(bench, 'reference', 'src'), path.join(dir, 'src'), { recursive: true });
  const task = { acceptance: 'duration-units.accept.mjs' };
  assert.equal(B.acceptance(task, dir).ok, true);
  fs.writeFileSync(path.join(dir, 'test', 'extra.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('x', () => assert.equal(1, 2));\n");
  const a = B.acceptance(task, dir);
  assert.deepEqual([a.ok, a.hiddenOk, a.visibleOk], [false, true, false]);
  assert.deepEqual(B.outcome({ finished: true }, a), { outcome: 'fail', why: 'visible tests failed' });
  // 沒有正常結束（工作流停下或在等人）就不算成功，即使檔案通過測試
  assert.equal(B.outcome({ finished: false, status: 'waiting_human', pending: 'Allow 2 more rounds?' }, { ok: true, hiddenOk: true, visibleOk: true }).outcome, 'stopped');
});

test('直接 CLI：通過且從 OpenCode session 紀錄確認實際模型', () => {
  const { report } = runBench(['--configs', 'direct-cli', '--tasks', 'duration-units']);
  const r = report.runs[0];
  assert.equal(r.outcome, 'pass');
  assert.equal(r.result.model.status, 'verified');
  assert.deepEqual(r.result.model.models, ['opencode/deepseek-v4.1-flash-free']);
  assert.equal(r.result.observed.uncachedInput, 100);
  assert.ok(report.env.bundles.hubSha256);
});

test('直接 CLI：取不到 session 紀錄時標「模型未驗證」；紀錄是別的模型時整次無效', () => {
  let { report } = runBench(['--configs', 'direct-cli', '--tasks', 'duration-units'], { FAKE_EXPORT: 'none' });
  assert.equal(report.runs[0].result.model.status, 'unverified');
  assert.equal(report.runs[0].outcome, 'pass');
  ({ report } = runBench(['--configs', 'direct-cli', '--tasks', 'duration-units'], { FAKE_EXPORT: 'opencode/big-pickle' }));
  assert.equal(report.runs[0].outcome, 'invalid');
  assert.match(report.runs[0].why, /another model: opencode\/big-pickle/);
});

test('直接 CLI：可見測試被改壞時不算成功；模型被限流時整次無效', () => {
  let { report } = runBench(['--configs', 'direct-cli', '--tasks', 'duration-units'], { FAKE_MODE: 'solve-badtest' });
  assert.equal(report.runs[0].outcome, 'fail');
  ({ report } = runBench(['--configs', 'direct-cli', '--tasks', 'duration-units'], { FAKE_MODE: 'limited' }));
  assert.equal(report.runs[0].outcome, 'invalid');
});

test('逾時：CLI 卡住時記為「逾時」（算未解出，不排除），並結束它啟動的程序', () => {
  const { report, started } = runBench(['--configs', 'direct-cli', '--tasks', 'duration-units', '--timeout-min', '0.05'], { FAKE_MODE: 'hang' });
  assert.equal(report.runs[0].outcome, 'timeout');
  assert.ok(started.length >= 1);
  for (const pid of started) assert.equal(alive(pid), false, `pid ${pid} still running`);
});

test('逾時：hub 不回應 RPC 時，同一個期限也會到，hub 程序被結束', () => {
  const { report, started } = runBench(['--configs', 'aivenue-single', '--tasks', 'duration-units', '--timeout-min', '0.08'], { BENCH_HUB_ENTRY: path.join(bench, 'test-doubles', 'fake-hub.mjs') });
  assert.equal(report.runs[0].outcome, 'timeout');
  assert.ok(started.length >= 1);
  for (const pid of started) assert.equal(alive(pid), false, `pid ${pid} still running`);
});

test('審查能力：審查者改了 checkout 裡任何檔案（不只 src）整次無效；沒改就比對找到的缺陷', () => {
  let { report } = runBench(['--configs', 'direct-cli', '--tasks', 'csv-report', '--review'], { FAKE_MODE: 'touch-test' });
  const touched = report.reviews[0];
  assert.equal(touched.outcome, 'invalid');
  assert.match(touched.why, /changed/);
  ({ report } = runBench(['--configs', 'direct-cli', '--tasks', 'csv-report', '--review'], { FAKE_MODE: 'review' }));
  const ok = report.reviews[0];
  assert.equal(ok.outcome, 'reviewed');
  assert.deepEqual(ok.result.found, ['D1', 'D3']);
});

test('模型驗證：兩個 session 只有一個讀得到紀錄時，只能是「部分驗證」，並逐一列出', () => {
  const { report } = runBench(['--configs', 'direct-cli', '--tasks', 'duration-units'], { FAKE_MODE: 'two-sessions', FAKE_EXPORT_MISSING: 'ses_fake2' });
  const m = report.runs[0].result.model;
  assert.equal(m.status, 'partly verified');
  assert.deepEqual(m.sessions.map((s) => [s.id, s.status]), [['ses_fake1', 'match'], ['ses_fake2', 'missing']]);
});

test('逾時：先回報了用量才卡住，保留已觀察到的用量並標為部分用量；沒看到的不當成 0', () => {
  const { report, out } = runBench(['--configs', 'direct-cli', '--tasks', 'duration-units', '--timeout-min', '0.05'], { FAKE_MODE: 'usage-hang' });
  const r = report.runs[0];
  assert.equal(r.outcome, 'timeout');
  assert.equal(r.result.partialUsage, true);
  assert.equal(r.result.observed.uncachedInput, 700);
  assert.equal(r.result.observed.cachedInput, 4000);
  const md = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
  assert.ok(md.includes('| 700 | 4.0k | — | 90 (partial) |'), md);
});

test('審查能力：直接 CLI 審查以非零結束時不算完成審查', () => {
  const { report } = runBench(['--configs', 'direct-cli', '--tasks', 'csv-report', '--review'], { FAKE_MODE: 'review-fail' });
  const r = report.reviews[0];
  assert.equal(r.outcome, 'stopped');
  assert.match(r.why, /did not finish \(exit code 1\)/);
});

test('清理：逾時後的清理有上限、會記錄，結束後不留下計時器拖住程序', () => {
  const t0 = Date.now();
  const { report } = runBench(['--configs', 'aivenue-single', '--tasks', 'duration-units', '--timeout-min', '0.08'], { BENCH_HUB_ENTRY: path.join(bench, 'test-doubles', 'fake-hub.mjs') });
  const elapsed = Date.now() - t0;
  assert.equal(report.runs[0].outcome, 'timeout');
  assert.equal(typeof report.runs[0].cleanupMs, 'number');
  assert.ok(report.runs[0].cleanupMs <= B.CLEANUP_GRACE_MS + 1000, `cleanup ${report.runs[0].cleanupMs}`);
  // 期限 4.8 秒；原本留下的 15 秒計時器會讓整個程序拖到約 20 秒
  assert.ok(elapsed < 14000, `took ${elapsed} ms`);
});

test('逾時：Aivenue 還沒收到任何用量事件（總計 0、events 0）時顯示未知，不當成 0；回報過 0 的事件仍是 0', () => {
  const { report, out } = runBench(['--configs', 'aivenue-single', '--tasks', 'duration-units', '--timeout-min', '0.15'], { BENCH_HUB_ENTRY: path.join(bench, 'test-doubles', 'fake-hub.mjs'), FAKE_HUB_MODE: 'running' });
  const r = report.runs[0];
  assert.equal(r.outcome, 'timeout');
  assert.equal(r.result.observed.events, 0);
  assert.equal(B.seenUsage(r), false);
  const md = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
  const row = md.split('\n').find((l) => l.startsWith('| aivenue-single | duration-units |'));
  assert.ok(row.includes('| — | — | — | — | — |'), row);
  assert.ok(!/\| 0–0 \|/.test(md), md);
  assert.equal(B.seenUsage({ result: { observed: { uncachedInput: 0, cachedInput: 0, output: 0, events: 2 } } }), true);
});

test('隔離：每個程序的 PWD 都指向它的工作資料夾', () => {
  const env = B.envFor('C:\\work\\repo', { X: '1' });
  assert.deepEqual([env.PWD, env.INIT_CWD, env.X, 'OLDPWD' in env], ['C:\\work\\repo', 'C:\\work\\repo', '1', false]);
});

test('隔離：session 紀錄顯示它在 checkout 以外的地方工作，整次無效', () => {
  const { report } = runBench(['--configs', 'direct-cli', '--tasks', 'duration-units'], { FAKE_EXPORT_DIR: 'C:\\Python\\elsewhere' });
  assert.equal(report.runs[0].outcome, 'invalid');
  assert.match(report.runs[0].why, /left its checkout: cli: worked in C:\\Python\\elsewhere/);
});

test('隔離：session 內容提到基準本身的資料夾（隱藏測試、解答所在），整次無效', () => {
  const { report } = runBench(['--configs', 'direct-cli', '--tasks', 'duration-units'], { FAKE_EXPORT_TEXT: `read ${path.join(bench, 'acceptance', 'duration-units.accept.mjs')}` });
  assert.equal(report.runs[0].outcome, 'invalid');
  assert.match(report.runs[0].why, /named the benchmark folder/);
});

test('隔離：執行中改到受保護的基準檔案時，該次無效並停止整批', () => {
  const guard = fs.mkdtempSync(path.join(work, 'guard-'));
  fs.writeFileSync(path.join(guard, 'f.txt'), 'original');
  const { report, stdout } = runBench(['--configs', 'direct-cli', '--tasks', 'duration-units,csv-report'], { BENCH_GUARD: guard, FAKE_MODE: 'escape-write', FAKE_ESCAPE_TO: path.join(guard, 'f.txt') }, 2);
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].outcome, 'invalid');
  assert.match(report.runs[0].why, /changed the benchmark's own files/);
  assert.match(stdout, /Stopped: a run changed the benchmark's own files/);
});

test('額度：「Free usage limit reached」判為無效（模型不可用），不是停下或失敗', () => {
  const { report } = runBench(['--configs', 'direct-cli', '--tasks', 'duration-units'], { FAKE_MODE: 'usage-limit' });
  assert.equal(report.runs[0].outcome, 'invalid');
  assert.match(report.runs[0].why, /usage limit reached/i);
});

test('逾時：仍會在之後另外檢查 session 的位置；位置越界就判為無效', () => {
  const { report } = runBench(['--configs', 'direct-cli', '--tasks', 'duration-units', '--timeout-min', '0.05'], { FAKE_MODE: 'usage-hang', FAKE_EXPORT_DIR: 'C:\\Python\\elsewhere' });
  const r = report.runs[0];
  assert.equal(r.outcome, 'invalid');
  assert.match(r.why, /left its checkout/);
  assert.equal(r.result.partialUsage, true);
  assert.equal(r.result.model.sessionDir, 'outside');
});

test('逾時：位置確認在 checkout 內才計入比較；查不到位置的逾時另外標示，不計入', () => {
  let { report } = runBench(['--configs', 'direct-cli', '--tasks', 'duration-units', '--timeout-min', '0.05'], { FAKE_MODE: 'usage-hang' });
  assert.equal(report.runs[0].outcome, 'timeout');
  assert.equal(report.runs[0].result.model.sessionDir, 'match');
  ({ report } = runBench(['--configs', 'direct-cli', '--tasks', 'duration-units', '--timeout-min', '0.05'], { FAKE_MODE: 'usage-hang', FAKE_EXPORT: 'none' }));
  assert.equal(report.runs[0].outcome, 'timeout');
  assert.equal(report.runs[0].result.model.sessionDir, 'unknown');
});

test('位置：紀錄沒有目錄欄位時是「位置未知」，不當成在 checkout 內；不計入比較', () => {
  const { report, out } = runBench(['--configs', 'direct-cli', '--tasks', 'duration-units'], { FAKE_EXPORT_DIR: '' });
  const r = report.runs[0];
  assert.equal(r.outcome, 'pass');
  assert.equal(r.result.model.status, 'verified');
  assert.equal(r.result.model.sessionDir, 'unknown');
  const md = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
  assert.ok(!md.includes('| direct-cli | 1 |'), 'a run with an unknown session dir must not be counted');
});

test('位置：紀錄沒有模型欄位，但顯示在 checkout 外工作時，越界證據仍會留下', () => {
  const { report } = runBench(['--configs', 'direct-cli', '--tasks', 'duration-units'], { FAKE_EXPORT: 'nomodel', FAKE_EXPORT_DIR: 'C:\\Python\\elsewhere' });
  const r = report.runs[0];
  assert.equal(r.result.model.status, 'unverified');
  assert.equal(r.outcome, 'invalid');
  assert.match(r.why, /worked in C:\\Python\\elsewhere/);
});


test('標準模式組別：只在指名時才跑，送出的設定是標準模式（不開計畫、一位審查者最多 2 輪、不驗收、不開 sub agent）', () => {
  const plan = spawnSync(process.execPath, [path.join(bench, 'run.mjs')], { encoding: 'utf8', timeout: 60000 });
  assert.equal(plan.status, 0, plan.stderr);
  assert.ok(!plan.stdout.includes('aivenue-standard'), '預設的三組不變');
  const saved = path.join(work, 'standard-config.json');
  const { report } = runBench(['--configs', 'aivenue-standard', '--tasks', 'duration-units', '--timeout-min', '0.08'], { BENCH_HUB_ENTRY: path.join(bench, 'test-doubles', 'fake-hub.mjs'), FAKE_HUB_MODE: 'running', FAKE_HUB_CONFIG: saved });
  assert.equal(report.runs[0].setup, 'aivenue-standard');
  const c = JSON.parse(fs.readFileSync(saved, 'utf8'));
  assert.equal(c.flow, 'standard');
  assert.equal(c.plan.enabled, false);
  assert.equal(c.implement.enabled, true);
  assert.ok(c.implement.reviewer, '保留程式審查');
  assert.equal(c.implement.maxRounds, 2);
  assert.equal(c.verify.enabled, false);
  assert.equal(c.subagents.enabled, false);
  assert.equal(c.memory.mode, 'off');
});

test('標準模式組別的設定由核心的 applyStandard 產生（從目前預設套用），不另外手寫', async () => {
  const task = { id: 'duration-units', goal: 'g' };
  const std = await B.aivenueConfig('aivenue-standard', task, 'C:/x');
  const cur = await B.aivenueConfig('aivenue-default', task, 'C:/x');
  assert.equal(cur.flow, undefined);
  // 與目前預設只差在流程欄位；作者、審查者、模型、記憶、權限都相同。
  assert.deepEqual(std.plan, { ...cur.plan, enabled: false });
  assert.deepEqual(std.implement, { ...cur.implement, maxRounds: 2 });
  assert.deepEqual(std.subagents, { ...cur.subagents, enabled: false });
  assert.deepEqual(std.verify, { ...cur.verify, enabled: false });
  const { flow, plan, implement, subagents, verify, ...rest } = std;
  const { plan: _p, implement: _i, subagents: _s, verify: _v, ...restCur } = cur;
  assert.equal(flow, 'standard');
  assert.deepEqual(rest, restCur);
});

// ---------- 另一個 CLI 的初測入口（pilot.mjs，不呼叫模型） ----------

/** 一份假的 Codex session 紀錄，放在暫存的 CODEX_HOME 底下。 */
function fakeCodexHome(id, lines) {
  const home = fs.mkdtempSync(path.join(work, 'codex-'));
  const dir = path.join(home, 'sessions', '2026', '11', '04');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rollout-2026-11-04T00-00-00-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return home;
}
function withCodexHome(home, fn) {
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    return fn();
  } finally {
    before === undefined ? delete process.env.CODEX_HOME : (process.env.CODEX_HOME = before);
  }
}

const call = (name, args) => ({ type: 'response_item', payload: { type: 'function_call', name, arguments: JSON.stringify(args) } });
const code = (input) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input } });
const meta = (cwd, model = 'gpt-6-luna', effort = 'low') => [
  { type: 'session_meta', payload: { cwd } },
  { type: 'turn_context', payload: { cwd, model, collaboration_mode: { settings: { reasoning_effort: effort } } } },
];

test('初測：只有每個工具呼叫都能完整判定且都在 checkout 內才算 contained；shell 或程式碼呼叫只能是「未發現越界」', () => {
  const co = path.join(work, 'pilot-co');
  const ok = fakeCodexHome('s-ok', [
    ...meta(co),
    call('apply_patch', { input: '*** Begin Patch\n*** Add File: result.txt\n+HELLO\n*** End Patch' }),
    call('mcp__aivenue__submit_work', { summary: `wrote ${path.join(co, 'result.txt')}` }),
  ]);
  const r = withCodexHome(ok, () => PILOT.readSession('codex', 's-ok', co));
  assert.equal(r.record, 'read');
  assert.deepEqual(r.models, ['gpt-6-luna']);
  assert.deepEqual(r.efforts, ['low']);
  assert.equal(r.toolCalls, 2);
  assert.equal(r.location, 'contained', JSON.stringify(r));
  const shell = fakeCodexHome('s-shell', [...meta(co), call('exec_command', { cmd: 'Get-Content NOTE.txt', workdir: co })]);
  const s = withCodexHome(shell, () => PILOT.readSession('codex', 's-shell', co));
  assert.equal(s.location, 'no escape found');
  assert.deepEqual(s.unchecked, { 'shell command': 1 });
  // Codex 的程式碼模式：{q:"…"}、{cmd:"…"} 不是磁碟路徑，但整段程式碼無法完整判定。
  const js = fakeCodexHome('s-code', [...meta(co), code('await tools.mcp__aivenue__search_records({q:"NOTE.txt"}); await tools.exec_command({cmd:"Get-Content NOTE.txt",workdir:' + JSON.stringify(co) + '}); report({status:"done", d:"x"})')]);
  const c = withCodexHome(js, () => PILOT.readSession('codex', 's-code', co));
  assert.deepEqual(c.outsidePaths, []);
  assert.equal(c.location, 'no escape found');
  assert.equal(c.uncheckedCalls, 1);
});

test('初測：相對路徑依呼叫的工作目錄解析；../ 跑出 checkout 就是越界（shell 與程式碼模式都一樣）', () => {
  const co = path.join(work, 'pilot-co3');
  const viaShell = fakeCodexHome('s-up', [...meta(co), call('exec_command', { cmd: 'Get-Content ../outside-canary.txt', workdir: co })]);
  const a = withCodexHome(viaShell, () => PILOT.readSession('codex', 's-up', co));
  assert.equal(a.location, 'outside');
  assert.ok(a.outsidePaths.some((p) => p.includes('outside-canary')), JSON.stringify(a.outsidePaths));
  // `..\..\` climbs only on Windows; on Linux and macOS a backslash is part of a file name, so use what that system's shell would.
  const up2 = process.platform === 'win32' ? 'type ..\\\\..\\\\secret.txt' : 'cat ../../secret.txt';
  const viaCode = fakeCodexHome('s-up2', [...meta(co), code('const r = await tools.exec_command({cmd:"' + up2 + '",workdir:' + JSON.stringify(co) + '}); text(r.output);')]);
  assert.equal(withCodexHome(viaCode, () => PILOT.readSession('codex', 's-up2', co)).location, 'outside');
  // 沒有寫工作目錄時，以 session 的工作目錄為準。
  const noWorkdir = fakeCodexHome('s-up3', [...meta(co), call('exec_command', { cmd: 'cat ../../x' })]);
  assert.equal(withCodexHome(noWorkdir, () => PILOT.readSession('codex', 's-up3', co)).location, 'outside');
  // 留在 checkout 內的 ../（sub/../NOTE.txt）不算越界；... 與 1..5 不是路徑。
  const fine = fakeCodexHome('s-up4', [...meta(co), call('exec_command', { cmd: 'Get-Content src/../NOTE.txt; node -e "[...a]"; seq 1..5', workdir: co })]);
  assert.equal(withCodexHome(fine, () => PILOT.readSession('codex', 's-up4', co)).location, 'no escape found');
  // patch 的檔案在 checkout 外。
  const patch = fakeCodexHome('s-patch', [...meta(co), call('apply_patch', { input: '*** Begin Patch\n*** Add File: ../escaped.txt\n+x\n*** End Patch' })]);
  assert.equal(withCodexHome(patch, () => PILOT.readSession('codex', 's-patch', co)).location, 'outside');
  // ~ 或環境變數無法解析：不算越界，但這個呼叫不能算完整判定。
  const home = fakeCodexHome('s-home', [...meta(co), call('apply_patch', { input: '*** Begin Patch\n*** Add File: result.txt\n+see ~/notes\n*** End Patch' })]);
  assert.equal(withCodexHome(home, () => PILOT.readSession('codex', 's-home', co)).location, 'no escape found');
});

test('初測：工作目錄或絕對路徑在 checkout 外就是越界；讀不到紀錄是 missing，其他 CLI 是 unknown', () => {
  const co = path.join(work, 'pilot-co2');
  const repo = path.join('C:', 'Python', 'agenthub');
  const outsideDir = fakeCodexHome('s-dir', [{ type: 'session_meta', payload: { cwd: repo } }, { type: 'turn_context', payload: { cwd: co, model: 'm' } }]);
  const a = withCodexHome(outsideDir, () => PILOT.readSession('codex', 's-dir', co));
  assert.equal(a.location, 'outside');
  assert.deepEqual(a.outsideDirs, [repo]);
  const readsOut = fakeCodexHome('s-read', [...meta(co), call('exec_command', { cmd: `type ${path.join(repo, 'scripts', 'bench', 'reference', 'src', 'csv.js')}`, workdir: co })]);
  const b = withCodexHome(readsOut, () => PILOT.readSession('codex', 's-read', co));
  assert.equal(b.location, 'outside');
  assert.ok(b.outsidePaths.some((p) => p.includes('reference')), JSON.stringify(b.outsidePaths));
  // 名稱相近但不在裡面的資料夾。
  const sibling = fakeCodexHome('s-sib', [{ type: 'session_meta', payload: { cwd: co + '-other' } }]);
  assert.equal(withCodexHome(sibling, () => PILOT.readSession('codex', 's-sib', co)).location, 'outside');
  assert.equal(withCodexHome(sibling, () => PILOT.readSession('codex', 'no-such-id', co)).record, 'missing');
  assert.equal(PILOT.readSession('copilot', 'x', co).location, 'unknown');
});

test('初測：實際模型與推理強度逐 session 比對；不符判無效，缺失標未驗證', () => {
  const want = { model: 'gpt-6-luna', effort: 'low' };
  const read = (models, efforts, role = 'executor') => ({ role, record: 'read', models, efforts });
  assert.equal(PILOT.checkModels([read(['gpt-6-luna'], ['low']), read(['gpt-6-luna'], ['low'], 'code_reviewer')], want).status, 'verified');
  assert.equal(PILOT.checkModels([read(['gpt-6-luna'], ['low']), read(['gpt-6-sol'], ['low'], 'code_reviewer')], want).status, 'mismatch');
  assert.equal(PILOT.checkModels([read(['gpt-6-luna', 'gpt-6-sol'], ['low'])], want).status, 'mismatch', '中途換模型也算不符');
  assert.equal(PILOT.checkModels([read(['gpt-6-luna'], ['high'])], want).status, 'mismatch');
  assert.equal(PILOT.checkModels([read(['gpt-6-luna'], [])], want).status, 'unverified');
  assert.equal(PILOT.checkModels([read([], ['low'])], want).status, 'unverified');
  assert.equal(PILOT.checkModels([read(['gpt-6-luna'], ['low']), { role: 'planner', record: 'missing', models: [], efforts: [] }], want).status, 'unverified');
  assert.equal(PILOT.checkModels([], want).status, 'unverified');
  // 沒有指定推理強度時只比對模型。
  assert.equal(PILOT.checkModels([read(['gpt-6-luna'], [])], { model: 'gpt-6-luna' }).status, 'verified');

  const entry = (model, location = 'no escape found') => ({ result: { status: 'completed' }, accept: { ok: true }, sessions: { location, model: { status: model, sessions: [{ role: 'executor', status: model, why: 'model gpt-6-sol' }] } } });
  assert.equal(PILOT.judgeCompare(entry('verified')).outcome, 'pass');
  assert.equal(PILOT.judgeCompare(entry('mismatch')).outcome, 'invalid');
  const u = PILOT.judgeCompare(entry('unverified'));
  assert.equal(u.outcome, 'pass');
  assert.match(u.why, /model unverified/);
  assert.equal(PILOT.judgeCompare(entry('verified', 'outside')).outcome, 'invalid');
});

test('初測：位置驗證的結論只到「結果檔正確、已解析的紀錄未發現越界」；模型不符或越界就不通過', () => {
  const files = { 'result.txt written in the checkout with the upper-case text': true };
  const sessions = (location, model = 'verified') => ({ sessions: [], location, calls: 9, unchecked: 6, model: { status: model } });
  const a = PILOT.judgeLocation(files, sessions('no escape found'));
  assert.equal(a.passed, true);
  assert.match(a.scope, /6 of 9 tool calls/);
  assert.match(a.scope, /not every read and write is proven/);
  assert.equal(PILOT.judgeLocation(files, sessions('outside')).passed, false);
  assert.equal(PILOT.judgeLocation(files, sessions('unknown')).passed, false);
  assert.equal(PILOT.judgeLocation(files, sessions('no escape found', 'mismatch')).passed, false);
  assert.equal(PILOT.judgeLocation(files, sessions('no escape found', 'unverified')).passed, false);
  // 舊報告裡的舊判定項目會被換掉，不會沿用。
  const old = PILOT.judgeLocation({ ...files, 'every session record read, every working folder and path inside the checkout': true }, sessions('outside'));
  assert.equal('every session record read, every working folder and path inside the checkout' in old.checks, false);
  assert.equal(old.passed, false);
});

test('初測：兩組只差流程配置；標準組由 applyStandard 產生；同一個 agent、模型與推理設定', async () => {
  const who = { provider: 'codex', model: 'gpt-6-luna', effort: 'low' };
  const cur = await PILOT.pilotConfig('default', 'g', 'C:/x', who);
  const std = await PILOT.pilotConfig('standard', 'g', 'C:/x', who);
  assert.equal(std.flow, 'standard');
  assert.deepEqual(std.plan, { ...cur.plan, enabled: false });
  assert.deepEqual(std.implement, { ...cur.implement, maxRounds: 2 });
  assert.deepEqual(std.subagents, { ...cur.subagents, enabled: false });
  for (const c of [cur, std]) {
    assert.deepEqual(c.implement.author, who);
    assert.deepEqual(c.implement.reviewer, who);
    assert.equal(c.memory.mode, 'off');
  }
  assert.deepEqual(cur.subagents.models, { codex: { model: 'gpt-6-luna', effort: 'low' } });
});

test('初測入口：一定要指名 CLI 與模型；OpenCode 留給原本的基準；不加 --go 不執行', () => {
  const run = (...a) => spawnSync(process.execPath, [path.join(bench, 'pilot.mjs'), ...a], { encoding: 'utf8', timeout: 60000 });
  assert.notEqual(run('--step', 'location').status, 0);
  assert.notEqual(run('--provider', 'opencode', '--model', 'opencode/deepseek-v4.1-flash-free', '--step', 'location').status, 0);
  assert.notEqual(run('--provider', 'codex', '--model', 'gpt-6-luna', '--step', 'compare').status, 0, '比較一定要指定任務');
  const dry = run('--provider', 'codex', '--model', 'gpt-6-luna', '--step', 'compare', '--task', 'duration-units');
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(dry.stdout.includes('Nothing was run'));
});

// Cleanup last, once every test is registered.
test.after(() => fs.rmSync(work, { recursive: true, force: true }));
