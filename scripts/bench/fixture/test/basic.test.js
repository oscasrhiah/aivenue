import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugify } from '../src/slug.js';
import { formatDuration, parseDuration } from '../src/duration.js';
import { total } from '../src/report.js';

test('slugify', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('  Café au lait  '), 'cafe-au-lait');
});

test('parseDuration: single units', () => {
  assert.equal(parseDuration('45s'), 45);
  assert.ok(Number.isNaN(parseDuration('soon')));
});

test('formatDuration', () => {
  assert.equal(formatDuration(5400), '1h30m');
  assert.equal(formatDuration(0), '0s');
});

test('total', () => {
  assert.equal(total([{ name: 'a', qty: 2, price: 3 }]), 6);
});
