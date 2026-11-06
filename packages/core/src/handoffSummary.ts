/**
 * The hand-off summary of a conversation that cannot be compacted from outside (its next turn starts a fresh
 * conversation from it): the model writes only what the conversation shows; Aivenue attaches its own records and
 * says which explicit references it could not find in the source. Kept within a size budget.
 * docs/next-task-skills-integration.md (context-compression, first version).
 */
import type { AgentEvent, AgentRunInfo, WorkflowRun } from './types';
import { handoffRecords } from './context';
import { estimateTokens } from './agentContext';
import { handoffSummaryPrompt } from './prompts';
import { notFoundBlock, notFoundInSource, type NotFound } from './sourceCheck';

/**
 * A hand-off that could not be made within its ceiling (the required items alone do not fit): nothing is replaced,
 * the conversation stays as it was.
 */
export interface HandoffNotMade {
  ok: false;
  reason: string;
  /** What the smallest possible hand-off would take, and the ceiling. */
  tokens: number;
  budget: number;
}

export interface HandoffSummary {
  ok: true;
  /** What the next conversation starts from: the summary, Aivenue's records, and the not-found note. */
  text: string;
  summary: string;
  records: string;
  notFound: NotFound[];
  /** Items the summary dropped even after a second try, or lost to the cut (kept word for word at its end). */
  missing: string[];
  /** The estimated size of `text`, and the ceiling it is held to. */
  tokens: number;
  budget: number;
}

export async function writeHandoffSummary(o: {
  run: WorkflowRun;
  info: AgentRunInfo;
  /** The agents whose turns make up this conversation. */
  ids: Set<string>;
  eventsOf: (agentId: string) => AgentEvent[];
  transcript: string;
  label: string;
  /** Runs the compactor on a prompt and returns its text. */
  compact: (prompt: string) => Promise<string>;
  /** Identifiers the summary must keep (paths, issue ids found in the transcript). */
  required: string[];
  /** What the source covers, for the not-found note. */
  range: string;
  totalTokens?: number;
  recordsChars?: number;
  at?: number;
}): Promise<HandoffSummary | HandoffNotMade> {
  const total = o.totalTokens ?? 3000;
  const hard = Math.round(total * 1.5);
  const kept = (items: string[]) => (items.length ? `\n\n## Kept verbatim\n${items.map((m) => `- ${m}`).join('\n')}` : '');
  // The records take at most 3/4 of the total (rebuilt smaller when their text counts more tokens, e.g. CJK).
  let chars = o.recordsChars ?? 4800;
  let records = handoffRecords(o.run, o.info, o.ids, o.eventsOf, chars, o.at);
  const floor = () => estimateTokens(records) + estimateTokens(kept(o.required.filter((r) => !records.includes(r)))) + MIN_SUMMARY + NOT_FOUND_RESERVE;
  while ((estimateTokens(records) > total * 0.75 || floor() > hard) && chars > 800) {
    chars = Math.max(800, Math.floor(chars * 0.7));
    records = handoffRecords(o.run, o.info, o.ids, o.eventsOf, chars, o.at);
    if (chars === 800) break;
  }
  // The smallest hand-off that keeps everything required does not fit: say so, and replace nothing (no model call).
  if (floor() > hard)
    return { ok: false, reason: `the items that must be kept (${o.required.length}) do not fit in the hand-off's ceiling of about ${hard} tokens (the smallest hand-off would take about ${floor()})`, tokens: floor(), budget: hard };
  // The records take their share first; the model's part gets the rest, never less than a useful minimum.
  const target = Math.max(800, total - estimateTokens(records));
  // What the records already carry word for word need not be in the model's part.
  const need = o.required.filter((r) => !records.includes(r));
  let summary = (await o.compact(handoffSummaryPrompt(o.label, o.transcript, target, records || undefined))).trim();
  let missing = need.filter((r) => !summary.includes(r));
  if (missing.length) {
    summary = (await o.compact(handoffSummaryPrompt(o.label, o.transcript, target, records || undefined, missing))).trim();
    missing = need.filter((r) => !summary.includes(r));
  }
  // The whole hand-off has a hard ceiling. The model's part is cut to fit it, leaving room for what the cut may take
  // away (the required items, put back word for word) and for the not-found note; what is missing is decided after
  // the cut, on the text that is kept.
  const body = summary;
  let allowance = Math.min(Math.round(target * 1.5), hard - estimateTokens(records) - estimateTokens(kept(need)) - NOT_FOUND_RESERVE);
  let text = '';
  let notFound: NotFound[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    summary = cutTo(body, Math.max(MIN_SUMMARY, allowance));
    missing = need.filter((r) => !summary.includes(r));
    summary += kept(missing);
    notFound = notFoundInSource(summary, [o.transcript, records, o.run.config.goal, o.run.plan?.markdown]);
    text = [summary, records, notFoundBlock(notFound, o.range)].filter(Boolean).join('\n\n');
    const over = estimateTokens(text) - hard;
    if (over <= 0 || allowance <= MIN_SUMMARY) break;
    allowance -= over + 20;
  }
  // Never hand over more than the ceiling: when even the smallest cut does not fit, nothing is replaced.
  if (estimateTokens(text) > hard) return { ok: false, reason: `the hand-off would take about ${estimateTokens(text)} tokens, over its ceiling of about ${hard}`, tokens: estimateTokens(text), budget: hard };
  return { ok: true, text, summary, records, notFound, missing, tokens: estimateTokens(text), budget: hard };
}

/** Room kept for the not-found note (it lists at most a dozen items). */
const NOT_FOUND_RESERVE = 300;
/** The model's part is never cut below this. */
const MIN_SUMMARY = 300;

/** `text` cut to at most `limit` tokens (estimated), with a note where it was cut; unchanged when it fits. */
function cutTo(text: string, limit: number): string {
  if (estimateTokens(text) <= limit) return text;
  let n = Math.floor(text.length * (limit / estimateTokens(text)));
  while (n > 0 && estimateTokens(text.slice(0, n)) > limit - 15) n = Math.floor(n * 0.9);
  return `${text.slice(0, n).trimEnd()}\n(the summary ran over its budget and was cut here)`;
}
