/**
 * "Not found in the source": explicit references a model-written summary makes that the material it was written from
 * does not contain (docs/next-task-skills-integration.md; after context-compression, which warns that summaries can
 * state plausible details that never appeared). Only explicit paths (with a file extension), Aivenue issue ids
 * (R1, V2, D3, M4) and record ids (agent ids, PR thread ids, comment ids) are checked; ordinary code names are not.
 * Not found is not "made up": a summary may rightly name a new file or name for a next step, so each item says whether
 * it is stated as done or existing, or named as something to add — and the range of the source it was checked against.
 */

export interface NotFound {
  ref: string;
  kind: 'path' | 'issue' | 'record';
  /** "stated": written as done or existing; "proposed": named as a next step or something new to add. */
  as: 'stated' | 'proposed';
  /** The summary line it is on (shortened). */
  line: string;
}

const PATH = /(?:[A-Za-z]:)?(?:[\w.-]+[\\/])*[\w-][\w.-]*\.(?:tsx?|jsx?|mjs|cjs|json|md|py|go|rs|java|kt|cs|cpp|h|css|scss|html|vue|svelte|ya?ml|toml|ini|sh|ps1|bat|sql|txt|csv|lock|gno|mod|sum)\b/g;
const ISSUE = /\b[RVDM]\d{1,3}\b/g;
const RECORD = /\b(?:PRRT?_[\w-]{6,}|discussion_r\d+|pullrequestreview-\d+|[0-9a-f]{8}-[0-9a-f]{3})\b/g;
// A section or a line about what is still to do, or wording that names something new.
const LATER_SECTION = /still to do|next steps?|to do|todo|remaining|plan|proposal|recommend|建議|下一步|待辦|尚待|計畫/i;
const PROPOSE = /\b(add|adding|create|creating|new|introduce|rename|will|should|next|propose[sd]?|plan(?:ned)? to|could|would|later)\b|新增|建立|改名|改為|將會|應該|建議|下一步|之後/i;

const norm = (s: string) => s.replace(/\\/g, '/');

/** The explicit references in `summary` that none of `sources` contains, each with how the summary uses it. */
export function notFoundInSource(summary: string, sources: (string | undefined)[]): NotFound[] {
  const source = norm(sources.filter(Boolean).join('\n'));
  const lines = summary.split('\n');
  const found: NotFound[] = [];
  const seen = new Set<string>();
  let section = '';
  for (const raw of lines) {
    if (/^#{1,4}\s/.test(raw)) section = raw;
    const refs: [string, NotFound['kind']][] = [
      ...[...raw.matchAll(PATH)].map((m) => [m[0], 'path'] as [string, NotFound['kind']]),
      ...[...raw.matchAll(ISSUE)].map((m) => [m[0], 'issue'] as [string, NotFound['kind']]),
      ...[...raw.matchAll(RECORD)].map((m) => [m[0], 'record'] as [string, NotFound['kind']]),
    ];
    for (const [ref, kind] of refs) {
      const key = norm(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      if (source.includes(key)) continue;
      // A path written relative to a folder the source names in full, or the other way round.
      if (kind === 'path' && key.includes('/') && source.includes(key.split('/').slice(-2).join('/'))) continue;
      const proposed = LATER_SECTION.test(section) || PROPOSE.test(raw);
      found.push({ ref, kind, as: proposed ? 'proposed' : 'stated', line: raw.trim().slice(0, 160) });
    }
  }
  return found;
}

/** The note that follows a summary: what was not found, how it is used, and what it was checked against. */
export function notFoundBlock(items: NotFound[], range: string): string {
  if (!items.length) return '';
  // At most a dozen, those written as done first: the note stays small.
  const shown = [...items.filter((i) => i.as === 'stated'), ...items.filter((i) => i.as === 'proposed')].slice(0, 12);
  return [
    `NOT FOUND IN THE SOURCE (checked by Aivenue against ${range}; only explicit paths, issue ids and record ids are checked). Not necessarily wrong:`,
    ...shown.map((i) =>
      i.as === 'stated'
        ? `- \`${i.ref}\` — written as done or existing: check it before relying on it ("${i.line.slice(0, 120)}")`
        : `- \`${i.ref}\` — named as a next step or something new (a new name can be expected) ("${i.line.slice(0, 120)}")`,
    ),
    ...(items.length > shown.length ? [`- (${items.length - shown.length} more not shown)`] : []),
  ].join('\n');
}
