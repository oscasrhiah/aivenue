// From each run.json under <home>/runs: the author's submission and the reviewer's verdict and issues, in full,
// written to <out>/<case>.json and summarised on stdout.
//   node issues.mjs <out dir> <home> [...]
import * as fs from 'node:fs';
import * as path from 'node:path';
const [out, ...homes] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
for (const home of homes) {
  for (const id of fs.readdirSync(path.join(home, 'runs'))) {
    const run = JSON.parse(fs.readFileSync(path.join(home, 'runs', id, 'run.json'), 'utf8'));
    const name = run.config.title.replace(/^skill acceptance: /, '').replace(/[^\w-]+/g, '_').replace(/_+$/, '');
    const rounds = Object.values(run.stages ?? {}).flatMap((s) => (s.rounds ?? []).map((r) => ({ stage: s.key, ...r })));
    fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(rounds, null, 1));
    console.log(`\n=== ${name} — ${run.status}`);
    for (const r of rounds) {
      const sub = r.submission ?? {};
      console.log(`  [${r.stage} r${r.n}] author: ${String(sub.summary ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
      const rev = r.review ?? r.reviews?.at?.(-1);
      if (rev) {
        console.log(`  reviewer verdict: ${rev.verdict}; ${(rev.issues ?? []).length} issues`);
        for (const i of rev.issues ?? []) console.log(`    ${String(i.severity).padEnd(8)} ${String(i.location ?? '').padEnd(40)} ${i.title}`);
        for (const v of rev.needsValidation ?? rev.unverified ?? []) console.log(`    needs-validation: ${v.title ?? JSON.stringify(v).slice(0, 120)}`);
      }
    }
  }
}
