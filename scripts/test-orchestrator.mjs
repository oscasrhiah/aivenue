import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';

// 工作流狀態機的回歸測試：真正的 Orchestrator，只把 CLI 換成依角色回應的替身 agent，
// 用來模擬各種結果、斷線、崩潰、錯誤核准與結果遺失。
const bundled = await build({
  stdin: { contents: `export { Orchestrator } from './packages/core/src/orchestrator'; export { RunStore } from './packages/core/src/store';`, resolveDir: process.cwd() },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent',
  plugins: [
    {
      name: '替身 agent',
      setup(b) {
        b.onLoad({ filter: /[\\/]agentRunner\.ts$/ }, () => ({ contents: `export async function runAgent(o) { return globalThis.__fakeAgent(o); }` }));
      },
    },
  ],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const { Orchestrator, RunStore } = mod.exports;

const spec = (id) => ({ id, name: id, command: id, run: { args: [] }, output: 'text' });
function setup(o = {}) {
  // `dir`: the same data folder again (Aivenue restarted).
  const dir = o.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-orch-'));
  const cwd = path.join(dir, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const ids = ['fake', 'fake2'];
  const registry = {
    get: (id) => (ids.includes(id) ? spec(id) : undefined),
    list: () => ids.map((id) => ({ spec: spec(id), installed: true, auth: { state: 'logged_in' } })),
    specs: () => ids.map(spec),
    defaults: () => ({}),
    runAuth: async () => undefined,
    listModels: async () => [],
    noteContext: () => undefined,
  };
  const orch = new Orchestrator({
    registry,
    store: new RunStore(path.join(dir, 'home')),
    usage: { recordRun() {}, recordError() {}, recordUsage() {}, cachedSummary: () => [] },
    capabilities: { serversFor: async () => [], skillsBlock: () => '', instructionsFor: () => undefined, skillsDir: dir },
    attachments: { prepare: async (a) => ({ attachments: a ?? [], warnings: [] }), adopt: (_id, a) => a ?? [], runDir: () => dir },
    dataDir: path.join(dir, 'home'),
    bridgePath: 'bridge.js',
    hubUrl: () => 'http://127.0.0.1:1',
    push: () => undefined,
    gpuQuery: o.gpuQuery ?? (() => { throw new Error('no GPU'); }),
    gpuSmi: o.gpuSmi ?? (() => { throw new Error('no GPU'); }),
  });
  return { orch, cwd, dir };
}

// Only the first line names the role (later text may quote other roles: "The CODE REVIEWER found…").
const role = (full) => {
  const prompt = full.split('\n')[0];
  return roleOf(prompt);
};
const roleOf = (prompt) =>
  /organize the shared knowledge/.test(prompt) ? 'librarian' : /NOW VERIFYING|GOAL VERIFIER/.test(prompt) ? 'verifier' : /ADJUDICATOR/.test(prompt) ? 'adjudicator' : /PLAN REVIEWER/.test(prompt) ? 'plan_reviewer' : /CODE REVIEWER/.test(prompt) ? 'code_reviewer' : /SUB-AGENT/.test(prompt) ? 'subagent' : /PLANNER/.test(prompt) ? 'planner' : 'executor';

const goal = { statement: 'tests pass', metrics: [{ id: 'M1', name: 'tests', target: 'all pass', how: 'npm test' }] };
const verdict = (outcome, met, issues = []) => ({ outcome, summary: outcome, metrics: [{ id: 'M1', value: met ? 'pass' : 'fail', met, evidence: 'npm test' }], issues });

/**
 * A fake CLI per role. `script[role]` is a list of behaviours used in turn (the last one repeats):
 * an args object to submit, { error }, { nothing: true } (exit without a result), or a function (orch, secret) => result.
 */
function fakeAgents(orch, script) {
  const used = {};
  const calls = [];
  globalThis.__fakeAgent = async (o) => {
    const r = role(o.prompt);
    calls.push(r);
    const list = script[r] ?? [defaults[r]];
    const step = list[Math.min(used[r] ?? 0, list.length - 1)];
    used[r] = (used[r] ?? 0) + 1;
    // The compactor runs without Aivenue's tools (no bridge).
    const secret = o.bridge?.env?.AIVENUE_SESSION;
    const done = { lastSeq: (o.seqStart ?? 0) + 1, exitCode: 0, resumed: false, finalText: 'done' };
    if (typeof step === 'function') return (await step(orch, secret, o)) ?? done;
    if (step.error) return { ...done, exitCode: 1, finalText: '', error: step.error };
    if (step.nothing) return { ...done, finalText: '' };
    await orch.callTool(secret, step.tool, step.args);
    return done;
  };
  return calls;
}
const defaults = {
  planner: { tool: 'submit_plan', args: { summary: 'plan', markdown: 'plan', steps: [{ id: '1', title: 'do it' }], goal } },
  plan_reviewer: { tool: 'submit_review', args: { verdict: 'approve', summary: 'ok', issues: [] } },
  executor: { tool: 'submit_work', args: { summary: 'done' } },
  code_reviewer: { tool: 'submit_review', args: { verdict: 'approve', summary: 'ok', issues: [] } },
  verifier: { tool: 'submit_verification', args: verdict('met', true) },
  subagent: { nothing: true },
};
const verify = (...v) => v.map((args) => ({ tool: 'submit_verification', args }));

function config(cwd, over = {}) {
  const r = { provider: 'fake' };
  return {
    title: 't',
    goal: 'make the tests pass',
    cwd,
    plan: { enabled: true, author: r, reviewer: { provider: 'fake2' }, maxRounds: 3, humanGate: false },
    implement: { enabled: true, author: r, reviewer: { provider: 'fake2' }, maxRounds: 5, humanGate: false },
    subagents: { enabled: false, allowed: [], maxDepth: 1, maxConcurrent: 1 },
    verify: { enabled: true, by: 'planner', repeatLimit: 3 },
    permission: 'auto',
    ...over,
  };
}

/** Wait until the run ended or asks the user something. */
async function settle(orch, id, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const r = orch.runs.get(id);
    if (!['running', 'paused'].includes(r.status)) return r;
    if (Date.now() > end) throw new Error(`still ${r.status}`);
    await new Promise((res) => setTimeout(res, 50));
  }
}
const routes = (r) => (r.stages.verify?.rounds ?? []).map((x) => x.route?.to);

test('驗收有缺陷 → 實作者修正 → 達標才結束', async () => {
  const { orch, cwd } = setup();
  fakeAgents(orch, { verifier: verify(verdict('defect', false, [{ id: 'V1', severity: 'major', title: 'crash' }]), verdict('met', true)) });
  const r = await settle(orch, orch.start(config(cwd)).id);
  assert.equal(r.status, 'completed', r.error);
  assert.deepEqual(routes(r), ['implementer', 'done']);
  assert.equal(r.stages.implement.rounds.length, 2);
  assert.equal(r.stages.plan.rounds.length, 1);
  assert.equal(r.cycles, 1);
});

test('工作有效但沒達標 → 計畫者重新規劃 → 重新實作', async () => {
  const { orch, cwd } = setup();
  fakeAgents(orch, { verifier: verify(verdict('not_met', false), verdict('met', true)) });
  const r = await settle(orch, orch.start(config(cwd)).id);
  assert.equal(r.status, 'completed', r.error);
  assert.deepEqual(routes(r), ['planner', 'done']);
  assert.equal(r.stages.plan.rounds.length, 2);
  assert.equal(r.stages.implement.rounds.length, 2);
});

test('錯誤核准：說達標但指標沒過，不會結束', async () => {
  const { orch, cwd } = setup();
  fakeAgents(orch, { verifier: verify(verdict('met', false), verdict('met', true)) });
  const r = await settle(orch, orch.start(config(cwd)).id);
  assert.equal(r.status, 'completed', r.error);
  assert.notEqual(routes(r)[0], 'done');
  assert.equal(routes(r).length, 2);
});

test('同一個缺陷連續修不好 → 交回計畫者重新診斷', async () => {
  const { orch, cwd } = setup();
  const same = verdict('defect', false, [{ id: 'V1', severity: 'major', title: 'Crash on empty input' }]);
  fakeAgents(orch, { verifier: verify(same, same, same, verdict('met', true)) });
  const r = await settle(orch, orch.start(config(cwd)).id);
  assert.deepEqual(routes(r), ['implementer', 'implementer', 'planner', 'done']);
  assert.equal(r.stages.verify.rounds[2].route.rediagnose, true);
  assert.equal(r.stages.plan.rounds.length, 2);
});

test('程式審查同一個問題反覆出現 → 計畫者重新診斷', async () => {
  const { orch, cwd } = setup();
  const issue = { tool: 'submit_review', args: { verdict: 'revise', summary: 'no', issues: [{ id: 'R1', severity: 'major', title: 'missing test' }] } };
  fakeAgents(orch, { code_reviewer: [issue, issue, issue, defaults.code_reviewer] });
  const r = await settle(orch, orch.start(config(cwd)).id);
  assert.equal(r.status, 'completed', r.error);
  assert.equal(r.stages.plan.rounds.length, 2);
  assert.equal(r.stages.implement.rounds[2].route.to, 'planner');
});

test('反駁後又被提出 → 第三方裁定駁回 → 通過', async () => {
  const { orch, cwd } = setup();
  const issue = { tool: 'submit_review', args: { verdict: 'revise', summary: 'no', issues: [{ id: 'R1', severity: 'major', title: 'use a mutex' }] } };
  const rebut = { tool: 'submit_work', args: { summary: 'no change', responses: [{ issue_id: 'R1', action: 'rebutted', note: 'single thread' }] } };
  const calls = fakeAgents(orch, {
    code_reviewer: [issue],
    executor: [defaults.executor, rebut, rebut],
    adjudicator: [{ tool: 'submit_ruling', args: { rulings: [{ issue_id: 'R1', ruling: 'dismiss', reason: 'the code is single-threaded (main.js:1)' }] } }],
  });
  const r = await settle(orch, orch.start(config(cwd, { verify: undefined, plan: { enabled: false, author: { provider: 'fake' }, reviewer: null, maxRounds: 1, humanGate: false } })).id);
  assert.equal(r.status, 'completed', r.error);
  assert.ok(calls.includes('adjudicator'));
  assert.equal(r.rulings.length, 1);
  assert.equal(r.stages.implement.rounds.at(-1).review.verdict, 'approve');
});

test('結果遺失：程序結束卻沒交結果 → 不算成功，由使用者決定', async () => {
  const { orch, cwd } = setup();
  fakeAgents(orch, { executor: [{ nothing: true }, defaults.executor] });
  const run = orch.start(config(cwd, { verify: undefined }));
  let r = await settle(orch, run.id);
  assert.equal(r.status, 'waiting_human');
  const ex = Object.values(r.agents).find((a) => a.role === 'executor');
  assert.equal(ex.endedWithoutResult, true);
  assert.equal(ex.status, 'failed');
  orch.decide(run.id, r.pending.id, 'retry');
  r = await settle(orch, run.id);
  assert.equal(r.status, 'completed', r.error);
});

test('斷線：網路錯誤自動退避重試後完成', async () => {
  const { orch, cwd } = setup();
  fakeAgents(orch, { executor: [{ error: 'fetch failed: ECONNRESET' }, defaults.executor] });
  const r = await settle(orch, orch.start(config(cwd, { verify: undefined })).id, 20000);
  assert.equal(r.status, 'completed', r.error);
  assert.ok(r.log.some((l) => /網路|Network/.test(l.text)));
});

test('崩潰：任務本身出錯不盲目重試，交給使用者', async () => {
  const { orch, cwd } = setup();
  const calls = fakeAgents(orch, { executor: [{ error: 'TypeError: cannot read properties of undefined (exit code 1)' }] });
  const r = await settle(orch, orch.start(config(cwd, { verify: undefined })).id);
  assert.equal(r.status, 'waiting_human');
  assert.equal(calls.filter((c) => c === 'executor').length, 1);
  assert.equal(Object.values(r.agents).find((a) => a.role === 'executor').failure.kind, 'logic');
  orch.cancel(r.id);
});

test('執行限制：超過循環次數 → 未完成，不是完成', async () => {
  const { orch, cwd } = setup();
  fakeAgents(orch, { verifier: verify(verdict('defect', false, [{ id: 'V1', severity: 'major', title: 'a' }]), verdict('defect', false, [{ id: 'V2', severity: 'major', title: 'b' }])) });
  const r = await settle(orch, orch.start(config(cwd, { limits: { enabled: true, maxCycles: 1 } })).id);
  assert.equal(r.status, 'incomplete');
  assert.match(r.incompleteReason, /retry limit/);
});

test('上層 agent 有子任務還在跑時不能交結果', async () => {
  const { orch, cwd } = setup();
  let blocked;
  fakeAgents(orch, {
    subagent: [async () => (await new Promise((res) => setTimeout(res, 400)), undefined)],
    executor: [
      async (o, secret) => {
        const sub = JSON.parse(await o.callTool(secret, 'spawn_subagent', { provider: 'fake2', task: 'help' }));
        blocked = await o.callTool(secret, 'submit_work', { summary: 'too early' }).then(() => false, (e) => e.message);
        await o.callTool(secret, 'wait_subagent', { subagent_id: sub.subagent_id, timeout_sec: 5 });
        await o.callTool(secret, 'submit_work', { summary: 'done' });
      },
    ],
  });
  const r = await settle(orch, orch.start(config(cwd, { verify: undefined, plan: { enabled: false, author: { provider: 'fake' }, reviewer: null, maxRounds: 1, humanGate: false }, subagents: { enabled: true, allowed: ['fake2'], maxDepth: 1, maxConcurrent: 2 } })).id);
  assert.match(blocked, /still running/);
  assert.equal(r.status, 'completed', r.error);
});

test('共享上下文：後面的 agent 看得到目標、驗收差距與交接', async () => {
  const { orch, cwd } = setup();
  const seen = [];
  fakeAgents(orch, {
    verifier: verify(verdict('defect', false, [{ id: 'V1', severity: 'major', title: 'crash on empty' }]), verdict('met', true)),
    executor: [
      defaults.executor,
      async (o, secret) => {
        seen.push(await o.callTool(secret, 'read_context', {}));
        await o.callTool(secret, 'submit_work', { summary: 'fixed' });
      },
    ],
  });
  const r = await settle(orch, orch.start(config(cwd)).id);
  assert.equal(r.status, 'completed', r.error);
  assert.match(seen[0], /WORKFLOW STATUS NOW/);
  assert.match(seen[0], /M1 tests: target all pass — last measured: fail \(NOT met\)/);
  assert.match(seen[0], /GOAL VERIFICATION 1: defect/);
  assert.match(seen[0], /HAND-OFFS/);
});

test('使用者停止、重跑 sub agent：上層 agent 收到通知並改收新的結果', async () => {
  const { orch, cwd } = setup();
  const seen = [];
  let firstId;
  fakeAgents(orch, {
    subagent: [async () => (await new Promise((res) => setTimeout(res, 300)), undefined)],
    executor: [
      async (o, secret) => {
        const run = [...o.runs.values()].at(-1);
        firstId = JSON.parse(await o.callTool(secret, 'spawn_subagent', { provider: 'fake2', task: 'help' })).subagent_id;
        o.stopAgent(run.id, firstId); // 使用者按 ■
        seen.push(await o.callTool(secret, 'wait_subagent', { subagent_id: firstId, timeout_sec: 5 }));
        o.rerunAgent(run.id, firstId); // 使用者按 ↻
        seen.push(await o.callTool(secret, 'list_providers', {}));
        const second = Object.values(run.agents).find((a) => a.rerunOf === firstId);
        seen.push(await o.callTool(secret, 'wait_subagent', { subagent_id: second.id, timeout_sec: 5 }));
        await o.callTool(secret, 'submit_work', { summary: 'done' });
      },
    ],
  });
  const r = await settle(orch, orch.start(config(cwd, { verify: undefined, plan: { enabled: false, author: { provider: 'fake' }, reviewer: null, maxRounds: 1, humanGate: false }, subagents: { enabled: true, allowed: ['fake2'], maxDepth: 1, maxConcurrent: 3 } })).id);
  assert.equal(r.status, 'completed', r.error);
  assert.match(seen[0], /"status":"cancelled"/);
  assert.match(seen[0], /AIVENUE NOTICE[\s\S]*STOPPED/);
  assert.match(seen[1], /re-ran sub-agent/);
  assert.match(seen[2], /"status":"completed"/);
  assert.equal(r.agents[firstId].status, 'cancelled');
});

const gpuCsv = (used) => `0, Fake GPU, ${used}, 24576, 0\n1, Fake GPU, 20000, 24576, 95\n`;

test('GPU 鎖：條件成立才上鎖、只拿空閒的卡、agent 結束自動釋放', async () => {
  let used = 9000; // GPU 0 一開始很忙
  const { orch, cwd } = setup({ gpuQuery: () => gpuCsv(used) });
  const node = JSON.stringify(process.execPath);
  let got;
  fakeAgents(orch, {
    executor: [
      async (o, secret) => {
        setTimeout(() => (used = 100), 300); // 另一個工作結束，GPU 0 空出來
        got = JSON.parse(await o.callTool(secret, 'wait_for', { check: `${node} -e "process.exit(0)"`, interval_sec: 5, timeout_min: 1, gpus: 1 }));
        while (got.status === 'waiting') got = JSON.parse(await o.callTool(secret, 'wait_for', { wait_id: got.wait_id }));
        const busy = JSON.parse(await o.callTool(secret, 'gpu_acquire', { count: 1 })); // GPU 1 忙、GPU 0 已被自己鎖住
        got.second = busy.status;
        got.locks = [...o.runs.values()].at(-1).gpuLocks.length;
        await o.callTool(secret, 'submit_work', { summary: 'trained' });
      },
    ],
  });
  const r = await settle(orch, orch.start(config(cwd, { verify: undefined, plan: { enabled: false, author: { provider: 'fake' }, reviewer: null, maxRounds: 1, humanGate: false } })).id, 30000);
  assert.equal(r.status, 'completed', r.error);
  assert.equal(got.status, 'met');
  assert.deepEqual(got.gpus, [0]);
  assert.equal(got.second, 'busy');
  assert.equal(got.locks, 1);
  assert.equal(r.gpuLocks.length, 0); // 結束時已釋放
  assert.ok(orch.gpus().every((g) => !g.lockedBy));
});

test('sub agent 額度用完 → 換一家重跑，上層改收新的結果', async () => {
  const { orch, cwd } = setup();
  let targets;
  let second;
  fakeAgents(orch, {
    subagent: [{ error: 'You exceeded your current quota, please check your plan and billing details' }, async () => undefined],
    executor: [
      async (o, secret) => {
        const run = [...o.runs.values()].at(-1);
        const first = JSON.parse(await o.callTool(secret, 'spawn_subagent', { provider: 'fake', title: 'write tests', task: 'Write the tests.' })).subagent_id;
        const r1 = JSON.parse((await o.callTool(secret, 'wait_subagent', { subagent_id: first, timeout_sec: 5 })).split('\n\nAIVENUE NOTICE')[0]);
        assert.equal(r1.status, 'failed');
        assert.equal(r1.failure, 'quota');
        targets = o.switchTargets(run.id, first); // 使用者打開 ⇄
        o.rerunAgent(run.id, first, 'fake2'); // 使用者選了 fake2
        second = Object.values(run.agents).find((a) => a.rerunOf === first);
        await o.callTool(secret, 'wait_subagent', { subagent_id: second.id, timeout_sec: 5 });
        await o.callTool(secret, 'submit_work', { summary: 'done' });
      },
    ],
  });
  const r = await settle(orch, orch.start(config(cwd, { verify: undefined, plan: { enabled: false, author: { provider: 'fake' }, reviewer: null, maxRounds: 1, humanGate: false }, subagents: { enabled: true, allowed: ['fake', 'fake2'], maxDepth: 1, maxConcurrent: 3 } })).id);
  assert.equal(r.status, 'completed', r.error);
  assert.deepEqual(targets.map((x) => [x.id, x.quota]), [['fake2', 'ok']]);
  assert.equal(second.provider, 'fake2');
  assert.equal(second.title, 'write tests');
  assert.equal(r.agents[second.id].status, 'completed');
});

test('審查來回留空＝無上限：超過以前的上限也不會停下來問', async () => {
  const { orch, cwd } = setup();
  const revise = { tool: 'submit_review', args: { verdict: 'revise', summary: 'no', issues: [{ id: 'R1', severity: 'minor', title: 'nit' }] } };
  const fixes = Array.from({ length: 7 }, (_, i) => ({ tool: 'submit_work', args: { summary: `fix ${i}`, responses: [{ issue_id: 'R1', action: 'fixed' }] } }));
  // 每一輪問題都不同，不會觸發「同一問題」規則；只看輪數上限。
  const reviews = Array.from({ length: 7 }, (_, i) => ({ ...revise, args: { ...revise.args, issues: [{ id: 'R1', severity: 'minor', title: `nit ${i}` }] } }));
  fakeAgents(orch, { code_reviewer: [...reviews, defaults.code_reviewer], executor: [defaults.executor, ...fixes] });
  const r = await settle(orch, orch.start(config(cwd, { verify: undefined, plan: { enabled: false, author: { provider: 'fake' }, reviewer: null, maxRounds: 1, humanGate: false }, implement: { enabled: true, author: { provider: 'fake' }, reviewer: { provider: 'fake2' }, maxRounds: 0, humanGate: false } })).id);
  assert.equal(r.status, 'completed', r.error);
  assert.equal(r.stages.implement.rounds.length, 8);
});

test('重新診斷門檻留空＝無上限：同一缺陷一直退回實作者，不強制交回計畫者', async () => {
  const { orch, cwd } = setup();
  const same = verdict('defect', false, [{ id: 'V1', severity: 'major', title: 'Crash on empty input' }]);
  fakeAgents(orch, { verifier: verify(same, same, same, same, verdict('met', true)) });
  const r = await settle(orch, orch.start(config(cwd, { verify: { enabled: true, by: 'planner', repeatLimit: 0 } })).id);
  assert.equal(r.status, 'completed', r.error);
  assert.deepEqual(routes(r), ['implementer', 'implementer', 'implementer', 'implementer', 'done']);
  assert.equal(r.stages.plan.rounds.length, 1);
});

test('執行中追加訊息：agent 先回覆；改變需求時計畫者更新計畫，實作者照新計畫繼續', async () => {
  const { orch, cwd } = setup();
  const prompts = [];
  // Works until Aivenue stops it (a mid-run message, or after reply_user asked for a plan update).
  const untilStopped = (o) => new Promise((res) => (o.signal.aborted ? res() : o.signal.addEventListener('abort', () => res(), { once: true })));
  const stopped = (o) => ({ lastSeq: (o.seqStart ?? 0) + 1, exitCode: 1, resumed: false, finalText: '', error: 'aborted' });
  let runId;
  fakeAgents(orch, {
    planner: [
      defaults.planner,
      async (o, secret, a) => {
        prompts.push(a.prompt);
        await o.callTool(secret, 'submit_plan', { summary: 'plan v2', markdown: 'plan v2', steps: [{ id: '1', title: 'do it' }, { id: '2', title: 'add dark mode' }], goal });
      },
    ],
    executor: [
      async (o, secret, a) => {
        setTimeout(() => o.interject(runId, 'Also add dark mode'), 100);
        await untilStopped(a);
        return stopped(a);
      },
      async (o, secret, a) => {
        prompts.push(a.prompt);
        await o.callTool(secret, 'reply_user', { text: 'Got it: dark mode needs a new step.', changes_plan: true });
        await untilStopped(a);
        return stopped(a);
      },
      async (o, secret, a) => {
        prompts.push(a.prompt);
        await o.callTool(secret, 'submit_work', { summary: 'done with dark mode' });
      },
    ],
  });
  runId = orch.start(config(cwd, { verify: undefined, plan: { enabled: true, author: { provider: 'fake' }, reviewer: null, maxRounds: 1, humanGate: false } })).id;
  const r = await settle(orch, runId);
  assert.equal(r.status, 'completed', r.error);
  const [answer, amend, after] = prompts;
  assert.match(answer, /THE USER SENT YOU A MESSAGE[\s\S]*Also add dark mode[\s\S]*reply_user/);
  assert.match(amend, /changes the task[\s\S]*Also add dark mode/);
  assert.match(after, /THE PLAN WAS UPDATED[\s\S]*add dark mode/);
  const m = r.userMessages[0];
  assert.equal(m.replies?.length, 1);
  assert.equal(m.replies[0].changesPlan, true);
  assert.match(m.replies[0].text, /dark mode/);
  assert.equal(m.planUpdated, true);
  assert.deepEqual(r.steps.map((x) => x.title), ['do it', 'add dark mode']);
});

test('CLI 自己壓縮對話：記下實際上限、交還它做過的事；輪詢提示改用 wait_for；findings 成為共用事實', async () => {
  const { orch, cwd } = setup();
  const seen = [];
  let n = 0;
  const tool = (o, title, output) => o.onEvent({ seq: ++n, ts: Date.now(), kind: 'tool', tool: { id: `t${n}`, name: 'bash', category: 'command', title, output, status: 'ok' } }, false);
  const used = (o, tokens) => o.onEvent({ seq: ++n, ts: Date.now(), kind: 'message', text: '…', context: { used: tokens, window: 1000000 } }, false);
  fakeAgents(orch, {
    executor: [
      async (o, secret, a) => {
        tool(a, 'cat src/model.py', 'class Model: pass');
        used(a, 170000);
        used(a, 30000); // its CLI compacted the conversation
        seen.push(await o.callTool(secret, 'post_note', { text: 'checked the data', kind: 'fact' }));
        tool(a, 'until [ -f done.txt ]; do sleep 5; done', '');
        seen.push(await o.callTool(secret, 'post_note', { text: 'waited', kind: 'fact' }));
        await o.callTool(secret, 'submit_work', { summary: 'done', findings: ['The dataset lives in data/aishell (16 kHz wav).'] });
      },
    ],
  });
  const r = await settle(orch, orch.start(config(cwd, { verify: undefined, plan: { enabled: false, author: { provider: 'fake' }, reviewer: null, maxRounds: 1, humanGate: false } })).id);
  assert.equal(r.status, 'completed', r.error);
  assert.match(seen[0], /YOUR OWN WORK BEFORE YOUR CONVERSATION WAS COMPACTED[\s\S]*src\/model\.py[\s\S]*class Model/);
  assert.match(seen[1], /wait_for/);
  assert.match(seen[0], /CHECKPOINT/);
  assert.deepEqual(Object.values(r.compactPoints ?? {}), [170000]);
  assert.ok(r.notes.some((x) => x.kind === 'fact' && /data\/aishell/.test(x.text)));
  assert.ok(r.log.some((l) => /自己壓縮了對話/.test(l.text)));
});

test('agent 自己在背景開的程序：沒有 track_process 也會被找到並追蹤', async () => {
  const { orch, cwd } = setup();
  const script = path.join(cwd, 'aivenue-slowjob.js');
  fs.writeFileSync(script, 'setTimeout(() => {}, 60000);');
  const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore' });
  child.unref();
  let found;
  let bgRun;
  let refused;
  let registered;
  fakeAgents(orch, {
    executor: [
      async (o, secret, a) => {
        a.onEvent({ seq: 1, ts: Date.now(), kind: 'tool', tool: { id: 'bg1', name: 'bash', category: 'command', title: 'nohup node aivenue-slowjob.js > slow.log 2>&1 &', output: '', status: 'ok' } }, false);
        const run = o.runs.get(bgRun);
        for (let i = 0; i < 120 && !found; i++) {
          found = (run.processes ?? []).find((p) => p.detected);
          if (!found) await new Promise((res) => setTimeout(res, 250));
        }
        // Not registered yet: the submission is refused, naming the job.
        refused = await o.callTool(secret, 'submit_work', { summary: 'done' }).then(() => '', (e) => e.message);
        await o.callTool(secret, 'track_process', { pid: found.pid, purpose: 'slow job', cleanup: 'aivenue', log: 'slow.log' });
        registered = run.processes.find((p) => p.pid === found.pid);
        await o.callTool(secret, 'submit_work', { summary: 'done' });
      },
    ],
  });
  try {
    bgRun = orch.start(config(cwd, { verify: undefined, plan: { enabled: false, author: { provider: 'fake' }, reviewer: null, maxRounds: 1, humanGate: false } })).id;
    const r = await settle(orch, bgRun, 60000);
    assert.equal(r.status, 'completed', r.error);
    assert.ok(found, 'not detected');
    assert.equal(found.pid, child.pid);
    assert.equal(found.log, 'slow.log');
    assert.equal(found.cleanup, 'keep');
    assert.match(refused, /Register your background jobs[\s\S]*PID \d+/);
    assert.equal(registered.purpose, 'slow job');
    assert.equal(registered.detected, undefined);
  } finally {
    try {
      process.kill(child.pid);
    } catch {}
  }
});

test('別的 agent 跑過、檔案也沒改過的指令又跑一次：提醒先查共享上下文', async () => {
  const { orch, cwd } = setup();
  let reply;
  let n = 100;
  const tool = (a, title) => a.onEvent({ seq: ++n, ts: Date.now(), kind: 'tool', tool: { id: `t${n}`, name: 'bash', category: 'command', title, output: '20 passed', status: 'ok' } }, false);
  fakeAgents(orch, {
    executor: [
      async (o, secret, a) => {
        tool(a, 'pytest -q');
        await o.callTool(secret, 'submit_work', { summary: 'done' });
      },
    ],
    code_reviewer: [
      async (o, secret, a) => {
        tool(a, 'cd /proj && pytest -q');
        reply = await o.callTool(secret, 'submit_review', { verdict: 'approve', summary: 'ok', issues: [] });
      },
    ],
  });
  const r = await settle(orch, orch.start(config(cwd, { verify: undefined, plan: { enabled: false, author: { provider: 'fake' }, reviewer: null, maxRounds: 1, humanGate: false } })).id);
  assert.equal(r.status, 'completed', r.error);
  assert.match(reply, /already did this[\s\S]*pytest -q[\s\S]*search_records/);
});

test('整理員：新筆記滿門檻就依主題整理，附出處；漏掉的逐字保留；read_context {topic} 拿得到', async () => {
  const { orch, cwd } = setup();
  let topic;
  let librarianPrompt;
  fakeAgents(orch, {
    executor: [
      async (o, secret) => {
        await o.callTool(secret, 'post_note', { text: 'Python 3.11 and torch 2.5 are installed', kind: 'fact' });
        await o.callTool(secret, 'post_note', { text: 'We keep 16 kHz audio', kind: 'decision' });
        await o.callTool(secret, 'submit_work', { summary: 'done', findings: ['The dataset is in data/aishell'] });
      },
    ],
    code_reviewer: [
      async (o, secret) => {
        // The librarian ran when the implementer's turn ended.
        for (let i = 0; i < 100 && !topic?.includes('Environment'); i++) {
          topic = await o.callTool(secret, 'read_context', { topic: 'knowledge' });
          if (!topic.includes('Environment')) await new Promise((r) => setTimeout(r, 50));
        }
        await o.callTool(secret, 'submit_review', { verdict: 'approve', summary: 'ok', issues: [] });
      },
    ],
    librarian: [
      async (o, secret, a) => {
        librarianPrompt = a.prompt;
        const ids = [...a.prompt.matchAll(/\[n:(\w+)\]/g)].map((m) => m[1]);
        // Cites the first two notes only: the third must be kept word for word.
        return { lastSeq: 1, exitCode: 0, resumed: false, finalText: `## Environment and versions\n- Python 3.11, torch 2.5 [n:${ids[0]}]\n\n## Decisions\n- 16 kHz audio [n:${ids[1]}]` };
      },
    ],
  });
  const r = await settle(orch, orch.start(config(cwd, { verify: undefined, plan: { enabled: false, author: { provider: 'fake' }, reviewer: null, maxRounds: 1, humanGate: false }, context: { organizeEvery: 3 } })).id);
  assert.equal(r.status, 'completed', r.error);
  assert.match(librarianPrompt, /Python 3\.11[\s\S]*16 kHz[\s\S]*data\/aishell/);
  assert.match(topic, /SHARED KNOWLEDGE[\s\S]*## Environment and versions[\s\S]*## Not sorted yet[\s\S]*data\/aishell/);
  assert.equal(r.knowledge.notes, 3);
  assert.equal(r.notes.length, 3);
});

test('壓縮者額度用完：錯誤訊息不會被當成整理結果，問使用者換別的 agent，換了就重做', async () => {
  const { orch, cwd } = setup();
  let calls = 0;
  fakeAgents(orch, {
    executor: [
      async (o, secret) => {
        await o.callTool(secret, 'post_note', { text: 'Python 3.11 is installed', kind: 'fact' });
        await o.callTool(secret, 'submit_work', { summary: 'done' });
      },
    ],
    librarian: [
      // Claude Code out of quota: the error also comes back as the reply text.
      async () => (calls++, { lastSeq: 1, exitCode: 1, resumed: false, finalText: "You've hit your 5-hour limit", error: "You've hit your 5-hour limit" }),
      async (o, secret, a) => {
        calls++;
        const id = a.prompt.match(/\[n:(\w+)\]/)[1];
        return { lastSeq: 1, exitCode: 0, resumed: false, finalText: `## Environment and versions\n- Python 3.11 [n:${id}]` };
      },
    ],
  });
  const r = await settle(orch, orch.start(config(cwd, { verify: undefined, plan: { enabled: false, author: { provider: 'fake' }, reviewer: null, maxRounds: 1, humanGate: false }, context: { organizeEvery: 0, compactor: { provider: 'fake' } } })).id);
  assert.equal(r.status, 'completed', r.error);
  await orch.organizeNow(r);
  assert.equal(r.knowledge, undefined);
  assert.equal(r.compactFailed?.job, 'organize');
  assert.equal(r.compactFailed?.provider, 'fake');
  assert.match(r.compactFailed?.error ?? '', /5-hour limit/);
  assert.equal(Object.values(r.agents).find((a) => a.role === 'compactor').status, 'failed');

  orch.answerCompactFailed(r.id, { provider: 'fake2' });
  assert.equal(r.compactFailed, undefined);
  assert.deepEqual(r.config.context.compactor, { provider: 'fake2' });
  await orch.organizeNow(r);
  assert.match(r.knowledge?.doc ?? '', /Python 3\.11/);
  assert.equal(calls, 2);
});

test('GPU 鎖住的卡上有沒人登記的程序：自動當成鎖卡的 agent 的背景程序', async () => {
  const job = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
  job.unref();
  const smi = (args) =>
    args[0].startsWith('--query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature')
      ? '0, NVIDIA GeForce RTX 5090, 11000, 32607, 100, 69, 447, 00000000:01:00.0\n'
      : args[0].startsWith('--query-compute-apps')
        ? `00000000:01:00.0, ${job.pid}, python, 10300\n`
        : '';
  const { orch, cwd } = setup({ gpuQuery: () => '0, NVIDIA GeForce RTX 5090, 500, 32607, 0\n', gpuSmi: smi });
  let found;
  let rid;
  fakeAgents(orch, {
    executor: [
      async (o, secret) => {
        await o.callTool(secret, 'gpu_acquire', { count: 1 });
        // The job was started by a script, so nothing in the commands says so: the watchdog finds it on the card.
        const run = o.runs.get(rid);
        o.watch(run);
        for (let i = 0; i < 100 && !found; i++) {
          found = (run.processes ?? []).find((p) => p.detected);
          if (!found) await new Promise((r) => setTimeout(r, 100));
        }
        await o.callTool(secret, 'track_process', { pid: found.pid, purpose: 'train', cleanup: 'keep' });
        await o.callTool(secret, 'submit_work', { summary: 'trained' });
      },
    ],
  });
  try {
    rid = orch.start(config(cwd, { verify: undefined, plan: { enabled: false, author: { provider: 'fake' }, reviewer: null, maxRounds: 1, humanGate: false } })).id;
    const r = await settle(orch, rid);
    assert.equal(r.status, 'completed', r.error);
    assert.ok(found, 'not adopted');
    assert.equal(found.pid, job.pid);
    assert.match(found.purpose, /^GPU 0: /);
    assert.equal(found.agentId, Object.values(r.agents).find((a) => a.role === 'executor').id);
  } finally {
    try {
      process.kill(job.pid);
    } catch {}
  }
});

test('Aivenue 重新啟動（更新）後：工作流從中斷的輪次接續，審查要求的修正直接交給實作者', async () => {
  const first = setup();
  const issue = { id: 'R1', severity: 'major', title: 'missing null check' };
  let cutOff;
  const hung = new Promise((r) => (cutOff = r));
  fakeAgents(first.orch, {
    code_reviewer: [{ tool: 'submit_review', args: { verdict: 'revise', summary: 'fix it', issues: [issue] } }, defaults.code_reviewer],
    executor: [
      defaults.executor,
      // Fixing R1 when Aivenue is closed: this turn never ends.
      async () => {
        cutOff();
        await new Promise(() => {});
      },
    ],
  });
  const id = first.orch.start(config(first.cwd, { verify: undefined, plan: { enabled: false, author: { provider: 'fake' }, reviewer: null, maxRounds: 1, humanGate: false } })).id;
  await hung;
  first.orch.d.store.saveNow(first.orch.runs.get(id));

  // A new Aivenue on the same data folder.
  const second = setup({ dir: first.dir });
  const loaded = second.orch.runs.get(id);
  assert.equal(loaded.status, 'interrupted');
  assert.equal(loaded.interruptedFrom, 'running');
  const prompts = [];
  fakeAgents(second.orch, {
    executor: [
      async (o, secret, a) => {
        prompts.push(a.prompt);
        await o.callTool(secret, 'submit_work', { summary: 'fixed R1', responses: [{ issue_id: 'R1', action: 'fixed' }] });
      },
    ],
  });
  assert.deepEqual(second.orch.autoResume(), [id]);
  const r = await settle(second.orch, id);
  assert.equal(r.status, 'completed', r.error);
  assert.match(prompts[0], /AIVENUE WAS RESTARTED[\s\S]*R1[\s\S]*missing null check/);
  // Round 1 (reviewed) is kept; the round that was cut off is done again as round 2.
  assert.equal(r.stages.implement.rounds.length, 2);
  assert.equal(r.stages.implement.rounds[0].review.verdict, 'revise');
  assert.equal(r.stages.implement.rounds[1].review.verdict, 'approve');
  assert.equal(r.resumes, 1);
  // The shared context shows where it stands, also after the restart.
  assert.match(prompts[0], /NOW: implementation stage[\s\S]*Resumed 1 time/);
});

test('暫停的工作流在重新啟動後不會自動接續，按「繼續」才接著做', async () => {
  const first = setup();
  let started;
  const going = new Promise((r) => (started = r));
  fakeAgents(first.orch, {
    executor: [
      async () => {
        started();
        await new Promise(() => {});
      },
    ],
  });
  const id = first.orch.start(config(first.cwd, { verify: undefined, plan: { enabled: false, author: { provider: 'fake' }, reviewer: null, maxRounds: 1, humanGate: false } })).id;
  await going;
  first.orch.pause(id);
  first.orch.d.store.saveNow(first.orch.runs.get(id));
  const second = setup({ dir: first.dir });
  assert.equal(second.orch.runs.get(id).interruptedFrom, 'paused');
  assert.deepEqual(second.orch.autoResume(), []);
  fakeAgents(second.orch, {});
  second.orch.resumeInterrupted(id);
  const r = await settle(second.orch, id);
  assert.equal(r.status, 'completed', r.error);
});

test('出問題時的詢問可以暫停工作流；按繼續就重試', async () => {
  const { orch, cwd } = setup();
  fakeAgents(orch, { executor: [{ error: "You've hit your 5-hour limit · resets 7:30pm (UTC) (exit code 1)" }, { error: 'still limited (exit code 1)' }, defaults.executor] });
  const id = orch.start(config(cwd, { verify: undefined, plan: { enabled: false, author: { provider: 'fake' }, reviewer: null, maxRounds: 1, humanGate: false } })).id;
  let r = await settle(orch, id);
  for (let i = 0; i < 200 && !r.pending; i++) await new Promise((res) => setTimeout(res, 50));
  assert.ok(r.pending.options.some((o) => o.id === 'pause'), JSON.stringify(r.pending.options));
  orch.decide(id, r.pending.id, 'pause');
  for (let i = 0; i < 100 && r.status !== 'paused'; i++) await new Promise((res) => setTimeout(res, 20));
  assert.equal(r.status, 'paused');
  orch.resume(id, 'quota is back');
  r = await settle(orch, id);
  // The retry ran; a question about the next failure may come up again, so answer it with retry until done.
  for (let i = 0; i < 5 && r.status === 'waiting_human'; i++) {
    orch.decide(id, r.pending.id, 'retry');
    r = await settle(orch, id);
  }
  assert.equal(r.status, 'completed', r.error);
});
