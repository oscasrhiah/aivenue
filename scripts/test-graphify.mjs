import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { build } from 'esbuild';

// 僅替換程序邊界，實際執行擴充服務的安裝、狀態和重試流程。
const bundled = await build({
  stdin: {
    contents: `export { ExtensionService } from './packages/core/src/extensions';
      export { setCapture } from './packages/core/src/proc';`,
    resolveDir: process.cwd(),
  },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{
    name: '測試程序',
    setup(b) {
      b.onLoad({ filter: /[\\/]proc\.ts$/ }, () => ({ contents: `
        export let capture;
        export function setCapture(fn) { capture = fn; }
        export function refreshPathCache() {}
        export function childEnv() { return {}; }
        export function findNode() {}
        export function killTree() {}
        export function resolveCommand(c) { return { file: c, prefixArgs: [], display: c }; }
        // 安裝指令改由 spawn 串流進度：用同一個 capture 替身回應。
        import { EventEmitter } from 'node:events';
        export function spawnResolved(cmd, args) {
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          Promise.resolve(capture(cmd.file, args)).then((r) => {
            if (r.stdout) child.stdout.emit('data', Buffer.from(r.stdout));
            if (r.stderr) child.stderr.emit('data', Buffer.from(r.stderr));
            child.emit('close', r.code);
          });
          return child;
        }
      ` }));
    },
  }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const { ExtensionService, setCapture } = mod.exports;
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const fail = (stderr) => ({ code: 1, stdout: '', stderr });

function service() {
  return new ExtensionService({
    dataDir: '.', bundledDir: '不存在的測試套件目錄',
    capabilities: { skillsDir: '.', get: () => ({ extensions: { graphify: { enabled: true } } }) },
    registry: {}, secrets: {}, onChange() {},
  });
}

test('預設 Python 3.15 時，安裝改用相容版本並進入就緒狀態', async () => {
  let installed = false;
  setCapture(async (cmd, args) => {
    if (cmd === 'graphify') return installed ? ok('graphify 0.9.95') : fail('尚未安裝');
    if (args[0] === '--version') return ok('uv 0.13.5');
    installed = args[args.indexOf('--python') + 1] === '3.12';
    return installed ? ok() : fail('Python 3.15 無法編譯 tree-sitter');
  });
  const s = service();
  await s.installGraphify();
  assert.equal(s.list().find(x => x.id === 'graphify').state, 'ready');
});

test('保留編譯錯誤開頭，而且失敗後可重試', async () => {
  let attempts = 0;
  let installed = false;
  setCapture(async (cmd, args) => {
    if (cmd === 'graphify') return installed ? ok('graphify 0.9.95') : fail('尚未安裝');
    if (args[0] === '--version') return ok('uv 0.13.5');
    if (++attempts === 1) return fail('編譯器錯誤：缺少必要標頭\n' + '一般建置訊息\n'.repeat(100) + 'hint: tree-sitter\nhint: graphifyy\nhint: build environment');
    installed = true;
    return ok();
  });
  const s = service();
  await s.installGraphify();
  const status = s.list().find(x => x.id === 'graphify');
  assert.equal(status.state, 'error');
  assert.match(status.message, /編譯器錯誤：缺少必要標頭/);
  await s.retry('graphify');
  // retry 非同步啟動安裝；讓立即完成的程序替身跑完。
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.list().find(x => x.id === 'graphify').state, 'ready');
});

test('已安裝且可執行時不重新安裝', async () => {
  setCapture(async (cmd) => {
    assert.equal(cmd, 'graphify');
    return ok('graphify 0.9.95');
  });
  const s = service();
  await s.installGraphify();
  assert.equal(s.list().find(x => x.id === 'graphify').state, 'ready');
});
