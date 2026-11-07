// Fixture for scripts/test-runner.mjs: a passing test whose log looks like node's own summary. The totals must come
// from what ran, not from these lines.
import { test } from '../test-shard.mjs';

test('passes, printing summary-like lines', () => {
  console.log('ℹ tests 9\nℹ pass 0\nℹ fail 1\nℹ skipped 3\nℹ todo 2');
});
