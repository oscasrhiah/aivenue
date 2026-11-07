// node --test reporter used by scripts/run-tests.mjs next to the spec reporter. It writes, as JSON, what one test
// process actually did, from node's own events rather than the printed text (which a test's log can imitate):
//   counts     the totals of node's final summary: tests, passed, failed, cancelled, skipped, todo;
//   names      the name of every top-level test or suite node ran or skipped, so the runner can compare them with the
//              tests the shard wrapper registered (a test made straight from node:test would run in every process);
//   fileEntry  the entry node makes for the file itself when the file ran no test of its own: named after the file,
//              at line 1, column 1, and reported while the file's own summaries count no top-level test. It is not in
//              `names`; whether it passed is in `fileEntryFailed`.
export default async function* topLevel(source) {
  const tops = [];
  let ownTopLevel = 0;
  let counts = null;
  for await (const event of source) {
    const data = event.data;
    if ((event.type === 'test:pass' || event.type === 'test:fail') && data.nesting === 0) {
      tops.push({ name: String(data.name), failed: event.type === 'test:fail', made: data.name === data.file && data.line === 1 && data.column === 1 });
    } else if (event.type === 'test:summary') {
      // One summary per file from inside its process (with `file`), and node's final one for the run (without).
      if (data.file) ownTopLevel += data.counts.topLevel;
      else counts = data.counts;
    }
  }
  const entry = ownTopLevel === 0 && tops.length === 1 && tops[0].made ? tops[0] : null;
  yield JSON.stringify({
    counts,
    names: tops.filter((t) => t !== entry).map((t) => t.name),
    fileEntry: Boolean(entry),
    fileEntryFailed: Boolean(entry?.failed),
  });
}
