import { estimateTokens } from './agentContext';
import type { CostBreakdown, CostRow, ObservedTotals, PromptTotals, PromptTurn, TokenUsage, WorkflowRun } from './types';

/**
 * What a prompt Aivenue sent was made of (docs/workflow-efficiency-plan.md A1). Observation only: nothing here changes
 * a prompt. Role prompts are split by the section headers prompts.ts writes; what no header claims is "instructions".
 */

/** Section headers of the role prompts (prompts.ts), and the part each one belongs to. */
const SECTIONS: [string, string][] = [
  ['GOAL TO MEET', 'goalSpec'],
  ['APPROVED PLAN:', 'plan'],
  ['YOUR PREVIOUS PLAN:', 'plan'],
  ['UPDATED PLAN:', 'plan'],
  ['REVISED PLAN:', 'plan'],
  ['PLAN:', 'plan'],
  ['YOUR PREVIOUS ISSUES:', 'priorReview'],
  ['IMPLEMENTER RESPONSES:', 'priorReview'],
  ['PLANNER RESPONSES:', 'priorReview'],
  ['REVIEW SUMMARY:', 'priorReview'],
  ['ISSUES:', 'priorReview'],
  ["IMPLEMENTER'S SUMMARY:", 'workSummary'],
  ['CHANGED FILES:', 'changedFiles'],
  ['EARLIER VERIFICATIONS', 'earlierVerifications'],
  ['USER FEEDBACK:', 'userFeedback'],
];

/** Lines that start instructions again after a section (they end the section before them). */
const ENDS = /^(When done|If the Aivenue tool|TASK:|HOW TO VERIFY:|GOAL PROGRESS:|For each issue)/;

export interface Piece {
  key: string;
  text: string;
}

/** A role prompt cut into its parts, in order: joined, they are the whole prompt. The goal is matched exactly. */
export function roleParts(prompt: string, goal: string): Piece[] {
  const out: Piece[] = [];
  const add = (key: string, from: number, to: number) => {
    if (to <= from) return;
    const last = out[out.length - 1];
    if (last?.key === key) last.text += prompt.slice(from, to);
    else out.push({ key, text: prompt.slice(from, to) });
  };
  // Where each section starts and which part it is; "GOAL:" is the user's goal, exactly as written.
  const marks: { at: number; key: string; end?: number }[] = [];
  const g = goal.trim();
  const goalAt = g ? prompt.indexOf(`GOAL:\n${g}`) : -1;
  if (goalAt >= 0) marks.push({ at: goalAt, key: 'goal', end: goalAt + 'GOAL:\n'.length + g.length });
  let pos = 0;
  for (const line of prompt.split('\n')) {
    const header = SECTIONS.find(([h]) => line.startsWith(h));
    if (header) marks.push({ at: pos, key: header[1] });
    else if (ENDS.test(line)) marks.push({ at: pos, key: 'instructions' });
    pos += line.length + 1;
  }
  marks.sort((a, b) => a.at - b.at);
  let cursor = 0;
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    if (m.at < cursor) continue;
    add('instructions', cursor, m.at);
    const next = marks.slice(i + 1).find((x) => x.at >= (m.end ?? m.at + 1))?.at ?? prompt.length;
    const end = Math.min(m.end ?? next, prompt.length);
    add(m.key, m.at, end);
    cursor = end;
  }
  add('instructions', cursor, prompt.length);
  return out;
}

/**
 * One turn's record. Every block's tokens are estimated from its own text (Chinese and English count differently);
 * the turn's tokens are the sum of its blocks. `cut` is what a shortening removed: listed, never counted as sent.
 */
export function promptTurn(groups: { key: string; text: string; parts?: Piece[]; cut?: { key: string; chars: number }[] }[], resumed: boolean, at = Date.now()): PromptTurn {
  const sums = new Map<string, { chars: number; tokens: number }>();
  const add = (key: string, text: string) => {
    if (!text) return;
    const cur = sums.get(key) ?? { chars: 0, tokens: 0 };
    cur.chars += text.length;
    cur.tokens += estimateTokens(text);
    sums.set(key, cur);
  };
  const cut: { key: string; chars: number }[] = [];
  for (const g of groups) {
    if (!g.text) continue;
    const parts = g.parts?.filter((p) => p.text) ?? [];
    // Pieces that do not join back into exactly the text (length, content or order) cannot be trusted: then the
    // group is one block.
    if (!parts.length || parts.map((p) => p.text).join('') !== g.text) add(g.key, g.text);
    else for (const p of parts) add(`${g.key}.${p.key}`, p.text);
    for (const c of g.cut ?? []) cut.push({ key: `${g.key}.${c.key}`, chars: c.chars });
  }
  const blocks = [...sums.entries()].map(([key, v]) => ({ key, ...v }));
  return { at, resumed, blocks, chars: blocks.reduce((n, b) => n + b.chars, 0), tokens: blocks.reduce((n, b) => n + b.tokens, 0), ...(cut.length ? { cut } : {}) };
}

/** Add a turn to an agent's whole-run totals (the detail keeps only the latest turns). */
export function addTurn(t: PromptTotals | undefined, turn: PromptTurn): PromptTotals {
  const out: PromptTotals = t ? { ...t, blocks: { ...t.blocks }, cut: { ...t.cut } } : { turns: 0, chars: 0, tokens: 0, blocks: {}, cut: {} };
  out.turns++;
  out.chars += turn.chars;
  out.tokens += turn.tokens;
  for (const b of turn.blocks) {
    const cur = out.blocks[b.key] ?? { chars: 0, tokens: 0, turns: 0 };
    out.blocks[b.key] = { chars: cur.chars + b.chars, tokens: cur.tokens + b.tokens, turns: cur.turns + 1 };
  }
  for (const c of turn.cut ?? []) out.cut[c.key] = (out.cut[c.key] ?? 0) + c.chars;
  return out;
}


const EMPTY = (): ObservedTotals => ({ uncachedInput: 0, cachedInput: 0, output: 0, events: 0 });

/**
 * Add one usage report to an agent's observed totals (A2, observation only). Usage whose input/cache split is not
 * known goes to `unsplit` (the provider's own numbers), never into the two input columns; one without a price makes
 * the cost unknown (not zero).
 */
export function addObserved(t: ObservedTotals | undefined, u: TokenUsage): ObservedTotals {
  const o = u.observed;
  const out: ObservedTotals = { ...(t ?? EMPTY()), ...(t?.unsplit ? { unsplit: { ...t.unsplit } } : {}) };
  out.events++;
  if (o?.splitKnown) {
    out.uncachedInput += o.uncachedInput ?? 0;
    out.cachedInput += o.cachedInput ?? 0;
  } else {
    const un = (out.unsplit ??= { input: 0, cached: 0 });
    un.input += o ? (o.reportedInput ?? 0) : (u.input ?? 0);
    un.cached += o ? (o.reportedCached ?? 0) : (u.cached ?? 0);
    out.splitUnknown = true;
  }
  out.output += o ? o.output : (u.output ?? 0);
  if (o?.reasoning !== undefined) out.reasoning = (out.reasoning ?? 0) + o.reasoning;
  if (o?.cacheWrite !== undefined) out.cacheWrite = (out.cacheWrite ?? 0) + o.cacheWrite;
  if (typeof u.costUsd === 'number' && !out.costUnknown) out.costUsd = (out.costUsd ?? 0) + u.costUsd;
  else if (typeof u.costUsd !== 'number') {
    out.costUnknown = true;
    out.costUsd = undefined;
  }
  return out;
}

/** Waiting on the user (a decision, an approval, a pause): counted apart from working time (A2). */
export function trackWaiting(run: WorkflowRun, at: number) {
  const waiting = !run.endedAt && (run.status === 'paused' || run.status === 'waiting_human' || !!run.approvals?.length);
  const t = (run.timing ??= { waitingMs: 0 });
  if (waiting && t.waitingSince === undefined) t.waitingSince = at;
  else if (!waiting && t.waitingSince !== undefined) {
    t.waitingMs += Math.max(0, at - t.waitingSince);
    t.waitingSince = undefined;
  }
}

const sumObserved = (a: ObservedTotals, b: ObservedTotals | undefined): ObservedTotals => {
  if (!b) return a;
  const out: ObservedTotals = { ...a, uncachedInput: a.uncachedInput + b.uncachedInput, cachedInput: a.cachedInput + b.cachedInput, output: a.output + b.output, events: a.events + b.events };
  if (b.reasoning !== undefined) out.reasoning = (a.reasoning ?? 0) + b.reasoning;
  if (b.cacheWrite !== undefined) out.cacheWrite = (a.cacheWrite ?? 0) + b.cacheWrite;
  if (a.unsplit || b.unsplit) out.unsplit = { input: (a.unsplit?.input ?? 0) + (b.unsplit?.input ?? 0), cached: (a.unsplit?.cached ?? 0) + (b.unsplit?.cached ?? 0) };
  if (b.splitUnknown) out.splitUnknown = true;
  if (a.costUnknown || b.costUnknown || (b.events && b.costUsd === undefined)) {
    out.costUnknown = true;
    out.costUsd = undefined;
  } else if (b.costUsd !== undefined) out.costUsd = (a.costUsd ?? 0) + b.costUsd;
  return out;
};

/** A workflow's cost by role and stage, its times, and the prompt blocks that took the most over the whole run (A2). */
export function costBreakdown(run: WorkflowRun, at = Date.now()): CostBreakdown {
  const rows = new Map<string, CostRow>();
  const blocks = new Map<string, { key: string; chars: number; tokens: number; turns: number }>();
  const cut = new Map<string, number>();
  let agentMs = 0;
  let turns = 0;
  let total = EMPTY();
  for (const a of Object.values(run.agents)) {
    if (a.role === 'test') continue;
    // Aivenue's own upkeep: compacting a conversation, or organizing the shared notes.
    const key = a.role === 'compactor' ? (/共用筆記|shared notes/i.test(a.task) ? 'librarian' : 'compaction') : a.stage ? `${a.role}@${a.stage}` : a.role;
    const row = rows.get(key) ?? { key, role: a.role, stage: a.role === 'compactor' ? undefined : a.stage, agents: 0, agentMs: 0, observed: EMPTY(), promptTokens: 0, turns: 0 };
    const ms = a.startedAt ? Math.max(0, (a.endedAt ?? at) - a.startedAt) : 0;
    row.agents++;
    row.agentMs += ms;
    agentMs += ms;
    row.observed = sumObserved(row.observed, a.observed);
    total = sumObserved(total, a.observed);
    // The whole run's totals, not only the turns whose detail is still kept.
    const p = a.promptTotals;
    if (p) {
      row.promptTokens += p.tokens;
      row.turns += p.turns;
      turns += p.turns;
      for (const [k, v] of Object.entries(p.blocks)) {
        const cur = blocks.get(k) ?? { key: k, chars: 0, tokens: 0, turns: 0 };
        cur.chars += v.chars;
        cur.tokens += v.tokens;
        cur.turns += v.turns;
        blocks.set(k, cur);
      }
      for (const [k, n] of Object.entries(p.cut)) cut.set(k, (cut.get(k) ?? 0) + n);
    }
    rows.set(key, row);
  }
  const t = run.timing;
  const waitingMs = (t?.waitingMs ?? 0) + (t?.waitingSince !== undefined ? Math.max(0, at - t.waitingSince) : 0);
  return {
    wallMs: Math.max(0, (run.endedAt ?? at) - run.createdAt),
    agentMs,
    waitingMs,
    rows: [...rows.values()],
    total,
    blocks: [...blocks.values()].sort((a, b) => b.tokens - a.tokens),
    cut: [...cut.entries()].map(([key, chars]) => ({ key, chars })).sort((a, b) => b.chars - a.chars),
    turns,
  };
}
