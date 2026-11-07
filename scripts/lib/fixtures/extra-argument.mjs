// Fixture for scripts/test-runner.mjs: options split over two objects, so the test body lands in a fourth argument.
// node would run the test without its body and pass it; the wrapper must refuse instead.
import { test } from '../test-shard.mjs';

test('options in two objects', { exclusive: true }, { skip: false }, () => {
  throw new Error('never reached');
});
