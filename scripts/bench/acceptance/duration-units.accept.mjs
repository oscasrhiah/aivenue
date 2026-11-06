// Hidden acceptance check for the "duration-units" task. Run with BENCH_CHECKOUT set to the checkout.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const { parseDuration, formatDuration } = await import(pathToFileURL(path.join(process.env.BENCH_CHECKOUT, 'src', 'duration.js')).href);

test('every unit is respected', () => {
  assert.equal(parseDuration('3m'), 180);
  assert.equal(parseDuration('2h'), 7200);
  assert.equal(parseDuration('1h30m'), 5400);
  assert.equal(parseDuration('2m5s'), 125);
  assert.equal(parseDuration('1h5s'), 3605);
  assert.equal(parseDuration('1h2m3s'), 3723);
  assert.equal(parseDuration('45s'), 45);
});

test('not a duration', () => {
  for (const bad of ['', 'soon', '5x', '1h30', 'h5']) assert.ok(Number.isNaN(parseDuration(bad)), bad);
});

test('round trip with formatDuration', () => {
  for (const n of [0, 1, 59, 60, 61, 3599, 3600, 3661, 86399]) assert.equal(parseDuration(formatDuration(n)), n, String(n));
});
