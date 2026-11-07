// Does capture() let an EPIPE escape when the child exits before reading its input? Bundles capture() from the
// source tree <src> (e.g. a checkout of 840cc17, and one of this branch) and runs `git --version`, `git rev-parse
// HEAD` and `true` N times each with 64 KiB of input, counting uncaught exceptions.
//   node scripts/linux-accept/repro-epipe.mjs <src> [N=300]
// Prints one line per command; exits 1 when any EPIPE was uncaught.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

const src = path.resolve(process.argv[2] ?? '.');
const N = Number(process.argv[3] ?? 300);
const out = await build({ stdin: { contents: `export { capture } from './packages/core/src/proc'`, resolveDir: src }, bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
const mod = { exports: {} };
new Function('require', 'module', 'exports', out.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const { capture } = mod.exports;
let uncaught = 0;
let last;
process.on('uncaughtException', (e) => {
  uncaught++;
  last = e;
});
let total = 0;
for (const [cmd, args] of [['git', ['--version']], ['git', ['rev-parse', 'HEAD']], ['true', []]]) {
  const before = uncaught;
  let sample;
  for (let i = 0; i < N; i++) {
    const r = await capture(cmd, args, { cwd: os.tmpdir(), input: 'x'.repeat(65536) });
    sample ??= r;
  }
  await new Promise((r) => setTimeout(r, 50));
  total += uncaught - before;
  console.log(`${cmd} ${args.join(' ')}: uncaught EPIPE ${uncaught - before}/${N}; exit=${sample.code}`);
}
if (last) console.log(`last uncaught: ${last.code} ${last.syscall}`);
console.log(`${src}: ${total === 0 ? 'no uncaught EPIPE' : `${total} uncaught EPIPE`}`);
process.exit(total === 0 ? 0 : 1);
