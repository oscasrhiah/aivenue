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

/**
 * What a test, build or failed command printed that the next agent needs: its error lines and its last lines, up to
 * `n` characters (the full output stays in the records).
 */
function keyOutput(output: string | undefined, n: number): string {
  // eslint-disable-next-line no-control-regex
  const lines = (output ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  if (!lines.length) return '';
  const all = lines.join('\n');
  if (all.length <= n) return all;
  const errs = lines.filter((l) => /error|fail|exception|traceback|assert|not found|denied/i.test(l)).slice(0, 30);
  const tail: string[] = [];
  let used = errs.join('\n').length;
  for (let i = lines.length - 1; i >= 0 && used + lines[i].length + 1 <= n; i--) {
    if (errs.includes(lines[i])) continue;
    tail.unshift(lines[i]);
    used += lines[i].length + 1;
  }
  return clip([...errs, ...(errs.length ? ['…'] : []), ...tail].join('\n'), n);
}

/** Commands whose output the next agent would otherwise re-run for: tests, builds, checks of the environment. */
const IMPORTANT = /\b(test|pytest|jest|vitest|mocha|unittest|tsc|build|compile|make|cargo|gradle|mvn|lint|eslint|ruff|mypy|nvidia-smi|--version|pip (list|show)|npm (ls|list))\b/i;

/** A command that only prints one file (`cat f`, `sed -n 1,80p f`, `head -n 50 f`, `Get-Content f`): that file. */
export function fileReadOf(command: string): string | undefined {
  const c = flat(command).replace(/^(cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*)+/i, '');
  if (/[|;&<>`$]/.test(c)) return undefined;
  const m = /^(cat|type|get-content|gc|less|more|head|tail|sed -n|nl)\s+(.+)$/i.exec(c);
  if (!m) return undefined;
  const parts = m[2].split(' ').filter((p) => !p.startsWith('-') && !/^\d+$/.test(p) && !(/^sed -n$/i.test(m[1]) && /^'?[\d,$]+p'?$/.test(p)));
  return parts.length === 1 ? parts[0].replace(/^["']|["']$/g, '') : undefined;
}

/** Waiting on a background job by hand (`until …; sleep`, `while …; sleep`, `sleep 60 && tail log`). */
export const POLLING = /\b(until|while)\b[\s\S]*\bsleep\b|\bsleep\s+\d+\s*(;|&&)/i;

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

/** A file an agent read, with what it saw (the newest read). */
export interface ReadEntry {
  file: string;
  ts: number;
  agents: Set<string>;
  /** What the read showed. */
  excerpt: string;
  /** Changed after the newest read: read it again. */
  outdated?: boolean;
}

/** The command ran, but what it printed says the check failed (a test run, `…; echo exit=$?`). */
const FAILED = /\bexit(?: code)?[=: ]+[1-9]|\bFAIL(ED)?\b|\b[1-9]\d* (failed|failing)\b|Traceback|\bError:|ParserError|\w+Exception\b|FullyQualifiedErrorId|command not found|No such file or directory|is not recognized as/;

const GRAPH = /\bgraphify\s+(query|path|explain|update|build|report)\b/i;

/**
 * Commands (and Graphify lookups) of every agent but `selfId` (or only of `onlyIds`), plus the files changed and read,
 * newer than `since`. Only the outputs are cut to their useful part; the blocks fit the rest to each agent's share.
 */
export function collectActivity(run: WorkflowRun, eventsOf: (agentId: string) => AgentEvent[], o: { since?: number; selfId?: string; onlyIds?: Set<string> } = {}) {
  const rel = (f: string) => {
    const r = path.relative(run.config.cwd, path.resolve(run.config.cwd, f));
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.replace(/\\/g, '/') : f;
  };
  const entries: LedgerEntry[] = [];
  const changed = new Map<string, { ts: number; by: AgentRunInfo }>();
  const read = new Map<string, ReadEntry>();
  const addRead = (f: string, ts: number, a: AgentRunInfo, output?: string) => {
    if (!f) return;
    const r = read.get(f) ?? read.set(f, { file: f, ts, agents: new Set(), excerpt: '' }).get(f)!;
    r.agents.add(a.id.slice(0, 8));
    if (ts >= r.ts || !r.excerpt) {
      r.ts = Math.max(r.ts, ts);
      // eslint-disable-next-line no-control-regex
      if (output?.trim()) r.excerpt = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
    }
  };
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
      if (o.onlyIds ? !o.onlyIds.has(a.id) : a.id === o.selfId) continue;
      if (t.category === 'read') {
        addRead(rel(flat(t.title)), e.ts, a, t.output);
        continue;
      }
      if (t.category !== 'command' && t.category !== 'search') continue;
      const what = flat(t.title || t.input);
      if (!what) continue;
      // Printing one file is reading it.
      const file = t.category === 'command' && t.status === 'ok' ? fileReadOf(what) : undefined;
      if (file) {
        addRead(rel(file), e.ts, a, t.output);
        continue;
      }
      const graph = GRAPH.test(what);
      const important = !graph && (t.status !== 'ok' || IMPORTANT.test(what) || FAILED.test(t.output ?? ''));
      entries.push({ ts: e.ts, agent: a, kind: graph ? 'graph' : 'command', what, ok: t.status === 'ok', result: graph ? clip(flat(t.output), 2000) : important ? keyOutput(t.output, 2000) : outcome(t.output, 400) });
    }
  }
  const changes = [...changed.entries()];
  for (const en of entries) en.outdated = changes.some(([, c]) => c.ts > en.ts);
  const same = (x: string, y: string) => x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
  for (const r of read.values()) r.outdated = changes.some(([f, c]) => c.ts > r.ts && same(f, r.file));
  const since = o.since ?? 0;
  return {
    entries: entries.filter((e) => e.ts > since).sort((x, y) => x.ts - y.ts),
    changed: changes.filter(([, c]) => c.ts > since),
    read: [...read.values()].filter((r) => r.ts > since).sort((x, y) => x.ts - y.ts),
    lastEdit,
  };
}

/** The same command run again keeps only its latest result. */
function latestPerCommand(entries: LedgerEntry[]): LedgerEntry[] {
  const by = new Map<string, LedgerEntry>();
  for (const e of entries) by.set(e.what, e);
  return [...by.values()].sort((x, y) => x.ts - y.ts);
}

/** As many of `lines` as fit in `budget`, newest (last) first, shown oldest first. */
export function fit(lines: string[], budget: number, head: string): string {
  if (!lines.length) return '';
  const out: string[] = [];
  let used = head.length;
  for (let i = lines.length - 1; i >= 0 && used + lines[i].length + 1 <= budget; i--) {
    out.unshift(lines[i]);
    used += lines[i].length + 1;
  }
  const dropped = lines.length - out.length;
  return [head, ...(dropped ? [`- (${dropped} older item(s) left out; search_records or read_context finds them)`] : []), ...out].join('\n');
}

const indent = (s: string) => s.replace(/\n/g, '\n    ');

/** One command line: who ran it, how it ended and what it printed. */
const commandLine = (e: LedgerEntry, showWho = true) =>
  `- ${showWho ? `[${who(e.agent)}] ` : ''}${!e.ok ? '✗' : FAILED.test(e.result) ? '⚠' : '✓'} \`${clip(e.what, 400)}\`${e.outdated ? ' (files changed since; re-run if it matters)' : ''}${e.result ? (e.result.includes('\n') ? `\n    ${indent(e.result)}` : ` → ${e.result}`) : ''}`;

/** One file read: who read it and the start of what they saw. */
const readLine = (r: ReadEntry, excerpt: number, showWho = true) =>
  `- ${r.file}${showWho ? ` (read by ${[...r.agents].join(',')})` : ''}${r.outdated ? ' — CHANGED since, read it again' : ''}${r.excerpt && !r.outdated ? `\n    ${indent(clip(r.excerpt, excerpt))}` : ''}`;

/** Characters per file excerpt: fewer when many were read, so the newest ones all show something. */
const excerptSize = (budget: number, files: number) => Math.max(300, Math.min(6000, Math.floor(budget / Math.max(1, Math.min(files, 40)))));

/** Commands and their results, files read (with what they showed) and changed: newest first within `budget`. */
export function activityBlock(act: ReturnType<typeof collectActivity>, budget: number): string {
  const cmds = latestPerCommand(act.entries.filter((e) => e.kind === 'command'));
  const parts = [
    fit(
      cmds.map((e) => commandLine(e)),
      Math.floor(budget * 0.5),
      'COMMANDS ALREADY RUN BY OTHER AGENTS (who, command, how it ended: ✓ ok, ⚠ ran but its output reports a failure, ✗ failed, then what it printed). Use these results instead of running the same command again; re-run only when files changed since or you need the full output (read_context {agent_id}):',
    ),
    fit(
      act.read.map((r) => readLine(r, excerptSize(budget * 0.4, act.read.length))),
      Math.floor(budget * 0.4),
      'FILES OTHER AGENTS ALREADY READ (with the start of what they saw; read again only what is marked CHANGED or what you need in full):',
    ),
    act.changed.length ? fit(act.changed.map(([f, c]) => `- ${f} (by ${who(c.by)})`), Math.floor(budget * 0.1), 'FILES CHANGED:') : '',
  ];
  return parts.filter(Boolean).join('\n\n');
}

/**
 * What this agent's own conversation already did, for when its CLI compacted it: the files it read (with what they
 * showed), the commands it ran and their results, and the files it changed. Saves reading and running it all again.
 */
export function ownWorkBlock(run: WorkflowRun, eventsOf: (agentId: string) => AgentEvent[], ids: Set<string>, notes: string[], budget: number): string {
  const act = collectActivity(run, eventsOf, { onlyIds: ids });
  const mine = act.changed.filter(([, c]) => ids.has(c.by.id));
  if (!act.entries.length && !act.read.length && !mine.length && !notes.length) return '';
  return [
    'YOUR OWN WORK BEFORE YOUR CONVERSATION WAS COMPACTED (recorded by Aivenue; still valid unless marked CHANGED — use it instead of reading or running it again):',
    notes.length ? fit(notes.map((n) => `- ${n}`), Math.floor(budget * 0.15), 'What you reported:') : '',
    fit(act.read.map((r) => readLine(r, excerptSize(budget * 0.5, act.read.length), false)), Math.floor(budget * 0.5), 'Files you read:'),
    fit(latestPerCommand(act.entries.filter((e) => e.kind === 'command')).map((e) => commandLine(e, false)), Math.floor(budget * 0.3), 'Commands you ran:'),
    mine.length ? fit(mine.map(([f]) => `- ${f}`), Math.floor(budget * 0.05), 'Files you changed:') : '',
  ]
    .filter(Boolean)
    .join('\n');
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
