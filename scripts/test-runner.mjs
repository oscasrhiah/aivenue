import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { test } from './lib/test-shard.mjs';

// scripts/run-tests.mjs and scripts/lib/test-shard.mjs: a file split across processes reports the same tests, with
// the same status, as a plain node --test run of it.
const fixture = path.join('scripts', 'lib', 'fixtures', 'shard-sample.mjs');
// Without NODE_TEST_CONTEXT, which node sets for a test file's own children and which changes how they report.
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AIVENUE_TEST_') && k !== 'NODE_TEST_CONTEXT'));
const totals = (out) => Object.fromEntries(['tests', 'pass', 'fail', 'skipped', 'todo'].map((k) => [k, Number(out.match(new RegExp(`^ℹ ${k} (\\d+)`, 'm'))?.[1] ?? -1)]));
// "name → status" for each test line of the spec reporter (✔ pass, ✖ fail, ﹣ skip; "# TODO" marks a todo).
const statuses = (out) =>
  Object.fromEntries(
    [...out.matchAll(/^\s*([✔✖﹣]) (.+?) \([\d.]+ms\)( # (SKIP|TODO))?\s*$/gm)].map((m) => [m[2], m[4] ? m[4].toLowerCase() : m[1] === '✔' ? 'pass' : m[1] === '✖' ? 'fail' : 'skip']),
  );
function plain(flags = [], file = fixture) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...flags, file], { encoding: 'utf8', env: clean() });
  return { code: r.status, out: r.stdout + r.stderr, totals: totals(r.stdout + r.stderr), statuses: statuses(r.stdout + r.stderr) };
}
function runner(jobs, shards, flags = [], file = fixture) {
  const env = { ...clean(), AIVENUE_TEST_JOBS: String(jobs), AIVENUE_TEST_VERBOSE: '1' };
  if (shards !== undefined) env.AIVENUE_TEST_SHARDS = String(shards);
  const r = spawnSync(process.execPath, [path.join('scripts', 'run-tests.mjs'), ...flags, file], { encoding: 'utf8', env });
  const out = r.stdout + r.stderr;
  return { code: r.status, out, totals: totals(out.slice(out.lastIndexOf('ℹ tests'))), statuses: statuses(out) };
}

test('平行測試：一般、skip、todo、only 與獨佔測試，直接執行、單核心、多核心的測試數與每項狀態都一樣', () => {
  const want = plain();
  assert.deepEqual(want.totals, { tests: 11, pass: 6, fail: 0, skipped: 3, todo: 2 });
  for (const [jobs, shards] of [[1, 1], [1, 3], [4, 4], [8, 11]]) {
    const got = runner(jobs, shards);
    assert.equal(got.code, 0, `${jobs} jobs, ${shards} shards`);
    assert.deepEqual(got.totals, want.totals, `${jobs} jobs, ${shards} shards: totals`);
    assert.deepEqual(got.statuses, want.statuses, `${jobs} jobs, ${shards} shards: each test`);
  }
});

test('平行測試：--test-only 交給每個程序，只跑 only 的測試，和直接執行一樣', () => {
  const want = plain(['--test-only']);
  assert.deepEqual(Object.keys(want.statuses).sort(), ['h test.only', 'i only option']);
  for (const [jobs, shards] of [[1, 1], [4, 4]]) {
    const got = runner(jobs, shards, ['--test-only']);
    assert.equal(got.code, 0);
    assert.deepEqual(got.totals, want.totals, `${jobs} jobs, ${shards} shards: totals`);
    assert.deepEqual(got.statuses, want.statuses, `${jobs} jobs, ${shards} shards: each test`);
  }
});

test('平行測試：只有獨佔測試的檔案直接進獨佔階段，直接執行、單核心、多核心都只有 1 項通過', () => {
  const file = path.join('scripts', 'lib', 'fixtures', 'exclusive-only.mjs');
  const want = plain([], file);
  assert.deepEqual(want.totals, { tests: 1, pass: 1, fail: 0, skipped: 0, todo: 0 });
  for (const [jobs, shards] of [[1, undefined], [4, undefined], [4, 3]]) {
    const got = runner(jobs, shards, [], file);
    assert.equal(got.code, 0, `${jobs} jobs, ${shards ?? 'auto'} shards`);
    assert.deepEqual(got.totals, want.totals, `${jobs} jobs, ${shards ?? 'auto'} shards: totals`);
    assert.deepEqual(got.statuses, want.statuses, `${jobs} jobs, ${shards ?? 'auto'} shards: each test`);
  }
});

test('平行測試：拆分數或同時程序數不是正整數時直接失敗並說明，不會漏跑測試卻回報成功', () => {
  for (const [name, value] of [['AIVENUE_TEST_SHARDS', '1.5'], ['AIVENUE_TEST_SHARDS', '0'], ['AIVENUE_TEST_SHARDS', 'abc'], ['AIVENUE_TEST_JOBS', '2.5']]) {
    const r = spawnSync(process.execPath, [path.join('scripts', 'run-tests.mjs'), fixture], { encoding: 'utf8', env: { ...clean(), [name]: value } });
    assert.equal(r.status, 2, `${name}=${value}`);
    assert.match(r.stderr, new RegExp(`${name} must be a whole number`));
    assert.doesNotMatch(r.stdout, /ℹ tests/, 'nothing ran');
  }
  // The shard wrapper refuses a malformed split of its own, so a file run by hand with one fails instead of shrinking.
  for (const value of ['0/1.5', '2/2', 'x']) {
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', fixture], { encoding: 'utf8', env: { ...clean(), AIVENUE_TEST_SHARD: value } });
    assert.notEqual(r.status, 0, `AIVENUE_TEST_SHARD=${value}`);
    assert.match(r.stdout + r.stderr, /AIVENUE_TEST_SHARD must be i\/n/);
  }
});

test('平行測試：分片與獨佔階段依實際登記的測試決定，註解、迴圈或簡寫都不會讓測試漏跑、失敗變成通過', () => {
  const fixtures = {
    // Only a comment mentions exclusive: true; the one test is ordinary and fails.
    'comment-exclusive.mjs': { tests: 1, pass: 0, fail: 1, skipped: 0, todo: 0 },
    // Three tests made in a loop and a failing exclusive one named by shorthand: no line a source scan would find.
    'hidden-from-source.mjs': { tests: 4, pass: 3, fail: 1, skipped: 0, todo: 0 },
  };
  for (const [name, totals] of Object.entries(fixtures)) {
    const file = path.join('scripts', 'lib', 'fixtures', name);
    const want = plain([], file);
    assert.equal(want.code, 1, `${name}: plain`);
    assert.deepEqual(want.totals, totals, `${name}: plain`);
    for (const [jobs, shards] of [[1, undefined], [4, undefined], [4, 3]]) {
      const got = runner(jobs, shards, [], file);
      const at = `${name}, ${jobs} jobs, ${shards ?? 'auto'} shards`;
      assert.equal(got.code, 1, at);
      assert.deepEqual(got.totals, want.totals, `${at}: totals`);
      assert.deepEqual(got.statuses, want.statuses, `${at}: each test`);
    }
  }
});

test('平行測試：選項拆成兩個物件、或檔案沒用分片包裝時直接失敗，不會讓測試沒跑本體就通過', () => {
  // test(name, { exclusive: true }, { skip }, fn): node would take the second object as the body and pass the test.
  const split = path.join('scripts', 'lib', 'fixtures', 'extra-argument.mjs');
  const want = plain([], split);
  assert.equal(want.code, 1);
  assert.match(want.out, /put every option in one object/);
  for (const jobs of [1, 4]) {
    const got = runner(jobs, undefined, [], split);
    assert.equal(got.code, 1, `${jobs} jobs`);
    assert.match(got.out, /put every option in one object/);
  }
  // A file taking test straight from node:test would run whole in every process it is split into.
  const bare = path.join('scripts', 'lib', 'fixtures', 'no-wrapper.mjs');
  const got = runner(4, undefined, [], bare);
  assert.equal(got.code, 1);
  assert.match(got.out, /does not take `test` from scripts\/lib\/test-shard\.mjs/);
});
