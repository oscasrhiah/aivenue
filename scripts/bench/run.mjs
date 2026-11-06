// Aivenue efficiency benchmark (docs/workflow-efficiency-plan.md A3).
//
//   node scripts/bench/run.mjs                      print what would run, run nothing
//   node scripts/bench/run.mjs --go                 run it (free OpenCode model only)
//
// Options:
//   --configs direct-cli,aivenue-single,aivenue-default   which setups (default: all three; aivenue-standard, the
//                                                          optional standard flow mode, only when named)
//   --tasks slug-maxlength,duration-units,csv-report       which tasks (default: all)
//   --repeat 2                                             runs per task and setup
//   --review                                               also run the review-ability test
//   --model opencode/deepseek-v4.1-flash-free              the only model used
//   --timeout-min 40                                       per run: start, every call, cancel and cleanup included
//   --out <folder>                                         where the report goes (default: a new folder in the temp dir)
//   --label <text>                                         name of this baseline in the report
//
// Every run gets a new checkout (a copy of scripts/bench/fixture, committed in a fresh git repository), a new
// Aivenue data folder and new CLI sessions; project memory is off. The model each session really used is read back
// from OpenCode's own session record: another model makes the run invalid, an unreadable record leaves it
// "model not verified". A run is never retried on another model. Setups rotate their order.
//
// Outcomes: "pass" (finished normally, hidden and visible tests pass), "fail" (finished, a test fails), "timeout"
// (hit the time limit: a result, counted as not solved), "stopped" (the workflow stopped or waited for a person),
// "invalid" (the model was unavailable, limited or not the one asked for: left out of the comparison) and "error"
// (the benchmark itself broke).
//
// For testing the benchmark without a model: BENCH_OPENCODE_CLI (a .mjs/.cjs stand-in for the OpenCode CLI) and
// BENCH_HUB_ENTRY (a stand-in for the hub entry).
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { CLEANUP_GRACE_MS, Deadline, TASKS, acceptance, envFor, fileHash, git, hashDir, hubEntry, killTree, newCheckout, startHub, withDeadline } from './lib.mjs';
export { CLEANUP_GRACE_MS, acceptance, envFor };

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const flag = (name) => process.argv.includes(`--${name}`);

const ALL_CONFIGS = ['direct-cli', 'aivenue-single', 'aivenue-default'];
const KNOWN_CONFIGS = [...ALL_CONFIGS, 'aivenue-standard'];
const opts = {
  configs: (arg('configs', ALL_CONFIGS.join(',')) ?? '').split(',').filter(Boolean),
  tasks: (arg('tasks', TASKS.map((t) => t.id).join(',')) ?? '').split(',').filter(Boolean),
  repeat: Number(arg('repeat', '2')),
  review: flag('review'),
  model: arg('model', 'opencode/deepseek-v4.1-flash-free'),
  timeoutMs: Number(arg('timeout-min', '40')) * 60000,
  out: arg('out', path.join(os.tmpdir(), `aivenue-bench-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`)),
  label: arg('label', 'baseline'),
  go: flag('go'),
};
for (const c of opts.configs) if (!KNOWN_CONFIGS.includes(c)) throw new Error(`unknown setup ${c}`);
for (const t of opts.tasks) if (!TASKS.some((x) => x.id === t)) throw new Error(`unknown task ${t}`);
// A name check only: it says the model is one of the free ones by name, not what it costs.
if (!/-free$/.test(opts.model)) throw new Error('only OpenCode models named "-free" may be used by this benchmark');
const [wantProvider, wantModel] = opts.model.includes('/') ? opts.model.split('/') : ['opencode', opts.model];

// ---------- processes ----------

/** The OpenCode CLI (or the stand-in a test gives), as a command and its leading arguments. */
function opencodeCli() {
  const stand = process.env.BENCH_OPENCODE_CLI;
  if (stand) return /\.(c|m)?js$/.test(stand) ? { cmd: process.execPath, pre: [stand] } : { cmd: stand, pre: [] };
  const candidates = [path.join(os.homedir(), 'AppData/Local/Programs/@opencodedesktop/resources/opencode-cli.exe'), path.join(os.homedir(), '.opencode/bin/opencode')];
  return { cmd: candidates.find((p) => fs.existsSync(p)) ?? 'opencode', pre: [] };
}

// ---------- the environment, recorded with every report ----------

function environment() {
  const cli = opencodeCli();
  let cliVersion = '';
  try {
    cliVersion = execFileSync(cli.cmd, [...cli.pre, '--version'], { encoding: 'utf8', timeout: 20000 }).trim();
  } catch {
    cliVersion = 'unknown';
  }
  // The Aivenue code that ran: the commit plus everything not committed (A4 keeps the full copy), and the bundles
  // the hub really runs (a stale build would otherwise be measured as the source).
  const diff = git(['diff', 'HEAD']);
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
  const untrackedHash = createHash('sha256');
  for (const f of untracked.sort()) untrackedHash.update(f).update('\0').update(fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f)) : '').update('\0');
  const dist = path.dirname(hubEntry());
  return {
    label: opts.label,
    at: new Date().toISOString(),
    os: `${process.platform}-${process.arch} ${os.release()}`,
    node: process.version,
    opencodeCli: [cli.cmd, ...cli.pre].join(' '),
    opencodeVersion: cliVersion,
    model: opts.model,
    modelCheck: 'name ends in -free (a name check, not a price check); the model each session used is read from OpenCode session export',
    aivenue: { commit: git(['rev-parse', 'HEAD']).trim(), diffSha256: createHash('sha256').update(diff).digest('hex'), untracked: untracked.length, untrackedSha256: untrackedHash.digest('hex') },
    bundles: { hub: hubEntry(), hubSha256: fileHash(hubEntry()), bridgeSha256: fileHash(path.join(dist, 'bridge.cjs')), uiSha256: fs.existsSync(path.join(dist, 'ui')) ? hashDir(path.join(dist, 'ui')) : 'missing' },
    fixtureSha256: hashDir(path.join(here, 'fixture')),
    tasks: opts.tasks,
    configs: opts.configs,
    repeat: opts.repeat,
    timeoutMin: opts.timeoutMs / 60000,
  };
}

// ---------- checkouts ----------

// ---------- Aivenue's own code: the OpenCode output parser and the flow modes ----------

let parserMod;
async function parserModule() {
  if (parserMod) return parserMod;
  const out = path.join(os.tmpdir(), `aivenue-bench-parser-${process.pid}.cjs`);
  await build({ stdin: { contents: "export { createParser } from './packages/core/src/providers/parsers'; export { addObserved } from './packages/core/src/promptStats'; export { applyStandard, matchesStandard } from './packages/core/src/flowMode';", resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  parserMod = createRequire(import.meta.url)(out);
  return parserMod;
}

const LIMITED = /rate.?limit|429|quota|too many requests|usage limit|limit reached|model.*(not found|unavailable|not available)|no such model|overloaded/i;

/**
 * Which model each expected session really used, from OpenCode's own record (`opencode session export <id>`, run in
 * the checkout). Every expected session is listed: one whose id is missing or whose record cannot be read is
 * "missing". Status: "mismatch" (some other model), "verified" (every session read and on the requested model),
 * "partly verified" (some read and right, some missing), "unverified" (none read).
 */
async function modelCheck(ctx, checkout, expected) {
  const cli = opencodeCli();
  const want = `${wantProvider}/${wantModel}`;
  const sessions = [];
  const seenIds = new Set();
  for (const e of expected) {
    if (!e.id) {
      sessions.push({ who: e.who, id: null, status: 'missing', place: 'unknown', why: 'no session id' });
      continue;
    }
    if (seenIds.has(e.id)) continue;
    seenIds.add(e.id);
    const child = ctx.spawn(cli.cmd, [...cli.pre, 'session', 'export', e.id], { cwd: checkout, env: envFor(checkout), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    await ctx.wait(new Promise((r) => child.on('close', r)));
    let data;
    try {
      data = JSON.parse(out.slice(out.indexOf('{')));
    } catch {
      data = undefined;
    }
    const models = [...new Set([...(data?.messages ?? []).map((m) => m.model ?? m.info?.model), data?.info?.model].filter(Boolean).map((m) => `${m.providerID ?? '?'}/${m.id ?? m.modelID ?? '?'}`))];
    // Where OpenCode located the session, and whether anything in it names the benchmark's own folder (its hidden
    // tests, reference solutions or the original fixture live there).
    const location = data?.info?.location?.directory ?? data?.info?.directory;
    const text = data ? JSON.stringify(data) : '';
    // No directory in the record is "unknown", never "inside".
    const place = !location ? 'unknown' : samePath(location, checkout) ? 'inside' : 'outside';
    // The benchmark's folder, and the folder it was started from (where an agent that ignores its working folder lands).
    const benchRef = [root, process.cwd()].flatMap((d) => [d, d.replace(/\\/g, '/'), d.replace(/\\/g, '\\\\')]).some((p) => p && text.toLowerCase().includes(p.toLowerCase()));
    // What the record shows about where it went counts even when it says nothing about the model.
    const status = !models.length ? 'missing' : models.every((m) => m === want) ? 'match' : 'mismatch';
    sessions.push({ who: e.who, id: e.id, status, ...(status === 'missing' ? { why: data ? 'no model in the record' : 'no readable record' } : { models }), location, place, outside: place === 'outside' ? location : undefined, benchRef });
  }
  const models = [...new Set(sessions.flatMap((x) => x.models ?? []))];
  const status = sessions.some((x) => x.status === 'mismatch')
    ? 'mismatch'
    : !sessions.length || sessions.every((x) => x.status === 'missing')
      ? 'unverified'
      : sessions.some((x) => x.status === 'missing')
        ? 'partly verified'
        : 'verified';
  const escaped = sessions.filter((x) => x.outside || x.benchRef);
  // Where the sessions say they worked, apart from which model: "match" only when every session's record names the checkout. This is the record, not an access boundary.
  const sessionDir = escaped.length ? 'outside' : sessions.length && sessions.every((x) => x.place === 'inside') ? 'match' : sessions.some((x) => x.place === 'inside') ? 'partly unknown' : 'unknown';
  return { status, models, sessions, sessionDir, escaped: escaped.length ? escaped.map((x) => `${x.who}: ${x.outside ? `worked in ${x.outside}` : 'named the benchmark folder'}`) : undefined };
}

/** After a run ran out of time: check the sessions it had started, in a separate, bounded time. */
export const POSTCHECK_MS = 120000;

const samePath = (a, b) => path.resolve(String(a)).toLowerCase().replace(/[\\/]+$/, '') === path.resolve(String(b)).toLowerCase().replace(/[\\/]+$/, '');

// ---------- setup: the CLI directly ----------

async function runDirect(ctx, checkout, prompt) {
  // Known from the start, so a run that runs out of time before any output can still be checked.
  Object.assign(ctx.partial, { checkout, expected: [{ who: 'cli', id: null }] });
  const { createParser, addObserved } = await parserModule();
  const started = Date.now();
  const events = [];
  const sessions = new Set();
  const parser = createParser('opencode-json', { emit: (e) => (events.push(e), events.length), updateTool: () => undefined }, checkout);
  const cli = opencodeCli();
  const child = ctx.spawn(cli.cmd, [...cli.pre, 'run', '--standalone', '--format', 'json', '--model', opts.model, '--auto'], { cwd: checkout, env: envFor(checkout), stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      // Every session the output names (the run's own and any child session), not only the first the parser reports.
      for (const m of line.matchAll(/"sessionID"\s*:\s*"([^"]+)"/g)) sessions.add(m[1]);
      parser.line(line);
      buf = buf.slice(i + 1);
    }
    // So far (kept if the run runs out of time).
    let seen;
    for (const e of events) if (e.usage) seen = addObserved(seen, e.usage);
    Object.assign(ctx.partial, { observed: seen, wallMs: Date.now() - started, agentMs: Date.now() - started, checkout, expected: sessions.size ? [...sessions].map((id) => ({ who: 'cli', id })) : [{ who: 'cli', id: null }] });
  });
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.end(prompt);
  const done = (code) => {
    if (buf) parser.line(buf);
    parser.end?.();
    let observed;
    for (const e of events) if (e.usage) observed = addObserved(observed, e.usage);
    const errors = events.filter((e) => e.kind === 'error').map((e) => e.text ?? '').concat(stderr.trim() ? [stderr.slice(-2000)] : []);
    return {
      wallMs: Date.now() - started,
      agentMs: Date.now() - started,
      waitingMs: 0,
      exitCode: code,
      observed,
      text: events.filter((e) => e.kind === 'message').map((e) => e.text ?? '').join('\n'),
      errors: errors.slice(0, 5),
      sessionIds: [...new Set([...events.map((e) => e.sessionId).filter(Boolean), ...sessions])],
      limited: errors.find((x) => LIMITED.test(x)),
    };
  };
  const code = await ctx.wait(new Promise((r) => child.on('close', r)));
  const r = done(code);
  const model = await modelCheck(ctx, checkout, r.sessionIds.length ? r.sessionIds.map((id) => ({ who: 'cli', id })) : [{ who: 'cli', id: null }]);
  return { ...r, model, finished: code === 0 };
}

// ---------- setups: Aivenue ----------

export async function aivenueConfig(setup, task, checkout) {
  const r = { provider: wantProvider, model: opts.model };
  const base = {
    title: task.id,
    goal: task.goal,
    cwd: checkout,
    permission: 'auto',
    assignment: { mode: 'manual' },
    memory: { mode: 'off' },
    context: { compactor: { provider: wantProvider, model: opts.model } },
    verify: { enabled: false, by: 'planner' },
  };
  if (setup === 'aivenue-single')
    return { ...base, plan: { enabled: false, author: r, reviewer: null, maxRounds: 1, humanGate: false }, implement: { enabled: true, author: r, reviewer: null, maxRounds: 1, humanGate: false }, subagents: { enabled: false, allowed: [], maxDepth: 1, maxConcurrent: 1 } };
  // The current default (packages/ui/src/components/RoleSettings.tsx defaultDraft), on the one free model.
  const current = {
    ...base,
    plan: { enabled: true, author: r, reviewer: r, maxRounds: 3, humanGate: false },
    implement: { enabled: true, author: r, reviewer: r, maxRounds: 3, humanGate: false },
    subagents: { enabled: true, allowed: [wantProvider], maxDepth: 1, maxConcurrent: 2, models: { [wantProvider]: { model: opts.model } } },
  };
  if (setup !== 'aivenue-standard') return current;
  // The standard flow mode, set by Aivenue's own function from the current default, as choosing it in the settings does.
  const { applyStandard, matchesStandard } = await parserModule();
  const standard = applyStandard(current);
  if (!matchesStandard(standard) || standard.flow !== 'standard') throw new Error('the standard setup is not the standard flow mode');
  return standard;
}

async function runAivenue(ctx, setup, task, checkout, home, goal = task.goal, stopOnFirstReview = false) {
  Object.assign(ctx.partial, { checkout, expected: [] });
  const hub = await startHub(ctx, home, checkout);
  const started = Date.now();
  const id = await hub.call('workflows.start', { config: { ...(await aivenueConfig(setup, task, checkout)), goal } });
  // Cancel it if the run ends early (deadline or error), before the hub process is ended.
  let ended = false;
  ctx.onCleanup(async () => !ended && hub.call('workflows.cancel', { id }).catch(() => undefined));
  let run;
  for (;;) {
    await ctx.wait(new Promise((r) => setTimeout(r, 3000)));
    run = await hub.call('workflows.get', { id });
    // So far (kept if the run runs out of time).
    const sofar = await hub.call('workflows.cost', { id }).catch(() => undefined);
    if (sofar) Object.assign(ctx.partial, { observed: sofar.total, wallMs: sofar.wallMs, agentMs: sofar.agentMs, waitingMs: sofar.waitingMs, promptTurns: sofar.turns });
    ctx.partial.checkout = checkout;
    ctx.partial.expected = Object.values(run?.agents ?? {})
      .filter((a) => a.role !== 'test' && a.startedAt)
      .map((a) => ({ who: `${a.role} ${a.id.slice(0, 8)}`, id: a.sessionId }));
    const review = run?.stages?.implement?.rounds?.find((x) => x.review)?.review;
    if (stopOnFirstReview && review) break;
    if (!['running', 'paused'].includes(run.status)) break;
  }
  const cost = await hub.call('workflows.cost', { id });
  if (['running', 'paused', 'waiting_human'].includes(run.status)) await hub.call('workflows.cancel', { id }).catch(() => undefined);
  ended = true;
  const agents = Object.values(run.agents ?? {}).filter((a) => a.role !== 'test');
  const errors = [run.error, ...agents.map((a) => a.failure?.message)].filter(Boolean);
  const otherProvider = agents.find((a) => a.provider !== wantProvider);
  const model = await modelCheck(ctx, checkout, agents.filter((a) => a.startedAt).map((a) => ({ who: `${a.role} ${a.id.slice(0, 8)}`, id: a.sessionId })));
  return {
    status: run.status,
    finished: run.status === 'completed',
    pending: run.pending?.message,
    wallMs: cost.wallMs ?? Date.now() - started,
    agentMs: cost.agentMs,
    waitingMs: cost.waitingMs,
    observed: cost.total,
    rows: cost.rows,
    blocks: cost.blocks.slice(0, 15),
    cut: cost.cut,
    promptTurns: cost.turns,
    agents: agents.map((a) => ({ role: a.role, provider: a.provider, requestedModel: a.model, sessionId: a.sessionId, status: a.status })),
    review: run.stages?.implement?.rounds?.find((x) => x.review)?.review,
    errors: errors.slice(0, 5),
    limited: errors.find((x) => LIMITED.test(x)),
    model: otherProvider ? { status: 'mismatch', models: [`${otherProvider.provider}/${otherProvider.model ?? '?'}`, ...model.models] } : model,
  };
}

// ---------- review ability ----------

const DEFECTS = JSON.parse(fs.readFileSync(path.join(here, 'review', 'defects.json'), 'utf8'));

/** Which known defects a review names (heuristic: one passage mentions the file and a keyword). */
export function found(passages) {
  return DEFECTS.defects
    .filter((d) =>
      passages.some((p) => {
        const t = p.toLowerCase();
        return t.includes(path.basename(d.file).toLowerCase()) && d.keywords.some((k) => t.includes(k.toLowerCase()));
      }),
    )
    .map((d) => d.id);
}

/** The whole checkout except .git (a reviewer must change nothing anywhere). */
const checkoutHash = (dir) => hashDir(dir, new Set(['.git']));

async function reviewRun(ctx, setup, work, name) {
  const task = TASKS.find((t) => t.id === DEFECTS.task);
  // The reference solution with the defective csv.js / report.js on top, left uncommitted: the change to review.
  const checkout = newCheckout(work, name, [path.join(here, 'reference', 'src'), path.join(here, 'review', 'src')]);
  const before = checkoutHash(checkout);
  const ask = `${task.goal}\n\nThe change for this task is already in the working tree (uncommitted: see git diff and the new files). Do not change any file.`;
  if (setup === 'direct-cli') {
    const r = await runDirect(ctx, checkout, `${ask}\nReview it: list every defect you find, each with the file it is in and why it is wrong.`);
    // The CLI's review is complete only when the CLI finished normally.
    return { ...r, changed: checkoutHash(checkout) !== before, reviewComplete: r.finished, found: found(r.text.split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.)\s)/)), raw: r.text.slice(0, 8000) };
  }
  const r = await runAivenue(ctx, setup, task, checkout, path.join(work, name, 'home'), `${ask}\nImplementer: make no changes; submit a short summary of what is in the working tree.`, true);
  const issues = r.review?.issues ?? [];
  // Aivenue's run is stopped on purpose after the first review: complete when that review was submitted.
  return { ...r, changed: checkoutHash(checkout) !== before, reviewComplete: !!r.review, found: found(issues.map((i) => `${i.title}\n${i.detail ?? ''}\n${i.location ?? ''}`)), raw: issues };
}

// ---------- outcomes ----------

/** What a solving run counts as (see the top of this file). */
export function outcome(r, accept) {
  if (r.limited) return { outcome: 'invalid', why: `model unavailable or limited: ${r.limited.slice(0, 200)}` };
  if (r.model?.escaped) return { outcome: 'invalid', why: `left its checkout: ${r.model.escaped.join('; ').slice(0, 200)}` };
  if (r.model?.status === 'mismatch') return { outcome: 'invalid', why: `ran on another model: ${r.model.models.join(', ')}` };
  if (r.timedOut) return { outcome: 'timeout', why: r.timeoutWhy };
  if (!r.finished) return { outcome: 'stopped', why: r.status ? `workflow ${r.status}${r.pending ? `: ${r.pending.slice(0, 120)}` : ''}` : `exit code ${r.exitCode}` };
  return accept.ok ? { outcome: 'pass' } : { outcome: 'fail', why: !accept.hiddenOk ? `hidden tests: ${accept.fail} failed` : 'visible tests failed' };
}

/** What a review run counts as. */
export function reviewOutcome(r) {
  if (r.limited) return { outcome: 'invalid', why: `model unavailable or limited: ${r.limited.slice(0, 200)}` };
  if (r.model?.escaped) return { outcome: 'invalid', why: `left its checkout: ${r.model.escaped.join('; ').slice(0, 200)}` };
  if (r.model?.status === 'mismatch') return { outcome: 'invalid', why: `ran on another model: ${r.model.models.join(', ')}` };
  if (r.changed) return { outcome: 'invalid', why: 'a file in the checkout was changed' };
  if (!r.reviewComplete) return { outcome: 'stopped', why: r.exitCode !== undefined ? `the review did not finish (exit code ${r.exitCode})` : 'no review was submitted' };
  return { outcome: 'reviewed' };
}

// ---------- the report ----------

const fmt = (n) => (n === undefined || n === null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
/** Whether any usage event was seen for the run (totals of 0 with no events are unknown, not zero). */
export const seenUsage = (r) => (r.result?.observed?.events ?? 0) > 0;
const secs = (ms) => (ms === undefined ? '—' : `${Math.round(ms / 1000)}s`);

function markdown(env, runs, reviews) {
  const lines = [
    `# Aivenue efficiency benchmark — ${env.label}`,
    '',
    `- ${env.at} · ${env.os} · Node ${env.node} · OpenCode ${env.opencodeVersion} · model ${env.model}`,
    `- Aivenue ${env.aivenue.commit.slice(0, 12)} (uncommitted diff ${env.aivenue.diffSha256.slice(0, 12)}, ${env.aivenue.untracked} untracked files ${env.aivenue.untrackedSha256.slice(0, 12)}) · hub bundle ${env.bundles.hubSha256.slice(0, 12)} · fixture ${env.fixtureSha256.slice(0, 12)} · ${env.timeoutMin} min per run`,
    `- ${runs.length} solving runs: ${['pass', 'fail', 'timeout', 'stopped', 'invalid', 'error'].map((o) => `${runs.filter((r) => r.outcome === o).length} ${o}`).join(', ')}. Initial screening only: it can show a clear regression, not prove that quality held.`,
    '- Pass rate counts pass / (pass + fail + timeout + stopped) among runs whose session dir is "match" (every session record names its own checkout): a run that hit the time limit counts as not solved. Invalid and error runs, and runs whose session dir is not "match", are left out (listed with their session dir). "match" comes from the session records only; it is not an access boundary.',
    `- A run that hit the time limit keeps the usage seen until then, marked "(partial)"; usage never seen is "—", never zero. After the limit, cleanup gets at most ${CLEANUP_GRACE_MS / 1000} s, recorded per run as cleanupMs. "partly verified": some sessions of the run could not be checked.`,
    '',
    '## Solving',
    '',
    '| setup | task | # | outcome | model | session dir | wall | agent time | uncached in | cached in | split unknown | out | cost | prompt turns | note |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of runs) {
    // No usage event seen: unknown ("—"), even when the totals read 0. Events that reported 0 stay 0.
    const o = seenUsage(r) ? r.result.observed : {};
    const part = r.result?.partialUsage ? ' (partial)' : '';
    lines.push(
      `| ${r.setup} | ${r.task} | ${r.n} | ${r.outcome} | ${r.result?.model?.status ?? '—'} | ${r.result?.model?.sessionDir ?? '—'} | ${secs(r.result?.wallMs)} | ${secs(r.result?.agentMs)} | ${fmt(o.uncachedInput)} | ${fmt(o.cachedInput)} | ${o.unsplit ? fmt(o.unsplit.input) : '—'} | ${fmt(o.output)}${o.events ? part : ''} | ${!o.events ? '—' : o.costUnknown || o.costUsd === undefined ? 'unknown' : `$${o.costUsd}`} | ${r.result?.promptTurns ?? '—'} | ${(r.why ?? r.error ?? '').replace(/\|/g, '/').slice(0, 160)} |`,
    );
  }
  lines.push('', '## Per setup', '', '| setup | counted runs | pass rate | timeouts | wall (min–max) | uncached+cached in (min–max) | out (min–max) | model verified | partial usage |', '|---|---|---|---|---|---|---|---|---|');
  for (const s of opts.configs) {
    const v = runs.filter((r) => r.setup === s && ['pass', 'fail', 'timeout', 'stopped'].includes(r.outcome) && r.result?.model?.sessionDir === 'match');
    if (!v.length) continue;
    // Unknown values are left out of a range (never taken as zero); runs with partial usage are counted and marked.
    const range = (f) => {
      const xs = v.map(f).filter((x) => typeof x === 'number');
      return xs.length ? `${fmt(Math.min(...xs))}–${fmt(Math.max(...xs))}${xs.length < v.length ? ` (${xs.length}/${v.length} known)` : ''}` : '—';
    };
    const inp = (r) => (seenUsage(r) ? r.result.observed.uncachedInput + r.result.observed.cachedInput : undefined);
    lines.push(
      `| ${s} | ${v.length} | ${Math.round((v.filter((r) => r.outcome === 'pass').length / v.length) * 100)}% | ${v.filter((r) => r.outcome === 'timeout').length} | ${range((r) => (r.result?.wallMs === undefined ? undefined : r.result.wallMs / 1000))}s | ${range(inp)} | ${range((r) => (seenUsage(r) ? r.result.observed.output : undefined))} | ${v.filter((r) => r.result?.model?.status === 'verified').length}/${v.length} | ${v.filter((r) => r.result?.partialUsage).length} |`,
    );
  }
  const blocks = new Map();
  for (const r of runs) for (const b of r.result?.blocks ?? []) blocks.set(b.key, (blocks.get(b.key) ?? 0) + b.tokens);
  if (blocks.size) {
    lines.push('', '## Largest prompt blocks (Aivenue setups, estimated tokens over all runs)', '');
    for (const [k, t] of [...blocks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) lines.push(`- ${k}: ${fmt(t)}`);
  }
  if (reviews.length) {
    lines.push('', '## Review ability', '', `Known defects: ${DEFECTS.defects.map((d) => `${d.id} ${d.what}`).join(' · ')}`, '', '| setup | # | outcome | model | session dir | found | note |', '|---|---|---|---|---|---|---|');
    for (const r of reviews) lines.push(`| ${r.setup} | ${r.n} | ${r.outcome} | ${r.result?.model?.status ?? '—'} | ${r.result?.model?.sessionDir ?? '—'} | ${r.result?.found?.join(', ') || 'none'} | ${(r.why ?? r.error ?? '').replace(/\|/g, '/').slice(0, 160)} |`);
    lines.push('', 'Matching is a heuristic (file name plus a keyword in one passage); the raw reviews are in report.json for a person to check.');
  }
  return lines.join('\n') + '\n';
}

// ---------- main ----------

async function main() {
  const plan = [];
  for (let n = 1; n <= opts.repeat; n++) {
    // Rotate the order of setups (and tasks) from one repeat to the next.
    const configs = opts.configs.map((_, i) => opts.configs[(i + n - 1) % opts.configs.length]);
    const tasks = opts.tasks.map((_, i) => opts.tasks[(i + n - 1) % opts.tasks.length]);
    for (const task of tasks) for (const setup of configs) plan.push({ kind: 'solve', setup, task, n });
    if (opts.review) for (const setup of configs.filter((c) => c !== 'aivenue-single')) plan.push({ kind: 'review', setup, task: DEFECTS.task, n });
  }

  console.log(`${plan.length} runs planned (${plan.filter((p) => p.kind === 'solve').length} solving, ${plan.filter((p) => p.kind === 'review').length} review-ability), model ${opts.model}`);
  for (const p of plan) console.log(`  ${p.kind.padEnd(6)} ${p.setup.padEnd(16)} ${p.task.padEnd(16)} #${p.n}`);
  if (!opts.go) {
    console.log('\nNothing was run. Add --go to run it.');
    return;
  }

  const env = environment();
  fs.mkdirSync(opts.out, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-bench-work-'));
  const runs = [];
  const reviews = [];
  const save = () => {
    fs.writeFileSync(path.join(opts.out, 'report.json'), JSON.stringify({ env, runs, reviews }, null, 1));
    fs.writeFileSync(path.join(opts.out, 'report.md'), markdown(env, runs, reviews));
  };
  // The fixture, hidden tests, reference solutions and review patch: a run must never change them.
  const guarded = (process.env.BENCH_GUARD ?? ['fixture', 'acceptance', 'reference', 'review'].map((d) => path.join(here, d)).join(path.delimiter)).split(path.delimiter).filter(Boolean);
  const guardHash = () => guarded.map((d) => (fs.existsSync(d) ? hashDir(d) : 'missing')).join(',');
  const guard = guardHash();
  for (const [i, p] of plan.entries()) {
    const name = `${String(i + 1).padStart(2, '0')}-${p.kind}-${p.setup}-${p.task}-${p.n}`;
    const entry = { ...p, id: randomUUID().slice(0, 8), name };
    process.stdout.write(`[${i + 1}/${plan.length}] ${name} … `);
    const started = Date.now();
    try {
      if (p.kind === 'review') {
        entry.result = await withDeadline(opts.timeoutMs, (ctx) => reviewRun(ctx, p.setup, work, name), entry);
        Object.assign(entry, reviewOutcome(entry.result));
      } else {
        const task = TASKS.find((t) => t.id === p.task);
        const checkout = newCheckout(work, name);
        entry.result = await withDeadline(opts.timeoutMs, (ctx) => (p.setup === 'direct-cli' ? runDirect(ctx, checkout, task.goal) : runAivenue(ctx, p.setup, task, checkout, path.join(work, name, 'home'))), entry);
        entry.accept = acceptance(task, checkout);
        Object.assign(entry, outcome(entry.result, entry.accept));
      }
    } catch (e) {
      if (e instanceof Deadline) {
        // Hitting the time limit is a result (not solved in time), not something to leave out.
        // What it used before then is kept and marked partial; what was never seen stays unknown, not zero.
        const p = e.partial ?? {};
        const why = `hit the ${opts.timeoutMs / 60000} min limit`;
        entry.result = { ...p, wallMs: Date.now() - started, partialUsage: true, timedOut: true, timeoutWhy: why };
        // Its processes have ended: now check where its sessions worked, in a separate, bounded time.
        try {
          entry.result.model = p.checkout ? await withDeadline(POSTCHECK_MS, (ctx) => modelCheck(ctx, p.checkout, p.expected?.length ? p.expected : [{ who: 'run', id: null }])) : { status: 'unverified', models: [], sessions: [], sessionDir: 'unknown' };
        } catch (err) {
          entry.result.model = { status: 'unverified', models: [], sessions: [], sessionDir: 'unknown', why: `the check after the time limit failed: ${String(err?.message ?? err).slice(0, 120)}` };
        }
        Object.assign(entry, p.kind === 'review' || entry.kind === 'review' ? reviewOutcome({ ...entry.result, reviewComplete: false, timedOut: true }) : outcome(entry.result, { ok: false }));
        if (entry.outcome === 'stopped' && entry.kind === 'review') Object.assign(entry, { outcome: 'timeout', why });
      } else Object.assign(entry, { outcome: 'error', error: String(e?.message ?? e).slice(0, 500) });
    }
    const touched = guardHash() !== guard;
    if (touched) Object.assign(entry, { outcome: 'invalid', why: `changed the benchmark's own files (${guarded.join(', ')})` });
    (p.kind === 'review' ? reviews : runs).push(entry);
    console.log(`${entry.outcome}${entry.why ? ` (${entry.why.slice(0, 100)})` : ''}${p.kind === 'review' && entry.result?.found ? ` found ${entry.result.found.join(',') || 'none'}` : ''}${entry.error ? `: ${entry.error}` : ''}`);
    save();
    if (touched) {
      console.log('\nStopped: a run changed the benchmark\'s own files. Restore them before running again.');
      process.exitCode = 2;
      break;
    }
  }
  console.log(`\nReport: ${path.join(opts.out, 'report.md')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
