// Fixture for scripts/test-runner.mjs: one ordinary test that fails. Only this comment mentions { exclusive: true },
// so a runner that reads the source text instead of the registered tests would skip it and report success.
import { test } from '../test-shard.mjs';

test('an ordinary failing test', () => {
  throw new Error('this failure must be reported');
});
