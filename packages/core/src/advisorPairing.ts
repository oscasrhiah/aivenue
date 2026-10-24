/**
 * Which advisor models Claude Code attaches to which main models (its native `--advisor`), after the pairing table in
 * https://code.claude.com/docs/en/advisor.md#choose-an-advisor-model. An advisor must rank at or above the main model;
 * a weaker one is silently not attached. Pure (no Node imports), so the UI uses it too.
 */

type Family = 'haiku' | 'sonnet' | 'opus' | 'fable';
interface ClaudeModel {
  family: Family;
  version: number;
}

/** What the aliases (opus, sonnet…) resolve to in current Claude Code releases. */
const ALIAS_VERSION: Record<Family, number> = { fable: 5.1, opus: 5.5, sonnet: 5.5, haiku: 5.5 };

/** "claude-opus-5-5", "opus", "claude-haiku-4-5-20251001", "claude-opus-4-6-thinking" → family + version. */
export function parseClaudeModel(model?: string): ClaudeModel | undefined {
  const s = model?.toLowerCase().trim();
  if (!s) return undefined;
  const family = (['fable', 'opus', 'sonnet', 'haiku'] as Family[]).find((f) => s.includes(f));
  if (!family) return undefined;
  const v = /^[-.]?(\d+)(?:[-.](\d{1,2})(?!\d))?/.exec(s.slice(s.indexOf(family) + family.length));
  return { family, version: v ? Number(v[1]) + (v[2] ? Number(v[2]) / 10 : 0) : ALIAS_VERSION[family] };
}

export type AdvisorPairing =
  /** Claude Code attaches the advisor. */
  | 'ok'
  /** The advisor ranks below the main model: the agent runs without it. */
  | 'weaker'
  /** This model cannot act as an advisor at all (e.g. Haiku 4.5): Claude Code refuses to start. */
  | 'not-advisor'
  /** The main model does not support the advisor: Claude Code refuses to start. */
  | 'main-unsupported'
  /** Not a model we can place (CLI default, unknown name): say nothing. */
  | 'unknown';

export function advisorPairing(main?: string, advisor?: string): AdvisorPairing {
  const m = parseClaudeModel(main);
  const a = parseClaudeModel(advisor);
  if (!m || !a) return 'unknown';
  if (a.family === 'haiku' && a.version < 5.5) return 'not-advisor';
  const is = (f: Family, min = 0) => a.family === f && a.version >= min - 1e-9;
  const v = m.version + 1e-9;
  let ok: boolean;
  if (m.family === 'fable') ok = m.version >= 5.1 - 1e-9 ? is('fable', 5.1) : is('fable', 5);
  else if (a.family === 'fable') ok = true;
  else if (m.family === 'opus' && v >= 5) ok = is('opus', 5);
  else if (m.family === 'sonnet' && v >= 5.5) ok = is('opus', 5) || is('sonnet', 5.5);
  else if (m.family === 'opus' && v >= 4.7) ok = is('opus', 4.7) || is('sonnet', 5.5);
  else if ((m.family === 'sonnet' && v >= 5) || (m.family === 'haiku' && v >= 5.5)) ok = is('opus', 4.7) || is('sonnet', 5) || is('haiku', 5.5);
  else if (m.family === 'opus' && v >= 4.6) ok = is('opus') || is('sonnet', 5) || is('haiku', 5.5);
  else if ((m.family === 'sonnet' && v >= 4.6) || (m.family === 'haiku' && v >= 4.5)) ok = is('opus') || is('sonnet') || is('haiku', 5.5);
  else return 'main-unsupported';
  return ok ? 'ok' : 'weaker';
}
