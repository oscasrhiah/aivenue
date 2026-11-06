/**
 * What a follow-up message inherits from the message it continues (docs/next-task-skills-integration.md,
 * improve-codebase-architecture, first step): one pure function over the previous run, so every piece of carried
 * state is listed in one place and can be tested with plain objects. Whether the CLI conversations themselves can go
 * on (same folder, no worktree, same provider) and the Orchestrator's in-memory caches stay with the Orchestrator.
 */
import type { AgentRunInfo, EarlierPlan, ObservedCheck, SharedMemory, SharedNote, UserWords, WorkflowRun } from './types';
import { conversationUserWords } from './userWords';

/**
 * Where `prev` had got to: its latest approved plan (else its latest one, marked not approved), its steps, its last
 * hand-off and the checks Aivenue saw run (given by the caller). A message that made no plan of its own and took no
 * step passes on the state it was given itself, so "go on" twice in a row still finds it.
 */
export function earlierPlanOf(prev: WorkflowRun, o: { now: number; checks: (ObservedCheck & { output?: string })[]; agentLabel: (a: AgentRunInfo) => string }): EarlierPlan | undefined {
  const stage = prev.stages.plan;
  const rounds = stage?.rounds ?? [];
  const approved = [...rounds].reverse().find((r) => r.submission?.plan && (r.review?.verdict === 'approve' || (stage?.status === 'approved' && r === rounds[rounds.length - 1])));
  const latest = approved ?? [...rounds].reverse().find((r) => r.submission?.plan);
  const planDoc = latest?.submission?.plan ?? prev.plan;
  const steps = (prev.steps ?? []).map((s) => ({ id: s.id, title: s.title, status: s.status, ...(s.note ? { note: s.note } : {}) }));
  const last = Object.values(prev.agents)
    .filter((a) => a.handover?.text?.trim() && a.role !== 'compactor')
    .sort((a, b) => (b.handover!.ts ?? b.endedAt ?? 0) - (a.handover!.ts ?? a.endedAt ?? 0))[0];
  if (!planDoc && !steps.length && !last && !o.checks.length) return prev.earlierPlan;
  return {
    runId: prev.id,
    status: prev.status,
    at: o.now,
    ...(planDoc ? { plan: { summary: planDoc.summary, markdown: planDoc.markdown, ...(latest ? { round: latest.n } : {}), approved: !!approved || (!rounds.length && !!prev.plan) } } : {}),
    steps,
    ...(last ? { handoff: { by: o.agentLabel(last), text: last.handover!.text.trim(), ts: last.handover!.ts ?? last.endedAt ?? 0 } } : {}),
    checks: o.checks,
  };
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const checkLine = (c: EarlierPlan['checks'][number]) =>
  `- ${c.outcome === 'failed' ? '✗ failed' : c.outcome === 'output_failure' ? '⚠ ran, its output reports a failure' : c.outcome === 'in_longer_command' ? '◦ ran within a longer command' : c.outcome === 'may_not_run' ? '◦ not known whether it ran' : '✓ passed'}: \`${c.command}\` (by ${c.by})${c.outdated ? ' — files changed after it, in that message' : c.maybeOutdated ? ' — a failed edit came after it' : ''}`;

/**
 * The previous message's state for a planner's or implementer's prompt, within `budget` characters. When it did not
 * finish: its unfinished steps first, then its failed checks, then the rest; when it finished: only where to read it.
 */
export function earlierPlanBlock(run: WorkflowRun, budget = 3000): string {
  const e = run.earlierPlan;
  if (!e) return '';
  const where = 'read_context {topic: "previous"} has its whole plan, steps, hand-off and check evidence';
  if (e.status === 'completed') return `\n\nTHE PREVIOUS MESSAGE (${e.runId}) FINISHED: ${where}.`;
  const head = `\n\nTHE PREVIOUS MESSAGE (${e.runId}) STOPPED BEFORE IT FINISHED (status: ${e.status}). Its state, from Aivenue's records — not this message's plan or progress: do not redo what it finished, and re-verify its checks before relying on them (they ran before this message). ${where}.`;
  const unfinished = e.steps.filter((s) => s.status !== 'done' && s.status !== 'skipped');
  const done = e.steps.filter((s) => s.status === 'done' || s.status === 'skipped');
  const bad = e.checks.filter((c) => c.outcome === 'failed' || c.outcome === 'output_failure');
  const other = e.checks.filter((c) => !bad.includes(c));
  const step = (s: EarlierPlan['steps'][number]) => `- ${s.id}. ${cut(s.title, 120)} [${s.status}]${s.note ? ` — ${cut(s.note, 200)}` : ''}`;
  // In order of importance; each part whole or left out, and what was left out is counted.
  const parts: { title: string; lines: string[] }[] = [
    { title: `Its plan${e.plan ? ` (${e.plan.approved ? 'approved' : 'NOT approved'}${e.plan.round ? `, plan round ${e.plan.round}` : ''})` : ''}: ${e.plan ? cut(e.plan.summary.replace(/\s+/g, ' '), 300) : '(none recorded)'}`, lines: [] },
    { title: 'Steps not finished:', lines: unfinished.map(step) },
    { title: 'Checks that did not pass:', lines: bad.map(checkLine) },
    { title: 'Steps finished:', lines: done.map(step) },
    { title: 'Other checks it ran:', lines: other.map(checkLine) },
    { title: `Its last hand-off (${e.handoff?.by ?? ''}):`, lines: e.handoff ? [cut(e.handoff.text.replace(/\s+/g, ' '), 600)] : [] },
  ];
  const out = [head];
  let used = head.length;
  const left: string[] = [];
  for (const p of parts) {
    if (p.title.startsWith('Its plan') || p.lines.length) {
      const text = [p.title, ...p.lines].join('\n');
      if (used + text.length + 1 <= budget) {
        out.push(text);
        used += text.length + 1;
      } else left.push(p.title.replace(/:.*$/, ''));
    }
  }
  if (left.length) out.push(`(left out for space: ${left.join('; ')} — ${where})`);
  return out.join('\n');
}

/** read_context {topic: "previous"}: the previous message's state whole. */
export function earlierPlanTopic(run: WorkflowRun): string {
  const e = run.earlierPlan;
  if (!e) return 'This message does not continue an earlier one (or the earlier one left no plan, steps, hand-off or checks).';
  return [
    `THE PREVIOUS MESSAGE ${e.runId} (status: ${e.status}; carried over ${new Date(e.at).toISOString().slice(0, 16)}Z). Its state from Aivenue's records — not this message's own plan or progress; its checks ran before this message: re-verify before relying on them.`,
    e.plan ? `PLAN (${e.plan.approved ? 'approved' : 'NOT approved'}${e.plan.round ? `, plan round ${e.plan.round}` : ''}):\n${e.plan.markdown}` : 'PLAN: none recorded.',
    `STEPS:\n${e.steps.length ? e.steps.map((s) => `- ${s.id}. ${s.title} [${s.status}]${s.note ? ` — ${s.note}` : ''}`).join('\n') : '(none recorded)'}`,
    e.handoff ? `LAST HAND-OFF (${e.handoff.by}, its own account):\n${e.handoff.text}` : 'LAST HAND-OFF: none.',
    `CHECKS AIVENUE SAW RUN:\n${e.checks.length ? e.checks.map((c) => `${checkLine(c)}${c.output ? `\n    ${c.output.replace(/\n/g, '\n    ')}` : ''}`).join('\n') : '(none)'}`,
  ].join('\n\n');
}

export interface Carried {
  /** Every note, marked as carried and with who wrote it. */
  notes: SharedNote[];
  knowledge?: WorkflowRun['knowledge'];
  sideEffects?: WorkflowRun['sideEffects'];
  /** Waits still waiting and not timed out. */
  waits?: WorkflowRun['waits'];
  memory?: SharedMemory;
  /** The latest file change known in the conversation so far, also from a message that never compacted. */
  earlierEdit?: number;
  /** The user's own words of every earlier message, verbatim. */
  earlierUserWords: UserWords[];
  /** The project memory picks (given again only when the new run has project memory on). */
  projectMemoryPicks?: NonNullable<WorkflowRun['projectMemory']>['picks'];
  contextMuted?: WorkflowRun['contextMuted'];
  contextAsked?: WorkflowRun['contextAsked'];
  /** Where the previous message had got to (its plan, steps, hand-off, checks), with its workflow id. */
  earlierPlan?: EarlierPlan;
}

/**
 * The state `prev` hands to the message that continues it. The caller gives the time (`now`, for waits) and the
 * latest file change it observed in `prev`'s own records (`lastEditSeen`), and how to name an agent for a note.
 */
export function carriedState(prev: WorkflowRun, o: { now: number; lastEditSeen: number; agentLabel: (a: AgentRunInfo) => string; checksSeen?: (ObservedCheck & { output?: string })[] }): Carried {
  const earlierPlan = earlierPlanOf(prev, { now: o.now, checks: o.checksSeen ?? [], agentLabel: o.agentLabel });
  const label = (agentId: string) => {
    const a = prev.agents[agentId];
    return a ? o.agentLabel(a) : undefined;
  };
  const waits = (prev.waits ?? []).filter((w) => w.state === 'waiting' && w.timeoutAt > o.now);
  const edit = Math.max(prev.earlierEdit ?? 0, prev.memory?.lastEdit ?? 0, o.lastEditSeen);
  return {
    // Every note goes along (searchable, and organized in the knowledge document that goes along too); only decisions
    // and the user's instructions are put in prompts again: the rest was about the earlier message.
    notes: (prev.notes ?? []).map((n) => ({ ...n, by: n.by ?? label(n.agentId), carried: true })),
    ...(prev.knowledge ? { knowledge: { ...prev.knowledge } } : {}),
    ...(prev.sideEffects?.length ? { sideEffects: [...prev.sideEffects] } : {}),
    ...(waits.length ? { waits: waits.map((w) => ({ ...w })) } : {}),
    ...(prev.memory ? { memory: { ...prev.memory } } : {}),
    ...(edit ? { earlierEdit: edit } : {}),
    earlierUserWords: conversationUserWords(prev).map((w) => ({ ...w })),
    ...(prev.projectMemory?.picks.length ? { projectMemoryPicks: [...prev.projectMemory.picks] } : {}),
    ...(prev.contextMuted ? { contextMuted: [...prev.contextMuted] } : {}),
    ...(prev.contextAsked ? { contextAsked: { ...prev.contextAsked } } : {}),
    ...(earlierPlan ? { earlierPlan } : {}),
  };
}

/** Put the carried state on the new run, exactly where each piece lives. */
export function applyCarried(run: WorkflowRun, c: Carried) {
  run.notes = c.notes;
  if (c.knowledge) run.knowledge = c.knowledge;
  if (c.sideEffects) run.sideEffects = c.sideEffects;
  if (c.waits) run.waits = c.waits;
  if (c.memory) run.memory = c.memory;
  if (c.earlierEdit) run.earlierEdit = c.earlierEdit;
  run.earlierUserWords = c.earlierUserWords;
  if (c.projectMemoryPicks && run.projectMemory && run.projectMemory.mode !== 'off') run.projectMemory.picks = c.projectMemoryPicks;
  if (c.contextMuted) run.contextMuted = c.contextMuted;
  if (c.contextAsked) run.contextAsked = c.contextAsked;
  if (c.earlierPlan) run.earlierPlan = c.earlierPlan;
}
