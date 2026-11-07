// Fixture for scripts/test-runner.mjs: tests a reading of the source text would miss. Three are made in a loop, and
// the exclusive one names its option by shorthand, so no line says `exclusive: true`. That one fails: a runner that
// lost it would report success.
import { test } from '../test-shard.mjs';

for (const name of ['loop a', 'loop b', 'loop c']) {
  test(name, () => {});
}
const exclusive = true;
test('exclusive by shorthand, failing', { exclusive }, () => {
  throw new Error('this failure must be reported');
});
