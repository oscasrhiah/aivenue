// Runs the test files on every core: each file in its own processes, the slow ones split into shards
// (scripts/lib/test-shard.mjs), then the tests marked exclusive one file at a time with nothing else running.
//   node scripts/run-tests.mjs [--test-only] [file ...]        (npm test; default: scripts/test-*.mjs)
// --test-only keeps node's meaning (only test.only / { only: true } run): each file then runs whole in one process.
// AIVENUE_TEST_JOBS: how many processes at once (default: the number of cores).
// AIVENUE_TEST_SHARDS: split every file into this many processes (default: from each file's cost and the core count).
// AIVENUE_TEST_VERBOSE: also print every process's own output.
// Prints a line per file and the totals in node --test's own form (ℹ tests / pass / fail / skipped / todo); exits 1
// on any failure and prints the output of each process that failed.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const nodeFlags = args.filter((a) => a === '--test-only');
const named = args.filter((a) => !a.startsWith('--'));
const files = (named.length ? named : fs.readdirSync(path.join(root, 'scripts')).filter((f) => /^test-.*\.mjs$/.test(f)).map((f) => path.join('scripts', f))).map((f) => path.resolve(root, f));
// A setting that must be a whole number of at least 1. Anything else stops the run: a split of 1.5 would make every
// process skip tests and still report success.
function wholeNumber(name) {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  if (!/^[1-9]\d*$/.test(v.trim())) {
    console.error(`${name} must be a whole number of at least 1, not "${v}"`);
    process.exit(2);
  }
  return Number(v);
}
// As many processes at once as this machine has cores (AIVENUE_TEST_JOBS overrides it).
const jobs = wholeNumber('AIVENUE_TEST_JOBS') ?? os.availableParallelism();
// How long each file takes alone, relative to the others (seconds on one machine; files not listed are quick). Each
// file is split in proportion to its share of the whole and the number of cores, so a machine with more cores splits
// further and one with fewer splits less; the extra quarter keeps every core busy while the short files finish.
// Never more processes than the file has tests.
const COST = { 'test-bench.mjs': 64, 'test-orchestrator.mjs': 62, 'test-memory.mjs': 27, 'test-workflow.mjs': 6 };
const cost = (file) => COST[path.basename(file)] ?? 2;
const total = files.reduce((s, f) => s + cost(f), 0);
// The tests of the parallel phase (exclusive ones run later). No process may be left without a test, or node reports
// the file itself as one: a file is never split into more processes than this, and one with none (only exclusive
// tests) gets no parallel process at all.
const parallelTests = (file) => {
  const src = fs.readFileSync(file, 'utf8');
  return Math.max(0, (src.match(/^test(\.(skip|todo|only))?\(/gm) ?? []).length - (src.match(/exclusive:\s*true/g) ?? []).length);
};
const hasExclusive = (file) => /exclusive:\s*true/.test(fs.readFileSync(file, 'utf8'));
const forced = wholeNumber('AIVENUE_TEST_SHARDS');
// With --test-only each file runs whole in one process: a process left without any `only` test would report the
// file itself as a test, so splitting would change the totals (and a focused run gains nothing from it).
const only = nodeFlags.includes('--test-only');
const shardsOf = (f) => {
  if (only) return 1;
  const n = parallelTests(f);
  // A file with no test found at all still gets one plain process, so it is run (and its failure seen) as before.
  if (!n) return hasExclusive(f) ? 0 : 1;
  return Math.max(1, Math.min(n, forced ?? Math.ceil((cost(f) / total) * jobs * 1.25)));
};
const SHARDS = new Map(files.map((f) => [f, shardsOf(f)]));
const weight = (file) => cost(file) / Math.max(1, SHARDS.get(file));

const plan = [];
const exclusive = [];
for (const file of files) {
  const n = SHARDS.get(file);
  if (only) {
    plan.push({ file, env: {} });
    continue;
  }
  for (let i = 0; i < n; i++) plan.push({ file, env: { AIVENUE_TEST_SHARD: `${i}/${n}`, AIVENUE_TEST_PHASE: 'parallel' } });
  if (hasExclusive(file)) exclusive.push({ file, env: { AIVENUE_TEST_PHASE: 'exclusive' } });
}
// Longest first, so the slow shards start at once and the short files fill the gaps.
plan.sort((x, y) => weight(y.file) - weight(x.file));

const KEYS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const count = (out, key) => Number(out.match(new RegExp(`^ℹ ${key} (\\d+)`, 'm'))?.[1] ?? 0);
function run(job) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', ...nodeFlags, job.file], { cwd: root, env: { ...process.env, ...job.env } });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ ...job, code, out, ms: Date.now() - t0, ...Object.fromEntries(KEYS.map((k) => [k, count(out, k)])) }));
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
  console.log(`${path.relative(root, file).padEnd(40)} ${String(sum('tests', rs)).padStart(4)} tests  ${String(sum('pass', rs)).padStart(4)} pass  ${sum('fail', rs) + sum('cancelled', rs)} fail  ${sum('skipped', rs)} skipped  ${sum('todo', rs)} todo  ${(Math.max(...rs.map((r) => r.ms)) / 1000).toFixed(1)}s (${rs.length} process${rs.length > 1 ? 'es' : ''})`);
}
console.log(`slowest: ${[...results].sort((a, b) => b.ms - a.ms).slice(0, 4).map((r) => `${path.basename(r.file)} ${r.env.AIVENUE_TEST_SHARD ?? r.env.AIVENUE_TEST_PHASE} ${(r.ms / 1000).toFixed(1)}s`).join(', ')}`);
if (process.env.AIVENUE_TEST_VERBOSE) for (const r of results) console.log(`\n=== ${path.relative(root, r.file)} ${JSON.stringify(r.env)} (exit ${r.code})\n${r.out}`);
for (const r of failed) console.log(`\n=== FAILED ${path.relative(root, r.file)} ${JSON.stringify(r.env)} (exit ${r.code})\n${r.out}`);
console.log(`ℹ tests ${sum('tests')}\nℹ pass ${sum('pass')}\nℹ fail ${sum('fail') + sum('cancelled')}\nℹ skipped ${sum('skipped')}\nℹ todo ${sum('todo')}\nℹ duration_ms ${Date.now() - t0}\nℹ processes ${results.length} (${jobs} at a time; parallel ${((t1 - t0) / 1000).toFixed(1)}s, exclusive ${((t2 - t1) / 1000).toFixed(1)}s)`);
process.exit(failed.length ? 1 : 0);
