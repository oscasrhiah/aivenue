/**
 * The goal of a follow-up message: what the user wrote, then the earlier task and how it ended. A message that did not
 * finish (stopped, failed, interrupted) says so, instead of passing its last agent's report off as its outcome; the
 * plan, steps and checks it left come with the follow-up from Aivenue's own records (core continuation.ts).
 *
 * Kept free of React so it can be tested (scripts/test-workflow.mjs).
 */
import type { WorkflowRun } from '../../core/src/types';

export function followUpGoal(goal: string, run: Pick<WorkflowRun, 'status' | 'config' | 'agents'>): string {
  const last = Object.values(run.agents)
    .filter((a) => (a.role === 'executor' || a.role === 'planner') && a.finalText)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0]?.finalText;
  const outcome = run.status === 'completed' ? (last ?? run.status) : `it did not finish (status: ${run.status})${last ? `; the last report before that: ${last}` : ''}`;
  return `${goal}\n\n(Context: this continues an earlier task in the same folder: "${run.config.goal.slice(0, 800)}". Its outcome: ${outcome.slice(0, 1500)})`;
}
