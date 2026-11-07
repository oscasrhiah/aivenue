// Fixture for scripts/test-runner.mjs: two tests through the shard wrapper and one straight from node:test. Split
// across processes the last would run in each of them, so the runner must refuse the file.
import { test as plainTest } from 'node:test';
import { test } from '../test-shard.mjs';

test('wrapped a', () => {});
test('wrapped b', () => {});
plainTest('straight from node:test', () => {});
