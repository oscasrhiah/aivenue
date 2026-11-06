import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { build } from 'esbuild';

// 工作流的控制規則（路由、限制、錯誤分類、紀錄、匯出）都是純函式，直接打包原始碼測試。
const bundled = await build({
  stdin: {
    contents: `export * from './packages/core/src/router';
      export * from './packages/core/src/failures';
      export * from './packages/core/src/records';
      export * from './packages/core/src/bundle';
      export { ResourceManager, pidAlive, checkShell, findGitBash } from './packages/core/src/resources';
      export { parseVerification, parsePlan, parseReview, parseRulings, toolsForRole } from './packages/core/src/hubTools';
      export { parseSize, inspectProcess } from './packages/core/src/procstat';
      export { CliPool } from './packages/core/src/cliPool';
      export { backgroundLaunch, pidFromOutput } from './packages/core/src/procdetect';
      export { fileReadOf, POLLING, collectActivity, activityBlock, ownWorkBlock } from './packages/core/src/ledger';
      export { contextBlock, conversationLog, formatTranscript, handoverOf, overview, shownElsewhere, toolInputText } from './packages/core/src/context';
      export { groupFolders } from './packages/core/src/outputs';
      export { codexContext } from './packages/core/src/agentContext';
      export { buildTopics, topicDetail, topicIndexBlock, topicList } from './packages/core/src/topics';
      export { addObserved, addTurn, costBreakdown, promptTurn, roleParts, trackWaiting } from './packages/core/src/promptStats';
      export { createParser } from './packages/core/src/providers/parsers';
      export { capture, cliEnv, consoleCodePage, decodeShellOutput } from './packages/core/src/proc';
      export { runAgent } from './packages/core/src/agentRunner';
      export { applyStandard, flowModeOf, keepFlowMark, matchesStandard, STANDARD_ROUNDS } from './packages/core/src/flowMode';
      export { draftInit, forNewConversations } from './packages/ui/src/draftInit';
      export * as P from './packages/core/src/prompts';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent',
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const W = mod.exports;
const L = (zh) => zh;

const metric = (id, met) => ({ id, value: met ? 'ok' : 'low', met, evidence: 'npm test' });
const issue = (id, title) => ({ id, severity: 'major', title });
const v = (outcome, metrics, issues = []) => ({ outcome, summary: '', metrics, issues });

// ---------- routing ----------

test('驗收路由：達標才結束，其餘各自退回', () => {
  assert.equal(W.routeVerification(v('met', [metric('M1', true), metric('M2', true)]), []).to, 'done');
  assert.equal(W.routeVerification(v('defect', [metric('M1', false)], [issue('V1', 'crash on empty input')]), []).to, 'implementer');
  assert.equal(W.routeVerification(v('invalid_evidence', [metric('M1', false)], [issue('V1', 'test uses training data')]), []).to, 'implementer');
  assert.equal(W.routeVerification(v('not_met', [metric('M1', false)]), []).to, 'planner');
});

test('代理不能自行宣告通過：說「達標」但有指標沒達成、或沒量任何指標', () => {
  const lie = W.routeVerification(v('met', [metric('M1', true), metric('M2', false)]), []);
  assert.notEqual(lie.to, 'done');
  assert.equal(lie.to, 'planner');
  assert.equal(W.routeVerification(v('met', []), []).to, 'implementer');
  // 計畫者的指標全過，但驗收者額外量測的使用者標準（U1）沒過 → 不能結束
  assert.notEqual(W.routeVerification(v('met', [metric('M1', true), metric('U1', false)]), []).to, 'done');
});

test('同一個問題連續修不好：交回計畫者重新診斷', () => {
  const d = (n) => v('defect', [metric('M1', false)], [issue(`V${n}`, 'Crash on empty input!')]);
  assert.equal(W.routeVerification(d(2), [d(1)], 3).to, 'implementer');
  const third = W.routeVerification(d(3), [d(1), d(2)], 3);
  assert.equal(third.to, 'planner');
  assert.equal(third.rediagnose, true);
});

test('狀態轉移：沒有達標就不停，直到驗收通過', () => {
  // 模擬一連串驗收結果，走過控制器的完整循環。
  const results = [
    v('defect', [metric('M1', false)], [issue('V1', 'off by one')]),
    v('invalid_evidence', [metric('M1', false)], [issue('V1', 'benchmark not run')]),
    v('not_met', [metric('M1', false)]),
    v('met', [metric('M1', true)]),
  ];
  const phases = [];
  const earlier = [];
  for (const r of results) {
    const next = W.nextPhase(W.routeVerification(r, earlier), true);
    earlier.push(r);
    phases.push(next);
    if (next === 'done') break;
  }
  assert.deepEqual(phases, ['implement', 'implement', 'plan', 'done']);
  // 沒有計畫階段：原本給計畫者的也交給實作者
  assert.equal(W.nextPhase({ to: 'planner', reason: '' }, false), 'implement');
});

test('爭議：作者反駁、審查者再提兩次 → 交付裁定', () => {
  const rounds = [
    { issues: [issue('R1', 'Use a mutex')] },
    { issues: [issue('R1', 'use a mutex')], responses: [{ issue_id: 'R1', action: 'rebutted' }] },
    { issues: [issue('R3', 'Use a mutex.')], responses: [{ issue_id: 'R1', action: 'rebutted' }] },
  ];
  assert.equal(W.disputedIssues(rounds).length, 1);
  // 作者修了（不是反駁）就不算爭議
  const fixed = rounds.map((r) => ({ ...r, responses: r.responses?.map((x) => ({ ...x, action: 'fixed' })) }));
  assert.equal(W.disputedIssues(fixed).length, 0);
});

test('執行限制：預設關閉，開啟後時間／費用／循環各自生效', () => {
  const st = { startedAt: 0, now: 3 * 3600000, costUsd: 50, cycles: 99 };
  assert.equal(W.limitHit(undefined, st), undefined);
  assert.equal(W.limitHit({ enabled: false, maxMinutes: 1 }, st), undefined);
  assert.match(W.limitHit({ enabled: true, maxMinutes: 60 }, st), /time/);
  assert.match(W.limitHit({ enabled: true, maxCostUsd: 10 }, st), /cost/);
  assert.match(W.limitHit({ enabled: true, maxCycles: 5 }, st), /retry/);
  assert.equal(W.limitHit({ enabled: true, maxMinutes: 600, maxCostUsd: 100, maxCycles: 100 }, st), undefined);
});

// ---------- failures ----------

test('錯誤分類：服務問題與邏輯錯誤分開', () => {
  assert.equal(W.classifyFailure('Error 429: Too Many Requests'), 'rate_limit');
  assert.equal(W.classifyFailure('You exceeded your current quota, please check your plan and billing details'), 'quota');
  assert.equal(W.classifyFailure('fetch failed: ECONNRESET'), 'network');
  assert.equal(W.classifyFailure('529 Overloaded'), 'model_service');
  assert.equal(W.classifyFailure('401 Unauthorized: invalid api key'), 'auth');
  assert.equal(W.classifyFailure('TypeError: cannot read properties of undefined'), 'logic');
});

test('恢復策略：限流退避重試、額度直接換人、邏輯錯誤不重試', () => {
  const r1 = W.recoveryFor('rate_limit', 1, L);
  const r3 = W.recoveryFor('rate_limit', 3, L);
  const r4 = W.recoveryFor('rate_limit', 4, L);
  assert.ok(r1.retry && r3.retry && r3.delayMs > r1.delayMs);
  assert.ok(!r4.retry && r4.failover);
  assert.ok(!W.recoveryFor('quota', 1, L).retry && W.recoveryFor('quota', 1, L).failover);
  assert.ok(W.recoveryFor('network', 1, L).retry);
  assert.ok(!W.recoveryFor('logic', 1, L).retry && !W.recoveryFor('logic', 1, L).failover);
});

// ---------- fault simulation ----------

test('故障模擬：遺失或亂掉的結果不會被當成通過', () => {
  assert.equal(W.parseVerification(undefined), undefined);
  assert.equal(W.parseVerification({ outcome: 'probably fine' }), undefined);
  const s = W.parseVerification({ outcome: 'Not met', summary: 'x', metrics: [{ id: 'M1', value: '0.8', met: 'true' }, { id: 'M2', value: '1', met: 'yes' }] });
  assert.equal(s.outcome, 'not_met');
  assert.deepEqual(s.metrics.map((m) => m.met), [true, false]);
  assert.equal(W.parseRulings({ rulings: [{ issue_id: 'R1', ruling: 'DISMISS', reason: 'x' }, { ruling: 'uphold' }] }).length, 1);
});

test('故障模擬：已核准的對外動作不重做、條件等待有上下限', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-res-'));
  const rm = new W.ResourceManager(dir);
  const w = rm.newWait('a1', { check: 'x', interval_sec: 1, timeout_min: 999999, gpus: 0 });
  assert.equal(w.intervalSec, 5);
  assert.ok(w.timeoutAt - w.startedAt <= 7 * 24 * 3600000);
  assert.equal(w.gpus, undefined);
  // 鎖檔屬於已結束的程序 → 視為過期
  fs.writeFileSync(path.join(dir, 'locks', 'gpu-0.json'), JSON.stringify({ workflowId: 'w', agentId: 'a', pid: 999999, since: 0 }));
  assert.deepEqual(rm.release('other'), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('條件等待：指令成功且輸出含指定文字才算成立', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-res-'));
  const rm = new W.ResourceManager(dir);
  const node = JSON.stringify(process.execPath);
  const ok = await rm.check(rm.newWait('a', { check: `${node} -e "console.log('done 100%')"`, contains: 'done' }), dir);
  const no = await rm.check(rm.newWait('a', { check: `${node} -e "console.log('still 40%')"`, contains: 'done' }), dir);
  const fail = await rm.check(rm.newWait('a', { check: `${node} -e "process.exit(3)"` }), dir);
  assert.deepEqual([ok.ok, no.ok, fail.ok], [true, false, false]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- records ----------

const runWith = (over = {}) => ({
  id: 'r1',
  config: { cwd: '.', goal: 'g', plan: { enabled: true }, implement: { enabled: true } },
  status: 'running',
  createdAt: 0,
  updatedAt: 0,
  stages: {
    plan: { key: 'plan', status: 'approved', rounds: [], roundLimit: 3 },
    implement: { key: 'implement', status: 'running', rounds: [{ n: 1, authorAgentId: 'e1', reviewerAgentId: 'c1', review: { verdict: 'revise', summary: 'needs work', issues: [issue('R1', 'missing test for parser.ts')], evidence: { at: 0, treeHash: 'aaa', env: {} } } }], roundLimit: 3 },
    verify: { key: 'verify', status: 'running', rounds: [{ n: 1, reviewerAgentId: 'v1', verification: { ...v('defect', [metric('M1', false)], [issue('V1', 'slow')]), evidence: { at: 0, treeHash: 'bbb', env: {} } } }], roundLimit: 9 },
  },
  steps: [],
  agents: {
    e1: { id: 'e1', role: 'executor', provider: 'opencode', depth: 0, stage: 'implement', round: 1, status: 'completed', task: '', startedAt: 0, stats: { events: 0, tools: 0, commands: 0, filesChanged: [] } },
    c1: { id: 'c1', role: 'code_reviewer', provider: 'codex', depth: 0, stage: 'implement', round: 1, status: 'completed', task: '', startedAt: 0, stats: { events: 0, tools: 0, commands: 0, filesChanged: [] } },
  },
  notes: [
    { id: 'n1', agentId: 'e1', text: 'parser lives in src/parser.ts', kind: 'fact', ts: 1 },
    { id: 'n2', agentId: 'e1', text: 'probably a race', kind: 'inference', ts: 2 },
    { id: 'n3', agentId: 'c1', text: 'keep the public API', kind: 'decision', ts: 3 },
  ],
  log: [],
  ...over,
});

test('驗證結果綁定程式版本：程式變了就標為過期', () => {
  const run = runWith();
  assert.equal(W.markStale(run, { treeHash: 'aaa', env: {} }), 1);
  assert.equal(run.stages.implement.rounds[0].review.stale, undefined);
  assert.equal(run.stages.verify.rounds[0].verification.stale, true);
  assert.equal(W.markStale(run, { treeHash: 'ccc', env: {} }), 1);
  assert.equal(W.markStale(run, { treeHash: 'ccc', env: {} }), 0);
});

test('交接摘要：事實、決策、未解問題分開，並連回證據', () => {
  const run = runWith();
  const h = W.buildHandoff(run, 'implement', run.stages.implement.rounds[0]);
  assert.ok(h.open.some((x) => x.startsWith('R1')));
  assert.ok(h.decisions.some((x) => x.includes('keep the public API')));
  assert.ok(!h.decisions.some((x) => x.includes('probably a race')));
  assert.ok(h.links.some((l) => l.issueId === 'R1') && h.links.some((l) => l.agentId === 'e1'));
});

test('紀錄搜尋：依角色、檔案、問題編號篩選', () => {
  const run = runWith();
  const events = { e1: [{ seq: 1, ts: 0, kind: 'tool', tool: { name: 'edit', category: 'edit', title: 'src/parser.ts', status: 'ok' } }], c1: [{ seq: 1, ts: 0, kind: 'message', text: 'looked at the lexer' }] };
  const of = (id) => events[id] ?? [];
  assert.ok(W.searchRecords(run, of, { file: 'parser.ts', role: 'executor' }).some((h) => h.kind === 'tool:edit'));
  assert.equal(W.searchRecords(run, of, { q: 'lexer', role: 'executor' }).length, 0);
  assert.ok(W.searchRecords(run, of, { issueId: 'R1' }).some((h) => h.kind === 'issue'));
  assert.ok(W.searchRecords(run, of, { q: 'race' }).some((h) => h.kind === 'note:inference'));
});

// ---------- export / project skill ----------

test('匯出遮罩：金鑰、權杖、信箱都被遮住', () => {
  const { text, count } = W.maskText('key sk-ant-abcdefghijklmnopqrstuv mail a.b@example.com gh ghp_abcdefghijklmnopqrstuvwxyz12 Authorization: Bearer abcdefghijklmnopqrstuvwx');
  assert.ok(!/sk-ant-|example\.com|ghp_|abcdefghijklmnopqrstuvwx/.test(text));
  assert.ok(count >= 4);
});

test('匯出：產生可追溯的檔案並寫明保存期限', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-exp-'));
  const out = W.exportBundle(dir, runWith(), () => [{ seq: 1, ts: 0, kind: 'message', text: 'contact me at x@y.io' }], true);
  const b = JSON.parse(fs.readFileSync(out.path, 'utf8'));
  assert.equal(b.format, 'aivenue-run/1');
  assert.equal(b.retention.days, W.EXPORT_RETENTION_DAYS);
  assert.ok(!JSON.stringify(b).includes('x@y.io'));
  assert.ok(b.events.e1.length === 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('提煉專案 Skill：只收已驗證的內容，重複不加', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-skill-'));
  const run = runWith({ plan: { summary: '', markdown: '', steps: [], goal: { statement: 's', metrics: [{ id: 'M1', name: 'tests', target: 'all pass', how: 'npm test' }] } } });
  run.stages.verify.rounds.push({ n: 2, verification: v('met', [metric('M1', true)]) });
  const a = W.distilProjectSkill(dir, run);
  const text = fs.readFileSync(a.path, 'utf8');
  assert.match(text, /parser lives in src\/parser\.ts/);
  assert.match(text, /keep the public API/);
  assert.match(text, /npm test/);
  assert.doesNotMatch(text, /probably a race/);
  assert.equal(W.distilProjectSkill(dir, run).added, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('工具權限：驗收者能交驗收，實作者不能；顧問不能等待或鎖 GPU', () => {
  const names = (role) => W.toolsForRole(role, false, true, false).map((t) => t.name);
  assert.ok(names('verifier').includes('submit_verification'));
  assert.ok(!names('executor').includes('submit_verification'));
  assert.ok(names('executor').includes('gpu_acquire') && names('executor').includes('wait_for'));
  assert.ok(!names('advisor').includes('gpu_acquire'));
  assert.ok(names('code_reviewer').includes('search_records'));
});

// ---------- background process progress ----------

test('程序進度：大小字串解析', () => {
  assert.equal(W.parseSize('15.6GB'), Math.round(15.6 * 1024 ** 3));
  assert.equal(W.parseSize('800 MB'), 800 * 1024 ** 2);
  assert.equal(W.parseSize(1234), 1234);
  assert.equal(W.parseSize('a lot'), undefined);
});

test('程序進度：依輸出檔大小算百分比、速度與剩餘時間', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-proc-'));
  const file = path.join(dir, 'data.tgz');
  fs.writeFileSync(file, Buffer.alloc(250));
  const p = { pid: process.pid, purpose: 'download', cleanup: 'agent', agentId: 'a', startedAt: Date.now() - 5000, watchFile: 'data.tgz', expectedBytes: 1000 };
  const d1 = W.inspectProcess(p, dir);
  assert.equal(d1.alive, true);
  assert.equal(d1.source, 'file');
  assert.equal(Math.round(d1.percent), 25);
  await new Promise((r) => setTimeout(r, 1100));
  fs.appendFileSync(file, Buffer.alloc(250));
  const d2 = W.inspectProcess(p, dir);
  assert.equal(Math.round(d2.percent), 50);
  assert.ok(d2.speed > 0 && d2.etaSec > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('程序進度：從日誌讀百分比；提前結束會標出來', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-proc-'));
  fs.writeFileSync(path.join(dir, 'train.log'), 'epoch 1\r 12%|██   |\r 37%|█████ |\nsaving checkpoint\n');
  const d = W.inspectProcess({ pid: 999999, purpose: 'train', cleanup: 'agent', agentId: 'a', startedAt: Date.now(), log: 'train.log' }, dir);
  assert.equal(d.percent, 37);
  assert.equal(d.source, 'log');
  assert.equal(d.alive, false);
  assert.equal(d.endedEarly, true);
  assert.ok(d.logTail.includes('saving checkpoint'));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- CLIs kept between turns ----------

const fakeChild = () => ({ exitCode: null, killed: false, pid: undefined, stdin: { end() {} }, once() {}, on() {} });
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

test('常駐 CLI：工作流還沒結束就不關，結束後閒置超過設定時間才關', async () => {
  let active = true;
  const pool = new W.CliPool(60, () => active);
  let closed = false;
  pool.add({ fingerprint: 'f', sessionId: 's1', child: fakeChild(), secret: 'x', busy: true, owner: 'wf1', cleanup: () => (closed = true) });
  await sleepMs(200); // 已超過閒置時間好幾次，但工作流仍在進行（例如等額度重置）
  assert.equal(closed, false);
  active = false;
  pool.ownerEnded('wf1');
  await sleepMs(30);
  assert.equal(closed, false); // 倒數從工作流結束時才開始
  await sleepMs(80);
  assert.equal(closed, true);
});

test('常駐 CLI：設成不自動關閉就一直保留', async () => {
  const pool = new W.CliPool(40, () => false);
  pool.setIdleMs(0);
  let closed = false;
  pool.add({ fingerprint: 'f', sessionId: 's2', child: fakeChild(), secret: 'x', busy: true, owner: 'wf2', cleanup: () => (closed = true) });
  pool.ownerEnded('wf2');
  await sleepMs(120);
  assert.equal(closed, false);
  pool.closeAll();
  assert.equal(closed, true);
});

// ---------- shared context ----------

test('背景程序偵測：nohup、&、新終端機、Start-Process 算啟動；等待迴圈不算', () => {
  const l = W.backgroundLaunch('nohup python train.py --epochs 16 > logs/train.log 2>&1 &', '[1] 204493');
  assert.equal(l.key, 'train.py');
  assert.equal(l.log, 'logs/train.log');
  assert.equal(l.pid, 204493);
  assert.equal(W.backgroundLaunch('gnome-terminal --title x -- bash -c "python -m asr.train; exec bash"').key, 'asr.train');
  assert.ok(W.backgroundLaunch('Start-Process python -ArgumentList fake.py -RedirectStandardOutput dl.log -PassThru'));
  assert.ok(W.backgroundLaunch('python serve.py', '', '{"command":"python serve.py","run_in_background":true}'));
  assert.equal(W.backgroundLaunch('until grep -q ^done run.status; do sleep 30; done'), undefined);
  // Starting a job and then waiting a moment in the same line is still a launch (this was missed before).
  const both = W.backgroundLaunch('cd /proj && CUDA_VISIBLE_DEVICES=0 nohup python whisper_vf/train.py --epochs 16 > logs/reg2.log 2>&1 & sleep 10; tail -5 logs/reg2.log');
  assert.equal(both?.key, 'train.py');
  assert.equal(both?.log, 'logs/reg2.log');
  assert.equal(W.backgroundLaunch('kill 1234'), undefined);
  assert.equal(W.backgroundLaunch('npm test && npm run build'), undefined);
  assert.equal(W.backgroundLaunch('ls 2>&1 | head'), undefined);
  assert.equal(W.pidFromOutput('started\n12345\n'), 12345);
});

test('讀檔指令算讀檔；輪詢指令認得出來', () => {
  assert.equal(W.fileReadOf('cat src/app.ts'), 'src/app.ts');
  assert.equal(W.fileReadOf('cd "/home/x/proj" && sed -n 1,80p train.py'), 'train.py');
  assert.equal(W.fileReadOf('head -n 50 README.md'), 'README.md');
  assert.equal(W.fileReadOf('cat a.ts b.ts'), undefined);
  assert.equal(W.fileReadOf('cat log | grep x'), undefined);
  assert.ok(W.POLLING.test('until [ -f runs/x/final.json ]; do sleep 60; done'));
  assert.ok(W.POLLING.test('sleep 300 && tail -5 train.log'));
  assert.ok(!W.POLLING.test('python train.py'));
});

const ev = (ts, category, title, output, status = 'ok') => ({ seq: ts, ts, kind: 'tool', tool: { id: `t${ts}`, name: category, category, title, output, status } });
function sharedRun(cwd) {
  const a1 = { id: 'aaaaaaaa-111', role: 'executor', provider: 'claude', status: 'completed', depth: 0, startedAt: 1, endedAt: 50, stats: {} };
  const a2 = { id: 'bbbbbbbb-222', role: 'code_reviewer', provider: 'codex', status: 'running', depth: 0, startedAt: 60, stats: {} };
  const run = { id: 'r', config: { cwd, goal: 'g' }, agents: { [a1.id]: a1, [a2.id]: a2 }, stages: { plan: { rounds: [] }, implement: { rounds: [] }, verify: { rounds: [] } }, notes: [] };
  const events = {
    [a1.id]: [
      ev(10, 'command', 'cat src/model.py', 'class Model:\n    def forward(self): ...'),
      ev(20, 'command', 'pytest -q', 'FAILED tests/test_a.py::test_x - AssertionError\n' + 'x\n'.repeat(50) + '1 failed, 20 passed'),
      ev(30, 'command', 'ls data', 'a.wav\nb.wav'),
      ev(40, 'edit', 'src/model.py', '', 'ok'),
    ],
    [a2.id]: [],
  };
  return { run, a1, a2, eventsOf: (id) => events[id] ?? [] };
}

test('共用上下文：讀過的檔案附內容、測試保留失敗細節、改過的檔案標出來', () => {
  const { run, a2, eventsOf } = sharedRun(os.tmpdir());
  const text = W.contextBlock(run, a2, eventsOf, { maxChars: 200000 });
  assert.match(text, /FILES OTHER AGENTS ALREADY READ/);
  assert.match(text, /src\/model\.py[^\n]*CHANGED since/);
  assert.match(text, /pytest -q[\s\S]*FAILED tests\/test_a\.py::test_x[\s\S]*1 failed, 20 passed/);
  assert.match(text, /ls data/);
});

test('共用上下文：放不下時目標與狀態留在最前面，較舊的內容先省略', () => {
  const { run, a2, eventsOf } = sharedRun(os.tmpdir());
  run.plan = { summary: 's', markdown: 'm', steps: [], goal: { statement: 'WER below 0.30', metrics: [{ id: 'M1', name: 'wer', target: '<0.30', how: 'eval' }] } };
  for (let i = 0; i < 400; i++) run.notes.push({ id: `n${i}`, agentId: 'aaaaaaaa-111', text: `note number ${i} ${'x'.repeat(80)}`, kind: 'fact', ts: 100 + i });
  const text = W.contextBlock(run, a2, eventsOf, { maxChars: 12000 });
  assert.ok(text.length <= 12000 + 200, `length ${text.length}`);
  assert.match(text, /Goal that must be met: WER below 0\.30/);
  assert.match(text, /note number 399/);
  assert.doesNotMatch(text, /note number 0 /);
  assert.match(text, /older item\(s\) left out/);
});

test('紀錄搜尋：多個關鍵字不分順序；筆記排在原始輸出前面', () => {
  const { run, eventsOf } = sharedRun(os.tmpdir());
  run.notes.push({ id: 'n1', agentId: 'aaaaaaaa-111', text: 'The forward pass of Model lives in src/model.py', kind: 'fact', ts: 5 });
  const hits = W.searchRecords(run, eventsOf, { q: 'model forward' });
  assert.ok(hits.length >= 2, JSON.stringify(hits));
  assert.equal(hits[0].kind, 'note:fact');
  assert.ok(hits.some((h) => h.kind.startsWith('tool:')));
  // No record has every word: the closest ones still come back.
  assert.ok(W.searchRecords(run, eventsOf, { q: 'forward nonexistentword' }).length >= 1);
  assert.equal(W.searchRecords(run, eventsOf, { q: 'zzz qqq' }).length, 0);
});

test('CLI 自己壓縮後：交還它自己讀過的檔案、跑過的指令與回報', () => {
  const { run, a1, eventsOf } = sharedRun(os.tmpdir());
  const text = W.ownWorkBlock(run, eventsOf, new Set([a1.id]), ['dataset lives in /data/aishell'], 20000);
  assert.match(text, /YOUR OWN WORK BEFORE YOUR CONVERSATION WAS COMPACTED/);
  assert.match(text, /dataset lives in \/data\/aishell/);
  assert.match(text, /Files you read:[\s\S]*src\/model\.py/);
  assert.match(text, /Commands you ran:[\s\S]*pytest -q/);
});

test('主題索引：同一個檔案的讀取、修改、提到它的筆記歸在一起；指令與筆記類型也各成主題', () => {
  const { run, eventsOf } = sharedRun(os.tmpdir());
  run.notes.push({ id: 'n1', agentId: 'aaaaaaaa-111', text: 'src/model.py: forward() skips the mask', kind: 'fact', ts: 45 });
  run.notes.push({ id: 'n2', agentId: 'aaaaaaaa-111', text: 'Use 16 kHz audio', kind: 'decision', ts: 46 });
  const topics = W.buildTopics(run, eventsOf);
  const file = topics.get('file:src/model.py');
  assert.deepEqual(file.items.map((i) => i.what), ['read', 'changed', 'note (fact)']);
  assert.ok(topics.get('command:pytest -q'));
  assert.equal(topics.get('decisions').items.length, 1);
  const detail = W.topicDetail(run, topics, 'model.py');
  assert.match(detail, /TOPIC file:src\/model\.py[\s\S]*read:[\s\S]*class Model[\s\S]*changed[\s\S]*skips the mask/);
  assert.match(W.topicDetail(run, topics, 'command:pytest'), /1 failed, 20 passed/);
  assert.match(W.topicDetail(run, topics, 'nothing-like-this'), /No topic matches/);
  const index = W.topicIndexBlock(topics, 4000);
  assert.match(index, /SHARED RECORDS BY TOPIC: 1 files, 2 commands[\s\S]*1 facts, 1 decisions/);
  assert.match(W.topicList(topics), /FILES:[\s\S]*file:src\/model\.py/);
  // The shared context carries the table of contents.
  assert.match(W.contextBlock(run, run.agents['bbbbbbbb-222'], eventsOf, { maxChars: 100000 }), /SHARED RECORDS BY TOPIC/);
});

test('wait_for 的檢查指令：依語法選 shell（Windows 預設 Git Bash），指令本身壞掉會直接回報', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-wait-'));
  fs.writeFileSync(path.join(dir, 'train.log'), 'epoch 16\n[done] exp/best.pt\n');
  const rm = new W.ResourceManager(dir);
  const win = process.platform === 'win32';
  const posix = win ? (W.findGitBash() ? 'bash' : 'powershell') : 'sh';
  assert.equal(W.checkShell("grep -q '^\\[done\\]' train.log"), posix);
  assert.equal(W.checkShell('[ $(wc -l < train.log) -ge 2 ]'), posix);
  assert.equal(W.checkShell('Test-Path train.log'), 'powershell');
  assert.equal(W.checkShell('anything', 'powershell'), 'powershell');
  if (win) assert.equal(W.checkShell('if exist train.log exit 0'), 'cmd');
  const run = (check, shell) => rm.check(rm.newWait('a', { check, shell }), dir);
  // The command from the measured run: bash quoting, which cmd.exe used to break.
  assert.equal((await run("grep -q '^\\[done\\]' train.log")).ok, true);
  assert.equal((await run("grep -q '^\\[nope\\]' train.log")).ok, false);
  if (win || fs.existsSync('/usr/bin/pwsh')) {
    assert.equal((await run('Test-Path train.log')).ok, true);
    // PowerShell prints False and still exits 0.
    assert.equal((await run('Test-Path missing.txt')).ok, false);
  }
  if (win) assert.equal((await run('if exist train.log (exit 0) else (exit 1)')).ok, true);
  // A check that can never run: reported at once instead of waiting until the timeout.
  const bad = await run('if then fi (');
  assert.equal(bad.ok, false);
  assert.equal(bad.broken, true, bad.output);
});

test('交接：下一個 agent 拿到前一個自己寫的交接，不是它的原始對話', () => {
  const { run, a1, a2, eventsOf } = sharedRun(os.tmpdir());
  run.config.contextSharing = 'full';
  a1.handover = { text: 'Fixed the mask in src/model.py; test_x still fails on padding, look at collate() next.', ts: 55 };
  const text = W.contextBlock(run, a2, eventsOf, { maxChars: 200000 });
  assert.match(text, /HAND-OFF TO YOU[\s\S]*THE AGENT BEFORE YOU — aaaaaaaa-111 — implementer[^\n]*its own account, to check[\s\S]*look at collate\(\) next/);
  assert.match(text, /read_context \{agent_id: "aaaaaaaa-111"\}/);
  assert.doesNotMatch(text, /FULL TRANSCRIPT/);
  // The directory still names it, but points at the hand-off instead of repeating it.
  assert.match(text, /Agents so far[^\n]*:\n- aaaaaaaa-111 — implementer[^\n]*\n  hand-off: in HAND-OFF TO YOU above/);
  assert.equal(text.split('Fixed the mask in src/model.py').length - 1, 1, 'the hand-off text appears once');
});

test('交接：沒寫交接時 Aivenue 用它的結果與最後的指令湊一份，不另外呼叫模型', () => {
  const { run, a1, a2, eventsOf } = sharedRun(os.tmpdir());
  a1.status = 'failed';
  a1.error = 'CLI exited 1';
  a1.stats = { filesChanged: ['src/model.py'] };
  const h = W.handoverOf(run, a1, eventsOf(a1.id));
  assert.equal(h.auto, true);
  assert.match(h.text, /ended with an error: CLI exited 1[\s\S]*Files it changed: src\/model\.py[\s\S]*pytest -q → ok/);
  assert.match(W.contextBlock(run, a2, eventsOf, { maxChars: 200000 }), /it wrote no hand-off; Aivenue put this together from what it did/);
});

test('共用筆記：交接筆記不重複出現；上一則訊息的筆記只帶決策與使用者指示', () => {
  const { run, a2, eventsOf } = sharedRun(os.tmpdir());
  run.notes.push(
    { id: 'h1', agentId: 'aaaaaaaa-111', text: 'HAND-OFF (implement stage, round 1, implementer): all done', kind: 'fact', ts: 51 },
    { id: 'c1', agentId: 'old', text: 'epoch 12 reached loss 0.4', kind: 'fact', ts: 5, carried: true },
    { id: 'c2', agentId: 'old', text: 'Use 16 kHz audio everywhere', kind: 'decision', ts: 6, carried: true },
    { id: 'c3', agentId: 'old', text: '使用者指示：套件裝在 Pytorch 環境', kind: 'fact', ts: 7, carried: true },
    { id: 'n9', agentId: 'aaaaaaaa-111', text: 'fresh fact of this message', kind: 'fact', ts: 52 },
  );
  const text = W.contextBlock(run, a2, eventsOf, { maxChars: 200000 });
  const notes = text.slice(text.indexOf('Shared notes'));
  assert.doesNotMatch(notes.split('\nAgents')[0], /HAND-OFF \(implement/);
  assert.doesNotMatch(text, /epoch 12 reached/);
  assert.match(text, /Use 16 kHz audio/);
  assert.match(text, /套件裝在 Pytorch 環境/);
  assert.match(text, /fresh fact of this message/);
  assert.match(text, /1 more notes from earlier messages/);
});

test('讀別人的對話：工具參數不帶 JSON 外殼、重複呼叫合併、可只看訊息或指令、可分頁', () => {
  const tool = (ts, title, input, output) => ({ seq: ts, ts, kind: 'tool', tool: { id: 't' + ts, name: 'bash', category: 'command', title, input, output, status: 'ok' } });
  const events = [
    { seq: 1, ts: 1, kind: 'message', text: 'I will check the log' },
    tool(2, 'tail -5 train.log', JSON.stringify({ command: 'tail -5 train.log', description: 'Show the end of the log' }), 'epoch 3'),
    tool(3, 'tail -5 train.log', JSON.stringify({ command: 'tail -5 train.log', description: 'Show the end of the log' }), 'epoch 3'),
    tool(4, 'tail -5 train.log', JSON.stringify({ command: 'tail -5 train.log', description: 'Show the end of the log' }), 'epoch 3'),
    { seq: 5, ts: 5, kind: 'result', text: 'Training is at epoch 3' },
  ];
  const all = W.formatTranscript(events, { budget: 40000 });
  assert.doesNotMatch(all, /"command"/);
  assert.match(all, /input: description: Show the end of the log/);
  assert.match(all, /same call again ×2/);
  assert.equal((all.match(/\[Tool bash\]/g) ?? []).length, 1);
  assert.doesNotMatch(W.formatTranscript(events, { budget: 40000, part: 'messages' }), /\[Tool/);
  assert.doesNotMatch(W.formatTranscript(events, { budget: 40000, part: 'tools' }), /\[Agent\]/);
  const long = Array.from({ length: 30 }, (_, i) => ({ seq: i, ts: i, kind: 'message', text: `message ${i} ${'y'.repeat(200)}` }));
  const p1 = W.formatTranscript(long, { budget: 2000 });
  const p2 = W.formatTranscript(long, { budget: 2000, page: 2 });
  assert.match(p1, /page 1 of \d+; page 2 for the part before this[\s\S]*message 29/);
  assert.doesNotMatch(p2, /message 29/);
  assert.match(W.formatTranscript(long, { budget: 2000, page: 99 }), /there are only \d+ pages/);
});

test('產生的檔案：同一個資料夾大量變動合併成一列，記檔案數與總大小', () => {
  const files = [
    ...Array.from({ length: 300 }, (_, i) => ({ path: `data/train/${i}.npy`, abs: '', status: 'added', size: 10 })),
    ...Array.from({ length: 3 }, (_, i) => ({ path: `src/f${i}.py`, abs: '', status: 'modified', size: 1 })),
  ];
  const out = W.groupFolders('/proj', files);
  assert.equal(out.length, 4);
  const g = out.find((f) => f.count);
  assert.equal(g.path, 'data/train/');
  assert.equal(g.count, 300);
  assert.equal(g.size, 3000);
});

test('交接：agent 寫的交接不限長度，完整交給下一個 agent', () => {
  const { run, a1, a2, eventsOf } = sharedRun(os.tmpdir());
  const long = 'detail '.repeat(5000) + 'THE-LAST-LINE';
  a1.handover = { text: long, ts: 55 };
  assert.match(W.contextBlock(run, a2, eventsOf, { maxChars: 200000 }), /THE-LAST-LINE/);
});

test('Codex 沒指定模型時：從它的對話紀錄讀出實際用的模型（最新一輪的 turn_context）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const dir = path.join(home, 'sessions', '2026', '10', '31');
  fs.mkdirSync(dir, { recursive: true });
  const tid = '01a18c40-f070-7170-a305-0132299ac492';
  const line = (type, payload) => JSON.stringify({ type, payload });
  fs.writeFileSync(
    path.join(dir, `rollout-2026-10-31T10-00-00-${tid}.jsonl`),
    [
      line('turn_context', { model: 'gpt-6.0', effort: 'low' }),
      line('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 1000 }, model_context_window: 400000 } }),
      line('turn_context', { model: 'gpt-6.1-sol', effort: 'medium' }),
      line('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 28800 }, model_context_window: 475000 } }),
    ].join('\n') + '\n',
  );
  const spec = { id: 'codex~work', name: 'Codex', command: 'codex', run: { args: [] }, output: 'codex-jsonl', accounts: { env: 'CODEX_HOME', home: '~/.codex' }, accountOf: 'codex', accountHome: home };
  assert.deepEqual(W.codexContext(spec, tid), { used: 28800, window: 475000, model: 'gpt-6.1-sol' });
});

// ---------- 階段 A：成本可解釋（docs/workflow-efficiency-plan.md A1／A2，只觀測、不改行為） ----------

/** contextBlock with its measure; also checks the kept pieces join back into exactly the text returned. */
function measured(run, self, eventsOf, maxChars) {
  const plain = W.contextBlock(run, self, eventsOf, { maxChars });
  const m = { kept: [], cut: [] };
  const text = W.contextBlock(run, self, eventsOf, { maxChars, measure: m });
  return { plain, text, m };
}

test('A1：共享上下文要各區塊時文字完全不變；各區塊接起來正好是送出的文字', () => {
  const { run, a2, eventsOf } = sharedRun(os.tmpdir());
  const { plain, text, m } = measured(run, a2, eventsOf, 200000);
  assert.equal(text, plain);
  assert.equal(m.kept.map((p) => p.text).join(''), text);
  assert.deepEqual(m.cut, []);
  assert.ok(m.kept.some((p) => p.key === 'activity'));
});

test('A1：共享上下文被截斷時，只統計實際送出的部分；截掉的另外列出', () => {
  const { run, a2, eventsOf } = sharedRun(os.tmpdir());
  for (let i = 0; i < 400; i++) run.notes.push({ id: `n${i}`, agentId: 'aaaaaaaa-111', text: `note number ${i} ${'x'.repeat(80)}`, kind: 'fact', ts: 100 + i });
  const { plain, text, m } = measured(run, a2, eventsOf, 3000);
  assert.equal(text, plain);
  assert.equal(m.kept.map((p) => p.text).join(''), text);
  const turn = W.promptTurn([{ key: 'shared', text, parts: m.kept, cut: m.cut }], false, 1);
  assert.equal(turn.chars, text.length);
  assert.ok(turn.cut.length > 0 && turn.cut.every((c) => c.chars > 0));
  assert.ok(turn.cut.reduce((n, c) => n + c.chars, 0) > 0);
});

test('A1：每個區塊用自己的文字估算 token（中文與英文不同），整輪是各區塊的和', () => {
  const zh = '中'.repeat(100);
  const en = 'a'.repeat(100);
  const turn = W.promptTurn([{ key: 'shared', text: zh + en, parts: [{ key: 'notes', text: zh }, { key: 'log', text: en }] }], false, 1);
  const by = Object.fromEntries(turn.blocks.map((b) => [b.key, b.tokens]));
  assert.equal(by['shared.notes'], 100);
  assert.equal(by['shared.log'], 25);
  assert.equal(turn.tokens, 125);
  // 區塊加總不等於文字時不信任拆分，整組算一塊
  const bad = W.promptTurn([{ key: 'shared', text: zh + en, parts: [{ key: 'notes', text: zh }] }], false, 1);
  assert.deepEqual(bad.blocks.map((b) => b.key), ['shared']);
  // 長度相同、但順序或內容不同：同樣不信任
  const swapped = W.promptTurn([{ key: 'shared', text: zh + en, parts: [{ key: 'log', text: en }, { key: 'notes', text: zh }] }], false, 1);
  assert.deepEqual(swapped.blocks.map((b) => b.key), ['shared']);
  const other = W.promptTurn([{ key: 'shared', text: zh + en, parts: [{ key: 'notes', text: '文'.repeat(100) }, { key: 'log', text: en }] }], false, 1);
  assert.deepEqual(other.blocks.map((b) => b.key), ['shared']);
});

test('A1：角色 prompt 依段落切開，接起來正好是整份；任務文字精確比對', () => {
  const cfg = { cwd: '/w', goal: 'Fix the parser.\nPLAN: this line is part of the goal' };
  const plan = { summary: 's', markdown: 'Do A then B', steps: [{ id: '1', title: 'A' }], goal: { statement: 'tests pass', metrics: [{ id: 'M1', name: 't', target: 'pass', how: 'npm test' }] } };
  const prompt = W.P.codeReviewPrompt(cfg, plan, 'I changed the parser', ' M src/a.ts', 2, { review: { verdict: 'revise', summary: 'x', issues: [{ id: 'R1', severity: 'major', title: 'bug' }] }, responses: [] });
  const pieces = W.roleParts(prompt, cfg.goal);
  assert.equal(pieces.map((p) => p.text).join(''), prompt);
  assert.equal(pieces.find((p) => p.key === 'goal').text, `GOAL:\n${cfg.goal}`);
  for (const k of ['plan', 'priorReview', 'workSummary', 'changedFiles', 'instructions']) assert.ok(pieces.some((p) => p.key === k), k);
  const turn = W.promptTurn([{ key: 'role', text: prompt, parts: pieces }, { key: 'rules', text: 'abc' }, { key: 'skills', text: '' }], false, 1);
  assert.equal(turn.chars, prompt.length + 3);
  assert.equal(turn.blocks.reduce((a, b) => a + b.chars, 0), turn.chars);
  assert.ok(!turn.blocks.some((b) => b.key === 'skills'));
});

test('A1：超過 40 輪時，逐輪明細只留最近的，但全程統計不漏', () => {
  let totals;
  for (let i = 0; i < 45; i++) totals = W.addTurn(totals, W.promptTurn([{ key: 'role', text: 'x'.repeat(40) }], i > 0, i));
  assert.equal(totals.turns, 45);
  assert.equal(totals.chars, 45 * 40);
  assert.equal(totals.blocks.role.turns, 45);
  const agent = { id: 'a', role: 'executor', stage: 'implement', task: '', startedAt: 1, endedAt: 2, stats: {}, promptTurns: [], promptTotals: totals };
  const c = W.costBreakdown({ id: 'r', createdAt: 0, endedAt: 10, agents: { a: agent } }, 10);
  assert.equal(c.turns, 45);
  assert.equal(c.rows[0].promptTokens, totals.tokens);
});

/** Feed a parser some lines; return what it emitted. */
function parse(format, lines) {
  const out = [];
  const p = W.createParser(format, { emit: (e) => (out.push(e), out.length), updateTool: () => undefined }, '/w');
  for (const l of lines) p.line(JSON.stringify(l));
  p.end?.();
  return out.filter((e) => e.usage).map((e) => e.usage);
}

test('A2：各家用量保留原始欄位，換算成同一口徑；既有欄位的數字不變', () => {
  const [claude] = parse('claude-stream', [{ type: 'result', subtype: 'success', result: 'ok', session_id: 's', total_cost_usd: 0.02, usage: { input_tokens: 100, cache_creation_input_tokens: 40, cache_read_input_tokens: 500, output_tokens: 70 } }]);
  assert.deepEqual([claude.input, claude.output, claude.cached, claude.costUsd], [140, 70, 500, 0.02]);
  assert.deepEqual(claude.observed, { uncachedInput: 140, cachedInput: 500, output: 70, cacheWrite: 40, splitKnown: true });
  assert.equal(claude.raw.cache_read_input_tokens, 500);

  const [codex] = parse('codex-jsonl', [{ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 90, reasoning_output_tokens: 30 } }]);
  assert.deepEqual([codex.input, codex.output, codex.cached], [400, 90, 600]);
  assert.deepEqual(codex.observed, { uncachedInput: 400, cachedInput: 600, output: 90, reasoning: 30, splitKnown: true });
  assert.equal(codex.raw.input_tokens, 1000);

  const [oc] = parse('opencode-json', [{ type: 'step_finish', part: { cost: 0, tokens: { input: 50, output: 20, reasoning: 5, cache: { read: 300, write: 10 } } } }]);
  assert.deepEqual([oc.input, oc.output, oc.cached, oc.costUsd], [50, 25, 300, 0]);
  assert.deepEqual(oc.observed, { uncachedInput: 60, cachedInput: 300, output: 25, reasoning: 5, cacheWrite: 10, splitKnown: true });
  assert.equal(oc.raw['cache.write'], 10);

  const [gem] = parse('gemini-stream', [{ type: 'result', status: 'success', stats: { input_tokens: 800, output_tokens: 40, cached: 300 } }]);
  assert.deepEqual([gem.input, gem.output, gem.cached], [800, 40, 300]);
  assert.deepEqual(gem.observed, { reportedInput: 800, reportedCached: 300, output: 40, splitKnown: false });
});

test('A2：拆分不明的輸入不放進「未快取／快取」兩欄，另列；價格不明不當成 0', () => {
  let t = W.addObserved(undefined, { input: 10, output: 5, cached: 0, costUsd: 0.01, observed: { uncachedInput: 10, cachedInput: 0, output: 5, splitKnown: true } });
  assert.equal(t.costUsd, 0.01);
  t = W.addObserved(t, { input: 800, output: 40, cached: 300, observed: { reportedInput: 800, reportedCached: 300, output: 40, splitKnown: false } });
  t = W.addObserved(t, { input: 7, output: 3, cached: 2 });
  assert.deepEqual([t.uncachedInput, t.cachedInput], [10, 0]);
  assert.deepEqual(t.unsplit, { input: 807, cached: 302 });
  assert.equal(t.splitUnknown, true);
  assert.equal(t.costUnknown, true);
  assert.equal(t.costUsd, undefined);
  assert.deepEqual([t.output, t.events], [48, 3]);
});

test('A2：成本分解依角色與階段、壓縮與整理筆記另列；三種時間分開；等待時間另計', () => {
  const totals = (tokens) => ({ turns: 1, chars: 400, tokens, blocks: { 'shared.log': { chars: 300, tokens: tokens * 0.75, turns: 1 }, 'role.plan': { chars: 100, tokens: tokens * 0.25, turns: 1 } }, cut: { 'shared.notes': 50 } });
  const ag = (id, role, stage, startedAt, endedAt, cost, task = '') => ({ id, role, stage, task, startedAt, endedAt, stats: {}, observed: { uncachedInput: 100, cachedInput: 50, output: 10, events: 1, costUsd: cost, costUnknown: cost === undefined }, promptTotals: totals(100) });
  const run = {
    id: 'r', createdAt: 0, endedAt: 10000, status: 'completed',
    agents: {
      a: ag('a', 'executor', 'implement', 1, 6001, 0.1),
      b: ag('b', 'code_reviewer', 'implement', 1000, 5000, undefined),
      c: ag('c', 'compactor', undefined, 6000, 7000, 0, '整理 30 則共用筆記'),
      d: ag('d', 'compactor', undefined, 7000, 8000, 0, '壓縮共享上下文'),
    },
    timing: { waitingMs: 1500 },
  };
  const c = W.costBreakdown(run, 20000);
  assert.equal(c.wallMs, 10000);
  assert.equal(c.agentMs, 6000 + 4000 + 1000 + 1000);
  assert.equal(c.waitingMs, 1500);
  assert.deepEqual(c.rows.map((r) => r.key).sort(), ['code_reviewer@implement', 'compaction', 'executor@implement', 'librarian']);
  assert.equal(c.total.costUnknown, true);
  assert.equal(c.blocks[0].key, 'shared.log');
  assert.equal(c.blocks[0].tokens, 300);
  assert.deepEqual(c.cut, [{ key: 'shared.notes', chars: 200 }]);

  const live = { status: 'running', timing: undefined };
  W.trackWaiting(live, 100);
  live.status = 'waiting_human';
  W.trackWaiting(live, 200);
  live.status = 'running';
  W.trackWaiting(live, 700);
  assert.equal(live.timing.waitingMs, 500);
});

test('啟動 agent CLI 時，PWD 與 INIT_CWD 指向它的工作資料夾，不沿用 Aivenue 啟動時的位置', () => {
  const before = { PWD: process.env.PWD, OLDPWD: process.env.OLDPWD };
  process.env.PWD = '/somewhere/else';
  process.env.OLDPWD = '/older';
  try {
    const env = W.cliEnv('C:/work/repo', { EXTRA: '1' });
    assert.equal(env.PWD, 'C:/work/repo');
    assert.equal(env.INIT_CWD, 'C:/work/repo');
    assert.equal(env.EXTRA, '1');
    assert.equal('OLDPWD' in env, false);
  } finally {
    for (const [k, v] of Object.entries(before)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});

// ---------- B：可選的標準模式（不呼叫模型） ----------

/** 目前新對話的預設角色配置（RoleSettings.tsx defaultDraft 的形狀），加上會被模式改掉的殘值。 */
const heavyDraft = () => ({
  cwd: 'C:/work/repo',
  plan: { enabled: true, author: { provider: 'claude' }, reviewer: { provider: 'codex' }, maxRounds: 3, humanGate: true },
  implement: { enabled: true, author: { provider: 'claude' }, reviewer: { provider: 'codex' }, maxRounds: 3, humanGate: true },
  subagents: { enabled: true, allowed: ['claude', 'codex'], maxDepth: 1, maxConcurrent: 2 },
  verify: { enabled: true, by: 'independent', verifier: { provider: 'gemini' }, repeatLimit: 3 },
  assignment: { mode: 'manual', auto: { priority: 'balanced', crossReview: true, failover: true } },
});

test('標準模式：完整設定每個角色欄位，不沿用上次的殘值', () => {
  const d = heavyDraft();
  const s = W.applyStandard(d);
  assert.equal(s.flow, 'standard');
  assert.equal(s.plan.enabled, false);
  assert.equal(s.plan.humanGate, false);
  // 計畫階段只是關掉，角色留著，之後重新開啟會回來。
  assert.deepEqual(s.plan.author, { provider: 'claude' });
  assert.deepEqual(s.plan.reviewer, { provider: 'codex' });
  assert.equal(s.implement.enabled, true);
  assert.deepEqual(s.implement.reviewer, { provider: 'codex' }, '保留程式審查');
  assert.equal(s.implement.maxRounds, W.STANDARD_ROUNDS);
  assert.equal(W.STANDARD_ROUNDS, 2);
  assert.equal(s.implement.humanGate, false);
  assert.equal(s.verify.enabled, false);
  assert.equal(s.subagents.enabled, false);
  // 和角色配置無關的設定不動；原本的物件也不被改到。
  assert.equal(s.cwd, d.cwd);
  assert.deepEqual(s.assignment, d.assignment);
  assert.deepEqual(d, heavyDraft());
  assert.equal(W.flowModeOf(s), 'standard');
});

test('標準模式：原本沒有審查者時，補上另一家（或計畫審查者、或實作者自己），程式審查一定保留', () => {
  const none = { ...heavyDraft(), implement: { ...heavyDraft().implement, reviewer: null } };
  assert.deepEqual(W.applyStandard(none, { provider: 'gemini' }).implement.reviewer, { provider: 'gemini' });
  assert.deepEqual(W.applyStandard(none).implement.reviewer, { provider: 'codex' });
  const alone = { ...none, plan: { ...none.plan, reviewer: null } };
  assert.deepEqual(W.applyStandard(alone).implement.reviewer, { provider: 'claude' });
  // 沒有驗收設定時不憑空加一個。
  const { verify: _v, ...noVerify } = heavyDraft();
  assert.equal(W.applyStandard(noVerify).verify, undefined);
});

test('標準模式：改掉任何角色配置就變成「自訂」；既有設定沒有模式標記，維持自訂且不被改動', () => {
  const s = W.applyStandard(heavyDraft());
  for (const changed of [
    { ...s, plan: { ...s.plan, enabled: true } },
    { ...s, implement: { ...s.implement, reviewer: null } },
    { ...s, implement: { ...s.implement, maxRounds: 3 } },
    { ...s, implement: { ...s.implement, humanGate: true } },
    { ...s, verify: { ...s.verify, enabled: true } },
    { ...s, subagents: { ...s.subagents, enabled: true } },
  ]) {
    assert.equal(W.flowModeOf(changed), 'custom');
    const kept = W.keepFlowMark(changed);
    assert.equal('flow' in kept, false, '殘留的模式標記要拿掉');
    assert.equal(W.flowModeOf(kept), 'custom');
  }
  // 換人不換配置：仍是標準。
  const other = W.keepFlowMark({ ...s, implement: { ...s.implement, author: { provider: 'codex' }, reviewer: { provider: 'claude' } } });
  assert.equal(W.flowModeOf(other), 'standard');
  // 已存的設定（沒有標記），即使配置剛好一樣，也不會被當成標準模式。
  const { flow: _f, ...saved } = s;
  assert.equal(W.flowModeOf(saved), 'custom');
  assert.equal(W.keepFlowMark(saved), saved);
  assert.equal(W.flowModeOf(heavyDraft()), 'custom');
});

test('標準模式的實作 prompt 要求先寫幾行計畫；其他配置的 prompt 一字不差', () => {
  const base = { ...heavyDraft(), title: 't', goal: 'add a flag' };
  const line = 'There is no planning stage in this workflow. Before you change any file, write a short plan of your own';
  const std = W.applyStandard(base);
  assert.ok(W.P.implementPrompt(std, undefined, '').includes(line));
  // 同樣的配置但沒有模式標記（使用者自己關掉計畫）：不加這句，和加入模式前完全相同。
  const { flow: _f, ...custom } = std;
  const plain = W.P.implementPrompt(custom, undefined, '');
  assert.ok(!plain.includes(line));
  const lines = W.P.implementPrompt(std, undefined, '').split('\n');
  assert.equal(lines.filter((l) => !l.startsWith('There is no planning stage')).join('\n'), plain);
  // 有核准計畫時不加。
  const plan = { summary: 's', markdown: 'm', steps: [{ id: '1', title: 'x', status: 'pending' }] };
  assert.ok(!W.P.implementPrompt(std, plan, '').includes(line));
});

// ---------- 新對話設定的載入順序（packages/ui/src/draftInit.ts） ----------

/** 依序回應的設定讀取：每次呼叫取下一個結果（Error 代表讀取失敗）。 */
function drafts(results) {
  const log = { set: [], errors: [], reads: 0 };
  const init = W.draftInit({
    read: async () => {
      const r = results[log.reads++];
      if (r instanceof Error) throw r;
      return r;
    },
    makeDefault: () => ({ name: 'default' }),
    set: (d, from) => log.set.push([d.name, from]),
    fail: (why) => why !== null && log.errors.push(why),
  });
  return { init, log };
}

test('設定載入：供應商先回來 → 讀取失敗 → 重連後讀到已存的標準模式，不會被預設值取代', async () => {
  const saved = { name: 'saved-standard', flow: 'standard' };
  const { init, log } = drafts([new Error('connection closed'), { draft: saved }]);
  await init.start(); // 供應商與 host 已知，先讀設定：失敗
  assert.deepEqual(log.set, [], '讀取失敗不等於沒有存檔，不建立預設值');
  assert.deepEqual(log.errors, ['connection closed']);
  assert.equal(init.done, false);
  await init.retry(); // 重新連線
  assert.deepEqual(log.set, [['saved-standard', 'saved']]);
  assert.equal(init.done, true);
  // 之後再收到任何東西都不會換掉已採用的設定。
  init.saved({ name: 'other' });
  await init.retry();
  assert.deepEqual(log.set, [['saved-standard', 'saved']]);
  assert.equal(log.reads, 2);
});

test('設定載入：只有成功讀到且確認沒有 draft 時才用預設值；回傳不是設定物件也算失敗', async () => {
  const none = drafts([{ locale: 'zh-TW' }]);
  await none.init.start();
  assert.deepEqual(none.log.set, [['default', 'default']]);
  const odd = drafts([undefined, null, { draft: { name: 'kept' } }]);
  await odd.init.start();
  await odd.init.retry();
  assert.deepEqual(odd.log.set, []);
  assert.equal(odd.log.errors.length, 2);
  await odd.init.retry();
  assert.deepEqual(odd.log.set, [['kept', 'saved']]);
});

test('設定載入：讀取失敗期間另外收到已存的設定就採用；供應商還沒回來前不讀', async () => {
  const { init, log } = drafts([new Error('timeout')]);
  await init.retry(); // 還沒 start：不讀
  assert.equal(log.reads, 0);
  await init.start();
  assert.deepEqual(log.errors, ['timeout']);
  init.saved(undefined); // 推送來的設定沒有 draft：不能因此建立預設值
  assert.deepEqual(log.set, []);
  init.saved({ name: 'pushed' });
  assert.deepEqual(log.set, [['pushed', 'saved']]);
});

test('設定載入：較舊的讀取晚回來且沒有 draft，不會搶先建立預設值；採用較新讀取的已存設定', async () => {
  const pending = [];
  const log = { set: [], errors: [] };
  const init = W.draftInit({
    read: () => new Promise((resolve) => pending.push(resolve)),
    makeDefault: () => ({ name: 'default' }),
    set: (d, from) => log.set.push([d.name, from]),
    fail: (why) => why !== null && log.errors.push(why),
  });
  const first = init.start(); // 第一次讀取還沒回覆
  const second = init.retry(); // 重試（例如重新連線）
  assert.equal(pending.length, 2);
  pending[0]({ locale: 'zh-TW' }); // 舊請求先回：沒有 draft
  await first;
  assert.deepEqual(log.set, [], '過期的讀取結果不採用');
  pending[1]({ draft: { name: 'saved-standard', flow: 'standard' } }); // 新請求回：已存的標準模式
  await second;
  assert.deepEqual(log.set, [['saved-standard', 'saved']]);
  assert.deepEqual(log.errors, []);
});

test('設定載入：較舊的讀取晚回來帶著 draft 也不採用，以最新一次為準', async () => {
  const pending = [];
  const log = [];
  const init = W.draftInit({ read: () => new Promise((resolve) => pending.push(resolve)), makeDefault: () => ({ name: 'default' }), set: (d, from) => log.push([d.name, from]), fail: () => undefined });
  const a = init.start();
  const b = init.retry();
  pending[0]({ draft: { name: 'older' } });
  await a;
  assert.deepEqual(log, []);
  pending[1]({ draft: { name: 'newer' } });
  await b;
  assert.deepEqual(log, [['newer', 'saved']]);
});

// ---------- C：prompt 裡的對話紀錄不重複同一個 prompt 已有的工具呼叫 ----------

function logRun(cwd) {
  const a1 = { id: 'aaaaaaaa-111', role: 'executor', provider: 'claude', status: 'completed', depth: 0, stage: 'implement', round: 1, startedAt: 1, endedAt: 50, stats: {}, summary: 'fixed the parser' };
  const a2 = { id: 'bbbbbbbb-222', role: 'code_reviewer', provider: 'codex', status: 'running', depth: 0, stage: 'implement', round: 1, startedAt: 60, stats: {} };
  const run = {
    id: 'r', config: { cwd, goal: 'g' }, agents: { [a1.id]: a1, [a2.id]: a2 }, stages: { plan: { rounds: [] }, implement: { rounds: [] }, verify: { rounds: [] } },
    notes: [{ id: 'n1', agentId: 'aaaaaaaa-111', text: 'keep the public API of parseDuration', kind: 'decision', ts: 25 }],
    userMessages: [{ ts: 35, text: 'Please do not touch formatDuration.' }],
  };
  const tool = (ts, category, name, title, status = 'ok', output = 'done') => ({ seq: ts, ts, kind: 'tool', tool: { id: `t${ts}`, name, category, title, output, status } });
  const events = {
    [a1.id]: [
      { seq: 5, ts: 5, kind: 'message', text: 'I will read the parser first.' },
      tool(10, 'command', 'shell', 'cat src/duration.js', 'ok', 'export function parseDuration() {}'),
      tool(12, 'command', 'shell', 'npm test', 'error', '1 failing'),
      tool(14, 'hub', 'report_progress', '回報進度'),
      tool(16, 'hub', 'search_records', '搜尋紀錄'),
      tool(18, 'hub', 'post_note', '留下筆記', 'error', 'note refused: too long'),
      tool(20, 'edit', 'apply_patch', 'src/duration.js'),
      { seq: 30, ts: 30, kind: 'error', text: 'the CLI lost its connection once' },
      tool(40, 'hub', 'submit_work', '提交實作'),
    ],
    [a2.id]: [],
  };
  return { run, a2, eventsOf: (id) => events[id] ?? [] };
}

test('C：prompt 的對話紀錄略過其他區塊已有摘要的成功工具呼叫；失敗的呼叫一律保留', () => {
  const { run, a2, eventsOf } = logRun(os.tmpdir());
  const text = W.contextBlock(run, a2, eventsOf, { maxChars: 200000 });
  const log = text.slice(text.indexOf('RECENT CONVERSATION'), text.indexOf('\n', text.indexOf('ended [completed]')));
  // 保留：說的話、錯誤、失敗的工具呼叫（指令與 Aivenue 工具）、使用者訊息、決定、結束摘要。
  assert.match(log, /said: I will read the parser first\./);
  assert.match(log, /error: the CLI lost its connection once/);
  assert.match(log, /post_note: 留下筆記 → error \(note refused: too long\)/);
  assert.match(log, /shell: npm test → error \(1 failing\)/);
  assert.match(log, /USER: Please do not touch formatDuration\./);
  assert.match(log, /DECISION: keep the public API of parseDuration/);
  assert.match(log, /ended \[completed\]/);
  // 略過：成功的指令、改檔與 Aivenue 呼叫（其他區塊有摘要）。
  assert.doesNotMatch(log, /shell: cat src\/duration\.js/);
  assert.doesNotMatch(log, /report_progress|search_records|submit_work|apply_patch/);
  // 那些指令與檔案仍在同一個 prompt 裡，含失敗的測試。
  // Printing a file counts as reading it: cat src/duration.js is under the files read (changed since, so marked).
  assert.match(text, /FILES OTHER AGENTS ALREADY READ[\s\S]*src\/duration\.js \(read by aaaaaaaa\)/);
  assert.match(text, /COMMANDS ALREADY RUN BY OTHER AGENTS/);
  assert.match(text, /npm test[\s\S]*1 failing/);
  assert.match(text, /FILES CHANGED:[\s\S]*src\/duration\.js/);
  assert.match(log, /failed tool calls/);
  assert.match(log, /read_context \{topic: "log"\} has the full log with every tool call/);
});

test('C：read_context 的完整對話紀錄不變，仍有每一個工具呼叫', () => {
  const { run, eventsOf } = logRun(os.tmpdir());
  const full = W.conversationLog(run, eventsOf).join('\n');
  for (const s of ['shell: cat src/duration.js', 'shell: npm test', 'report_progress', 'search_records', 'apply_patch', 'submit_work', 'post_note', 'USER: Please', 'DECISION: keep']) assert.ok(full.includes(s), s);
  const prompt = W.conversationLog(run, eventsOf, 600, { inPrompt: true });
  assert.ok(prompt.length < W.conversationLog(run, eventsOf).length);
  // 判斷規則本身。
  assert.equal(W.shownElsewhere({ category: 'command', status: 'ok' }), true);
  for (const category of ['command', 'search', 'read', 'edit', 'hub']) assert.equal(W.shownElsewhere({ category, status: 'error' }), false, `a failed ${category} call stays`);
  assert.equal(W.shownElsewhere({ category: 'hub', status: 'ok' }), true);
  assert.equal(W.shownElsewhere({ category: 'hub', status: 'error' }), false);
  assert.equal(W.shownElsewhere({ category: 'web', status: 'ok' }), false);
  assert.equal(W.shownElsewhere({ category: 'agent', status: 'ok' }), false);
});

test('C：三個 agent：第一位的 apply_patch 失敗、中間隔一位，第三位的 prompt 仍看得到失敗原因', () => {
  const tool = (ts, category, name, title, status = 'ok', output = 'done') => ({ seq: ts, ts, kind: 'tool', tool: { id: `t${ts}`, name, category, title, output, status } });
  const a1 = { id: 'aaaaaaaa-111', role: 'executor', provider: 'claude', status: 'completed', depth: 0, stage: 'implement', round: 1, startedAt: 1, endedAt: 50, stats: {}, summary: 'tried to fix the parser' };
  const a2 = { id: 'bbbbbbbb-222', role: 'code_reviewer', provider: 'codex', status: 'completed', depth: 0, stage: 'implement', round: 1, startedAt: 60, endedAt: 90, stats: {}, summary: 'revise: parser untouched', handoff: 'Please fix the parser; tests still fail.' };
  const a3 = { id: 'cccccccc-333', role: 'executor', provider: 'claude', status: 'running', depth: 0, stage: 'implement', round: 2, startedAt: 100, stats: {} };
  const run = { id: 'r', config: { cwd: os.tmpdir(), goal: 'g' }, agents: { [a1.id]: a1, [a2.id]: a2, [a3.id]: a3 }, stages: { plan: { rounds: [] }, implement: { rounds: [] }, verify: { rounds: [] } }, notes: [] };
  const events = {
    [a1.id]: [tool(10, 'edit', 'apply_patch', 'src/duration.js', 'error', 'patch failed: context mismatch at line 12 of src/duration.js'), { seq: 20, ts: 20, kind: 'message', text: 'The patch did not apply.' }],
    [a2.id]: [tool(70, 'command', 'shell', 'npm test', 'ok', '3 passing')],
    [a3.id]: [],
  };
  const eventsOf = (id) => events[id] ?? [];
  const text = W.contextBlock(run, a3, eventsOf, { maxChars: 200000 });
  // The hand-off comes from the one in between (the code reviewer), not the first: the reason cannot rely on it.
  assert.match(text, /THE AGENT BEFORE YOU — bbbbbbbb/);
  const handover = text.slice(text.indexOf('HAND-OFF TO YOU'), text.indexOf('RECENT CONVERSATION'));
  assert.doesNotMatch(handover, /context mismatch/);
  const log = text.slice(text.indexOf('RECENT CONVERSATION'), text.indexOf('\n', text.lastIndexOf('ended [completed]')));
  assert.match(log, /aaaaaaaa implementer claude implement#1 apply_patch: src\/duration\.js → error \(patch failed: context mismatch at line 12/);
  // The successful command of the one in between is summarized under the commands, not repeated in the log.
  assert.doesNotMatch(log, /shell: npm test/);
  assert.match(text, /COMMANDS ALREADY RUN BY OTHER AGENTS[\s\S]*npm test/);
});

// ---------- 輸出解碼：多位元字元跨 chunk 時，原始輸出、保存的紀錄與共享上下文一致 ----------

const KNOWN = '中文測試 Café au lait 𝄞';

/**
 * A node script that writes `lines` (each a string ending in \n) to stdout, each line cut into pieces at the given
 * byte offsets with a pause in between, so the pieces arrive as separate chunks; every cut falls inside a character.
 */
function chunkedWriter(dir, name, lines) {
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    `const lines = ${JSON.stringify(lines)};
// "now": write right away (a check command gets no input); otherwise after reading the prompt from stdin.
const write = async () => {
  for (const line of lines) {
    const b = Buffer.from(line, 'utf8');
    // Cut inside every multi-byte character: right after its first byte.
    const cuts = [];
    for (let i = 0; i < b.length; i++) if (b[i] >= 0xc0) cuts.push(i + 1);
    let at = 0;
    for (const c of [...cuts, b.length]) {
      process.stdout.write(b.subarray(at, c));
      at = c;
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  process.exit(0);
};
if (process.argv.includes('now')) write();
else {
  process.stdin.on('end', write);
  process.stdin.on('data', () => undefined);
}
`,
  );
  return file;
}

test('解碼：CLI 的 JSON 輸出把多位元字元切在 chunk 中間，保存的事件與共享上下文仍和原文一字不差', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-decode-'));
  const lines = [
    { type: 'thread.started', thread_id: 'th-1' },
    { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'cat known.txt' } },
    { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'cat known.txt', aggregated_output: KNOWN, exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: `I read it: ${KNOWN}` } },
    { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
  ].map((l) => JSON.stringify(l) + '\n');
  // The raw bytes the CLI writes are exactly the UTF-8 of these lines.
  assert.ok(Buffer.from(lines.join(''), 'utf8').toString('utf8').includes(KNOWN));
  const script = chunkedWriter(dir, 'fake-codex.js', lines);
  const spec = { id: 'fakecodex', name: 'Fake Codex', command: process.execPath, run: { fresh: [[script]], common: [], prompt: 'stdin' }, output: 'codex-jsonl' };
  const events = [];
  const res = await W.runAgent({ spec, prompt: 'read known.txt', cwd: dir, mode: 'write', tmpDir: dir, signal: new AbortController().signal, onEvent: (e) => events.push(e) });
  assert.equal(res.exitCode, 0, res.error);
  const toolEvent = events.find((e) => e.kind === 'tool' && e.tool?.id === 'c1');
  assert.equal(toolEvent.tool.output, KNOWN, '保存的工具輸出');
  assert.equal(events.find((e) => e.kind === 'message').text, `I read it: ${KNOWN}`, '保存的訊息');
  assert.ok(!events.some((e) => /�/.test(JSON.stringify(e))), '沒有替換字元');
  // The shared context the next agent gets from those events.
  const a1 = { id: 'aaaaaaaa-111', role: 'executor', provider: 'fakecodex', status: 'completed', depth: 0, startedAt: 1, endedAt: 2, stats: {} };
  const a2 = { id: 'bbbbbbbb-222', role: 'code_reviewer', provider: 'fakecodex', status: 'running', depth: 0, startedAt: 3, stats: {} };
  const run = { id: 'r', config: { cwd: dir, goal: 'g' }, agents: { [a1.id]: a1, [a2.id]: a2 }, stages: { plan: { rounds: [] }, implement: { rounds: [] }, verify: { rounds: [] } }, notes: [] };
  const stamped = events.map((e, i) => ({ ...e, ts: 1 + i / 100 }));
  const text = W.contextBlock(run, a2, (id) => (id === a1.id ? stamped : []), { maxChars: 200000 });
  assert.ok(text.includes(`said: I read it: ${KNOWN}`), '共享上下文的對話紀錄');
  assert.match(text, /FILES OTHER AGENTS ALREADY READ[\s\S]*known\.txt/);
  assert.ok(text.includes(KNOWN.slice(0, 4)) && text.split(KNOWN).length >= 3, '共享上下文中的讀檔內容與訊息都和原文相同');
  assert.ok(!/�/.test(text));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('解碼：capture（git 等指令）與 wait_for 的檢查指令，輸出跨 chunk 也不會斷字', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-decode-'));
  const script = chunkedWriter(dir, 'writer.js', [`${KNOWN}\n`]);
  const r = await W.capture(process.execPath, [script], { input: '' });
  assert.equal(r.stdout, `${KNOWN}\n`);
  const rm = new W.ResourceManager(dir);
  // node writes UTF-8 itself, so this checks only the chunk boundaries, not a console code page.
  const c = await rm.check(rm.newWait('a', { check: `"${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}" now`, contains: KNOWN }), dir);
  assert.equal(c.output, KNOWN);
  assert.equal(c.ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 失敗的編輯：依實際觀察標示，不列為確定改動 ----------

function editRun(edits) {
  const a1 = { id: 'aaaaaaaa-111', role: 'executor', provider: 'claude', status: 'completed', depth: 0, startedAt: 1, endedAt: 90, stats: {} };
  const a2 = { id: 'bbbbbbbb-222', role: 'code_reviewer', provider: 'codex', status: 'running', depth: 0, startedAt: 100, stats: {} };
  const run = { id: 'r', config: { cwd: os.tmpdir(), goal: 'g' }, agents: { [a1.id]: a1, [a2.id]: a2 }, stages: { plan: { rounds: [] }, implement: { rounds: [] }, verify: { rounds: [] } }, notes: [] };
  const tool = (ts, category, name, title, status, output = '') => ({ seq: ts, ts, kind: 'tool', tool: { id: `t${ts}`, name, category, title, output, status }, ...(category === 'edit' ? { files: [title] } : {}) });
  const events = {
    [a1.id]: [
      tool(10, 'command', 'shell', 'cat src/duration.js', 'ok', 'export function parseDuration() {}'),
      tool(12, 'command', 'shell', 'npm test', 'ok', '3 passing'),
      ...edits.map(([ts, status]) => tool(ts, 'edit', 'apply_patch', 'src/duration.js', status, status === 'error' ? 'patch failed: context mismatch' : '')),
    ],
    [a2.id]: [],
  };
  return { run, a1, a2, eventsOf: (id) => events[id] ?? [] };
}

test('失敗的編輯：只有失敗時列為「可能改動，需確認」，不列在 FILES CHANGED；先前的讀檔與指令標成需確認', () => {
  const { run, a2, eventsOf } = editRun([[20, 'error']]);
  const text = W.contextBlock(run, a2, eventsOf, { maxChars: 200000 });
  assert.doesNotMatch(text, /FILES CHANGED:/);
  assert.match(text, /FILES POSSIBLY CHANGED \(every edit of them failed[^\n]*\):\n- src\/duration\.js \(by aaaaaaaa/);
  assert.match(text, /src\/duration\.js \(read by aaaaaaaa\) — possibly changed since \(an edit of it failed\): check it/);
  // What was read is still shown (flagged), since the file may well be unchanged.
  assert.match(text, /possibly changed since[^\n]*\n\s+export function parseDuration/);
  assert.match(text, /npm test` \(a failed edit since may have changed files; check before relying on it\)/);
  assert.doesNotMatch(text, /CHANGED since, read it again/);
});

test('失敗的編輯：有任何一次成功就是確定改動（不論先後）；失敗不會把成功蓋掉', () => {
  for (const edits of [[[20, 'ok'], [30, 'error']], [[20, 'error'], [30, 'ok']]]) {
    const { run, a2, eventsOf } = editRun(edits);
    const text = W.contextBlock(run, a2, eventsOf, { maxChars: 200000 });
    assert.match(text, /FILES CHANGED:\n- src\/duration\.js/, JSON.stringify(edits));
    assert.doesNotMatch(text, /FILES POSSIBLY CHANGED/);
    assert.match(text, /src\/duration\.js \(read by aaaaaaaa\) — CHANGED since, read it again/);
  }
});

test('失敗的編輯：壓縮後的「自己做過的事」也分開列出確定改動與可能改動', () => {
  const failed = editRun([[20, 'error']]);
  const own = W.ownWorkBlock(failed.run, failed.eventsOf, new Set([failed.a1.id]), [], 20000);
  assert.match(own, /Files you possibly changed \(your edits of them failed; check them\):\n- src\/duration\.js/);
  assert.doesNotMatch(own, /Files you changed:/);
  const done = editRun([[20, 'ok']]);
  const own2 = W.ownWorkBlock(done.run, done.eventsOf, new Set([done.a1.id]), [], 20000);
  assert.match(own2, /Files you changed:\n- src\/duration\.js/);
  assert.doesNotMatch(own2, /possibly changed/);
});

test('Windows 檔案提醒：只在 Windows 回傳；其他平台是空字串，prompt 不變', () => {
  assert.match(W.P.windowsFilesRule('win32'), /^\n\nWINDOWS FILES: when you read a file known to be UTF-8 with Windows PowerShell 5\.1, use `Get-Content -Encoding UTF8`\. For a partial change prefer `apply_patch`/);
  for (const p of ['linux', 'darwin', 'freebsd']) assert.equal(W.P.windowsFilesRule(p), '');
});

// ---------- wait_for 檢查指令的輸出：依實際位元組解碼，不強制轉 UTF-8 ----------

test('shell 輸出解碼：合法 UTF-8 照 UTF-8；不是 UTF-8 時用主控台代碼頁；代碼頁不明時和以前一樣', () => {
  const utf8 = Buffer.from('中文測試 Café 𝄞', 'utf8');
  assert.equal(W.decodeShellOutput(utf8, 950), '中文測試 Café 𝄞', 'valid UTF-8 is never re-read in the code page');
  const big5 = Buffer.from(new Uint8Array([0xa4, 0xa4, 0xa4, 0xe5, 0xb4, 0xfa, 0xb8, 0xd5])); // 中文測試 in code page 950
  assert.equal(W.decodeShellOutput(big5, 950), '中文測試');
  const latin = Buffer.from([0x43, 0x61, 0x66, 0xe9]); // Café in code page 1252
  assert.equal(W.decodeShellOutput(latin, 1252), 'Café');
  // Unknown code page (or not Windows): UTF-8 with replacement characters, as before.
  assert.equal(W.decodeShellOutput(big5, null), big5.toString('utf8'));
  assert.equal(W.decodeShellOutput(big5, 12345), big5.toString('utf8'));
  assert.equal(W.decodeShellOutput(Buffer.from('plain ascii'), 950), 'plain ascii');
});

test('wait_for：Windows PowerShell 5.1 以主控台代碼頁輸出的中文，檢查結果讀得正確', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-cp-'));
  const rm = new W.ResourceManager(dir);
  const c = await rm.check(rm.newWait('a', { check: "Write-Output '中文測試 完成'", shell: 'powershell', contains: '中文測試 完成' }), dir);
  assert.equal(c.output, '中文測試 完成', `code page ${W.consoleCodePage()}`);
  assert.equal(c.ok, true);
  // A test that does not hold still reads as failed: the "False" stays last.
  const f = await rm.check(rm.newWait('a', { check: "Write-Error '找不到檔案' 2>$null; Test-Path 'C:\\no\\such\\file'", shell: 'powershell' }), dir);
  assert.equal(f.ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 安全檢查：內建的 security-audit skill 與設定 ----------

test('安全檢查：內建的 security-audit 有 SKILL.md、全部參考文件與授權，來源固定在一個 commit', () => {
  const root = path.join(process.cwd(), 'packages', 'core', 'bundled');
  const dir = path.join(root, 'security-audit', 'skills', 'security-audit');
  const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: security-audit\n/);
  assert.match(fs.readFileSync(path.join(root, 'security-audit', 'LICENSE'), 'utf8'), /^MIT License/);
  assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /\| `security-audit\/` \| https:\/\/github\.com\/cloudflare\/security-audit-skill \| `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` \| MIT/);
  // Every companion file SKILL.md links to is there, except the full-audit tools Aivenue leaves out (README says so).
  const omitted = new Set(['report-schema.json', 'validate-findings.cjs', 'validate-coverage-ledger.cjs']);
  const linked = [...skill.matchAll(/\]\(([A-Z0-9-]+\.md)\)/g)].map((m) => m[1]);
  assert.ok(linked.length >= 5, linked.join(','));
  for (const f of new Set(linked)) assert.ok(fs.existsSync(path.join(dir, f)), f);
  for (const f of omitted) assert.ok(!fs.existsSync(path.join(dir, f)), `${f} is left out`);
  // No script is shipped with it.
  assert.deepEqual(fs.readdirSync(dir).filter((f) => !f.endsWith('.md')), []);
});

test('安全檢查的指示：指定 guidance 模式、只做靜態檢查、需執行才能確認的列為待驗證且不給嚴重度', () => {
  const rule = W.P.securityReviewRule('/x/SKILL.md');
  assert.match(rule, /^\n\nSECURITY CHECK \(the user turned it on for this workflow\)/);
  assert.ok(rule.includes('Read /x/SKILL.md, then only the companion files next to it that fit what this change touches'));
  assert.match(rule, /do not ask which mode to use, do not run the full audit workflow, and do not create an output directory/);
  assert.match(rule, /Do not run the target's code, builds, tests or tools to confirm a security issue, do not probe deployed or external services, and do not spend paid API quota/);
  assert.ok(rule.includes('Say how far the evidence goes. Separate what the source itself shows'));
  assert.ok(rule.includes('put it in needs_validation (title, location, missing: what the source shows and what it does not, how: a safe way to confirm it), with no severity'));
  assert.match(rule, /report the proven part in issues and the rest in needs_validation, and do not list the same thing in both/);
});

test('安全檢查只套用在這段對話：存成新對話的預設時拿掉；完整電腦存取也回到完全 Auto', () => {
  const d = { permission: 'full', securityReview: true, cwd: 'C:/p', implement: { enabled: true } };
  assert.deepEqual(W.forNewConversations(d), { permission: 'auto', cwd: 'C:/p', implement: { enabled: true } });
  assert.deepEqual(W.forNewConversations({ permission: 'auto', cwd: 'C:/p' }), { permission: 'auto', cwd: 'C:/p' });
  assert.equal(d.securityReview, true, 'the conversation keeps its own setting');
});

// ---------- 審查的「待驗證」：獨立欄位，不給嚴重度，不進路由 ----------

test('待驗證：submit_review 的 needs_validation 另外保存，不混進 issues；舊審查沒有這個欄位照常解析', () => {
  const r = W.parseReview({
    verdict: 'revise',
    summary: 's',
    issues: [{ id: 'R1', severity: 'major', title: 'path traversal', location: 'src/a.js:3' }],
    needs_validation: [
      { title: 'header trusted for the admin check', location: 'src/a.js:9', missing: 'the code trusts it; whether a client can set it depends on the proxy', how: 'check the deployment config for a proxy that overwrites it' },
      { id: 'V7', title: 'second', missing: 'm', how: 'h' },
      { missing: 'no title: dropped', how: 'h' },
    ],
  });
  assert.equal(r.issues.length, 1);
  assert.deepEqual(r.issues.map((i) => i.id), ['R1']);
  assert.deepEqual(r.needsValidation.map((n) => n.id), ['V1', 'V7']);
  assert.equal(r.needsValidation[0].location, 'src/a.js:9');
  assert.equal('severity' in r.needsValidation[0], false);
  const old = W.parseReview({ verdict: 'approve', summary: 'ok', issues: [] });
  assert.equal('needsValidation' in old, false);
  // The fallback JSON shape every reviewer gets names the field.
  assert.match(W.P.codeReviewPrompt({ goal: 'g', title: 't', cwd: '.' }, undefined, 'w', 'c', 1), /"needs_validation": \[\{"id": "V1", "title": string, "location": string, "missing": string, "how": string\}\]/);
});

test('待驗證：read_context 的總覽把它和已確認問題分開，標成未確認', () => {
  const run = { id: 'r', config: { cwd: '.', goal: 'g' }, agents: {}, notes: [], steps: [], stages: { plan: { rounds: [] }, implement: { rounds: [{ n: 1, review: { verdict: 'revise', summary: 's', issues: [{ id: 'R1', severity: 'major', title: 'traversal' }], needsValidation: [{ id: 'V1', title: 'header trusted', missing: 'proxy unknown', how: 'check config' }] } }] }, verify: { rounds: [] } } };
  const text = W.overview(run);
  assert.match(text, /R1 \[major\] traversal/);
  assert.match(text, /V1 \[needs validation, not confirmed\] header trusted — missing: proxy unknown — to confirm: check config/);
});

// ---------- 交接升級：一份交接，分開「Aivenue 看到的」「前一位的說法」「未確認的」 ----------

function handoffRun() {
  const tool = (ts, category, name, title, status = 'ok', output = 'ok') => ({ seq: ts, ts, kind: 'tool', tool: { id: `t${ts}`, name, category, title, output, status } });
  const a1 = { id: 'aaaaaaaa-111', role: 'executor', provider: 'claude', status: 'completed', depth: 0, stage: 'implement', round: 1, startedAt: 1, endedAt: 50, stats: { filesChanged: ['src/server.js'] }, handover: { text: 'Added the download route. I also ran the linter and everything is green.', ts: 50 } };
  const a2 = { id: 'bbbbbbbb-222', role: 'code_reviewer', provider: 'codex', status: 'completed', depth: 0, stage: 'implement', round: 1, startedAt: 60, endedAt: 90, stats: {}, handover: { text: 'R1 must be fixed; V1 needs the deployment config.', ts: 90 } };
  const a3 = { id: 'cccccccc-333', role: 'executor', provider: 'claude', status: 'running', depth: 0, stage: 'implement', round: 2, startedAt: 100, stats: {}, task: 'Fix the open issues of the code review' };
  const review = {
    verdict: 'revise',
    summary: 'fix it',
    issues: [{ id: 'R1', severity: 'major', title: 'download route permits path traversal', location: 'src/server.js:12' }],
    needsValidation: [{ id: 'V1', title: 'admin check trusts a client header', location: 'src/server.js:22', missing: 'the code trusts the header; whether a client can set it depends on the proxy', how: 'check the deployment config' }],
  };
  const run = {
    id: 'r',
    config: { cwd: os.tmpdir(), goal: 'Add a download route' },
    agents: { [a1.id]: a1, [a2.id]: a2, [a3.id]: a3 },
    stages: { plan: { rounds: [] }, implement: { rounds: [{ n: 1, authorAgentId: a1.id, reviewerAgentId: a2.id, submission: { summary: 'added it' }, review, route: { to: 'implementer', reason: '1 open issue from the code review' } }] }, verify: { rounds: [] } },
    notes: [],
    userMessages: [{ ts: 40, text: 'Keep the public API exactly as it is.' }],
  };
  const events = {
    [a1.id]: [tool(10, 'command', 'shell', 'npm test', 'ok', '3 passing'), tool(20, 'edit', 'apply_patch', 'src/server.js')],
    [a2.id]: [tool(70, 'command', 'shell', 'node --test test/server.test.js', 'error', '1 failing: traversal')],
    [a3.id]: [],
  };
  return { run, a3, eventsOf: (id) => events[id] ?? [] };
}

test('交接升級：接手者拿到下一步、使用者原話、Aivenue 看到的驗證、未解問題、待驗證、前一位的說法、來源與核對要求', () => {
  const { run, a3, eventsOf } = handoffRun();
  const text = W.contextBlock(run, a3, eventsOf, { maxChars: 200000 });
  const h = text.slice(text.indexOf('HAND-OFF TO YOU'), text.indexOf('BEFORE YOU ACT'));
  assert.match(h, /^HAND-OFF TO YOU \(from Aivenue's records; the user's words and the current files win over it\):/);
  // Next step.
  assert.match(h, /NEXT STEP:\n- Your task now: Fix the open issues of the code review\n- Why it came back to you: 1 open issue from the code review/);
  // The user's words, verbatim.
  assert.match(h, /FROM THE USER \(their words; constraints to keep\):\n- "Keep the public API exactly as it is\."/);
  // Only what Aivenue saw run: the passing test and the failing one, not the linter the agent says it ran.
  const verified = h.slice(h.indexOf('VERIFIED BY AIVENUE'), h.indexOf('OPEN ISSUES'));
  assert.match(verified, /✓ passed: `npm test` \(run by aaaaaaaa implementer\)/);
  assert.match(verified, /✗ failed: `node --test test\/server\.test\.js` \(run by bbbbbbbb code reviewer\)/);
  assert.doesNotMatch(verified, /lint/i);
  assert.match(verified, /an agent's own claims are not here/);
  // Open issues and what is not confirmed, apart.
  const open = h.slice(h.indexOf('OPEN ISSUES'), h.indexOf('NEEDS VALIDATION'));
  assert.match(open, /- R1 \[major\] download route permits path traversal \(src\/server\.js:12\) — implement review, round 1/);
  assert.doesNotMatch(open, /V1|client header/);
  assert.match(h, /NEEDS VALIDATION \(not confirmed, no severity; not facts, not defects\):\n- V1 admin check trusts a client header \(src\/server\.js:22\) — missing evidence: the code trusts the header; whether a client can set it depends on the proxy; to confirm: check the deployment config/);
  // The previous agent's account, as its claims.
  assert.match(h, /THE AGENT BEFORE YOU — bbbbbbbb-222 — code reviewer[^\n]*its own account, to check:\nR1 must be fixed; V1 needs the deployment config\./);
  // Sources, with what matters there.
  assert.match(h, /SOURCES:\n- Its conversation: read_context \{agent_id: "bbbbbbbb-222"\}/);
  assert.match(h, /All reviews and verifications: read_context \{\}\./);
  assert.match(text, /BEFORE YOU ACT: check the claims you rely on against the current files, read-only; report a mismatch/);
});

test('交接升級：同一份 prompt 不重複舊的交接區塊、狀態裡的未解問題與 agent 清單裡的交接全文', () => {
  const { run, a3, eventsOf } = handoffRun();
  const text = W.contextBlock(run, a3, eventsOf, { maxChars: 200000 });
  assert.equal(text.split('HAND-OFF TO YOU (').length - 1, 1);
  assert.doesNotMatch(text, /HAND-OFFS \(latest of each stage\)/);
  assert.doesNotMatch(text, /HAND-OFF FROM THE AGENT BEFORE YOU/);
  assert.doesNotMatch(text, /Open implement review issues/, 'the status does not list them again');
  assert.equal(text.split('R1 must be fixed; V1 needs the deployment config.').length - 1, 1, 'its hand-off appears once');
  // Without a hand-off (the first agent), the status still lists open issues as before.
  const first = { ...run, agents: { [a3.id]: a3 } };
  assert.match(W.contextBlock(first, a3, eventsOf, { maxChars: 200000 }), /Open implement review issues \(round 1\): R1 \[major\]/);
});

test('交接回歸：只記在計畫階段的決定與待辦，經過實作者後，審查者仍從新交接看到', () => {
  const p1 = { id: 'pppppppp-111', role: 'planner', provider: 'claude', status: 'completed', depth: 0, stage: 'plan', round: 1, startedAt: 1, endedAt: 20, stats: {} };
  const ex = { id: 'eeeeeeee-222', role: 'executor', provider: 'claude', status: 'completed', depth: 0, stage: 'implement', round: 1, startedAt: 30, endedAt: 50, stats: { filesChanged: ['src/a.js'] }, handover: { text: 'Implemented the change in src/a.js.', ts: 50 } };
  const rv = { id: 'rrrrrrrr-333', role: 'code_reviewer', provider: 'codex', status: 'running', depth: 0, stage: 'implement', round: 1, startedAt: 60, stats: {} };
  const run = {
    id: 'r',
    config: { cwd: os.tmpdir(), goal: 'g' },
    agents: { [p1.id]: p1, [ex.id]: ex, [rv.id]: rv },
    stages: {
      plan: { rounds: [{ n: 1, authorAgentId: p1.id, handoff: { ts: 20, stage: 'plan', round: 1, decisions: ['Store dates as UTC; never local time'], facts: ['submitted: plan for the export'], open: ['P1 [minor] decide the CSV delimiter later'], links: [] } }] },
      implement: { rounds: [{ n: 1, authorAgentId: ex.id, submission: { summary: 'done' } }] },
      verify: { rounds: [] },
    },
    notes: [],
  };
  const text = W.contextBlock(run, rv, () => [], { maxChars: 200000 });
  const h = text.slice(text.indexOf('HAND-OFF TO YOU'), text.indexOf('BEFORE YOU ACT'));
  // The executor's own hand-off does not repeat them; the reviewer still gets them.
  assert.doesNotMatch(ex.handover.text, /UTC|delimiter/);
  assert.match(h, /RECORDED AT EACH STAGE \(the latest round of each\):\nplan stage, round 1:\n  DECISION: Store dates as UTC; never local time\n  FACT: submitted: plan for the export\n  OPEN: P1 \[minor\] decide the CSV delimiter later/);
  assert.doesNotMatch(text, /HAND-OFFS \(latest of each stage\)/, 'not repeated in the old block');
});

test('交接回歸：複合指令的整體成功不寫成某一項檢查已通過；單獨執行的檢查照實標示', () => {
  const tool = (ts, title, status = 'ok', output = 'done') => ({ seq: ts, ts, kind: 'tool', tool: { id: `t${ts}`, name: 'shell', category: 'command', title, output, status } });
  const a1 = { id: 'aaaaaaaa-111', role: 'executor', provider: 'claude', status: 'completed', depth: 0, stage: 'implement', round: 1, startedAt: 1, endedAt: 50, stats: {} };
  const a2 = { id: 'bbbbbbbb-222', role: 'code_reviewer', provider: 'codex', status: 'running', depth: 0, stage: 'implement', round: 1, startedAt: 60, stats: {} };
  const run = { id: 'r', config: { cwd: os.tmpdir(), goal: 'g' }, agents: { [a1.id]: a1, [a2.id]: a2 }, stages: { plan: { rounds: [] }, implement: { rounds: [] }, verify: { rounds: [] } }, notes: [] };
  const events = {
    [a1.id]: [
      tool(10, 'npm test; git status --short'),
      tool(11, 'npm run build | tail -5'),
      tool(12, 'cd web && npm run lint', 'error', 'exit 1'),
      tool(13, 'pytest -q'),
      tool(14, "node --test 'a; b.test.js'"),
    ],
  };
  const text = W.contextBlock(run, a2, (id) => events[id] ?? [], { maxChars: 200000 });
  const v = text.slice(text.indexOf('VERIFIED BY AIVENUE'), text.indexOf('THE AGENT BEFORE YOU'));
  assert.match(v, /◦ ran within a longer command \(the command ended fine; the check's own result: read the output\): `npm test; git status --short`/);
  assert.match(v, /◦ ran within a longer command[^`]*`npm run build \| tail -5`/);
  assert.match(v, /✗ the longer command it ran in failed \(which step failed: check the output\): `cd web && npm run lint`/);
  assert.match(v, /✓ passed: `pytest -q`/);
  // A separator inside quotes is not a second step.
  assert.match(v, /✓ passed: `node --test 'a; b\.test\.js'`/);
  assert.doesNotMatch(v, /✓ passed: `npm test; git status/);
});

test('交接回歸：程式審查要求修改（沒有記錄路由）時，返工的實作者仍知道為什麼回到它手上', () => {
  const { run, a3, eventsOf } = handoffRun();
  delete run.stages.implement.rounds[0].route;
  const text = W.contextBlock(run, a3, eventsOf, { maxChars: 200000 });
  assert.match(text, /NEXT STEP:\n- Your task now: Fix the open issues of the code review\n- Why it came back to you: the implement review of round 1 asked for changes \(R1\)/);
  // A first-round agent gets no NEXT STEP (its task is the role prompt's).
  const first = { ...a3, round: 1 };
  assert.doesNotMatch(W.contextBlock({ ...run, agents: { ...run.agents, [a3.id]: first } }, first, eventsOf, { maxChars: 200000 }), /NEXT STEP:/);
});

