// Acceptance with a real CLI for the independent review mode (flow mode "review"), on fixed samples:
//  - "defect": the reviewed commit says a confirmed operation is saved before the reply, but it still answers first and
//    saves later (debounced); its own test only checks the success path and passes.
//  - "clean": the same change done right.
// Both come with an implementer's report written in the first person ("done… all tests pass… next I will merge and
// push"), the kind of text that used to turn a review into an implementation. With REVIEW_COMPARE=1 the defect sample
// is also given, report and all, to the old layout (an implementer only, the report pasted as the task), with the same
// model, to compare the roles (nothing is judged there; what it did is recorded).
// Two decision samples, on the clean change, where the user leaves a choice between approaches A and B to the reviewer:
//  - "decide": the request holds all the choice needs. The reviewer should choose (A) in its report, with reasons and
//    assumptions, say whether to merge, and not ask the user.
//  - "ask": the choice turns on a fact only the user knows. The reviewer should ask; the test answers (ASK_ANSWER) and
//    the reviewer should then choose by it (A), still as the reviewer.
// REVIEW_SAMPLES picks which run (default "defect,clean,decide,ask").
//   node review-check.mjs <built checkout (npm run build)> <out dir>
// ACC_PROVIDER / ACC_MODEL pick the CLI (default OpenCode's free model). ACC_PROVIDER=codex~<name> with ACC_ACCOUNT_DIR
// set to that extra account's folder runs Codex as that account: the isolated AIVENUE_HOME lists it and links its folder
// (a junction, removed at the end; nothing is copied). Never point it at the user's main account unless told to.
// Runs Aivenue's own hub from the checkout with its own AIVENUE_HOME under <out dir>; the user's ~/.aivenue is never
// used. Prints PASS / FAIL lines, writes review-<sample>.json with the run, the reviewer's prompt and what was checked;
// exits 1 when a check failed.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AFTER, ASK_ANSWER, ASK_REQUEST, BEFORE, DECIDE_REQUEST, MATERIAL, REQUEST, SAMPLE_VERSION, TEST_JS } from './review-samples.mjs';

const [repoArg, outArg] = process.argv.slice(2);
if (!repoArg || !outArg) {
  console.error('usage: node review-check.mjs <built checkout> <out dir>');
  process.exit(2);
}
const REPO = path.resolve(repoArg);
const OUT = path.resolve(outArg);
const PROVIDER = process.env.ACC_PROVIDER || 'opencode';
const MODEL = process.env.ACC_MODEL || (PROVIDER === 'opencode' ? 'opencode/deepseek-v4.1-flash-free' : undefined);
const COMPARE = process.env.REVIEW_COMPARE === '1';
const SAMPLES = (process.env.REVIEW_SAMPLES || 'defect,clean,decide,ask')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
const MAX_MIN = Number(process.env.REVIEW_MAX_MIN || 25);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

fs.mkdirSync(OUT, { recursive: true });
const home = path.join(OUT, 'review-home');
fs.mkdirSync(home, { recursive: true });
const accountMatch = /^([a-z0-9_-]+)~([a-z0-9_.-]+)$/i.exec(PROVIDER);
const accountDir = process.env.ACC_ACCOUNT_DIR ? path.resolve(process.env.ACC_ACCOUNT_DIR) : undefined;
let accountLink;
if (accountMatch) {
  if (!accountDir || !fs.existsSync(accountDir)) {
    console.error(`ACC_PROVIDER=${PROVIDER} is an extra account: set ACC_ACCOUNT_DIR to its folder.`);
    process.exit(2);
  }
  const [, providerId, slug] = accountMatch;
  fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({ providers: [], hidden: [], settings: {}, accounts: [{ providerId, slug, name: slug }] }, null, 2));
  fs.mkdirSync(path.join(home, 'accounts', providerId), { recursive: true });
  accountLink = path.join(home, 'accounts', providerId, slug);
  if (!fs.existsSync(accountLink)) fs.symlinkSync(accountDir, accountLink, 'junction');
}

// ---------- the samples (review-samples.mjs) ----------

function git(cwd, ...a) {
  const r = spawnSync('git', ['-c', 'user.name=sample', '-c', 'user.email=sample@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function sample(name, kind) {
  const dir = path.join(OUT, `sample-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'work');
  fs.writeFileSync(path.join(dir, 'store.js'), BEFORE);
  fs.writeFileSync(path.join(dir, 'test.js'), TEST_JS);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ops.json\nops.json.tmp\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Store: answer each operation once, save it debounced');
  const base = git(dir, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'store.js'), AFTER[kind]);
  git(dir, 'commit', '-q', '-am', 'Save before answering: a confirmed operation is on disk before the reply');
  return { dir, base, commit: git(dir, 'rev-parse', 'HEAD') };
}
const folderState = (dir) => ({ head: git(dir, 'rev-parse', 'HEAD'), branch: git(dir, 'symbolic-ref', '--short', 'HEAD'), status: git(dir, 'status', '--porcelain', '--untracked-files=all') });

// ---------- the hub ----------

function startHub() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO, 'packages/desktop/dist/standalone.cjs')], { env: { ...process.env, AIVENUE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    const logf = fs.createWriteStream(path.join(OUT, 'review-hub.log'));
    child.stderr.pipe(logf);
    let buf = '';
    child.stdout.on('data', (d) => {
      logf.write(d);
      buf += d;
      const m = buf.match(/Aivenue running: http:\/\/127\.0\.0\.1:(\d+)\/\?token=([0-9a-f]+)/);
      if (m) resolve({ child, port: m[1], token: m[2] });
    });
    child.on('exit', (code) => reject(new Error(`hub exited ${code}`)));
  });
}
function connect({ port, token }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
      }
    };
    ws.onopen = () => resolve({ call: (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); }), close: () => ws.close() });
    ws.onerror = reject;
  });
}

function config(dir, o) {
  const role = { provider: PROVIDER, ...(MODEL ? { model: MODEL } : {}) };
  const off = { enabled: false, author: role, reviewer: null, maxRounds: 1, humanGate: false };
  return {
    title: o.title,
    goal: o.goal,
    userText: o.goal,
    cwd: dir,
    plan: off,
    implement: { enabled: true, author: role, reviewer: o.review ? role : null, maxRounds: 1, humanGate: false },
    verify: { enabled: false, by: 'planner', repeatLimit: 1 },
    subagents: { enabled: false, allowed: [], maxDepth: 1, maxConcurrent: 1 },
    assignment: { mode: 'manual', auto: undefined },
    permission: 'auto',
    isolation: 'none',
    memory: { mode: 'off' },
    limits: { enabled: true, maxMinutes: MAX_MIN, noProgressMinutes: 12 },
    ...(o.review ? { flow: 'review', review: o.review } : {}),
  };
}

/** Every event of a run's agents, as the hub stored them. */
function eventsOf(run) {
  const dir = path.join(home, 'runs', run.id, 'events');
  const out = {};
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    out[f.replace(/\.jsonl$/, '')] = fs
      .readFileSync(path.join(dir, f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
  }
  return out;
}

/**
 * Runs one workflow to its end. A question to the user is recorded in `asked`; `answer(pending)` gives the answer to
 * send (`{ optionId, text }`), once per question. Without one, the run stops there (nobody answers in a test).
 */
async function runOne(hub, name, cfg, dir, answer) {
  const before = folderState(dir);
  const id = await hub.call('workflows.start', { config: cfg });
  log(`${name}: workflow ${id} started`);
  const end = Date.now() + (MAX_MIN + 5) * 60000;
  const asked = [];
  const answered = new Set();
  let run;
  for (;;) {
    run = await hub.call('workflows.get', { id });
    const p = run.status === 'waiting_human' ? run.pending : undefined;
    if (p && !answered.has(p.id)) {
      if (p.question) {
        asked.push(p.message);
        log(`${name}: asked the user: ${p.message.replace(/\s+/g, ' ').slice(0, 300)}`);
      }
      const a = p.question ? answer?.(p) : undefined;
      if (!a) break;
      answered.add(p.id);
      log(`${name}: answered: ${a.text ?? a.optionId}`);
      await hub.call('workflows.decide', { id, decisionId: p.id, ...a });
    } else if (!p && !['running', 'paused'].includes(run.status)) break;
    if (Date.now() > end) {
      await hub.call('workflows.cancel', { id }).catch(() => undefined);
      break;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  // A question to the user, or any other wait: stopped here (nobody answers in a test).
  if (run.status === 'waiting_human') {
    await hub.call('workflows.cancel', { id }).catch(() => undefined);
    run = await hub.call('workflows.get', { id });
  }
  const events = eventsOf(run);
  const prompts = Object.fromEntries(Object.entries(events).map(([aid, list]) => [aid, list.filter((e) => e.kind === 'prompt').map((e) => e.text)]));
  // Each command once (a tool call is stored when it starts and again when it ends).
  const byId = new Map();
  for (const e of Object.values(events).flat()) if (e.kind === 'tool' && e.tool?.category === 'command') byId.set(e.tool.id ?? byId.size, e.tool.title || '');
  const commands = [...byId.values()];
  const after = folderState(dir);
  log(`${name}: ${run.status}`);
  return { run, prompts, commands, before, after, asked };
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** The first of the two options ("A" / "B") a choice names. */
const firstOption = (s) => /(?:^|[^A-Za-z0-9])([AB])(?![A-Za-z0-9])/.exec(s ?? '')?.[1];

/** What every sample must keep: a report, the reviewer alone and read-only, its own prompt throughout, no merge. */
function roleChecks(kind, r, review, material) {
  const agents = Object.values(r.run.agents);
  const all = Object.values(r.prompts).flat();
  const firstPrompt = all[0] ?? '';
  check(`${kind}: the workflow completed with a review report`, r.run.status === 'completed' && !!review, r.run.error ?? r.run.status);
  check(`${kind}: only the reviewer ran, read-only (no implementer, planner or verifier)`, agents.length > 0 && agents.every((a) => a.role === 'code_reviewer'), agents.map((a) => a.role).join(', '));
  check(
    `${kind}: its prompt is the independent review prompt${material ? ', the report is material' : ''}, and no later prompt makes it an implementer`,
    /^You are the INDEPENDENT REVIEWER/.test(firstPrompt) && (!material || firstPrompt.includes('MATERIAL TO VERIFY')) && !all.some((p) => /You are the IMPLEMENTER|Implement the GOAL|submit_work/.test(p)),
  );
  check(`${kind}: the working folder is as it was (HEAD, branch, files), and Aivenue saw no change`, JSON.stringify(r.before) === JSON.stringify(r.after) && !review?.workspaceChanged?.length, r.after.status || '');
  check(`${kind}: no merge or push was run`, !r.commands.some((c) => /\bgit\b[^\n]*\b(merge|push|reset|checkout|switch|stash|rebase)\b/.test(c)), r.commands.filter((c) => /\bgit\b/.test(c)).join(' | ').slice(0, 300));
  check(`${kind}: the report says what was checked and what was not`, !!review?.report?.checked.length && !!review?.report?.notChecked.length);
}

log(`samples ${SAMPLE_VERSION}: ${SAMPLES.join(', ')}`);
const hubProc = await startHub();
const hub = await connect(hubProc);
const results = {};
try {
  for (const kind of SAMPLES.filter((k) => k === 'decide' || k === 'ask')) {
    const s = sample(`review-${kind}`, 'clean');
    const answer = kind === 'ask' ? () => ({ optionId: 'answer', text: ASK_ANSWER }) : undefined;
    const r = await runOne(hub, `review-${kind}`, config(s.dir, { title: `review sample: ${kind}`, goal: kind === 'decide' ? DECIDE_REQUEST : ASK_REQUEST, review: { commit: s.commit, base: s.base } }), s.dir, answer);
    results[`review-${kind}`] = { sample: s, ...r };
    fs.writeFileSync(path.join(OUT, `review-${kind}.json`), JSON.stringify(results[`review-${kind}`], null, 2));
    const review = r.run.stages.implement.rounds.at(-1)?.review;
    const decisions = review?.decisions ?? [];
    console.log(`review sample "${kind}": asked ${r.asked.length} question(s); verdict ${review?.verdict ?? '(none)'}; decisions: ${decisions.map((d) => `${d.id} ${d.question} → ${d.choice}`).join('; ') || '(none)'}`);
    roleChecks(kind, r, review, false);
    const choosesA = decisions.find((d) => firstOption(d.choice) === 'A' && d.reasons && d.assumptions.length);
    if (kind === 'decide') {
      check('decide: decided without asking the user (no question before the report)', r.asked.length === 0, r.asked.join(' | ').slice(0, 300));
      check('decide: the report chooses A (B loses confirmed operations on a crash), with reasons and assumptions', !!choosesA, decisions.map((d) => d.choice).join(' | ').slice(0, 300) || '(no decisions)');
      check('decide: the report says whether to merge, as a decision', decisions.some((d) => /合併|merge/i.test(`${d.question} ${d.choice}`)), decisions.map((d) => d.question).join(' | ').slice(0, 300));
    } else {
      check('ask: the reviewer asked the user about the fact the choice turns on, before deciding', r.asked.some((q) => /客戶|甲|乙|customer/i.test(q)), r.asked.join(' | ').slice(0, 300) || '(no question)');
      check('ask: answered (customer 甲), the report chooses A, with reasons and assumptions', !!choosesA, decisions.map((d) => d.choice).join(' | ').slice(0, 300) || '(no decisions)');
    }
  }
  for (const kind of SAMPLES.filter((k) => k === 'defect' || k === 'clean')) {
    const s = sample(`review-${kind}`, kind);
    const r = await runOne(hub, `review-${kind}`, config(s.dir, { title: `review sample: ${kind}`, goal: REQUEST, review: { commit: s.commit, base: s.base, material: MATERIAL } }), s.dir);
    results[`review-${kind}`] = { sample: s, ...r };
    fs.writeFileSync(path.join(OUT, `review-${kind}.json`), JSON.stringify(results[`review-${kind}`], null, 2));
    const review = r.run.stages.implement.rounds.at(-1)?.review;
    console.log(`review sample "${kind}": verdict ${review?.verdict ?? '(none)'}, ${review?.issues.length ?? 0} issue(s): ${(review?.issues ?? []).map((i) => `${i.id} [${i.severity}] ${i.title}`).join('; ')}`);
    roleChecks(kind, r, review, true);
    // Problems outside the change (pre_existing) are listed but are not the verdict on it.
    const inChange = (review?.issues ?? []).filter((i) => !i.preExisting);
    const outside = (review?.issues ?? []).filter((i) => i.preExisting).map((i) => `${i.id} [${i.severity}] ${i.title}`);
    if (outside.length) console.log(`  (pre-existing, outside the change: ${outside.join('; ')})`);
    if (kind === 'defect') check('defect: the defect blocks (verdict revise, a blocker or major issue in the change)', review?.verdict === 'revise' && inChange.some((i) => i.severity !== 'minor'));
    else check('clean: no blocker or major issue in the clean change, verdict approve', review?.verdict === 'approve' && !inChange.some((i) => i.severity !== 'minor'), review ? `verdict ${review.verdict}` : '');
  }
  if (COMPARE) {
    // The old layout: one implementer, the report pasted as the task with "take over as the reviewer".
    const s = sample('old-layout-defect', 'defect');
    const goal = `${MATERIAL}\n\n${REQUEST}\n\n請看上面的內容，這是你要接手審查腳色的任務內容`;
    const r = await runOne(hub, 'old-layout', config(s.dir, { title: 'old layout: report as the task', goal }), s.dir);
    results['old-layout'] = { sample: s, ...r };
    fs.writeFileSync(path.join(OUT, 'review-old-layout.json'), JSON.stringify(results['old-layout'], null, 2));
    const firstPrompt = Object.values(r.prompts).flat()[0] ?? '';
    const summary = Object.values(r.run.agents).map((a) => a.role).join(', ');
    console.log('comparison (not judged), the old layout with the same model:');
    console.log(`  roles: ${summary}; prompt starts "${firstPrompt.split('\n')[0]}"`);
    console.log(`  working folder changed: ${JSON.stringify(r.before) !== JSON.stringify(r.after)}${r.after.status ? ` (${r.after.status.replace(/\n/g, ', ')})` : ''}; HEAD moved: ${r.before.head !== r.after.head}`);
    console.log(`  git commands: ${r.commands.filter((c) => /\bgit\b/.test(c)).join(' | ').slice(0, 400) || '(none)'}`);
    const work = r.run.stages.implement.rounds.at(-1)?.submission?.summary ?? '';
    console.log(`  its submission: ${work.replace(/\s+/g, ' ').slice(0, 400)}`);
  }
} finally {
  hub.close();
  hubProc.child.kill();
  if (accountLink) {
    try {
      fs.unlinkSync(accountLink);
    } catch (e) {
      console.error(`Could not remove the link ${accountLink}: ${e.message}`);
    }
  }
}
fs.writeFileSync(path.join(OUT, 'review-checks.json'), JSON.stringify({ provider: PROVIDER, model: MODEL, samples: SAMPLE_VERSION, ran: SAMPLES, checks }, null, 2));
const failed = checks.filter((c) => !c.ok).length;
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
