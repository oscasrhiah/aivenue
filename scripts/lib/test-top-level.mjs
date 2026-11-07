// node --test reporter used by scripts/run-tests.mjs next to the spec reporter: writes, as JSON, the name of every
// top-level test or suite node actually ran or skipped in this process. The runner compares them with the tests the
// shard wrapper registered, so a test made straight from node:test (which every process would run) is found.
export default async function* topLevel(source) {
  const names = [];
  for await (const event of source) {
    if ((event.type === 'test:pass' || event.type === 'test:fail') && event.data.nesting === 0) names.push(String(event.data.name));
  }
  yield JSON.stringify(names);
}
