import type { AgentEvent, AgentRunInfo, ContextSharing, OpenDecision, SharedNote, WorkflowRun } from './types';
import { activityBlock, collectActivity, fit, handoffsBlock, knowledgeBlock, statusBlock, verifiedChecks } from './ledger';
import { buildTopics, topicIndexBlock } from './topics';
import { isPending, memoryHistory, renderMemory } from './memoryEntries';

/**
 * Shared context between agents: an overview of the workflow, full transcripts on request,
 * and the block every agent's prompt gets. Text is English because it goes to the models.
 */

export const DEFAULT_SHARING: ContextSharing = 'on_demand';
/** One page of an agent's conversation through read_context {agent_id}. */
export const TRANSCRIPT_PAGE = 40000;
/** Notes that are an agent's hand-off (also organized by the librarian), shown as hand-offs rather than as notes. */
export const HANDOFF_NOTE = /^HAND-OFF\b/;

/** Whitespace folded to single spaces. */
const flat = (t: string | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();
export const sharingOf = (run: WorkflowRun): ContextSharing => run.config.contextSharing ?? DEFAULT_SHARING;

const ROLE: Record<AgentRunInfo['role'], string> = {
  planner: 'planner',
  plan_reviewer: 'plan reviewer',
  executor: 'implementer',
  code_reviewer: 'code reviewer',
  verifier: 'goal verifier',
  adjudicator: 'adjudicator',
  subagent: 'sub-agent',
  advisor: 'advisor',
  compactor: 'context compactor',
  test: 'test',
};

const cut = (s: string | undefined, n: number) => {
  const t = (s ?? '').trim();
  return t.length > n ? `${t.slice(0, n)}… (+${t.length - n} chars)` : t;
};

const oneLine = (s: string | undefined, n: number) => cut((s ?? '').replace(/\s+/g, ' '), n);

/** A note that passes on what the user asked or said. */
export const USER_SAID = /\b(the )?user (said|says|asked|asks|wants|prefers|requested|instructed|told|requires|chose)\b|\buser'?s? (instruction|request|preference|requirement)|使用者|用戶/i;

/** A role in English, for text that goes to the models. */
export const roleName = (role: AgentRunInfo['role']) => ROLE[role];

export function agentLabel(a: AgentRunInfo): string {
  return `${a.id} — ${ROLE[a.role]} (${a.provider}${a.model ? `, ${a.model}` : ''})${a.round && a.role !== 'subagent' ? `, round ${a.round}` : ''}`;
}

/** What an agent handed over: its submission for its round, or its final reply. */
export function agentResult(run: WorkflowRun, a: AgentRunInfo): string {
  const round = a.stage ? run.stages[a.stage]?.rounds.find((r) => r.n === a.round) : undefined;
  if (round?.reviewerAgentId === a.id && round.review) return `verdict ${round.review.verdict}, ${round.review.issues.length} issue(s): ${round.review.summary}`;
  if (round?.authorAgentId === a.id && round.submission) return round.submission.plan ? `plan: ${round.submission.plan.summary}` : round.submission.summary;
  return a.finalText ?? '';
}

/**
 * What an agent handed to whoever takes over: the hand-off it wrote with its submission, or, when it wrote none (it
 * failed, was stopped, or its CLI ignored the field), one put together from what it did. No model call either way.
 */
export function handoverOf(run: WorkflowRun, a: AgentRunInfo, events: AgentEvent[]): { text: string; auto: boolean } {
  if (a.handover?.text && !a.handover.auto) return { text: a.handover.text, auto: false };
  const lines: string[] = [];
  if (a.status === 'failed' || a.status === 'cancelled') lines.push(`It ended ${a.status === 'failed' ? 'with an error' : 'stopped'}${a.error ? `: ${cut(a.error, 600)}` : ''}.`);
  const result = agentResult(run, a);
  if (result) lines.push(`What it reported:\n${cut(result, 4000)}`);
  if (a.stats?.filesChanged?.length) lines.push(`Files it changed: ${a.stats.filesChanged.slice(-40).join(', ')}${a.stats.filesChanged.length > 40 ? ` (+${a.stats.filesChanged.length - 40} more)` : ''}`);
  const maybe = a.stats?.filesMaybeChanged ?? [];
  if (maybe.length) lines.push(`Files it possibly changed (every edit of them failed, which does not show whether they changed; check them): ${maybe.slice(-40).join(', ')}${maybe.length > 40 ? ` (+${maybe.length - 40} more)` : ''}`);
  const tools = events.filter((e) => e.kind === 'tool' && e.tool && e.tool.status !== 'running' && (e.tool.category === 'command' || e.tool.category === 'edit'));
  if (tools.length) lines.push(`Its last commands and edits:\n${tools.slice(-8).map((e) => `- ${oneLine(e.tool!.title || e.tool!.input, 200)} → ${e.tool!.status}${e.tool!.status === 'error' && e.tool!.output ? `: ${oneLine(e.tool!.output, 300)}` : ''}`).join('\n')}`);
  return { text: lines.join('\n') || '(it did nothing that was recorded)', auto: true };
}

/**
 * The one hand-off an agent gets from the agent before it (docs/next-task-skills-integration.md, first delivery),
 * put together from the records with no model call. After Matt Pocock's handoff (point at what is recorded rather
 * than copy it), context-compression (fixed sections so nothing drops silently; the user's words verbatim; the
 * artifact trail from Aivenue's own records, not a summary) and ce-handoff (the receiver checks material claims
 * against the current state; the user's words and current files win; whose account each part is).
 * Kept apart on purpose: what Aivenue saw run, what the previous agent says, and what is not confirmed yet.
 */
/** One open decision as lines: the question, each side with its source, and what it rests on. */
function decisionLines(d: OpenDecision): string[] {
  return [
    `- ${d.id} [${d.status === 'decided' ? `decided by ${cut(flat(d.decidedBy), 80)} (${cut(d.decisionSource, 300)}): ${cut(flat(d.decision), 300)}` : 'open, for the user'}] ${cut(flat(d.question), 300)}`,
    ...d.positions.map((p) => `    ${cut(flat(p.by), 80)}: ${cut(flat(p.view), 600)}${p.source ? ` (${cut(p.source, 300)})` : ''}`),
    ...(d.proposal ? [`    the author's proposal, not a decision: ${cut(flat(d.proposal), 600)}`] : []),
    ...(d.sources.length ? [`    sources: ${d.sources.map((x) => cut(x, 300)).join('; ')}`] : []),
  ];
}

/** The open decisions of the latest submission of each stage that recorded any. */
export function openDecisionLines(run: WorkflowRun): string[] {
  return (['plan', 'implement'] as const)
    .flatMap((k) => [...(run.stages[k]?.rounds ?? [])].reverse().find((r) => r.submission?.openDecisions?.length)?.submission?.openDecisions ?? [])
    .flatMap(decisionLines);
}

/** One item kept whole, or, when it does not fit, a short form that says what was left out and where to read it. */
type Unit = string | { full: string; short: string };

/** As many items as fit in `budget`, from the first (lists in order of importance); an item is never split. */
function fitTop(items: Unit[], budget: number, head: string): string {
  const out: string[] = [];
  let used = head.length + 80;
  let i = 0;
  for (; i < items.length; i++) {
    const it = items[i];
    const full = typeof it === 'string' ? it : it.full;
    const short = typeof it === 'string' ? undefined : it.short;
    const pick = used + full.length + 1 <= budget ? full : short && used + short.length + 1 <= budget ? short : undefined;
    if (!pick) break;
    out.push(pick);
    used += pick.length + 1;
  }
  const dropped = items.length - i;
  return [head, ...out, ...(dropped ? [`- (${dropped} more item(s) left out; read_context finds them)`] : [])].join('\n');
}

/**
 * Each open decision as one unit: its question with every side and its sources, or — when that does not fit — its
 * question with where to read the rest.
 */
export function openDecisionUnits(run: WorkflowRun): { full: string; short: string }[] {
  return (['plan', 'implement'] as const)
    .flatMap((k) => [...(run.stages[k]?.rounds ?? [])].reverse().find((r) => r.submission?.openDecisions?.length)?.submission?.openDecisions ?? [])
    .map((d) => {
      const lines = decisionLines(d);
      const first = lines[0].replace(/^- /, '- [open decision] ');
      return { full: [first, ...lines.slice(1)].join('\n'), short: `${first} — its sides and sources are left out here for space: read_context {} lists them in full` };
    });
}

/** The user's own words in the records: messages during the run, feedback on a round, decisions said to be theirs. */
export function userWordLines(run: WorkflowRun): string[] {
  return [
    ...(run.userMessages ?? []).slice(-8).map((m) => `- "${cut(m.text.trim(), 1500)}"`),
    ...(['plan', 'implement'] as const).flatMap((k) => (run.stages[k]?.rounds ?? []).filter((r) => r.userFeedback).slice(-2).map((r) => `- (on the ${k} round ${r.n}) "${cut(r.userFeedback!.trim(), 1500)}"`)),
    ...(run.notes ?? []).filter((n) => n.kind === 'decision' && USER_SAID.test(n.text)).slice(-6).map((n) => `- (decision recorded as the user's) ${cut(flat(n.text), 400)}`),
  ];
}

/** Open issues of the latest review in each stage, and what it left unconfirmed (no severity, kept apart). */
export function openReviewLines(run: WorkflowRun): { open: string[]; nv: string[] } {
  const reviews = (['plan', 'implement'] as const).map((k) => ({ k, r: [...(run.stages[k]?.rounds ?? [])].reverse().find((x) => x.review) })).filter((x) => x.r);
  const open = reviews
    .filter(({ r }) => r!.review!.verdict === 'revise' && r!.review!.issues.length)
    .flatMap(({ k, r }) => r!.review!.issues.map((i) => `- ${i.id} [${i.severity}] ${cut(flat(i.title), 160)}${i.location ? ` (${i.location})` : ''} — ${k} review, round ${r!.n}${r!.review!.stale ? ', STALE: the code changed since' : ''}`));
  const nv = reviews.flatMap(({ k, r }) =>
    (r!.review!.needsValidation ?? []).map((n) => `- ${n.id} ${cut(flat(n.title), 160)}${n.location ? ` (${n.location})` : ''} — missing evidence: ${cut(flat(n.missing), 300)}${n.how ? `; to confirm: ${cut(flat(n.how), 200)}` : ''} (${k} review, round ${r!.n})`),
  );
  return { open, nv };
}

/**
 * Aivenue's own records for the hand-off summary of a conversation that cannot be compacted from outside
 * (docs/next-task-skills-integration.md; after context-compression: the artifact trail is not left to the summarizer).
 * Most important first, all within `budget` characters: the task and the user's words; open issues, what is not
 * confirmed and open decisions; the checks this conversation ran (how they ended — a check run before a later file
 * change is marked to be re-verified); its other commands (how they ended, no output); the files it changed or
 * possibly changed; the files it read (names only). Each part names its source; what does not fit is counted, with
 * where to read it.
 */
export function handoffRecords(run: WorkflowRun, info: AgentRunInfo, ids: Set<string>, eventsOf: (agentId: string) => AgentEvent[], budget: number, at = Date.now()): string {
  const act = collectActivity(run, eventsOf, { onlyIds: ids });
  const head = `FROM AIVENUE'S RECORDS (attached by Aivenue, not written by the summarizer; source: the tool records of agent(s) ${[...ids].map((id) => id.slice(0, 8)).join(', ')} and the workflow's review records, up to ${new Date(at).toISOString().slice(0, 16)}Z; full outputs: read_context {agent_id}):`;
  const { open, nv } = openReviewLines(run);
  const shown = (e: { ok: boolean; result: string; outdated?: boolean; maybeOutdated?: boolean; what: string }) =>
    `- ${!e.ok ? '✗' : /\b(fail(ed|ing|ure)?|error)\b/i.test(e.result) ? '⚠' : '✓'} \`${cut(flat(e.what), 160)}\`${e.outdated ? ' — files changed since' : e.maybeOutdated ? ' — a failed edit since may have changed files' : ''}`;
  const checks = verifiedChecks(act, 10);
  const checkSet = new Set(checks.map((l) => /`([^`]*)`/.exec(l)?.[1]));
  const latest = new Map<string, (typeof act.entries)[number]>();
  for (const e of act.entries.filter((x) => x.kind === 'command')) latest.set(e.what, e);
  const commands = [...latest.values()].filter((e) => !checkSet.has(cut(e.what, 100))).map(shown);
  const changed = act.changed.filter(([, c]) => ids.has(c.by.id));
  // The first two parts keep their items in order of importance (from the top: the task and the earliest words, which
  // set the constraints; confirmed issues before decisions before what is not confirmed); the rest keep the newest.
  const sections: { title: string; lines: Unit[]; cap: number; top?: boolean }[] = [
    { title: 'Task and the user\'s words (constraints to keep):', lines: [...(info.task ? [`- Task of this conversation: ${cut(flat(info.task), 400)}`] : []), ...userWordLines(run)], cap: 0.45, top: true },
    {
      title: 'Open issues, open decisions, points not confirmed:',
      lines: [...open, ...openDecisionUnits(run), ...nv.map((l) => l.replace(/^- /, '- [not confirmed] '))],
      cap: 0.45,
      top: true,
    },
    { title: 'Checks it ran (re-verify any marked so before relying on it):', lines: checks, cap: 1 },
    { title: 'Files it changed:', lines: changed.filter(([, c]) => c.sure).map(([f, c]) => `- ${f} (by ${c.by.id.slice(0, 8)})`), cap: 1 },
    { title: 'Files it possibly changed (every edit of them failed; check them):', lines: changed.filter(([, c]) => !c.sure).map(([f, c]) => `- ${f} (by ${c.by.id.slice(0, 8)})`), cap: 1 },
    { title: 'Other commands it ran (how they ended; outputs in read_context):', lines: commands, cap: 1 },
    { title: 'Files it read (names only):', lines: act.read.map((r) => `- ${r.file}${r.outdated ? ' — CHANGED since' : r.maybeOutdated ? ' — possibly changed since' : ''}`), cap: 1 },
  ];
  let left = budget - head.length - 1;
  const parts = [head];
  for (const s of sections) {
    if (!s.lines.length || left <= s.title.length + 40) continue;
    const room = Math.min(left, Math.floor(budget * s.cap));
    // fit() does not count its "left out" line: leave room for it.
    const text = s.top ? fitTop(s.lines, room, s.title) : fit(s.lines as string[], room - 90, s.title);
    if (text.length > room) continue;
    parts.push(text);
    left -= text.length + 1;
  }
  return parts.length > 1 ? parts.join('\n') : '';
}

export function handoffToYou(run: WorkflowRun, self: AgentRunInfo, prev: AgentRunInfo, handover: { text: string; auto: boolean }, act: ReturnType<typeof collectActivity>, accountChars: number): { text: string; listsOpenIssues: boolean } {
  const parts: string[] = [`HAND-OFF TO YOU (from Aivenue's records; the user's words and the current files win over it):`];
  // Next step: what Aivenue asked of this agent, and why the work came here.
  // A route counts only when it sends the work to this agent's role (a review or verification sending it back).
  const toMe = self.role === 'executor' ? 'implementer' : self.role === 'planner' ? 'planner' : undefined;
  const routed = toMe ? [...(run.stages.plan?.rounds ?? []), ...(run.stages.implement?.rounds ?? []), ...(run.stages.verify?.rounds ?? [])].filter((r) => r.route?.to === toMe).pop()?.route : undefined;
  // A code or plan review asking for changes records no route: the round before this one in the agent's own stage says
  // why the work came back.
  const before = self.stage && self.round && self.round > 1 && (self.role === 'executor' || self.role === 'planner') ? run.stages[self.stage]?.rounds.find((r) => r.n === self.round! - 1) : undefined;
  const sentBack = before?.review?.verdict === 'revise' ? `the ${self.stage} review of round ${before.n} asked for changes${before.review.issues.length ? ` (${before.review.issues.map((i) => i.id).join(', ')})` : ''}` : undefined;
  const why = routed ? flat(routed.reason) : sentBack;
  // Only when the work came back: a first turn's task is already the role prompt's.
  if (why) parts.push(`NEXT STEP:\n${[self.task?.trim() ? `- Your task now: ${cut(flat(self.task), 300)}` : '', `- Why it came back to you: ${cut(why, 300)}`].filter(Boolean).join('\n')}`);
  // The user's own words, verbatim: messages during the run, feedback on a round, decisions said to be the user's.
  const userLines = userWordLines(run);
  if (userLines.length) parts.push(`FROM THE USER (their words; constraints to keep):\n${userLines.join('\n')}`);
  // What the records prove, not what anyone says they checked.
  const checks = verifiedChecks(act);
  parts.push(`VERIFIED BY AIVENUE (checks it saw run; an agent's own claims are not here):\n${checks.length ? checks.join('\n') : '- none recorded yet'}`);
  // Open issues of the latest review in each stage, and what is not confirmed yet (no severity, kept apart).
  const { open, nv } = openReviewLines(run);
  if (open.length) parts.push(`OPEN ISSUES (confirmed by a reviewer):\n${open.join('\n')}`);
  if (nv.length) parts.push(`NEEDS VALIDATION (not confirmed, no severity; not facts, not defects):\n${nv.join('\n')}`);
  // Points an author left for the user: every side and its sources, still open unless the user decided.
  const decisions = openDecisionLines(run);
  if (decisions.length) parts.push(`OPEN DECISIONS (left for the user to decide; keep every side and its source, do not settle them yourself):\n${decisions.join('\n')}`);
  // What each stage recorded when its latest round ended (decisions, facts, open points): an earlier stage's decision
  // reaches every later agent even when the agent right before did not repeat it. Open issues listed above are not
  // repeated.
  const listed = new Set([...open, ...decisions].map((l) => /^- (\S+)/.exec(l)?.[1]));
  const recorded = Object.entries(run.stages).flatMap(([key, st]) => {
    const h = [...(st?.rounds ?? [])].reverse().find((x) => x.handoff)?.handoff;
    if (!h) return [];
    const lines = [
      ...h.decisions.map((d) => `  DECISION: ${cut(flat(d), 240)}`),
      ...h.facts.map((d) => `  FACT: ${cut(flat(d), 240)}`),
      ...h.open.filter((d) => !listed.has(/^(\S+)/.exec(d)?.[1])).map((d) => `  OPEN: ${cut(flat(d), 200)}`),
    ];
    return lines.length ? [`${key} stage, round ${h.round}:`, ...lines] : [];
  });
  if (recorded.length) parts.push(`RECORDED AT EACH STAGE (the latest round of each):\n${recorded.join('\n')}`);
  // The previous agent's account: its claims, to check, not facts.
  parts.push(
    `THE AGENT BEFORE YOU — ${agentLabel(prev)} [${prev.status}]${handover.auto ? ' (it wrote no hand-off; Aivenue put this together from what it did)' : ' — its own account, to check'}:\n${handover.auto ? cut(handover.text, accountChars) : handover.text.trim()}`,
  );
  // Where to look, with what matters there.
  const files = prev.stats?.filesChanged ?? [];
  const maybe = prev.stats?.filesMaybeChanged ?? [];
  const sources = [
    `- Its conversation: read_context {agent_id: "${prev.id}"} (parts "messages", "tools").`,
    files.length ? `- What it changed: ${files.slice(-12).join(', ')}${files.length > 12 ? ` (+${files.length - 12} more)` : ''} (see their current diff)` : '',
    maybe.length ? `- Possibly changed (its edits failed; check them): ${maybe.slice(-12).join(', ')}` : '',
    (['plan', 'implement'] as const).some((k) => run.stages[k]?.rounds.some((x) => x.review)) ? '- All reviews and verifications: read_context {}.' : '',
  ].filter(Boolean);
  parts.push(`SOURCES:\n${sources.join('\n')}`);
  parts.push('BEFORE YOU ACT: check the claims you rely on against the current files, read-only; report a mismatch instead of building on it.');
  return { text: parts.join('\n'), listsOpenIssues: open.length > 0 };
}

/**
 * One agent in the directory of the shared context: who, where, its state, what it handed over (the first line, or
 * all of it in "full" sharing).
 */
function directoryLine(run: WorkflowRun, a: AgentRunInfo, resultChars: number, whole = false, noHandoff = false): string {
  const where = a.stage && a.role !== 'subagent' ? `, ${a.stage} stage` : a.parentId ? `, sub-agent of ${a.parentId.slice(0, 8)}` : '';
  const h = !noHandoff && a.handover?.text && !a.handover.auto ? `\n  hand-off: ${whole ? a.handover.text.trim().replace(/\n/g, '\n    ') : oneLine(a.handover.text, 300)}` : noHandoff ? '\n  hand-off: in HAND-OFF TO YOU above' : '';
  return `- ${agentLabel(a)}${where} [${a.status}]: ${cut(agentResult(run, a), resultChars) || '—'}${h}`;
}

/** Agents other than `self`, oldest first. */
function others(run: WorkflowRun, selfId?: string): AgentRunInfo[] {
  return Object.values(run.agents)
    .filter((a) => a.id !== selfId && a.role !== 'test' && a.role !== 'compactor')
    .sort((x, y) => (x.startedAt ?? 0) - (y.startedAt ?? 0));
}

function noteLine(run: WorkflowRun, n: SharedNote): string {
  const a = run.agents[n.agentId];
  // fact (checked) / inference (a judgement, not verified) / decision, so nobody builds on a guess as if it were checked.
  const kind = n.kind ? `${n.kind.toUpperCase()} ` : '';
  return `- ${kind}[${a ? `${a.id.slice(0, 8)} ${ROLE[a.role]} ${a.provider}` : n.by ?? 'agent'}] ${n.text}`;
}

/** Notes not yet folded into the shared memory (or all of them with `all`), newer than `since`. */
function notesBlock(run: WorkflowRun, o: { all?: boolean; since?: number } = {}): string {
  const upto = o.all ? 0 : run.memory?.upto ?? 0;
  const notes = (run.notes ?? []).filter((n) => (n.ts > upto || unfolded(run, `n:${n.id}`)) && n.ts > (o.since ?? 0));
  if (!notes.length) return '(no notes yet)';
  return notes.map((n) => noteLine(run, n)).join('\n');
}

/** The compacted shared memory, if any. */
function memoryBlock(run: WorkflowRun): string {
  const m = run.memory;
  return m?.summary ? `SHARED MEMORY (earlier notes and agent results, condensed):\n${m.summary}` : '';
}

/** Whether an agent's result is already folded into the shared memory. */
const folded = (run: WorkflowRun, a: AgentRunInfo) => !!run.memory && !!a.endedAt && a.endedAt <= run.memory.upto && !unfolded(run, `a:${a.id}`);

/** Material up to the memory's time that its last compaction left pending: still shown as it is. */
const unfolded = (run: WorkflowRun, ref: string) => isPending(run.memory?.pending, ref);

/** Every original note, also the ones folded into the shared memory (read_context {agent_id: "notes"}). */
export function allNotes(run: WorkflowRun): string {
  return `ALL SHARED NOTES (originals):\n${notesBlock(run, { all: true })}`;
}

/**
 * The block appended to an agent's prompt (empty in "summary" mode). `since`: a resumed conversation already has
 * everything up to then, so it only gets what is new. `maxChars`: this agent's share of its model. The goal, status
 * and hand-offs always come first; the rest fills the share newest first, and what does not fit stays reachable through
 * read_context and search_records. `recap`: what the agent's own conversation did before its CLI compacted it.
 */
export function contextBlock(run: WorkflowRun, self: AgentRunInfo, transcriptOf: (agentId: string) => AgentEvent[], o: { since?: number; maxChars?: number; recap?: (budget: number) => string; measure?: { kept: { key: string; text: string }[]; cut: { key: string; chars: number }[] } } = {}): string {
  const mode = sharingOf(run);
  if (mode === 'summary') return '';
  const since = o.since ?? 0;
  const max = o.maxChars ?? 40000;
  const fresh = (a: AgentRunInfo) => a.status === 'running' || (a.endedAt ?? 0) > since;
  const agents = others(run, self.id);
  // Whoever worked right before this agent hands over to it (handoffToYou), not its raw conversation: that stays in the
  // shared records (read_context {agent_id}). A sub-agent has its task from its parent instead.
  const prev = self.parentId ? undefined : agents.filter((a) => a.depth === 0 && a.status !== 'running').pop();
  const handover = prev && fresh(prev) ? handoverOf(run, prev, transcriptOf(prev.id)) : undefined;
  const foldedCount = agents.filter((a) => folded(run, a)).length;
  const list = [
    ...(foldedCount && !since ? [`- (${foldedCount} earlier agent(s): see the shared memory below)`] : []),
    // "full": every agent's whole hand-off (organized by the agent itself), not only the one right before. The one
    // before this agent is in the hand-off already: its line keeps who and what, not its hand-off again.
    ...agents.filter((a) => !folded(run, a) && fresh(a)).map((a) => (mode === 'full' ? directoryLine(run, a, 2000, true, !!handover && a === prev) : directoryLine(run, a, 1200, false, !!handover && a === prev))),
  ];
  const memory = run.memory && run.memory.updatedAt > since ? memoryBlock(run) : '';
  const upto = Math.max(run.memory?.upto ?? 0, run.knowledge?.upto ?? 0);
  // Hand-offs come as hand-offs (the agent directory, the one before this agent in full); notes from an earlier
  // message only when they are decisions or the user's instructions, the rest is in the organized knowledge and searchable.
  const inPrompt = (n: SharedNote) => !HANDOFF_NOTE.test(n.text) && (!n.carried || n.kind === 'decision' || USER_SAID.test(n.text));
  const notes = (run.notes ?? []).filter((n) => (n.ts > upto || unfolded(run, `n:${n.id}`)) && n.ts > since && inPrompt(n)).map((n) => noteLine(run, n));
  const carriedOut = !since ? (run.notes ?? []).filter((n) => n.carried && !inPrompt(n) && !HANDOFF_NOTE.test(n.text)).length : 0;
  const knowledgeDoc = run.knowledge && run.knowledge.updatedAt > since ? run.knowledge.doc : '';
  const act = collectActivity(run, transcriptOf, { since, selfId: self.id });
  // The one hand-off from the agent before; with it, the stages' hand-off notes and the open issues in the status are
  // not repeated (it carries the open issues, what is not confirmed, and where to look).
  const handoff = handover && prev ? handoffToYou(run, self, prev, handover, act, Math.max(6000, Math.floor((max - 4000) * 0.4))) : undefined;
  // Always first: where things stand and what was handed over.
  const status = statusBlock(run, { openIssues: !handoff?.listsOpenIssues });
  const handoffs = handoff ? '' : handoffsBlock(run, since);
  const footer =
    "Call the Aivenue tool `read_context` {} for the full overview (complete plan, every review and verification, all summaries), `read_context` {agent_id} for any agent's conversation (its messages, commands and their output; part \"messages\" or \"tools\", page 2 for older parts), or `search_records` {q, role, file, issue_id…} to find something specific. Use `post_note` {text, kind: fact|inference|decision} to tell all later agents about a decision, a gotcha or where something lives. When you submit, list what you learned in `findings` and write your `handoff` for the agent who takes over: the state, what is open, what to do next and where to look.";
  const progress = progressBlock(run);
  const head = [
    since ? 'SHARED CONTEXT (only what is new since your last turn, plus the current status):' : 'SHARED CONTEXT: You work together with other agents on this workflow.',
    progress,
    'CHECK HERE FIRST: before running a command, reading a file or investigating something, look for it below and call `search_records` {q: "a few keywords"} — another agent may already have done it. Re-run only when files changed since or you need more than what is recorded.',
    status,
    handoffs,
  ]
    .filter(Boolean)
    .join('\n');
  // The rest of the share, newest first in each part: own work after a compaction, notes, agents, memory, then what
  // the others ran and read.
  let room = Math.max(4000, max - head.length - footer.length - 400);
  const take = (text: string) => ((room -= text.length + 1), text);
  const handoverText = take(handoff?.text ?? '');
  const recap = o.recap ? take(o.recap(Math.floor(room * 0.3))) : '';
  // The organized knowledge and the table of contents of every record, before the newest raw items.
  const organized = take(knowledgeDoc ? `SHARED KNOWLEDGE (organized by subject from the shared notes, with sources [n:id]; read_context {topic: "knowledge"} for all of it):\n${cut(knowledgeDoc, Math.floor(room * 0.25))}` : '');
  const index = take(topicIndexBlock(buildTopics(run, transcriptOf), Math.max(1500, Math.floor(room * 0.06)), since));
  // The newest of the raw conversation log (every agent and the user); the rest is one read_context away.
  // Without the successful tool calls other blocks summarize (shownElsewhere); every failed call stays, with what was
  // said, results, errors, the user's messages and decisions.
  const log = since ? [] : conversationLog(run, transcriptOf, 400, { inPrompt: true });
  const recent = log.slice(-LOG_PAGE);
  const logText = take(recent.length ? fit(recent, Math.floor(room * 0.3), `RECENT CONVERSATION (the newest ${recent.length} of ${log.length} entries: what agents said and ended with, failed tool calls, errors, the user's messages and decisions; successful commands, file reads and edits are summarized below, and read_context {topic: "log"} has the full log with every tool call):`) : '');
  const carriedText = carriedOut ? `(${carriedOut} more notes from earlier messages of this conversation are in the shared records${run.knowledge ? ", organized in the shared knowledge" : ""}: search_records {q} or read_context {topic: "facts"} when you need one.)` : '';
  const noteText = take([notes.length ? fit(notes, Math.floor(room * 0.3), `Shared notes${since ? ' (new)' : ''}:`) : since ? '' : 'Shared notes:\n(no notes yet)', carriedText].filter(Boolean).join('\n'));
  const listText = take(list.length ? fit(list, Math.floor(room * 0.2), `Agents${since ? ' (new or updated)' : ' so far'} — read_context {agent_id} for any one's whole conversation:`) : since ? '' : 'You are the first agent in this workflow.');
  const memText = take(memory ? cut(memory, Math.floor(room * 0.3)) : '');
  const knowledge = take(knowledgeBlock(run, act, Math.floor(Math.max(0, room) * 0.25), !since));
  const activity = take(activityBlock(act, Math.max(2000, room)));
  if (since && !handoverText && !recap && !logText && !organized && !list.length && !memory && !notes.length && !handoffs && !knowledge && !activity) return `\nSHARED CONTEXT: nothing new from the other agents since your last turn.${status ? `\n${status}` : ''}`;
  const lines = ['', head, handoverText, recap, logText, organized, index, listText, memText, noteText, knowledge, activity, footer];
  let text = lines.filter((l) => l !== '').join('\n');
  // The same text as pieces, in order (observation only, docs/workflow-efficiency-plan.md A1): joined with "\n" they
  // are exactly `text`; what a cut below removes is counted apart, never as sent.
  const pieces: { key: string; text: string }[] = o.measure
    ? (
        [
          ['instructions', head.split('\n')[0]],
          ['progress', progress],
          ['instructions', head.split('\n').find((l) => l.startsWith('CHECK HERE FIRST')) ?? ''],
          ['status', status],
          ['handoffs', handoffs],
          ['handover', handoverText],
          ['recap', recap],
          ['log', logText],
          ['knowledgeDoc', organized],
          ['index', index],
          ['agents', listText],
          ['sharedMemory', memText],
          ['notes', noteText],
          ['knowledgeBase', knowledge],
          ['activity', activity],
          ['instructions', footer],
        ] as [string, string][]
      )
        .filter(([, t]) => t !== '')
        .map(([key, t]) => ({ key, text: t }))
    : [];
  // Still over this agent's share (a huge status or hand-off): keep the start, where the goal and status are.
  const cutAt = o.maxChars && text.length > o.maxChars ? o.maxChars : undefined;
  if (cutAt !== undefined) text = `${text.slice(0, cutAt)}\n… (shortened to fit your model; call read_context {} for the rest)`;
  if (o.measure) {
    const limit = cutAt ?? Infinity;
    let pos = 0;
    pieces.forEach((p, i) => {
      // The "\n" before every piece but the first.
      if (i > 0) {
        if (pos < limit) o.measure!.kept.push({ key: 'separators', text: '\n' });
        else o.measure!.cut.push({ key: 'separators', chars: 1 });
        pos++;
      }
      const keep = Math.max(0, Math.min(p.text.length, limit - pos));
      if (keep) o.measure!.kept.push({ key: p.key, text: p.text.slice(0, keep) });
      if (keep < p.text.length) o.measure!.cut.push({ key: p.key, chars: p.text.length - keep });
      pos += p.text.length;
    });
    if (cutAt !== undefined) o.measure.kept.push({ key: 'instructions', text: text.slice(cutAt) });
    // The leading "\n" of the returned block.
    o.measure.kept.unshift({ key: 'separators', text: '\n' });
  }
  return '\n' + text;
}

/**
 * Where the workflow is, always at the top of the shared context: the stage and round, the plan's summary and every
 * step with its status, and whether it was resumed after Aivenue restarted. Together with the goal status below it,
 * any agent (also one starting after an update) knows what is done and what comes next.
 */
export function progressBlock(run: WorkflowRun): string {
  const lines: string[] = [];
  const stage = (['verify', 'implement', 'plan'] as const).find((k) => run.stages[k]?.status === 'running');
  if (stage) lines.push(`NOW: ${stage === 'verify' ? 'goal verification' : stage === 'plan' ? 'planning' : 'implementation'} stage, round ${run.stages[stage]!.rounds.length || 1}${run.cycles ? `, cycle ${run.cycles + 1}` : ''}.`);
  if (run.resumes) lines.push(`Resumed ${run.resumes} time(s) after Aivenue restarted (last interruption ${run.interruptedAt ? new Date(run.interruptedAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'earlier'}): check what was cut off before going on.`);
  if (run.plan) {
    lines.push(`PLAN: ${cut(run.plan.summary, 800)}`);
    if (run.steps?.length) lines.push(`STEPS:\n${run.steps.map((s) => `- ${s.id}. ${oneLine(s.title, 140)} [${s.status}]${s.note ? ` — ${oneLine(s.note, 200)}` : ''}`).join('\n')}`);
  }
  return lines.join('\n');
}

/** Entries of the conversation log in one page of read_context {topic: "log"}, and in an agent's prompt. */
export const LOG_PAGE = 100;

/**
 * The conversation log: everything said and run in this workflow, every agent and the user, oldest first, one line
 * each. Kept apart from the organized shared context; an agent gets the newest entries and pages back for more.
 */
/**
 * Successful tool calls whose gist other blocks of the prompt summarize: commands, searches, file reads and edits
 * (COMMANDS ALREADY RUN, FILES … READ, FILES CHANGED) and Aivenue's own tools (progress, hand-offs, agent list). Those
 * blocks have budgets of their own, so a given call is not guaranteed to be in the same prompt; the full log stays one
 * read_context away. A failed call is never dropped: the other blocks do not carry why it failed (FILES CHANGED lists
 * a file whose patch failed without the reason).
 */
export const shownElsewhere = (t: NonNullable<AgentEvent['tool']>) => t.status === 'ok' && ['command', 'search', 'read', 'edit', 'hub'].includes(t.category ?? '');

/**
 * The conversation log, oldest first. `inPrompt`: the version for an agent's prompt, without the tool calls the same
 * prompt shows elsewhere (shownElsewhere); what agents said, their results, errors, the user's messages and decisions
 * all stay. read_context {topic: "log"} keeps every entry.
 */
export function conversationLog(run: WorkflowRun, transcriptOf: (agentId: string) => AgentEvent[], entryChars = 600, o: { inPrompt?: boolean } = {}): string[] {
  const rows: { ts: number; text: string }[] = [];
  const at = (ts: number) => new Date(ts).toISOString().slice(5, 16).replace('T', ' ');
  for (const a of Object.values(run.agents)) {
    if (a.role === 'test' || a.role === 'compactor') continue;
    const who = `${a.id.slice(0, 8)} ${ROLE[a.role]} ${a.provider}${a.stage ? ` ${a.stage}#${a.round ?? ''}` : ''}`;
    for (const e of transcriptOf(a.id)) {
      if (e.kind === 'message' && e.text?.trim()) rows.push({ ts: e.ts, text: `[${at(e.ts)}] ${who} said: ${oneLine(e.text, entryChars)}` });
      else if (e.kind === 'tool' && e.tool && e.tool.status !== 'running' && !(o.inPrompt && shownElsewhere(e.tool)))
        rows.push({ ts: e.ts, text: `[${at(e.ts)}] ${who} ${e.tool.name}: ${oneLine(e.tool.title || e.tool.input, 200)} → ${e.tool.status}${e.tool.status === 'error' && e.tool.output ? ` (${oneLine(e.tool.output, 200)})` : ''}` });
      else if (e.kind === 'error' && e.text?.trim()) rows.push({ ts: e.ts, text: `[${at(e.ts)}] ${who} error: ${oneLine(e.text, 300)}` });
    }
    if (a.endedAt && a.status !== 'running') rows.push({ ts: a.endedAt, text: `[${at(a.endedAt)}] ${who} ended [${a.status}]: ${oneLine(agentResult(run, a), entryChars) || '—'}` });
  }
  for (const m of run.userMessages ?? []) rows.push({ ts: m.ts, text: `[${at(m.ts)}] USER: ${oneLine(m.text, entryChars * 2)}` });
  for (const n of run.notes ?? []) if (n.kind === 'decision') rows.push({ ts: n.ts, text: `[${at(n.ts)}] DECISION: ${oneLine(n.text, entryChars * 2)}` });
  return rows.sort((x, y) => x.ts - y.ts).map((r) => r.text);
}

/** One page of the conversation log (page 1 = the newest entries). */
export function logPage(entries: string[], page: number): string {
  const pages = Math.max(1, Math.ceil(entries.length / LOG_PAGE));
  const p = Math.min(Math.max(1, page), pages);
  const end = entries.length - (p - 1) * LOG_PAGE;
  const part = entries.slice(Math.max(0, end - LOG_PAGE), end);
  return [`CONVERSATION LOG — page ${p} of ${pages} (${entries.length} entries, oldest first on each page; page 1 is the newest${p < pages ? `, read_context {topic: "log", page: ${p + 1}} for older` : ''}):`, ...(part.length ? part : ['(empty)'])].join('\n');
}

/** Overview for `read_context` without an agent id. `eventsOf` adds the commands every agent ran and the project knowledge. */
export function overview(run: WorkflowRun, eventsOf?: (agentId: string) => AgentEvent[]): string {
  const parts = [`GOAL:\n${run.config.goal}`];
  // The shared memory in full: every active entry, and what was replaced, retracted or merged, with why.
  if (run.memory?.entries?.length) {
    const all = renderMemory(run.memory.entries, 1_000_000, { tokens: (t) => Math.ceil(t.length / 4) }).text;
    const history = memoryHistory(run.memory.entries);
    parts.push(`SHARED MEMORY (all entries, cycle ${run.memory.cycle ?? 0}):\n${all}${history ? `\n\n${history}` : ''}`);
  }
  const status = statusBlock(run);
  if (status) parts.push(status);
  if (run.plan) parts.push(`CURRENT PLAN:\n${run.plan.markdown?.trim() || run.plan.summary}\n\nSteps:\n${run.plan.steps.map((s) => `${s.id}. ${s.title}${s.detail ? ` — ${s.detail}` : ''}`).join('\n')}`);
  if (run.steps.length) parts.push(`STEP PROGRESS:\n${run.steps.map((s) => `${s.id}. ${s.title} [${s.status}]${s.note ? ` — ${s.note}` : ''}`).join('\n')}`);
  for (const key of ['plan', 'implement'] as const) {
    for (const r of run.stages[key].rounds) {
      const rows: string[] = [];
      if (r.userFeedback) rows.push(`User feedback: ${r.userFeedback}`);
      if (r.submission) rows.push(`Author submitted: ${r.submission.plan ? `plan "${r.submission.plan.summary}"` : r.submission.summary}`);
      for (const resp of r.submission?.responses ?? [])
        rows.push(
          `  response to ${resp.issue_id}: ${resp.unmatched ? `not a review issue of this round (sent as ${resp.action === 'unclassified' ? resp.given || 'no action' : resp.action}; counted as nothing)` : resp.action}${resp.conflict ? ` [same source as open decision ${resp.conflict}]` : ''}${resp.note ? ` — ${resp.note}` : ''}`,
        );
      for (const d of r.submission?.openDecisions ?? []) rows.push(...decisionLines(d).map((l) => `  ${l}`));
      if (r.review) {
        rows.push(`Review: ${r.review.verdict} — ${r.review.summary}`);
        for (const i of r.review.issues) rows.push(`  ${i.id} [${i.severity}] ${i.title}${i.location ? ` (${i.location})` : ''}${i.detail ? `: ${i.detail}` : ''}`);
        // Not confirmed and without severity: kept apart so no one passes them on as facts.
        for (const n of r.review.needsValidation ?? []) rows.push(`  ${n.id} [needs validation, not confirmed] ${n.title}${n.location ? ` (${n.location})` : ''} — missing: ${n.missing}${n.how ? ` — to confirm: ${n.how}` : ''}`);
      }
      if (r.route) rows.push(`Routed to ${r.route.to}: ${r.route.reason}`);
      if (rows.length) parts.push(`${key.toUpperCase()} STAGE, ROUND ${r.n}:\n${rows.join('\n')}`);
    }
  }
  for (const r of run.stages.verify?.rounds ?? []) {
    const v = r.verification;
    if (!v) continue;
    const ev = v.evidence ? ` (measured on ${v.evidence.commit ? `commit ${v.evidence.commit}, ` : ''}tree ${v.evidence.treeHash}${v.stale ? ', STALE: code changed since' : ''})` : '';
    parts.push(
      [
        `GOAL VERIFICATION ${r.n}: ${v.outcome} — ${v.summary}${ev}`,
        ...v.metrics.map((m) => `  ${m.id}: ${m.value} (${m.met ? 'met' : 'NOT met'}) — ${m.evidence}`),
        ...v.issues.map((i) => `  ${i.id} [${i.severity}] ${i.title}${i.detail ? `: ${i.detail}` : ''}`),
        r.route ? `  Routed to ${r.route.to}: ${r.route.reason}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  const handoffs = handoffsBlock(run);
  if (handoffs) parts.push(handoffs);
  if (run.knowledge) parts.push(`SHARED KNOWLEDGE (organized from ${run.knowledge.notes} notes):\n${run.knowledge.doc}`);
  if (eventsOf) {
    const index = topicIndexBlock(buildTopics(run, eventsOf), 4000);
    if (index) parts.push(index);
    const act = collectActivity(run, eventsOf);
    const knowledge = knowledgeBlock(run, act, 12000, true);
    if (knowledge) parts.push(knowledge);
    const activity = activityBlock(act, 20000);
    if (activity) parts.push(activity);
  }
  parts.push(
    `AGENTS:\n${others(run)
      .map((a) => `- ${agentLabel(a)} [${a.status}]${a.parentId ? `, sub-agent of ${a.parentId}, task: ${oneLine(a.task, 200)}` : ''}${folded(run, a) ? ' (result in the shared memory)' : `\n  result: ${cut(agentResult(run, a), 1500) || '—'}`}`)
      .join('\n')}`,
  );
  const memory = memoryBlock(run);
  if (memory) parts.push(memory);
  parts.push(`SHARED NOTES${run.memory ? ' (newer than the shared memory)' : ''}${run.knowledge ? ' (also the ones organized into the shared knowledge)' : ''}:\n${notesBlock(run)}`);
  parts.push(`Call read_context {agent_id} for any agent's full transcript${run.memory ? ', or read_context {agent_id: "notes"} for every original note' : ''}.`);
  return parts.join('\n\n');
}

/**
 * A tool call's input without its JSON wrapping: the arguments the title does not already show, as `name: value`.
 * Raw JSON of every call was the most repeated part of transcripts, for the compactor and for read_context.
 */
export function toolInputText(title: string, input: string | undefined, max = 1200): string {
  const raw = (input ?? '').trim();
  if (!raw || raw === title.trim()) return '';
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return cut(raw, max);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return cut(raw, max);
  const parts = Object.entries(obj as Record<string, unknown>)
    .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)] as const)
    .filter(([, v]) => v !== undefined && v !== '' && v !== '{}' && v !== '[]' && !title.includes(v.trim()));
  return cut(parts.map(([k, v]) => `${k}: ${cut(v, 600)}`).join('\n    '), max);
}

/**
 * An agent's run as readable text: messages, tool calls with input/output, results. `part`: only messages or only
 * tool calls. Over budget it is paged from the end: page 1 is the newest part, page 2 the one before it…
 */
export function formatTranscript(events: AgentEvent[], o: { budget: number; prompts?: boolean; part?: 'all' | 'messages' | 'tools'; page?: number }): string {
  const out: string[] = [];
  const messages = o.part !== 'tools';
  const tools = o.part !== 'messages';
  let last = '';
  let repeats = 0;
  for (const e of events) {
    switch (e.kind) {
      case 'prompt':
        if (o.prompts && messages) out.push(`[Instructions from Aivenue]\n${cut(e.text, 3000)}`);
        break;
      case 'message':
        if (messages) out.push(`[Agent] ${cut(e.text, 4000)}`);
        break;
      case 'tool': {
        if (!e.tool || !tools) break;
        // The same call with the same output again (polling a log, re-reading a file): once, with a count.
        const key = `${e.tool.name}|${e.tool.title}|${e.tool.input ?? ''}|${e.tool.output ?? ''}`;
        if (key === last && out.length) {
          repeats++;
          out[out.length - 1] = out[out.length - 1].replace(/\n  \(same call again ×\d+\)$/, '') + `\n  (same call again ×${repeats})`;
          break;
        }
        last = key;
        repeats = 0;
        const input = toolInputText(e.tool.title, e.tool.input);
        out.push([`[Tool ${e.tool.name}] ${e.tool.title} → ${e.tool.status}`, input ? `  input: ${input}` : '', e.tool.output ? `  output: ${cut(e.tool.output, 2000)}` : ''].filter(Boolean).join('\n'));
        break;
      }
      case 'result':
        if (e.text?.trim() && messages) out.push(`[Final] ${cut(e.text, 4000)}`);
        break;
      case 'error':
        out.push(`[Error] ${cut(e.text, 1000)}`);
        break;
    }
  }
  const text = out.join('\n\n');
  if (!text) return '(no activity recorded)';
  if (text.length <= o.budget) return o.page && o.page > 1 ? '(the whole conversation fits on page 1)' : text;
  const pages = Math.ceil(text.length / o.budget);
  const page = Math.max(1, Math.floor(o.page ?? 1));
  if (page > pages) return `(there are only ${pages} pages)`;
  const end = text.length - (page - 1) * o.budget;
  const start = Math.max(0, end - o.budget);
  return [`(page ${page} of ${pages}${page < pages ? `; page ${page + 1} for the part before this` : ''})`, start > 0 ? '…' + text.slice(start, end) : text.slice(start, end), end < text.length ? `… (newer part: page ${page - 1})` : ''].filter(Boolean).join('\n');
}
