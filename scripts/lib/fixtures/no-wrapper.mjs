// Fixture for scripts/test-runner.mjs: a test file that takes `test` straight from node:test. Split across processes,
// every process would run all of it; the runner must say so instead of counting it several times.
import { test } from 'node:test';

test('from node:test', () => {});
