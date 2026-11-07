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
import { fileURLToPath, pathToFileURL } from 'node:url';

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
// The split only decides speed: what runs, and what is counted, comes from the tests each process actually
// registered (scripts/lib/test-shard.mjs reports them), never from reading the source.
const COST = { 'test-bench.mjs': 64, 'test-orchestrator.mjs': 62, 'test-memory.mjs': 27, 'test-workflow.mjs': 6 };
const cost = (file) => COST[path.basename(file)] ?? 2;
const total = files.reduce((s, f) => s + cost(f), 0);
// A rough count of a file's tests, only to avoid starting processes that would get none (a wrong guess costs time,
// not results: a process left without a test is recognised from its report and not counted).
const guess = (file) => Math.max(1, (fs.readFileSync(file, 'utf8').match(/^test(\.(skip|todo|only))?\(/gm) ?? []).length);
const forced = wholeNumber('AIVENUE_TEST_SHARDS');
// With --test-only each file runs whole in one process: a process left without any `only` test would report the
// file itself as a test, so splitting would change the totals (and a focused run gains nothing from it).
const only = nodeFlags.includes('--test-only');
// Every file gets at least one parallel process: that is where its exclusive tests are found as well.
const SHARDS = new Map(files.map((f) => [f, only ? 1 : Math.max(1, Math.min(guess(f), forced ?? Math.ceil((cost(f) / total) * jobs * 1.25)))]));
const weight = (file) => cost(file) / SHARDS.get(file);

const reports = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-tests-'));
let jobId = 0;
const plan = [];
for (const file of files) {
  const n = SHARDS.get(file);
  if (only) plan.push({ file, env: {} });
  else for (let i = 0; i < n; i++) plan.push({ file, env: { AIVENUE_TEST_SHARD: `${i}/${n}`, AIVENUE_TEST_PHASE: 'parallel' } });
}
// Longest first, so the slow shards start at once and the short files fill the gaps.
plan.sort((x, y) => weight(y.file) - weight(x.file));

// The totals of a process come from node's own summary event (scripts/lib/test-top-level.mjs), not from its printed
// output: a test may log a line that looks like "ℹ fail 1". The text is kept only to show what happened.
const KEYS = { tests: 'tests', pass: 'passed', fail: 'failed', cancelled: 'cancelled', skipped: 'skipped', todo: 'todo' };
// The runner's own settings for each process replace anything of the kind in its environment: a split inherited from
// outside (AIVENUE_TEST_SHARD=1/2 with --test-only, say) would make that process skip tests and still pass. So does
// NODE_TEST_CONTEXT, which node sets when the runner itself is started from a test and which changes how a child reports.
const INHERITED = new Set(['AIVENUE_TEST_SHARD', 'AIVENUE_TEST_PHASE', 'AIVENUE_TEST_REPORT', 'NODE_TEST_CONTEXT']);
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !INHERITED.has(k)));
const topLevelReporter = pathToFileURL(path.join(root, 'scripts', 'lib', 'test-top-level.mjs')).href;
// Names in `ran` that the wrapper did not register (counting repeats): tests made straight from node:test.
function unregistered(ran, names) {
  const left = new Map();
  for (const n of names) left.set(n, (left.get(n) ?? 0) + 1);
  return ran.filter((n) => (left.get(n) ?? 0) > 0 ? (left.set(n, left.get(n) - 1), false) : true);
}
function run(job) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const id = jobId++;
    const reportFile = path.join(reports, `${id}.json`);
    const topFile = path.join(reports, `${id}.top.json`);
    const env = { ...baseEnv, ...job.env, AIVENUE_TEST_REPORT: reportFile };
    const reporters = ['--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${topLevelReporter}`, `--test-reporter-destination=${topFile}`];
    const child = spawn(process.execPath, ['--test', ...reporters, ...nodeFlags, job.file], { cwd: root, env });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (out += d));
    child.on('close', (code) => {
      let report = null;
      try {
        report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
      } catch {}
      let top = null;
      try {
        top = JSON.parse(fs.readFileSync(topFile, 'utf8'));
      } catch {}
      const r = { ...job, code, out, ms: Date.now() - t0, report, top, ...Object.fromEntries(Object.entries(KEYS).map(([k, from]) => [k, top?.counts?.[from] ?? 0])) };
      const rel = path.relative(root, job.file);
      const fail = (why) => {
        r.code = r.code || 1;
        r.out += `\n${rel}${why}\n`;
      };
      if (!top?.counts) fail(': node did not report what ran (scripts/lib/test-top-level.mjs)');
      // A file that ran to the end without loading the shard wrapper would run every test in every process.
      if (code === 0 && !report) fail(' does not take `test` from scripts/lib/test-shard.mjs, so it cannot be split');
      // Nor may a file mix the two: a test made straight from node:test runs in each of its processes. node's own
      // entry for a file that ran no test is not among `names` (the reporter recognises it from node's events).
      const extra = report && top ? unregistered(top.names, report.names) : [];
      if (extra.length) fail(` runs ${extra.length} test(s) not taken from scripts/lib/test-shard.mjs, which every process of the file would run again: ${extra.map((n) => JSON.stringify(n)).join(', ')}`);
      resolve(r);
    });
  });
}
// A process that registered no test and ran none still passes: node reports the file itself as one test. It ran
// nothing, so it is not counted, unless the file has no test at all (then a plain run reports that one, and so does this).
const empty = (r) => r.code === 0 && r.report?.registered === 0 && r.top?.fileEntry && !r.top.fileEntryFailed && !r.top.names.length;
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
// The exclusive phase, for each file whose processes saw an exclusive test (or that could not say, having failed).
const exclusive = only ? [] : files.filter((f) => parallel.some((r) => r.file === f && (r.report?.exclusives > 0 || !r.report))).map((file) => ({ file, env: { AIVENUE_TEST_PHASE: 'exclusive' } }));
const ran = [...parallel, ...(await pool(exclusive, 1))];
const t2 = Date.now();
fs.rmSync(reports, { recursive: true, force: true });
const results = ran.filter((r) => {
  if (!empty(r)) return true;
  const same = ran.filter((o) => o.file === r.file);
  return same.every(empty) && same[0] === r;
});
const failed = results.filter((r) => r.code !== 0 || r.fail || r.cancelled);
const sum = (k, list = results) => list.reduce((s, r) => s + r[k], 0);
for (const file of files) {
  const rs = results.filter((r) => r.file === file);
  const procs = ran.filter((r) => r.file === file).length;
  console.log(`${path.relative(root, file).padEnd(40)} ${String(sum('tests', rs)).padStart(4)} tests  ${String(sum('pass', rs)).padStart(4)} pass  ${sum('fail', rs) + sum('cancelled', rs)} fail  ${sum('skipped', rs)} skipped  ${sum('todo', rs)} todo  ${(Math.max(...ran.filter((r) => r.file === file).map((r) => r.ms)) / 1000).toFixed(1)}s (${procs} process${procs > 1 ? 'es' : ''})`);
}
console.log(`slowest: ${[...results].sort((a, b) => b.ms - a.ms).slice(0, 4).map((r) => `${path.basename(r.file)} ${r.env.AIVENUE_TEST_SHARD ?? r.env.AIVENUE_TEST_PHASE} ${(r.ms / 1000).toFixed(1)}s`).join(', ')}`);
// Only the processes that are counted: one without tests would show the file itself as a passing test.
if (process.env.AIVENUE_TEST_VERBOSE) for (const r of results) console.log(`\n=== ${path.relative(root, r.file)} ${JSON.stringify(r.env)} (exit ${r.code})\n${r.out}`);
for (const r of failed) console.log(`\n=== FAILED ${path.relative(root, r.file)} ${JSON.stringify(r.env)} (exit ${r.code})\n${r.out}`);
console.log(`ℹ tests ${sum('tests')}\nℹ pass ${sum('pass')}\nℹ fail ${sum('fail') + sum('cancelled')}\nℹ skipped ${sum('skipped')}\nℹ todo ${sum('todo')}\nℹ duration_ms ${Date.now() - t0}\nℹ processes ${ran.length} (${ran.length - results.length} without tests, not counted; ${jobs} at a time; parallel ${((t1 - t0) / 1000).toFixed(1)}s, exclusive ${((t2 - t1) / 1000).toFixed(1)}s)`);
process.exit(failed.length ? 1 : 0);
