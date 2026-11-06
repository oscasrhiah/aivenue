// Stand-in for the OpenCode CLI, for testing the benchmark without a model (scripts/test-bench.mjs).
//   FAKE_MODE: solve | solve-badtest | two-sessions | hang | usage-hang | touch-test | limited | usage-limit | escape-write | review | review-fail
//   FAKE_EXPORT: the model "session export" reports ("provider/id"), or "none" for no record
//   FAKE_PIDS: a file to append this process's pid to
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (process.env.FAKE_PIDS) fs.appendFileSync(process.env.FAKE_PIDS, `${process.pid}\n`);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (args[0] === '--version') {
  console.log('fake-opencode 0.0.0');
} else if (args[0] === 'session' && args[1] === 'export') {
  const m = process.env.FAKE_EXPORT ?? 'opencode/deepseek-v4.1-flash-free';
  // FAKE_EXPORT_MISSING: a session id with no record.
  if (m !== 'none' && args[2] !== process.env.FAKE_EXPORT_MISSING) {
    const [providerID, id] = m.split('/');
    // FAKE_EXPORT_DIR: where the session says it worked (default: the folder export runs in, i.e. the checkout).
    const directory = process.env.FAKE_EXPORT_DIR ?? process.cwd();
    // FAKE_EXPORT=nomodel: a record that says where it worked but not which model.
    if (m === 'nomodel') {
      process.stdout.write(JSON.stringify({ info: { id: args[2], location: { directory } }, messages: [{ content: [{ text: 'ok' }] }] }));
      process.exit(0);
    }
    process.stdout.write(`Exporting session ${args[2]}\n${JSON.stringify({ info: { id: args[2], model: { id, providerID }, location: { directory } }, messages: [{ model: { id, providerID }, content: [{ text: process.env.FAKE_EXPORT_TEXT ?? 'ok' }] }] })}`);
  }
} else if (args[0] === 'run') {
  let prompt = '';
  process.stdin.on('data', (d) => (prompt += d));
  process.stdin.on('end', async () => {
    const mode = process.env.FAKE_MODE ?? 'solve';
    out({ type: 'step_start', sessionID: 'ses_fake1', part: { sessionID: 'ses_fake1' } });
    if (mode === 'two-sessions') out({ type: 'step_start', sessionID: 'ses_fake2', part: { sessionID: 'ses_fake2' } });
    if (mode === 'hang') return setInterval(() => undefined, 1000);
    if (mode === 'usage-hang') {
      out({ type: 'step_finish', part: { cost: 0, tokens: { input: 700, output: 90, reasoning: 0, cache: { read: 4000, write: 0 } } } });
      return setInterval(() => undefined, 1000);
    }
    if (mode === 'usage-limit') {
      process.stderr.write('Error: Free usage limit reached. Free models work in OpenCode (h)\n');
      process.exit(1);
    }
    // FAKE_ESCAPE_TO: a file outside the checkout this run writes to.
    if (mode === 'escape-write') fs.appendFileSync(process.env.FAKE_ESCAPE_TO, 'written from a benchmark run\n');
    if (mode === 'limited') {
      out({ type: 'error', error: { message: 'Rate limit exceeded (429)' }, message: 'Rate limit exceeded (429)' });
      process.stderr.write('Error: Rate limit exceeded (429)\n');
      process.exit(1);
    }
    if (mode === 'solve' || mode === 'solve-badtest' || mode === 'two-sessions') fs.cpSync(path.join(here, '..', 'reference', 'src'), path.join(process.cwd(), 'src'), { recursive: true });
    if (mode === 'solve-badtest') fs.writeFileSync(path.join(process.cwd(), 'test', 'extra.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('always fails', () => assert.equal(1, 2));\n");
    if (mode === 'touch-test') fs.appendFileSync(path.join(process.cwd(), 'test', 'basic.test.js'), '\n// touched\n');
    const text = mode === 'review' || mode === 'touch-test' || mode === 'review-fail' ?'Defects:\n\n- src/csv.js: double quotes inside a field are not doubled.\n\n- src/report.js: summaryCsv([]) throws because it reads items[0].' : 'done';
    out({ type: 'text', part: { id: 'prt_1', type: 'text', text, sessionID: 'ses_fake1', time: { start: 1, end: 2 } } });
    out({ type: 'step_finish', part: { cost: 0, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 300, write: 0 } } } });
    process.exit(mode === 'review-fail' ? 1 : 0);
  });
} else {
  console.error(`fake-opencode: unknown ${args.join(' ')}`);
  process.exit(2);
}
