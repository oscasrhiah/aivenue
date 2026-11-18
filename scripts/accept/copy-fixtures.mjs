// Fixed conversations for the copy checks (vscode-copy-check.mjs, and the desktop app): written into an Aivenue data
// folder by the real orchestrator, with its agents replaced by stand-ins that say fixed text. No model is called.
//  - "回覆" (implementation): the implementer's reply in Traditional Chinese with a table, a nested list and a
//    multi-line code block; it is its message in the log, its submission and its final text.
//  - "審查" (independent review): a report with a blocker, a pre-existing issue, two decisions the user listed (choices,
//    reasons, assumptions) and what was checked and not.
// The texts are exported for the checks to compare a paste with, character by character.
//   node copy-fixtures.mjs <AIVENUE_HOME> <project folder> <vscode|app> [<folder for the expected texts>]
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CODE = ["module.exports = (s) =>", "  s.trim().toLowerCase().replace(/\\s+/g, '-');", '// 最後一行：註解也要逐字保留'].join('\n');
export const REPLY = [
  '已完成：slug 改用連字號，測試通過。',
  '',
  '| 步驟 | 動作 | 結果 |',
  '|---|---|---|',
  '| 1 | 執行 `node slug.test.js` | 失敗（底線） |',
  '| 2 | 把底線改成連字號 | 通過 |',
  '',
  '- 改了 `slug.js`',
  '  - 只動一行',
  '- 沒有改測試',
  '',
  '```js',
  CODE,
  '```',
  '',
  '第二段：換行要保留，',
  '這是同一段的第二行。',
].join('\n');

export const DECIDE = ['在做法 A、B 之間選一個', '要不要合併這次的變更'];
export const REVIEW = {
  verdict: 'revise',
  summary: '做法 A 正確，但這次的提交還有一個問題。\n\n| 檢查 | 結果 |\n|---|---|\n| 崩潰後重開 | 操作還在 |\n| 寫入失敗 | 回覆了成功 |',
  issues: [
    { id: 'R1', severity: 'blocker', title: '寫入失敗時仍回覆成功', location: 'store.js:14', detail: '寫入丟出錯誤時，catch 吞掉它\n之後照樣回覆 { ok: true }。', blocking: '已確認成功的操作遺失：符合嚴重問題的標準' },
    { id: 'R2', severity: 'minor', title: '註解拼錯字', location: 'store.js:3', blocking: '只是文字，不影響行為', pre_existing: true },
  ],
  decisions: [
    { id: 'D1', choice: 'A：先寫入磁碟再回覆', reasons: 'B 先回覆再批次寫入，崩潰時會遺失已確認的操作，違反需求。', assumptions: ['一個檔案只有一個寫入者（程式碼寫明的設計）', '整台電腦斷電不在範圍'] },
    { id: 'D2', choice: '先不要合併：R1 修好後再合併', reasons: 'R1 會讓使用者以為成功的操作消失。', assumptions: ['R1 的修正不改變 A 的寫入順序'] },
  ],
  checked: ['在受審提交的暫存工作樹跑 node test.js', '寫入失敗時的回覆（注入錯誤）'],
  not_checked: ['Linux：這台是 Windows'],
  reproduced: ['注入寫入錯誤：回覆 { ok: true }，檔案沒有這筆操作'],
  trusted: ['材料說完整測試通過'],
};

function git(cwd, ...a) {
  return execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8' }).trim();
}

/** Writes the two conversations into `home` (an AIVENUE_HOME) for `host`; `proj` becomes a small git project. */
export async function writeFixtures(home, proj, host) {
  const { build } = createRequire(path.join(REPO, 'package.json'))('esbuild');
  const out = await build({
    stdin: { contents: "export { Orchestrator } from './packages/core/src/orchestrator'; export { RunStore } from './packages/core/src/store';", resolveDir: REPO },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
    plugins: [{ name: 'stand-in agents', setup: (b) => b.onLoad({ filter: /[\\/]agentRunner\.ts$/ }, () => ({ contents: 'export async function runAgent(o) { return globalThis.__copyFixtureAgent(o); }' })) }],
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(createRequire(path.join(REPO, 'package.json')), mod, mod.exports);
  const { Orchestrator, RunStore } = mod.exports;

  fs.mkdirSync(proj, { recursive: true });
  if (!fs.existsSync(path.join(proj, '.git'))) {
    git(proj, 'init', '-q');
    fs.writeFileSync(path.join(proj, 'store.js'), '// store\n');
    git(proj, 'add', '-A');
    git(proj, 'commit', '-q', '-m', 'Store: base');
    fs.writeFileSync(path.join(proj, 'store.js'), '// store: save before answering\n');
    git(proj, 'commit', '-q', '-am', 'Save before answering');
  }
  const spec = (id) => ({ id, name: id === 'opencode' ? 'OpenCode' : id, command: id, run: { args: [] }, output: 'text' });
  const ids = ['opencode'];
  const orch = new Orchestrator({
    registry: { get: (id) => (ids.includes(id) ? spec(id) : undefined), quotaCaps: () => ({}), setQuotaCap() {}, list: () => ids.map((id) => ({ spec: spec(id), installed: true, auth: { state: 'logged_in' } })), specs: () => ids.map(spec), defaults: () => ({}), runAuth: async () => undefined, listModels: async () => [], noteContext() {} },
    store: new RunStore(home, host),
    usage: { recordRun() {}, recordError() {}, recordUsage() {}, cachedSummary: () => [], summary: async () => [] },
    capabilities: { serversFor: async () => [], skillsBlock: () => '', instructionsFor: () => undefined, skillsDir: home },
    attachments: { prepare: async (a) => ({ attachments: a ?? [], warnings: [] }), adopt: (_id, a) => a ?? [], runDir: () => home },
    dataDir: home,
    bridgePath: 'bridge.js',
    hubUrl: () => 'http://127.0.0.1:1',
    push: () => undefined,
    gpuQuery: () => {
      throw new Error('no GPU');
    },
    gpuSmi: () => {
      throw new Error('no GPU');
    },
  });
  const say = (o, seq, text) => o.onEvent({ seq, ts: Date.now(), kind: 'message', text }, false);
  globalThis.__copyFixtureAgent = async (o) => {
    const secret = o.bridge?.env?.AIVENUE_SESSION;
    const done = (finalText) => ({ lastSeq: (o.seqStart ?? 0) + 2, exitCode: 0, resumed: false, finalText });
    if (/^You are the INDEPENDENT REVIEWER/.test(o.prompt)) {
      say(o, 1, '審查完成，報告如下。');
      await orch.callTool(secret, 'submit_review', REVIEW);
      return done('審查完成，報告如下。');
    }
    say(o, 1, REPLY);
    await orch.callTool(secret, 'submit_work', { summary: REPLY });
    return done(REPLY);
  };
  const role = { provider: 'opencode', model: 'opencode/deepseek-v4.1-flash-free' };
  const base = (title, goal) => ({
    title,
    goal,
    userText: goal,
    cwd: proj,
    plan: { enabled: false, author: role, reviewer: null, maxRounds: 1, humanGate: false },
    implement: { enabled: true, author: role, reviewer: null, maxRounds: 1, humanGate: false },
    verify: { enabled: false, by: 'planner', repeatLimit: 1 },
    subagents: { enabled: false, allowed: [], maxDepth: 1, maxConcurrent: 1 },
    assignment: { mode: 'manual' },
    permission: 'auto',
    isolation: 'none',
    memory: { mode: 'off' },
  });
  const settle = async (id) => {
    for (let i = 0; i < 400; i++) {
      const r = orch.runs.get(id);
      if (r && !['running', 'queued'].includes(r.status)) return r;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error(`fixture run ${id} did not finish`);
  };
  const reply = await settle(orch.start(base('複製測試：回覆', '把 slug 的底線改成連字號，並用表格說明每一步')).id);
  const review = await settle(
    orch.start({ ...base('複製測試：審查報告', '請審查這次的變更，替我在做法 A、B 之間選一個，並告訴我要不要合併'), implement: { enabled: true, author: role, reviewer: role, maxRounds: 1, humanGate: false }, flow: 'review', review: { decide: DECIDE } }).id,
  );
  // Written to disk before a hub reads them.
  await new Promise((res) => setTimeout(res, 500));
  for (const r of [reply, review]) if (r.status !== 'completed') throw new Error(`fixture "${r.config.title}" ended ${r.status}: ${r.error ?? ''}`);
  return { reply, review };
}

/**
 * What each copy button must put on the clipboard, as files to compare a paste with (the Ubuntu desktop check): the
 * reply, its code block alone, and the review report as the page's Traditional Chinese text makes it.
 */
export async function writeExpected(dir, review) {
  const { build } = createRequire(path.join(REPO, 'package.json'))('esbuild');
  const out = await build({ entryPoints: [path.join(REPO, 'packages/ui/src/reviewText.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(createRequire(path.join(REPO, 'package.json')), mod, mod.exports);
  const report = mod.exports.reviewMarkdown((zh) => zh, review.stages.implement.rounds.at(-1).review, review.reviewTarget);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '複製回覆-複製結果.md'), REPLY);
  fs.writeFileSync(path.join(dir, '複製程式碼.txt'), CODE);
  fs.writeFileSync(path.join(dir, '複製審查報告.md'), report);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [home, proj, host, expectedDir] = process.argv.slice(2);
  if (!home || !proj || !['vscode', 'app'].includes(host)) {
    console.error('usage: node copy-fixtures.mjs <AIVENUE_HOME> <project folder> <vscode|app> [<folder for the expected texts>]');
    process.exit(2);
  }
  const { reply, review } = await writeFixtures(path.resolve(home), path.resolve(proj), host);
  console.log(`written: ${reply.id} (${reply.config.title}), ${review.id} (${review.config.title})`);
  if (expectedDir) {
    await writeExpected(path.resolve(expectedDir), review);
    console.log(`expected texts: ${path.resolve(expectedDir)}`);
  }
  process.exit(0);
}
