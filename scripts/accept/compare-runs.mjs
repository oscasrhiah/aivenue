// Compares a plain `node --test --test-reporter=spec scripts/test-*.mjs` log with an `npm test` log (run with
// AIVENUE_TEST_VERBOSE=1): the totals, and every test line at every nesting level as "depth status name" with how
// many times it appears (spec reporter: ✔ pass, ✖ fail, ﹣ skip; "# TODO" after the time marks a todo). Subtests
// (indented two spaces per level) count in "ℹ tests", so they are compared too.
//   node compare-runs.mjs <direct.log> <npm-test.log>
// Exits 0 only when the totals are the same, no test differs in name, status or count, and no name appears twice.
import * as fs from 'node:fs';

const [a, b] = process.argv.slice(2).map((f) => fs.readFileSync(f, 'utf8'));
const totals = (s) => Object.fromEntries(['tests', 'pass', 'fail', 'skipped', 'todo'].map((k) => [k, Number([...s.matchAll(new RegExp(`^ℹ ${k} (\\d+)`, 'gm'))].at(-1)?.[1] ?? -1)]));
// Test lines at every level (the depth is part of the key), without the duration. The recap of failing tests at the
// end of a report repeats each failure, so it is left out.
const lines = (s) => {
  const body = s.split(/^✖ failing tests:$/m)[0];
  const m = new Map();
  for (const x of body.matchAll(/^((?:  )*)([✔✖﹣]) (.+?) \([\d.]+ms\)( # (.*))?\s*$/gm)) {
    const status = x[2] === '﹣' ? 'skip' : x[5] && /^TODO\b/.test(x[5]) ? 'todo' : x[2] === '✔' ? 'pass' : 'fail';
    const depth = x[1].length / 2;
    const key = `${depth ? `[depth ${depth}] ` : ''}${status} ${x[3]}`;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
};
const ta = totals(a);
const tb = totals(b);
console.log('direct  :', JSON.stringify(ta));
console.log('npm test:', JSON.stringify(tb));
const la = lines(a);
const lb = lines(b);
const keys = new Set([...la.keys(), ...lb.keys()]);
const diff = [...keys].filter((k) => (la.get(k) ?? 0) !== (lb.get(k) ?? 0));
const twice = (m) => [...m].filter(([, n]) => n > 1).map(([k]) => k);
console.log(`test lines: direct ${la.size}, npm test ${lb.size}; differing in status or count: ${diff.length}; appearing more than once: direct ${twice(la).length}, npm test ${twice(lb).length}`);
for (const k of diff.slice(0, 30)) console.log(`  direct ${la.get(k) ?? 0} / npm test ${lb.get(k) ?? 0}: ${k}`);
for (const k of [...twice(la), ...twice(lb)].slice(0, 10)) console.log(`  more than once: ${k}`);
const same = JSON.stringify(ta) === JSON.stringify(tb) && ta.tests > 0 && !diff.length && !twice(la).length && !twice(lb).length && la.size === ta.tests;
console.log(same ? 'SAME' : 'DIFFERENT');
process.exit(same ? 0 : 1);
