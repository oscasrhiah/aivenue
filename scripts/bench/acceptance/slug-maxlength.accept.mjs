// Hidden acceptance check for the "slug-maxlength" task. Run with BENCH_CHECKOUT set to the checkout.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const { slugify } = await import(pathToFileURL(path.join(process.env.BENCH_CHECKOUT, 'src', 'slug.js')).href);

test('unchanged without the option', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('Hello, World!', {}), 'hello-world');
  assert.equal(slugify('Hello, World!', { maxLength: 0 }), 'hello-world');
});

test('cuts at a word boundary and never ends with "-"', () => {
  assert.equal(slugify('The quick brown fox', { maxLength: 10 }), 'the-quick');
  assert.equal(slugify('The quick brown fox', { maxLength: 9 }), 'the-quick');
  assert.equal(slugify('The quick brown fox', { maxLength: 8 }), 'the');
  assert.equal(slugify('The quick brown fox', { maxLength: 100 }), 'the-quick-brown-fox');
});

test('a first word longer than the limit is cut', () => {
  assert.equal(slugify('Supercalifragilistic expialidocious', { maxLength: 5 }), 'super');
});

test('never longer than maxLength', () => {
  for (let n = 1; n <= 25; n++) assert.ok(slugify('alpha beta gamma delta', { maxLength: n }).length <= n, String(n));
});
