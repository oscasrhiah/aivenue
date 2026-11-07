// Fixture for scripts/test-runner.mjs: a file whose only test is exclusive. The runner must not start a parallel
// process for it (that process would have no test, and node would count the file itself as one).
import { test } from '../test-shard.mjs';

test('the only test, exclusive', { exclusive: true }, () => {});
