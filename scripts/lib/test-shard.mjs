// `test` for the repository's test files, so scripts/run-tests.mjs can split one file across several processes.
// Run plainly (`node --test scripts/test-x.mjs`) every test is registered as usual. Under the runner:
//   AIVENUE_TEST_SHARD=i/n      this process registers every n-th test starting at i (round robin, so slow
//                               neighbours land in different processes);
//   AIVENUE_TEST_PHASE=parallel tests marked { exclusive: true } are left out;
//   AIVENUE_TEST_PHASE=exclusive only those tests run (the runner starts them alone, after the parallel phase);
//   AIVENUE_TEST_REPORT=<file>  on exit, write the names of the tests this process registered and how many exclusive
//                               tests the file has. The runner plans from these, never from the source text, so a
//                               comment or a test made in a loop cannot change what runs.
// test.skip, test.todo and test.only take the same path as test, so each is registered by exactly one process and
// the totals match a plain run. `only` keeps node's meaning: ignored unless --test-only is given (the runner passes
// that flag on to every process), then only those tests run.
// Mark a test exclusive when it must not share the machine with other tests: it scans every process on the
// computer, or it judges a lock by timing. Options go in one object: test(name, { exclusive: true, skip }, fn).
import * as fs from 'node:fs';
import { test as base } from 'node:test';

// "i/n" with whole numbers, 0 <= i < n. Anything else would make tests vanish from every process, so it stops the file.
const spec = process.env.AIVENUE_TEST_SHARD ?? '0/1';
const m = /^(\d+)\/([1-9]\d*)$/.exec(spec);
if (!m || Number(m[1]) >= Number(m[2])) throw new Error(`AIVENUE_TEST_SHARD must be i/n with whole numbers and i < n, not "${spec}"`);
const [shard, shards] = [Number(m[1]), Number(m[2])];
const phase = process.env.AIVENUE_TEST_PHASE;
if (phase !== undefined && phase !== 'parallel' && phase !== 'exclusive') throw new Error(`AIVENUE_TEST_PHASE must be parallel or exclusive, not "${phase}"`);
// Meant for this process only: a test that starts other node processes must not have them write over it.
const report = process.env.AIVENUE_TEST_REPORT;
delete process.env.AIVENUE_TEST_REPORT;
let seen = 0;
let registered = 0;
let exclusives = 0;
const names = [];
if (report) process.on('exit', () => fs.writeFileSync(report, JSON.stringify({ registered, exclusives, names })));

function register(method, name, ...rest) {
  // node's own forms: (name), (name, fn), (name, options), (name, options, fn). Anything longer, or a function slot
  // holding something else, would leave the test without its body and let it pass without running.
  if (rest.length > 2 || (rest.length === 2 && typeof rest[1] !== 'function') || (rest.length === 2 && (rest[0] === null || typeof rest[0] !== 'object'))) {
    throw new TypeError(`test "${name}": expected (name, options, fn); put every option in one object`);
  }
  let [opts, fn] = rest;
  if (typeof opts === 'function') [fn, opts] = [opts, {}];
  const { exclusive, ...options } = opts ?? {};
  if (exclusive) exclusives++;
  if (phase === 'exclusive' && !exclusive) return undefined;
  if (phase === 'parallel' && exclusive) return undefined;
  if (phase !== 'exclusive' && seen++ % shards !== shard) return undefined;
  registered++;
  names.push(String(name));
  return fn === undefined ? method(name, options) : method(name, options, fn);
}

export function test(name, ...rest) {
  return register(base, name, ...rest);
}
test.skip = (name, ...rest) => register(base.skip, name, ...rest);
test.todo = (name, ...rest) => register(base.todo, name, ...rest);
test.only = (name, ...rest) => register(base.only, name, ...rest);
// Hooks run in every process that has tests of this file (e.g. test.after cleans up that process's work).
for (const k of ['before', 'after', 'beforeEach', 'afterEach', 'mock']) test[k] = base[k];
