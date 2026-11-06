// Sub-agents as batches of work: one batch per piece of delegated work, with every attempt at it. An attempt joins
// a batch only through an explicit link — a re-run from the UI, or `retry_of` when the parent starts it again — never
// by its title (two batches may share a title and cover different ranges). Shared by the hub (its completion note)
// and the UI (the batch overview), so both say the same thing. No Node imports: the UI loads it too.
import type { AgentRunInfo } from './types';

export type BatchState = 'blocked' | 'running' | 'done' | 'stopped';

/** One piece of delegated work and every attempt at it (re-runs joined to the first), oldest first. */
export interface Batch {
  key: string;
  title: string;
  attempts: AgentRunInfo[];
  latest: AgentRunInfo;
  state: BatchState;
}

/** A batch's state is its latest attempt's: a failure an earlier attempt recovered from is history, not a blocker. */
export function batchState(a: AgentRunInfo): BatchState {
  if (a.status === 'running' || a.status === 'queued' || a.status === 'paused') return 'running';
  if (a.status === 'completed' && !a.endedWithoutResult) return 'done';
  if (a.status === 'cancelled') return 'stopped';
  return 'blocked';
}

/** Sub-agents grouped into batches by their re-run links, in the order the batches were first started. */
export function batchesOf(children: AgentRunInfo[], titleOf: (a: AgentRunInfo) => string): Batch[] {
  const byId = new Map(children.map((c) => [c.id, c]));
  const root = (a: AgentRunInfo): AgentRunInfo => {
    let x = a;
    for (let i = 0; i < 100 && x.rerunOf && byId.has(x.rerunOf); i++) x = byId.get(x.rerunOf)!;
    return x;
  };
  const groups = new Map<string, AgentRunInfo[]>();
  for (const c of [...children].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
    const key = root(c).id;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(c);
  }
  return [...groups.entries()].map(([key, attempts]) => {
    const latest = attempts[attempts.length - 1];
    return { key, title: titleOf(attempts[0]), attempts, latest, state: batchState(latest) };
  });
}

/** How many batches are in each state. */
export function batchCounts(list: Batch[]): Record<BatchState, number> {
  const out: Record<BatchState, number> = { blocked: 0, running: 0, done: 0, stopped: 0 };
  for (const b of list) out[b.state]++;
  return out;
}

/** Every parent's sub-agent batches in a workflow (closed ones left out, as on screen). */
export function runBatches(agents: AgentRunInfo[], titleOf: (a: AgentRunInfo) => string): Batch[] {
  const subs = agents.filter((a) => a.role === 'subagent' && !a.closed);
  const parents = [...new Set(subs.map((a) => a.parentId ?? ''))];
  return parents.flatMap((p) => batchesOf(subs.filter((a) => (a.parentId ?? '') === p), titleOf));
}
