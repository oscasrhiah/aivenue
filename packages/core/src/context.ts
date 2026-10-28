import type { AgentEvent, AgentRunInfo, ContextSharing, SharedNote, WorkflowRun } from './types';
import { activityBlock, collectActivity, handoffsBlock, knowledgeBlock, statusBlock } from './ledger';

/**
 * Shared context between agents: an overview of the workflow, full transcripts on request,
 * and the block every agent's prompt gets. Text is English because it goes to the models.
 */

export const DEFAULT_SHARING: ContextSharing = 'on_demand';
/** Most characters of the previous agent's transcript inlined in "full" mode (prompts go through stdin, so no command-line limit). */
export const FULL_BUDGET = 1_000_000;
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
  const notes = (run.notes ?? []).filter((n) => n.ts > upto && n.ts > (o.since ?? 0));
  if (!notes.length) return '(no notes yet)';
  return notes.map((n) => noteLine(run, n)).join('\n');
}

/** The compacted shared memory, if any. */
function memoryBlock(run: WorkflowRun): string {
  const m = run.memory;
  return m?.summary ? `SHARED MEMORY (earlier notes and agent results, condensed):\n${m.summary}` : '';
}

/** Whether an agent's result is already folded into the shared memory. */
const folded = (run: WorkflowRun, a: AgentRunInfo) => !!run.memory && !!a.endedAt && a.endedAt <= run.memory.upto;

/** Every original note, also the ones folded into the shared memory (read_context {agent_id: "notes"}). */
export function allNotes(run: WorkflowRun): string {
  return `ALL SHARED NOTES (originals):\n${notesBlock(run, { all: true })}`;
}

/**
 * The block appended to an agent's prompt (empty in "summary" mode). `since`: a resumed conversation already has
 * everything up to then, so it only gets what is new. `maxChars`: the cap for this agent's model (the rest stays
 * reachable through read_context).
 */
export function contextBlock(run: WorkflowRun, self: AgentRunInfo, transcriptOf: (agentId: string) => AgentEvent[], o: { since?: number; maxChars?: number } = {}): string {
  const mode = sharingOf(run);
  if (mode === 'summary') return '';
  const since = o.since ?? 0;
  const fresh = (a: AgentRunInfo) => a.status === 'running' || (a.endedAt ?? 0) > since;
  const agents = others(run, self.id).filter((a) => a.id !== self.parentId || mode !== 'full');
  const foldedCount = agents.filter((a) => folded(run, a)).length;
  const list = [
    ...(foldedCount && !since ? [`- (${foldedCount} earlier agent(s): see the shared memory below)`] : []),
    ...agents.filter((a) => !folded(run, a) && fresh(a)).map((a) => `- ${agentLabel(a)} [${a.status}]: ${oneLine(agentResult(run, a), 160) || '—'}`),
  ];
  const memory = run.memory && run.memory.updatedAt > since ? memoryBlock(run) : '';
  const notes = notesBlock(run, { since });
  // Where things stand, what was handed over, and what every other agent already ran and learned.
  const status = statusBlock(run);
  const handoffs = handoffsBlock(run, since);
  const act = collectActivity(run, transcriptOf, { since, selfId: self.id });
  const footer =
    'Call the Aivenue tool `read_context` {} for the full overview (complete plan, every review and verification, all summaries), `read_context` {agent_id} for an agent\'s full transcript (its messages, commands and their output), or `search_records` {q, role, file, issue_id…} to find something specific. Use `post_note` {text, kind: fact|inference|decision} to tell all later agents about a decision, a gotcha or where something lives.';
  const fixed = [
    '',
    since ? 'SHARED CONTEXT (only what is new since your last turn, plus the current status):' : 'SHARED CONTEXT: You work together with other agents on this workflow.',
    status,
    handoffs,
    list.length ? `Agents${since ? ' (new or updated)' : ' so far'}:\n${list.join('\n')}` : since ? '' : 'You are the first agent in this workflow.',
    memory,
    `Shared notes${since ? ' (new)' : ''}:\n${notes}`,
  ];
  // What is left of this agent's share goes to the project knowledge and the commands others ran.
  const room = Math.max(3000, (o.maxChars ?? 40000) - fixed.join('\n').length - footer.length - 200);
  const knowledge = knowledgeBlock(run, act, Math.floor(room * 0.4), !since);
  const activity = activityBlock(act, room - knowledge.length);
  if (since && !list.length && !memory && notes === '(no notes yet)' && !handoffs && !knowledge && !activity) return `\nSHARED CONTEXT: nothing new from the other agents since your last turn.${status ? `\n${status}` : ''}`;
  const lines = [...fixed, knowledge, activity, footer];
  if (mode === 'full') {
    // The most recent hand-off: whoever worked right before this agent (for a sub-agent, its parent so far).
    const prev = self.parentId ? run.agents[self.parentId] : others(run, self.id).filter((a) => a.depth === 0 && a.status !== 'running').pop();
    if (prev && fresh(prev)) {
      const budget = Math.max(4000, Math.min(FULL_BUDGET, (o.maxChars ?? FULL_BUDGET) - lines.join('\n').length));
      lines.push(`\nFULL TRANSCRIPT OF THE PREVIOUS AGENT (${agentLabel(prev)}):\n${formatTranscript(transcriptOf(prev.id), { budget })}`);
    }
  }
  let text = lines.filter((l) => l !== '').join('\n');
  // Over this agent's share of its model: keep the newest part; the rest is one read_context call away.
  if (o.maxChars && text.length > o.maxChars) text = `SHARED CONTEXT (shortened to fit your model; call read_context {} for the rest):\n…${text.slice(-o.maxChars)}`;
  return '\n' + text;
}

/** Overview for `read_context` without an agent id. `eventsOf` adds the commands every agent ran and the project knowledge. */
export function overview(run: WorkflowRun, eventsOf?: (agentId: string) => AgentEvent[]): string {
  const parts = [`GOAL:\n${run.config.goal}`];
  const status = statusBlock(run);
  if (status) parts.push(status);
  if (run.plan) parts.push(`CURRENT PLAN:\n${run.plan.markdown?.trim() || run.plan.summary}\n\nSteps:\n${run.plan.steps.map((s) => `${s.id}. ${s.title}${s.detail ? ` — ${s.detail}` : ''}`).join('\n')}`);
  if (run.steps.length) parts.push(`STEP PROGRESS:\n${run.steps.map((s) => `${s.id}. ${s.title} [${s.status}]${s.note ? ` — ${s.note}` : ''}`).join('\n')}`);
  for (const key of ['plan', 'implement'] as const) {
    for (const r of run.stages[key].rounds) {
      const rows: string[] = [];
      if (r.userFeedback) rows.push(`User feedback: ${r.userFeedback}`);
      if (r.submission) rows.push(`Author submitted: ${r.submission.plan ? `plan "${r.submission.plan.summary}"` : r.submission.summary}`);
      for (const resp of r.submission?.responses ?? []) rows.push(`  response to ${resp.issue_id}: ${resp.action}${resp.note ? ` — ${resp.note}` : ''}`);
      if (r.review) {
        rows.push(`Review: ${r.review.verdict} — ${r.review.summary}`);
        for (const i of r.review.issues) rows.push(`  ${i.id} [${i.severity}] ${i.title}${i.location ? ` (${i.location})` : ''}${i.detail ? `: ${i.detail}` : ''}`);
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
  if (eventsOf) {
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
  parts.push(`SHARED NOTES${run.memory ? ' (newer than the shared memory)' : ''}:\n${notesBlock(run)}`);
  parts.push(`Call read_context {agent_id} for any agent's full transcript${run.memory ? ', or read_context {agent_id: "notes"} for every original note' : ''}.`);
  return parts.join('\n\n');
}

/** An agent's run as readable text: messages, tool calls with input/output, results. Keeps the latest part when over budget. */
export function formatTranscript(events: AgentEvent[], o: { budget: number; prompts?: boolean }): string {
  const out: string[] = [];
  for (const e of events) {
    switch (e.kind) {
      case 'prompt':
        if (o.prompts) out.push(`[Instructions from Aivenue]\n${cut(e.text, 3000)}`);
        break;
      case 'message':
        out.push(`[Agent] ${cut(e.text, 4000)}`);
        break;
      case 'tool':
        if (!e.tool) break;
        out.push(
          [`[Tool ${e.tool.name}] ${e.tool.title} → ${e.tool.status}`, e.tool.input ? `  input: ${cut(e.tool.input, 1200)}` : '', e.tool.output ? `  output: ${cut(e.tool.output, 2000)}` : ''].filter(Boolean).join('\n'),
        );
        break;
      case 'result':
        if (e.text?.trim()) out.push(`[Final] ${cut(e.text, 4000)}`);
        break;
      case 'error':
        out.push(`[Error] ${cut(e.text, 1000)}`);
        break;
    }
  }
  let text = out.join('\n\n');
  if (text.length > o.budget) text = `(earlier part omitted — ${text.length - o.budget} chars)\n…${text.slice(-o.budget)}`;
  return text || '(no activity recorded)';
}
