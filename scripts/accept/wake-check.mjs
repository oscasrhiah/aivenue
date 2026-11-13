// Acceptance with a real CLI: an agent starts a small background job, registers it with notify_when_done, ends its
// turn without submitting; when the job ends, Aivenue must continue its conversation, and the agent reads the job's
// output and submits it.
//   node wake-check.mjs <checkout (built: npm run build)> <out dir>
// Only OpenCode is used (the only role of the workflow; no planner, reviewer, verifier or memory), so no other agent's
// quota is spent. WAKE_MODEL picks the OpenCode model (default a free one); WAKE_JOB_SEC the job's length (default
// 45); WAKE_TRIES how many workflows to try when the model does not follow the steps (default 2).
// Runs Aivenue's own hub from the checkout (not a packaged app) with its own AIVENUE_HOME under <out dir>; the user's
// ~/.aivenue is never used. The CLI's own session data stays where the CLI keeps it.
// Prints PASS / FAIL lines, writes wake-*.json and a timeline (wake-timeline-<attempt>.md, from the run's events);
// exits 1 when the wake-up was not shown working.
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Judge again what an earlier run left in <out dir> (its wake-attempt-*.json, wake-run-*.json, wake-home, wake-work-*),
// with this script's checks; no CLI is run and <out dir> is not changed. Timelines go to <timeline dir> when given.
//   node wake-check.mjs --judge <out dir> [<timeline dir>]
if (process.argv[2] === '--judge') {
  const out = path.resolve(process.argv[3] ?? '.');
  const tlDir = process.argv[4] && path.resolve(process.argv[4]);
  const attempts = fs.readdirSync(out).filter((f) => /^wake-attempt-\d+\.json$/.test(f)).sort();
  let failed = !attempts.length;
  if (!attempts.length) console.log(`  FAIL  no wake-attempt-*.json in ${out}`);
  for (const f of attempts) {
    const n = f.match(/\d+/)[0];
    const saved = JSON.parse(fs.readFileSync(path.join(out, f), 'utf8'));
    const run = JSON.parse(fs.readFileSync(path.join(out, `wake-run-${n}.json`), 'utf8'));
    const sawWaiting = saved.checks?.['the agent ended its turn and Aivenue showed it waiting for the job'];
    const j = judge({ run, home: path.join(out, 'wake-home'), dir: path.join(out, `wake-work-${n}`), expected: saved.expected, sawWaiting });
    console.log(`attempt ${n}: workflow ${run.id}`);
    for (const [k, v] of Object.entries(j.checks)) {
      if (!v) failed = true;
      console.log(`  ${v ? 'PASS' : 'FAIL'}  attempt ${n}: ${k}`);
    }
    if (tlDir) {
      fs.mkdirSync(tlDir, { recursive: true });
      fs.writeFileSync(path.join(tlDir, `wake-timeline-${n}.md`), timeline(run, j.ex, j.events, j.jobs, j.wakes));
    }
  }
  process.exit(failed ? 1 : 0);
}

const [repoArg, outArg] = process.argv.slice(2);
if (!repoArg || !outArg) {
  console.error('usage: node wake-check.mjs <built checkout> <out dir>   |   node wake-check.mjs --judge <out dir> [<timeline dir>]');
  process.exit(2);
}
const REPO = path.resolve(repoArg);
const OUT = path.resolve(outArg);
const PROVIDER = 'opencode';
const MODEL = process.env.WAKE_MODEL || 'opencode/deepseek-v4.1-flash-free';
const JOB_SEC = Number(process.env.WAKE_JOB_SEC || 45);
const TRIES = Number(process.env.WAKE_TRIES || 2);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
fs.mkdirSync(OUT, { recursive: true });

function startHub(home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO, 'packages/desktop/dist/standalone.cjs')], { env: { ...process.env, AIVENUE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    const logf = fs.createWriteStream(path.join(OUT, 'wake-hub.log'));
    child.stderr.pipe(logf);
    let buf = '';
    child.stdout.on('data', (d) => {
      logf.write(d);
      buf += d;
      const m = buf.match(/Aivenue running: (http:\/\/127\.0\.0\.1:(\d+)\/\?token=([0-9a-f]+))/);
      if (m) resolve({ child, port: m[2], token: m[3] });
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

/**
 * The working folder: a job that waits, then writes its result code. The code comes from a new secret each attempt, so
 * a result left from an earlier attempt cannot pass. The secret is in job.js, which the agent may read: what shows the
 * wake-up is when result.txt is read and the result submitted (only after Aivenue continued the conversation).
 */
function prepare(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const secret = crypto.randomBytes(16).toString('hex');
  const code = crypto.createHash('sha256').update(secret).digest('hex').slice(0, 12);
  fs.writeFileSync(
    path.join(dir, 'job.js'),
    [
      `// A small background job: works for ${JOB_SEC} s, then writes its result.`,
      `const fs = require('fs');`,
      `console.log('job started');`,
      `setTimeout(() => {`,
      `  fs.writeFileSync(__dirname + '/result.txt', 'RESULT-' + require('crypto').createHash('sha256').update(${JSON.stringify(secret)}).digest('hex').slice(0, 12) + '\\n');`,
      `  console.log('job done 100%');`,
      `}, ${JOB_SEC * 1000});`,
      '',
    ].join('\n'),
  );
  return `RESULT-${code}`;
}

const GOAL = [
  'This is a test of waiting for a background job. Follow these steps exactly, and change no files.',
  '1. In the working folder, start `node job.js` in the BACKGROUND, with its output going to job.log, and get its PID.',
  '   - Linux / macOS shell: `nohup node job.js > job.log 2>&1 & echo $!`',
  '   - Windows PowerShell: `(Start-Process node -ArgumentList job.js -RedirectStandardOutput job.log -WindowStyle Hidden -PassThru).Id`',
  '2. Right after it started, register it with the Aivenue tool `track_process` {pid: <that PID>, purpose: "result job", cleanup: "agent", log: "job.log", notify_when_done: true}.',
  `3. Then END YOUR TURN IMMEDIATELY, without submitting. Do not wait for the job in any way: no sleep, no polling, no wait_for, no reading result.txt yet (the job takes about ${JOB_SEC} seconds). Aivenue continues this conversation by itself when the job ends.`,
  '4. When Aivenue tells you the job ended, read result.txt on its own: with your file-read tool, or with the single command `cat result.txt` and nothing else in that command. Then submit your work (submit_work) with a summary that contains the line from result.txt exactly (it starts with RESULT-).',
].join('\n');

function config(dir) {
  const role = { provider: PROVIDER, model: MODEL };
  const off = { enabled: false, author: role, reviewer: null, maxRounds: 1, humanGate: false };
  return {
    title: 'acceptance: wake after a background job',
    goal: GOAL,
    cwd: dir,
    plan: off,
    implement: { enabled: true, author: role, reviewer: null, maxRounds: 1, humanGate: false },
    verify: { enabled: false, by: 'planner', repeatLimit: 1 },
    subagents: { enabled: false, allowed: [], maxDepth: 1, maxConcurrent: 1 },
    assignment: { mode: 'manual', auto: undefined },
    permission: 'auto',
    isolation: 'none',
    memory: { mode: 'off' },
    limits: { enabled: true, maxMinutes: 15, noProgressMinutes: 8 },
  };
}

// Function declarations, not consts: --judge (at the top) uses them before this point.
function inputOf(tool) {
  try {
    const i = typeof tool.input === 'string' ? JSON.parse(tool.input) : tool.input;
    return i && typeof i === 'object' ? i : {};
  } catch {
    return {};
  }
}

/**
 * Whether a finished tool call is a confirmed read of <cwd>/result.txt. All of:
 * - it succeeded, and its output holds `expected` (the result code, new each attempt): it ran, and what it read is
 *   that file's content;
 * - a file read (category "read") whose path is that very file, or a terminal command that is one plain read of it:
 *   cat / type / Get-Content / gc, optional switches, the path, and nothing else (no ; && || | > < ` $( or new line:
 *   what ran cannot be told apart then). Relative paths count from the command's own workdir, else from <cwd>.
 * Anything else, a submission, an edit, a search, a command that only names the file or reads another one, is no
 * evidence; nor is a read inside OpenCode's code mode, which is not recognised: the check then fails rather than pass
 * on what it cannot confirm.
 */
function readOfResult(tool, cwd, expected) {
  if (tool?.status !== 'ok' || !cwd || !expected || !String(tool.output ?? '').includes(expected)) return false;
  const input = inputOf(tool);
  const win = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.includes('\\');
  const P = win ? path.win32 : path.posix;
  const key = (p) => (win ? P.normalize(p).toLowerCase() : P.normalize(p));
  const target = key(P.join(cwd, 'result.txt'));
  const base = typeof input.workdir === 'string' && input.workdir ? P.resolve(cwd, input.workdir) : cwd;
  const isTarget = (p) => typeof p === 'string' && p.trim() !== '' && key(P.resolve(base, p.trim())) === target;
  if (tool.category === 'read') return [input.path, input.file_path, input.filePath, input.absolute_path, input.AbsolutePath].some(isTarget);
  if (tool.category === 'command') {
    const cmd = String(input.command ?? input.cmd ?? input.CommandLine ?? '').trim();
    if (/[;&|<>`\r\n]|\$\(/.test(cmd)) return false;
    const m = /^(?:cat|type|Get-Content|gc)(?:\.exe)?(?:\s+-[A-Za-z]+)*\s+(?:"([^"]+)"|'([^']+)'|([^\s"']+))(?:\s+-[A-Za-z]+)*$/i.exec(cmd);
    return !!m && isTarget(m[1] ?? m[2] ?? m[3]);
  }
  return false;
}

/** Whether a call other than Aivenue's own tools names result.txt at all (a peek before the wake-up, of any kind). */
function namesResult(tool) {
  return tool?.category !== 'hub' && /result\.txt/i.test(`${tool?.title ?? ''} ${typeof tool?.input === 'string' ? tool.input : JSON.stringify(tool?.input ?? '')}`);
}

/**
 * What one attempt shows, from the run, the executor's events as Aivenue stored them (under the run's AIVENUE_HOME)
 * and the working folder. `sawWaiting`: whether the executor was seen waiting for the job while the run went on (only
 * visible live: the run keeps no record of it).
 */
function judge({ run, home, dir, expected, sawWaiting }) {
  const texts = (run.log ?? []).map((l) => l.text);
  // Every job registered to be waited for (an agent may register a wrong PID first, then the real one: each is its own
  // job and wakes it once).
  const jobs = (run.processes ?? []).filter((x) => x.notify);
  const job = jobs[0];
  const summary = run.stages?.implement?.rounds?.at(-1)?.submission?.summary ?? '';
  const result = fs.existsSync(path.join(dir, 'result.txt')) ? fs.readFileSync(path.join(dir, 'result.txt'), 'utf8').trim() : '';
  const ex = Object.values(run.agents ?? {}).find((a) => a.role === 'executor');
  const evFile = ex ? path.join(home, 'runs', run.id, 'events', `${ex.id}.jsonl`) : '';
  const events = evFile && fs.existsSync(evFile) ? fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const tools = events.filter((e) => e.kind === 'tool' && e.tool?.status !== 'running');
  // One line per wake-up; it names every job that ended for it.
  const wakes = (run.log ?? []).filter((l) => /等待的背景程序已結束|was waiting for ended/.test(l.text));
  const wakesOf = (j) => wakes.filter((l) => new RegExp(`PID ${j.pid}(?!\\d)`).test(l.text)).length;
  const resumed = (ex?.promptTurns ?? []).filter((t) => t.resumed).length;
  const wakeAt = wakes[0]?.ts ?? Infinity;
  const sessions = events.filter((e) => e.kind === 'session' && e.sessionId).map((e) => e.sessionId);
  const cwd = run.config?.cwd ?? dir;
  const readsResult = (e) => readOfResult(e.tool, cwd, expected);
  const submits = tools.filter((e) => e.tool.category === 'hub' && /^submit_/.test(e.tool.name));
  const checks = {
    'workflow completed': run.status === 'completed',
    'a background job registered with notify_when_done': jobs.length > 0,
    'the agent ended its turn and Aivenue showed it waiting for the job': !!sawWaiting,
    'the job ended and Aivenue continued the conversation': wakes.length > 0,
    'woken once for each waited job (one wake-up each, one resumed turn per wake-up)': jobs.length > 0 && jobs.every((j) => wakesOf(j) === 1) && resumed === wakes.length,
    'the wake-up continued the same CLI session': sessions.length >= 2 && new Set(sessions).size === 1,
    'Aivenue delivered each ended job to the agent (marked as told)': jobs.length > 0 && jobs.every((j) => j.announced === true),
    'not asked to hand in a result (no "did not submit" nudge)': !texts.some((t) => /沒有提交結果，要求補交|did not submit; asking again/.test(t)),
    'nothing submitted before the wake-up': submits.length > 0 && submits.every((e) => e.ts > wakeAt),
    // After the wake-up, a read that is confirmed; before it, nothing that even names the file.
    'result.txt read only after the wake-up': tools.some((e) => readsResult(e) && e.ts > wakeAt) && !tools.some((e) => namesResult(e.tool) && e.ts < wakeAt),
    'preflight did not report the CLI as not signed in': !texts.some((t) => /^(預檢|Preflight)：.*(尚未登入|not signed in)/.test(t)),
    'the job wrote its result': result === expected,
    'the submitted summary contains the job result': !!expected && summary.includes(expected),
  };
  return { checks, job, jobs, summary, result, ex, events, wakes, sessions };
}

/** The attempt's timeline (local time), from the run's log, the executor's events and the job: for the report. */
function timeline(run, ex, events, jobs, wakes) {
  const rows = [];
  const short = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 120).replace(/\|/g, '\\|');
  const add = (ts, what, detail = '') => ts && rows.push({ ts, what, detail: short(detail) });
  add(run.createdAt, 'workflow started', run.id);
  let turn = 0;
  for (const e of events) {
    if (e.kind === 'prompt') add(e.ts, `turn ${++turn} prompt`, turn > 1 ? e.text : '');
    else if (e.kind === 'session') add(e.ts, 'CLI session', e.sessionId);
    else if (e.kind === 'result') add(e.ts, 'turn ended', e.text);
    else if (e.kind === 'tool' && e.tool?.status !== 'running') add(e.ts, `tool ${e.tool.name}`, e.tool.title);
  }
  // endedAt is when Aivenue saw the job gone: it checks every 3 s while the agent waits.
  for (const j of jobs) if (j.endedAt) add(j.endedAt, 'job end seen by Aivenue', `PID ${j.pid}`);
  for (const w of wakes) add(w.ts, 'wake-up', w.text);
  add(run.endedAt, `workflow ${run.status}`);
  rows.sort((a, b) => a.ts - b.ts);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const at = (ts) => {
    const d = new Date(ts);
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  };
  const off = -new Date(run.createdAt ?? Date.now()).getTimezoneOffset();
  const zone = `UTC${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  const t0 = rows[0]?.ts ?? 0;
  return [
    `# Wake-up timeline: workflow ${run.id}`,
    '',
    `- Date ${new Date(t0).toISOString().slice(0, 10)}, times in ${zone}; executor ${ex?.provider ?? '?'} ${ex?.model ?? ''}`,
    `- Waited jobs: ${jobs.map((j) => `PID ${j.pid}`).join(', ') || 'none'}; wake-ups: ${wakes.length}; resumed turns: ${(ex?.promptTurns ?? []).filter((t) => t.resumed).length}`,
    '- "job end seen by Aivenue" is when Aivenue saw the process gone (it checks every 3 s while waiting), not when it exited.',
    '',
    '| time | +s | event | detail |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${at(r.ts)} | ${((r.ts - t0) / 1000).toFixed(1)} | ${r.what} | ${r.detail} |`),
    '',
  ].join('\n');
}

const home = path.join(OUT, 'wake-home');
fs.mkdirSync(home, { recursive: true });
const hub = await startHub(home);
const rpc = await connect(hub);
const info = await rpc.call('host.info').catch(() => ({}));
log('hub', hub.port, 'version', info.version, 'build', info.build);
const providers = await rpc.call('providers.list');
const p = providers.find((x) => x.spec?.id === PROVIDER);
log(`${PROVIDER}:`, JSON.stringify({ installed: p?.installed, auth: p?.auth?.state, version: p?.version }), 'model', MODEL || '(default)');
let fails = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => (fails++, console.log(`  FAIL  ${m}`));
if (!p?.installed) {
  bad(`${PROVIDER} is not installed: install OpenCode and run again`);
  rpc.close();
  hub.child.kill();
  process.exit(1);
}

let verdict;
for (let attempt = 1; attempt <= TRIES && !verdict?.passed; attempt++) {
  const dir = path.join(OUT, `wake-work-${attempt}`);
  const expected = prepare(dir);
  const id = await rpc.call('workflows.start', { config: config(dir) });
  log(`attempt ${attempt}: workflow ${id}, expecting ${expected}`);
  const t0 = Date.now();
  let run;
  let sawWaiting = false;
  let waitingSince = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    run = await rpc.call('workflows.get', { id });
    const ex = Object.values(run.agents ?? {}).find((a) => a.role === 'executor');
    if (/等待背景程序結束|Waiting for background job/.test(ex?.waiting ?? '')) sawWaiting = true;
    if (['completed', 'incomplete', 'failed', 'cancelled', 'interrupted'].includes(run.status)) break;
    if (run.status === 'waiting_human' || run.status === 'paused') {
      waitingSince ||= Date.now();
      if (Date.now() - waitingSince > 60_000) {
        log('waiting on a person; cancelling:', JSON.stringify(run.pending ?? {}).slice(0, 300));
        await rpc.call('workflows.cancel', { id });
      }
    } else waitingSince = 0;
    if (Date.now() - t0 > 16 * 60_000) {
      log('over 16 minutes; cancelling');
      await rpc.call('workflows.cancel', { id });
    }
  }
  fs.writeFileSync(path.join(OUT, `wake-run-${attempt}.json`), JSON.stringify(run, null, 1));
  const { checks, jobs, summary, result, ex, events, wakes, sessions } = judge({ run, home, dir, expected, sawWaiting });
  const passed = Object.values(checks).every(Boolean);
  verdict = { attempt, workflow: id, minutes: ((Date.now() - t0) / 60000).toFixed(1), status: run.status, expected, result, summary: summary.slice(0, 500), jobs: jobs.map((j) => ({ pid: j.pid, notify: j.notify, announced: j.announced, endedAt: j.endedAt })), sessions: [...new Set(sessions)], checks, passed };
  fs.writeFileSync(path.join(OUT, `wake-attempt-${attempt}.json`), JSON.stringify(verdict, null, 1));
  fs.writeFileSync(path.join(OUT, `wake-timeline-${attempt}.md`), timeline(run, ex, events, jobs, wakes));
  log(`attempt ${attempt}: ${passed ? 'passed' : 'not passed'} in ${verdict.minutes} min`);
  for (const [k, v] of Object.entries(checks)) console.log(`      ${v ? 'yes' : 'NO '}  ${k}`);
}
for (const [k, v] of Object.entries(verdict.checks)) (v ? ok : bad)(`attempt ${verdict.attempt}: ${k}`);
fs.writeFileSync(path.join(OUT, 'wake-summary.json'), JSON.stringify({ provider: PROVIDER, model: MODEL, jobSec: JOB_SEC, hub: { version: info.version, build: info.build }, ...verdict }, null, 1));
rpc.close();
hub.child.kill();
process.exit(fails ? 1 : 0);
