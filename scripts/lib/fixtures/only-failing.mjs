// Fixture for scripts/test-runner.mjs: one test.only that fails. Run with --test-only it must be reported as failing
// even when the runner itself was started with a split of its own in the environment.
import { test } from '../test-shard.mjs';

test.only('a failing only test', () => {
  throw new Error('this failure must be reported');
});
