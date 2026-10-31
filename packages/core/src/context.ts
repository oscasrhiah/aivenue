import type { AgentEvent, AgentRunInfo, ContextSharing, SharedNote, WorkflowRun } from './types';
import { activityBlock, collectActivity, fit, handoffsBlock, knowledgeBlock, statusBlock } from './ledger';
import { buildTopics, topicIndexBlock } from './topics';

/**
 * Shared context between agents: an overview of the workflow, full transcripts on request,
 * and the block every agent's prompt gets. Text is English because it goes to the models.
 */

export const DEFAULT_SHARING: ContextSharing = 'on_demand';
/** One page of an agent's conversation through read_context {agent_id}. */
export const TRANSCRIPT_PAGE = 40000;
/** Notes that are an agent's hand-off (also organized by the librarian), shown as hand-offs rather than as notes. */
export const HANDOFF_NOTE = /^HAND-OFF\b/;
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
const USER_SAID = /\b(the )?user (said|says|asked|asks|wants|prefers|requested|instructed|told|requires|chose)\b|\buser'?s? (instruction|request|preference|requirement)|使用者|用戶/i;

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
  const tools = events.filter((e) => e.kind === 'tool' && e.tool && e.tool.status !== 'running' && (e.tool.category === 'command' || e.tool.category === 'edit'));
  if (tools.length) lines.push(`Its last commands and edits:\n${tools.slice(-8).map((e) => `- ${oneLine(e.tool!.title || e.tool!.input, 200)} → ${e.tool!.status}${e.tool!.status === 'error' && e.tool!.output ? `: ${oneLine(e.tool!.output, 300)}` : ''}`).join('\n')}`);
  return { text: lines.join('\n') || '(it did nothing that was recorded)', auto: true };
}

/**
 * One agent in the directory of the shared context: who, where, its state, what it handed over (the first line, or
 * all of it in "full" sharing).
 */
function directoryLine(run: WorkflowRun, a: AgentRunInfo, resultChars: number, whole = false): string {
  const where = a.stage && a.role !== 'subagent' ? `, ${a.stage} stage` : a.parentId ? `, sub-agent of ${a.parentId.slice(0, 8)}` : '';
  const h = a.handover?.text && !a.handover.auto ? `\n  hand-off: ${whole ? a.handover.text.trim().replace(/\n/g, '\n    ') : oneLine(a.handover.text, 300)}` : '';
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
 * everything up to then, so it only gets what is new. `maxChars`: this agent's share of its model. The goal, status
 * and hand-offs always come first; the rest fills the share newest first, and what does not fit stays reachable through
 * read_context and search_records. `recap`: what the agent's own conversation did before its CLI compacted it.
 */
export function contextBlock(run: WorkflowRun, self: AgentRunInfo, transcriptOf: (agentId: string) => AgentEvent[], o: { since?: number; maxChars?: number; recap?: (budget: number) => string } = {}): string {
  const mode = sharingOf(run);
  if (mode === 'summary') return '';
  const since = o.since ?? 0;
  const max = o.maxChars ?? 40000;
  const fresh = (a: AgentRunInfo) => a.status === 'running' || (a.endedAt ?? 0) > since;
  const agents = others(run, self.id);
  const foldedCount = agents.filter((a) => folded(run, a)).length;
  const list = [
    ...(foldedCount && !since ? [`- (${foldedCount} earlier agent(s): see the shared memory below)`] : []),
    // "full": every agent's whole hand-off (organized by the agent itself), not only the one right before.
    ...agents.filter((a) => !folded(run, a) && fresh(a)).map((a) => (mode === 'full' ? directoryLine(run, a, 2000, true) : directoryLine(run, a, 1200))),
  ];
  const memory = run.memory && run.memory.updatedAt > since ? memoryBlock(run) : '';
  const upto = Math.max(run.memory?.upto ?? 0, run.knowledge?.upto ?? 0);
  // Hand-offs come as hand-offs (the agent directory, the one before this agent in full); notes from an earlier
  // message only when they are decisions or the user's instructions, the rest is in the organized knowledge and searchable.
  const inPrompt = (n: SharedNote) => !HANDOFF_NOTE.test(n.text) && (!n.carried || n.kind === 'decision' || USER_SAID.test(n.text));
  const notes = (run.notes ?? []).filter((n) => n.ts > upto && n.ts > since && inPrompt(n)).map((n) => noteLine(run, n));
  const carriedOut = !since ? (run.notes ?? []).filter((n) => n.carried && !inPrompt(n) && !HANDOFF_NOTE.test(n.text)).length : 0;
  const knowledgeDoc = run.knowledge && run.knowledge.updatedAt > since ? run.knowledge.doc : '';
  // Always first: where things stand and what was handed over.
  const status = statusBlock(run);
  const handoffs = handoffsBlock(run, since);
  const act = collectActivity(run, transcriptOf, { since, selfId: self.id });
  const footer =
    "Call the Aivenue tool `read_context` {} for the full overview (complete plan, every review and verification, all summaries), `read_context` {agent_id} for any agent's conversation (its messages, commands and their output; part \"messages\" or \"tools\", page 2 for older parts), or `search_records` {q, role, file, issue_id…} to find something specific. Use `post_note` {text, kind: fact|inference|decision} to tell all later agents about a decision, a gotcha or where something lives. When you submit, list what you learned in `findings` and write your `handoff` for the agent who takes over: the state, what is open, what to do next and where to look.";
  const head = [
    since ? 'SHARED CONTEXT (only what is new since your last turn, plus the current status):' : 'SHARED CONTEXT: You work together with other agents on this workflow.',
    progressBlock(run),
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
  // Whoever worked right before this agent hands over what it wrote for the next one, not its raw conversation: that
  // stays in the shared records (read_context {agent_id}). A sub-agent has its task from its parent instead.
  const prev = self.parentId ? undefined : others(run, self.id).filter((a) => a.depth === 0 && a.status !== 'running').pop();
  const handover = prev && fresh(prev) ? handoverOf(run, prev, transcriptOf(prev.id)) : undefined;
  const handoverText = take(handover
    ? `HAND-OFF FROM THE AGENT BEFORE YOU — ${agentLabel(prev!)} [${prev!.status}]${handover.auto ? ' (it wrote none; put together by Aivenue from what it did)' : ''}:\n${handover.auto ? cut(handover.text, Math.max(6000, Math.floor(room * 0.4))) : handover.text.trim()}\nIts whole conversation is in the shared records: read_context {agent_id: "${prev!.id}"} (part "messages" for what it said, "tools" for its commands and their output).`
    : '');
  const recap = o.recap ? take(o.recap(Math.floor(room * 0.3))) : '';
  // The organized knowledge and the table of contents of every record, before the newest raw items.
  const organized = take(knowledgeDoc ? `SHARED KNOWLEDGE (organized by subject from the shared notes, with sources [n:id]; read_context {topic: "knowledge"} for all of it):\n${cut(knowledgeDoc, Math.floor(room * 0.25))}` : '');
  const index = take(topicIndexBlock(buildTopics(run, transcriptOf), Math.max(1500, Math.floor(room * 0.06)), since));
  const carriedText = carriedOut ? `(${carriedOut} more notes from earlier messages of this conversation are in the shared records${run.knowledge ? ", organized in the shared knowledge" : ""}: search_records {q} or read_context {topic: "facts"} when you need one.)` : '';
  const noteText = take([notes.length ? fit(notes, Math.floor(room * 0.3), `Shared notes${since ? ' (new)' : ''}:`) : since ? '' : 'Shared notes:\n(no notes yet)', carriedText].filter(Boolean).join('\n'));
  const listText = take(list.length ? fit(list, Math.floor(room * 0.2), `Agents${since ? ' (new or updated)' : ' so far'} — read_context {agent_id} for any one's whole conversation:`) : since ? '' : 'You are the first agent in this workflow.');
  const memText = take(memory ? cut(memory, Math.floor(room * 0.3)) : '');
  const knowledge = take(knowledgeBlock(run, act, Math.floor(Math.max(0, room) * 0.25), !since));
  const activity = take(activityBlock(act, Math.max(2000, room)));
  if (since && !handoverText && !recap && !organized && !list.length && !memory && !notes.length && !handoffs && !knowledge && !activity) return `\nSHARED CONTEXT: nothing new from the other agents since your last turn.${status ? `\n${status}` : ''}`;
  const lines = ['', head, handoverText, recap, organized, index, listText, memText, noteText, knowledge, activity, footer];
  let text = lines.filter((l) => l !== '').join('\n');
  // Still over this agent's share (a huge status or hand-off): keep the start, where the goal and status are.
  if (o.maxChars && text.length > o.maxChars) text = `${text.slice(0, o.maxChars)}\n… (shortened to fit your model; call read_context {} for the rest)`;
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
