// Summarise acceptance runs: for each run under <home>/runs, each agent's role, which skills its index listed,
// whether the bundled-skill rule was in its prompt, which SKILL.md / companion files it read, the commands it ran,
// the files it edited, and its final submission.
//   node analyze.mjs <home dir> [...]
import * as fs from 'node:fs';
import * as path from 'node:path';

const SKILLS = ['improve-codebase-architecture', 'codebase-design', 'diagnosing-bugs', 'gha-security-review', 'web-design-guidelines', 'security-audit', 'debugging-and-error-recovery', 'code-review-and-quality', 'frontend-ui-engineering', 'api-and-interface-design', 'test-driven-development', 'security-and-hardening'];
for (const home of process.argv.slice(2)) {
  const runs = path.join(home, 'runs');
  if (!fs.existsSync(runs)) continue;
  for (const id of fs.readdirSync(runs)) {
    const dir = path.join(runs, id);
    const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
    console.log(`\n##### ${run.config?.title} — ${run.status} (${id})`);
    for (const [aid, a] of Object.entries(run.agents ?? {})) {
      const f = path.join(dir, 'events', `${aid}.jsonl`);
      if (!fs.existsSync(f)) continue;
      const ev = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const prompt = ev.find((e) => e.kind === 'prompt')?.text ?? '';
      // Skills index entries are "- <name>: <description> — <path to SKILL.md>".
      const index = [...prompt.matchAll(/^- ([\w-]+): .* — .*SKILL\.md\s*$/gm)].map((m) => m[1]);
      const tools = new Map();
      for (const e of ev.filter((e) => e.kind === 'tool' && e.tool)) tools.set(e.tool.id, e.tool);
      const list = [...tools.values()];
      const reads = list.filter((t) => t.category === 'read' || /read/i.test(t.name)).map((t) => `${t.title ?? ''} ${t.input ?? ''}`).filter((s) => /\.bundled|SKILL\.md|command\.md|references[\\/]/.test(s)).map((s) => (s.match(/[\w.-]+[\\/]+(SKILL\.md|command\.md|[\w-]+\.md)/g) ?? [s.slice(0, 120)]).join(' '));
      const cmds = list.filter((t) => t.category === 'command').map((t) => (t.title ?? '').slice(0, 140));
      const edits = list.filter((t) => t.category === 'edit').map((t) => t.title);
      console.log(`--- ${a.role} (${a.provider} ${a.model ?? ''}) ${a.status}`);
      console.log(`    index: ${index.join(', ') || '—'}; rule: ${/BUNDLED SKILLS/.test(prompt) ? 'yes' : 'no'}; security check rule: ${/security-audit/.test(prompt) ? 'yes' : 'no'}`);
      console.log(`    skill files read: ${reads.length ? [...new Set(reads)].join(' | ') : 'none'}`);
      console.log(`    commands (${cmds.length}): ${cmds.slice(0, 12).join(' ‖ ')}`);
      console.log(`    edits: ${[...new Set(edits)].join(', ') || 'none'}`);
      const submit = list.filter((t) => /submit_(work|review|plan)/.test(t.name ?? '')).at(-1);
      if (submit) console.log(`    submit: ${String(submit.input ?? '').replace(/\s+/g, ' ').slice(0, 2500)}`);
      else {
        const last = ev.filter((e) => e.kind === 'message').at(-1);
        if (last) console.log(`    last message: ${String(last.text ?? '').replace(/\s+/g, ' ').slice(0, 1500)}`);
      }
    }
  }
}
