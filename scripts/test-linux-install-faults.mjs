import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from './lib/test-shard.mjs';

// Every step of install.sh and uninstall.sh, made to fail one at a time: each call of each outside command they use
// (reading, hashing, writing the records, copying and renaming files, removing them, resolving paths) fails once, as a
// read error, a full disk or a permission error would. After each such run, three things must hold:
//   1. the user's files (in the install folder and ~/.aivenue) are exactly as before;
//   2. the records still vouch for every Aivenue file there: with the fault gone, the same install.sh finishes the
//      install, and uninstall.sh (on a copy of the folder) removes every Aivenue file;
//   3. a run that reports success (exit 0) really finished: the whole new version in place and nothing pending, or,
//      for uninstall.sh, no Aivenue file left.
const skip = process.platform !== 'linux' && 'install.sh is for Linux';
const linux = path.resolve('packages/desktop/linux');
const LIST = '.aivenue-files';
const LEGACY = '.aivenue-legacy-files';
const PENDING = '.aivenue-pending';
const MARK = '.aivenue-install';
const APP_FILES = ['aivenue', 'aivenue.sh', 'chrome_crashpad_handler', 'aivenue.png', 'resources/app.asar', 'resources/app.asar.unpacked/node_modules/x/index.js', 'locales/en-US.pak'];
const LEGACY_FILES = [...APP_FILES, 'install.sh', 'uninstall.sh'];
// The outside commands the two scripts run (the shell's own builtins cannot fail this way).
const TOOLS = ['sha256sum', 'cat', 'cp', 'mv', 'sort', 'grep', 'sed', 'cut', 'wc', 'mktemp', 'mkdir', 'chmod', 'rm', 'readlink', 'dirname', 'ls', 'awk', 'rmdir', 'od', 'tr'];
const real = Object.fromEntries(TOOLS.map((t) => [t, spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim()]));

function makePackage(dir, tag, files = APP_FILES, scripts = linux) {
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), `stub ${f} ${tag}`);
  }
  for (const f of ['install.sh', 'uninstall.sh']) fs.copyFileSync(path.join(scripts, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, LEGACY), LEGACY_FILES.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, LIST), [...files, 'install.sh', 'uninstall.sh', LEGACY, LIST].sort().join('\n') + '\n');
}
const sha = (file) => (fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'missing');
function treeSha(dir, rels) {
  const h = createHash('sha256');
  const walk = (rel) => {
    const p = path.join(dir, rel);
    if (!fs.existsSync(p)) return h.update(`missing ${rel}\n`);
    if (fs.statSync(p).isDirectory()) for (const e of fs.readdirSync(p).sort()) walk(path.join(rel, e));
    else h.update(`${rel} ${sha(p)}\n`);
  };
  rels.forEach(walk);
  return h.digest('hex');
}
const USER_RELS = ['data', 'notes.txt', 'resources/my-theme.css', 'blob.bin', '.aivenue-staging.personal-backup'];
function userFiles(dest) {
  const files = { 'data/runs/r1/run.json': '{"id":"r1"}', 'data/memory/p1/log.jsonl': '{"text":"remember"}\n', 'notes.txt': 'mine', 'resources/my-theme.css': 'body{}', '.aivenue-staging.personal-backup/h': 'backup' };
  for (const [f, s] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
    fs.writeFileSync(path.join(dest, f), s);
  }
  fs.writeFileSync(path.join(dest, 'blob.bin'), Buffer.from([0, 1, 2, 255, 254, 10, 13, 0xe4, 0xbd, 0xa0]));
}

/** The shared packages and fault commands. */
function setupRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-faults-'));
  const pkg = path.join(root, 'pkg');
  makePackage(pkg, 'new');
  const old = path.join(root, 'old024'); // the 0.2.4 program (no list, no marker)
  makePackage(old, 'old');
  const v1 = path.join(root, 'v1'); // an earlier install with the list, and a file the new version no longer has
  makePackage(v1, 'v1', [...APP_FILES, 'locales/old-only.pak']);
  const fdir = path.join(root, 'faults');
  fs.mkdirSync(fdir);
  for (const t of TOOLS) {
    fs.writeFileSync(path.join(fdir, t), [
      '#!/bin/sh',
      `c="$FAULT_DIR/n.${t}"; n=0; [ -f "$c" ] && read -r n < "$c"; case "$n" in ''|*[!0-9]*) n=0 ;; esac; n=$((n + 1)); echo "$n" > "$c"`,
      // A real read or write error: grep reports it with 2 (1 means "no line matched"), the others with 1.
      `if [ "$FAULT_TOOL" = ${t} ] && [ "$n" = "$FAULT_AT" ]; then echo "${t}: injected failure (call $n)" >&2; exit ${t === 'grep' ? 2 : 1}; fi`,
      `exec ${real[t]} "$@"`,
    ].join('\n') + '\n', { mode: 0o755 });
  }
  const kdir = path.join(root, 'kill'); // `mv` that kills the script on its Nth call (KILL_AT), to leave a stopped install
  fs.mkdirSync(kdir);
  fs.writeFileSync(path.join(kdir, 'mv'), `#!/bin/sh\nc="$KILL_COUNT"; n=0; [ -f "$c" ] && read -r n < "$c"; n=$((n + 1)); echo "$n" > "$c"\n[ "$n" = "$KILL_AT" ] && kill -9 $PPID && sleep 1\nexec ${real.mv} "$@"\n`, { mode: 0o755 });
  return { root, pkg, old, v1, fdir, kdir };
}

function sh(script, env) {
  return new Promise((resolve) => {
    const c = spawn('sh', [script], { env });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('close', (code) => resolve({ code, out }));
  });
}
const shSync = (script, env) => {
  const r = spawnSync('sh', [script], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
};

/** A fresh case folder: HOME with ~/.aivenue, and the install folder in the state `kind` names. */
function makeCase(R, dir, kind) {
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.aivenue'), { recursive: true });
  fs.writeFileSync(path.join(home, '.aivenue', 'data.json'), 'keep');
  const dest = path.join(dir, 'apps');
  const env = (extra = {}) => ({ PATH: process.env.PATH, HOME: home, AIVENUE_INSTALL_DIR: dest, ...extra });
  const legacy = () => {
    for (const f of LEGACY_FILES) {
      fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
      fs.copyFileSync(path.join(R.old, f), path.join(dest, f));
    }
  };
  const stop = () => {
    const r = shSync(path.join(R.pkg, 'install.sh'), env({ PATH: `${R.kdir}:${process.env.PATH}`, KILL_COUNT: path.join(dir, 'k'), KILL_AT: '5' }));
    assert.equal(r.code, null, `setup: the install stopped (${r.out})`);
    assert.ok(fs.existsSync(path.join(dest, PENDING)), 'setup: a stopped install');
  };
  if (kind === 'new') {
    // nothing there yet
  } else if (kind === 'legacy') {
    legacy();
  } else if (kind === 'legacy-stopped') {
    legacy();
    userFiles(dest);
    stop();
  } else if (kind === 'v1') {
    assert.equal(shSync(path.join(R.v1, 'install.sh'), env()).code, 0);
  } else if (kind === 'installed') {
    assert.equal(shSync(path.join(R.v1, 'install.sh'), env()).code, 0);
    assert.equal(shSync(path.join(R.pkg, 'install.sh'), env()).code, 0);
  }
  if (kind !== 'new' && kind !== 'legacy-stopped') userFiles(dest);
  return { dir, home, dest, env };
}
const userState = (c) => `${treeSha(c.dest, USER_RELS)} ${treeSha(c.home, ['.aivenue'])}`;
const ourStaging = (dest) => (fs.existsSync(dest) ? fs.readdirSync(dest).filter((n) => /^\.aivenue-staging\.[0-9a-f]{16}$/.test(n)) : []);
const tempRecords = (dest) => (fs.existsSync(dest) ? fs.readdirSync(dest).filter((n) => /^\.aivenue-(pending|files|install)\.[A-Za-z0-9]{6}$/.test(n)) : []);
const pkgFiles = (pkg) => fs.readFileSync(path.join(pkg, LIST), 'utf8').trim().split('\n');
/** The new version is installed and finished: every package file in place with the package's content, the file list
 * names them and the marker records the list's SHA-256, nothing pending. */
function installedProblem(dest, pkg) {
  for (const f of pkgFiles(pkg)) if (f !== LIST && sha(path.join(dest, f)) !== sha(path.join(pkg, f))) return `${f} is not the new version's`;
  const list = fs.existsSync(path.join(dest, LIST)) ? fs.readFileSync(path.join(dest, LIST), 'utf8').trim().split('\n') : [];
  if (!pkgFiles(pkg).every((f) => list.includes(f))) return 'the file list does not name every file';
  if (!fs.existsSync(path.join(dest, MARK)) || !fs.readFileSync(path.join(dest, MARK), 'utf8').includes(`list ${sha(path.join(dest, LIST))}`)) return 'the marker does not record the list';
  if (fs.existsSync(path.join(dest, PENDING))) return 'a plan is still pending';
  if (ourStaging(dest).length) return 'a staging folder is left';
  return '';
}
const AIVENUE_NAMES = [...new Set([...LEGACY_FILES, ...APP_FILES, 'locales/old-only.pak', LIST, LEGACY, PENDING])];
function removedProblem(dest) {
  if (!fs.existsSync(dest)) return '';
  const left = AIVENUE_NAMES.filter((f) => fs.existsSync(path.join(dest, f)));
  if (left.length) return `left: ${left.join(', ')}`;
  if (ourStaging(dest).length) return 'a staging folder is left';
  return '';
}

/** Count the calls of each command in one run of `step` with no fault. */
async function countCalls(R, kind, step) {
  const dir = fs.mkdtempSync(path.join(R.root, 'count-'));
  const c = makeCase(R, dir, kind);
  const fd = path.join(dir, 'f');
  fs.mkdirSync(fd);
  const r = await sh(path.join(R.pkg, `${step}.sh`), c.env({ PATH: `${R.fdir}:${process.env.PATH}`, FAULT_DIR: fd, FAULT_TOOL: '' }));
  assert.equal(r.code, 0, `${kind} ${step} with no fault: ${r.out}`);
  const n = Object.fromEntries(TOOLS.map((t) => [t, fs.existsSync(path.join(fd, `n.${t}`)) ? Number(fs.readFileSync(path.join(fd, `n.${t}`), 'utf8')) : 0]));
  fs.rmSync(dir, { recursive: true, force: true });
  return n;
}

/** One trial: `step` (install or uninstall) with the `at`th call of `tool` failing, then the checks. */
async function trial(R, kind, step, tool, at) {
  const label = `${kind} ${step}: ${tool} call ${at}`;
  const dir = fs.mkdtempSync(path.join(R.root, 't-'));
  const c = makeCase(R, dir, kind);
  const before = userState(c);
  const fd = path.join(dir, 'f');
  fs.mkdirSync(fd);
  const r = await sh(path.join(R.pkg, `${step}.sh`), c.env({ PATH: `${R.fdir}:${process.env.PATH}`, FAULT_DIR: fd, FAULT_TOOL: tool, FAULT_AT: String(at) }));
  const fails = [];
  const check = (ok, what) => ok || fails.push(what);
  check(r.code !== null, 'the run was not killed');
  check(userState(c) === before, 'user files unchanged after the faulty run');
  if (r.code === 0) {
    const p = step === 'install' ? installedProblem(c.dest, R.pkg) : removedProblem(c.dest);
    check(!p, `reported success but not finished: ${p}`);
  }
  // With the fault gone: the same install finishes (in this folder), and uninstall removes everything (in a copy).
  const copy = { ...c, dir: path.join(dir, 'b'), dest: path.join(dir, 'b', 'apps'), home: path.join(dir, 'b', 'home') };
  fs.mkdirSync(copy.dir);
  if (fs.existsSync(c.dest)) fs.cpSync(c.dest, copy.dest, { recursive: true, verbatimSymlinks: true });
  fs.cpSync(c.home, copy.home, { recursive: true, verbatimSymlinks: true });
  const copyBefore = userState(copy);
  if (step === 'install' || fs.existsSync(c.dest)) {
    const again = await sh(path.join(R.pkg, 'install.sh'), c.env());
    check(again.code === 0, `install again: exit ${again.code}: ${again.out.trim().split('\n').slice(0, 4).join(' | ')}`);
    if (again.code === 0) check(!installedProblem(c.dest, R.pkg), `install again: ${installedProblem(c.dest, R.pkg)}`);
    check(userState(c) === before, 'user files unchanged after installing again');
    check(tempRecords(c.dest).length === 0, `install again: records left half-written: ${tempRecords(c.dest)}`);
  }
  if (fs.existsSync(copy.dest)) {
    const env = { PATH: process.env.PATH, HOME: copy.home, AIVENUE_INSTALL_DIR: copy.dest };
    const un = await sh(path.join(R.pkg, 'uninstall.sh'), env);
    check(un.code === 0, `uninstall: exit ${un.code}: ${un.out.trim().split('\n').slice(0, 4).join(' | ')}`);
    check(!removedProblem(copy.dest), `uninstall: ${removedProblem(copy.dest)}`);
    check(userState(copy) === copyBefore, 'user files unchanged after uninstall');
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return fails.length ? `${label} (exit ${r.code}; ${r.out.trim().split('\n').slice(-2).join(' | ')}): ${fails.join('; ')}` : '';
}

// One pool of workers for every sweep (they run at the same time): one trial per CPU.
const POOL = Math.max(2, os.cpus().length);
let running = 0;
const waiting = [];
async function slot(fn) {
  if (running >= POOL) await new Promise((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

async function sweep(kind, step) {
  const R = setupRoot();
  try {
    const counts = await countCalls(R, kind, step);
    const jobs = [];
    for (const t of TOOLS) for (let at = 1; at <= counts[t]; at++) jobs.push([t, at]);
    const problems = (await Promise.all(jobs.map(([t, at]) => slot(() => trial(R, kind, step, t, at))))).filter(Boolean);
    assert.ok(jobs.length > 100, `${kind} ${step}: ${jobs.length} faults tried`);
    assert.deepEqual(problems.sort(), [], `${kind} ${step}: ${jobs.length} faults tried (${Object.entries(counts).filter(([, n]) => n).map(([t, n]) => `${t} ${n}`).join(', ')})`);
  } finally {
    fs.rmSync(R.root, { recursive: true, force: true });
  }
}

// The seven sweeps run at the same time and share the pool above.
const SWEEPS = [
  ['故障掃描：首次安裝，每個外部指令的每一次呼叫各失敗一次', 'new', 'install'],
  ['故障掃描：從 0.2.4 升級，每個外部指令的每一次呼叫各失敗一次（含舊檔、新檔的雜湊失敗）', 'legacy', 'install'],
  ['故障掃描：0.2.4 升級中斷後（已有完整計畫）重跑，每一次呼叫各失敗一次；上一份計畫保留到新計畫接替', 'legacy-stopped', 'install'],
  ['故障掃描：有清單的覆蓋安裝（含舊版才有的檔案），每一次呼叫各失敗一次', 'v1', 'install'],
  ['故障掃描：卸載完成的安裝，每一次呼叫各失敗一次', 'installed', 'uninstall'],
  ['故障掃描：卸載中斷的升級（依計畫），每一次呼叫各失敗一次', 'legacy-stopped', 'uninstall'],
  ['故障掃描：用新套件卸載 0.2.4，每一次呼叫各失敗一次', 'legacy', 'uninstall'],
];
test('故障掃描（七種情境同時進行）', { skip, concurrency: true }, async (t) => {
  await Promise.all(SWEEPS.map(([name, kind, step]) => t.test(name, () => sweep(kind, step))));
});
