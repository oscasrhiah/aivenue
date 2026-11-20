// The tooltips of an agent's token cells in the Agent map (packages/ui/src/tokenCells.ts): the total leaves the cache
// reads out only when the CLI's input/cache split is known; otherwise the input and cache-read cells say the numbers
// are shown as the CLI reports them.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { test } from './lib/test-shard.mjs';

const out = await build({ entryPoints: ['packages/ui/src/tokenCells.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
const mod = { exports: {} };
new Function('require', 'module', 'exports', out.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const { tokenTips } = mod.exports;
const zh = (a) => a;
const en = (_a, b) => b;

test('split 已知（Claude Code、Codex、OpenCode）：合計寫「不含快取讀取」，輸入與快取讀取不另加提示', () => {
  assert.deepEqual(tokenTips(zh, false), { total: '輸入加輸出，不含快取讀取' });
  assert.equal(tokenTips(en, false).total, 'Input plus output, without cache reads');
});

test('split 未知：合計不說「不含快取讀取」，輸入和快取讀取提示照 CLI 回報的數字', () => {
  const tips = tokenTips(zh, true);
  assert.equal(tips.total, '輸入加輸出');
  assert.doesNotMatch(tips.total, /不含快取/);
  assert.equal(tips.input, '這家 CLI 沒有說明輸入是否已包含快取讀取，數字照它回報的顯示');
  assert.equal(tips.cached, tips.input);
  assert.doesNotMatch(tokenTips(en, true).total, /without cache/);
});
