import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from './lib/test-shard.mjs';
import { build } from 'esbuild';

// 僅替換程序邊界，實際執行擴充服務的安裝、狀態和重試流程。
const bundled = await build({
  stdin: {
    contents: `export { ExtensionService } from './packages/core/src/extensions';
      export { setCapture } from './packages/core/src/proc';`,
    resolveDir: process.cwd(),
  },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{
    name: '測試程序',
    setup(b) {
      b.onLoad({ filter: /[\\/]proc\.ts$/ }, () => ({ contents: `
        export let capture;
        export function setCapture(fn) { capture = fn; }
        export function refreshPathCache() {}
        export function childEnv() { return {}; }
        export function findNode() {}
        export function killTree() {}
        export function resolveCommand(c) { return { file: c, prefixArgs: [], display: c }; }
        // 安裝指令改由 spawn 串流進度：用同一個 capture 替身回應。
        import { EventEmitter } from 'node:events';
        export function spawnResolved(cmd, args) {
          const child = new EventEmitter();
          // Like a real stream after setEncoding('utf8'): it emits strings.
          const stream = () => Object.assign(new EventEmitter(), { encoding: undefined, setEncoding(e) { this.encoding = e; return this; } });
          child.stdout = stream();
          child.stderr = stream();
          const out = (s, text) => s.emit('data', s.encoding ? text : Buffer.from(text));
          Promise.resolve(capture(cmd.file, args)).then((r) => {
            if (r.stdout) out(child.stdout, r.stdout);
            if (r.stderr) out(child.stderr, r.stderr);
            child.emit('close', r.code);
          });
          return child;
        }
      ` }));
    },
  }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const { ExtensionService, setCapture } = mod.exports;
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const fail = (stderr) => ({ code: 1, stdout: '', stderr });

function service() {
  return new ExtensionService({
    dataDir: '.', bundledDir: '不存在的測試套件目錄',
    capabilities: { skillsDir: '.', get: () => ({ extensions: { graphify: { enabled: true } } }) },
    registry: {}, secrets: {}, onChange() {},
  });
}

test('預設 Python 3.15 時，安裝改用相容版本並進入就緒狀態', async () => {
  let installed = false;
  setCapture(async (cmd, args) => {
    if (cmd === 'graphify') return installed ? ok('graphify 0.9.95') : fail('尚未安裝');
    if (args[0] === '--version') return ok('uv 0.13.5');
    installed = args[args.indexOf('--python') + 1] === '3.12';
    return installed ? ok() : fail('Python 3.15 無法編譯 tree-sitter');
  });
  const s = service();
  await s.installGraphify();
  assert.equal(s.list().find(x => x.id === 'graphify').state, 'ready');
});

test('保留編譯錯誤開頭，而且失敗後可重試', async () => {
  let attempts = 0;
  let installed = false;
  setCapture(async (cmd, args) => {
    if (cmd === 'graphify') return installed ? ok('graphify 0.9.95') : fail('尚未安裝');
    if (args[0] === '--version') return ok('uv 0.13.5');
    if (++attempts === 1) return fail('編譯器錯誤：缺少必要標頭\n' + '一般建置訊息\n'.repeat(100) + 'hint: tree-sitter\nhint: graphifyy\nhint: build environment');
    installed = true;
    return ok();
  });
  const s = service();
  await s.installGraphify();
  const status = s.list().find(x => x.id === 'graphify');
  assert.equal(status.state, 'error');
  assert.match(status.message, /編譯器錯誤：缺少必要標頭/);
  await s.retry('graphify');
  // retry 非同步啟動安裝；讓立即完成的程序替身跑完。
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.list().find(x => x.id === 'graphify').state, 'ready');
});

test('已安裝且可執行時不重新安裝', async () => {
  setCapture(async (cmd) => {
    assert.equal(cmd, 'graphify');
    return ok('graphify 0.9.95');
  });
  const s = service();
  await s.installGraphify();
  assert.equal(s.list().find(x => x.id === 'graphify').state, 'ready');
});

test('安全檢查：內建的 security-audit skill 複製到 skills 資料夾，回傳 CLI 讀得到的 SKILL.md 路徑；沒有附就是 undefined', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-skills-'));
  const make = (bundledDir) => new ExtensionService({ dataDir: skillsDir, bundledDir, capabilities: { skillsDir, get: () => ({ extensions: {} }) }, registry: {}, secrets: {}, onChange() {} });
  const p = make(path.join(process.cwd(), 'packages', 'core', 'bundled')).securityAuditSkill();
  assert.equal(p, path.join(skillsDir, '.bundled', 'security-audit', 'skills', 'security-audit', 'SKILL.md'));
  assert.ok(fs.existsSync(p));
  assert.ok(fs.existsSync(path.join(path.dirname(p), 'WEB-PROTOCOL-AND-AUTH.md')));
  assert.equal(make(path.join(skillsDir, 'nothing-here')).securityAuditSkill(), p, 'an earlier copy still serves');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-skills-'));
  assert.equal(new ExtensionService({ dataDir: empty, bundledDir: path.join(empty, 'none'), capabilities: { skillsDir: empty, get: () => ({ extensions: {} }) }, registry: {}, secrets: {}, onChange() {} }).securityAuditSkill(), undefined);
  fs.rmSync(skillsDir, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});

test('可開關的內建 skill：預設關閉；開啟後只出現在對應角色的技能清單與規則，關閉後移除；web-design-guidelines 用內附的規則、不連網', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-skills-'));
  let cfg = { extensions: {} };
  const pushed = [];
  const s = new ExtensionService({
    dataDir: skillsDir,
    bundledDir: path.join(process.cwd(), 'packages', 'core', 'bundled'),
    capabilities: { skillsDir, get: () => cfg, setExtensions: (e) => { cfg = { ...cfg, extensions: e }; }, extraSkills: undefined, extraRules: undefined },
    registry: {}, secrets: {}, onChange() {}, onPackChange: (l) => pushed.push(l),
  });
  const caps = s.o.capabilities;
  const names = (role) => caps.extraSkills(role).map((x) => x.name);
  const list = s.packSkills();
  assert.deepEqual(list.map((x) => x.id), ['architecture-review', 'diagnosing-bugs', 'gha-security-review', 'web-design-guidelines']);
  assert.ok(list.every((x) => x.available && !x.enabled), 'shipped, off by default');
  for (const role of ['planner', 'plan_reviewer', 'executor', 'code_reviewer', 'subagent']) assert.deepEqual(names(role), [], `nothing for ${role} while off`);
  for (const id of ['architecture-review', 'diagnosing-bugs', 'gha-security-review', 'web-design-guidelines']) s.setPackSkill(id, true);
  assert.equal(pushed.length, 4);
  assert.deepEqual(names('planner').sort(), ['codebase-design', 'improve-codebase-architecture']);
  assert.deepEqual(names('executor'), ['diagnosing-bugs']);
  assert.deepEqual(names('subagent'), ['diagnosing-bugs']);
  assert.deepEqual(names('code_reviewer').sort(), ['gha-security-review', 'web-design-guidelines']);
  assert.deepEqual(names('plan_reviewer'), []);
  for (const x of caps.extraSkills('code_reviewer')) assert.ok(fs.existsSync(x.path), `copied: ${x.path}`);
  const wdg = caps.extraSkills('code_reviewer').find((x) => x.name === 'web-design-guidelines');
  const wrapper = fs.readFileSync(wdg.path, 'utf8');
  assert.ok(!/raw\.githubusercontent|WebFetch/.test(wrapper.replace(/not fetched|never fetch|Do not fetch/gi, '')), 'the wrapper does not fetch the rules');
  assert.ok(fs.existsSync(path.join(path.dirname(wdg.path), 'command.md')), 'pinned rules next to it');
  assert.ok(fs.existsSync(path.join(path.dirname(wdg.path), '..', '..', 'LICENSE')));
  assert.match(caps.extraRules('code_reviewer'), /gha-security-review: static review only/);
  assert.match(caps.extraRules('planner'), /improve-codebase-architecture: review read-only/);
  assert.match(caps.extraRules('executor'), /diagnosing-bugs: .*ask_user/);
  assert.equal(caps.extraRules('plan_reviewer'), '');
  s.setPackSkill('gha-security-review', false);
  assert.deepEqual(names('code_reviewer'), ['web-design-guidelines']);
  assert.doesNotMatch(caps.extraRules('code_reviewer'), /gha-security-review/);
  assert.throws(() => s.setPackSkill('frontend-testing-debugging', true), /frontend-testing-debugging/);
  fs.rmSync(skillsDir, { recursive: true, force: true });
});

test('CI 診斷：內建的 gh-fix-ci skill 也複製到 skills 資料夾，回傳讀得到的 SKILL.md 路徑', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-skills-'));
  const s = new ExtensionService({ dataDir: skillsDir, bundledDir: path.join(process.cwd(), 'packages', 'core', 'bundled'), capabilities: { skillsDir, get: () => ({ extensions: {} }) }, registry: {}, secrets: {}, onChange() {} });
  const p = s.ghFixCiSkill();
  assert.equal(p, path.join(skillsDir, '.bundled', 'gh-fix-ci', 'skills', 'gh-fix-ci', 'SKILL.md'));
  assert.ok(fs.existsSync(p));
  fs.rmSync(skillsDir, { recursive: true, force: true });
});

test('審查意見：內建的 gh-address-comments skill 也複製到 skills 資料夾，回傳讀得到的 SKILL.md 路徑', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-skills-'));
  const s = new ExtensionService({ dataDir: skillsDir, bundledDir: path.join(process.cwd(), 'packages', 'core', 'bundled'), capabilities: { skillsDir, get: () => ({ extensions: {} }) }, registry: {}, secrets: {}, onChange() {} });
  const p = s.ghAddressCommentsSkill();
  assert.equal(p, path.join(skillsDir, '.bundled', 'gh-address-comments', 'skills', 'gh-address-comments', 'SKILL.md'));
  assert.ok(fs.existsSync(p));
  fs.rmSync(skillsDir, { recursive: true, force: true });
});
