// The cost breakdown's "by model" grouping (packages/core/src/promptStats.ts costBreakdown().models): one row per
// provider (account included) and model, the roles each played with how many agents, upkeep under its own label, the
// test role skipped, and a model changed mid-run counted under the last model and marked.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { test } from './lib/test-shard.mjs';

const out = await build({ entryPoints: ['packages/core/src/promptStats.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
const mod = { exports: {} };
new Function('require', 'module', 'exports', out.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const { costBreakdown } = mod.exports;

const ag = (id, role, provider, model, o = {}) => ({
  id,
  role,
  provider,
  model,
  task: o.task ?? '',
  stage: o.stage,
  modelDefault: o.modelDefault,
  snapshot: o.snapshot,
  startedAt: 1,
  endedAt: 1 + (o.ms ?? 1000),
  stats: {},
  observed: { uncachedInput: 100, cachedInput: 50, output: 10, events: 1, costUsd: 0.01 },
});

test('依模型：同一家同一模型合成一列，列出擔任的角色與次數；帳號是供應商 id 的一部分', () => {
  const run = {
    id: 'r',
    createdAt: 0,
    endedAt: 5000,
    agents: {
      a: ag('a', 'planner', 'opencode', 'opencode/big-pickle', { stage: 'plan', ms: 2000 }),
      b: ag('b', 'planner', 'opencode', 'opencode/big-pickle', { stage: 'plan' }),
      c: ag('c', 'subagent', 'opencode', 'opencode/big-pickle'),
      d: ag('d', 'executor', 'codex~oscarhshiah', 'gpt-6-luna', { stage: 'implement' }),
      e: ag('e', 'compactor', 'opencode', 'opencode/big-pickle', { task: '壓縮共享上下文' }),
      f: ag('f', 'compactor', 'opencode', 'opencode/big-pickle', { task: '整理 12 則共用筆記' }),
      t: ag('t', 'test', 'opencode', 'opencode/big-pickle'),
    },
  };
  const c = costBreakdown(run, 5000);
  assert.deepEqual(c.models.map((m) => m.key), ['opencode|opencode/big-pickle|', 'codex~oscarhshiah|gpt-6-luna|']);
  const oc = c.models[0];
  assert.equal(oc.agents, 5, 'the test role is skipped');
  assert.deepEqual(oc.roles.map((r) => `${r.key}×${r.count}`), ['planner×2', 'subagent×1', 'compaction×1', 'librarian×1']);
  assert.equal(oc.agentMs, 2000 + 4 * 1000);
  assert.equal(oc.observed.uncachedInput, 500);
  assert.equal(oc.observed.output, 50);
  assert.equal(c.models[1].provider, 'codex~oscarhshiah');
  assert.deepEqual(c.models[1].roles, [{ key: 'executor', role: 'executor', count: 1 }]);
  assert.equal(c.models.reduce((n, m) => n + m.agents, 0), c.rows.reduce((n, r) => n + r.agents, 0), 'the same agents as the role table');
  assert.ok(c.models.every((m) => !m.changed));
});

test('依模型：預設模型另成一列並標記；中途換過模型的 agent 算在最後的模型，該列標「中途換過模型」', () => {
  const run = {
    id: 'r',
    createdAt: 0,
    endedAt: 3000,
    agents: {
      a: ag('a', 'executor', 'claude', 'sonnet', { modelDefault: true }),
      b: ag('b', 'code_reviewer', 'claude', 'sonnet'),
      c: ag('c', 'executor', 'claude', 'opus', { snapshot: { at: 0, model: 'sonnet', skills: [], userMessages: 0 } }),
    },
  };
  const c = costBreakdown(run, 3000);
  const byKey = Object.fromEntries(c.models.map((m) => [m.key, m]));
  assert.equal(byKey['claude|sonnet|default'].modelDefault, true);
  assert.equal(byKey['claude|sonnet|'].modelDefault, undefined);
  assert.equal(byKey['claude|opus|'].changed, true, 'last model opus, started on sonnet');
  assert.equal(byKey['claude|opus|'].observed.uncachedInput, 100, 'all its tokens under its last model');
  assert.equal(byKey['claude|sonnet|'].changed, undefined);
});
