/**
 * Markdown as agents write it (CommonMark with GitHub's tables, task lists and strikethrough), parsed into a small
 * tree that components/Markdown.tsx draws as React elements: no HTML from the text is ever interpreted, so an agent's
 * reply cannot inject markup. Forgiving where agents are loose: a table or a list may follow a paragraph line
 * directly; a code fence inside a list item keeps the list (and its numbering) going; every line break is kept.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong' | 'em' | 'del'; c: Inline[] }
  /** `local`: a file or other non-web target, shown as text with the target on hover (never followed by the page). */
  | { t: 'link'; href: string; local: boolean; c: Inline[] }
  | { t: 'br' };

export type Align = 'left' | 'center' | 'right' | undefined;

export interface ListItem {
  /** A task list item ("- [ ]", "- [x]"). */
  task?: boolean;
  checked?: boolean;
  c: Block[];
}

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'code'; lang?: string; v: string }
  | { t: 'hr' }
  | { t: 'quote'; c: Block[] }
  | { t: 'list'; ordered: boolean; start?: number; items: ListItem[] }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] };

// ---------------------------------------------------------------- blocks

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const LIST = /^( {0,3})([-*+•]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const DELIM_CELL = /^[ \t]*:?-+:?[ \t]*$/;

const indentOf = (s: string) => s.length - s.replace(/^[ \t]+/, '').length;
/** A line with up to `n` columns of its indentation removed. */
const dedent = (s: string, n: number) => {
  let i = 0;
  while (i < n && i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return s.slice(i);
};
const blank = (s: string) => !s.trim();

/** A table row's cells: split on "|" outside code spans and not escaped; the outer pipes are optional. */
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = '';
  let tick = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      tick = tick === n ? 0 : tick || n;
      cur += s.slice(i, i + n);
      i += n - 1;
      continue;
    }
    if (ch === '|' && !tick) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Whether lines[i] and lines[i + 1] open a table: a row with pipes, then a delimiter row with as many cells. */
function tableAt(lines: string[], i: number): boolean {
  const head = lines[i];
  const delim = lines[i + 1];
  if (delim === undefined || !head.includes('|') || indentOf(head) > 3) return false;
  const d = cells(delim);
  if (!d.every((c) => DELIM_CELL.test(c)) || (!delim.includes('|') && d.length < 2)) return false;
  return cells(head).length === d.length;
}

/** Whether a line starts a block of its own (and so ends a paragraph or a lazy continuation). */
function startsBlock(lines: string[], i: number): boolean {
  const l = lines[i];
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || LIST.test(l) || tableAt(lines, i);
}

function listMarker(line: string): { indent: number; marker: string; ordered: boolean; num?: number; content: string; contentCol: number } | undefined {
  const m = LIST.exec(line);
  if (!m) return undefined;
  const [, ind, marker, gap = '', rest = ''] = m;
  // "-" alone is an empty item; "---" is a rule (checked before this).
  const ordered = /\d/.test(marker);
  const spaces = gap.length;
  const contentCol = ind.length + marker.length + (rest ? Math.min(Math.max(spaces, 1), 4) : 1);
  return { indent: ind.length, marker, ordered, num: ordered ? parseInt(marker, 10) : undefined, content: rest, contentCol };
}
/** Two markers of the same list: both bullets, or both numbers with the same delimiter. */
const sameList = (a: string, b: string) => (/\d/.test(a) ? /\d/.test(b) && a.slice(-1) === b.slice(-1) : !/\d/.test(b));

export function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    // A fenced code block (to its closing fence, or to the end).
    const f = FENCE.exec(line);
    if (f) {
      const [, ind, fence, lang] = f;
      const body: string[] = [];
      for (i++; i < lines.length; i++) {
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[i]);
        if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
          i++;
          break;
        }
        body.push(dedent(lines[i], ind.length));
      }
      out.push({ t: 'code', lang: lang || undefined, v: body.join('\n') });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      out.push({ t: 'h', level: h[1].length, c: inline(h[2] ?? '') });
      i++;
      continue;
    }
    if (tableAt(lines, i)) {
      const head = cells(line);
      const align: Align[] = cells(lines[i + 1]).map((c) => {
        const l = c.startsWith(':');
        const r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : undefined;
      });
      const rows: Inline[][][] = [];
      for (i += 2; i < lines.length && !blank(lines[i]) && lines[i].includes('|') && !FENCE.test(lines[i]) && !HEADING.test(lines[i]); i++) {
        const row = cells(lines[i]);
        rows.push(head.map((_, k) => inline(row[k] ?? '')));
      }
      out.push({ t: 'table', align, head: head.map((c) => inline(c)), rows });
      continue;
    }
    if (HR.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    // A block quote: its ">" lines (and lazy continuation lines), parsed again as blocks.
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i]);
        if (q) body.push(q[1]);
        else if (!blank(lines[i]) && body.length && !blank(body[body.length - 1]) && !startsBlock(lines, i)) body.push(lines[i]);
        else break;
        i++;
      }
      out.push({ t: 'quote', c: parseBlocks(body) });
      continue;
    }
    const first = listMarker(line);
    if (first) {
      const list: Block & { t: 'list' } = { t: 'list', ordered: first.ordered, start: first.ordered && first.num !== 1 ? first.num : undefined, items: [] };
      let m: ReturnType<typeof listMarker> = first;
      while (m && i < lines.length) {
        // One item: its first line, then what is indented to its content (or continues its paragraph lazily),
        // with blank lines inside it; a code fence inside it keeps every line until it closes.
        const body: string[] = [m.content];
        let fence: string | undefined;
        let j = i + 1;
        for (; j < lines.length; j++) {
          const l = lines[j];
          if (fence) {
            body.push(dedent(l, m.contentCol));
            if (new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`).test(dedent(l, m.contentCol))) fence = undefined;
            continue;
          }
          if (blank(l)) {
            // A blank line stays in the item only if what follows is still in it.
            let k = j + 1;
            while (k < lines.length && blank(lines[k])) k++;
            if (k < lines.length && indentOf(lines[k]) >= m.contentCol) {
              for (; j < k; j++) body.push('');
              j--;
              continue;
            }
            break;
          }
          if (indentOf(l) >= m.contentCol) {
            const d = dedent(l, m.contentCol);
            const of = FENCE.exec(d);
            if (of) fence = of[2];
            body.push(d);
            continue;
          }
          const next = listMarker(l);
          if (next) break;
          // Lazy continuation of the item's last paragraph line.
          if (!blank(body[body.length - 1]) && !startsBlock(lines, j)) {
            const d = l.trim();
            const of = FENCE.exec(d);
            if (of) break;
            body.push(d);
            continue;
          }
          // A fence at a lesser indent inside an item (agents write "1. text\n```" and indent the closing fence the
          // same): taken into the item when the item has only begun.
          const of = FENCE.exec(l);
          if (of && indentOf(l) > m.indent) {
            fence = of[2];
            body.push(l.trim());
            continue;
          }
          break;
        }
        let task: boolean | undefined;
        let checked: boolean | undefined;
        const tm = /^\[([ xX])\][ \t]+/.exec(body[0]);
        if (tm) {
          task = true;
          checked = tm[1] !== ' ';
          body[0] = body[0].slice(tm[0].length);
        }
        list.items.push({ task, checked, c: parseBlocks(body) });
        i = j;
        // Blank lines between items keep the list going when the next item is of the same list.
        let k = i;
        while (k < lines.length && blank(lines[k])) k++;
        const next = k < lines.length ? listMarker(lines[k]) : undefined;
        if (next && next.indent <= 3 && sameList(next.marker, first.marker) && !HR.test(lines[k])) {
          i = k;
          m = next;
        } else m = undefined;
      }
      out.push(list);
      continue;
    }
    // A paragraph: its lines until a blank line or another block; "===" / "---" under it make it a heading.
    const para: string[] = [line];
    for (i++; i < lines.length && !blank(lines[i]); i++) {
      const s = SETEXT.exec(lines[i]);
      if (s) break;
      if (startsBlock(lines, i)) break;
      para.push(lines[i]);
    }
    const s = i < lines.length ? SETEXT.exec(lines[i]) : null;
    if (s) {
      out.push({ t: 'h', level: s[1][0] === '=' ? 1 : 2, c: inline(para.join('\n')) });
      i++;
      continue;
    }
    out.push({ t: 'p', c: inline(para.join('\n')) });
  }
  return out;
}

export function parseMarkdown(src: string): Block[] {
  return parseBlocks(src.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
}

// ---------------------------------------------------------------- inline

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const WORD = /[\p{L}\p{N}]/u;
const URL_RE = /https?:\/\/[^\s<>"'`]+/y;
const isRemote = (href: string) => /^(https?:\/\/|mailto:)/i.test(href);

/** Inline text: code spans, emphasis, strikethrough, links, bare URLs, `<br>`; every newline is a line break. */
export function inline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };
  const push = (n: Inline) => {
    flush();
    out.push(n);
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length && PUNCT.test(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '\n') {
      push({ t: 'br' });
      i++;
      continue;
    }
    if (ch === '`') {
      let n = 1;
      while (src[i + n] === '`') n++;
      const run = '`'.repeat(n);
      let k = src.indexOf(run, i + n);
      while (k >= 0 && src[k + n] === '`') k = src.indexOf(run, k + n + 1);
      if (k >= 0) {
        let v = src.slice(i + n, k).replace(/\n/g, ' ');
        if (v.length > 2 && v.startsWith(' ') && v.endsWith(' ') && v.trim()) v = v.slice(1, -1);
        push({ t: 'code', v });
        i = k + n;
        continue;
      }
      text += run;
      i += n;
      continue;
    }
    // <br> (agents put it in table cells), <https://…> and <mailto:…>; any other tag stays text.
    if (ch === '<') {
      const br = /^<br\s*\/?>/i.exec(src.slice(i));
      if (br) {
        push({ t: 'br' });
        i += br[0].length;
        continue;
      }
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(src.slice(i));
      if (auto) {
        push({ t: 'link', href: auto[1], local: false, c: [{ t: 'text', v: auto[1].replace(/^mailto:/i, '') }] });
        i += auto[0].length;
        continue;
      }
    }
    // [text](target "title") and ![alt](target): a web link opens in the browser; anything else is a reference.
    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const img = ch === '!';
      const start = img ? i + 1 : i;
      let depth = 0;
      let k = start;
      for (; k < src.length; k++) {
        if (src[k] === '\\') {
          k++;
          continue;
        }
        if (src[k] === '[') depth++;
        else if (src[k] === ']' && --depth === 0) break;
        else if (src[k] === '\n' && src[k + 1] === '\n') break;
      }
      if (src[k] === ']' && src[k + 1] === '(') {
        const m = /^\(\s*<?([^\s()<>]+(?:\([^\s()]*\))?[^\s()<>]*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/.exec(src.slice(k + 1));
        if (m) {
          const href = m[1];
          const label = src.slice(start + 1, k);
          push({ t: 'link', href, local: !isRemote(href), c: label ? inline(label) : [{ t: 'text', v: href }] });
          i = k + 1 + m[0].length;
          continue;
        }
      }
    }
    // A bare web address (trailing punctuation is the sentence's, not the address's).
    if ((ch === 'h' || ch === 'H') && (i === 0 || !WORD.test(src[i - 1]))) {
      URL_RE.lastIndex = i;
      const m = URL_RE.exec(src);
      if (m) {
        let href = m[0];
        while (/[.,;:!?)\]}」』）。，；：！？、]$/.test(href)) {
          if (href.endsWith(')') && (href.match(/\(/g)?.length ?? 0) >= (href.match(/\)/g)?.length ?? 0)) break;
          href = href.slice(0, -1);
        }
        push({ t: 'link', href, local: false, c: [{ t: 'text', v: href }] });
        i += href.length;
        continue;
      }
    }
    // **strong** / __strong__, ~~del~~, *em* / _em_ (an underscore inside a word, as in snake_case, is a letter).
    if (ch === '*' || ch === '_' || ch === '~') {
      const dbl = src[i + 1] === ch;
      if (ch === '~' && !dbl) {
        text += ch;
        i++;
        continue;
      }
      const d = dbl ? ch + ch : ch;
      const after = src[i + d.length];
      const before = i > 0 ? src[i - 1] : ' ';
      const opens = after !== undefined && !/\s/.test(after) && !(ch === '_' && WORD.test(before));
      if (opens) {
        let found = -1;
        for (let k = src.indexOf(d, i + d.length); k >= 0; k = src.indexOf(d, k + 1)) {
          if (k === i + d.length || /\s/.test(src[k - 1])) continue;
          // A closing "_" is not followed by a letter; a single "*" or "_" that belongs to a double one is not the closer.
          if (ch === '_' && k + d.length < src.length && WORD.test(src[k + d.length])) continue;
          if (!dbl && (src[k + 1] === ch || src[k - 1] === ch)) continue;
          found = k;
          break;
        }
        if (found >= 0) {
          push({ t: ch === '~' ? 'del' : dbl ? 'strong' : 'em', c: inline(src.slice(i + d.length, found)) });
          i = found + d.length;
          continue;
        }
      }
      text += d;
      i += d.length;
      continue;
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

/** Plain text of inline content (for titles and tests). */
export const plain = (c: Inline[]): string => c.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'br' ? '\n' : plain(n.c))).join('');
