// `test` for the repository's test files, so scripts/run-tests.mjs can split one file across several processes.
// Run plainly (`node --test scripts/test-x.mjs`) every test is registered as usual. Under the runner:
//   AIVENUE_TEST_SHARD=i/n      this process registers every n-th test starting at i (round robin, so slow
//                               neighbours land in different processes);
//   AIVENUE_TEST_PHASE=parallel tests marked { exclusive: true } are left out;
//   AIVENUE_TEST_PHASE=exclusive only those tests run (the runner starts them alone, after the parallel phase).
// Mark a test exclusive when it must not share the machine with other tests: it scans every process on the
// computer, or it judges a lock by timing.
import { test as base } from 'node:test';

const [shard, shards] = (process.env.AIVENUE_TEST_SHARD ?? '0/1').split('/').map(Number);
const phase = process.env.AIVENUE_TEST_PHASE;
let seen = 0;

export function test(name, opts, fn) {
  if (typeof opts === 'function') [fn, opts] = [opts, {}];
  const { exclusive, ...rest } = opts ?? {};
  if (phase === 'exclusive') return exclusive ? base(name, rest, fn) : undefined;
  if (phase === 'parallel' && exclusive) return undefined;
  if (seen++ % shards !== shard) return undefined;
  return base(name, rest, fn);
}
for (const k of ['skip', 'todo', 'only', 'before', 'after', 'beforeEach', 'afterEach', 'mock']) test[k] = base[k];
