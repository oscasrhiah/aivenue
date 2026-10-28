import type { IssueResponse, ReviewIssue, RouteDecision, Verification } from './types';

/**
 * The controller's routing, as pure functions: given structured review / verification results it decides who works
 * next. Agents never declare the workflow done themselves; only these rules (and the user) do.
 */

/** An issue's identity across rounds: its title without case, punctuation or numbering. */
export function issueKey(i: Pick<ReviewIssue, 'title'>): string {
  return i.title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Issues present in each of the last `limit` rounds (oldest first): the same problem failing fix after fix. */
export function repeatedIssues(rounds: ReviewIssue[][], limit: number): ReviewIssue[] {
  if (limit < 2 || rounds.length < limit) return [];
  const last = rounds.slice(-limit);
  const keys = last.map((r) => new Set(r.map(issueKey)));
  return last[last.length - 1].filter((i) => keys.every((k) => k.has(issueKey(i))));
}

/**
 * Where a verification sends the work.
 * - met (every metric met) → done; "met" with a missed metric is not trusted and counts as not met.
 * - defect → the implementer fixes it following the plan.
 * - invalid_evidence → the implementer re-runs the measurement or repairs the validation pipeline.
 * - not_met (the work is valid but the goal is missed) → the planner re-plans.
 * - the same defect / evidence problem surviving `repeatLimit` fixes in a row → the planner re-diagnoses.
 */
export function routeVerification(v: Verification, earlier: Verification[], repeatLimit = 3): RouteDecision {
  const missed = v.metrics.filter((m) => !m.met);
  if (v.outcome === 'met' && !missed.length && v.metrics.length) return { to: 'done', reason: 'every acceptance metric is met' };
  if (v.outcome === 'met' && !v.metrics.length) return { to: 'implementer', reason: 'reported as met without measuring any acceptance metric: measure them', issues: [] };
  const outcome = v.outcome === 'met' ? 'not_met' : v.outcome;
  if (outcome === 'not_met') return { to: 'planner', reason: `the work is valid but the goal is missed (${missed.map((m) => m.id).join(', ') || 'metrics'}): re-plan`, issues: missed.map((m) => m.id) };
  const history = [...earlier.filter((e) => e.outcome === outcome).map((e) => e.issues), v.issues];
  const stuck = repeatedIssues(history, repeatLimit);
  if (stuck.length) return { to: 'planner', reason: `the same ${outcome === 'defect' ? 'defect' : 'evidence problem'} failed ${repeatLimit} fixes in a row: re-diagnose`, issues: stuck.map((i) => i.id), rediagnose: true };
  return outcome === 'defect'
    ? { to: 'implementer', reason: 'defects or missing work: fix them following the plan', issues: v.issues.map((i) => i.id) }
    : { to: 'implementer', reason: 'the evidence is invalid or insufficient: re-test or repair the validation pipeline', issues: v.issues.map((i) => i.id) };
}

/**
 * A code-review issue the author rebutted and the reviewer raised again, `times` rounds running: the two disagree, so
 * an independent ruling on the evidence decides it.
 */
export function disputedIssues(rounds: { issues: ReviewIssue[]; responses?: IssueResponse[] }[], times = 2): ReviewIssue[] {
  if (rounds.length < times + 1) return [];
  const out: ReviewIssue[] = [];
  const last = rounds[rounds.length - 1];
  for (const issue of last.issues) {
    let n = 0;
    for (let k = rounds.length - 1; k > 0 && n < times; k--) {
      const raised = rounds[k].issues.some((i) => issueKey(i) === issueKey(issue));
      const prev = rounds[k - 1].issues.find((i) => issueKey(i) === issueKey(issue));
      const rebutted = prev && rounds[k].responses?.some((r) => r.issue_id === prev.id && r.action === 'rebutted');
      if (raised && rebutted) n++;
      else break;
    }
    if (n >= times) out.push(issue);
  }
  return out;
}

/** Limits reached (when enabled): the run ends as "incomplete", never as done. */
export function limitHit(
  limits: { enabled: boolean; maxMinutes?: number; maxCostUsd?: number; maxCycles?: number } | undefined,
  state: { startedAt: number; now: number; costUsd: number; cycles: number },
): string | undefined {
  if (!limits?.enabled) return undefined;
  if (limits.maxMinutes && state.now - state.startedAt > limits.maxMinutes * 60000) return `time limit (${limits.maxMinutes} min)`;
  if (limits.maxCostUsd && state.costUsd > limits.maxCostUsd) return `cost limit ($${limits.maxCostUsd})`;
  if (limits.maxCycles && state.cycles > limits.maxCycles) return `retry limit (${limits.maxCycles} cycles)`;
  return undefined;
}

/**
 * The stage a route leads to: done, the planning stage (re-plan / re-diagnose) or the implementation stage. Without a
 * planning stage the implementer also takes what would go to the planner.
 */
export function nextPhase(route: RouteDecision, planEnabled: boolean): 'done' | 'plan' | 'implement' {
  if (route.to === 'done') return 'done';
  if (route.to === 'planner' && planEnabled) return 'plan';
  return 'implement';
}
