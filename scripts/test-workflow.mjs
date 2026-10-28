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
      export { ResourceManager, pidAlive } from './packages/core/src/resources';
      export { parseVerification, parsePlan, parseRulings, toolsForRole } from './packages/core/src/hubTools';
      export { parseSize, inspectProcess } from './packages/core/src/procstat';
      export { CliPool } from './packages/core/src/cliPool';`,
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
