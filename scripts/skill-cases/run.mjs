// Acceptance runs of the four switchable bundled skills through a real Aivenue hub and OpenCode (free model).
//   node scripts/skill-cases/run.mjs <variant: pack|baseline> <out dir> [case ...]   (after npm run build)
// SKILL_MODEL picks the OpenCode model (default: a free one). Then: node scripts/skill-cases/analyze.mjs <out>/home-<variant>
// and node scripts/skill-cases/issues.mjs <results dir> <out>/home-<variant>.
// pack:     the four skills on (Capabilities → built-in skills you can turn on), Agent Skills off.
// baseline: the four off; Agent Skills on (debugging-and-error-recovery, code-review-and-quality, ...); for the
//           GitHub Actions case the workflow's own security check (security-audit) instead.
// Each variant gets its own hub with its own AIVENUE_HOME under <out dir>; the user's ~/.aivenue is never used.
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CASES = path.join(REPO, 'scripts', 'skill-cases');
const [variant, outArg, ...only] = process.argv.slice(2);
const OUT = path.resolve(outArg);
const MODEL = process.env.SKILL_MODEL || 'opencode/deepseek-v4.1-flash-free';
const role = () => ({ provider: 'opencode', model: MODEL });
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...a], { cwd, stdio: 'pipe' }).toString();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function copy(from, to) {
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

/** Each case: how its working folder is made, the task, and which stages run. */
const CASE = {
  'architecture-review': {
    prepare(dir) {
      copy(path.join(CASES, 'architecture-review', 'fixture'), dir);
      git(dir, 'init', '-q');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'orders: first version');
      fs.appendFileSync(path.join(dir, 'src/orders/priceOrder.ts'), '// tweak\n');
      git(dir, 'commit', '-qam', 'orders: coupon');
      fs.appendFileSync(path.join(dir, 'src/api.ts'), '// tweak\n');
      git(dir, 'commit', '-qam', 'orders: quote endpoint');
    },
    goal: '審查這個 repo 的架構，找出值得加深的模組，只產出報告，不要改程式。',
    stages: 'plan',
  },
  'diagnosing-bugs': {
    prepare(dir) {
      copy(path.join(CASES, 'diagnosing-bugs', 'fixture'), dir);
      git(dir, 'init', '-q');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'cache');
    },
    goal: '`npm test` 偶爾失敗，找出原因並修好。',
    stages: 'implement',
  },
  'gha-security-review': {
    prepare(dir) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "app", "private": true, "scripts": { "test": "node -e 0" } }\n');
      git(dir, 'init', '-q');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'app');
      copy(path.join(CASES, 'gha-security-review', 'fixture'), dir);
      git(dir, 'add', '-N', '.github');
    },
    goal: '工作目錄裡有一個尚未 commit 的變更：新增的 GitHub Actions workflow（.github/workflows/pr-greet.yml）。實作者不要修改任何檔案，只要確認變更在那裡並交出結果；由程式碼審查者審查這個 workflow 並回報問題。',
    stages: 'review',
  },
  'web-design-guidelines': {
    prepare(dir) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "ui", "private": true }\n');
      git(dir, 'init', '-q');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'ui');
      copy(path.join(CASES, 'web-design-guidelines', 'fixture'), dir);
      git(dir, 'add', '-N', 'src');
    },
    goal: '工作目錄裡有尚未 commit 的變更：src/Toolbar.tsx 與 src/Card.tsx 兩個新元件。實作者不要修改任何檔案，只要確認變更在那裡並交出結果；由程式碼審查者依網頁介面準則審查 src/，以 file:line 回報問題。',
    stages: 'review',
  },
};

function config(name, dir) {
  const c = CASE[name];
  const off = { enabled: false, author: role(), reviewer: null, maxRounds: 1, humanGate: false };
  return {
    title: `skill acceptance: ${name} (${variant})`,
    goal: c.goal,
    cwd: dir,
    plan: c.stages === 'plan' ? { enabled: true, author: role(), reviewer: null, maxRounds: 1, humanGate: false } : off,
    implement: c.stages === 'plan' ? off : { enabled: true, author: role(), reviewer: c.stages === 'review' ? role() : null, maxRounds: 1, humanGate: false },
    subagents: { enabled: false, allowed: [], maxDepth: 1, maxConcurrent: 1 },
    assignment: { mode: 'manual', auto: undefined },
    permission: 'auto',
    isolation: 'none',
    memory: { mode: 'off' },
    limits: { enabled: true, maxMinutes: 25, noProgressMinutes: 8 },
    securityReview: variant === 'baseline' && name === 'gha-security-review',
  };
}

// ---------- hub ----------
function startHub(home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO, 'packages/desktop/dist/standalone.cjs')], { env: { ...process.env, AIVENUE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    const logf = fs.createWriteStream(path.join(OUT, `hub-${variant}.log`));
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

// ---------- run ----------
fs.mkdirSync(OUT, { recursive: true });
const home = path.join(OUT, `home-${variant}`);
fs.mkdirSync(home, { recursive: true });
const hub = await startHub(home);
const rpc = await connect(hub);
log('hub', variant, hub.port);
const providers = await rpc.call('providers.list');
const oc = providers.find((p) => p.spec?.id === 'opencode');
log('opencode:', JSON.stringify({ available: oc?.available ?? oc?.status, version: oc?.version }));
if (variant === 'pack') {
  for (const id of ['architecture-review', 'diagnosing-bugs', 'gha-security-review', 'web-design-guidelines']) await rpc.call('extensions.setPackSkill', { id, on: true });
} else {
  await rpc.call('extensions.setEnabled', { id: 'agent-skills', enabled: true });
}
log('pack skills:', JSON.stringify((await rpc.call('extensions.packSkills')).map((s) => `${s.id}:${s.enabled}`)));

const names = only.length ? only : Object.keys(CASE);
const results = {};
await Promise.all(
  names.map(async (name) => {
    const dir = path.join(OUT, `${name}-${variant}`);
    fs.rmSync(dir, { recursive: true, force: true });
    CASE[name].prepare(dir);
    const cfg = config(name, dir);
    const pre = await rpc.call('workflows.preflight', { config: cfg }).catch((e) => ({ error: e.message }));
    fs.writeFileSync(path.join(OUT, `${name}-${variant}.preflight.json`), JSON.stringify(pre, null, 1));
    const id = await rpc.call('workflows.start', { config: cfg });
    log('started', name, id);
    const t0 = Date.now();
    let run;
    let waitingSince = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 10_000));
      run = await rpc.call('workflows.get', { id });
      if (['completed', 'incomplete', 'failed', 'cancelled', 'interrupted'].includes(run.status)) break;
      if (run.status === 'waiting_human' || run.status === 'paused') {
        waitingSince ||= Date.now();
        if (Date.now() - waitingSince > 60_000) {
          log(name, 'waiting on a person; cancelling:', JSON.stringify(run.pending ?? {}).slice(0, 300));
          fs.writeFileSync(path.join(OUT, `${name}-${variant}.pending.json`), JSON.stringify(run.pending ?? null, null, 1));
          await rpc.call('workflows.cancel', { id });
        }
      } else waitingSince = 0;
      if (Date.now() - t0 > 30 * 60_000) {
        log(name, 'over 30 minutes; cancelling');
        await rpc.call('workflows.cancel', { id });
      }
    }
    const exp = await rpc.call('workflows.export', { id, mask: false }).catch((e) => ({ error: e.message }));
    fs.writeFileSync(path.join(OUT, `${name}-${variant}.export.json`), typeof exp === 'string' ? exp : JSON.stringify(exp, null, 1));
    fs.writeFileSync(path.join(OUT, `${name}-${variant}.run.json`), JSON.stringify(run, null, 1));
    let status = '';
    try {
      status = git(dir, 'status', '--porcelain');
    } catch {}
    results[name] = { id, status: run.status, minutes: ((Date.now() - t0) / 60000).toFixed(1), gitStatus: status };
    log('finished', name, run.status, results[name].minutes, 'min');
  }),
);
fs.writeFileSync(path.join(OUT, `summary-${variant}.json`), JSON.stringify(results, null, 1));
rpc.close();
hub.child.kill();
log('done', JSON.stringify(results));
process.exit(0);
