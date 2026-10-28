import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { build } from 'esbuild';

// 模型清單不能因為 CLI 讀取失敗就變成空的：先重試，再用上一次成功的清單，最後用內建的免費模型。
const bundled = await build({
  stdin: { contents: `export { ProviderRegistry } from './packages/core/src/providers/registry';`, resolveDir: process.cwd() },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent',
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const { ProviderRegistry } = mod.exports;

const node = process.execPath;
const ok = (...ids) => ['-e', `console.log(${JSON.stringify(ids.join('\n'))})`];
const fail = ['-e', 'process.exit(1)'];

function registry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-models-'));
  const secrets = { get: async () => undefined, set: async () => undefined, delete: async () => undefined, has: () => false, list: () => [], keys: async () => [] };
  const r = new ProviderRegistry(dir, secrets, () => undefined);
  return r;
}
const spec = (src) => ({ id: 'fake-oc', name: 'Fake', command: node, run: { common: [], prompt: 'stdin' }, output: 'text', modelSource: src, models: ['opencode/builtin-free'] });
const ids = (list) => list.map((m) => m.id);

test('CLI 讀不到時用重試參數讀', async () => {
  const r = registry();
  r.upsert(spec({ type: 'command', args: fail, retryArgs: ok('opencode/a-free', 'opencode-go/kimi-k3') }));
  assert.deepEqual(ids(await r.listModels('fake-oc')), ['opencode/a-free', 'opencode-go/kimi-k3']);
});

test('之後讀取失敗：保留上一次成功的清單，不會變空', async () => {
  const r = registry();
  r.upsert(spec({ type: 'command', args: ok('opencode/a-free', 'opencode/b-free') }));
  assert.equal((await r.listModels('fake-oc')).length, 2);
  r.upsert(spec({ type: 'command', args: fail, retryArgs: fail }));
  assert.deepEqual(ids(await r.listModels('fake-oc', true)), ['opencode/a-free', 'opencode/b-free']);
});

test('從來沒成功過：用內建的免費模型', async () => {
  const r = registry();
  r.upsert(spec({ type: 'command', args: fail }));
  assert.deepEqual(ids(await r.listModels('fake-oc')), ['opencode/builtin-free']);
});

test('登入付費方案後清單更新：免費與付費模型都在', async () => {
  const r = registry();
  r.upsert(spec({ type: 'command', args: ok('opencode/big-pickle') }));
  assert.deepEqual(ids(await r.listModels('fake-oc')), ['opencode/big-pickle']);
  // 登入後 CLI 多列出 Go 的模型；帳號變動時 Aivenue 會丟掉快取重新讀。
  r.upsert(spec({ type: 'command', args: ok('opencode/big-pickle', 'opencode-go/kimi-k3') }));
  r.forgetModels('fake-oc');
  assert.deepEqual(ids(await r.listModels('fake-oc')), ['opencode/big-pickle', 'opencode-go/kimi-k3']);
});

const statusSpec = (out) => ({ ...spec({ type: 'command', args: ok('opencode/big-pickle') }), status: { ready: true, accounts: { args: ['-e', `console.log(${JSON.stringify(out)})`], none: '^(No authenticated|0 credentials)', skip: String.raw`^(Credentials\b|\d+ credentials)` } } });

test('登入狀態：OpenCode 1.x 與 2.x 的帳號清單都認得', async () => {
  const r = registry();
  r.upsert(statusSpec('┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials'));
  assert.equal((await r.checkAuth('fake-oc')).signedIn, false);
  r.upsert(statusSpec('┌  Credentials ~/.local/share/opencode/auth.json\n│\n●  OpenCode Go api\n│\n└  1 credentials'));
  const a = await r.checkAuth('fake-oc');
  assert.equal(a.signedIn, true);
  assert.match(a.detail, /OpenCode Go api/);
  r.upsert(statusSpec('No authenticated integrations'));
  assert.equal((await r.checkAuth('fake-oc')).signedIn, false);
});

test('帳號變動（登入或登出）時模型清單版本加一，選單會重新讀取', async () => {
  const r = registry();
  r.upsert(statusSpec('0 credentials'));
  await r.checkAuth('fake-oc');
  const v0 = r.list().find((p) => p.spec.id === 'fake-oc').modelsVersion;
  r.upsert(statusSpec('●  OpenCode Go api\n1 credentials'));
  await r.checkAuth('fake-oc');
  assert.equal(r.list().find((p) => p.spec.id === 'fake-oc').modelsVersion, v0 + 1);
});
