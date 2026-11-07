// Fixture for scripts/test-runner.mjs: the first test ends the process, so the second, which would fail, never runs.
// node then reports only the file itself, as passing; the runner must name the registered tests that have no result.
import { test } from '../test-shard.mjs';

test('ends the process', () => {
  process.exit(0);
});
test('would fail if it ran', () => {
  throw new Error('this test must not be counted as passed');
});
