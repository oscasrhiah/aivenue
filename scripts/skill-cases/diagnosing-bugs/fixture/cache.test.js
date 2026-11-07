import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as c from './cache.js';

test('getUser fetches a user once, however many callers ask at the same time', async () => {
  c.reset();
  await c.getUser(1); // warm-up of an unrelated path
  c.reset();
  const first = c.getUser(7);
  await new Promise((r) => setTimeout(r, Math.random() * 6));
  const [a, b] = await Promise.all([first, c.getUser(7)]);
  assert.deepEqual(a, b);
  assert.equal(c.fetchCalls, 1);
});
