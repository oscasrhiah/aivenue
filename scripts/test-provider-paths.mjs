import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { test } from './lib/test-shard.mjs';
import { build } from 'esbuild';

// Where Aivenue looks for a provider's CLI before PATH (ProviderSpec.commandPaths): the real built-in specs and the real
// lookup (proc.ts specCommand), with the home folder pointed at a temporary one.
const bundled = await build({
  stdin: { contents: `export { BUILTIN_PROVIDERS } from './packages/core/src/providers/builtin'; export { specCommand } from './packages/core/src/proc';`, resolveDir: process.cwd() },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent',
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const { BUILTIN_PROVIDERS, specCommand } = mod.exports;

/** Runs `fn` with os.homedir() at a fresh temporary folder (USERPROFILE on Windows, HOME elsewhere). */
function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-home-'));
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    fs.rmSync(home, { recursive: true, force: true });
  }
}
const place = (home, rel) => {
  const file = path.join(home, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return file;
};

const opencode = BUILTIN_PROVIDERS.find((p) => p.id === 'opencode');

test('OpenCode：找得到 OpenCode Desktop 現在的安裝位置（ai.opencode.desktop）', () => {
  withHome((home) => {
    const cli = place(home, 'AppData/Local/Programs/ai.opencode.desktop/resources/opencode-cli.exe');
    assert.equal(specCommand(opencode), cli);
  });
});

test('OpenCode：舊版 Desktop 的位置（@opencodedesktop）和官方安裝程式的位置照樣找得到；兩個 Desktop 位置都在時用新的', () => {
  withHome((home) => {
    const old = place(home, 'AppData/Local/Programs/@opencodedesktop/resources/opencode-cli.exe');
    assert.equal(specCommand(opencode), old);
    const cur = place(home, 'AppData/Local/Programs/ai.opencode.desktop/resources/opencode-cli.exe');
    assert.equal(specCommand(opencode), cur);
  });
  withHome((home) => {
    const official = place(home, '.opencode/bin/opencode');
    assert.equal(specCommand(opencode), official);
  });
  // Nothing installed in those folders: the command on PATH.
  withHome(() => assert.equal(specCommand(opencode), 'opencode'));
});
