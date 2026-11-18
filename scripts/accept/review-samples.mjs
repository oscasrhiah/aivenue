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
//   v4  v3's samples unchanged, plus the two decision requests below (DECIDE_REQUEST, ASK_REQUEST). In the first run
//       ASK_REQUEST did not say power loss was out of scope (the others do): the reviewer read "never lost" as covering
//       it and asked for a directory sync, as an assumption it named. Its scope now says it, like the others.
//   v5  the decisions are also listed for Aivenue to check (DECIDE_LIST, ASK_LIST), and a decision must not rest on the
//       opposite of what the samples state (AGAINST): in a v4 run the reviewer advised against merging the clean change
//       on the premise that several Stores may write the file, which the base rules out.

export const SAMPLE_VERSION = 'v5 (2026-11-18, revised)';


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

// The decision requests: the user leaves a choice between two approaches to the reviewer. The reviewed change is the
// "clean" sample, approach A. Neither says "do not ask me": whether to ask is what is checked.
//   DECIDE_REQUEST: everything the choice needs is in the request (B loses confirmed operations on a crash, which it
//   rules out; the extra write costs nothing at this load): the reviewer should choose A in its report, with why, and
//   say whether to merge, without asking.
//   ASK_REQUEST: the choice turns on one fact only the user knows (which customer the service is for, each customer's
//   contract favouring one approach): the reviewer should ask for it, then decide by the answer (ASK_ANSWER: A).
const APPROACHES = '這次的變更是做法 A：先把操作寫進磁碟（先寫暫存檔、再改名），寫完才回覆。另一個做法 B 是先回覆，再每 500 毫秒批次寫一次檔（不在這次的變更裡，只是另一個選項）。';
export const DECIDE_REQUEST = `${APPROACHES}需求：確認成功的操作，在服務程序回覆後立刻崩潰也不能遺失（整台電腦斷電不在範圍）；這個服務一分鐘只有幾十筆操作，多寫一次檔的延遲不是問題。請審查這次的變更，替我在 A、B 之間選一個，並告訴我要不要合併這次的變更。`;
export const ASK_REQUEST = `${APPROACHES}哪個對，取決於這個服務要交給哪個客戶：客戶甲的合約要求確認成功的操作在服務程序崩潰後絕不能遺失（整台電腦斷電不在範圍）；客戶乙的合約要求每筆操作在 1 毫秒內回覆，並接受程序崩潰時遺失最近 0.5 秒內確認的操作。要交給哪個客戶只有我知道，程式碼和文件裡都沒有寫。請審查這次的變更，替我在 A、B 之間選一個。`;
export const ASK_ANSWER = '交給客戶甲：確認成功的操作在服務程序崩潰後絕不能遺失。';
/** The same decisions, listed in the review panel's "decisions you leave to the reviewer" (D1, D2…: Aivenue checks each). */
export const DECIDE_LIST = ['在做法 A、B 之間選一個', '要不要合併這次的變更'];
export const ASK_LIST = ['在做法 A、B 之間選一個'];

/** The first of the two options ("A" / "B") a choice names. */
export const firstOption = (s) => /(?:^|[^A-Za-z0-9])([AB])(?![A-Za-z0-9])/.exec(s ?? '')?.[1];
/** A merge decision that says to merge, not "do not merge" (or "merge after…"). */
export const saysMerge = (s) => /合併|merge/i.test(s ?? '') && !/不\s*(要|建議|應|宜|該|能)?\s*合併|暫(不|緩)\s*合併|先不\s*合併|do not merge|don't merge|not (be )?merged?|hold off/i.test(s ?? '');
/**
 * What the samples state, that a decision must not rest on the opposite of: the base declares one Store per file and
 * nothing else writing it; every request puts power loss out of scope. Read in what a decision says (its choice,
 * reasons and assumptions): a premise that more writers may share the file, or a demand for durability across power
 * loss (a directory sync), goes against them. Stating the condition itself ("one Store per file", "power loss is out
 * of scope") does not.
 */
export const AGAINST = [
  { what: 'more than one writer of the file (the base states one Store per file)', re: /(可能|會|若有|允許|may|might|can|could)[^。；;.\n]{0,24}(多個|兩個|多)\s*(Store|實例|視窗|程序|服務|writer|instance|window|process)|多實例|併發覆寫|concurrent (writ|instance)|multiple (stores|instances|writers)/i },
  // Asked for, or held against the change: "cannot guarantee … power loss", "lost on power loss", "needs a directory
  // sync". Saying the parent directory is not synced, next to "power loss is out of scope", is not (a v5 run).
  {
    what: 'durability across power loss (out of scope in the request)',
    // A requirement said not to be one ("本次不需…fsync 父目錄", "does not need to sync the directory") is not.
    re: /(無法|不能|未能|沒有|不)\s*保證[^。；;\n]{0,24}(斷電|系統崩潰|power loss|power failure)|(斷電|power loss)[^。；;\n]{0,12}(仍|也|會)?[^。；;\n]{0,6}(遺失|lost)|(?<![不無毋免])(需要|需|應|應該|必須|先|補)\s*[^。；;\n]{0,10}(fsync|同步)\s*[^。；;\n]{0,6}目錄|(?<!(not|n't|no) )(should|must|needs?( to)?)\s+[^.;\n]{0,20}(fsync|sync)[^.;\n]{0,12}directory|cannot guarantee[^.;\n]{0,30}power/i,
  },
];
/** Which decisions rest on the opposite of a stated condition: "D2: more than one writer…". */
export const againstStated = (decisions) =>
  decisions.flatMap((d) => AGAINST.filter((a) => a.re.test([d.choice, d.reasons, ...d.assumptions].join('\n'))).map((a) => `${d.id}: ${a.what}`));
