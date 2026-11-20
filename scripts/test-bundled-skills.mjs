import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { test } from './lib/test-shard.mjs';
import { build } from 'esbuild';

// The bundled Agent Skills: the pinned upstream copy (packages/core/bundled/README.md) and who each skill is offered to.
const BUNDLED = path.join(process.cwd(), 'packages', 'core', 'bundled');
const bundled = await build({
  stdin: { contents: `export { ExtensionService } from './packages/core/src/extensions';`, resolveDir: process.cwd() },
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
          contents: `export async function capture() { return { code: 1, stdout: '', stderr: '' }; }
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
