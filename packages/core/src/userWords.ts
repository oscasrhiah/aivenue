/**
 * The user's own words across the messages of one conversation, kept verbatim by Aivenue and carried from each
 * message to the next — so a constraint from an early message does not depend on a summary model keeping it
 * (docs/next-task-skills-integration.md, context-compression). Kept apart from what Aivenue adds to a follow-up's goal
 * (the earlier task's outcome), so an agent's account is never taken for the user's word.
 *
 * In prompts: the earlier messages, whole (never cut inside a message), oldest first with their times, newest kept
 * first when they do not all fit — and then an explicit "incomplete" line naming what is left out and how to read it.
 */
import type { UserWords, WorkflowRun } from './types';

/** This message's own words: the request that started it, and the messages sent while it ran. */
export function ownUserWords(run: WorkflowRun): UserWords[] {
  const request: UserWords = {
    id: `g:${run.id}`,
    runId: run.id,
    ts: run.createdAt,
    text: (run.config.userText ?? run.config.goal).trim(),
    kind: 'request',
    ...(run.config.userTextNote ? { note: run.config.userTextNote } : run.config.userText === undefined && run.config.continueFrom ? { note: 'saved before the user\'s words were kept apart: may include context Aivenue added' } : {}),
  };
  const messages: UserWords[] = (run.userMessages ?? []).map((m) => ({ id: `u:${m.ts}`, runId: run.id, ts: m.ts, text: m.text.trim(), kind: 'message' }));
  return [request, ...messages].filter((w) => w.text);
}

/** Every piece of the user's words in the conversation up to and including this message, oldest first. */
export function conversationUserWords(run: WorkflowRun): UserWords[] {
  return [...(run.earlierUserWords ?? []), ...ownUserWords(run)].sort((a, b) => a.ts - b.ts);
}

/** A follow-up carries the user's words of everything before it. */
export function carryUserWords(prev: WorkflowRun, run: WorkflowRun) {
  run.earlierUserWords = conversationUserWords(prev).map((w) => ({ ...w }));
}

const iso = (t: number) => `${new Date(t).toISOString().slice(0, 16)}Z`;
const line = (w: UserWords) => `- [${w.id}] ${iso(w.ts)} ${w.kind}${w.note ? ` (${w.note})` : ''}: "${w.text}"`;

/**
 * The earlier messages for a prompt, within `budget` characters: whole messages only, newest kept first, shown
 * oldest first. What does not fit is named with its time and size, and how to read it.
 */
export function earlierUserWordsBlock(run: WorkflowRun, budget: number): { text: string; shown: string[]; omitted: UserWords[] } {
  const words = run.earlierUserWords ?? [];
  if (!words.length) return { text: '', shown: [], omitted: [] };
  const head =
    "THE USER'S EARLIER MESSAGES IN THIS CONVERSATION (their own words, verbatim, oldest first — saved by Aivenue, not summarized. A later message, the current request included, may change an earlier one: when they disagree, the later one holds):";
  // The whole block — heading, messages, the list of what is left out and how to read it — stays within `budget`.
  // Room is kept for the "incomplete" line first; whole messages fill the rest, newest first.
  const incomplete = (left: UserWords[], room: number) => {
    const intro = `INCOMPLETE: ${left.length} earlier message(s) of the user are not shown here for space`;
    const tail = `. Their constraints may still hold: read them with read_context {topic: "user"} (all of them) or {topic: "user", from: "<id>"} (that one and later) before relying on what is shown.`;
    const named: string[] = [];
    let size = intro.length + tail.length + 40;
    for (const w of [...left].sort((a, b) => b.ts - a.ts)) {
      const item = `[${w.id}] ${iso(w.ts)} (${w.text.length} characters)`;
      if (size + item.length + 2 > room) break;
      named.push(item);
      size += item.length + 2;
    }
    const rest = left.length - named.length;
    return `${intro}${named.length ? `: ${named.join(', ')}` : ''}${rest ? `${named.length ? ', and' : ':'} ${rest} more` : ''}${tail}`;
  };
  const RESERVE = 480;
  const kept: UserWords[] = [];
  let used = head.length + 1;
  for (const w of [...words].sort((a, b) => b.ts - a.ts)) {
    const size = line(w).length + 1;
    // Room for the "incomplete" line stays free until every message is in.
    const reserve = kept.length + 1 < words.length ? RESERVE : 0;
    if (used + size + reserve > budget) continue;
    kept.push(w);
    used += size;
  }
  const omitted = words.filter((w) => !kept.includes(w));
  const shown = [...kept].sort((a, b) => a.ts - b.ts);
  const parts = [head, ...shown.map(line)];
  if (omitted.length) parts.push(incomplete(omitted, Math.max(0, budget - used - 1)));
  const text = parts.join('\n');
  // A budget too small even for the heading: only the incomplete line, which says where to read everything.
  if (text.length > budget) return { text: incomplete(words, budget).slice(0, budget), shown: [], omitted: [...words] };
  return { text, shown: shown.map((w) => w.id), omitted };
}

/** read_context {topic: "user"}: every piece of the user's words in the conversation, whole; from an id on if given. */
export function userWordsTopic(run: WorkflowRun, from?: string): string {
  const all = conversationUserWords(run);
  const start = from ? all.findIndex((w) => w.id === from) : 0;
  const list = start >= 0 ? all.slice(start) : all;
  return [`THE USER'S OWN WORDS IN THIS CONVERSATION (verbatim, oldest first; the later one holds when they disagree)${from && start < 0 ? ` — no "${from}", so all of them` : ''}:`, ...list.map(line)].join('\n');
}
