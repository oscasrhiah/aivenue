// Runs the test files on every core: each file in its own processes, the slow ones split into shards
// (scripts/lib/test-shard.mjs), then the tests marked exclusive one file at a time with nothing else running.
//   node scripts/run-tests.mjs [file ...]        (npm test; default: scripts/test-*.mjs)
// AIVENUE_TEST_JOBS: how many processes at once (default: the number of cores).
// Prints a line per file and the totals in node --test's own form (ℹ tests / pass / fail / skipped); exits 1 on
// any failure and prints the output of each process that failed.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files = (process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(path.join(root, 'scripts')).filter((f) => /^test-.*\.mjs$/.test(f)).map((f) => path.join('scripts', f))).map((f) => path.resolve(root, f));
// As many processes at once as this machine has cores (AIVENUE_TEST_JOBS overrides it).
const jobs = Math.max(1, Number(process.env.AIVENUE_TEST_JOBS) || os.availableParallelism());
// How long each file takes alone, relative to the others (seconds on one machine; files not listed are quick). Each
// file is split in proportion to its share of the whole and the number of cores, so a machine with more cores splits
// further and one with fewer splits less; the extra quarter keeps every core busy while the short files finish.
// Never more processes than the file has tests.
const COST = { 'test-bench.mjs': 64, 'test-orchestrator.mjs': 62, 'test-memory.mjs': 27, 'test-workflow.mjs': 6 };
const cost = (file) => COST[path.basename(file)] ?? 2;
const total = files.reduce((s, f) => s + cost(f), 0);
const testsIn = (file) => (fs.readFileSync(file, 'utf8').match(/^test\(/gm) ?? []).length || 1;
const SHARDS = Object.fromEntries(files.map((f) => [path.basename(f), Math.max(1, Math.min(testsIn(f), Math.ceil((cost(f) / total) * jobs * 1.25)))]));
const weight = (file) => cost(file) / SHARDS[path.basename(file)];

const plan = [];
const exclusive = [];
for (const file of files) {
  const n = SHARDS[path.basename(file)] ?? 1;
  for (let i = 0; i < n; i++) plan.push({ file, env: { AIVENUE_TEST_SHARD: `${i}/${n}`, AIVENUE_TEST_PHASE: 'parallel' } });
  if (/exclusive:\s*true/.test(fs.readFileSync(file, 'utf8'))) exclusive.push({ file, env: { AIVENUE_TEST_PHASE: 'exclusive' } });
}
// Longest first, so the slow shards start at once and the short files fill the gaps.
plan.sort((x, y) => weight(y.file) - weight(x.file));

const count = (out, key) => Number(out.match(new RegExp(`^ℹ ${key} (\\d+)`, 'm'))?.[1] ?? 0);
function run(job) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', job.file], { cwd: root, env: { ...process.env, ...job.env } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ ...job, code, out, ms: Date.now() - t0, tests: count(out, 'tests'), pass: count(out, 'pass'), fail: count(out, 'fail'), skipped: count(out, 'skipped'), cancelled: count(out, 'cancelled') }));
  });
}
async function pool(list, size) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, list.length) }, async () => {
    while (next < list.length) results.push(await run(list[next++]));
  }));
  return results;
}

const t0 = Date.now();
const parallel = await pool(plan, jobs);
const t1 = Date.now();
const results = [...parallel, ...(await pool(exclusive, 1))];
const t2 = Date.now();
const failed = results.filter((r) => r.code !== 0 || r.fail || r.cancelled);
const sum = (k, list = results) => list.reduce((s, r) => s + r[k], 0);
for (const file of files) {
  const rs = results.filter((r) => r.file === file);
  console.log(`${path.relative(root, file).padEnd(40)} ${String(sum('tests', rs)).padStart(4)} tests  ${String(sum('pass', rs)).padStart(4)} pass  ${sum('fail', rs) + sum('cancelled', rs)} fail  ${sum('skipped', rs)} skipped  ${(Math.max(...rs.map((r) => r.ms)) / 1000).toFixed(1)}s (${rs.length} process${rs.length > 1 ? 'es' : ''})`);
}
console.log(`slowest: ${[...results].sort((a, b) => b.ms - a.ms).slice(0, 4).map((r) => `${path.basename(r.file)} ${r.env.AIVENUE_TEST_SHARD ?? r.env.AIVENUE_TEST_PHASE} ${(r.ms / 1000).toFixed(1)}s`).join(', ')}`);
for (const r of failed) console.log(`\n=== FAILED ${path.relative(root, r.file)} ${JSON.stringify(r.env)} (exit ${r.code})\n${r.out}`);
console.log(`ℹ tests ${sum('tests')}\nℹ pass ${sum('pass')}\nℹ fail ${sum('fail') + sum('cancelled')}\nℹ skipped ${sum('skipped')}\nℹ duration_ms ${Date.now() - t0}\nℹ processes ${results.length} (${jobs} at a time; parallel ${((t1 - t0) / 1000).toFixed(1)}s, exclusive ${((t2 - t1) / 1000).toFixed(1)}s)`);
process.exit(failed.length ? 1 : 0);
