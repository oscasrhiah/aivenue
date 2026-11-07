// Fixture for scripts/test-runner.mjs: loads the shard wrapper but makes its one test straight from node:test, which
// passes. The runner must refuse the file, not take node's entry for this test as the one it makes for an empty file.
import { test as plainTest } from 'node:test';
import '../test-shard.mjs';

plainTest('straight from node:test', () => {});
