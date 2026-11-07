import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { test } from './lib/test-shard.mjs';
import { build } from 'esbuild';

// 專案記憶的儲存層（docs/memory-phase1.md §5、§6、§10）：多個子程序同時寫、鎖、崩潰復原、刪除不復活。
// 子程序才測得到跨程序的鎖，所以把原始碼打包成一個檔案，讓測試和子程序都載入它。
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-memtest-'));
const bundleFile = path.join(work, 'memory.cjs');
await build({
  stdin: {
    contents: `export * from './packages/core/src/memoryStore';
      export * from './packages/core/src/osLock';
      export * from './packages/core/src/memoryProject';
      export * from './packages/core/src/memoryVerify';
      export * from './packages/core/src/memoryWorkflow';
      export { treeScan } from './packages/core/src/records';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundleFile,
  logLevel: 'silent',
  plugins: [
    {
      // The code under test reads the file system through this wrapper, so a test can make one call fail
      // (globalThis.__fsFail = { readdirSync: fn }): a folder or file that cannot be read.
      name: 'fs that can fail',
      setup(b) {
        b.onResolve({ filter: /^(node:)?fs$/ }, (a) => (a.namespace === 'fs-hook' ? { path: 'node:fs', external: true } : { path: 'fs-hook', namespace: 'fs-hook' }));
        b.onLoad({ filter: /.*/, namespace: 'fs-hook' }, () => ({
          contents: `const real = require('node:fs');
            module.exports = new Proxy(real, { get: (t, k) => globalThis.__fsFail?.[k] ?? t[k] });`,
          loader: 'js',
        }));
      },
    },
  ],
});
const M = createRequire(import.meta.url)(bundleFile);

const workerFile = path.join(work, 'worker.cjs');
fs.writeFileSync(
  workerFile,
  `const fs = require('fs');
const M = require(${JSON.stringify(bundleFile)});
const [mode, dataDir, ...rest] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  if (mode === 'append') {
    const [who, n] = rest;
    const s = new M.MemoryStore(dataDir, 'p1');
    for (let i = 0; i < Number(n); i++) await s.add({ kind: 'fact', text: who + '-' + i, source: { workflowId: 'w-' + who, noteId: String(i), ts: Date.now() }, lifecycle: 'active' });
  } else if (mode === 'critical') {
    const [n, marker, overlaps] = rest;
    const name = M.lockName(dataDir, 'crit');
    for (let i = 0; i < Number(n); i++)
      await M.withOsLock(name, async () => {
        try {
          fs.closeSync(fs.openSync(marker, 'wx'));
        } catch {
          fs.appendFileSync(overlaps, 'x');
        }
        await sleep(2);
        fs.rmSync(marker, { force: true });
      }, { timeoutMs: 60000 });
  } else if (mode === 'hold') {
    const [block] = rest;
    await M.withOsLock(M.lockName(dataDir, 'p1'), async () => {
      process.stdout.write('held\\n');
      if (block === 'block') { const end = Date.now() + 1500; while (Date.now() < end); }
      else if (block === 'until') { const file = rest[1]; while (!fs.existsSync(file)) await sleep(50); }
      else await new Promise(() => {});
    });
  } else if (mode === 'delete') {
    const [id] = rest;
    await new M.MemoryStore(dataDir, 'p1').delete(id);
  } else if (mode === 'resolve') {
    const [cwd] = rest;
    const r = await M.resolveProject(dataDir, cwd, { host: 'test-host' });
    process.stdout.write(r.projectId + '\\n');
  } else if (mode === 'apply') {
    const [opId] = rest;
    const s = new M.MemoryStore(dataDir, 'p1');
    await s.enqueue({ opId, kind: 'pitfall', text: 'queued once', source: { workflowId: 'wq', noteId: 'n1', ts: 1 }, lifecycle: 'active' });
    await s.processQueue();
  }
})().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
`,
);

/** Children still running: killed when the tests end, whatever happened. */
const live = new Set();

/**
 * Run the worker. `done` resolves with its exit code and output (it is killed after `timeoutMs`); `ready(text)` waits
 * for a line it prints and fails at once, with its output, if it exits, cannot start, or takes too long.
 */
function worker(args, env = {}, timeoutMs = 60000) {
  const child = spawn(process.execPath, [workerFile, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  live.add(child);
  let out = '';
  let ended;
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const done = new Promise((resolve) => {
    child.on('close', (code) => resolve((ended = { code, out })));
    child.on('error', (e) => resolve((ended = { code: -1, out: out + String(e) })));
  }).finally(() => {
    live.delete(child);
    clearTimeout(timer);
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  async function ready(text, ms = 10000) {
    const end = Date.now() + ms;
    while (!out.includes(text)) {
      if (ended) throw new Error(`worker ended (code ${ended.code}) before printing "${text}":\n${ended.out}`);
      if (Date.now() > end) {
        child.kill('SIGKILL');
        throw new Error(`worker did not print "${text}" within ${ms}ms:\n${out}`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  return { child, done, ready, output: () => out };
}

const freshDir = () => fs.mkdtempSync(path.join(work, 'data-'));
const src = (w, n) => ({ workflowId: w, noteId: n, ts: Date.now() });
const allText = (dir) =>
  fs
    .readdirSync(path.join(dir, 'memory', 'p1'))
    .map((f) => fs.readFileSync(path.join(dir, 'memory', 'p1', f), 'utf8'))
    .join('\n');

test('鎖：三個子程序同時寫入，資料不遺失、seq 連續', async () => {
  const dir = freshDir();
  const runs = ['a', 'b', 'c'].map((w) => worker(['append', dir, w, '20']));
  const res = await Promise.all(runs.map((r) => r.done));
  for (const r of res) assert.equal(r.code, 0, r.out);
  const s = new M.MemoryStore(dir, 'p1');
  assert.equal(s.list().length, 60);
  const seqs = fs
    .readFileSync(path.join(dir, 'memory', 'p1', 'log.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(1)
    .map((l) => JSON.parse(l).seq);
  assert.deepEqual(seqs, Array.from({ length: 60 }, (_, i) => i + 1));
});

test('鎖：六個子程序爭用同一把鎖，任何時刻只有一個在臨界區', async () => {
  const dir = freshDir();
  const marker = path.join(dir, 'inside');
  const overlaps = path.join(dir, 'overlaps');
  const res = await Promise.all(Array.from({ length: 6 }, () => worker(['critical', dir, '25', marker, overlaps]).done));
  for (const r of res) assert.equal(r.code, 0, r.out);
  assert.equal(fs.existsSync(overlaps) ? fs.readFileSync(overlaps, 'utf8').length : 0, 0);
});

test('鎖：持有者事件迴圈阻塞時拿不到；持有者被強制結束後拿得到', { exclusive: true }, async () => {
  const dir = freshDir();
  const name = M.lockName(dir, 'p1');
  const blocked = worker(['hold', dir, 'block']);
  try {
    await blocked.ready('held');
    await assert.rejects(M.withOsLock(name, () => 1, { timeoutMs: 600 }), M.LockBusyError);
    await blocked.done;
  } finally {
    blocked.child.kill('SIGKILL');
  }

  const holder = worker(['hold', dir, 'forever']);
  try {
    await holder.ready('held');
    await assert.rejects(M.withOsLock(name, () => 1, { timeoutMs: 300 }), M.LockBusyError);
  } finally {
    holder.child.kill('SIGKILL');
  }
  await holder.done;
  assert.equal(await M.withOsLock(name, () => 'got', { timeoutMs: 5000 }), 'got');
});

/** Suspend or resume a whole process through the OS (not an event-loop block): NtSuspendProcess on Windows, SIGSTOP on Linux. */
function osSuspend(pid, resume = false) {
  if (process.platform === 'win32') {
    const fn = resume ? 'NtResumeProcess' : 'NtSuspendProcess';
    const ps = `$s='[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h); [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);'; Add-Type -Name P -Namespace W -MemberDefinition $s; $p=Get-Process -Id ${pid}; exit [W.P]::${fn}($p.Handle)`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'pipe' });
  } else process.kill(pid, resume ? 'SIGCONT' : 'SIGSTOP');
}

test('鎖：持有者被作業系統暫停時不被接管、等待者不寫入；恢復後兩筆都在；暫停中被結束後等待者接著寫', { exclusive: true }, { skip: !['win32', 'linux'].includes(process.platform) && 'locks are Windows and Linux only' }, async () => {
  for (const ending of ['resume', 'kill']) {
    const dir = freshDir();
    const release = path.join(dir, 'release');
    const holder = worker(['hold', dir, 'until', release]);
    try {
      await holder.ready('held');
      osSuspend(holder.child.pid);
      assert.equal(await M.isOsLockHeld(M.lockName(dir, 'p1')), true, 'a suspended holder keeps the lock');
      const writer = worker(['append', dir, 'w', '1']);
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(fs.existsSync(path.join(dir, 'memory', 'p1', 'log.jsonl')) ? new M.MemoryStore(dir, 'p1').list().length : 0, 0, 'nothing written while the holder is suspended');
      fs.writeFileSync(release, 'go');
      if (ending === 'resume') osSuspend(holder.child.pid, true);
      else holder.child.kill('SIGKILL');
      const w = await writer.done;
      assert.equal(w.code, 0, w.out);
      if (ending === 'resume') assert.equal((await holder.done).code, 0);
      assert.deepEqual(new M.MemoryStore(dir, 'p1').list().map((e) => e.text), ['w-0'], ending);
    } finally {
      try {
        osSuspend(holder.child.pid, true);
      } catch {
        // already ended
      }
      holder.child.kill('SIGKILL');
    }
  }
});

test('鎖名稱：同一資料目錄的不同寫法得到同一把鎖', () => {
  const dir = freshDir();
  assert.equal(M.lockName(dir, 'p1'), M.lockName(dir + path.sep, 'p1'));
  if (process.platform === 'win32') assert.equal(M.lockName(dir, 'p1'), M.lockName(dir.toUpperCase(), 'p1'));
});

test('復原：寫到一半的最後一行被截掉，前面的紀錄都在', async () => {
  const dir = freshDir();
  const s = new M.MemoryStore(dir, 'p1');
  await s.add({ kind: 'fact', text: 'one', source: src('w', '1'), lifecycle: 'active' });
  await s.add({ kind: 'fact', text: 'two', source: src('w', '2'), lifecycle: 'active' });
  fs.appendFileSync(path.join(dir, 'memory', 'p1', 'log.jsonl'), '{"seq":3,"opId":"x","ts":1,"op":"add","da');
  const t = new M.MemoryStore(dir, 'p1');
  assert.equal(t.list().length, 2); // 不持鎖讀取時略過殘行
  await t.add({ kind: 'fact', text: 'three', source: src('w', '3'), lifecycle: 'active' });
  assert.deepEqual(t.list().map((m) => m.text).sort(), ['one', 'three', 'two']);
  const lines = fs.readFileSync(path.join(dir, 'memory', 'p1', 'log.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 4);
});

test('冪等：套用後、清空佇列前崩潰，重跑同一個 op id 不會寫兩次', async () => {
  const dir = freshDir();
  const r = await worker(['apply', dir, 'op-fixed-1'], { AIVENUE_MEM_CRASH_AT: 'after-apply' }).done;
  assert.equal(r.code, 99);
  const s = new M.MemoryStore(dir, 'p1');
  await s.processQueue();
  // 與子程序送出的請求完全相同（重試）
  await s.enqueue({ opId: 'op-fixed-1', kind: 'pitfall', text: 'queued once', source: { workflowId: 'wq', noteId: 'n1', ts: 1 }, lifecycle: 'active' });
  await s.processQueue();
  assert.equal(s.list().length, 1);
});

for (const step of ['delete:intent', 'delete:tombstone', 'delete:log', 'delete:snapshot', 'delete:queue', 'delete:checkouts']) {
  test(`刪除：在「${step}」之後崩潰，重啟後內容不會復活`, async () => {
    const dir = freshDir();
    const s = new M.MemoryStore(dir, 'p1');
    const secretish = `forget-me-${step}`;
    const { added } = await s.add({ kind: 'fact', text: secretish, source: src('wd', 'n9'), lifecycle: 'active' });
    await s.add({ kind: 'fact', text: 'keep me', source: src('wd', 'n10'), lifecycle: 'active' });
    // 佇列裡還有一筆同來源、未套用的候選
    await s.enqueue({ kind: 'fact', text: 'rewritten ' + secretish, source: src('wd', 'n9'), lifecycle: 'active' });
    fs.writeFileSync(path.join(dir, 'memory', 'p1', 'checkouts.json'), JSON.stringify({ generation: 1, states: { c1: { [added[0]]: { state: 'verified', expected: 'exit 0', actual: 'exit 0', evidenceRef: 'e', fingerprint: [], at: 1 } } } }));
    const r = await worker(['delete', dir, added[0]], { AIVENUE_MEM_CRASH_AT: step }).done;
    assert.equal(r.code, 99, r.out);

    const t = new M.MemoryStore(dir, 'p1');
    await t.processQueue(); // 取得鎖時先把刪除做完
    assert.deepEqual(t.list().map((m) => m.text), ['keep me']);
    assert.ok(!allText(dir).includes(secretish), `${step}: text left in files`);
    assert.ok(!fs.existsSync(path.join(dir, 'memory', 'p1', 'delete-intent.json')));
    // 同一來源、同一內容都不能再生效
    const again = await t.add({ kind: 'fact', text: secretish, source: src('other', 'x'), lifecycle: 'active' });
    assert.equal(again.added.length, 0);
    const same = await t.add({ kind: 'fact', text: 'new words', source: src('wd', 'n9'), lifecycle: 'active' });
    assert.equal(same.added.length, 0);
  });
}

test('同步：另一個 hub 刪除後，generation 改變，這邊整份重讀', async () => {
  const dir = freshDir();
  const a = new M.MemoryStore(dir, 'p1');
  const b = new M.MemoryStore(dir, 'p1');
  const { added } = await a.add({ kind: 'fact', text: 'shared', source: src('w', '1'), lifecycle: 'active' });
  assert.equal(b.list().length, 1);
  const before = b.progress();
  await a.delete(added[0]);
  assert.equal(b.refresh(), true);
  assert.notEqual(b.progress().generation, before.generation);
  assert.equal(b.list().length, 0);
});

test('遮蔽：機密在佇列、紀錄、快照裡都只剩遮蔽後的內容', async () => {
  const dir = freshDir();
  const s = new M.MemoryStore(dir, 'p1');
  const key = 'sk-ant-' + 'a1B2c3D4e5F6g7H8i9J0k1L2';
  await s.enqueue({ kind: 'fact', text: `deploy uses ${key}`, conditions: `token: ${key}`, source: src('w', '1'), evidence: [{ eventRef: 'e1', kind: 'command', summary: `ran with ${key}` }], lifecycle: 'active' });
  assert.ok(!allText(dir).includes(key));
  await s.processQueue();
  for (let i = 0; i < 55; i++) await s.add({ kind: 'fact', text: 'filler ' + i, source: src('f', String(i)), lifecycle: 'active' });
  assert.ok(fs.existsSync(path.join(dir, 'memory', 'p1', 'snapshot.json')));
  assert.ok(!allText(dir).includes(key));
  assert.match(s.list().find((m) => m.text.startsWith('deploy'))?.text ?? '', /\[api key\]/);
});

test('去重：同鍵只補來源與證據；不同環境、大小寫或參數不同是不同記憶', async () => {
  const dir = freshDir();
  const s = new M.MemoryStore(dir, 'p1');
  const base = { kind: 'practice', text: 'Run npm test -- --runInBand', lifecycle: 'active' };
  await s.add({ ...base, source: src('w1', 'a'), evidence: [{ eventRef: 'e1', kind: 'command', summary: 'ok' }] });
  const second = await s.add({ ...base, text: '  Run npm test -- --runInBand\r\n', source: src('w2', 'b'), evidence: [{ eventRef: 'e2', kind: 'command', summary: 'ok' }] });
  assert.equal(second.merged.length, 1);
  await s.add({ ...base, environment: 'Linux', source: src('w3', 'c') });
  await s.add({ ...base, text: 'run npm test -- --runInBand', source: src('w4', 'd') });
  await s.add({ ...base, text: 'Run npm test -- --runinband', source: src('w5', 'e') });
  const list = s.list();
  assert.equal(list.length, 4);
  const merged = list.find((m) => m.text === 'Run npm test -- --runInBand' && !m.environment);
  assert.equal(merged.sources.length, 2);
  assert.equal(merged.evidence.length, 2);
});

test('更新：使用者鎖定或改過的內容，自動操作不能覆寫；版本不符會被拒絕', async () => {
  const dir = freshDir();
  const s = new M.MemoryStore(dir, 'p1');
  const { added } = await s.add({ kind: 'fact', text: 'v1', source: src('w', '1'), lifecycle: 'active' });
  const m = await s.update(added[0], { text: 'v2 by user' }, { byUser: true });
  assert.equal(m.editedByUser, true);
  await assert.rejects(s.update(added[0], { text: 'auto' }), /only the user/);
  await assert.rejects(s.update(added[0], { lifecycle: 'archived' }, { version: 1 }), /changed since/);
  assert.equal((await s.update(added[0], { lifecycle: 'archived' }, { version: m.version })).lifecycle, 'archived');
});

test('佇列：上一個寫入者留下半行，下一筆候選不會黏上去而遺失；中段損壞會回報', async () => {
  const dir = freshDir();
  const s = new M.MemoryStore(dir, 'p1');
  const q = path.join(dir, 'memory', 'p1', 'queue.jsonl');
  await s.enqueue({ kind: 'fact', text: 'first', source: src('w', '1'), lifecycle: 'active' });
  fs.appendFileSync(q, '{"opId":"torn","ts":1,"candidate":{"kind":"fa');
  await s.enqueue({ kind: 'fact', text: 'second', source: src('w', '2'), lifecycle: 'active' });
  await s.processQueue();
  assert.deepEqual(s.list().map((m) => m.text).sort(), ['first', 'second']);

  await s.enqueue({ kind: 'fact', text: 'third', source: src('w', '3'), lifecycle: 'active' });
  fs.writeFileSync(q, 'not json\n' + fs.readFileSync(q, 'utf8'));
  await assert.rejects(s.processQueue(), M.MemoryCorruptError);
  assert.match(fs.readFileSync(q, 'utf8'), /third/); // 沒有被清掉
});

test('刪除復原：紀錄檔中段損壞時回報錯誤，保留檔案與刪除意圖，不清掉其他記憶', async () => {
  const dir = freshDir();
  const s = new M.MemoryStore(dir, 'p1');
  const keep = (await s.add({ kind: 'fact', text: 'keep', source: src('w', '1'), lifecycle: 'active' })).added[0];
  const gone = (await s.add({ kind: 'fact', text: 'gone', source: src('w', '2'), lifecycle: 'active' })).added[0];
  assert.equal((await worker(['delete', dir, gone], { AIVENUE_MEM_CRASH_AT: 'delete:tombstone' }).done).code, 99);
  const logFile = path.join(dir, 'memory', 'p1', 'log.jsonl');
  const lines = fs.readFileSync(logFile, 'utf8').split('\n');
  lines.splice(1, 0, '{"damaged":');
  fs.writeFileSync(logFile, lines.join('\n'));
  const damaged = fs.readFileSync(logFile, 'utf8');

  const t = new M.MemoryStore(dir, 'p1');
  await assert.rejects(t.processQueue(), M.MemoryCorruptError);
  assert.equal(fs.readFileSync(logFile, 'utf8'), damaged);
  assert.ok(fs.existsSync(path.join(dir, 'memory', 'p1', 'delete-intent.json')));
  assert.match(damaged, new RegExp(keep));
});

test('更新：自動操作不能解除鎖定、改驗證指令；鎖定的條目自動操作一律不能改', async () => {
  const dir = freshDir();
  const s = new M.MemoryStore(dir, 'p1');
  const { added } = await s.add({ kind: 'practice', text: 'run tests', check: { command: 'npm test', expectExit: 0 }, source: src('w', '1'), lifecycle: 'active' });
  await s.update(added[0], { locked: true }, { byUser: true });
  await assert.rejects(s.update(added[0], { locked: false }), /only the user/);
  await assert.rejects(s.update(added[0], { check: { command: 'true', expectExit: 0 } }), /only the user/);
  await assert.rejects(s.update(added[0], { approvedBy: 'auto' }), /only the user/);
  await assert.rejects(s.update(added[0], { lifecycle: 'superseded' }), /locked by the user/);
  const m = s.get(added[0]);
  assert.equal(m.locked, true);
  assert.equal(m.check.command, 'npm test');
  assert.equal(m.lifecycle, 'active');
});

test('更新：同一 op id、同一版本重試視為已完成；同一 op id 換內容會被拒絕', async () => {
  const dir = freshDir();
  const s = new M.MemoryStore(dir, 'p1');
  const { added } = await s.add({ kind: 'fact', text: 'v1', source: src('w', '1'), lifecycle: 'active' });
  const first = await s.update(added[0], { text: 'v2' }, { version: 1, byUser: true, opId: 'op-u1' });
  const retry = await s.update(added[0], { text: 'v2' }, { version: 1, byUser: true, opId: 'op-u1' });
  assert.equal(retry.version, first.version);
  assert.equal(retry.text, 'v2');
  await assert.rejects(s.update(added[0], { text: 'v3' }, { version: 1, byUser: true, opId: 'op-u1' }), /different change/);
  // 重開後（由紀錄與快照重建）仍認得
  const t = new M.MemoryStore(dir, 'p1');
  assert.equal((await t.update(added[0], { text: 'v2' }, { version: 1, byUser: true, opId: 'op-u1' })).version, first.version);
});

test('候選：同一 op id 重試可以；同一 op id 換內容會被拒絕，不會回報成功卻沒寫入', async () => {
  const dir = freshDir();
  const s = new M.MemoryStore(dir, 'p1');
  const c = { opId: 'op-c1', kind: 'fact', text: 'first', source: { workflowId: 'w', noteId: '1', ts: 1 }, lifecycle: 'active' };
  await s.add(c);
  const again = await s.add(c);
  assert.equal(again.added.length + again.merged.length, 0);
  await assert.rejects(s.add({ ...c, text: 'different' }), M.MemoryOpConflictError);
  await assert.rejects(s.enqueue({ ...c, text: 'different' }), M.MemoryOpConflictError);
  // 還在佇列、尚未套用時也一樣
  await s.enqueue({ ...c, opId: 'op-c2', text: 'queued' });
  await s.enqueue({ ...c, opId: 'op-c2', text: 'queued' });
  await assert.rejects(s.enqueue({ ...c, opId: 'op-c2', text: 'other' }), M.MemoryOpConflictError);
  await s.processQueue();
  assert.deepEqual(s.list().map((m) => m.text).sort(), ['first', 'queued']);
});

test('冪等：欄位順序不同的同一請求仍可重試（候選與更新，重開 Store 後也一樣）', async () => {
  const dir = freshDir();
  const s = new M.MemoryStore(dir, 'p1');
  await s.add({ opId: 'op-o1', kind: 'fact', text: 'ordered', source: { workflowId: 'w', noteId: '1', ts: 5 }, lifecycle: 'active' });
  const t = new M.MemoryStore(dir, 'p1');
  const again = await t.add({ lifecycle: 'active', source: { ts: 5, noteId: '1', workflowId: 'w' }, text: 'ordered', kind: 'fact', opId: 'op-o1' });
  assert.equal(again.added.length + again.merged.length, 0);
  const id = t.list()[0].id;
  await t.update(id, { text: 'x', conditions: 'y' }, { byUser: true, opId: 'op-o2' });
  const u = new M.MemoryStore(dir, 'p1');
  assert.equal((await u.update(id, { conditions: 'y', text: 'x' }, { byUser: true, opId: 'op-o2' })).text, 'x');
  assert.equal(M.stableJson({ b: 1, a: [{ d: 1, c: 2 }], u: undefined }), '{"a":[{"c":2,"d":1}],"b":1}');
});

test('鎖定：同內容的新候選不合併進鎖定的條目，留在佇列等解鎖', async () => {
  const dir = freshDir();
  const s = new M.MemoryStore(dir, 'p1');
  const { added } = await s.add({ kind: 'fact', text: 'pinned', source: src('w', '1'), lifecycle: 'active' });
  const locked = await s.update(added[0], { locked: true }, { byUser: true });
  const r = await s.add({ kind: 'fact', text: 'pinned', source: src('w2', '2'), evidence: [{ eventRef: 'e9', kind: 'command', summary: 'ok' }], lifecycle: 'active' });
  assert.equal(r.held.length, 1);
  const after = s.get(added[0]);
  assert.equal(after.version, locked.version);
  assert.equal(after.sources.length, 1);
  assert.equal(after.evidence.length, 0);
  assert.match(fs.readFileSync(path.join(dir, 'memory', 'p1', 'queue.jsonl'), 'utf8'), /w2/);
  // 使用者解鎖後才合併
  await s.update(added[0], { locked: false }, { byUser: true });
  const later = await s.processQueue();
  assert.equal(later.merged.length, 1);
  assert.equal(s.get(added[0]).sources.length, 2);
});

// ---------- 第二步：專案身分、checkout 驗證狀態、驗證事件 ----------

const gitIn = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, stdio: 'ignore' });

/** A repository with one commit and a second worktree. */
function repoWithWorktree() {
  const base = fs.mkdtempSync(path.join(work, 'repo-'));
  const main = path.join(base, 'main');
  fs.mkdirSync(path.join(main, 'src'), { recursive: true });
  fs.writeFileSync(path.join(main, 'src', 'a.ts'), 'export const a = 1;\n');
  gitIn(main, 'init', '-q');
  gitIn(main, 'add', '.');
  gitIn(main, 'commit', '-q', '-m', 'init');
  const wt = path.join(base, 'wt');
  gitIn(main, 'worktree', 'add', '-q', wt);
  return { main, wt };
}

test('專案身分：同一 repo 的 worktree 共用專案、checkout 不同；子資料夾同一 checkout；非 Git 與其他執行端是不同專案', async () => {
  const dir = freshDir();
  const { main, wt } = repoWithWorktree();
  const a = await M.resolveProject(dir, main, { host: 'h1' });
  const b = await M.resolveProject(dir, wt, { host: 'h1' });
  const sub = await M.resolveProject(dir, path.join(main, 'src'), { host: 'h1' });
  assert.equal(a.kind, 'git');
  assert.equal(a.projectId, b.projectId);
  assert.notEqual(a.checkoutId, b.checkoutId);
  assert.equal(sub.projectId, a.projectId);
  assert.equal(sub.checkoutId, a.checkoutId);
  const other = await M.resolveProject(dir, main, { host: 'h2' });
  assert.notEqual(other.projectId, a.projectId);
  const plain = fs.mkdtempSync(path.join(work, 'plain-'));
  const p = await M.resolveProject(dir, plain, { host: 'h1' });
  assert.equal(p.kind, 'folder');
  assert.notEqual(p.projectId, a.projectId);
  assert.equal(M.listProjects(dir).length, 3);
});

test('專案身分：四個子程序同時第一次開啟同一專案，得到同一個 projectId', async () => {
  const dir = freshDir();
  const { main } = repoWithWorktree();
  const res = await Promise.all(Array.from({ length: 4 }, () => worker(['resolve', dir, main]).done));
  for (const r of res) assert.equal(r.code, 0, r.out);
  assert.equal(new Set(res.map((r) => r.out.trim())).size, 1);
  assert.equal(M.listProjects(dir).length, 1);
});

test('專案身分：搬家後重新連結，保留同一個 projectId；目標已屬於別的專案則拒絕', async () => {
  const dir = freshDir();
  const { main } = repoWithWorktree();
  const a = await M.resolveProject(dir, main, { host: 'h1' });
  const moved = path.join(path.dirname(main), 'moved');
  fs.cpSync(main, moved, { recursive: true });
  await M.relinkProject(dir, a.projectId, moved, { host: 'h1' });
  assert.equal((await M.resolveProject(dir, moved, { host: 'h1' })).projectId, a.projectId);
  const b = await M.resolveProject(dir, main, { host: 'h1' }); // 舊位置現在是新的專案
  await assert.rejects(M.relinkProject(dir, b.projectId, moved, { host: 'h1' }), /already belongs/);
});

/** A memory with a check command that rests on src/a.ts. */
async function checkedMemory(s, root, checkoutId) {
  const hash = M.fingerprint(root, ['src/a.ts'])[0].hash;
  const { added } = await s.add({
    kind: 'practice',
    text: 'build with npm run build',
    check: { command: 'npm run build', expectExit: 0 },
    source: src('w', '1'),
    evidence: [{ eventRef: 'e0', kind: 'file_read', checkoutId, files: [{ path: 'src/a.ts', hash }], summary: 'read a.ts' }],
    lifecycle: 'active',
  });
  return s.get(added[0]);
}

test('驗證：一般成功的指令不算；符合 check 且結束碼相符才算；結束碼不符標待重驗', async () => {
  const dir = freshDir();
  const { main } = repoWithWorktree();
  const id = await M.resolveProject(dir, main, { host: 'h1' });
  const s = new M.MemoryStore(dir, id.projectId);
  const m = await checkedMemory(s, id.checkoutRoot, id.checkoutId);
  assert.equal(M.stateIn(m, id.checkoutId, id.checkoutRoot, undefined), 'unverified');

  assert.deepEqual(await M.recordEvent(s, id.checkoutId, id.checkoutRoot, { kind: 'command', ref: 'e1', command: 'git status', status: 'ok', at: 10 }), []);
  assert.equal(s.checkoutStates(id.checkoutId)[m.id], undefined);

  await M.recordEvent(s, id.checkoutId, id.checkoutRoot, { kind: 'command', ref: 'e2', command: '  npm run build ', status: 'ok', exitCode: 0, at: 20 });
  let st = s.checkoutStates(id.checkoutId)[m.id];
  assert.equal(st.state, 'verified');
  assert.equal(st.lastVerifiedAt, 20);
  assert.equal(M.stateIn(s.get(m.id), id.checkoutId, id.checkoutRoot, st), 'verified');

  await M.recordEvent(s, id.checkoutId, id.checkoutRoot, { kind: 'command', ref: 'e3', command: 'npm run build', status: 'error', exitCode: 1, at: 30 });
  st = s.checkoutStates(id.checkoutId)[m.id];
  assert.equal(st.state, 'needs_recheck');
  assert.equal(st.lastVerifiedAt, 20); // 失敗不刷新最後驗證時間
});

test('驗證：狀態屬於 checkout；改檔只降級該 checkout；新增來源與使用者核准不刷新驗證時間', async () => {
  const dir = freshDir();
  const { main, wt } = repoWithWorktree();
  const A = await M.resolveProject(dir, main, { host: 'h1' });
  const B = await M.resolveProject(dir, wt, { host: 'h1' });
  const s = new M.MemoryStore(dir, A.projectId);
  const m = await checkedMemory(s, A.checkoutRoot, A.checkoutId);
  await M.recordEvent(s, A.checkoutId, A.checkoutRoot, { kind: 'command', ref: 'e1', command: 'npm run build', status: 'ok', exitCode: 0, at: 100 });
  const stA = () => M.stateIn(s.get(m.id), A.checkoutId, A.checkoutRoot, s.checkoutStates(A.checkoutId)[m.id]);
  const stB = () => M.stateIn(s.get(m.id), B.checkoutId, B.checkoutRoot, s.checkoutStates(B.checkoutId)[m.id]);
  assert.equal(stA(), 'verified');
  assert.equal(stB(), 'unverified');

  // B 改了檔案：A 不受影響
  fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'export const a = 2;\n');
  assert.equal(stA(), 'verified');
  assert.equal(stB(), 'unverified');
  // A 改了檔案：A 待重驗
  fs.writeFileSync(path.join(main, 'src', 'a.ts'), 'export const a = 3;\n');
  assert.equal(stA(), 'needs_recheck');

  await s.add({ kind: 'practice', text: 'build with npm run build', check: { command: 'npm run build', expectExit: 0 }, source: src('w9', '9'), lifecycle: 'active' });
  await s.update(m.id, { approvedBy: 'user' }, { byUser: true });
  assert.equal(s.checkoutStates(A.checkoutId)[m.id].lastVerifiedAt, 100);
  assert.equal(s.checkoutStates(B.checkoutId)[m.id], undefined);
});

test('驗證：驗收指標通過且未過期才算；過期或未達標標待重驗；刪除記憶連同 checkout 狀態一起清掉', async () => {
  const dir = freshDir();
  const { main } = repoWithWorktree();
  const id = await M.resolveProject(dir, main, { host: 'h1' });
  const s = new M.MemoryStore(dir, id.projectId);
  const { added } = await s.add({ kind: 'practice', text: 'p95 latency measured by npm run bench', source: { ...src('w', '1'), metricId: 'M1' }, lifecycle: 'active' });
  const ev = (met, stale, at) => ({ kind: 'verification', ref: 'v' + at, workflowId: 'w', metricId: 'M1', met, stale, value: '120ms', target: '< 150ms', at, files: M.fingerprint(id.checkoutRoot, [M.WHOLE_CHECKOUT]) });
  await M.recordEvent(s, id.checkoutId, id.checkoutRoot, ev(true, true, 1));
  assert.equal(s.checkoutStates(id.checkoutId)[added[0]].state, 'needs_recheck');
  await M.recordEvent(s, id.checkoutId, id.checkoutRoot, ev(true, false, 2));
  assert.equal(s.checkoutStates(id.checkoutId)[added[0]].state, 'verified');
  assert.deepEqual(await M.recordEvent(s, id.checkoutId, id.checkoutRoot, { ...ev(true, false, 3), metricId: 'M2' }), []);

  await s.delete(added[0]);
  assert.deepEqual(s.checkoutStates(id.checkoutId), {});
  assert.ok(!fs.readFileSync(path.join(dir, 'memory', id.projectId, 'checkouts.json'), 'utf8').includes(added[0]));
});

test('驗證：不同工作流（或不同目標版本）的同名指標 M1 不會互相驗證', async () => {
  const dir = freshDir();
  const { main } = repoWithWorktree();
  const id = await M.resolveProject(dir, main, { host: 'h1' });
  const s = new M.MemoryStore(dir, id.projectId);
  const lat = (await s.add({ kind: 'practice', text: 'latency under 150ms', source: { ...src('wA', '1'), metricId: 'M1', goalVersion: 'g1' }, lifecycle: 'active' })).added[0];
  const tests = (await s.add({ kind: 'practice', text: 'all tests pass', source: { ...src('wB', '1'), metricId: 'M1', goalVersion: 'g7' }, lifecycle: 'active' })).added[0];
  const touched = await M.recordEvent(s, id.checkoutId, id.checkoutRoot, { kind: 'verification', ref: 'v1', workflowId: 'wA', goalVersion: 'g1', metricId: 'M1', met: true, stale: false, value: '120ms', at: 10, files: M.fingerprint(id.checkoutRoot, [M.WHOLE_CHECKOUT]) });
  assert.deepEqual(touched, [lat]);
  assert.equal(s.checkoutStates(id.checkoutId)[tests], undefined);
  // 同一工作流、目標改版後的 M1 也不算
  assert.deepEqual(await M.recordEvent(s, id.checkoutId, id.checkoutRoot, { kind: 'verification', ref: 'v2', workflowId: 'wA', goalVersion: 'g2', metricId: 'M1', met: true, stale: false, value: '1', at: 20 }), []);
});

test('驗證：使用者改了文字或 check 後，舊驗證失效；只補來源或鎖定不影響', async () => {
  const dir = freshDir();
  const { main } = repoWithWorktree();
  const id = await M.resolveProject(dir, main, { host: 'h1' });
  const s = new M.MemoryStore(dir, id.projectId);
  const m = await checkedMemory(s, id.checkoutRoot, id.checkoutId);
  await M.recordEvent(s, id.checkoutId, id.checkoutRoot, { kind: 'command', ref: 'e1', command: 'npm run build', status: 'ok', exitCode: 0, at: 10 });
  const state = () => M.stateIn(s.get(m.id), id.checkoutId, id.checkoutRoot, s.checkoutStates(id.checkoutId)[m.id]);
  assert.equal(state(), 'verified');
  await s.add({ kind: 'practice', text: 'build with npm run build', check: { command: 'npm run build', expectExit: 0 }, source: src('w2', '2'), lifecycle: 'active' });
  await s.update(m.id, { locked: true }, { byUser: true });
  assert.equal(state(), 'verified');
  await s.update(m.id, { text: 'build with make', check: { command: 'make', expectExit: 0 } }, { byUser: true });
  assert.equal(state(), 'needs_recheck');
  // 舊指令再成功一次也不算（它不是現在的 check）；新的 check 成功才回到已驗證
  assert.deepEqual(await M.recordEvent(s, id.checkoutId, id.checkoutRoot, { kind: 'command', ref: 'e2', command: 'npm run build', status: 'ok', exitCode: 0, at: 20 }), []);
  await M.recordEvent(s, id.checkoutId, id.checkoutRoot, { kind: 'command', ref: 'e3', command: 'make', status: 'ok', exitCode: 0, at: 30 });
  assert.equal(state(), 'verified');
});

test('驗證：晚到的舊事件不覆蓋較新的狀態；同一事件重送不重複寫入', async () => {
  const dir = freshDir();
  const { main } = repoWithWorktree();
  const id = await M.resolveProject(dir, main, { host: 'h1' });
  const s = new M.MemoryStore(dir, id.projectId);
  const m = await checkedMemory(s, id.checkoutRoot, id.checkoutId);
  const fail = { kind: 'command', ref: 'late-fail', command: 'npm run build', status: 'error', exitCode: 1, at: 100 };
  assert.deepEqual(await M.recordEvent(s, id.checkoutId, id.checkoutRoot, fail), [m.id]);
  assert.deepEqual(await M.recordEvent(s, id.checkoutId, id.checkoutRoot, { kind: 'command', ref: 'old-ok', command: 'npm run build', status: 'ok', exitCode: 0, at: 50 }), []);
  const st = s.checkoutStates(id.checkoutId)[m.id];
  assert.equal(st.state, 'needs_recheck');
  assert.equal(st.at, 100);
  assert.deepEqual(await M.recordEvent(s, id.checkoutId, id.checkoutRoot, fail), []);
});

// ---------- 第三步：擷取、選取、依角色注入 ----------

test('擷取：只有使用者自己寫的「記住：」行會生效；引用、程式碼區塊、貼上內容不算；持續性用語只進候選', () => {
  const text = ['記住：這個專案用 pnpm', '> 記住：引用不算', '```', '記住：程式碼不算', '```', '<pasted id="1">記住：貼上的不算</pasted>', 'remember: run lint first'].join('\n');
  assert.deepEqual(M.memoryCommands(text), ['這個專案用 pnpm', 'run lint first']);
  const cands = M.fromUserMessage('w1', { ts: 5, text });
  assert.deepEqual(cands.map((c) => [c.lifecycle, c.opId]), [['active', 'w1:remember:5:0'], ['active', 'w1:remember:5:1']]);
  const lasting = M.fromUserMessage('w1', { ts: 6, text: '以後一律先跑測試' });
  assert.equal(lasting[0].lifecycle, 'candidate');
  assert.deepEqual(M.fromUserMessage('w1', { ts: 7, text: '這次先不要跑測試' }), []);
  // 重試得到同一個請求（op id、時間、來源都固定）
  assert.deepEqual(M.fromUserMessage('w1', { ts: 5, text }), cands);
});

test('擷取：agent 的 fact／decision 筆記只當候選；推測與使用者筆記不擷取', () => {
  assert.equal(M.fromNote('w', { id: 'n1', agentId: 'a1', kind: 'fact', text: 'uses node 22', ts: 1 }).lifecycle, 'candidate');
  assert.equal(M.fromNote('w', { id: 'n2', agentId: 'a1', kind: 'inference', text: 'maybe', ts: 1 }), undefined);
  assert.equal(M.fromNote('w', { id: 'n3', agentId: 'user', kind: 'fact', text: 'x', ts: 1 }), undefined);
  assert.equal(M.commandOf('`npm test`'), 'npm test');
  assert.equal(M.commandOf('run the tests and look at the coverage'), undefined);
});

async function storeWith(dir, items) {
  const s = new M.MemoryStore(dir, 'p1');
  const ids = [];
  for (const [i, it] of items.entries()) ids.push((await s.add({ lifecycle: 'active', source: src('w', String(i)), ...it })).added[0]);
  return { s, ids };
}

test('注入：依角色挑種類；新對話給整份，接續的對話只給變動（撤回、使用者更新）', async () => {
  const dir = freshDir();
  const { s, ids } = await storeWith(dir, [
    { kind: 'instruction', text: 'use pnpm' },
    { kind: 'pitfall', text: 'npm ci fails on Windows with EPERM; close the editor first' },
    { kind: 'decision', text: 'keep the REST API' },
    { kind: 'practice', text: 'measure with npm run bench' },
  ]);
  const mem = { mode: 'full', checkoutId: 'c1', checkoutRoot: dir, picks: M.pickMemories(s.list(), 'use pnpm'), given: {}, injectedTokens: 0, queued: 0 };
  const exec = M.injectionFor(s, mem, 'executor');
  assert.match(exec.text, /use pnpm/);
  assert.match(exec.text, /EPERM/);
  assert.doesNotMatch(exec.text, /REST API/);
  const ver = M.injectionFor(s, mem, 'verifier');
  assert.deepEqual(ver.given.map((g) => g.memoryId).sort(), [ids[0], ids[3]].sort());
  assert.equal(M.injectionFor(s, mem, 'compactor').text, '');

  // 沒有變動：接續的對話什麼都不補
  assert.equal(M.injectionFor(s, mem, 'executor', exec.given).text, '');
  await s.delete(ids[1]);
  await s.update(ids[0], { text: 'use pnpm 9' }, { byUser: true });
  const again = M.injectionFor(s, mem, 'executor', exec.given);
  assert.match(again.text, new RegExp(`\\[${ids[1]}\\] was withdrawn`));
  assert.match(again.text, /updated by the user\) use pnpm 9/);
  // 新對話不再收到被刪的，並列出原因
  const fresh = M.injectionFor(s, mem, 'executor');
  assert.doesNotMatch(fresh.text, /EPERM/);
  assert.ok(fresh.leftOut.some((x) => x.memoryId === ids[1]));
  // 中途新增的記憶不加入這個工作流
  await s.add({ kind: 'instruction', text: 'added later', source: src('w', 'late'), lifecycle: 'active' });
  assert.doesNotMatch(M.injectionFor(s, mem, 'executor').text, /added later/);
});

test('注入：超過預算的不默默截斷，列在未帶入；完全不用模式什麼都不給', async () => {
  const dir = freshDir();
  const long = 'x'.repeat(2400);
  const { s } = await storeWith(dir, [1, 2, 3].map((i) => ({ kind: 'fact', text: `fact ${i} ${long}` })));
  const mem = { mode: 'full', checkoutId: 'c1', checkoutRoot: dir, picks: M.pickMemories(s.list(), ''), given: {}, injectedTokens: 0, queued: 0 };
  const inj = M.injectionFor(s, mem, 'executor');
  assert.ok(inj.tokens <= M.MEMORY_BUDGET);
  assert.equal(inj.given.length + inj.leftOut.length, 3);
  assert.ok(inj.leftOut.length >= 1);
  assert.ok(inj.leftOut.every((x) => x.reason === 'over the budget'));
  assert.equal(M.injectionFor(s, { ...mem, mode: 'off' }, 'executor').text, '');
});

test('驗收候選：整份驗收沒通過不產生記憶；同一指標的不同次驗收各自一個請求，合併成同一條', async () => {
  const goal = { statement: 'fast', metrics: [{ id: 'M1', name: 'tests', target: 'pass', how: 'npm test' }, { id: 'M2', name: 'p95', target: '<150ms', how: 'npm run bench' }] };
  const v = (outcome, m1, value) => ({ outcome, summary: '', fingerprint: [{ path: 'src/a.ts', hash: 'h1' }], issues: [], metrics: [{ id: 'M1', value, met: m1, evidence: 'npm test' }, { id: 'M2', value: '200ms', met: outcome === 'met', evidence: 'bench' }] });
  assert.deepEqual(M.fromVerification('w', goal, v('not_met', true, 'pass'), 1, 1), []);
  const dir = freshDir();
  const s = new M.MemoryStore(dir, 'p1');
  for (const c of M.fromVerification('w', goal, v('met', true, '120 passed'), 10, 1)) await s.add(c);
  for (const c of M.fromVerification('w', goal, v('met', true, '121 passed'), 20, 2)) await s.add(c);
  const tests = s.list().filter((m) => m.text.startsWith('tests'));
  assert.equal(tests.length, 1);
  assert.equal(tests[0].sources.length, 2);
  assert.equal(tests[0].evidence.length, 2);
});

test('接續注入：更新與撤回也受預算限制；沒送出的不算已送達，下次再送', async () => {
  const dir = freshDir();
  const { s, ids } = await storeWith(dir, [1, 2, 3].map((i) => ({ kind: 'fact', text: `fact ${i}` })));
  const mem = { mode: 'full', checkoutId: 'c1', checkoutRoot: dir, picks: M.pickMemories(s.list(), ''), given: {}, injectedTokens: 0, queued: 0 };
  const first = M.injectionFor(s, mem, 'executor');
  for (const id of ids) await s.update(id, { text: `${id} ` + 'y'.repeat(2400) }, { byUser: true });
  const upd = M.injectionFor(s, mem, 'executor', first.given);
  assert.ok(upd.tokens <= M.MEMORY_BUDGET, `tokens ${upd.tokens}`);
  assert.ok(upd.leftOut.length >= 1);
  const sent = upd.given.filter((g) => g.contentDigest !== first.given.find((x) => x.memoryId === g.memoryId).contentDigest);
  assert.equal(sent.length, 3 - upd.leftOut.length); // 沒送出的保留舊摘要
  const next = M.injectionFor(s, mem, 'executor', upd.given);
  assert.ok(next.text.includes(upd.leftOut[0].memoryId));
});

test('壓縮後的接續對話：收到仍有效記憶的精簡清單', async () => {
  const dir = freshDir();
  const { s } = await storeWith(dir, [{ kind: 'instruction', text: 'use pnpm ' + 'z'.repeat(300) }, { kind: 'pitfall', text: 'EPERM on Windows' }]);
  const mem = { mode: 'full', checkoutId: 'c1', checkoutRoot: dir, picks: M.pickMemories(s.list(), ''), given: {}, injectedTokens: 0, queued: 0 };
  const first = M.injectionFor(s, mem, 'executor');
  assert.equal(M.injectionFor(s, mem, 'executor', first.given).text, '');
  const recap = M.injectionFor(s, mem, 'executor', first.given, { compacted: true });
  assert.match(recap.text, /compacted/);
  assert.match(recap.text, /EPERM on Windows/);
  assert.ok(recap.text.split('\n').every((l) => l.length < 200));
});

test('環境：記憶寫明的作業系統不符時不選、不帶入，並列出原因', async () => {
  const win = { os: 'windows', wsl: false };
  const lin = { os: 'linux', wsl: false };
  assert.equal(M.environmentFits('Windows 11, Node 22', win), true);
  assert.equal(M.environmentFits('Windows 11, Node 22', lin), false);
  assert.equal(M.environmentFits('Node 22', lin), true);
  assert.equal(M.environmentFits('WSL Ubuntu', lin), true);
  const dir = freshDir();
  const { s, ids } = await storeWith(dir, [{ kind: 'pitfall', text: 'close the editor before npm ci', environment: 'Windows' }, { kind: 'pitfall', text: 'anywhere' }]);
  assert.deepEqual(M.pickMemories(s.list(), '', lin).map((p) => p.memoryId), [ids[1]]);
  const mem = { mode: 'full', checkoutId: 'c1', checkoutRoot: dir, picks: M.pickMemories(s.list(), '', win), given: {}, injectedTokens: 0, queued: 0 };
  const inj = M.injectionFor(s, mem, 'executor', undefined, { env: lin });
  assert.doesNotMatch(inj.text, /close the editor/);
  assert.deepEqual(inj.leftOut, [{ memoryId: ids[0], reason: 'for another environment' }]);
});

test('工作流租約：持有租約的工作流，候選不會被別人套用；租約放掉後才會', async () => {
  const dir = freshDir();
  const s = new M.MemoryStore(dir, 'p1');
  const name = M.lockName(dir, 'wf-A');
  const lease = await M.holdOsLock(name);
  assert.ok(lease);
  assert.equal(await M.isOsLockHeld(name), true);
  await s.enqueue({ kind: 'fact', text: 'from A', source: src('A', '1'), lifecycle: 'active' });
  const ended = async () => {
    const out = new Set();
    for (const wf of s.queuedWorkflows()) if (!(await M.isOsLockHeld(M.lockName(dir, `wf-${wf}`)))) out.add(wf);
    return out;
  };
  let done = await ended();
  await s.processQueue({ workflows: (wf) => done.has(wf) });
  assert.equal(s.list().length, 0);
  assert.deepEqual(s.queuedWorkflows(), ['A']);
  await lease.release();
  done = await ended();
  await s.processQueue({ workflows: (wf) => done.has(wf) });
  assert.deepEqual(s.list().map((m) => m.text), ['from A']);
});

test('驗收產生的做法：沿用驗收開始時的依據；依賴檔改了就待重驗；沒有依據就不產生', async () => {
  const dir = freshDir();
  const { main } = repoWithWorktree();
  const id = await M.resolveProject(dir, main, { host: 'h1' });
  const s = new M.MemoryStore(dir, id.projectId);
  const goal = { statement: 'fast', metrics: [{ id: 'M1', name: 'p95', target: '<150ms', how: 'npm run bench' }], data: ['src/a.ts'] };
  const basis = M.fingerprint(id.checkoutRoot, ['src/a.ts']);
  const v = { outcome: 'met', summary: '', issues: [], metrics: [{ id: 'M1', value: '120ms', met: true, evidence: 'bench' }], fingerprint: basis };
  assert.deepEqual(M.fromVerification('w', goal, { ...v, fingerprint: undefined }, 1, 1, id.checkoutId), []);
  const [cand] = M.fromVerification('w', goal, v, 10, 1, id.checkoutId);
  assert.deepEqual(cand.evidence[0].files, basis);
  const { added } = await s.add(cand);
  // 驗收開始後、工作流結束前檔案又被改：記錄的仍是驗收開始時的版本，所以馬上就是待重驗
  fs.writeFileSync(path.join(main, 'src', 'a.ts'), 'export const a = 42;\n');
  const goalVersion = M.goalVersionOf(goal);
  await M.recordEvent(s, id.checkoutId, id.checkoutRoot, { kind: 'verification', ref: 'v1', workflowId: 'w', goalVersion, metricId: 'M1', met: true, stale: false, value: '120ms', at: 10, files: basis });
  const m = s.get(added[0]);
  const st = s.checkoutStates(id.checkoutId)[m.id];
  assert.deepEqual(st.fingerprint, basis);
  assert.equal(M.stateIn(m, id.checkoutId, id.checkoutRoot, st), 'needs_recheck');
});

test('沒有檔案依據的驗證：以整個 checkout 為依據，任何程式改動都待重驗', async () => {
  const dir = freshDir();
  const { main } = repoWithWorktree();
  const id = await M.resolveProject(dir, main, { host: 'h1' });
  const s = new M.MemoryStore(dir, id.projectId);
  const { added } = await s.add({ kind: 'practice', text: 'lint passes', check: { command: 'npm run lint', expectExit: 0 }, source: src('w', '1'), lifecycle: 'active' });
  await M.recordEvent(s, id.checkoutId, id.checkoutRoot, { kind: 'command', ref: 'c1', command: 'npm run lint', status: 'ok', exitCode: 0, at: 5 });
  const st = s.checkoutStates(id.checkoutId)[added[0]];
  assert.equal(st.fingerprint[0].path, M.WHOLE_CHECKOUT);
  assert.equal(M.stateIn(s.get(added[0]), id.checkoutId, id.checkoutRoot, st), 'verified');
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(path.join(main, 'src', 'b.ts'), 'export const b = 1;\n');
  assert.equal(M.stateIn(s.get(added[0]), id.checkoutId, id.checkoutRoot, st), 'needs_recheck');
});

test('指紋：資料夾超過掃描上限時標示不完整；之後改了沒掃到的檔案，也不會維持已驗證', async () => {
  const dir = freshDir();
  const { main } = repoWithWorktree();
  const data = path.join(main, 'data');
  fs.mkdirSync(data);
  for (let i = 0; i <= M.FOLDER_SCAN_LIMIT; i++) fs.writeFileSync(path.join(data, `f${String(i).padStart(6, '0')}.txt`), 'x');
  const id = await M.resolveProject(dir, main, { host: 'h1' });
  const fp = M.fingerprint(id.checkoutRoot, ['data']);
  assert.ok(fp[0].hash.startsWith(M.INCOMPLETE), fp[0].hash);
  assert.equal(M.basisIncomplete(fp), true);

  const s = new M.MemoryStore(dir, id.projectId);
  const { added } = await s.add({ kind: 'practice', text: 'eval passes', check: { command: 'npm run eval', expectExit: 0 }, source: src('w', '1'), evidence: [{ eventRef: 'e0', kind: 'file_read', checkoutId: id.checkoutId, files: fp, summary: 'data' }], lifecycle: 'active' });
  await M.recordEvent(s, id.checkoutId, id.checkoutRoot, { kind: 'command', ref: 'c1', command: 'npm run eval', status: 'ok', exitCode: 0, at: 5 });
  const st = s.checkoutStates(id.checkoutId)[added[0]];
  assert.equal(st.state, 'needs_recheck'); // 通過了，但依據不完整，不能記成已驗證
  assert.equal(st.lastVerifiedAt, 5);
  fs.writeFileSync(path.join(data, `f${String(M.FOLDER_SCAN_LIMIT).padStart(6, '0')}.txt`), 'changed');
  assert.deepEqual(M.stateDetail(s.get(added[0]), id.checkoutId, id.checkoutRoot, st), { state: 'needs_recheck', why: 'incomplete' });
  const mem = { mode: 'full', checkoutId: id.checkoutId, checkoutRoot: id.checkoutRoot, picks: M.pickMemories(s.list(), ''), given: {}, injectedTokens: 0, queued: 0 };
  assert.match(M.injectionFor(s, mem, 'executor').text, /could not be fully scanned/);
});

test('指紋：整個 checkout 的掃描被截斷時標示不完整；不存在的檔案記為 missing', () => {
  const dir = fs.mkdtempSync(path.join(work, 'tree-'));
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, `f${i}.ts`), 'x');
  assert.equal(M.treeScan(dir, 10).complete, false);
  assert.equal(M.treeScan(dir).complete, true);
  assert.equal(M.fingerprint(dir, [M.WHOLE_CHECKOUT])[0].hash.startsWith('tree:'), true);
  assert.equal(M.fingerprint(dir, ['nope.ts'])[0].hash, 'missing');
});

test('只讀查詢：新專案找不到時不建立任何檔案', () => {
  const dir = freshDir();
  const plain = fs.mkdtempSync(path.join(work, 'plain-'));
  assert.equal(M.findProject(dir, plain, { host: 'h1' }), undefined);
  assert.equal(fs.existsSync(path.join(dir, 'memory')), false);
});

test('測試工具：子程序沒印出就緒訊號就結束時，立刻失敗並附上輸出，不會一直等', async () => {
  const w = worker(['no-such-mode', freshDir()]);
  const t0 = Date.now();
  await assert.rejects(w.ready('held', 20000), /ended \(code 0\) before printing "held"/);
  assert.ok(Date.now() - t0 < 10000);
});

test.after(() => {
  for (const c of live) c.kill('SIGKILL');
});

test.after(() => fs.rmSync(work, { recursive: true, force: true }));

test('驗收事件沒帶依據時，不記成已驗證', async () => {
  const dir = freshDir();
  const s = new M.MemoryStore(dir, 'p1');
  const { added } = await s.add({ kind: 'practice', text: 'p95 ok', source: { ...src('w', '1'), metricId: 'M1' }, lifecycle: 'active' });
  await M.recordEvent(s, 'c1', dir, { kind: 'verification', ref: 'v1', workflowId: 'w', metricId: 'M1', met: true, stale: false, value: '1', at: 1 });
  assert.equal(s.checkoutStates('c1')[added[0]].state, 'needs_recheck');
});

/** Make fs calls on paths matching `match` fail with `code` while `fn` runs (through the bundle's fs wrapper). */
const realFs = createRequire(import.meta.url)('node:fs');
function failing(name, match, code, fn) {
  const real = realFs[name];
  globalThis.__fsFail = {
    [name]: function (p, ...rest) {
      if (match(String(p))) throw Object.assign(new Error(`${code}: ${p}`), { code });
      return real.call(realFs, p, ...rest);
    },
  };
  try {
    return fn();
  } finally {
    globalThis.__fsFail = undefined;
  }
}

test('指紋：整個 checkout 有讀不到的資料夾或檔案時標示不完整；掃描中被刪掉的檔案不算', () => {
  const dir = fs.mkdtempSync(path.join(work, 'tree-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'x');
  fs.writeFileSync(path.join(dir, 'b.ts'), 'y');
  const inSrc = (p) => path.basename(p) === 'src';
  assert.equal(M.treeScan(dir).complete, true);
  assert.equal(failing('readdirSync', inSrc, 'EACCES', () => M.treeScan(dir).complete), false);
  assert.ok(failing('readdirSync', inSrc, 'EACCES', () => M.fingerprint(dir, [M.WHOLE_CHECKOUT])[0].hash).startsWith(M.INCOMPLETE));
  const isB = (p) => path.basename(p) === 'b.ts';
  assert.equal(failing('statSync', isB, 'EPERM', () => M.treeScan(dir).complete), false);
  assert.equal(failing('statSync', isB, 'ENOENT', () => M.treeScan(dir).complete), true);
});

test('指紋：單一檔案或資料夾讀不到時標示不完整，不當成沒變', () => {
  const dir = fs.mkdtempSync(path.join(work, 'fp-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'x.csv'), '1');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'x');
  assert.equal(failing('readFileSync', (p) => path.basename(p) === 'a.ts', 'EACCES', () => M.fingerprint(dir, ['a.ts'])[0].hash), `${M.INCOMPLETE}unreadable`);
  assert.ok(failing('readdirSync', (p) => path.basename(p) === 'data', 'EACCES', () => M.fingerprint(dir, ['data'])[0].hash).startsWith(M.INCOMPLETE));
  assert.ok(!M.fingerprint(dir, ['data'])[0].hash.startsWith(M.INCOMPLETE));
});
