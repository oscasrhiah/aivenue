import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from './lib/test-shard.mjs';

// install.sh / uninstall.sh on a stub package in a throwaway HOME: default and custom install folders, folders that are
// not Aivenue's, and the user's files — in ~/.aivenue or inside the install folder itself — which are always kept.
const skip = process.platform !== 'linux' && 'install.sh is for Linux';
const linux = path.resolve('packages/desktop/linux');
const LIST = '.aivenue-files';
const APP_FILES = ['aivenue', 'aivenue.sh', 'chrome_crashpad_handler', 'aivenue.png', 'resources/app.asar', 'resources/app.asar.unpacked/node_modules/x/index.js', 'locales/en-US.pak'];

const LEGACY = '.aivenue-legacy-files';
/** What a package from before the list (0.2.4 and earlier) held (stub): the app files and the two scripts. */
const LEGACY_FILES = [...APP_FILES, 'install.sh', 'uninstall.sh'];

/** A package folder like scripts/package-linux.mjs makes: the app files, the scripts, the legacy list and the list of all. */
function makePackage(dir, files = APP_FILES, scripts = linux) {
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), `stub ${f} ${path.basename(dir)}`);
  }
  for (const f of ['install.sh', 'uninstall.sh']) fs.copyFileSync(path.join(scripts, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, LEGACY), LEGACY_FILES.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, LIST), [...files, 'install.sh', 'uninstall.sh', LEGACY, LIST].sort().join('\n') + '\n');
}
/** Every file under `dir` with its content, to show that a refused install changed nothing. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) out[path.relative(dir, p)] = `link → ${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function world() {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-install-'));
  const home = path.join(w, 'home');
  fs.mkdirSync(path.join(home, '.aivenue'), { recursive: true });
  fs.writeFileSync(path.join(home, '.aivenue', 'data.json'), 'keep');
  const pkg = path.join(w, 'pkg');
  makePackage(pkg);
  // A clean shell: only what is passed here (no AIVENUE_HOME, AIVENUE_INSTALL_DIR… from the test's own environment).
  const run = (script, env = {}) => {
    const r = spawnSync('sh', [script], { env: { PATH: process.env.PATH, HOME: home, ...env }, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const bin = path.join(home, '.local/bin/aivenue');
  const desktop = path.join(home, '.local/share/applications/aivenue.desktop');
  const icon = path.join(home, '.local/share/icons/hicolor/512x512/apps/aivenue.png');
  const linked = () => (isLink(bin) ? fs.readlinkSync(bin) : undefined);
  const shortcutsGone = () => !isLink(bin) && !fs.existsSync(desktop) && !fs.existsSync(icon);
  const dataKept = () => fs.readFileSync(path.join(home, '.aivenue', 'data.json'), 'utf8') === 'keep';
  return { w, home, pkg, run, bin, desktop, linked, shortcutsGone, dataKept, done: () => fs.rmSync(w, { recursive: true, force: true }) };
}
const isLink = (p) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
/** Files a user keeps inside the install folder (AIVENUE_HOME pointed there once, or notes). */
function userFiles(dest) {
  const files = { 'data/runs/r1/run.json': '{"id":"r1"}', 'data/memory/p1/log.jsonl': '{"text":"remember"}\n', 'notes.txt': 'mine', 'resources/my-theme.css': 'body{}' };
  for (const [f, s] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
    fs.writeFileSync(path.join(dest, f), s);
  }
  return () => Object.entries(files).every(([f, s]) => fs.existsSync(path.join(dest, f)) && fs.readFileSync(path.join(dest, f), 'utf8') === s);
}
// Every file of the app is gone (a folder kept for the user's files keeps only the marker that it was Aivenue's).
const appGone = (dest) => APP_FILES.concat(['install.sh', 'uninstall.sh', LIST]).every((f) => !fs.existsSync(path.join(dest, f)));

test('安裝／卸載：預設位置，從安裝資料夾卸載，資料夾整個移除、資料保留', { skip }, () => {
  const t = world();
  const dest = path.join(t.home, '.local/share/aivenue');
  assert.equal(t.run(path.join(t.pkg, 'install.sh')).code, 0);
  assert.ok(fs.existsSync(path.join(dest, '.aivenue-install')) && fs.existsSync(path.join(dest, LIST)));
  assert.equal(t.linked(), path.join(dest, 'aivenue.sh'));
  const r = t.run(path.join(dest, 'uninstall.sh'));
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(dest) && t.shortcutsGone() && t.dataKept(), r.out);
  t.done();
});

test('安裝：只複製清單上的檔案，解壓資料夾裡其他東西不會被裝進去', { skip }, () => {
  const t = world();
  fs.writeFileSync(path.join(t.pkg, 'stray.txt'), 'not part of the package');
  const dest = path.join(t.w, 'apps');
  assert.equal(t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest }).code, 0);
  assert.ok(!fs.existsSync(path.join(dest, 'stray.txt')));
  assert.ok(fs.existsSync(path.join(dest, 'resources/app.asar.unpacked/node_modules/x/index.js')));
  t.done();
});

test('卸載：資料曾存到安裝資料夾內，換一個沒有 AIVENUE_HOME 的乾淨 shell 直接卸載，資料全部保留', { skip }, () => {
  const t = world();
  const dest = path.join(t.home, '.local/share/aivenue');
  t.run(path.join(t.pkg, 'install.sh'));
  const kept = userFiles(dest);
  const r = t.run(path.join(dest, 'uninstall.sh')); // no AIVENUE_HOME, no AIVENUE_INSTALL_DIR
  assert.equal(r.code, 0, r.out);
  assert.ok(kept(), 'user files inside the install folder are kept');
  assert.ok(appGone(dest), 'every Aivenue file is removed');
  assert.ok(t.shortcutsGone());
  assert.match(r.out, /Kept .*not part of Aivenue/);
  // The kept folder can be installed into again; with AIVENUE_HOME pointing there it is the same: removed app, kept data.
  const again = t.run(path.join(t.pkg, 'install.sh'));
  assert.equal(again.code, 0, again.out);
  assert.ok(kept() && fs.existsSync(path.join(dest, 'aivenue')));
  const r2 = t.run(path.join(dest, 'uninstall.sh'), { AIVENUE_HOME: path.join(dest, 'data') });
  assert.equal(r2.code, 0, r2.out);
  assert.ok(kept() && appGone(dest));
  // Removing again from the extracted package finds nothing more to remove and still keeps the files.
  const r3 = t.run(path.join(t.pkg, 'uninstall.sh'), { AIVENUE_INSTALL_DIR: dest });
  assert.equal(r3.code, 0, r3.out);
  assert.ok(kept());
  t.done();
});

test('覆蓋安裝：安裝資料夾內的使用者檔案保留；舊版有、新版沒有的檔案移除', { skip }, () => {
  const t = world();
  const dest = path.join(t.w, 'custom-apps');
  const v1 = path.join(t.w, 'v1');
  makePackage(v1, [...APP_FILES, 'locales/old-only.pak']);
  assert.equal(t.run(path.join(v1, 'install.sh'), { AIVENUE_INSTALL_DIR: dest }).code, 0);
  const kept = userFiles(dest);
  fs.writeFileSync(path.join(t.pkg, 'aivenue'), 'stub aivenue v2');
  const r = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
  assert.equal(r.code, 0, r.out);
  assert.ok(kept(), 'user files kept over a reinstall');
  assert.equal(fs.readFileSync(path.join(dest, 'aivenue'), 'utf8'), 'stub aivenue v2');
  assert.ok(!fs.existsSync(path.join(dest, 'locales/old-only.pak')));
  assert.equal(fs.readFileSync(path.join(dest, LIST), 'utf8'), fs.readFileSync(path.join(t.pkg, LIST), 'utf8'));
  t.done();
});

test('安裝／卸載：自訂位置（名稱不是 aivenue）不必再設環境變數，從安裝資料夾或解壓資料夾都能完整卸載', { skip }, () => {
  const t = world();
  const custom = path.join(t.w, 'custom-apps');
  assert.equal(t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: custom }).code, 0);
  assert.ok(fs.readFileSync(t.desktop, 'utf8').includes(`Exec=${custom}/aivenue.sh %U`));
  let r = t.run(path.join(custom, 'uninstall.sh'));
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(custom) && t.shortcutsGone() && t.dataKept());
  // From the extracted package: found through the `aivenue` command; the package itself is left alone.
  assert.equal(t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: custom }).code, 0);
  r = t.run(path.join(t.pkg, 'uninstall.sh'));
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(custom) && t.shortcutsGone() && t.dataKept() && fs.existsSync(path.join(t.pkg, 'aivenue.sh')));
  t.done();
});

test('安裝／卸載：不是 Aivenue 的資料夾、HOME、不完整的套件，都在刪除任何東西前拒絕', { skip }, () => {
  const t = world();
  const projects = path.join(t.w, 'projects');
  fs.mkdirSync(projects);
  fs.writeFileSync(path.join(projects, 'important.txt'), 'mine');
  assert.notEqual(t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: projects }).code, 0);
  assert.ok(!isLink(t.bin));
  assert.equal(t.run(path.join(t.pkg, 'install.sh')).code, 0); // a real install, whose shortcuts must survive
  for (const env of [{ AIVENUE_INSTALL_DIR: projects }, { AIVENUE_INSTALL_DIR: t.home }, { AIVENUE_INSTALL_DIR: path.join(t.w, 'nowhere') }]) {
    const r = t.run(path.join(t.pkg, 'uninstall.sh'), env);
    assert.notEqual(r.code, 0, `${env.AIVENUE_INSTALL_DIR}: ${r.out}`);
  }
  assert.notEqual(t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: t.home }).code, 0);
  assert.equal(fs.readFileSync(path.join(projects, 'important.txt'), 'utf8'), 'mine');
  assert.ok(isLink(t.bin) && fs.existsSync(t.desktop) && t.dataKept());
  // install.sh inside the install would replace itself while running.
  const dest = path.join(t.home, '.local/share/aivenue');
  assert.notEqual(t.run(path.join(dest, 'install.sh')).code, 0);
  assert.ok(fs.existsSync(path.join(dest, 'aivenue.sh')));
  // A package without its file list is not installed.
  const broken = path.join(t.w, 'broken');
  makePackage(broken);
  fs.rmSync(path.join(broken, LIST));
  assert.notEqual(t.run(path.join(broken, 'install.sh'), { AIVENUE_INSTALL_DIR: path.join(t.w, 'b') }).code, 0);
  assert.ok(!fs.existsSync(path.join(t.w, 'b')));
  assert.equal(t.run(path.join(t.pkg, 'install.sh')).code, 0, 'reinstall over an install');
  t.done();
});

test('卸載：無法確認哪些是 Aivenue 的檔案（沒有清單、清單指到資料夾外），刪除前就拒絕', { skip }, () => {
  const t = world();
  const dest = path.join(t.home, '.local/share/aivenue');
  t.run(path.join(t.pkg, 'install.sh'));
  const kept = userFiles(dest);
  const outside = path.join(t.w, 'outside.txt');
  fs.writeFileSync(outside, 'not in the install');
  // A list naming a file outside the folder.
  fs.appendFileSync(path.join(dest, LIST), '../../../outside.txt\n');
  let r = t.run(path.join(dest, 'uninstall.sh'));
  assert.notEqual(r.code, 0, r.out);
  assert.ok(fs.existsSync(outside) && kept() && fs.existsSync(path.join(dest, 'aivenue')) && isLink(t.bin));
  // No list at all, run from inside the install: nothing to tell the files apart by.
  fs.rmSync(path.join(dest, LIST));
  r = t.run(path.join(dest, 'uninstall.sh'));
  assert.notEqual(r.code, 0, r.out);
  assert.ok(kept() && fs.existsSync(path.join(dest, 'aivenue')) && isLink(t.bin) && fs.existsSync(t.desktop));
  t.done();
});

test('卸載：清單上的路徑經過連到資料夾外的連結時，不刪連結另一端的檔案', { skip }, () => {
  const t = world();
  const dest = path.join(t.w, 'apps');
  t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
  // locales/ replaced by a link to a folder elsewhere that has a file of the same name.
  const elsewhere = path.join(t.w, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'en-US.pak'), 'someone else');
  fs.rmSync(path.join(dest, 'locales'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(dest, 'locales'));
  const r = t.run(path.join(dest, 'uninstall.sh'));
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(path.join(elsewhere, 'en-US.pak'), 'utf8'), 'someone else');
  t.done();
});

test('安裝／卸載：兩份安裝時，移除沒被捷徑指到的那份不會刪掉另一份的捷徑', { skip }, () => {
  const t = world();
  const first = path.join(t.w, 'first');
  const second = path.join(t.w, 'second');
  t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: first });
  t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: second });
  const r = t.run(path.join(first, 'uninstall.sh'));
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(first));
  assert.equal(t.linked(), path.join(second, 'aivenue.sh'));
  assert.ok(fs.readFileSync(t.desktop, 'utf8').includes(`Exec=${second}/aivenue.sh`));
  t.done();
});

test('0.2.4 以前的安裝（沒有標記檔和清單）：新的 uninstall.sh 依套件清單移除，裡面的使用者檔案保留；覆蓋安裝也一樣', { skip }, () => {
  const t = world();
  const legacy = path.join(t.w, 'legacy-apps');
  // What an older install.sh leaves: the app files and shortcuts, no marker, no list.
  for (const f of [...APP_FILES, 'install.sh', 'uninstall.sh']) {
    fs.mkdirSync(path.dirname(path.join(legacy, f)), { recursive: true });
    fs.copyFileSync(path.join(t.pkg, f), path.join(legacy, f));
  }
  const kept = userFiles(legacy);
  fs.mkdirSync(path.dirname(t.bin), { recursive: true });
  fs.symlinkSync(path.join(legacy, 'aivenue.sh'), t.bin);
  fs.mkdirSync(path.dirname(t.desktop), { recursive: true });
  fs.writeFileSync(t.desktop, `[Desktop Entry]\nName=Aivenue\nExec=${legacy}/aivenue.sh %U\n`);
  // Reinstall over it first: the user's files survive, and it becomes an install with a list.
  let r = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: legacy });
  assert.equal(r.code, 0, r.out);
  assert.ok(kept() && fs.existsSync(path.join(legacy, LIST)));
  // Then a plain older layout again, removed from the extracted package.
  fs.rmSync(path.join(legacy, LIST));
  fs.rmSync(path.join(legacy, '.aivenue-install'));
  r = t.run(path.join(t.pkg, 'uninstall.sh'));
  assert.equal(r.code, 0, r.out);
  assert.ok(kept() && appGone(legacy) && t.shortcutsGone() && t.dataKept());
  t.done();
});

// ---------- Reinstall conflicts: a path the new version needs already holds something that is not Aivenue's ----------

test('覆蓋安裝：新版新增的檔名撞上使用者檔案時，在修改任何檔案前拒絕；之後卸載也不刪那個檔案', { skip }, () => {
  const t = world();
  const dest = path.join(t.w, 'apps');
  const v1 = path.join(t.w, 'v1');
  makePackage(v1);
  assert.equal(t.run(path.join(v1, 'install.sh'), { AIVENUE_INSTALL_DIR: dest }).code, 0);
  fs.writeFileSync(path.join(dest, 'my-notes.txt'), 'my precious notes');
  // The next version adds a file of the same name.
  const v2 = path.join(t.w, 'v2');
  makePackage(v2, [...APP_FILES, 'my-notes.txt']);
  const before = { files: snapshot(dest), bin: t.linked(), desktop: fs.readFileSync(t.desktop, 'utf8') };
  const r = t.run(path.join(v2, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /my-notes\.txt \(already there and not an Aivenue file\)/);
  assert.deepEqual(snapshot(dest), before.files, 'nothing in the install folder changed');
  assert.equal(t.linked(), before.bin);
  assert.equal(fs.readFileSync(t.desktop, 'utf8'), before.desktop);
  // The v1 install is still whole, and removing it keeps the notes.
  const u = t.run(path.join(dest, 'uninstall.sh'));
  assert.equal(u.code, 0, u.out);
  assert.equal(fs.readFileSync(path.join(dest, 'my-notes.txt'), 'utf8'), 'my precious notes');
  assert.ok(appGone(dest));
  t.done();
});

test('覆蓋安裝：清單上的檔案被換成資料夾、或需要資料夾的位置是檔案，也在修改前拒絕', { skip }, () => {
  const t = world();
  const dest = path.join(t.w, 'apps');
  t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
  // An Aivenue file replaced by a folder of the user's.
  fs.rmSync(path.join(dest, 'aivenue.png'));
  fs.mkdirSync(path.join(dest, 'aivenue.png'));
  fs.writeFileSync(path.join(dest, 'aivenue.png', 'inside.txt'), 'mine');
  let before = snapshot(dest);
  let r = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
  assert.notEqual(r.code, 0, r.out);
  assert.deepEqual(snapshot(dest), before);
  fs.rmSync(path.join(dest, 'aivenue.png'), { recursive: true });
  // A user's file where the package needs the locales/ folder.
  fs.rmSync(path.join(dest, 'locales'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'locales'), 'a file');
  before = snapshot(dest);
  r = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /locales \(a file where Aivenue needs a folder\)/);
  assert.deepEqual(snapshot(dest), before);
  t.done();
});

test('覆蓋安裝：寫入位置經過連到安裝資料夾外的連結時，在修改前拒絕，外面的檔案不被寫入或刪除', { skip }, () => {
  const t = world();
  const dest = path.join(t.w, 'apps');
  t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
  const outside = path.join(t.w, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'app.asar'), 'someone else');
  // resources/ replaced by a link to a folder elsewhere.
  fs.rmSync(path.join(dest, 'resources'), { recursive: true });
  fs.symlinkSync(outside, path.join(dest, 'resources'));
  const before = { dest: snapshot(dest), outside: snapshot(outside) };
  let r = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /resources\/app\.asar \(a link leads it outside/);
  assert.deepEqual(snapshot(outside), before.outside, 'nothing written outside');
  assert.deepEqual(snapshot(dest), before.dest);
  // A single listed file that is a link to a file elsewhere: refused too (a copy would write through it).
  fs.rmSync(path.join(dest, 'resources'));
  fs.mkdirSync(path.join(dest, 'resources'));
  fs.writeFileSync(path.join(dest, 'resources', 'app.asar'), 'stub');
  fs.rmSync(path.join(dest, 'aivenue.png'));
  fs.symlinkSync(path.join(outside, 'app.asar'), path.join(dest, 'aivenue.png'));
  r = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
  assert.notEqual(r.code, 0, r.out);
  assert.equal(fs.readFileSync(path.join(outside, 'app.asar'), 'utf8'), 'someone else');
  // Uninstall leaves the linked file alone as well.
  const u = t.run(path.join(dest, 'uninstall.sh'));
  assert.equal(u.code, 0, u.out);
  assert.equal(fs.readFileSync(path.join(outside, 'app.asar'), 'utf8'), 'someone else');
  t.done();
});

test('覆蓋安裝：0.2.4 以前的安裝只把舊版清單上的檔案當成 Aivenue 的；撞上新版新增檔名的使用者檔案時拒絕', { skip }, () => {
  const t = world();
  const legacy = path.join(t.w, 'legacy-apps');
  for (const f of LEGACY_FILES) {
    fs.mkdirSync(path.dirname(path.join(legacy, f)), { recursive: true });
    fs.copyFileSync(path.join(t.pkg, f), path.join(legacy, f));
  }
  fs.writeFileSync(path.join(legacy, 'my-notes.txt'), 'my precious notes');
  const v2 = path.join(t.w, 'v2');
  makePackage(v2, [...APP_FILES, 'my-notes.txt']);
  const before = snapshot(legacy);
  const r = t.run(path.join(v2, 'install.sh'), { AIVENUE_INSTALL_DIR: legacy });
  assert.notEqual(r.code, 0, r.out);
  assert.deepEqual(snapshot(legacy), before);
  // Without the clash the same folder takes the new version, and the notes stay.
  const ok = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: legacy });
  assert.equal(ok.code, 0, ok.out);
  assert.equal(fs.readFileSync(path.join(legacy, 'my-notes.txt'), 'utf8'), 'my precious notes');
  assert.equal(fs.readFileSync(path.join(legacy, 'aivenue'), 'utf8'), `stub aivenue pkg`);
  t.done();
});

test('覆蓋安裝：Aivenue 已移除、只剩使用者檔案的資料夾裡沒有東西算 Aivenue 的；撞名就拒絕', { skip }, () => {
  const t = world();
  const dest = path.join(t.w, 'apps');
  t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
  fs.writeFileSync(path.join(dest, 'my-notes.txt'), 'my precious notes');
  assert.equal(t.run(path.join(dest, 'uninstall.sh')).code, 0);
  const v2 = path.join(t.w, 'v2');
  makePackage(v2, [...APP_FILES, 'my-notes.txt']);
  const before = snapshot(dest);
  const r = t.run(path.join(v2, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
  assert.notEqual(r.code, 0, r.out);
  assert.deepEqual(snapshot(dest), before);
  // Uninstalling the already-removed folder again changes nothing.
  const u = t.run(path.join(t.pkg, 'uninstall.sh'), { AIVENUE_INSTALL_DIR: dest });
  assert.equal(u.code, 0, u.out);
  assert.deepEqual(snapshot(dest), before);
  t.done();
});

// ---------- An incomplete package never breaks the installed version; removals never follow a link outside ----------

const noStaging = (dest) => !fs.readdirSync(dest).some((n) => n.startsWith('.aivenue-staging'));

test('覆蓋安裝：新套件缺少或讀不到清單上的檔案（例如 app.asar）時，在動到舊版前拒絕，舊版仍完整可啟動', { skip }, () => {
  const t = world();
  const dest = path.join(t.w, 'apps');
  const v1 = path.join(t.w, 'v1');
  makePackage(v1);
  assert.equal(t.run(path.join(v1, 'install.sh'), { AIVENUE_INSTALL_DIR: dest }).code, 0);
  const before = { files: snapshot(dest), bin: t.linked() };
  // A half-extracted next version: its list names resources/app.asar, the file is not there.
  const v2 = path.join(t.w, 'v2');
  makePackage(v2);
  fs.rmSync(path.join(v2, 'resources/app.asar'));
  let r = t.run(path.join(v2, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /resources\/app\.asar \(missing or unreadable in the package/);
  assert.deepEqual(snapshot(dest), before.files, 'the old version is untouched');
  assert.equal(t.linked(), before.bin);
  // The old launcher still finds its app: the files the launcher runs are the v1 ones.
  assert.equal(fs.readFileSync(path.join(dest, 'resources/app.asar'), 'utf8'), 'stub resources/app.asar v1');
  assert.equal(fs.readFileSync(path.join(dest, 'aivenue'), 'utf8'), 'stub aivenue v1');
  // The same with a file that is there but cannot be read.
  makePackage(v2);
  fs.chmodSync(path.join(v2, 'resources/app.asar'), 0o000);
  r = t.run(path.join(v2, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
  fs.chmodSync(path.join(v2, 'resources/app.asar'), 0o644);
  if (process.getuid?.() !== 0) {
    assert.notEqual(r.code, 0, r.out);
    assert.deepEqual(snapshot(dest), before.files);
  }
  assert.ok(noStaging(dest));
  t.done();
});

test('覆蓋安裝：檢查通過後複製仍失敗（例如磁碟已滿）時，暫存的新檔案全部清掉，舊版不變', { skip }, () => {
  const t = world();
  const dest = path.join(t.w, 'apps');
  const v1 = path.join(t.w, 'v1');
  makePackage(v1);
  t.run(path.join(v1, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
  const before = snapshot(dest);
  // A `cp` that fails while staging app.asar, as a full disk would.
  const shim = path.join(t.w, 'shim');
  fs.mkdirSync(shim);
  fs.writeFileSync(path.join(shim, 'cp'), '#!/bin/sh\nfor a; do case "$a" in *.aivenue-staging*/resources/app.asar) echo "cp: No space left on device" >&2; exit 1 ;; esac; done\nexec /bin/cp "$@"\n', { mode: 0o755 });
  const r = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, PATH: `${shim}:${process.env.PATH}` });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /nothing was changed/);
  assert.deepEqual(snapshot(dest), before);
  assert.ok(noStaging(dest));
  // A fresh install that fails the same way leaves no folder behind.
  const fresh = path.join(t.w, 'fresh');
  const r2 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: fresh, PATH: `${shim}:${process.env.PATH}` });
  assert.notEqual(r2.code, 0, r2.out);
  assert.ok(!fs.existsSync(fresh));
  t.done();
});

test('覆蓋安裝成功：沒有留下暫存資料夾', { skip }, () => {
  const t = world();
  const dest = path.join(t.w, 'apps');
  t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
  assert.equal(t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest }).code, 0);
  assert.ok(noStaging(dest));
  t.done();
});

test('卸載與覆蓋安裝：上層資料夾是連到外部的連結時，外部的空子資料夾都還在', { skip }, () => {
  for (const link of ['resources', 'resources/app.asar.unpacked']) {
    const t = world();
    const dest = path.join(t.w, 'apps');
    t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
    // A folder elsewhere with the same (empty) subfolders as the package's.
    const outside = path.join(t.w, 'outside');
    const sub = link === 'resources' ? 'app.asar.unpacked/node_modules/x' : 'node_modules/x';
    fs.mkdirSync(path.join(outside, sub), { recursive: true });
    fs.rmSync(path.join(dest, link), { recursive: true });
    fs.symlinkSync(outside, path.join(dest, link));
    const dirs = () => fs.readdirSync(outside, { recursive: true }).sort();
    const before = dirs();
    const reinstall = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
    assert.notEqual(reinstall.code, 0, reinstall.out);
    assert.deepEqual(dirs(), before, `${link}: outside folders after the refused reinstall`);
    const u = t.run(path.join(dest, 'uninstall.sh'));
    assert.equal(u.code, 0, u.out);
    assert.deepEqual(dirs(), before, `${link}: outside folders after uninstall`);
    assert.ok(fs.existsSync(path.join(outside, sub)));
    t.done();
  }
});

/** A `mv` that fails on its Nth call (counted in a file), as a sudden permission or I/O error would. */
function failingMv(w) {
  const shim = path.join(w, 'mvshim');
  fs.mkdirSync(shim, { recursive: true });
  fs.writeFileSync(
    path.join(shim, 'mv'),
    '#!/bin/sh\nn=$(($(cat "$MV_COUNT" 2>/dev/null || echo 0) + 1)); echo $n > "$MV_COUNT"\n' +
      'if [ "$n" = "$MV_FAIL" ]; then echo "mv: Input/output error" >&2; exit 1; fi\nexec /bin/mv "$@"\n',
    { mode: 0o755 },
  );
  return (n, count) => ({ PATH: `${shim}:${process.env.PATH}`, MV_FAIL: String(n), MV_COUNT: count });
}
const pkgFiles = (pkg) => fs.readFileSync(path.join(pkg, LIST), 'utf8').trim().split('\n');
const sameAsPackage = (dest, pkg) => pkgFiles(pkg).every((f) => fs.existsSync(path.join(dest, f)) && fs.readFileSync(path.join(dest, f), 'utf8') === fs.readFileSync(path.join(pkg, f), 'utf8'));

test('首次安裝：逐檔換上時中途失敗（第一個檔案已就位、下一個 mv 失敗），移除故障後用同一指令重跑能完成安裝', { skip }, () => {
  // Every mv the install makes, one at a time: the first fails, the second (first file in place, next fails), … the last.
  for (let n = 1; ; n++) {
    const t = world();
    const dest = path.join(t.w, 'apps');
    const count = path.join(t.w, 'mv-count');
    const r1 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, ...failingMv(t.w)(n, count) });
    const calls = Number(fs.readFileSync(count, 'utf8'));
    if (r1.code === 0) {
      assert.ok(n > 3, 'the install makes several mv calls');
      t.done();
      break;
    }
    assert.match(r1.out, /run (the same )?install\.sh again/, `mv #${n}`);
    assert.equal(calls, n);
    const r2 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
    assert.equal(r2.code, 0, `mv #${n} failed, then the retry: ${r2.out}`);
    assert.ok(sameAsPackage(dest, t.pkg), `mv #${n}: every file in place after the retry`);
    assert.ok(noStaging(dest));
    assert.equal(t.linked(), path.join(dest, 'aivenue.sh'));
    assert.equal(fs.statSync(path.join(dest, 'aivenue')).mode & 0o111, 0o111, 'the launcher can be run');
    const u = t.run(path.join(dest, 'uninstall.sh'));
    assert.equal(u.code, 0, u.out);
    assert.ok(!fs.existsSync(dest), `mv #${n}: uninstall after the retry removes the folder`);
    t.done();
  }
});

test('覆蓋安裝：逐檔換上時中途失敗，重跑後完成；使用者檔案保留，舊版才有的檔案移除；未重跑直接卸載也只刪 Aivenue 的檔案', { skip }, () => {
  const total = (() => {
    const t = world();
    const dest = path.join(t.w, 'apps');
    t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
    const count = path.join(t.w, 'mv-count');
    t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, ...failingMv(t.w)(0, count) });
    const n = Number(fs.readFileSync(count, 'utf8'));
    t.done();
    return n;
  })();
  for (const n of [1, 2, Math.ceil(total / 2), total - 1, total]) {
    for (const then of ['retry', 'uninstall']) {
      const t = world();
      const dest = path.join(t.w, 'apps');
      const v1 = path.join(t.w, 'v1');
      makePackage(v1, [...APP_FILES, 'resources/old-only.bin']);
      assert.equal(t.run(path.join(v1, 'install.sh'), { AIVENUE_INSTALL_DIR: dest }).code, 0);
      const kept = userFiles(dest);
      const count = path.join(t.w, 'mv-count');
      const r1 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, ...failingMv(t.w)(n, count) });
      assert.notEqual(r1.code, 0, `mv #${n}: ${r1.out}`);
      if (then === 'retry') {
        const r2 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
        assert.equal(r2.code, 0, `mv #${n}: ${r2.out}`);
        assert.ok(sameAsPackage(dest, t.pkg), `mv #${n}`);
        assert.ok(!fs.existsSync(path.join(dest, 'resources/old-only.bin')), `mv #${n}: the old version's own file is removed`);
        assert.ok(noStaging(dest));
      } else {
        const u = t.run(path.join(dest, 'uninstall.sh'));
        assert.equal(u.code, 0, `mv #${n}: ${u.out}`);
        assert.ok(appGone(dest) && !fs.existsSync(path.join(dest, 'resources/old-only.bin')), `mv #${n}: no Aivenue file left`);
        assert.ok(noStaging(dest));
      }
      assert.ok(kept(), `mv #${n} then ${then}: the user's files`);
      assert.ok(t.dataKept());
      t.done();
    }
  }
});

/**
 * Faults for install.sh / uninstall.sh, set per run through the environment:
 *   MV_KILL=n      the nth `mv` kills the script with SIGKILL (as `kill -9` or a power cut would), MV_COUNT counts
 *   CP_KILL=path   copying that package file kills the script
 *   RM_FAIL=path   removing that file fails (as a permission error would)
 *   SHA_FAIL=file  hashing that file fails with a read error, printing nothing (its full real path)
 *   MV_FAIL_ONCE=name  the first rename that would put a file named that in place fails (MV_FAILED: a flag file)
 */
function faults(w) {
  const dir = path.join(w, 'faults');
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, body) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  write('mv', [
    'if [ -n "$MV_KILL" ]; then n=$(($(cat "$MV_COUNT" 2>/dev/null || echo 0) + 1)); echo $n > "$MV_COUNT"; [ "$n" = "$MV_KILL" ] && kill -9 $PPID && sleep 1; fi',
    // MV_KILL_AFTER=name: do the rename, then kill the script when it put a file named that in place.
    'if [ -n "$MV_KILL_AFTER" ]; then for a; do last="$a"; done; /bin/mv "$@"; s=$?; case "$last" in */"$MV_KILL_AFTER") kill -9 $PPID; sleep 1 ;; esac; exit $s; fi',
    // MV_KILL_BEFORE=name: kill the script just before it would put a file named that in place (the move not done).
    'if [ -n "$MV_KILL_BEFORE" ]; then for a; do last="$a"; done; case "$last" in */"$MV_KILL_BEFORE") pkill -KILL -f -- "$KILL_TARGET"; sleep 1; exit 1 ;; esac; fi',
    'if [ -n "$MV_FAIL_ONCE" ] && [ ! -e "$MV_FAILED" ]; then for a; do last="$a"; done; case "$last" in */"$MV_FAIL_ONCE") : > "$MV_FAILED"; echo "mv: Input/output error" >&2; exit 1 ;; esac; fi',
    'exec /bin/mv "$@"',
  ].join('\n'));
  // SHA_KILL=n: the nth sha256sum kills the whole script (KILL_TARGET: its path; subshells included).
  write('sha256sum', `if [ -n "$SHA_FAIL" ] && [ "$(readlink -f /proc/self/fd/0)" = "$SHA_FAIL" ]; then echo "sha256sum: -: Input/output error" >&2; exit 1; fi\nif [ -n "$SHA_KILL" ]; then n=$(($(cat "$SHA_COUNT" 2>/dev/null || echo 0) + 1)); echo $n > "$SHA_COUNT"; [ "$n" = "$SHA_KILL" ] && pkill -KILL -f -- "$KILL_TARGET" && sleep 1; fi\nexec ${spawnSync('sh', ['-c', 'command -v sha256sum'], { encoding: 'utf8' }).stdout.trim()} "$@"`);
  write('cp', 'if [ -n "$CP_KILL" ]; then for a; do case "$a" in */.aivenue-staging.*/"$CP_KILL") kill -9 $PPID; sleep 1 ;; esac; done; fi\nexec /bin/cp "$@"');
  write('rm', 'if [ -n "$RM_FAIL" ]; then for a; do case "$a" in */"$RM_FAIL") echo "rm: cannot remove \'$a\': Operation not permitted" >&2; exit 1 ;; esac; done; fi\nexec /bin/rm "$@"');
  return (env) => ({ PATH: `${dir}:${process.env.PATH}`, ...env });
}
/** Rewrite the plan in `dest` as a complete one (header … `end <SHA-256 of the lines before>`), its lines changed by `edit`. */
function writePlan(dest, edit) {
  const p = path.join(dest, '.aivenue-pending');
  const lines = fs.readFileSync(p, 'utf8').trimEnd().split('\n').slice(0, -1);
  const body = edit(lines).join('\n') + '\n';
  fs.writeFileSync(p, `${body}end ${createHash('sha256').update(body).digest('hex')}\n`);
}
/** Staging folders the installer makes (other folders with the same prefix are the user's). */
const ourStaging = (dest) => fs.readdirSync(dest).filter((n) => /^\.aivenue-staging\.[0-9a-f]{16}$/.test(n));
const installedClean = (dest, pkg) => sameAsPackage(dest, pkg) && ourStaging(dest).length === 0 && !fs.existsSync(path.join(dest, '.aivenue-pending')) && fs.existsSync(path.join(dest, '.aivenue-install'));
/** A user's file with bytes that are not text, and a check that they are still exactly these bytes. */
function keepBytes(file) {
  const bytes = Buffer.from([0, 1, 2, 255, 254, 10, 13, 0x41, 0xe4, 0xbd, 0xa0]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return () => fs.existsSync(file) && Buffer.compare(fs.readFileSync(file), bytes) === 0;
}

test('首次安裝被 kill -9 中止（暫存複製時或逐檔換上時的每一步）：重跑同一指令完成；或直接卸載，資料夾整個移除', { skip }, () => {
  const cases = [{ CP_KILL: 'resources/app.asar' }];
  for (let n = 1; n <= 12; n++) cases.push({ MV_KILL: String(n) });
  for (const fault of cases) {
    for (const then of ['retry', 'uninstall']) {
      const t = world();
      const dest = path.join(t.w, 'apps');
      const r1 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, ...faults(t.w)({ MV_COUNT: path.join(t.w, 'n'), ...fault }) });
      const label = `${JSON.stringify(fault)} then ${then}`;
      if (r1.code === 0) { t.done(); continue; } // the install had fewer steps than this
      assert.equal(r1.code, null, `${label}: killed`);
      if (then === 'retry') {
        const r2 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
        assert.equal(r2.code, 0, `${label}: ${r2.out}`);
        assert.ok(installedClean(dest, t.pkg), label);
        assert.equal(t.linked(), path.join(dest, 'aivenue.sh'));
      } else {
        const u = t.run(path.join(t.pkg, 'uninstall.sh'), { AIVENUE_INSTALL_DIR: dest });
        assert.equal(u.code, 0, `${label}: ${u.out}`);
        assert.ok(!fs.existsSync(dest), `${label}: nothing of Aivenue (or its staging folder) is left`);
      }
      t.done();
    }
  }
});

test('覆蓋安裝被 kill -9 中止：重跑完成，或直接卸載只移除 Aivenue 的檔案；使用者檔案逐位元組保留', { skip }, () => {
  for (const fault of [{ CP_KILL: 'resources/app.asar' }, { MV_KILL: '1' }, { MV_KILL: '5' }, { MV_KILL: '10' }]) {
    for (const then of ['retry', 'uninstall']) {
      const t = world();
      const dest = path.join(t.w, 'apps');
      const v1 = path.join(t.w, 'v1');
      makePackage(v1, [...APP_FILES, 'resources/old-only.bin']);
      assert.equal(t.run(path.join(v1, 'install.sh'), { AIVENUE_INSTALL_DIR: dest }).code, 0);
      const kept = userFiles(dest);
      const bytes = keepBytes(path.join(dest, 'data/blob.bin'));
      const label = `${JSON.stringify(fault)} then ${then}`;
      const r1 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, ...faults(t.w)({ MV_COUNT: path.join(t.w, 'n'), ...fault }) });
      assert.equal(r1.code, null, `${label}: killed (${r1.out})`);
      if (then === 'retry') {
        const r2 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
        assert.equal(r2.code, 0, `${label}: ${r2.out}`);
        assert.ok(installedClean(dest, t.pkg), label);
        assert.ok(!fs.existsSync(path.join(dest, 'resources/old-only.bin')), `${label}: the old version's own file is removed`);
      } else {
        const u = t.run(path.join(t.pkg, 'uninstall.sh'), { AIVENUE_INSTALL_DIR: dest });
        assert.equal(u.code, 0, `${label}: ${u.out}`);
        assert.ok(appGone(dest) && !fs.existsSync(path.join(dest, 'resources/old-only.bin')), `${label}: no Aivenue file left`);
        assert.equal(ourStaging(dest).length, 0, `${label}: the recorded staging folder is removed`);
        assert.ok(!fs.existsSync(path.join(dest, '.aivenue-pending')));
      }
      assert.ok(kept() && bytes(), `${label}: the user's files`);
      assert.ok(t.dataKept());
      t.done();
    }
  }
});

test('名稱以 .aivenue-staging. 開頭的使用者資料夾：正常覆蓋安裝、中斷後重試、卸載後都逐位元組保留', { skip }, () => {
  const t = world();
  const dest = path.join(t.w, 'apps');
  assert.equal(t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest }).code, 0);
  const backup = keepBytes(path.join(dest, '.aivenue-staging.personal-backup/history'));
  // Even one named exactly like the installer's own (16 hex digits), when no install recorded it.
  const lookalike = keepBytes(path.join(dest, '.aivenue-staging.0123456789abcdef/notes'));
  const both = () => backup() && lookalike();
  let r = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
  assert.equal(r.code, 0, r.out);
  assert.ok(both(), 'after a reinstall');
  r = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, ...faults(t.w)({ MV_COUNT: path.join(t.w, 'n'), MV_KILL: '3' }) });
  assert.equal(r.code, null);
  assert.ok(both(), 'after an install that was killed');
  r = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
  assert.equal(r.code, 0, r.out);
  assert.ok(both(), 'after the retry');
  // A plan that names the look-alike folder (but not with an id it holds) does not make it the installer's either:
  // a real plan from a stopped reinstall, its staging entry pointing at the look-alike.
  r = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, ...faults(t.w)({ CP_KILL: 'resources/app.asar' }) });
  assert.equal(r.code, null);
  writePlan(dest, (lines) => lines.map((l, i) => (i === 1 ? 'stage .aivenue-staging.0123456789abcdef ffffffffffffffff' : l)));
  const u = t.run(path.join(dest, 'uninstall.sh'));
  assert.equal(u.code, 0, u.out);
  assert.ok(both(), 'after uninstall');
  assert.ok(appGone(dest));
  t.done();
});

test('中斷後、重試前，使用者在新版還沒寫入的位置放了同名檔案：重跑拒絕且不覆蓋，直接卸載也不刪；移走後重跑完成', { skip }, () => {
  const v2 = [...APP_FILES, 'resources/new-in-v2.bin'];
  for (const start of ['fresh', 'upgrade']) {
    for (const then of ['retry', 'uninstall']) {
      const t = world();
      const dest = path.join(t.w, 'apps');
      makePackage(t.pkg, v2);
      if (start === 'upgrade') {
        makePackage(path.join(t.w, 'v1'));
        assert.equal(t.run(path.join(t.w, 'v1/install.sh'), { AIVENUE_INSTALL_DIR: dest }).code, 0);
      }
      const label = `${start} then ${then}`;
      // Stopped right after the first file is in place (the second mv fails).
      const r1 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, ...failingMv(t.w)(2, path.join(t.w, 'n')) });
      assert.notEqual(r1.code, 0, label);
      assert.ok(!fs.existsSync(path.join(dest, 'resources/new-in-v2.bin')), `${label}: not written yet`);
      const mine = keepBytes(path.join(dest, 'resources/new-in-v2.bin'));
      if (then === 'retry') {
        const r2 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
        assert.notEqual(r2.code, 0, `${label}: ${r2.out}`);
        assert.match(r2.out, /resources\/new-in-v2\.bin \(already there and not an Aivenue file\)/);
        assert.ok(mine(), `${label}: not overwritten`);
        fs.renameSync(path.join(dest, 'resources/new-in-v2.bin'), path.join(t.w, 'moved-away.bin'));
        const r3 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
        assert.equal(r3.code, 0, `${label}: ${r3.out}`);
        assert.ok(installedClean(dest, t.pkg), label);
      } else {
        const u = t.run(path.join(t.pkg, 'uninstall.sh'), { AIVENUE_INSTALL_DIR: dest });
        assert.equal(u.code, 0, `${label}: ${u.out}`);
        assert.ok(mine(), `${label}: not removed`);
        assert.ok(appGone(dest), `${label}: Aivenue's files are`);
      }
      t.done();
    }
  }
});

test('卸載時有套件檔案刪不掉：回報失敗（非 0），紀錄保留；排除故障後用同一指令重跑完成卸載', { skip }, () => {
  for (const stuck of ['resources/app.asar', 'uninstall.sh', '.aivenue-files']) {
    const t = world();
    const dest = path.join(t.w, 'apps');
    assert.equal(t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest }).code, 0);
    const kept = userFiles(dest);
    const u1 = t.run(path.join(dest, 'uninstall.sh'), faults(t.w)({ RM_FAIL: stuck }));
    assert.notEqual(u1.code, 0, `${stuck}: ${u1.out}`);
    assert.match(u1.out, new RegExp(`Could not remove these Aivenue files[^]*  ${stuck.replace(/\./g, '\\.')}`));
    assert.ok(fs.existsSync(path.join(dest, stuck)));
    const list = fs.readFileSync(path.join(dest, LIST), 'utf8').split('\n');
    assert.ok(list.includes(stuck) && list.includes(LIST), `${stuck}: the list keeps what is left`);
    assert.ok(fs.existsSync(path.join(dest, 'uninstall.sh')), `${stuck}: uninstall.sh is kept to run again`);
    assert.ok(kept());
    // The same command again, fault fixed.
    const u2 = t.run(path.join(dest, 'uninstall.sh'));
    assert.equal(u2.code, 0, `${stuck}: ${u2.out}`);
    assert.ok(appGone(dest) && kept(), stuck);
    assert.ok(!fs.existsSync(path.join(dest, 'locales')) && !fs.existsSync(path.join(dest, 'resources/app.asar.unpacked')), `${stuck}: no empty Aivenue folders left`);
    assert.ok(t.shortcutsGone());
    t.done();
  }
});

test('覆蓋安裝時舊版才有的檔案刪不掉：安裝完成並提示，檔案留在清單上，之後卸載會移除', { skip }, () => {
  const t = world();
  const dest = path.join(t.w, 'apps');
  const v1 = path.join(t.w, 'v1');
  makePackage(v1, [...APP_FILES, 'resources/old-only.bin']);
  assert.equal(t.run(path.join(v1, 'install.sh'), { AIVENUE_INSTALL_DIR: dest }).code, 0);
  const r = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, ...faults(t.w)({ RM_FAIL: 'resources/old-only.bin' }) });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Could not remove these files of the old version[^]*resources\/old-only\.bin/);
  assert.ok(fs.readFileSync(path.join(dest, LIST), 'utf8').split('\n').includes('resources/old-only.bin'));
  assert.equal(t.run(path.join(dest, 'uninstall.sh')).code, 0);
  assert.ok(!fs.existsSync(dest));
  t.done();
});

/** An install from before the file list (0.2.4 and earlier) in `dest`: the legacy package's files, no marker, no list. */
function legacyInstall(t, dest) {
  const old = path.join(t.w, 'old');
  makePackage(old, LEGACY_FILES.filter((f) => !['install.sh', 'uninstall.sh'].includes(f)));
  for (const f of LEGACY_FILES) {
    fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
    fs.copyFileSync(path.join(old, f), path.join(dest, f));
  }
}
const sha = (file) => (fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'missing');
/** SHA-256 of every file under the given paths in `dir` (the user's files), to compare before and after. */
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
const USER_RELS = ['data', 'notes.txt', 'resources/my-theme.css', 'blob.bin'];

test('回歸 1：從沒有清單的 0.2.4 升級，換檔途中被 kill -9；重跑同一指令完成升級，使用者檔案與歷史的雜湊不變', { skip }, () => {
  for (let n = 1; n <= 12; n++) {
    const t = world();
    const dest = path.join(t.w, 'apps');
    legacyInstall(t, dest);
    userFiles(dest);
    keepBytes(path.join(dest, 'blob.bin'));
    const before = { user: treeSha(dest, USER_RELS), home: treeSha(t.home, ['.aivenue']) };
    const r1 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, ...faults(t.w)({ MV_COUNT: path.join(t.w, 'n'), MV_KILL: String(n) }) });
    if (r1.code === 0) { t.done(); continue; }
    assert.equal(r1.code, null, `mv #${n}: killed`);
    const r2 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
    assert.equal(r2.code, 0, `mv #${n}: ${r2.out}`);
    assert.ok(installedClean(dest, t.pkg), `mv #${n}`);
    assert.equal(treeSha(dest, USER_RELS), before.user, `mv #${n}: user files`);
    assert.equal(treeSha(t.home, ['.aivenue']), before.home, `mv #${n}: history (~/.aivenue)`);
    t.done();
  }
});

test('回歸 2：首次安裝換檔途中中止，第二次執行在寫好清單後再中止；第三次同一指令完成，兩次中止都在預定位置', { skip }, () => {
  for (const first of [2, 4, 6]) {
    const t = world();
    const dest = path.join(t.w, 'apps');
    const f = faults(t.w);
    const label = `first kill at mv #${first}`;
    const r1 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, ...f({ MV_COUNT: path.join(t.w, 'n1'), MV_KILL: String(first) }) });
    assert.equal(r1.code, null, `${label}: killed`);
    // Where: while files were being put in place — the plan is there, no file list yet, not every file is new.
    assert.ok(fs.existsSync(path.join(dest, '.aivenue-pending')), `${label}: plan written`);
    assert.ok(!fs.existsSync(path.join(dest, LIST)), `${label}: no list yet`);
    assert.ok(!sameAsPackage(dest, t.pkg), `${label}: stopped half way`);
    const r2 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, ...f({ MV_KILL_AFTER: LIST }) });
    assert.equal(r2.code, null, `${label}: second run killed`);
    // Where: right after a file list was put in place, the install not finished.
    assert.ok(fs.existsSync(path.join(dest, LIST)), `${label}: second run stopped after writing the list`);
    assert.ok(fs.existsSync(path.join(dest, '.aivenue-pending')), `${label}: not finished`);
    const r3 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
    assert.equal(r3.code, 0, `${label}: ${r3.out}`);
    assert.ok(installedClean(dest, t.pkg), label);
    t.done();
  }
});

test('回歸 3：升級中斷後，使用者在清單路徑放了自己的 .aivenue-files；重跑安裝列出衝突並保留，直接卸載也保留，其他使用者資料雜湊不變', { skip }, () => {
  // The user's own file at that path; it even names the user's files, so taking it for Aivenue's would remove them.
  const theirs = 'notes.txt\ndata/runs/r1/run.json\nresources/my-theme.css\nblob.bin\n';
  for (const stop of [{ CP_KILL: 'resources/app.asar' }, { MV_KILL: '5' }]) {
    for (const then of ['retry', 'uninstall']) {
      const t = world();
      const dest = path.join(t.w, 'apps');
      legacyInstall(t, dest);
      userFiles(dest);
      keepBytes(path.join(dest, 'blob.bin'));
      const label = `${JSON.stringify(stop)} then ${then}`;
      const r1 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, ...faults(t.w)({ MV_COUNT: path.join(t.w, 'n'), ...stop }) });
      assert.equal(r1.code, null, `${label}: killed`);
      fs.writeFileSync(path.join(dest, LIST), theirs);
      const before = { list: sha(path.join(dest, LIST)), user: treeSha(dest, USER_RELS), home: treeSha(t.home, ['.aivenue']) };
      if (then === 'retry') {
        const r2 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
        assert.notEqual(r2.code, 0, `${label}: refused (${r2.out})`);
        assert.match(r2.out, /^ {2}\.aivenue-files \(/m, `${label}: the conflict is listed`);
      } else {
        const u = t.run(path.join(t.pkg, 'uninstall.sh'), { AIVENUE_INSTALL_DIR: dest });
        assert.match(u.out, /\.aivenue-files/, `${label}: the kept list is reported (${u.out})`);
      }
      assert.equal(sha(path.join(dest, LIST)), before.list, `${label}: the user's .aivenue-files`);
      assert.equal(treeSha(dest, USER_RELS), before.user, `${label}: other user files`);
      assert.equal(treeSha(t.home, ['.aivenue']), before.home, `${label}: ~/.aivenue`);
      t.done();
    }
  }
});

test('完成的安裝裡，.aivenue-files 被換成使用者自己的檔案：重裝列出衝突並停止，卸載拒絕；所有檔案都保留', { skip }, () => {
  const t = world();
  const dest = path.join(t.w, 'apps');
  assert.equal(t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest }).code, 0);
  userFiles(dest);
  fs.writeFileSync(path.join(dest, LIST), 'notes.txt\ndata/runs/r1/run.json\n');
  const before = snapshot(dest);
  const r = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /^ {2}\.aivenue-files \(not written by this installer/m);
  assert.deepEqual(snapshot(dest), before, 'nothing changed by the refused reinstall');
  const u = t.run(path.join(dest, 'uninstall.sh'));
  assert.notEqual(u.code, 0, u.out);
  assert.match(u.out, /not written by the installer/);
  assert.deepEqual(snapshot(dest), before, 'nothing removed by the refused uninstall');
  t.done();
});

test('同一次安裝被連續中止三次（每次停在不同位置），第四次同一指令完成；首次安裝、有清單的升級、0.2.4 升級都一樣', { skip }, () => {
  for (const start of ['fresh', 'upgrade', 'legacy']) {
    for (const kills of [[1, 1, 1], [3, 2, 5], [6, 4, 2], [9, 7, 3]]) {
      const t = world();
      const dest = path.join(t.w, 'apps');
      if (start === 'upgrade') {
        makePackage(path.join(t.w, 'v1'), [...APP_FILES, 'resources/old-only.bin']);
        assert.equal(t.run(path.join(t.w, 'v1/install.sh'), { AIVENUE_INSTALL_DIR: dest }).code, 0);
      }
      if (start === 'legacy') legacyInstall(t, dest);
      if (start !== 'fresh') userFiles(dest);
      const user = treeSha(dest, USER_RELS);
      const f = faults(t.w);
      kills.forEach((n, i) => t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, ...f({ MV_COUNT: path.join(t.w, `n${i}`), MV_KILL: String(n) }) }));
      const label = `${start}, kills ${kills.join('/')}`;
      const r = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
      assert.equal(r.code, 0, `${label}: ${r.out}`);
      assert.ok(installedClean(dest, t.pkg), label);
      assert.ok(!fs.existsSync(path.join(dest, 'resources/old-only.bin')), `${label}: old-only file removed`);
      assert.equal(treeSha(dest, USER_RELS), user, `${label}: user files`);
      t.done();
    }
  }
});

test('回歸 4：從 0.2.4 升級中斷後（已有計畫、還沒有標記），使用者在舊版清單上的路徑放了自己的檔案；重跑與直接卸載都不再用舊版清單認領，使用者檔案 SHA-256 不變', { skip }, () => {
  for (const stop of [{ CP_KILL: 'resources/app.asar' }, { MV_KILL: '5' }]) {
    for (const then of ['retry', 'uninstall']) {
      const t = world();
      // The legacy list also names a path the 0.2.4 install does not have (like a newer build's file).
      fs.appendFileSync(path.join(t.pkg, LEGACY), 'locales/af.pak\n');
      const dest = path.join(t.w, 'apps');
      legacyInstall(t, dest);
      userFiles(dest);
      const label = `${JSON.stringify(stop)} then ${then}`;
      const r1 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, ...faults(t.w)({ MV_COUNT: path.join(t.w, 'n'), ...stop }) });
      assert.equal(r1.code, null, `${label}: killed`);
      assert.ok(fs.existsSync(path.join(dest, '.aivenue-pending')) && !fs.existsSync(path.join(dest, '.aivenue-install')), `${label}: plan there, no marker`);
      // The user's own files: one at a path of the 0.2.4 install that the new version also has (content matches no
      // record), one at a path only the legacy list names (no record at all).
      const mine = { 'locales/en-US.pak': keepBytes(path.join(dest, 'locales/en-US.pak')), 'locales/af.pak': keepBytes(path.join(dest, 'locales/af.pak')) };
      const before = { user: treeSha(dest, [...USER_RELS, 'locales/en-US.pak', 'locales/af.pak']), home: treeSha(t.home, ['.aivenue']) };
      if (then === 'retry') {
        const r2 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
        assert.notEqual(r2.code, 0, `${label}: refused (${r2.out})`);
        assert.match(r2.out, /^ {2}locales\/en-US\.pak \(already there and not an Aivenue file\)/m, label);
        assert.equal(treeSha(dest, [...USER_RELS, 'locales/en-US.pak', 'locales/af.pak']), before.user, `${label}: nothing of the user's changed`);
        // The user moves the conflicting file away: the recorded Aivenue files upgrade normally; af.pak stays.
        fs.renameSync(path.join(dest, 'locales/en-US.pak'), path.join(t.w, 'moved.pak'));
        const r3 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest });
        assert.equal(r3.code, 0, `${label}: ${r3.out}`);
        assert.ok(installedClean(dest, t.pkg), `${label}: upgraded`);
        assert.ok(mine['locales/af.pak'](), `${label}: af.pak kept`);
      } else {
        const u = t.run(path.join(t.pkg, 'uninstall.sh'), { AIVENUE_INSTALL_DIR: dest });
        assert.equal(u.code, 0, `${label}: ${u.out}`);
        assert.ok(mine['locales/en-US.pak']() && mine['locales/af.pak'](), `${label}: the user's files kept`);
        assert.equal(treeSha(dest, [...USER_RELS, 'locales/en-US.pak', 'locales/af.pak']), before.user, label);
        assert.ok(APP_FILES.filter((f) => f !== 'locales/en-US.pak').every((f) => !fs.existsSync(path.join(dest, f))), `${label}: the recorded Aivenue files removed`);
      }
      assert.equal(treeSha(t.home, ['.aivenue']), before.home, `${label}: ~/.aivenue`);
      t.done();
    }
  }
});

test('回歸 4b：已完成的安裝在覆蓋安裝途中被中止，使用者改寫了舊版清單上的檔案；重跑不刪它，卸載也不刪它', { skip }, () => {
  for (const then of ['retry', 'uninstall']) {
    const t = world();
    const dest = path.join(t.w, 'apps');
    makePackage(path.join(t.w, 'v1'), [...APP_FILES, 'resources/old-only.bin']);
    assert.equal(t.run(path.join(t.w, 'v1/install.sh'), { AIVENUE_INSTALL_DIR: dest }).code, 0);
    const r1 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, ...faults(t.w)({ CP_KILL: 'resources/app.asar' }) });
    assert.equal(r1.code, null, then);
    // The old version's own file, now the user's (its content matches no record).
    const mine = keepBytes(path.join(dest, 'resources/old-only.bin'));
    const r2 = then === 'retry'
      ? t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest })
      : t.run(path.join(t.pkg, 'uninstall.sh'), { AIVENUE_INSTALL_DIR: dest });
    assert.equal(r2.code, 0, `${then}: ${r2.out}`);
    assert.ok(mine(), `${then}: the user's file kept`);
    if (then === 'retry') assert.ok(installedClean(dest, t.pkg), then);
    else assert.ok(appGone(dest), then);
    t.done();
  }
});

/** The 0.2.4 program files in `dest` are still exactly the old package's. */
const oldProgramIntact = (t, dest) => ['aivenue', 'aivenue.sh', 'resources/app.asar'].every((f) => sha(path.join(dest, f)) === sha(path.join(t.w, 'old', f)));

test('回歸 5：從 0.2.4 升級時在寫計畫途中（第一次換程式檔之前）被 kill -9；重跑完成、直接卸載完整移除，舊版程式未被動過，使用者檔案 SHA-256 不變', { skip }, () => {
  const stops = [{ SHA_KILL: '1' }, { SHA_KILL: '4' }, { SHA_KILL: '9' }, { SHA_KILL: '15' }, { MV_KILL_BEFORE: '.aivenue-pending' }];
  for (const stop of stops) {
    for (const then of ['retry', 'uninstall']) {
      const t = world();
      const dest = path.join(t.w, 'apps');
      legacyInstall(t, dest);
      userFiles(dest);
      const label = `${JSON.stringify(stop)} then ${then}`;
      const before = { user: treeSha(dest, USER_RELS), home: treeSha(t.home, ['.aivenue']) };
      const r1 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, ...faults(t.w)({ SHA_COUNT: path.join(t.w, 'n'), KILL_TARGET: path.join(t.pkg, 'install.sh'), ...stop }) });
      assert.equal(r1.code, null, `${label}: killed (${r1.out})`);
      assert.ok(oldProgramIntact(t, dest), `${label}: no program file replaced yet`);
      assert.ok(!fs.existsSync(path.join(dest, '.aivenue-pending')), `${label}: no plan published`);
      const r2 = then === 'retry'
        ? t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest })
        : t.run(path.join(t.pkg, 'uninstall.sh'), { AIVENUE_INSTALL_DIR: dest });
      assert.equal(r2.code, 0, `${label}: ${r2.out}`);
      if (then === 'retry') assert.ok(installedClean(dest, t.pkg), label);
      else assert.ok(LEGACY_FILES.every((f) => !fs.existsSync(path.join(dest, f))), `${label}: the whole 0.2.4 install removed`);
      assert.ok(fs.readdirSync(dest).every((n) => !/^\.aivenue-(pending|files)\.[A-Za-z0-9]{6}$/.test(n)), `${label}: no record left half-written`);
      assert.equal(treeSha(dest, USER_RELS), before.user, `${label}: user files`);
      assert.equal(treeSha(t.home, ['.aivenue']), before.home, `${label}: ~/.aivenue`);
      t.done();
    }
  }
});

test('回歸 5b：計畫被截斷（寫到一半的 .aivenue-pending）時，重跑安裝和直接卸載都停止並說明，不刪也不改任何檔案', { skip }, () => {
  for (const then of ['retry', 'uninstall']) {
    const t = world();
    const dest = path.join(t.w, 'apps');
    legacyInstall(t, dest);
    userFiles(dest);
    // A plan written straight into place and cut off part way, as an older candidate could leave it.
    const lines = ['aivenue-pending 2', 'stage .aivenue-staging.0123456789abcdef 0123456789abcdef', `old ${sha(path.join(dest, 'aivenue'))}  aivenue`, `old ${sha(path.join(dest, 'aivenue.sh'))}  aivenue.s`];
    fs.writeFileSync(path.join(dest, '.aivenue-pending'), lines.join('\n'));
    const before = snapshot(dest);
    const r = then === 'retry'
      ? t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest })
      : t.run(path.join(t.pkg, 'uninstall.sh'), { AIVENUE_INSTALL_DIR: dest });
    assert.notEqual(r.code, 0, `${then}: ${r.out}`);
    assert.match(r.out, /not a complete record/, then);
    assert.deepEqual(snapshot(dest), before, `${then}: nothing changed`);
    t.done();
  }
});

test('回歸 6：從 0.2.4 升級中斷後重跑，重跑又在寫新計畫途中被 kill -9；上一份完整計畫原封不動，第三次重跑或直接卸載都正常', { skip }, () => {
  const stops = [{ SHA_KILL: '3' }, { SHA_KILL: '12' }, { SHA_KILL: '25' }, { MV_KILL_BEFORE: '.aivenue-pending' }];
  for (const stop of stops) {
    for (const then of ['retry', 'uninstall']) {
      const t = world();
      const dest = path.join(t.w, 'apps');
      legacyInstall(t, dest);
      userFiles(dest);
      const before = { user: treeSha(dest, USER_RELS), home: treeSha(t.home, ['.aivenue']) };
      const label = `${JSON.stringify(stop)} then ${then}`;
      const f = faults(t.w);
      assert.equal(t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, ...f({ MV_COUNT: path.join(t.w, 'm'), MV_KILL: '5' }) }).code, null, label);
      const plan1 = sha(path.join(dest, '.aivenue-pending'));
      assert.notEqual(plan1, 'missing', `${label}: a complete plan after the first stop`);
      const r2 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, ...f({ SHA_COUNT: path.join(t.w, 'n'), KILL_TARGET: path.join(t.pkg, 'install.sh'), ...stop }) });
      assert.equal(r2.code, null, `${label}: the retry killed (${r2.out})`);
      assert.equal(sha(path.join(dest, '.aivenue-pending')), plan1, `${label}: the previous complete plan is untouched`);
      const r3 = then === 'retry'
        ? t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest })
        : t.run(path.join(t.pkg, 'uninstall.sh'), { AIVENUE_INSTALL_DIR: dest });
      assert.equal(r3.code, 0, `${label}: ${r3.out}`);
      if (then === 'retry') assert.ok(installedClean(dest, t.pkg), label);
      else assert.ok(LEGACY_FILES.concat(APP_FILES).every((x) => !fs.existsSync(path.join(dest, x))), `${label}: Aivenue's files removed`);
      assert.equal(treeSha(dest, USER_RELS), before.user, `${label}: user files`);
      assert.equal(treeSha(t.home, ['.aivenue']), before.home, `${label}: ~/.aivenue`);
      t.done();
    }
  }
});

test('回歸 7：從 0.2.4 升級時舊檔或新檔的 SHA-256 讀取失敗（再加第一次換檔失敗）；在換任何程式檔前停止、不發布計畫，排除故障後重跑完成、直接卸載完整移除', { skip }, () => {
  for (const which of ['old aivenue', 'old resources/app.asar', 'new aivenue', 'new resources/app.asar']) {
    for (const then of ['retry', 'uninstall']) {
      const t = world();
      const dest = path.join(t.w, 'apps');
      legacyInstall(t, dest);
      userFiles(dest);
      const label = `${which} then ${then}`;
      const before = { user: treeSha(dest, USER_RELS), home: treeSha(t.home, ['.aivenue']) };
      const [side, rel] = which.split(' ');
      const failing = fs.realpathSync(path.join(side === 'old' ? dest : t.pkg, rel));
      const r1 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, ...faults(t.w)({ SHA_FAIL: failing, MV_FAIL_ONCE: 'aivenue', MV_FAILED: path.join(t.w, 'mvf') }) });
      assert.equal(r1.code, 1, `${label}: reported (${r1.out})`);
      assert.match(r1.out, /could not be read to record its SHA-256[\s\S]*nothing was changed/, label);
      assert.ok(oldProgramIntact(t, dest), `${label}: no program file replaced`);
      assert.ok(!fs.existsSync(path.join(dest, '.aivenue-pending')), `${label}: no plan published`);
      assert.equal(treeSha(dest, USER_RELS), before.user, `${label}: user files after the failed run`);
      const r2 = then === 'retry'
        ? t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest })
        : t.run(path.join(t.pkg, 'uninstall.sh'), { AIVENUE_INSTALL_DIR: dest });
      assert.equal(r2.code, 0, `${label}: ${r2.out}`);
      if (then === 'retry') assert.ok(installedClean(dest, t.pkg), label);
      else assert.ok(LEGACY_FILES.every((f) => !fs.existsSync(path.join(dest, f))), `${label}: the whole 0.2.4 install removed`);
      assert.equal(treeSha(dest, USER_RELS), before.user, `${label}: user files`);
      assert.equal(treeSha(t.home, ['.aivenue']), before.home, `${label}: ~/.aivenue`);
      t.done();
    }
  }
});

test('回歸 7（已有完整計畫）：0.2.4 升級中斷後重跑，重跑時舊檔、新檔或已換上檔案的 SHA-256 讀取失敗；回報失敗、上一份計畫原封不動，排除故障後重跑或卸載都完整', { skip }, () => {
  // After the stop (5th mv) the first files are the new version's, the rest still 0.2.4's.
  for (const which of ['dest aivenue', 'dest resources/app.asar', 'pkg resources/app.asar']) {
    for (const then of ['retry', 'uninstall']) {
      const t = world();
      const dest = path.join(t.w, 'apps');
      legacyInstall(t, dest);
      userFiles(dest);
      const label = `${which} then ${then}`;
      const before = { user: treeSha(dest, USER_RELS), home: treeSha(t.home, ['.aivenue']) };
      const f = faults(t.w);
      assert.equal(t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, ...f({ MV_COUNT: path.join(t.w, 'm'), MV_KILL: '5' }) }).code, null, label);
      const plan1 = sha(path.join(dest, '.aivenue-pending'));
      const program = snapshot(dest);
      const [side, rel] = which.split(' ');
      const failing = fs.realpathSync(path.join(side === 'dest' ? dest : t.pkg, rel));
      const r2 = t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, ...f({ SHA_FAIL: failing }) });
      assert.equal(r2.code, 1, `${label}: reported (${r2.out})`);
      assert.match(r2.out, /could not be read[\s\S]*nothing was changed/, label);
      assert.equal(sha(path.join(dest, '.aivenue-pending')), plan1, `${label}: the previous complete plan is untouched`);
      assert.deepEqual(snapshot(dest), program, `${label}: nothing changed`);
      const r3 = then === 'retry'
        ? t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest })
        : t.run(path.join(t.pkg, 'uninstall.sh'), { AIVENUE_INSTALL_DIR: dest });
      assert.equal(r3.code, 0, `${label}: ${r3.out}`);
      if (then === 'retry') assert.ok(installedClean(dest, t.pkg), label);
      else assert.ok(LEGACY_FILES.concat(APP_FILES).every((x) => !fs.existsSync(path.join(dest, x))), `${label}: Aivenue's files removed`);
      assert.equal(treeSha(dest, USER_RELS), before.user, `${label}: user files`);
      assert.equal(treeSha(t.home, ['.aivenue']), before.home, `${label}: ~/.aivenue`);
      t.done();
    }
  }
});

test('回歸 7（卸載）：依中斷升級的計畫卸載時，計畫記錄的檔案讀不到 SHA-256；不刪任何檔案並回報（非 0），排除故障後卸載完整', { skip }, () => {
  for (const rel of ['aivenue', 'resources/app.asar']) {
    const t = world();
    const dest = path.join(t.w, 'apps');
    legacyInstall(t, dest);
    userFiles(dest);
    const before = treeSha(dest, USER_RELS);
    const f = faults(t.w);
    assert.equal(t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, ...f({ MV_COUNT: path.join(t.w, 'm'), MV_KILL: '5' }) }).code, null, rel);
    const all = snapshot(dest);
    const u1 = t.run(path.join(t.pkg, 'uninstall.sh'), { AIVENUE_INSTALL_DIR: dest, ...f({ SHA_FAIL: fs.realpathSync(path.join(dest, rel)) }) });
    assert.equal(u1.code, 1, `${rel}: ${u1.out}`);
    assert.match(u1.out, /could not be read to check it[\s\S]*nothing was removed/, rel);
    assert.deepEqual(snapshot(dest), all, `${rel}: nothing removed`);
    const u2 = t.run(path.join(t.pkg, 'uninstall.sh'), { AIVENUE_INSTALL_DIR: dest });
    assert.equal(u2.code, 0, `${rel}: ${u2.out}`);
    assert.ok(LEGACY_FILES.concat(APP_FILES).every((x) => !fs.existsSync(path.join(dest, x))), `${rel}: Aivenue's files removed`);
    assert.equal(treeSha(dest, USER_RELS), before, `${rel}: user files`);
    t.done();
  }
});

test('回歸 7b：結尾校驗相符、但內有格式錯誤紀錄的計畫（缺 SHA-256、SHA-256 長度不對、路徑含 ..、多餘的行、缺或多一行 stage）；重跑安裝和直接卸載都停止，不刪也不改任何檔案', { skip }, () => {
  const edits = {
    'empty SHA-256': (l) => l.map((x) => (x.endsWith('  aivenue') && x.startsWith('old ') ? 'old   aivenue' : x)),
    '63 hex digits': (l) => l.map((x) => (x.endsWith('  aivenue') && x.startsWith('old ') ? `old ${x.slice(5, 68)}  aivenue` : x)),
    'path with ..': (l) => [...l, `old ${'0'.repeat(64)}  locales/../../outside`],
    'a line of another form': (l) => [...l, 'note: hello'],
    'no stage line': (l) => l.filter((x) => !x.startsWith('stage ')),
    'two stage lines': (l) => [...l, 'stage .aivenue-staging.0123456789abcdef 0123456789abcdef'],
  };
  for (const [name, edit] of Object.entries(edits)) {
    for (const then of ['retry', 'uninstall']) {
      const t = world();
      const dest = path.join(t.w, 'apps');
      legacyInstall(t, dest);
      userFiles(dest);
      assert.equal(t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest, ...faults(t.w)({ MV_COUNT: path.join(t.w, 'm'), MV_KILL: '5' }) }).code, null);
      writePlan(dest, edit);
      const before = snapshot(dest);
      const r = then === 'retry'
        ? t.run(path.join(t.pkg, 'install.sh'), { AIVENUE_INSTALL_DIR: dest })
        : t.run(path.join(t.pkg, 'uninstall.sh'), { AIVENUE_INSTALL_DIR: dest });
      assert.equal(r.code, 1, `${name}, ${then}: ${r.out}`);
      assert.match(r.out, /not a complete record/, `${name}, ${then}`);
      assert.deepEqual(snapshot(dest), before, `${name}, ${then}: nothing changed`);
      t.done();
    }
  }
});
