// One term per concept (docs/terms.md): fails when a retired term comes back in what the user reads. Scans every string
// literal of packages/ui/src and of packages/core/src (comments and regular expressions are skipped), and the text
// between JSX tags of the .tsx files. Each literal knows whether it is the first (zh-TW) or second (English) argument of
// a t()/L() call:
//   - zh-TW copy (a literal with Chinese in it, not the English argument): every retired term of the table;
//   - a literal without Chinese that is not the English argument (a label written outside t(), the zh-TW argument, a
//     template whose placeholders are t()/L() calls): the retired English words zh-TW copy no longer uses ("Sub agent",
//     "Agent map"), ＝ ≠ →, and full-width punctuation that would show in the English UI too;
//   - English copy (the second argument): "shared memory" and ＝ ≠ →.
// What is sent to agents (prompts, tool descriptions) is left out, as are the places where a word means something else
// (代理伺服器: a network proxy).
//   node --test scripts/test-terms.mjs
import { test } from './lib/test-shard.mjs';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** The retired terms of docs/terms.md, in zh-TW copy: [what it was, the pattern, the term to use]. */
const RETIRED = [
  ['完全 Auto', /完全\s*Auto/, '全自動'],
  ['Plan 唯讀', /Plan\s*唯讀/, '唯讀規劃'],
  ['Agent map (in zh-TW)', /Agent\s*map/i, '分工圖'],
  ['agent 地圖', /agent\s*地圖/i, '分工圖'],
  ['協作圖', /協作圖/, '分工圖'],
  ['sub agent (in zh-TW)', /\bsub[ -]?agents?\b/i, '子 agent'],
  ['子代理', /子代理/, '子 agent'],
  ['代理 for agent', /代理(?!伺服器)/, 'agent（代理只用在代理伺服器）'],
  ['智能體／代理人', /智能體|代理人/, 'agent'],
  ['達標／未達標', /達標/, '未完成（工作流）、達成／未達成（驗收指標）'],
  ['本輪結束，目標未達成', /本輪結束，目標未達成/, '本輪未完成'],
  ['以編輯工具改', /以編輯工具改/, '改了 N 個檔案'],
  ['worktree 副本／獨立副本／工作樹', /worktree\s*副本|獨立的?副本|工作樹/, '隔離副本'],
  ['需要修改', /需要修改/, '要求修改'],
  ['沒看到檢查', /沒看到檢查(?!任)/, '尚未執行檢查'],
  ['N 項檢查通過', /項檢查(?:通過|失敗)/, '檢查通過 N 項／檢查失敗 N 項'],
  // 「用時 12s」, a label 「用時」: not 「費用時」「使用時」.
  ['用時', /(?<!\p{Script=Han})用時|用時(?=\s*[\d$])/u, '耗時'],
  ['程式審查', /程式審查/, '審查程式碼／程式碼審查者'],
  ['計畫撰寫／規劃者／撰寫者', /計畫撰寫|規劃者|撰寫者/, '撰寫計畫／計畫者／作者'],
  ['續接', /續接/, '接續'],
  ['思考程度', /思考程度/, '推理強度'],
  // 「推理強度」 only; 「輸出含推理」 (reasoning tokens) is allowed below.
  ['推理 alone', /推理(?!強度)/, '推理強度'],
  ['共用記憶／共享', /共用記憶|共享/, '共用上下文、共用知識（字首：共用）'],
  ['技能', /技能/, 'Skill'],
  ['Pull Request (in zh-TW)', /Pull Request/, 'PR'],
  ['插件', /插件/, '擴充功能'],
  ['調用', /調用/, '使用'],
  ['打開', /打開/, '開啟'],
  ['中止', /中止/, '停止'],
  ['已取消', /已取消/, '已停止'],
  ['＝ ≠ → in zh-TW copy', /[＝≠→⇒]/, 'words: 「設定的記憶頁」, 「壓到」'],
];

/** In a literal without Chinese that is not English copy: what zh-TW users would read as it is. */
const RETIRED_ASCII = [
  ['Sub agent (outside the English argument)', /\b[Ss]ub agents?\b/, '子 agent (zh-TW) / sub-agent (English, in t()/L())'],
  ['Agent map (outside the English argument)', /\b[Aa]gent map\b/, '分工圖 (zh-TW) / Agent map (English, in t()/L())'],
  ['＝ ≠ → (outside the English argument)', /[＝≠→⇒]/, 'words'],
  ['full-width punctuation outside t()/L()', /[，：、；。（）]/, "the separator inside t(), e.g. t('，', ', ') (JSX text)"],
];

/** In English copy (the second argument of t()/L()). */
const RETIRED_EN = [
  ['shared memory (English)', /shared memory/i, 'shared context'],
  ['＝ ≠ → in English copy', /[＝≠→⇒]/, 'words: "down to", "in the GitHub section of Settings"'],
];

/** Files whose strings go to agents, not to the user (prompts, tool descriptions, the agents' own instructions). */
const AGENT_FACING = new Set(['core/src/prompts.ts', 'core/src/hubTools.ts', 'core/src/skills/builtin.ts', 'core/src/instructions.ts']);

/** Literals allowed to keep a match, with why: [file, the retired term's name, a part of the literal]. */
const ALLOW = [
  // Reasoning tokens are part of the output: a column and its explanation, not the effort setting.
  ['ui/src/components/Cost.tsx', '推理 alone', '輸出含推理'],
  ['ui/src/components/Cost.tsx', '推理 alone', '推理是輸出的一部分'],
  // English written for the agents (the shared context, the records, a follow-up's goal, what to tell the user), not
  // the user's copy: arrows there are the agents' notation.
  ['core/src/context.ts', '＝ ≠ → (outside the English argument)', ''],
  ['core/src/ledger.ts', '＝ ≠ → (outside the English argument)', ''],
  ['ui/src/followUp.ts', '＝ ≠ → (outside the English argument)', ''],
  ['core/src/ciDiagnose.ts', '＝ ≠ → (outside the English argument)', 'Ask the user to sign in'],
  ['core/src/prReviews.ts', '＝ ≠ → (outside the English argument)', 'Ask the user to sign in'],
];

/** Where a literal sits: the zh-TW (first) or English (second) argument of t()/L(), or anywhere else. */
const ROLE = { zh: 'zh', en: 'en', other: 'other' };

/**
 * Every string literal of a TS/TSX source with its line and role, comments and regular expressions skipped. A template
 * literal is one literal with each `${…}` as a placeholder (`tl`: one of them calls t()/L()); the strings inside its
 * expressions are literals of their own.
 */
export function literals(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  // A slash starts a regular expression where an expression may start: after these characters or keywords (not after <
  // or >, where it closes a JSX tag).
  const regexAfter = (prev) => prev === '' || /[(,=:[!&|?{};+\-*%~^]$/.test(prev) || /(?:^|[^\w$])(?:return|typeof|case|of|in|=>)$/.test(prev);
  const quoted = (q) => {
    const start = line;
    let s = '';
    i++;
    while (i < n && src[i] !== q) {
      if (src[i] === '\\') {
        s += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (src[i] === '\n') line++;
      s += src[i++];
    }
    i++;
    return { text: s, line: start };
  };
  const template = () => {
    const start = line;
    let s = '';
    let tl = false;
    i++;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') {
        s += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        const from = i;
        code(true);
        if (/(?:^|[^\w$.])[tL]\(/.test(src.slice(from, i))) tl = true;
        s += '${…}';
        continue;
      }
      if (src[i] === '\n') line++;
      s += src[i++];
    }
    i++;
    return { text: s, line: start, tl };
  };
  // The name called by a "(" at i: t or L (not obj.t).
  const callee = () => {
    let j = i - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    const end = j + 1;
    while (j >= 0 && /[\w$]/.test(src[j])) j--;
    const name = src.slice(j + 1, end);
    return (name === 't' || name === 'L') && src[j] !== '.';
  };
  // Code up to the end (or, inside `${…}`, to its closing brace): strings and templates collected, the rest skipped.
  const code = (inExpr) => {
    const stack = [];
    let prev = '';
    const role = () => {
      const top = stack.at(-1);
      return top?.tl ? (top.arg === 0 ? ROLE.zh : top.arg === 1 ? ROLE.en : ROLE.other) : ROLE.other;
    };
    while (i < n) {
      const c = src[i];
      if (c === '\n') {
        line++;
        i++;
        continue;
      }
      if (/\s/.test(c)) {
        i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '/') {
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end < 0 ? n : end + 2;
        for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
        i = stop;
        continue;
      }
      if (c === '/' && regexAfter(prev)) {
        i++;
        let cls = false;
        while (i < n && src[i] !== '\n') {
          if (src[i] === '\\') i += 2;
          else if (src[i] === '[') (cls = true), i++;
          else if (src[i] === ']') (cls = false), i++;
          else if (src[i] === '/' && !cls) break;
          else i++;
        }
        if (src[i] === '/') i++;
        while (/[a-z]/i.test(src[i] ?? '')) i++;
        prev = 'x';
        continue;
      }
      if (c === "'" || c === '"') {
        const r = role();
        out.push({ ...quoted(c), role: r });
        prev = 'x';
        continue;
      }
      if (c === '`') {
        const r = role();
        out.push({ ...template(), role: r });
        prev = 'x';
        continue;
      }
      if (c === '(' || c === '[' || c === '{') stack.push({ tl: c === '(' && callee(), arg: 0 });
      else if (c === ')' || c === ']') stack.pop();
      else if (c === '}') {
        if (inExpr && !stack.length) {
          i++;
          return;
        }
        stack.pop();
      } else if (c === ',' && stack.length) stack.at(-1).arg++;
      prev = (prev + c).slice(-12);
      i++;
    }
  };
  code(false);
  return out;
}

/**
 * The text of a .tsx source's JSX, with its line; comments are left out first. Between tags (`>text<`, no braces) it is
 * checked for every retired term; next to an expression (`}，{`, `>，{`, `}：<`) only for full-width punctuation, which
 * then shows in the English UI too.
 */
export function jsxTexts(src) {
  const out = [];
  const lines = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).split('\n');
  lines.forEach((l, k) => {
    const code = l.replace(/(^|[^:'"`])\/\/.*$/, '$1');
    for (const m of code.matchAll(/>([^<>{}]*)</g)) {
      const text = m[1].trim();
      if (text && /[\p{L}\p{P}]/u.test(text)) out.push({ text, line: k + 1, role: ROLE.other, jsx: true });
    }
    // Next to an expression; not a template's own text (`${a}：${b}`, which ends in "$"), nor inside quotes.
    for (const m of code.matchAll(/[>}]([^<>{}'"`]*)[<{]/g)) {
      const text = m[1];
      if (!text.endsWith('$') && !/^>[^<>{}]*<$/.test(m[0]) && FULL_WIDTH.test(text)) out.push({ text: text.trim(), line: k + 1, role: ROLE.other, jsx: true, punct: true });
    }
  });
  return out;
}

const FULL_WIDTH = /[，：、；。（）]/;

function sources(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const HAN = /\p{Script=Han}/u;

/** What a literal of a source would flag: [the retired term's name, what to use]. */
export function flags(lit) {
  if (lit.punct) return RETIRED_ASCII.filter(([name]) => name.startsWith('full-width'));
  if (lit.role === ROLE.en) return RETIRED_EN.filter(([, re]) => re.test(lit.text));
  if (HAN.test(lit.text)) return RETIRED.filter(([, re]) => re.test(lit.text));
  // Full-width punctuation is looked for in JSX text only (above): in a string it is often the zh-TW side of a choice
  // made in code.
  return RETIRED_ASCII.filter(([name, re]) => (lit.jsx || !name.startsWith('full-width')) && re.test(lit.text));
}

function findings() {
  const found = [];
  for (const pkg of ['ui', 'core']) {
    for (const file of sources(path.join(root, 'packages', pkg, 'src'))) {
      const rel = path.relative(path.join(root, 'packages'), file).replace(/\\/g, '/');
      if (AGENT_FACING.has(rel)) continue;
      const src = fs.readFileSync(file, 'utf8');
      const all = [...literals(src), ...(file.endsWith('.tsx') ? jsxTexts(src) : [])];
      for (const lit of all) {
        for (const [name, , use] of flags(lit)) {
          if (ALLOW.some(([f, n, part]) => f === rel && n === name && lit.text.includes(part))) continue;
          found.push(`${rel}:${lit.line} ${name} (use ${use}): ${lit.text.replace(/\s+/g, ' ').slice(0, 90)}`);
        }
      }
    }
  }
  return found;
}

test('用詞表：退場的用詞沒有回到介面與對話文字（docs/terms.md）', () => {
  const found = findings();
  assert.deepEqual(found, [], `退場的用詞又出現了：\n${found.join('\n')}`);
});

test('用詞表的掃描：讀得到字串、跳過註解與正規表示式，模板字串裡的字串也算', () => {
  const lits = literals("// 子代理 in a comment\nconst a = t('子 agent', 'Sub-agent'); /* 協作圖 */ const r = /'協作圖'/; const b = `分工圖 ${x ? '完全 Auto' : ''}`;");
  const texts = lits.map((l) => l.text);
  assert.ok(texts.includes('子 agent') && texts.includes('Sub-agent'));
  assert.ok(texts.includes('完全 Auto'), texts.join(' | '));
  assert.ok(!texts.some((s) => /子代理|協作圖/.test(s)), texts.join(' | '));
  // A template's own text keeps a placeholder for each expression; a regular expression inside one is skipped.
  const more = literals("const c = `前 ${p.replace(/'/g, '')} 後 ${t('子 agent', 'Sub-agents')}`; const d = 'x';").map((l) => l.text);
  assert.deepEqual(more, ['', '子 agent', 'Sub-agents', '前 ${…} 後 ${…}', 'x']);
});

test('用詞表的掃描：t()/L() 的第二個參數是英文；其他地方的英文舊詞、JSX 文字與 t() 外的全形標點也會被找到', () => {
  const roles = literals("t('子 agent', 'Sub-agents'); L(`a ${x}`, `b ${y}`); f('x', 'y'); o.t('p', 'q')").map((l) => `${l.text}:${l.role}`);
  assert.deepEqual(roles, ['子 agent:zh', 'Sub-agents:en', 'a ${…}:zh', 'b ${…}:en', 'x:other', 'y:other', 'p:other', 'q:other']);
  const hit = (s) => [...literals(s), ...jsxTexts(s)].flatMap((l) => flags(l).map(([name]) => name));
  // The forms round D removed: an English label outside t(), a JSX prop, JSX text, a title.
  assert.ok(hit("return subTitle(a) || 'Sub agent';").some((n) => n.startsWith('Sub agent')));
  assert.ok(hit('<Switch label="Sub agents" />').some((n) => n.startsWith('Sub agent')));
  assert.ok(hit('<h4 className="sect-title">Sub agents</h4>').some((n) => n.startsWith('Sub agent')));
  assert.ok(hit("title={open ? t('分工圖', 'Agent map') : 'Agent map'}").some((n) => n.startsWith('Agent map')));
  assert.ok(hit('<span className="am-open-label">Agent map</span>').some((n) => n.startsWith('Agent map')));
  // English copy keeps its own terms; an arrow next to a t()/L() placeholder, full-width punctuation outside t().
  assert.deepEqual(hit("t('分工圖', 'Agent map'); t('子 agent', 'sub-agent'); t('、', ', ')"), []);
  assert.ok(hit("const n = `${L('顧問建議', 'Advisor')} → ${who}`;").some((n) => n.startsWith('＝ ≠ →')));
  assert.ok(hit('<b>{t(a, b)}</b>：<span>{x}</span>').some((n) => n.startsWith('full-width')));
  assert.ok(hit("L('更新共用上下文', 'Update the shared memory')").includes('shared memory (English)'));
  assert.ok(hit("t('推理', 'Effort')").includes('推理 alone'));
  assert.deepEqual(hit("t('推理強度', 'Effort')"), []);
});
