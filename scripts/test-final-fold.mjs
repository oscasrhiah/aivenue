// The final result / plan card's fold (packages/ui/src/finalFold.ts, used by FinalResult in pages/Chat.tsx): open by
// default, remembered per run, a one-line Markdown-free preview, and a head click that ignores the head's own controls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { test } from './lib/test-shard.mjs';

const out = await build({ entryPoints: ['packages/ui/src/finalFold.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
const mod = { exports: {} };
new Function('require', 'module', 'exports', out.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const { isFolded, setFolded, previewLine, headClickToggles } = mod.exports;

test('預設展開；收合狀態依工作流分開記住，再展開就清掉', () => {
  assert.equal(isFolded('a'), false);
  setFolded('a', true);
  assert.equal(isFolded('a'), true);
  assert.equal(isFolded('b'), false, 'another run stays open');
  setFolded('a', false);
  assert.equal(isFolded('a'), false);
});

test('收合時的預覽：一行、去掉 Markdown 符號、程式碼區塊與連結網址', () => {
  const text = '## Summary\n\nAdded **tags** to `add` and [list](https://x.example/y).\n\n```js\nconst a = 1;\n```\n- kept old notes\n';
  assert.equal(previewLine(text), 'Summary Added tags to add and list. kept old notes');
  assert.ok(!/\n/.test(previewLine('a\nb\n\nc')));
  assert.equal(previewLine('x'.repeat(500)).length, 240);
});

test('點標題列空白處會收合／展開；點複製、進度等按鈕不會', () => {
  const at = (selectorHit) => ({ closest: (sel) => (selectorHit && sel.includes(selectorHit) ? {} : null) });
  assert.equal(headClickToggles(at(null)), true, 'the title text or empty space');
  assert.equal(headClickToggles(at('button')), false, 'copy / progress toggle / the fold button itself');
  assert.equal(headClickToggles(at('a')), false);
  assert.equal(headClickToggles(null), true);
});
