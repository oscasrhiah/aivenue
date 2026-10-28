import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentEvent, AgentRunInfo, EvidenceStamp, Handoff, PhaseKey, Round, WorkflowRun } from './types';
import { snapshot } from './outputs';
import { issueKey } from './router';

/** Files that do not change what a test or review measured (Aivenue's own folder, generated graphs). */
const NOT_CODE = /^(\.aivenue|graphify-out)([\\/]|$)/;

/**
 * Which version of the work a result applies to: git commit (if any), a hash of every file's path, size and
 * modification time, the environment, and the data files the plan names.
 */
export function evidenceStamp(cwd: string, dataPaths: string[] = []): EvidenceStamp {
  return { at: Date.now(), commit: gitHead(cwd), treeHash: treeHash(cwd), env: environment(), data: dataPaths.length ? dataStamp(cwd, dataPaths) : undefined };
}

export function treeHash(cwd: string): string {
  const snap = snapshot(cwd);
  const h = createHash('sha1');
  for (const [p, st] of [...snap.files].sort(([a], [b]) => a.localeCompare(b))) if (!NOT_CODE.test(p)) h.update(`${p}\0${st.size}\0${Math.round(st.mtimeMs)}\n`);
  return h.digest('hex').slice(0, 16);
}

function gitHead(cwd: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The parts of the environment that change results: OS, runtimes, and the active Python / conda environment. */
function environment(): Record<string, string> {
  const env: Record<string, string> = { os: `${process.platform}-${process.arch}`, node: process.versions.node };
  for (const k of ['CONDA_DEFAULT_ENV', 'VIRTUAL_ENV', 'CUDA_VISIBLE_DEVICES']) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

/** Size and modification time of every data file (folders walked, up to 20 000 files). */
function dataStamp(cwd: string, paths: string[]): string {
  const h = createHash('sha1');
  let left = 20000;
  const walk = (abs: string, shown: string) => {
    if (left-- <= 0) return;
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      h.update(`${shown}\0missing\n`);
      return;
    }
    if (!st.isDirectory()) return void h.update(`${shown}\0${st.size}\0${Math.round(st.mtimeMs)}\n`);
    for (const e of fs.readdirSync(abs).sort()) walk(path.join(abs, e), `${shown}/${e}`);
  };
  for (const p of paths) walk(path.resolve(cwd, p), p);
  return h.digest('hex').slice(0, 16);
}

/**
 * Mark reviews and verifications measured on another version as stale (they need checking again): the code or its
 * dependency files changed (the tree), the data the goal names changed, or the environment (OS, runtime, Python / conda
 * environment, visible GPUs) is not the same. Returns how many were newly marked.
 */
export function markStale(run: WorkflowRun, now: Pick<EvidenceStamp, 'treeHash' | 'data' | 'env'>): number {
  let n = 0;
  const differs = (e: EvidenceStamp) => e.treeHash !== now.treeHash || (e.data ?? '') !== (now.data ?? '') || JSON.stringify(e.env) !== JSON.stringify(now.env);
  for (const stage of [run.stages.plan, run.stages.implement, run.stages.verify]) {
    for (const r of stage?.rounds ?? []) {
      for (const res of [r.review, r.verification]) {
        if (res?.evidence && !res.stale && differs(res.evidence) && stage !== run.stages.plan) {
          res.stale = true;
          n++;
        }
      }
    }
  }
  return n;
}

// ---------- hand-off summaries ----------

/** A round's hand-off, built from its structured results (no model call): facts, decisions, open issues, links. */
export function buildHandoff(run: WorkflowRun, stage: PhaseKey, r: Round): Handoff {
  const facts: string[] = [];
  const decisions: string[] = [];
  const open: string[] = [];
  const links: Handoff['links'] = [];
  if (r.authorAgentId) links.push({ agentId: r.authorAgentId, label: 'author' });
  if (r.reviewerAgentId) links.push({ agentId: r.reviewerAgentId, label: stage === 'verify' ? 'verifier' : 'reviewer' });
  if (r.submission?.summary) facts.push(`submitted: ${r.submission.summary.slice(0, 300)}`);
  if (r.review) {
    (r.review.verdict === 'approve' ? decisions : facts).push(`review ${r.review.verdict}: ${r.review.summary.slice(0, 300)}`);
    for (const i of r.review.issues) {
      open.push(`${i.id} [${i.severity}] ${i.title}`);
      links.push({ issueId: i.id, agentId: r.reviewerAgentId, label: i.id });
    }
  }
  if (r.verification) {
    for (const m of r.verification.metrics) (m.met ? facts : open).push(`metric ${m.id}: ${m.value} (${m.met ? 'met' : 'not met'}) — ${m.evidence.slice(0, 200)}`);
    for (const i of r.verification.issues) {
      open.push(`${i.id} [${i.severity}] ${i.title}`);
      links.push({ issueId: i.id, agentId: r.reviewerAgentId, label: i.id });
    }
  }
  if (r.route) decisions.push(`routed to ${r.route.to}: ${r.route.reason}`);
  const since = Math.min(...[r.authorAgentId, r.reviewerAgentId].map((id) => (id ? (run.agents[id]?.startedAt ?? Infinity) : Infinity)));
  for (const n of run.notes ?? []) if (n.kind === 'decision' && n.ts >= since) decisions.push(n.text.slice(0, 300));
  return { ts: Date.now(), stage, round: r.n, facts, decisions, open, links };
}

// ---------- search ----------

export interface RecordHit {
  agentId?: string;
  role?: string;
  stage?: string;
  round?: number;
  seq?: number;
  kind: string;
  text: string;
}

export interface RecordQuery {
  q?: string;
  role?: string;
  agentId?: string;
  stage?: string;
  round?: number;
  file?: string;
  issueId?: string;
  limit?: number;
}

/**
 * Search a run's records — every agent's messages, tool calls and output, shared notes, reviews and verifications —
 * by text and by role, agent, stage, round, file or issue id.
 */
export function searchRecords(run: WorkflowRun, eventsOf: (agentId: string) => AgentEvent[], q: RecordQuery): RecordHit[] {
  const needle = q.q?.trim().toLowerCase();
  const file = q.file?.replace(/\\/g, '/').toLowerCase();
  const issue = q.issueId?.toLowerCase();
  const hits: RecordHit[] = [];
  const match = (text: string) => (!needle || text.toLowerCase().includes(needle)) && (!file || text.replace(/\\/g, '/').toLowerCase().includes(file)) && (!issue || text.toLowerCase().includes(issue));
  const agentOk = (a: AgentRunInfo) => (!q.role || a.role === q.role) && (!q.agentId || a.id === q.agentId) && (!q.stage || a.stage === q.stage) && (!q.round || a.round === q.round);
  for (const a of Object.values(run.agents)) {
    if (!agentOk(a)) continue;
    for (const e of eventsOf(a.id)) {
      const text = e.kind === 'tool' ? `${e.tool?.name ?? ''} ${e.tool?.title ?? ''}\n${e.tool?.input ?? ''}\n${e.tool?.output ?? ''}` : (e.text ?? '');
      if (!text || !['tool', 'message', 'error', 'info'].includes(e.kind) || !match(text)) continue;
      hits.push({ agentId: a.id, role: a.role, stage: a.stage, round: a.round, seq: e.seq, kind: e.kind === 'tool' ? `tool:${e.tool?.name ?? ''}` : e.kind, text: snippet(text, needle) });
    }
  }
  for (const n of run.notes ?? []) {
    const a = run.agents[n.agentId];
    if (a && !agentOk(a)) continue;
    if (match(n.text)) hits.push({ agentId: n.agentId, role: a?.role, stage: a?.stage, round: a?.round, kind: `note${n.kind ? `:${n.kind}` : ''}`, text: snippet(n.text, needle) });
  }
  for (const [key, st] of Object.entries(run.stages)) {
    if (!st || (q.stage && q.stage !== key)) continue;
    for (const r of st.rounds) {
      if (q.round && q.round !== r.n) continue;
      for (const i of [...(r.review?.issues ?? []), ...(r.verification?.issues ?? [])]) {
        const text = `${i.id} [${i.severity}] ${i.title}${i.location ? ` (${i.location})` : ''}${i.detail ? `\n${i.detail}` : ''}`;
        if (match(text)) hits.push({ agentId: r.reviewerAgentId, stage: key, round: r.n, kind: 'issue', text: snippet(text, needle) });
      }
    }
  }
  return hits.slice(0, Math.max(1, Math.min(q.limit ?? 50, 200)));
}

function snippet(text: string, needle?: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!needle) return flat.slice(0, 240);
  const i = flat.toLowerCase().indexOf(needle);
  const start = Math.max(0, i - 80);
  return (start ? '…' : '') + flat.slice(start, start + 240) + (flat.length > start + 240 ? '…' : '');
}

/** Every issue across the run's reviews and verifications, newest last, keyed by identity (for "same issue" checks). */
export function issueHistory(rounds: Round[]): Map<string, number> {
  const seen = new Map<string, number>();
  for (const r of rounds) for (const i of [...(r.review?.issues ?? []), ...(r.verification?.issues ?? [])]) seen.set(issueKey(i), (seen.get(issueKey(i)) ?? 0) + 1);
  return seen;
}
