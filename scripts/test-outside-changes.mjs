// The "outside the working folder" warning of a conversation (components/Safety.tsx OutsideChanges): one line on the
// first layer (count and where, a button with aria-expanded), the grouped list and the note only when opened, and the
// system temp folder (where agent CLIs keep their helper scripts) marked rather than hidden.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { test } from './lib/test-shard.mjs';

const require = createRequire(import.meta.url);
const out = await build({
  stdin: {
    contents: `export { OutsideChanges, isTempDir } from './packages/ui/src/components/Safety';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'lucide-react'],
  plugins: [
    {
      name: 'no hub',
      setup(b) {
        b.onResolve({ filter: /^\.\.?\/(api|Ask)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const hub = { call: async () => undefined, on: () => () => undefined }; export const useSettings = () => undefined; export const ask = async () => false;', loader: 'js' }));
      },
    },
  ],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
const { OutsideChanges, isTempDir } = mod.exports;
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const run = (outsideChanges) => ({ config: { goal: 'Fix the page' }, outsideChanges });
const html = (r) => renderToStaticMarkup(React.createElement(OutsideChanges, { run: r }));

test('寫檔紀錄預設收成一行：數量與第一個位置、等 K 個位置，按鈕帶 aria-expanded，清單與說明收起', () => {
  const h = html(run(['C:\\Users\\me\\AppData\\Local\\Temp\\opencode\\a.ps1', 'C:\\Users\\me\\AppData\\Local\\Temp\\opencode\\b.ps1', 'D:\\other\\notes\\x.txt']));
  assert.match(h, /工作資料夾外有 3 筆寫檔紀錄/);
  assert.match(h, /…\/Temp\/opencode\/ 等 2 個位置/);
  assert.match(h, /<button type="button" class="outside-toggle" aria-expanded="false"/);
  assert.match(h, /class="outside-changes outside-line"/);
  assert.doesNotMatch(h, /decision/, 'no frame while collapsed');
  assert.doesNotMatch(h, /outside-groups|用終端指令改的檔案/, 'the list and the note open from the line');
  assert.equal(html(run([])), '');
  assert.match(html(run(['/home/me/x/y.txt'])), /outside-where">…\/me\/x\/<\/span><\/button>/, 'one place: its label, no count of places');
});

test('系統暫存資料夾（agent CLI 放輔助腳本的地方）認得出來，其他資料夾不算', () => {
  for (const d of ['C:\\Users\\me\\AppData\\Local\\Temp\\opencode', 'C:/Users/me/AppData/Local/Temp', '/tmp/codex', '/var/folders/ab/cd1234/T/claude', '/private/var/folders/ab/cd/T']) assert.equal(isTempDir(d), true, d);
  for (const d of ['C:\\Users\\me\\Documents\\Temp files', 'D:\\proj\\tmp', '/home/me/tmp', '/var/log', 'C:\\Users\\me\\AppData\\Local\\Programs']) assert.equal(isTempDir(d), false, d);
});
