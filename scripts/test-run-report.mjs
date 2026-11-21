import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { test } from './lib/test-shard.mjs';

// The conversation exported as a page a person reads, then printed to a PDF by a headless browser.
const b = await build({ stdin: { contents: `export { runReportHtml, exportRunPdf } from './packages/core/src/runReport'; export { findBrowser } from './packages/core/src/screenshot';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
const mod = { exports: {} };
new Function('require', 'module', 'exports', b.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const { runReportHtml, exportRunPdf, findBrowser } = mod.exports;

const run = {
  id: 'r1',
  status: 'completed',
  createdAt: Date.now() - 60000,
  endedAt: Date.now(),
  config: { title: '加標籤 <b>', goal: '幫筆記加上標籤', cwd: 'C:\proj' },
  agents: {
    a1: { id: 'a1', role: 'executor', provider: 'opencode', model: 'opencode/big-pickle', status: 'completed', depth: 0, task: '', startedAt: Date.now() - 50000, endedAt: Date.now() - 1000, finalText: '完成了，金鑰 sk-abcdefghijklmnopqrstuv 不要外流' },
  },
};
const events = { a1: [
  { seq: 1, ts: 1, kind: 'thinking', text: 'SECRET THOUGHT' },
  { seq: 2, ts: 2, kind: 'message', text: '我先讀 store.js' },
  { seq: 3, ts: 3, kind: 'tool', tool: { id: 't', name: 'read', category: 'read', title: 'Read src/store.js', output: 'x'.repeat(5000), status: 'ok' } },
  { seq: 4, ts: 4, kind: 'error', text: 'boom' },
] };

test('匯出頁：你的訊息、agent 的角色與模型、說的話、工具（輸出截短）、錯誤、結果；不含思考；HTML 會跳脫', () => {
  const h = runReportHtml(run, (id) => events[id] ?? []);
  assert.match(h, /幫筆記加上標籤/);
  assert.match(h, /實作|Implementer/);
  assert.match(h, /opencode\/big-pickle/);
  assert.match(h, /我先讀 store\.js/);
  assert.match(h, /Read src\/store\.js/);
  assert.match(h, /boom/);
  assert.ok(!h.includes('SECRET THOUGHT'));
  assert.ok(!h.includes('x'.repeat(2000)));
  assert.ok(h.includes('加標籤 &lt;b&gt;'));
});

test('匯出成 PDF：用無頭瀏覽器印出，金鑰遮罩，暫存的 HTML 會刪掉', { skip: !findBrowser() && 'no Chromium-based browser' }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-pdf-'));
  const r = await exportRunPdf(data, run, (id) => events[id] ?? []);
  assert.ok(r.path.endsWith('.pdf'));
  assert.equal(fs.readFileSync(r.path).subarray(0, 5).toString(), '%PDF-');
  assert.ok(r.bytes > 1000);
  assert.ok(r.masked >= 1);
  assert.deepEqual(fs.readdirSync(path.join(data, 'exports')).filter((f) => f.endsWith('.html')), []);
});
