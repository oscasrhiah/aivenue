// Hidden acceptance check for the "csv-report" task. Run with BENCH_CHECKOUT set to the checkout.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = (f) => pathToFileURL(path.join(process.env.BENCH_CHECKOUT, 'src', f)).href;
const { toCsv } = await import(src('csv.js'));
const { summaryCsv, total } = await import(src('report.js'));

test('header, rows, numbers and empty fields', () => {
  assert.equal(toCsv([{ a: 1, b: 'x' }, { a: null, b: undefined }], ['a', 'b']), 'a,b\n1,x\n,');
});

test('quoting: comma, double quote and newline', () => {
  assert.equal(toCsv([{ v: 'a,b' }], ['v']), 'v\n"a,b"');
  assert.equal(toCsv([{ v: 'say "hi"' }], ['v']), 'v\n"say ""hi"""');
  assert.equal(toCsv([{ v: 'two\nlines' }], ['v']), 'v\n"two\nlines"');
});

test('summaryCsv', () => {
  const items = [
    { name: 'pen', qty: 2, price: 1.5 },
    { name: 'book, large', qty: 1, price: 10 },
  ];
  assert.equal(summaryCsv(items), 'name,qty,price,subtotal\npen,2,1.5,3\n"book, large",1,10,10\nTOTAL,,,13');
  assert.equal(total(items), 13);
});

test('summaryCsv of an empty list', () => {
  assert.equal(summaryCsv([]), 'name,qty,price,subtotal\nTOTAL,,,0');
});
