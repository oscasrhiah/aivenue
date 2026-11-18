/**
 * The decisions a user lists for an independent reviewer ("Decisions you leave to the reviewer", one per line): at most
 * DECIDE_MAX, each at most DECIDE_ITEM_MAX characters. Past either, nothing is dropped or cut, which would let a report
 * that leaves one out pass: the page names the lines before sending, and the hub refuses the review (reviewTarget.ts).
 * Kept free of Node so the page uses the same rules and words.
 */

export const DECIDE_MAX = 10;
export const DECIDE_ITEM_MAX = 500;

/** What the field holds: its lines (as the page keeps them) or one text; blank lines are not decisions. */
type Field = readonly unknown[] | string | undefined | null;

const lines = (v: Field): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : '')) : typeof v === 'string' ? v.split('\n') : []);

/** The decisions as listed: each line trimmed, blank lines left out, none dropped or cut. */
export function decideItems(v: Field): string[] {
  return lines(v)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** A line over a limit: `line` counts every line of the field (blank ones too), as the user sees them. */
export interface DecideProblem {
  line: number;
  /** "count": past the DECIDE_MAX-th decision; "length": longer than DECIDE_ITEM_MAX. */
  why: 'count' | 'length';
  /** Which decision it is (1-based, blank lines not counted). */
  item: number;
  length: number;
}

/** Every line over a limit, in order; none: the list can be sent. */
export function decideProblems(v: Field): DecideProblem[] {
  const out: DecideProblem[] = [];
  let item = 0;
  lines(v).forEach((raw, i) => {
    const text = raw.trim();
    if (!text) return;
    item++;
    if (item > DECIDE_MAX) out.push({ line: i + 1, why: 'count', item, length: text.length });
    if (text.length > DECIDE_ITEM_MAX) out.push({ line: i + 1, why: 'length', item, length: text.length });
  });
  return out;
}

/** What to tell the user: the limits, then each line over one. `t`: the page's or the hub's language picker. */
export function decideProblemText(t: (zh: string, en: string) => string, problems: DecideProblem[]): string {
  const count = problems.filter((p) => p.why === 'count');
  const long = problems.filter((p) => p.why === 'length');
  const parts: string[] = [];
  if (count.length)
    parts.push(
      t(
        `最多 ${DECIDE_MAX} 項，目前有 ${DECIDE_MAX + count.length} 項；超過的是第 ${count.map((p) => p.line).join('、')} 行`,
        `at most ${DECIDE_MAX}, there are ${DECIDE_MAX + count.length}; past the limit: line${count.length > 1 ? 's' : ''} ${count.map((p) => p.line).join(', ')}`,
      ),
    );
  if (long.length)
    parts.push(
      t(
        `每項最多 ${DECIDE_ITEM_MAX} 字；${long.map((p) => `第 ${p.line} 行有 ${p.length} 字`).join('、')}`,
        `each at most ${DECIDE_ITEM_MAX} characters; ${long.map((p) => `line ${p.line} has ${p.length}`).join(', ')}`,
      ),
    );
  return t(`「要審查者決定的事」超過上限：${parts.join('；')}。請修改後再送出，Aivenue 不會自動刪減。`, `"Decisions you leave to the reviewer" is over its limits: ${parts.join('; ')}. Edit it and send again; Aivenue does not cut it for you.`);
}
