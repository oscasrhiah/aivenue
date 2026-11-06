import type { RoleConfig, WorkflowConfig } from './types';

/**
 * Flow modes (docs/workflow-efficiency-plan.md B): a mode sets every field of the role layout it covers, so nothing of
 * the previous settings carries over. Only "standard" exists so far, and it is optional: it is not the default for new
 * conversations and never replaces settings the user saved.
 *
 * Standard: no planning stage (no planner, no plan review); the implementer writes a short plan itself; one code
 * reviewer for at most 2 rounds; no goal verification; no sub-agents.
 */
export type FlowMode = 'standard';

export const STANDARD_ROUNDS = 2;

type Layout = Pick<WorkflowConfig, 'plan' | 'implement' | 'subagents' | 'verify' | 'flow'>;

/**
 * The settings with the standard layout applied. The planning stage keeps its roles (only switched off), so turning it
 * back on restores them. The reviewer stays who it was; without one, `fallbackReviewer` (or else the plan reviewer, or
 * else the implementer) reviews.
 */
export function applyStandard<T extends Layout>(c: T, fallbackReviewer?: RoleConfig): T {
  const reviewer = c.implement.reviewer ?? fallbackReviewer ?? c.plan.reviewer ?? c.implement.author;
  return {
    ...c,
    flow: 'standard',
    plan: { ...c.plan, enabled: false, humanGate: false },
    implement: { ...c.implement, enabled: true, reviewer: { ...reviewer }, maxRounds: STANDARD_ROUNDS, humanGate: false },
    verify: c.verify ? { ...c.verify, enabled: false } : undefined,
    subagents: { ...c.subagents, enabled: false },
  };
}

/** Whether the role layout is exactly the standard one (whoever plays the roles). */
export function matchesStandard(c: Layout): boolean {
  return !c.plan.enabled && c.implement.enabled && !!c.implement.reviewer && c.implement.maxRounds === STANDARD_ROUNDS && !c.implement.humanGate && !c.verify?.enabled && !c.subagents.enabled;
}

/** The mode the settings are in: "standard" only when it was chosen and nothing was changed away from it. */
export function flowModeOf(c: Layout): FlowMode | 'custom' {
  return c.flow === 'standard' && matchesStandard(c) ? 'standard' : 'custom';
}

/** After an edit: drops the mode mark when the layout no longer matches it (the settings then show as custom). */
export function keepFlowMark<T extends Layout>(c: T): T {
  if (!c.flow || matchesStandard(c)) return c;
  const { flow: _flow, ...rest } = c;
  return rest as T;
}
