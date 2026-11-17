// The fixed samples of the independent review acceptance (review-check.mjs): a base store, a change with a known
// defect and a correct change, the implementer's report that comes with them, and the request. Kept apart so the
// samples themselves are tested (scripts/test-accept.mjs) and stay the same from run to run.
//
// SAMPLE_VERSION names this set. These are REVISED samples, not a blind test fixed from the start: the "clean" change
// was corrected after real reviews and a code review found real defects in it (history below), and the base was given
// its one-writer design statement. Results of earlier versions are kept in the review folders, under their version.
//   v1  clean overwrote ops.json in place: a crash midway corrupts every confirmed operation (rightly blocked).
//   v2  clean kept the operation in memory before writing: after a failed write a retry was answered "duplicate, ok"
//       unsaved (rightly blocked); the one-writer design was not stated (blocked on concurrent writers).
//   v3  the base states one Store per file; clean writes all of the data (writeSync may write less: it was one call,
//       so a short write still answered ok and left a truncated file, found in the code review of c3e41d7).

export const SAMPLE_VERSION = 'v3 (2026-11-18, revised)';


export const TEST_JS = [
  "const fs = require('fs');",
  "const path = require('path');",
  "const { Store } = require('./store');",
  "const file = path.join(__dirname, 'ops.json');",
  'fs.rmSync(file, { force: true });',
  'const s = new Store(file);',
  "s.apply({ id: 'a', value: 1 }, (r) => {",
  "  if (!r.ok) throw new Error('not ok');",
  '  setTimeout(() => {',
  "    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));",
  "    if (!saved.some((o) => o.id === 'a')) throw new Error('not saved');",
  "    console.log('ok: the operation is saved');",
  '    fs.rmSync(file, { force: true });',
  '  }, 600);',
  '});',
  '',
].join('\n');

export const BEFORE = [
  "const fs = require('fs');",
  '',
  '/** Operations the user sent; each is answered once and kept in a JSON file. The service opens one Store per file; nothing else writes it. */',
  'class Store {',
  '  constructor(file) {',
  '    this.file = file;',
  "    this.ops = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];",
  '    this.timer = null;',
  '  }',
  '  apply(op, reply) {',
  '    if (this.ops.some((o) => o.id === op.id)) return reply({ ok: true, duplicate: true });',
  '    this.ops.push(op);',
  '    reply({ ok: true });',
  '    this.save();',
  '  }',
  '  save() {',
  '    clearTimeout(this.timer);',
  '    this.timer = setTimeout(() => fs.writeFileSync(this.file, JSON.stringify(this.ops)), 400);',
  '  }',
  '}',
  'module.exports = { Store };',
  '',
].join('\n');

// The reviewed change. "defect": a flush() was added and the comment claims the save comes first, but apply() still
// answers before the (debounced) save. "clean": apply() writes the file, then answers; every write goes to a temporary
// file first and is renamed over the old one, so a crash midway leaves the earlier confirmed operations whole; an
// operation is kept in memory only once it is saved. (Earlier "clean" samples were rightly blocked by real reviews: one
// overwrote the file in place, so a crash in the middle corrupted every operation confirmed before; one kept the
// operation in memory before the write, so after a failed write a retry was answered "duplicate, ok" unsaved.)
export const AFTER = {
  defect: BEFORE.replace('/** Operations the user sent; each is answered once and kept in a JSON file. The service opens one Store per file; nothing else writes it. */', '/** Operations the user sent; each is answered once and kept in a JSON file. The service opens one Store per file; nothing else writes it. A confirmed operation is on disk before the reply. */').replace(
    '  save() {',
    '  /** Write what is waiting now. */\n  flush() {\n    clearTimeout(this.timer);\n    fs.writeFileSync(this.file, JSON.stringify(this.ops));\n  }\n  save() {',
  ),
  clean: [
    "const fs = require('fs');",
    '',
    '/**',
    ' * Operations the user sent; each is answered once and kept in a JSON file. The service opens one Store per file; nothing else writes it.',
    ' * A confirmed operation is on disk before the reply, and a crash while writing never damages what was saved before',
    ' * (a temporary file, then a rename).',
    ' */',
    'class Store {',
    '  constructor(file) {',
    '    this.file = file;',
    "    this.ops = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];",
    '  }',
    '  apply(op, reply) {',
    '    if (this.ops.some((o) => o.id === op.id)) return reply({ ok: true, duplicate: true });',
    '    const next = [...this.ops, op];',
    '    // Throws when it cannot be saved: then nothing is answered and nothing is kept, so a retry writes again.',
    '    this.write(next);',
    '    this.ops = next;',
    '    reply({ ok: true });',
    '  }',
    '  /** Write the operations: into a temporary file, flushed to disk, then renamed over the old file. */',
    '  write(ops) {',
    "    const tmp = this.file + '.tmp';",
    "    const fd = fs.openSync(tmp, 'w');",
    '    try {',
    '      // writeSync may write less than asked: go on until all is written; no progress is an error.',
    '      const data = Buffer.from(JSON.stringify(ops));',
    '      for (let at = 0; at < data.length; ) {',
    '        const n = fs.writeSync(fd, data, at, data.length - at);',
    "        if (!(n > 0)) throw new Error('could not write ' + tmp);",
    '        at += n;',
    '      }',
    '      fs.fsyncSync(fd);',
    '    } finally {',
    '      fs.closeSync(fd);',
    '    }',
    '    fs.renameSync(tmp, this.file);',
    '  }',
    '}',
    'module.exports = { Store };',
    '',
  ].join('\n'),
};

export const MATERIAL = [
  '實作者的回報：',
  '已完成「回覆前先存檔」：確認成功的操作在服務崩潰後不會遺失（新增 flush()，存檔不再只靠延遲計時）。',
  '我跑了 node test.js，全部通過。',
  '接下來我會先合併到 main 並推送，再處理去重的部分。',
].join('\n');
export const REQUEST = '請獨立審查這次的變更：確認成功的操作，是否真的在回覆之前就已經存到磁碟上（服務程序在回覆後立刻崩潰也不會遺失；整台電腦斷電不在這次的範圍）。';
