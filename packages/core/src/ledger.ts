import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentEvent, AgentRunInfo, WorkflowRun } from './types';

/**
 * What every agent did, built from their recorded events (no model call), for the shared context:
 * - the commands they ran and how each ended (so nobody re-runs a test or a scan to learn what is already known),
 * - the files they changed and read,
 * - what Graphify told them about the project (and the graph's own report),
 * - where the workflow stands: goal and gap, open issues, routing, waits, GPU locks, background processes, blockers.
 * Every line names the agent (id and role) it comes from.
 */

const ROLE: Record<string, string> = {
  planner: 'planner',
  plan_reviewer: 'plan reviewer',
  executor: 'implementer',
  code_reviewer: 'code reviewer',
  verifier: 'goal verifier',
  adjudicator: 'adjudicator',
  subagent: 'sub-agent',
  advisor: 'advisor',
};

export const who = (a: AgentRunInfo | undefined) => (a ? `${a.id.slice(0, 8)} ${ROLE[a.role] ?? a.role}` : 'agent');

const flat = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The end of a command's output: usually its verdict ("12 passed", "exit 1", the error). */
function outcome(output: string | undefined, n = 180): string {
  // eslint-disable-next-line no-control-regex
  const lines = (output ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  const errs = lines.filter((l) => /error|fail|exception|traceback|not found|denied/i.test(l));
  const pick = errs.length ? [errs[0], lines[lines.length - 1]] : lines.slice(-2);
  return clip([...new Set(pick)].join(' ⏎ '), n);
}

export interface LedgerEntry {
  ts: number;
  agent: AgentRunInfo;
  kind: 'command' | 'graph';
  what: string;
  ok: boolean;
  result: string;
  /** Files changed after it ran: its result may be out of date. */
  outdated?: boolean;
}

/** The command ran, but what it printed says the check failed (a test run, `…; echo exit=$?`). */
const FAILED = /\bexit(?: code)?[=: ]+[1-9]|\bFAIL(ED)?\b|\b[1-9]\d* (failed|failing)\b|Traceback|\bError:/;

const GRAPH = /\bgraphify\s+(query|path|explain|update|build|report)\b/i;

/** Commands (and Graphify lookups) of every agent but `selfId`, plus the files changed and read, newer than `since`. */
export function collectActivity(run: WorkflowRun, eventsOf: (agentId: string) => AgentEvent[], o: { since?: number; selfId?: string } = {}) {
  const rel = (f: string) => {
    const r = path.relative(run.config.cwd, path.resolve(run.config.cwd, f));
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.replace(/\\/g, '/') : f;
  };
  const entries: LedgerEntry[] = [];
  const changed = new Map<string, { ts: number; by: AgentRunInfo }>();
  const read = new Map<string, Set<string>>();
  let lastEdit = 0;
  for (const a of Object.values(run.agents)) {
    if (a.role === 'test' || a.role === 'compactor') continue;
    for (const e of eventsOf(a.id)) {
      if (e.kind !== 'tool' || !e.tool || e.tool.status === 'running') continue;
      const t = e.tool;
      if (t.category === 'edit') {
        lastEdit = Math.max(lastEdit, e.ts);
        for (const f of e.files?.length ? e.files : [t.title]) changed.set(rel(f), { ts: e.ts, by: a });
        continue;
      }
      if (a.id === o.selfId) continue;
      if (t.category === 'read') {
        const f = rel(flat(t.title));
        if (f) (read.get(f) ?? read.set(f, new Set()).get(f)!).add(a.id.slice(0, 8));
        continue;
      }
      if (t.category !== 'command' && t.category !== 'search') continue;
      const what = flat(t.title || t.input).slice(0, 300);
      if (!what) continue;
      entries.push({ ts: e.ts, agent: a, kind: GRAPH.test(what) ? 'graph' : 'command', what, ok: t.status === 'ok', result: GRAPH.test(what) ? clip(flat(t.output), 900) : outcome(t.output) });
    }
  }
  for (const en of entries) en.outdated = [...changed.values()].some((c) => c.ts > en.ts);
  const since = o.since ?? 0;
  return {
    entries: entries.filter((e) => e.ts > since).sort((x, y) => x.ts - y.ts),
    changed: [...changed.entries()].filter(([, c]) => c.ts > since),
    read: [...read.entries()],
    lastEdit,
  };
}

/** The same command run again keeps only its latest result. */
function latestPerCommand(entries: LedgerEntry[]): LedgerEntry[] {
  const by = new Map<string, LedgerEntry>();
  for (const e of entries) by.set(e.what, e);
  return [...by.values()].sort((x, y) => x.ts - y.ts);
}

function fit(lines: string[], budget: number, head: string): string {
  if (!lines.length) return '';
  const out: string[] = [];
  let used = head.length;
  // Newest first within the budget, shown oldest first.
  for (let i = lines.length - 1; i >= 0 && used + lines[i].length + 1 <= budget; i--) {
    out.unshift(lines[i]);
    used += lines[i].length + 1;
  }
  const dropped = lines.length - out.length;
  return [head, ...(dropped ? [`- (${dropped} older line(s) left out; search_records finds them)`] : []), ...out].join('\n');
}

/** Commands and their results, files changed and read. */
export function activityBlock(act: ReturnType<typeof collectActivity>, budget: number): string {
  const cmds = latestPerCommand(act.entries.filter((e) => e.kind === 'command'));
  const parts: string[] = [];
  parts.push(
    fit(
      cmds.map((e) => `- [${who(e.agent)}] ${!e.ok ? '✗' : FAILED.test(e.result) ? '⚠' : '✓'} \`${clip(e.what, 160)}\`${e.result ? ` → ${e.result}` : ''}${e.outdated ? ' (files changed since; re-run if it matters)' : ''}`),
      Math.floor(budget * 0.7),
      'COMMANDS ALREADY RUN BY OTHER AGENTS (who, command, how it ended: ✓ ok, ⚠ ran but its output reports a failure, ✗ failed). Use these results instead of running the same command again; re-run only when files changed since or you need the full output (read_context {agent_id}):',
    ),
  );
  if (act.changed.length)
    parts.push(
      fit(
        act.changed.map(([f, c]) => `- ${f} (by ${who(c.by)})`),
        Math.floor(budget * 0.15),
        'FILES CHANGED:',
      ),
    );
  if (act.read.length) parts.push(clip(`FILES OTHER AGENTS ALREADY READ: ${act.read.map(([f, ids]) => `${f} (${[...ids].join(',')})`).join('; ')}`, Math.floor(budget * 0.15)));
  return parts.filter(Boolean).join('\n\n');
}

/**
 * What is known about the project's structure: the Graphify report (when the folder has a graph) and every
 * Graphify lookup an agent made, so the next agent starts from that instead of exploring again.
 */
export function knowledgeBlock(run: WorkflowRun, act: ReturnType<typeof collectActivity>, budget: number, withReport: boolean): string {
  const parts: string[] = [];
  const out = path.join(run.config.cwd, 'graphify-out');
  if (withReport && fs.existsSync(path.join(out, 'graph.json'))) {
    const report = ['GRAPH_REPORT.md', 'report.md'].map((f) => path.join(out, f)).find((f) => fs.existsSync(f));
    const text = report ? fs.readFileSync(report, 'utf8').trim() : '';
    parts.push(
      text
        ? `PROJECT STRUCTURE (Graphify report of this folder, ${new Date(fs.statSync(report!).mtimeMs).toISOString().slice(0, 16)}):\n${clip(text, Math.floor(budget * 0.5))}`
        : 'PROJECT STRUCTURE: this folder has a Graphify graph (graphify-out/graph.json); ask it with `graphify query "<question>"` before exploring files.',
    );
  }
  const lookups = latestPerCommand(act.entries.filter((e) => e.kind === 'graph' && e.ok && e.result));
  if (lookups.length)
    parts.push(
      fit(
        lookups.map((e) => `- [${who(e.agent)}] \`${clip(e.what, 140)}\`${e.outdated ? ' (files changed since)' : ''}\n  ${e.result}`),
        budget - parts.join('').length,
        'WHAT GRAPHIFY ALREADY ANSWERED (reuse instead of asking again):',
      ),
    );
  return parts.join('\n\n');
}

/** Where the workflow stands right now: goal and gap, open issues, routing, waits, locks, processes, blockers. */
export function statusBlock(run: WorkflowRun): string {
  const lines: string[] = [];
  const goal = run.plan?.goal;
  const checks = (run.stages.verify?.rounds ?? []).flatMap((r) => (r.verification ? [{ v: r.verification, route: r.route }] : []));
  const last = checks[checks.length - 1];
  if (goal) {
    lines.push(`Goal that must be met: ${clip(flat(goal.statement), 300)}`);
    for (const m of goal.metrics) {
      const got = last?.v.metrics.find((x) => x.id === m.id);
      lines.push(`- ${m.id} ${m.name}: target ${clip(flat(m.target), 160)}${got ? ` — last measured: ${clip(flat(got.value), 120)} (${got.met ? 'met' : 'NOT met'}${last!.v.stale ? ', STALE: code changed since' : ''})` : ' — not measured yet'}`);
    }
    for (const m of last?.v.metrics.filter((x) => !goal.metrics.some((g) => g.id === x.id)) ?? []) lines.push(`- ${m.id} (the user's own criterion): ${clip(flat(m.value), 120)} (${m.met ? 'met' : 'NOT met'})`);
  }
  if (run.cycles) lines.push(`Cycle ${run.cycles + 1} (goal verification sent the work back ${run.cycles} time(s)).`);
  if (last?.route && last.route.to !== 'done') lines.push(`Last verification → ${last.route.to}: ${clip(last.route.reason, 200)}`);
  // Open issues of the latest review in each stage.
  for (const key of ['plan', 'implement'] as const) {
    const r = [...run.stages[key].rounds].reverse().find((x) => x.review);
    if (r?.review?.verdict === 'revise' && r.review.issues.length) lines.push(`Open ${key} review issues (round ${r.n}${r.review.stale ? ', STALE' : ''}): ${r.review.issues.map((i) => `${i.id} [${i.severity}] ${clip(i.title, 80)}`).join('; ')}`);
    if (r?.route?.to === 'planner') lines.push(`Code review → planner: ${clip(r.route.reason, 200)}`);
  }
  if (last && last.v.issues.length && last.route?.to !== 'done') lines.push(`Verification issues: ${last.v.issues.map((i) => `${i.id} ${clip(i.title, 80)}`).join('; ')}`);
  for (const r of run.rulings ?? []) lines.push(`Ruling on ${r.issueId}: ${clip(r.ruling, 200)}`);
  const agentOf = (id: string) => run.agents[id];
  for (const w of run.waits ?? [])
    if (w.state === 'waiting')
      lines.push(`Waiting (wait_id ${w.id}, ${who(agentOf(w.agentId))}): \`${clip(w.check, 120)}\` every ${w.intervalSec}s until ${new Date(w.timeoutAt).toISOString().slice(11, 16)} UTC${w.gpus ? `, then lock ${w.gpus} GPU` : ''}${w.lastOutput ? `; last check: ${clip(flat(w.lastOutput), 120)}` : ''}. To keep waiting call wait_for {wait_id: "${w.id}"}.`);
  for (const l of run.gpuLocks ?? []) lines.push(`GPU ${l.gpus.join(', ')} locked by ${who(agentOf(l.agentId))}: do not use those cards.`);
  for (const p of run.processes ?? []) lines.push(`Background process ${p.pid} (${clip(p.purpose, 80)}) by ${who(agentOf(p.agentId))}: ${p.alive ? 'running' : 'ended'}; cleanup: ${p.cleanup}.`);
  for (const a of Object.values(run.agents)) {
    if (!['running', 'paused', 'queued'].includes(a.status)) continue;
    lines.push(`Working now: ${who(a)} (${a.provider}) — ${clip(flat(a.task), 100)}${a.waiting ? `; waiting: ${clip(a.waiting, 100)}` : ''}${a.failure ? `; recovering from ${a.failure.kind}: ${clip(a.failure.action, 100)}` : ''}`);
  }
  if (run.pending) lines.push(`Waiting for the user to decide: ${clip(run.pending.message, 160)}`);
  if (run.approvals?.length) lines.push(`${run.approvals.length} action(s) waiting for the user's approval.`);
  return lines.length ? `WORKFLOW STATUS NOW:\n${lines.join('\n')}` : '';
}

/** The latest hand-off of each stage: facts, decisions and open points, with the agents they come from. */
export function handoffsBlock(run: WorkflowRun, since = 0): string {
  const out: string[] = [];
  for (const [key, st] of Object.entries(run.stages)) {
    const r = [...(st?.rounds ?? [])].reverse().find((x) => x.handoff);
    const h = r?.handoff;
    if (!h || h.ts <= since) continue;
    const src = h.links.filter((l) => l.agentId && !l.issueId).map((l) => `${l.label} ${l.agentId!.slice(0, 8)}`).join(', ');
    out.push(
      [
        `${key} round ${h.round} (${src}):`,
        ...h.decisions.map((d) => `  DECISION: ${clip(flat(d), 240)}`),
        ...h.facts.map((d) => `  FACT: ${clip(flat(d), 240)}`),
        ...h.open.map((d) => `  OPEN: ${clip(flat(d), 200)}`),
      ].join('\n'),
    );
  }
  return out.length ? `HAND-OFFS (latest of each stage):\n${out.join('\n')}` : '';
}
