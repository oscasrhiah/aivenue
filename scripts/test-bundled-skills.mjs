import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { test } from './lib/test-shard.mjs';
import { build } from 'esbuild';

// The bundled Agent Skills and impeccable: the pinned upstream copies (packages/core/bundled/README.md), who each skill is
// offered to, and impeccable's install folder, environment and uninstall (no real npm or engine: proc.ts is stubbed).
const BUNDLED = path.join(process.cwd(), 'packages', 'core', 'bundled');
const bundled = await build({
  stdin: { contents: `export { ExtensionService } from './packages/core/src/extensions'; export { impeccableEngine } from './packages/core/src/impeccable';`, resolveDir: process.cwd() },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent',
  plugins: [
    {
      name: 'no processes',
      setup(b) {
        b.onLoad({ filter: /[\\/]proc\.ts$/ }, () => ({
          // The impeccable engine answers its handshake when its file exists; every other command fails.
          contents: `import * as fs from 'node:fs';
            export async function capture(cmd, args) { return args && args[0] === 'engine-probe' && fs.existsSync(cmd) ? { code: 0, stdout: 'impeccable-engine 0.1.18', stderr: '' } : { code: 1, stdout: '', stderr: '' }; }
            export function refreshPathCache() {} export function childEnv() { return {}; } export function findNode() {}
            export function killTree() {} export function resolveCommand(c) { return { file: c, prefixArgs: [], display: c }; }
            export function spawnResolved() { throw new Error('no processes in this test'); }`,
        }));
      },
    },
  ],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const { ExtensionService } = mod.exports;

test('Agent Skills 是上游 222bf92 的版本：26 個 Skill，含 accessibility-engineering 與它連結的角色說明', () => {
  const dir = path.join(BUNDLED, 'agent-skills');
  const skills = fs.readdirSync(path.join(dir, 'skills')).filter((d) => fs.existsSync(path.join(dir, 'skills', d, 'SKILL.md'))).sort();
  assert.equal(skills.length, 26);
  assert.ok(skills.includes('accessibility-engineering'));
  for (const s of skills) assert.match(fs.readFileSync(path.join(dir, 'skills', s, 'SKILL.md'), 'utf8'), new RegExp(`^---\\r?\\nname: ${s}\\r?\\n`), s);
  assert.ok(fs.existsSync(path.join(dir, 'agents', 'accessibility-auditor.md')));
  assert.ok(fs.existsSync(path.join(dir, 'LICENSE')));
  assert.match(fs.readFileSync(path.join(BUNDLED, 'README.md'), 'utf8'), /agent-skills\/` \| https:\/\/github\.com\/addyosmani\/agent-skills \| `222bf920f0d3ac8ce9badf51cd7c60709050c1e0`/);
});

test('accessibility-engineering 交給實作者和程式碼審查者，預設開啟；問答型與 meta Skill 仍預設關閉', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-skills-'));
  const cfg = {};
  const caps = { skillsDir: path.join(data, 'skills'), get: () => ({ extensions: cfg }), setExtensions: (next) => Object.assign(cfg, next) };
  const s = new ExtensionService({ dataDir: data, bundledDir: BUNDLED, capabilities: caps, registry: {}, secrets: {}, onChange() {} });
  await s.setEnabled('agent-skills', true);
  const list = s.list().find((x) => x.id === 'agent-skills').skills;
  assert.equal(list.length, 26);
  const a11y = list.find((k) => k.name === 'accessibility-engineering');
  assert.deepEqual([...a11y.roles].sort(), ['code_reviewer', 'executor']);
  assert.equal(a11y.enabled, true);
  assert.match(a11y.description, /WCAG 2\.2 AA/);
  for (const off of ['interview-me', 'idea-refine', 'constraint-driven-development', 'using-agent-skills', 'context-engineering', 'doubt-driven-development']) assert.equal(list.find((k) => k.name === off).enabled, false, off);
  // Offered to the roles it is mapped to, and only those.
  assert.ok(caps.extraSkills('executor').some((k) => k.name === 'accessibility-engineering'));
  assert.ok(caps.extraSkills('code_reviewer').some((k) => k.name === 'accessibility-engineering'));
  assert.ok(!caps.extraSkills('planner').some((k) => k.name === 'accessibility-engineering'));
  fs.rmSync(data, { recursive: true, force: true });
});

const { impeccableEngine } = mod.exports;

test('impeccable 是上游 skill-v4.8.0 的 Skill 檔：啟動器、引擎版本、授權與換行', () => {
  const dir = path.join(BUNDLED, 'impeccable');
  const skill = path.join(dir, 'skills', 'impeccable');
  assert.match(fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8'), /^---\r?\nname: impeccable\r?\n[\s\S]*version: 4\.8\.0/);
  assert.equal(fs.readFileSync(path.join(skill, 'scripts', 'VERSION'), 'utf8').trim(), '0.1.18');
  assert.match(fs.readFileSync(path.join(skill, 'scripts', 'engine-checksums.txt'), 'utf8'), /^0\.1\.18 impeccable-windows-x64\.exe [0-9a-f]{64}$/m);
  // cmd.exe needs CRLF in the batch launcher; sh needs LF in the other one.
  const cmd = fs.readFileSync(path.join(skill, 'scripts', 'impeccable.cmd'), 'utf8');
  assert.ok(cmd.includes('\r\n') && !/[^\r]\n/.test(cmd), 'impeccable.cmd keeps CRLF');
  assert.ok(!fs.readFileSync(path.join(skill, 'scripts', 'impeccable'), 'utf8').includes('\r'), 'the sh launcher keeps LF');
  for (const f of ['LICENSE', 'NOTICE.md']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.match(fs.readFileSync(path.join(BUNDLED, 'README.md'), 'utf8'), /\| `impeccable\/` \| https:\/\/github\.com\/pbakaus\/impeccable .*\| `414603bf14c7a344edb466bb1f85690c77ce8b7d` \| Apache-2\.0/);
});

test('impeccable：預設關閉；裝好後交給實作者與程式碼審查者，指令帶關閉使用統計的環境，解除安裝只刪 Aivenue 的副本', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-impeccable-'));
  const cfg = {};
  const caps = { skillsDir: path.join(data, 'skills'), get: () => ({ extensions: cfg }), setExtensions: (next) => Object.assign(cfg, next) };
  const s = new ExtensionService({ dataDir: data, bundledDir: BUNDLED, capabilities: caps, registry: {}, secrets: {}, onChange() {} });
  const tools = path.join(data, 'tools', 'impeccable');
  const row = () => s.list().find((x) => x.id === 'impeccable');
  assert.equal(row().enabled, false);
  assert.equal(caps.extraEnv(), undefined);
  assert.ok(!caps.extraSkills('executor').some((k) => k.name === 'impeccable'));

  // What npm would have installed: the package and this platform's engine.
  const engine = impeccableEngine(path.join(data, 'tools'));
  assert.ok(engine.startsWith(path.join(tools, 'node_modules', '@impeccable') + path.sep), engine);
  fs.mkdirSync(path.dirname(engine), { recursive: true });
  fs.writeFileSync(engine, '');
  fs.mkdirSync(path.join(tools, 'node_modules', 'impeccable'), { recursive: true });
  fs.writeFileSync(path.join(tools, 'node_modules', 'impeccable', 'package.json'), JSON.stringify({ name: 'impeccable', version: '4.8.0' }));
  await s.setEnabled('impeccable', true);
  for (let i = 0; i < 50 && row().state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(row().state, 'ready');
  assert.equal(row().version, '4.8.0');
  assert.equal(row().installed, true);

  // The skill copy sits in Aivenue's skills folder, offered to the implementer and the code reviewer only, with the rule.
  const copy = path.join(caps.skillsDir, '.bundled', 'impeccable', 'skills', 'impeccable', 'SKILL.md');
  assert.ok(fs.existsSync(copy));
  for (const role of ['executor', 'code_reviewer']) {
    assert.deepEqual(caps.extraSkills(role).filter((k) => k.name === 'impeccable').map((k) => k.path), [copy], role);
    assert.match(caps.extraRules(role, data), /IMPECCABLE \(design skill\)[\s\S]*do not run live, generate, hooks, pin, install, component-review or build-phase[\s\S]*~\/\.impeccable\/component-reviews/);
  }
  for (const role of ['planner', 'plan_reviewer', 'subagent']) {
    assert.ok(!caps.extraSkills(role).some((k) => k.name === 'impeccable'), role);
    assert.doesNotMatch(caps.extraRules(role, data), /IMPECCABLE/, role);
  }

  // The agents' commands: Aivenue's engine, telemetry and update checks off, impeccable's own files in the tools folder.
  const env = caps.extraEnv();
  assert.equal(env.IMPECCABLE_BIN, engine);
  for (const k of ['DO_NOT_TRACK', 'IMPECCABLE_NO_TELEMETRY', 'IMPECCABLE_NO_UPDATE_CHECK', 'IMPECCABLE_NO_STALENESS_CHECK']) assert.equal(env[k], '1', k);
  for (const k of ['IMPECCABLE_HOME', 'IMPECCABLE_UPDATE_CACHE', 'IMPECCABLE_STALENESS_CACHE']) assert.ok(env[k].startsWith(tools + path.sep), k);
  assert.match(env.IMPECCABLE_SEED_SALT, /^[0-9a-f]{32}$/);
  const saved = JSON.parse(fs.readFileSync(path.join(tools, 'aivenue-settings.json'), 'utf8'));
  assert.equal(saved.telemetry, false);
  assert.equal(saved.seedSalt, env.IMPECCABLE_SEED_SALT, 'the salt is kept between runs');
  assert.equal(caps.extraEnv().IMPECCABLE_SEED_SALT, env.IMPECCABLE_SEED_SALT);

  // Off: nothing offered, no environment; the install stays until uninstalled.
  await s.setEnabled('impeccable', false);
  assert.equal(caps.extraEnv(), undefined);
  assert.ok(!caps.extraSkills('executor').some((k) => k.name === 'impeccable'));
  assert.equal(row().installed, true);
  const outside = path.join(data, 'project-file.txt');
  fs.writeFileSync(outside, 'mine');
  await s.uninstall('impeccable');
  assert.ok(!fs.existsSync(tools));
  assert.ok(!fs.existsSync(path.join(caps.skillsDir, '.bundled', 'impeccable')));
  assert.ok(fs.existsSync(outside));
  assert.equal(row().installed, false);
  assert.equal(row().enabled, false);
  fs.rmSync(data, { recursive: true, force: true });
});

test('開啟 impeccable 或 CodeGraph 時，安裝開始前顯示「準備安裝…」，不會閃過「尚未安裝」的錯誤', async () => {
  for (const id of ['impeccable', 'codegraph']) {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), `aivenue-${id}-`));
    const cfg = {};
    const seen = [];
    const caps = { skillsDir: path.join(data, 'skills'), get: () => ({ extensions: cfg }), setExtensions: (next) => Object.assign(cfg, next) };
    const s = new ExtensionService({ dataDir: data, bundledDir: BUNDLED, capabilities: caps, registry: {}, secrets: {}, onChange: (list) => seen.push(list.find((x) => x.id === id)) });
    const first = (await s.setEnabled(id, true)).find((x) => x.id === id);
    for (let i = 0; i < 50 && s.list().find((x) => x.id === id).state === 'working'; i++) await new Promise((r) => setTimeout(r, 10));
    const shown = seen.filter((x) => x.enabled);
    assert.ok(shown.length > 0, id);
    assert.equal(shown[0].state, 'working', `${id}: ${JSON.stringify(shown[0])}`);
    assert.equal(shown[0].message, '準備安裝…');
    assert.ok(['working', 'error'].includes(first.state), id);
    assert.ok(!shown.some((x) => /尚未安裝/.test(x.message ?? '')), `${id}: ${JSON.stringify(shown.map((x) => [x.state, x.message]))}`);
    // The stub has no Node.js: the install ends with its real error, not "not installed".
    assert.equal(s.list().find((x) => x.id === id).state, 'error');
    assert.match(s.list().find((x) => x.id === id).message, /Node\.js/);
    fs.rmSync(data, { recursive: true, force: true });
  }
});
