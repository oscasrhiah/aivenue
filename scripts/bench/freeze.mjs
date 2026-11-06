// Freeze the current Aivenue as a benchmark baseline (docs/workflow-efficiency-plan.md A4).
//
//   node scripts/bench/freeze.mjs [--label frozen-20261104] [--root bench-results]
//
// Copies the working tree as it is (tracked and untracked files, uncommitted changes included; nothing is committed),
// saves the commit and the diff, builds the copy, and records the hashes of the bundles that will run. The baseline
// is then run against that build (the command is printed at the end). bench-results/ is ignored by git.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const label = arg('label', `frozen-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`);
const dir = path.resolve(root, arg('root', 'bench-results'), label);
if (!/^[\w.-]+$/.test(label)) throw new Error('label: letters, digits, ".", "-" and "_" only');
if (fs.existsSync(dir)) throw new Error(`${dir} already exists: pick another --label`);

const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

function hashDir(d) {
  const h = createHash('sha256');
  const walk = (p, rel) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const q = path.join(p, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(q, `${rel}${e.name}/`);
      else h.update(`${rel}${e.name}\0`).update(fs.readFileSync(q)).update('\0');
    }
  };
  walk(d, '');
  return h.digest('hex');
}
const fileHash = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// 1. The working tree as it is: what git tracks plus untracked files that are not ignored.
const source = path.join(dir, 'source');
const files = git(['ls-files', '-co', '--exclude-standard']).split('\n').filter(Boolean);
for (const f of files) {
  const from = path.join(root, f);
  if (!fs.existsSync(from) || fs.statSync(from).isDirectory()) continue; // deleted in the working tree
  fs.mkdirSync(path.dirname(path.join(source, f)), { recursive: true });
  fs.copyFileSync(from, path.join(source, f));
}
const commit = git(['rev-parse', 'HEAD']).trim();
fs.writeFileSync(path.join(dir, 'aivenue.diff'), git(['diff', 'HEAD', '--binary']));
const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
const sourceSha256 = hashDir(source);

// 2. Build the copy with this checkout's installed dependencies (linked for the build only, then unlinked).
const link = path.join(source, 'node_modules');
fs.symlinkSync(path.join(root, 'node_modules'), link, 'junction');
let built;
try {
  built = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: source, encoding: 'utf8', timeout: 15 * 60000 });
} finally {
  // Removes the link only, never what it points to.
  fs.unlinkSync(link);
}
if (built.status !== 0) throw new Error(`the build of the copy failed:\n${built.stdout}\n${built.stderr}`);

// 3. What will run, and what it is measured against.
const dist = path.join(source, 'packages', 'desktop', 'dist');
const freeze = {
  label,
  at: new Date().toISOString(),
  node: process.version,
  aivenue: { commit, dirty: git(['status', '--porcelain']).trim().length > 0, diffSha256: fileHash(path.join(dir, 'aivenue.diff')), untracked, files: files.length, sourceSha256 },
  build: { log: built.stdout.trim().split('\n').slice(-1)[0] },
  bundles: { hub: path.join(dist, 'standalone.cjs'), hubSha256: fileHash(path.join(dist, 'standalone.cjs')), bridgeSha256: fileHash(path.join(dist, 'bridge.cjs')), uiSha256: hashDir(path.join(dist, 'ui')) },
  bench: { fixtureSha256: hashDir(path.join(source, 'scripts', 'bench', 'fixture')), tasksSha256: fileHash(path.join(source, 'scripts', 'bench', 'tasks.json')), acceptanceSha256: hashDir(path.join(source, 'scripts', 'bench', 'acceptance')), runnerSha256: fileHash(path.join(source, 'scripts', 'bench', 'run.mjs')) },
};
fs.writeFileSync(path.join(dir, 'freeze.json'), JSON.stringify(freeze, null, 1));
console.log(`Frozen: ${dir}`);
console.log(`  ${files.length} files (commit ${commit.slice(0, 12)}${freeze.aivenue.dirty ? ' + uncommitted changes' : ''}), hub bundle ${freeze.bundles.hubSha256.slice(0, 12)}`);
console.log('\nRun the baseline against this build with:');
console.log(`  BENCH_HUB_ENTRY="${freeze.bundles.hub}" node "${path.join(source, 'scripts', 'bench', 'run.mjs')}" --go --review --label ${label} --out "${path.join(dir, 'report')}"`);
