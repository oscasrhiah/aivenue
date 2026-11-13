import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from './lib/test-shard.mjs';

// The release acceptance scripts (scripts/accept): what they count as evidence, and what they may stop.
const ACCEPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'accept');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `aivenue-accept-${name}-`));

// ---------- wake-check.mjs --judge ----------

const EXPECTED = 'RESULT-0123456789ab';
const PID = 4242;
const SESSION = 'ses_one';

/**
 * A wake-up acceptance result folder as wake-check.mjs leaves it, for one attempt that worked: the job registered,
 * the turn ended, Aivenue woke the agent once in the same session, it read result.txt and submitted.
 * `edit(events, run)` changes it before it is written.
 */
function wakeResult(edit = () => undefined) {
  const out = tmp('wake');
  const t = (s) => 1_000_000 + s * 1000;
  const tool = (s, name, category, input, title = name, status = 'ok') => ({ kind: 'tool', ts: t(s), tool: { id: `c${s}`, name, category, title, input: JSON.stringify(input), status } });
  const events = [
    { kind: 'prompt', ts: t(1), text: 'You are the IMPLEMENTER' },
    { kind: 'session', ts: t(2), sessionId: SESSION },
    tool(3, 'read', 'read', { filePath: path.join(out, 'wake-work-1', 'job.js') }, 'job.js'),
    tool(4, 'shell', 'command', { command: 'nohup node job.js > job.log 2>&1 & echo $!' }, 'nohup node job.js > job.log 2>&1 & echo $!'),
    tool(5, 'track_process', 'hub', { code: `return await tools.aivenue.track_process({ pid: ${PID}, notify_when_done: true });` }),
    { kind: 'result', ts: t(6), text: 'Started the job; ending my turn.' },
    { kind: 'prompt', ts: t(51), text: 'AIVENUE: a background job you were waiting for has ended' },
    { kind: 'session', ts: t(52), sessionId: SESSION },
    tool(53, 'read', 'read', { filePath: path.join(out, 'wake-work-1', 'result.txt') }, 'result.txt'),
    tool(54, 'submit_work', 'hub', { code: `return await tools.aivenue.submit_work({ summary: "read result.txt: ${EXPECTED}" });` }, '提交實作結果'),
    { kind: 'result', ts: t(55), text: 'Done.' },
  ];
  const run = {
    id: 'wf-1',
    status: 'completed',
    createdAt: t(0),
    endedAt: t(56),
    log: [
      { ts: t(0), text: '工作流開始：acceptance: wake after a background job' },
      { ts: t(50), text: `實作 (OpenCode) 等待的背景程序已結束（PID ${PID}），接續它的對話` },
    ],
    processes: [{ pid: PID, notify: true, announced: true, endedAt: t(50) }],
    agents: { a1: { id: 'a1', role: 'executor', provider: 'opencode', model: 'opencode/free', promptTurns: [{ resumed: false }, { resumed: true }] } },
    stages: { implement: { rounds: [{ submission: { summary: `read result.txt: ${EXPECTED}` } }] } },
  };
  edit(events, run);
  fs.mkdirSync(path.join(out, 'wake-work-1'), { recursive: true });
  fs.writeFileSync(path.join(out, 'wake-work-1', 'result.txt'), `${EXPECTED}\n`);
  fs.mkdirSync(path.join(out, 'wake-home', 'runs', run.id, 'events'), { recursive: true });
  fs.writeFileSync(path.join(out, 'wake-home', 'runs', run.id, 'events', 'a1.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'wake-run-1.json'), JSON.stringify(run));
  fs.writeFileSync(path.join(out, 'wake-attempt-1.json'), JSON.stringify({ attempt: 1, expected: EXPECTED, checks: { 'the agent ended its turn and Aivenue showed it waiting for the job': true } }));
  return out;
}

/** `node wake-check.mjs --judge <dir>`: its exit code and which checks failed. */
function judge(dir) {
  const r = spawnSync(process.execPath, [path.join(ACCEPT, 'wake-check.mjs'), '--judge', dir], { encoding: 'utf8' });
  const failed = [...r.stdout.matchAll(/^ {2}FAIL {2}attempt \d+: (.+)$/gm)].map((m) => m[1]);
  return { code: r.status, failed, out: r.stdout + r.stderr };
}
const READ_AFTER = 'result.txt read only after the wake-up';
const isRead = (e) => e.kind === 'tool' && e.tool.category === 'read' && /result\.txt/.test(e.tool.input);

test('喚回驗收 --judge：讀檔、喚回、提交都齊全的結果通過', () => {
  const r = judge(wakeResult());
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.failed, []);
});

test('喚回驗收 --judge：沒有讀取 result.txt 的事件時必定失敗，即使提交內容提到檔名', () => {
  // The submission (and its tool input) name result.txt, but nothing read it.
  const r = judge(wakeResult((events) => events.splice(events.findIndex(isRead), 1)));
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(r.failed, [READ_AFTER]);
});

test('喚回驗收 --judge：只有寫入、搜尋、失敗的讀取或提交提到 result.txt，都不算讀過', () => {
  const variants = {
    'an edit of it': (e) => Object.assign(e.tool, { name: 'write', category: 'edit' }),
    'a search naming it': (e) => Object.assign(e.tool, { name: 'grep', category: 'search', input: JSON.stringify({ pattern: 'RESULT', path: 'result.txt' }) }),
    'a read that failed': (e) => Object.assign(e.tool, { status: 'error' }),
    'a command that only names it': (e) => Object.assign(e.tool, { name: 'shell', category: 'command', input: JSON.stringify({ command: 'echo result.txt is next' }), title: 'echo result.txt is next' }),
    'a command that writes it': (e) => Object.assign(e.tool, { name: 'shell', category: 'command', input: JSON.stringify({ command: 'echo x > result.txt' }), title: 'echo x > result.txt' }),
  };
  for (const [name, change] of Object.entries(variants)) {
    const r = judge(wakeResult((events) => change(events.find(isRead))));
    assert.equal(r.code, 1, `${name}: ${r.out}`);
    assert.deepEqual(r.failed, [READ_AFTER], name);
  }
});

test('喚回驗收 --judge：用終端指令讀取 result.txt 也算；喚回前就讀過則失敗', () => {
  for (const cmd of ['cat result.txt', 'type .\\result.txt', 'Get-Content -Raw "C:\\w\\result.txt"']) {
    const r = judge(wakeResult((events) => Object.assign(events.find(isRead).tool, { name: 'shell', category: 'command', input: JSON.stringify({ command: cmd }), title: cmd })));
    assert.equal(r.code, 0, `${cmd}: ${r.out}`);
  }
  // Also read before the wake-up (it waited or peeked instead of ending its turn).
  const early = judge(wakeResult((events) => events.splice(3, 0, { ...events.find(isRead), ts: 1_000_000 + 3500 })));
  assert.equal(early.code, 1, early.out);
  assert.deepEqual(early.failed, [READ_AFTER]);
});

test('喚回驗收 --judge：喚回兩次、換了 session、喚回前就提交、預檢說尚未登入，各自失敗', () => {
  const cases = [
    ['woken once for the job (one wake-up, one resumed turn)', (events, run) => run.log.push({ ts: 1_000_000 + 60_000, text: `實作 (OpenCode) 等待的背景程序已結束（PID ${PID}），接續它的對話` })],
    ['the wake-up continued the same CLI session', (events) => (events.find((e) => e.kind === 'session' && e.ts > 1_000_000 + 50_000).sessionId = 'ses_other')],
    ['nothing submitted before the wake-up', (events) => (events.find((e) => e.tool?.name === 'submit_work').ts = 1_000_000 + 5500)],
    ['preflight did not report the CLI as not signed in', (events, run) => run.log.push({ ts: 1_000_000 + 100, text: '預檢：實作：OpenCode 尚未登入' })],
  ];
  for (const [check, change] of cases) {
    const r = judge(wakeResult(change));
    assert.equal(r.code, 1, `${check}: ${r.out}`);
    assert.ok(r.failed.includes(check), `${check}: ${JSON.stringify(r.failed)}`);
  }
});

// ---------- win-procs.ps1 (what win-accept.ps1 stops) ----------

const pwsh = process.platform === 'win32' ? ['pwsh', 'powershell'].find((c) => spawnSync(c, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).status === 0) : undefined;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test(
  'Windows 驗收只關掉自己啟動的程序：同名的使用者 Aivenue（其他資料夾，或同一資料夾但不是這次啟動的）都不動',
  { skip: (process.platform !== 'win32' && 'Windows only') || (!pwsh && 'no PowerShell') },
  async () => {
    const dir = tmp('procs');
    // Stand-ins named Aivenue.exe: node, linked (or copied) into "ours" (this run's folder) and "theirs" (a user's own
    // Aivenue somewhere else).
    const exe = {};
    for (const side of ['ours', 'theirs']) {
      fs.mkdirSync(path.join(dir, side));
      exe[side] = path.join(dir, side, 'Aivenue.exe');
      try {
        fs.linkSync(process.execPath, exe[side]);
      } catch {
        fs.copyFileSync(process.execPath, exe[side]);
      }
    }
    const js = (name, body) => (fs.writeFileSync(path.join(dir, name), body), path.join(dir, name));
    const sleeper = js('sleep.js', 'setTimeout(() => {}, 120000);\n');
    const detached = `const { spawn } = require('child_process');
const run = (exe, args) => { const c = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); return c.pid; };
`;
    // The launched process starts a child (which starts a grandchild) and one from outside this run's folder, then
    // ends, as a portable launcher may: its descendants must still be found.
    js('mid.js', `${detached}require('fs').writeFileSync(process.argv[2], String(run(process.execPath, [${JSON.stringify(sleeper)}])));\nsetTimeout(() => {}, 120000);\n`);
    js(
      'launch.js',
      `${detached}const path = require('path');
const pids = { child: run(process.execPath, [path.join(__dirname, 'mid.js'), process.argv[2] + '.grand']), outside: run(${JSON.stringify(exe.theirs)}, [${JSON.stringify(sleeper)}]) };
require('fs').writeFileSync(process.argv[2], JSON.stringify(pids));
setTimeout(() => process.exit(0), 300);\n`,
    );
    const others = [];
    const started = (side) => {
      const c = spawn(exe[side], [sleeper], { detached: true, stdio: 'ignore', windowsHide: true });
      c.unref();
      others.push(c.pid);
      return c.pid;
    };
    try {
      // Running before this run started: the user's own (other folder), and one from this run's very folder.
      const user = started('theirs');
      const sameFolder = started('ours');
      await new Promise((r) => setTimeout(r, 1500));
      const pidFile = path.join(dir, 'pids.json');
      const harness = js(
        'harness.ps1',
        `param($Lib, $Exe, $Launch, $PidFile, $Ours)
. $Lib
$since = (Get-Date).AddSeconds(-1)
$root = Start-Process -FilePath $Exe -ArgumentList ('"' + $Launch + '"'), ('"' + $PidFile + '"') -PassThru -WindowStyle Hidden
for ($i = 0; $i -lt 100 -and -not (Test-Path ($PidFile + '.grand')); $i++) { Start-Sleep -Milliseconds 100 }
Start-Sleep -Milliseconds 800
$selected = @(Select-Ours @($root.Id) $since @($Ours) | ForEach-Object { $_.Id })
$left = Stop-Ours $root.Id $since @($Ours) | Select-Object -Last 1
[pscustomobject]@{ root = $root.Id; selected = $selected; left = $left } | ConvertTo-Json -Compress
`,
      );
      const r = spawnSync(pwsh, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness, path.join(ACCEPT, 'win-procs.ps1'), exe.ours, path.join(dir, 'launch.js'), pidFile, path.join(dir, 'ours')], { encoding: 'utf8', timeout: 60000 });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const got = JSON.parse(r.stdout.trim().split('\n').at(-1));
      const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      const grand = Number(fs.readFileSync(pidFile + '.grand', 'utf8'));
      others.push(pids.outside, pids.child, grand);
      const selected = new Set(got.selected);
      // Ours: the child and grandchild of the launched process (which itself has ended).
      assert.ok(selected.has(pids.child) && selected.has(grand), JSON.stringify({ got, pids, grand }));
      for (const [who, pid] of Object.entries({ user, sameFolder, outside: pids.outside })) assert.ok(!selected.has(pid), `${who} (${pid}) selected: ${JSON.stringify(got)}`);
      assert.equal(got.left, 0);
      assert.ok(!alive(pids.child) && !alive(grand), 'ours stopped');
      for (const [who, pid] of Object.entries({ user, sameFolder, outside: pids.outside })) assert.ok(alive(pid), `${who} (${pid}) was stopped`);
    } finally {
      for (const pid of others) {
        try {
          process.kill(pid);
        } catch {
          // already gone
        }
      }
    }
  },
);
