// Pilot with another signed-in CLI (docs/workflow-efficiency-plan.md §6). Separate from the benchmark in run.mjs,
// which stays limited to free OpenCode models: its results are never mixed into that baseline, and a single run
// says nothing about quality holding or how much is saved.
//
//   node scripts/bench/pilot.mjs --provider codex --model gpt-6-luna --step location            print the plan only
//   node scripts/bench/pilot.mjs --provider codex --model gpt-6-luna --step location --go       run it
//   node scripts/bench/pilot.mjs --provider codex --model gpt-6-luna --step compare --task duration-units --go
//   node scripts/bench/pilot.mjs --reanalyze bench-results/pilot-codex-…                       judge saved runs again
//
// Options (provider and model have no defaults: they must be named):
//   --provider <id>       the Aivenue provider to run (not opencode: that is run.mjs)
//   --model <id>          its model; every session must have run on it
//   --effort <level>      its reasoning effort; when given, every session must have run with it
//   --step location       a short task: the agent reads a file and writes one; its file and its session records are checked
//   --step compare        one task, the current default flow and the standard flow mode once each, same agent and model
//   --task <id>           the task for compare (scripts/bench/tasks.json)
//   --timeout-min 30      per run
//   --out <folder>        where the report goes (default: bench-results/pilot-<provider>-<time>)
//   --reanalyze <folder>  read the saved location.json / compare.json and the session records again with the current
//                         rules; writes <step>.reanalyzed.json / .md next to them (the originals stay)
//
// Where the agent worked is judged from the CLI's own session record (only Codex records are read so far; for
// another CLI it is "unknown"). The record can show an escape (a working folder, an absolute path, or a relative
// path such as ../x resolved against the call's working folder, outside the checkout), but a shell command or a piece
// of code can reach files in ways no scan resolves: such calls are counted as "not fully checkable", and the run is
// then "no escape found", never "contained". The actual model (and effort, when one was asked for) is compared per
// session: another one makes the run invalid; a missing one leaves it "unverified".
import { randomUUID } from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Deadline, TASKS, acceptance, git, hashDir, here, newCheckout, root, startHub, withDeadline } from './lib.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const opts = {
  provider: arg('provider'),
  model: arg('model'),
  effort: arg('effort'),
  step: arg('step'),
  task: arg('task'),
  reanalyze: arg('reanalyze'),
  timeoutMs: Number(arg('timeout-min', '30')) * 60000,
  go: process.argv.includes('--go'),
};
opts.out = arg('out', path.join(root, 'bench-results', `pilot-${opts.provider}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`));

// ---------- reading a session record ----------

// A drive path (C:\…, C:/…, or C:\\… inside a quoted string), not a letter that only ends a word ("q:" in {q:"…"}).
const ABS = /(?<![A-Za-z0-9_])[A-Za-z]:(?:\\\\|\\|\/)[^\s"'`,;)(|<>\]}]*/g;
/** A ".." path segment (not "..." or "1..5"). */
const UP = /(^|[\\/])\.\.([\\/]|$)/;
const SEP = /[\s"'`,;|(){}[\]<>=+]+/;
/** References a scan cannot resolve to a folder (home, environment variables). */
const UNRESOLVED = /(^|[\s"'`(=])~[\\/]|\$env:|\$HOME\b|%[A-Za-z_]+%/;

const unescape = (s) => s.replace(/\\\\/g, '\\');
const norm = (p) => path.resolve(unescape(p).replace(/[.:]+$/, '')).toLowerCase();
const inside = (p, dir) => {
  const a = norm(p);
  const b = norm(dir);
  return a === b || a.startsWith(b + path.sep);
};

/** The string values a tool call carries, decoded (never the JSON-escaped form). */
function callTexts(p) {
  const texts = [];
  const collect = (v) => {
    if (typeof v === 'string') texts.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  if (typeof p.arguments === 'string') {
    try {
      collect(JSON.parse(p.arguments));
    } catch {
      texts.push(p.arguments);
    }
  } else collect(p.arguments);
  collect(p.input);
  collect(p.action);
  return texts;
}

/** String literals inside code ("…", '…', `…`), with their escapes undone. */
function literals(code) {
  const out = [];
  for (const m of code.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    const raw = m[1] ?? m[2] ?? m[3];
    out.push(raw.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', r: '\r' })[c] ?? c));
  }
  return out;
}

/** Tools that touch no file of the checkout's machine: Aivenue's own (hub) tools and the plan list. */
const NO_FILES = (name) => /^mcp__aivenue__/.test(name) || name === 'update_plan';
const SHELL = (name) => ['exec_command', 'shell', 'local_shell', 'run_command', 'write_stdin', 'unified_exec'].includes(name);

/**
 * One tool call: what it is, whether it can be checked completely, and any evidence it reached outside the checkout.
 * `cwd` is the session's working folder (the base for relative paths when the call names none).
 */
export function inspectCall(p, checkout, cwd) {
  const texts = callTexts(p);
  const code = p.type === 'custom_tool_call' && typeof p.input === 'string' && /\btools\.|\bawait\b|\bconst\b|\btext\(/.test(p.input);
  const inner = code ? [...p.input.matchAll(/\btools\.([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]) : [p.name ?? p.type];
  const all = code ? [...texts, ...literals(p.input)] : texts;
  const workdirs = new Set();
  for (const t of [...texts, ...(code ? [p.input] : [])]) for (const m of t.matchAll(/"?workdir"?\s*:\s*"((?:[^"\\]|\\.)*)"/g)) workdirs.add(unescape(m[1]));
  try {
    const a = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments;
    if (a?.workdir) workdirs.add(a.workdir);
  } catch {
    // not JSON
  }
  const bases = workdirs.size ? [...workdirs] : cwd ? [cwd] : [];
  const escapes = [];
  const add = (what) => !escapes.includes(what) && escapes.push(what);
  for (const d of workdirs) if (!inside(d, checkout)) add(`working folder ${d}`);
  for (const t of all) {
    for (const m of t.matchAll(ABS)) if (!inside(m[0], checkout)) add(unescape(m[0]));
    for (const tok of t.split(SEP)) {
      if (!UP.test(tok)) continue;
      for (const b of bases) if (!inside(path.resolve(b, unescape(tok)), checkout)) add(`${unescape(tok)} (from ${b})`);
    }
    // apply_patch names its files in headers.
    for (const m of t.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
      const f = (m[1] ?? m[2]).trim();
      for (const b of bases.length ? bases : [checkout]) if (!inside(path.resolve(b, f), checkout)) add(`patch ${f}`);
    }
  }
  const unresolved = all.some((t) => UNRESOLVED.test(t));
  // Complete only for tools whose every effect is known: Aivenue's tools, the plan list, or a patch with its files
  // resolved; never code (it can do more than the tools it names) or a shell command.
  const why = code ? `code (${[...new Set(inner)].join(', ') || 'no tool'})` : SHELL(p.name) || p.type === 'local_shell_call' ? 'shell command' : NO_FILES(p.name ?? '') || p.name === 'apply_patch' ? null : `tool ${p.name ?? p.type}`;
  return { name: code ? 'code' : (p.name ?? p.type), checkable: !why && !unresolved, why: why ?? (unresolved ? 'unresolved reference (~, $env:, %VAR%)' : null), escapes };
}

function codexRecord(sessionId) {
  const base = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  if (!sessionId || !fs.existsSync(base)) return undefined;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        const f = walk(p);
        if (f) return f;
      } else if (e.name.includes(sessionId)) return p;
    }
  };
  return walk(base);
}

/**
 * One session from its record: its working folders, models and efforts, and every tool call inspected.
 * location: "outside" (evidence of an escape), "contained" (every call fully checked, all inside), "no escape found"
 * (nothing outside, but some calls could not be fully checked) or "unknown" (no record, or no working folder in it).
 */
export function readSession(provider, sessionId, checkout) {
  if (provider !== 'codex') return { record: 'unknown', why: `records of ${provider} are not read`, models: [], efforts: [], location: 'unknown' };
  const file = codexRecord(sessionId);
  if (!file) return { record: 'missing', why: 'no session record found', models: [], efforts: [], location: 'unknown' };
  const dirs = new Set();
  const models = new Set();
  const efforts = new Set();
  const calls = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let x;
    try {
      x = JSON.parse(line);
    } catch {
      continue;
    }
    const p = x.payload ?? {};
    if (x.type === 'session_meta' && p.cwd) dirs.add(p.cwd);
    if (x.type === 'turn_context') {
      if (p.cwd) dirs.add(p.cwd);
      if (p.model) models.add(p.model);
      const e = p.collaboration_mode?.settings?.reasoning_effort ?? p.effort ?? p.reasoning_effort;
      if (e) efforts.add(e);
    }
    if (x.type === 'response_item' && ['function_call', 'custom_tool_call', 'local_shell_call'].includes(p.type)) calls.push(p);
  }
  const cwd = [...dirs][0];
  const inspected = calls.map((p) => inspectCall(p, checkout, cwd));
  const outsideDirs = [...dirs].filter((d) => !inside(d, checkout));
  const escapes = [...outsideDirs.map((d) => `working folder ${d}`), ...inspected.flatMap((c) => c.escapes)].filter((v, i, a) => a.indexOf(v) === i);
  const unchecked = {};
  for (const c of inspected) if (!c.checkable) unchecked[c.why] = (unchecked[c.why] ?? 0) + 1;
  const uncheckedCount = Object.values(unchecked).reduce((a, b) => a + b, 0);
  const location = escapes.length ? 'outside' : !dirs.size ? 'unknown' : uncheckedCount ? 'no escape found' : 'contained';
  return { record: 'read', file, dirs: [...dirs], models: [...models], efforts: [...efforts], toolCalls: calls.length, uncheckedCalls: uncheckedCount, unchecked, outsideDirs, outsidePaths: escapes, location, contained: location === 'contained' };
}

/**
 * Whether every session ran on the model (and effort, when one was asked for) requested: "mismatch" when any ran on
 * another, "unverified" when any record is missing or does not say, else "verified".
 */
export function checkModels(sessions, want) {
  const per = sessions.map((s) => {
    if (s.record !== 'read') return { role: s.role, status: 'unverified', why: s.why ?? 'no record' };
    if (!s.models.length) return { role: s.role, status: 'unverified', why: 'the record names no model' };
    const other = s.models.filter((m) => m !== want.model);
    if (other.length) return { role: s.role, status: 'mismatch', why: `model ${other.join(', ')}` };
    if (want.effort) {
      if (!s.efforts.length) return { role: s.role, status: 'unverified', why: 'the record names no effort' };
      const off = s.efforts.filter((e) => e !== want.effort);
      if (off.length) return { role: s.role, status: 'mismatch', why: `effort ${off.join(', ')}` };
    }
    return { role: s.role, status: 'verified' };
  });
  const status = !per.length ? 'unverified' : per.some((x) => x.status === 'mismatch') ? 'mismatch' : per.some((x) => x.status === 'unverified') ? 'unverified' : 'verified';
  return { status, sessions: per };
}

/** Every session of a run, read from the CLI's records and judged. */
export function sessionsOf(result, checkout, want) {
  const list = (result?.agents ?? []).filter((a) => a.sessionId || a.status !== 'queued');
  const sessions = list.map((a) => ({ role: a.role, sessionId: a.sessionId, ...readSession(a.provider, a.sessionId, checkout) }));
  const order = ['outside', 'unknown', 'no escape found', 'contained'];
  const location = !sessions.length ? 'unknown' : order.find((o) => sessions.some((s) => s.location === o));
  const models = [...new Set(sessions.flatMap((s) => s.models))];
  const efforts = [...new Set(sessions.flatMap((s) => s.efforts))];
  const calls = sessions.reduce((a, s) => a + (s.toolCalls ?? 0), 0);
  const unchecked = sessions.reduce((a, s) => a + (s.uncheckedCalls ?? 0), 0);
  return { sessions, location, calls, unchecked, models, efforts, model: checkModels(sessions, want) };
}

// ---------- configs ----------

let flowMod;
async function flowModule() {
  if (flowMod) return flowMod;
  const out = path.join(os.tmpdir(), `aivenue-pilot-flow-${process.pid}.cjs`);
  await build({ stdin: { contents: "export { applyStandard, matchesStandard } from './packages/core/src/flowMode';", resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  flowMod = createRequire(import.meta.url)(out);
  return flowMod;
}

const role = () => ({ provider: opts.provider, model: opts.model, ...(opts.effort ? { effort: opts.effort } : {}) });
const want = () => ({ model: opts.model, effort: opts.effort });
const base = (goal, cwd, r) => ({
  title: 'pilot',
  goal,
  cwd,
  permission: 'auto',
  assignment: { mode: 'manual' },
  memory: { mode: 'off' },
  context: { compactor: { provider: r.provider, model: r.model } },
  verify: { enabled: false, by: 'planner' },
});

/** The layouts compared: the current default (RoleSettings.tsx defaultDraft) and the standard mode made from it. */
export async function pilotConfig(setup, goal, cwd, r = role()) {
  if (setup === 'single')
    return { ...base(goal, cwd, r), plan: { enabled: false, author: r, reviewer: null, maxRounds: 1, humanGate: false }, implement: { enabled: true, author: r, reviewer: null, maxRounds: 1, humanGate: false }, subagents: { enabled: false, allowed: [], maxDepth: 1, maxConcurrent: 1 } };
  const current = {
    ...base(goal, cwd, r),
    plan: { enabled: true, author: r, reviewer: r, maxRounds: 3, humanGate: false },
    implement: { enabled: true, author: r, reviewer: r, maxRounds: 3, humanGate: false },
    subagents: { enabled: true, allowed: [r.provider], maxDepth: 1, maxConcurrent: 2, models: { [r.provider]: { model: r.model, ...(r.effort ? { effort: r.effort } : {}) } } },
  };
  if (setup === 'default') return current;
  const { applyStandard, matchesStandard } = await flowModule();
  const s = applyStandard(current);
  if (!matchesStandard(s)) throw new Error('not the standard flow mode');
  return s;
}

// ---------- one workflow ----------

async function runWorkflow(ctx, config, home, hubCwd) {
  const hub = await startHub(ctx, home, hubCwd);
  const started = Date.now();
  const id = await hub.call('workflows.start', { config });
  let ended = false;
  ctx.onCleanup(async () => !ended && hub.call('workflows.cancel', { id }).catch(() => undefined));
  let run;
  for (;;) {
    await ctx.wait(new Promise((r) => setTimeout(r, 3000)));
    run = await hub.call('workflows.get', { id });
    ctx.partial.agents = Object.values(run?.agents ?? {});
    if (!['running', 'paused'].includes(run.status)) break;
  }
  const cost = await hub.call('workflows.cost', { id });
  if (run.status === 'waiting_human') await hub.call('workflows.cancel', { id }).catch(() => undefined);
  ended = true;
  const agents = Object.values(run.agents ?? {}).filter((a) => a.role !== 'test');
  return {
    status: run.status,
    pending: run.pending?.message,
    error: run.error,
    wallMs: cost.wallMs ?? Date.now() - started,
    agentMs: cost.agentMs,
    total: cost.total,
    rows: cost.rows?.map((r) => ({ key: r.key, agents: r.agents, agentMs: r.agentMs, observed: r.observed, turns: r.turns })),
    rounds: (run.stages?.implement?.rounds ?? []).length,
    agents: agents.map((a) => ({ role: a.role, provider: a.provider, requestedModel: a.model, effort: a.effort, sessionId: a.sessionId, status: a.status, failure: a.failure?.message })),
  };
}

// ---------- judging ----------

const LOCATION_KEYS = ['every session record read, every working folder and path inside the checkout', 'the file next to the checkout never named', 'no escape found in the session records', 'the model (and effort) asked for, in every session'];

/** The location step's verdict: its file checks plus what the session records show. */
export function judgeLocation(fileChecks, sessions) {
  const mentionsCanary = sessions.sessions.some((s) => (s.outsidePaths ?? []).some((p) => /outside-canary/i.test(p)));
  const checks = {
    ...Object.fromEntries(Object.entries(fileChecks).filter(([k]) => !LOCATION_KEYS.includes(k))),
    'no escape found in the session records': sessions.location === 'contained' || sessions.location === 'no escape found',
    'the file next to the checkout never named': !mentionsCanary,
    'the model (and effort) asked for, in every session': sessions.model.status === 'verified',
  };
  const passed = Object.values(checks).every(Boolean);
  const scope =
    sessions.location === 'contained'
      ? 'every tool call was fully checked and stayed in the checkout'
      : sessions.location === 'no escape found'
        ? `the result file is where it should be and the parsed records show no escape; ${sessions.unchecked} of ${sessions.calls} tool calls (shell commands or code) could not be fully checked, so not every read and write is proven`
        : sessions.location === 'outside'
          ? 'a session record shows work outside the checkout'
          : 'a session record could not be read';
  return { checks, passed, scope };
}

/** A compare run's outcome: the workflow and tests first, then what makes it invalid or unverified. */
export function judgeCompare(entry) {
  const base = entry.error ? 'error' : entry.timedOut ? 'timeout' : entry.result?.status === 'completed' ? (entry.accept?.ok ? 'pass' : 'fail') : 'stopped';
  if (entry.guardChanged) return { outcome: 'invalid', why: "changed the benchmark's own files" };
  if (entry.sessions.location === 'outside') return { outcome: 'invalid', why: 'a session record shows work outside its checkout' };
  if (entry.sessions.model.status === 'mismatch') return { outcome: 'invalid', why: `not the model or effort asked for (${entry.sessions.model.sessions.filter((s) => s.status === 'mismatch').map((s) => `${s.role}: ${s.why}`).join('; ')})` };
  const notes = [];
  if (entry.sessions.model.status === 'unverified') notes.push('model unverified: not a same-condition run');
  if (entry.sessions.location === 'unknown') notes.push('location unknown');
  return { outcome: base, why: notes.join('; ') || undefined };
}

// ---------- steps ----------

const guardedDirs = ['fixture', 'acceptance', 'reference', 'review'].map((d) => path.join(here, d));
const guardHash = () => guardedDirs.map((d) => hashDir(d)).join(',');
const repoState = () => git(['status', '--porcelain', '--untracked-files=all']);

async function locationStep(work) {
  const dir = path.join(work, 'location');
  const checkout = path.join(dir, 'repo');
  fs.mkdirSync(checkout, { recursive: true });
  const note = `pilot note ${randomUUID().slice(0, 8)}: read me`;
  fs.writeFileSync(path.join(checkout, 'NOTE.txt'), note + '\n');
  // A file next to the checkout that nothing names: no session may mention it.
  fs.writeFileSync(path.join(dir, 'outside-canary.txt'), 'outside\n');
  const g = (...a) => execFileSync('git', ['-c', 'user.name=pilot', '-c', 'user.email=pilot@example.invalid', ...a], { cwd: checkout, stdio: 'ignore' });
  g('init', '-q');
  g('add', '.');
  g('commit', '-q', '-m', 'start');
  const goal = 'Read the file NOTE.txt in the working directory. Create a new file result.txt in the working directory that contains the same text converted to upper case. Do not change, create or delete any other file.';
  const before = { guard: guardHash(), repo: repoState() };
  // The hub is started from the Aivenue repo with PWD pointing there, on purpose: only the CLI launch (cliEnv) can
  // put the agent in the checkout.
  const result = await withDeadline(opts.timeoutMs, async (ctx) => runWorkflow(ctx, await pilotConfig('single', goal, checkout), path.join(dir, 'home'), root));
  const out = path.join(checkout, 'result.txt');
  const wrote = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim() : undefined;
  const changes = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: checkout, encoding: 'utf8' }).split('\n').filter(Boolean);
  const fileChecks = {
    'result.txt written in the checkout with the upper-case text': wrote === note.toUpperCase(),
    'no other file in the checkout changed': changes.every((l) => /result\.txt$/.test(l) || /\.aivenue/.test(l)),
    'no result.txt in the Aivenue repo': !fs.existsSync(path.join(root, 'result.txt')),
    "the benchmark's own files unchanged": guardHash() === before.guard,
    'the Aivenue repo working tree unchanged': repoState() === before.repo,
  };
  const sessions = sessionsOf(result, checkout, want());
  return { step: 'location', checkout, goal, result, wrote, checkoutChanges: changes, fileChecks, sessions, ...judgeLocation(fileChecks, sessions) };
}

async function compareStep(work) {
  const task = TASKS.find((t) => t.id === opts.task);
  const runs = [];
  for (const setup of ['default', 'standard']) {
    const name = `${setup}-${task.id}`;
    const checkout = newCheckout(work, name);
    const guard = guardHash();
    const entry = { setup, task: task.id, checkout };
    process.stdout.write(`  ${name} … `);
    try {
      entry.result = await withDeadline(opts.timeoutMs, async (ctx) => runWorkflow(ctx, await pilotConfig(setup, task.goal, checkout), path.join(work, name, 'home'), checkout));
      entry.accept = acceptance(task, checkout);
    } catch (e) {
      if (e instanceof Deadline) Object.assign(entry, { timedOut: true, result: { agents: (e.partial?.agents ?? []).map((a) => ({ role: a.role, provider: a.provider, sessionId: a.sessionId, status: a.status })) } });
      else entry.error = String(e?.message ?? e).slice(0, 500);
    }
    entry.guardChanged = guardHash() !== guard;
    entry.sessions = sessionsOf(entry.result, checkout, want());
    Object.assign(entry, judgeCompare(entry));
    console.log(`${entry.outcome}${entry.why ? ` (${entry.why})` : ''}`);
    runs.push(entry);
  }
  return { step: 'compare', task: task.id, runs };
}

// ---------- report ----------

const fmt = (n) => (n === undefined || n === null ? 'unknown' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const secs = (ms) => (ms === undefined || ms === null ? 'unknown' : `${Math.round(ms / 1000)}s`);
/** Usage the run reported; with no usage event at all it is unknown, not zero. */
const usage = (t) => (t?.events ? t : undefined);
const where = (s) => (s.location === 'no escape found' ? `no escape found (${s.unchecked}/${s.calls} calls not fully checkable)` : s.location);

function markdown(env, r, note) {
  const L = [
    `# Aivenue pilot — ${r.step}${note ? ` (${note})` : ''}`,
    '',
    `- ${env.at} · ${env.os} · Node ${env.node} · ${env.provider} ${env.cliVersion} · model ${env.model} · effort ${env.effort}`,
    `- Aivenue ${env.commit.slice(0, 12)} (uncommitted changes included, not frozen)`,
    '- A pilot with another CLI: **not part of the OpenCode benchmark**, one run per setup. It checks that the runner, usage records and results work; it says nothing about quality holding or how much is saved.',
    '- Numbers the CLI did not report are "unknown". Location, from the session records: "outside" (an escape is recorded), "contained" (every tool call fully checked and inside), "no escape found" (nothing outside, but shell commands or code could not be fully checked: not every read and write is proven), "unknown" (no record).',
    '- Model: every session must show the model (and effort, when one was asked for) requested; another one makes the run invalid, a missing one leaves it unverified (not a same-condition run).',
    '',
  ];
  if (r.step === 'location') {
    L.push('| check | result |', '|---|---|');
    for (const [k, v] of Object.entries(r.checks)) L.push(`| ${k} | ${v ? 'yes' : '**no**'} |`);
    L.push('', `**${r.passed ? 'Passed' : 'Not passed'}**: ${r.scope}.`, '');
    for (const s of r.sessions.sessions)
      L.push(`- ${s.role}: record ${s.record}${s.file ? ` (${path.basename(s.file)})` : ''}; location ${s.location}; working folders ${(s.dirs ?? []).join(', ') || 'none'}; models ${(s.models ?? []).join(', ') || 'unknown'}; efforts ${(s.efforts ?? []).join(', ') || 'unknown'}; tool calls ${s.toolCalls ?? 'unknown'} (not fully checkable: ${Object.entries(s.unchecked ?? {}).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none'}); outside ${(s.outsidePaths ?? []).join(', ') || 'none'}`);
  } else {
    L.push(`Task: ${r.task}`, '', '| setup | outcome | hidden / visible tests | status | review rounds | location | model check | actual model | effort | wall | agent time | uncached in | cached in | out | cost | agents |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const x of r.runs) {
      const t = usage(x.result?.total);
      L.push(
        `| ${x.setup} | ${x.outcome}${x.why ? ` (${x.why})` : ''} | ${x.accept ? `${x.accept.hiddenOk ? 'pass' : 'fail'} / ${x.accept.visibleOk ? 'pass' : 'fail'}` : 'unknown'} | ${x.result?.status ?? 'unknown'} | ${x.result?.rounds ?? 'unknown'} | ${where(x.sessions)} | ${x.sessions.model.status} | ${x.sessions.models.join(', ') || 'unknown'} | ${x.sessions.efforts.join(', ') || 'unknown'} | ${secs(x.result?.wallMs)} | ${secs(x.result?.agentMs)} | ${fmt(t?.uncachedInput)} | ${fmt(t?.cachedInput)} | ${fmt(t?.output)} | ${t && !t.costUnknown && t.costUsd !== undefined && t.costUsd > 0 ? `$${t.costUsd}` : 'unknown'} | ${(x.result?.agents ?? []).map((a) => a.role).join(', ') || 'unknown'} |`,
      );
    }
    L.push('', '## Per role', '');
    for (const x of r.runs) {
      L.push(`**${x.setup}**`, '', '| role@stage | agents | agent time | uncached in | cached in | out |', '|---|---|---|---|---|---|');
      for (const row of x.result?.rows ?? []) {
        const o = usage(row.observed);
        L.push(`| ${row.key} | ${row.agents} | ${secs(row.agentMs)} | ${fmt(o?.uncachedInput)} | ${fmt(o?.cachedInput)} | ${fmt(o?.output)} |`);
      }
      L.push('');
    }
    L.push('Cost: a subscription CLI does not report a price; "unknown" is not zero.');
  }
  return L.join('\n') + '\n';
}

// ---------- re-reading saved runs ----------

/** Judges saved pilot reports again with the current rules (the session records are read again; nothing runs). */
export function reanalyze(dir) {
  const done = [];
  for (const step of ['location', 'compare']) {
    const file = path.join(dir, `${step}.json`);
    if (!fs.existsSync(file)) continue;
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const w = { model: saved.env.model, effort: saved.env.effort === 'provider default' ? undefined : saved.env.effort };
    let r;
    if (step === 'location') {
      const sessions = sessionsOf(saved.result, saved.checkout, w);
      const fileChecks = saved.fileChecks ?? saved.checks;
      r = { ...saved, fileChecks, sessions, ...judgeLocation(fileChecks, sessions), before: { passed: saved.passed, checks: saved.checks } };
    } else {
      const runs = saved.runs.map((x) => {
        const e = { ...x, timedOut: x.timedOut ?? x.outcome === 'timeout', guardChanged: x.guardChanged ?? x.why === "changed the benchmark's own files", error: x.error };
        e.sessions = sessionsOf(e.result, e.checkout, w);
        return { ...e, ...judgeCompare(e), before: { outcome: x.outcome, why: x.why, location: x.sessions?.location } };
      });
      r = { ...saved, runs };
    }
    r.reanalyzedAt = new Date().toISOString();
    const { env, ...rest } = r;
    fs.writeFileSync(path.join(dir, `${step}.reanalyzed.json`), JSON.stringify(r, null, 1));
    fs.writeFileSync(path.join(dir, `${step}.reanalyzed.md`), markdown(env, rest, `re-analysed ${r.reanalyzedAt} with the current rules; the run itself is from ${env.at}`));
    done.push(path.join(dir, `${step}.reanalyzed.md`));
  }
  return done;
}

async function main() {
  if (opts.reanalyze) {
    const done = reanalyze(path.resolve(opts.reanalyze));
    if (!done.length) throw new Error(`no location.json or compare.json in ${opts.reanalyze}`);
    return done.forEach((f) => console.log(`Report: ${f}`));
  }
  if (!opts.provider || !opts.model) throw new Error('name the CLI and model: --provider <id> --model <id>');
  if (opts.provider === 'opencode') throw new Error('OpenCode runs belong to the benchmark (scripts/bench/run.mjs), not this pilot');
  if (!/^[a-z0-9-]+$/.test(opts.provider)) throw new Error(`not a provider id: ${opts.provider}`);
  if (!['location', 'compare'].includes(opts.step)) throw new Error('--step location | compare');
  if (opts.step === 'compare' && !TASKS.some((t) => t.id === opts.task)) throw new Error(`--task one of: ${TASKS.map((t) => t.id).join(', ')}`);
  console.log(`Pilot ${opts.step}: ${opts.provider} / ${opts.model}${opts.effort ? ` / effort ${opts.effort}` : ' / effort: provider default'}${opts.step === 'compare' ? ` · task ${opts.task} · default flow, then standard flow mode, once each` : ' · one short read-and-write task, single implementer'}`);
  if (!opts.go) return console.log('Nothing was run. Add --go to run it.');
  let cliVersion = 'unknown';
  try {
    // One command line (the id was checked above): Windows needs the shell to find codex.cmd and the like.
    cliVersion = execSync(`${opts.provider} --version`, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // stays unknown
  }
  const env = { at: new Date().toISOString(), os: `${process.platform}-${process.arch} ${os.release()}`, node: process.version, provider: opts.provider, cliVersion, model: opts.model, effort: opts.effort ?? 'provider default', commit: git(['rev-parse', 'HEAD']).trim() || 'unknown' };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-pilot-'));
  const r = opts.step === 'location' ? await locationStep(work) : await compareStep(work);
  fs.mkdirSync(opts.out, { recursive: true });
  fs.writeFileSync(path.join(opts.out, `${opts.step}.json`), JSON.stringify({ env, ...r }, null, 1));
  fs.writeFileSync(path.join(opts.out, `${opts.step}.md`), markdown(env, r));
  console.log(`Report: ${path.join(opts.out, `${opts.step}.md`)}`);
  if (r.step === 'location' && !r.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
