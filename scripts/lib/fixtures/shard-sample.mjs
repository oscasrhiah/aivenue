// Fixture for scripts/test-runner.mjs: every kind of test the shard wrapper must count the same way in a plain run,
// one process, and several processes.
import { test } from '../test-shard.mjs';

test('a plain', () => {});
test('b plain', () => {});
test('c plain', () => {});
test.skip('d test.skip', () => {});
test('e skip option', { skip: true }, () => {});
test.todo('f test.todo', () => {});
test('g todo option', { todo: true }, () => {});
test.only('h test.only', () => {});
test('i only option', { only: true }, () => {});
test('j exclusive', { exclusive: true }, () => {});
test.skip('k exclusive skip', { exclusive: true }, () => {});
