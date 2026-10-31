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
      export { parseVerification, parsePlan, parseRulings, toolsForRole } from './packages/core/src/hubTools';
      export { parseSize, inspectProcess } from './packages/core/src/procstat';
      export { CliPool } from './packages/core/src/cliPool';
      export { backgroundLaunch, pidFromOutput } from './packages/core/src/procdetect';
      export { fileReadOf, POLLING, collectActivity, activityBlock, ownWorkBlock } from './packages/core/src/ledger';
      export { contextBlock, formatTranscript, handoverOf, toolInputText } from './packages/core/src/context';
      export { groupFolders } from './packages/core/src/outputs';
      export { buildTopics, topicDetail, topicIndexBlock, topicList } from './packages/core/src/topics';`,
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
  assert.match(text, /HAND-OFF FROM THE AGENT BEFORE YOU — aaaaaaaa-111 — implementer[\s\S]*look at collate\(\) next/);
  assert.match(text, /read_context \{agent_id: "aaaaaaaa-111"\}/);
  assert.doesNotMatch(text, /FULL TRANSCRIPT/);
  // The directory shows who it is and the first line of what it handed over.
  assert.match(text, /Agents so far[^\n]*:\n- aaaaaaaa-111 — implementer[\s\S]*hand-off: Fixed the mask/);
});

test('交接：沒寫交接時 Aivenue 用它的結果與最後的指令湊一份，不另外呼叫模型', () => {
  const { run, a1, a2, eventsOf } = sharedRun(os.tmpdir());
  a1.status = 'failed';
  a1.error = 'CLI exited 1';
  a1.stats = { filesChanged: ['src/model.py'] };
  const h = W.handoverOf(run, a1, eventsOf(a1.id));
  assert.equal(h.auto, true);
  assert.match(h.text, /ended with an error: CLI exited 1[\s\S]*Files it changed: src\/model\.py[\s\S]*pytest -q → ok/);
  assert.match(W.contextBlock(run, a2, eventsOf, { maxChars: 200000 }), /it wrote none; put together by Aivenue/);
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
