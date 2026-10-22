import type { IssueResponse, PlanDoc, Review, SubagentConfig, WorkflowConfig } from './types';

const LANG = 'Write all human-readable text (plans, summaries, issue descriptions) in the same language as the GOAL.';
const SHOT = 'If the work has a visible UI (web page, HTML file, app screen), check it with the Aivenue tool `capture_screenshot` {target: URL or HTML file path, width? (390 = phone), full_page?}; the user sees the screenshot in the conversation.';

const FALLBACK = (tool: string, shape: string) =>
  `If the \`${tool}\` tool is not available to you, end your reply with a single fenced \`\`\`json block containing exactly: ${shape}`;

const PLAN_SHAPE = '{"summary": string, "markdown": string, "steps": [{"id": "1", "title": string, "detail": string}], "responses": [{"issue_id": string, "action": "fixed"|"rebutted", "note": string}]}';
const REVIEW_SHAPE = '{"verdict": "approve"|"revise", "summary": string, "issues": [{"id": "R1", "severity": "blocker"|"major"|"minor", "title": string, "detail": string, "location": string}]}';
const WORK_SHAPE = '{"summary": string, "responses": [{"issue_id": string, "action": "fixed"|"rebutted", "note": string}]}';

function header(role: string, cfg: WorkflowConfig): string {
  return [
    `You are the ${role} in an Aivenue multi-agent workflow. Other AI agents (possibly from other vendors) plan, implement and review this task with you.`,
    `Working directory: ${cfg.cwd}`,
    '',
    'GOAL:',
    cfg.goal.trim(),
    '',
    LANG,
  ].join('\n');
}

export function planBlock(plan: PlanDoc | undefined): string {
  if (!plan) return '(no plan)';
  const steps = plan.steps.map((s) => `- [${s.id}] ${s.title}${s.detail ? ` — ${s.detail}` : ''}`).join('\n');
  return `${plan.markdown?.trim() || plan.summary}\n\nSteps:\n${steps}`;
}

function issuesBlock(review: Review): string {
  return review.issues.map((i) => `- ${i.id} [${i.severity}] ${i.title}${i.location ? ` (${i.location})` : ''}${i.detail ? `\n  ${i.detail}` : ''}`).join('\n') || '(no itemized issues)';
}

function responsesBlock(responses: IssueResponse[] | undefined): string {
  if (!responses?.length) return '(the author did not respond to individual issues)';
  return responses.map((r) => `- ${r.issue_id}: ${r.action === 'fixed' ? 'FIXED' : 'REBUTTED'}${r.note ? ` — ${r.note}` : ''}`).join('\n');
}

export function subagentBlock(sub: SubagentConfig, depth: number, available: { id: string; name: string; model?: string; effort?: string; model_fixed?: boolean }[]): string {
  if (!sub.enabled || depth >= sub.maxDepth || !available.length) return '';
  const describe = (a: (typeof available)[number]) => {
    const m = [a.model, a.effort && `effort ${a.effort}`].filter(Boolean).join(', ');
    return `${a.id} (${a.name}${m ? `; ${a.model_fixed ? 'uses' : 'default'} ${m}` : ''})`;
  };
  return [
    '',
    'SUB-AGENTS: You may delegate self-contained sub-tasks to other AI agents with the Aivenue tools:',
    `- \`spawn_subagent\` {provider, task, mode?: "write"|"readonly", model?, effort?} starts one and returns a subagent_id immediately. Available providers: ${available.map(describe).join(', ')}. Leave model/effort out unless the task clearly needs a different one.`,
    '- `wait_subagent` {subagent_id} waits up to ~50 seconds and returns its status/result; call it again while it is still running.',
    `- At most ${sub.maxConcurrent} sub-agents run at once. Give each a complete, specific task (it cannot see this conversation). Sub-agents share this working directory, so give parallel sub-agents disjoint files.`,
  ].join('\n');
}

// ---------- Plan stage ----------

export function planDraftPrompt(cfg: WorkflowConfig, sub: string, userFeedback?: string): string {
  return [
    header('PLANNER', cfg),
    '',
    'TASK: Investigate the codebase as much as you need (read files, search) but DO NOT modify any files. Then write a concrete, step-by-step implementation plan for the GOAL.',
    'The plan will be reviewed by another agent and then executed by an implementer agent, so be specific: files to change, approach, risks, and how to verify (tests/build).',
    userFeedback ? `\nThe user added this guidance:\n${userFeedback}` : '',
    sub,
    '',
    'When the plan is ready, call the Aivenue tool `submit_plan` with: summary, markdown (the full plan), steps (short numbered steps with ids "1", "2", ...).',
    FALLBACK('submit_plan', PLAN_SHAPE),
  ].join('\n');
}

export function planReviewPrompt(cfg: WorkflowConfig, plan: PlanDoc, round: number, prior?: { review: Review; responses?: IssueResponse[] }): string {
  return [
    header('PLAN REVIEWER', cfg),
    '',
    round === 1
      ? 'TASK: Critically review the implementation plan below. Check it against the GOAL and the actual codebase (you may read files; DO NOT modify anything).'
      : `TASK: This is review round ${round}. The planner revised the plan in response to your previous review. Re-check it. Accept rebuttals that have good reasons; do not repeat issues that were properly addressed.`,
    'Approve only if the plan is correct, complete and ready to execute. Minor nits alone should not block approval.',
    prior ? `\nYOUR PREVIOUS ISSUES:\n${issuesBlock(prior.review)}\n\nPLANNER RESPONSES:\n${responsesBlock(prior.responses)}` : '',
    '',
    'PLAN:',
    planBlock(plan),
    '',
    'When done, call the Aivenue tool `submit_review` with verdict "approve" or "revise", a summary, and itemized issues (ids "R1", "R2", ... ; severity blocker/major/minor).',
    FALLBACK('submit_review', REVIEW_SHAPE),
  ].join('\n');
}

export function planRevisePrompt(cfg: WorkflowConfig, review: Review | undefined, userFeedback?: string): string {
  return [
    review ? 'The PLAN REVIEWER requested changes to your plan.' : 'The user requested changes to your plan.',
    review ? `\nREVIEW SUMMARY: ${review.summary}\n\nISSUES:\n${issuesBlock(review)}` : '',
    userFeedback ? `\nUSER FEEDBACK:\n${userFeedback}` : '',
    '',
    'For each issue decide: revise the plan (FIXED), or explain why the plan is already right (REBUTTED). Do not modify files.',
    'Then call `submit_plan` again with the FULL updated plan (summary, markdown, steps) and `responses` — one entry per issue id.',
    FALLBACK('submit_plan', PLAN_SHAPE),
    '',
    `(Reminder of the goal: ${cfg.goal.trim().slice(0, 500)})`,
  ].join('\n');
}

// ---------- Implement stage ----------

export function implementPrompt(cfg: WorkflowConfig, plan: PlanDoc | undefined, sub: string, userFeedback?: string): string {
  return [
    header('IMPLEMENTER', cfg),
    '',
    plan ? 'TASK: Implement the APPROVED PLAN below in the working directory.' : 'TASK: Implement the GOAL in the working directory.',
    plan ? 'Before starting each plan step call `report_progress` {step_id, status: "in_progress"}, and after finishing it {step_id, status: "done", note}. Use "blocked" or "skipped" with a note when needed.' : 'Report notable milestones with `report_progress`.',
    'Verify your work (build / tests) where possible.',
    SHOT,
    userFeedback ? `\nThe user added this guidance:\n${userFeedback}` : '',
    sub,
    plan ? `\nAPPROVED PLAN:\n${planBlock(plan)}` : '',
    '',
    'When finished, call the Aivenue tool `submit_work` with a summary of what you changed and how you verified it.',
    FALLBACK('submit_work', WORK_SHAPE),
  ].join('\n');
}

export function codeReviewPrompt(cfg: WorkflowConfig, plan: PlanDoc | undefined, work: string, changes: string, round: number, prior?: { review: Review; responses?: IssueResponse[] }): string {
  return [
    header('CODE REVIEWER', cfg),
    '',
    round === 1
      ? 'TASK: Review the implementation that another agent just made in the working directory.'
      : `TASK: This is review round ${round}. The implementer addressed your previous review. Re-check the code. Accept rebuttals that have good reasons.`,
    'Inspect the actual changes (e.g. `git diff`, read the files), run the build/tests if available, and check the work against the GOAL and the plan.',
    'DO NOT modify any files — report problems as issues instead.',
    SHOT,
    'Approve only if the work is correct and complete. Minor nits alone should not block approval.',
    prior ? `\nYOUR PREVIOUS ISSUES:\n${issuesBlock(prior.review)}\n\nIMPLEMENTER RESPONSES:\n${responsesBlock(prior.responses)}` : '',
    plan ? `\nPLAN:\n${planBlock(plan)}` : '',
    `\nIMPLEMENTER'S SUMMARY:\n${work || '(none)'}`,
    changes ? `\nCHANGED FILES:\n${changes}` : '',
    '',
    'When done, call the Aivenue tool `submit_review` with verdict "approve" or "revise", a summary, and itemized issues (ids "R1", "R2", ...).',
    FALLBACK('submit_review', REVIEW_SHAPE),
  ].join('\n');
}

export function fixPrompt(review: Review | undefined, userFeedback?: string): string {
  return [
    review ? 'The CODE REVIEWER found problems with your implementation.' : 'The user requested changes to your implementation.',
    review ? `\nREVIEW SUMMARY: ${review.summary}\n\nISSUES:\n${issuesBlock(review)}` : '',
    userFeedback ? `\nUSER FEEDBACK:\n${userFeedback}` : '',
    '',
    'For each issue: fix it in the code (FIXED), or explain why the current code is right (REBUTTED). Re-run the build/tests after fixing.',
    'Then call `submit_work` with a summary and `responses` — one entry per issue id.',
    FALLBACK('submit_work', WORK_SHAPE),
  ].join('\n');
}

// ---------- Sub-agents ----------

/** Sent to an agent the user paused mid-turn, once they resume. */
/**
 * Every agent: outside-world writes need the user's OK (any permission level), plus what GitHub access this
 * computer has, so agents use it instead of guessing.
 */
export function externalRule(github?: { gh: boolean; user?: string; mcp: boolean }): string {
  const lines = [
    '',
    'EXTERNAL ACTIONS: before anything that changes something outside this computer — git push, creating/merging/closing a pull request, commenting on or creating/closing an issue, publishing a release, triggering a deployment or workflow, any other write to GitHub or another service — call the Aivenue tool `confirm_external_action` {kind, target, details} and wait for the answer. Only do it if it is approved, exactly as described; if it is denied, do not do it and say so in your report. Reading (git fetch/pull/status/log, viewing PRs, issues or CI) needs no approval. Local commits need no approval either.',
  ];
  if (github?.user && github.gh)
    lines.push(
      `GITHUB: the GitHub CLI \`gh\` is installed and signed in as ${github.user}; git push/pull to GitHub over HTTPS uses that sign-in. Use \`gh\` for pull requests, issues, reviews and CI (e.g. gh pr create, gh pr view, gh issue list, gh run view --log-failed)${github.mcp ? ', or the GitHub MCP tools' : ''}. Never print or store the token.`,
    );
  return lines.join('\n');
}

/** Folders besides the working folder that the user made available. */
export function extraDirsBlock(dirs: string[]): string {
  if (!dirs.length) return '';
  return [
    '',
    'ADDITIONAL FOLDERS: besides the working directory, the user made these folders available. Read and explore them whenever they help (search, list, open files) — you do not need to ask:',
    ...dirs.map((d) => `- ${d}`),
    'Treat them as reference material: do not modify, create or delete files in them unless the user explicitly asked for changes there.',
  ].join('\n');
}

export function resumeAfterPause(): string {
  return 'The user paused you in the middle of your work and has now resumed. Continue the task exactly where you left off (check the working directory if unsure what was already done), and finish it as instructed before (including calling the Aivenue submit tool if you were asked to).';
}

// ---------- Advisor ----------

export function advisorPrompt(cfg: WorkflowConfig, askerLabel: string, question: string, overview: string, transcript: string): string {
  return [
    'You are the ADVISOR in an Aivenue multi-agent workflow: a stronger model that another agent consults when it is stuck.',
    `Working directory: ${cfg.cwd}`,
    'Do NOT modify any files. You may read files or run read-only commands to check facts.',
    'Give concrete, prioritized advice the asking agent can act on right away: what is wrong, what to do next, what to avoid. Say so plainly if its approach is fine.',
    LANG,
    '',
    `QUESTION FROM ${askerLabel}:`,
    question,
    '',
    'WORKFLOW SO FAR:',
    overview,
    '',
    `FULL TRANSCRIPT OF ${askerLabel}:`,
    transcript,
    '',
    'Reply with your advice only.',
  ].join('\n');
}

/** Told to every agent when an advisor is available. */
export function advisorHint(who: string, max: number): string {
  return `\nADVISOR: ${who} is available as an advisor. Call the Aivenue tool \`ask_advisor\` {question} before locking in a plan, when the same error shows up twice, or before declaring uncertain work done. At most ${max} consultations per conversation, so ask focused questions.`;
}

export function subagentPrompt(cwd: string, task: string, parentLabel: string, sub: string): string {
  return [
    `You are a SUB-AGENT in an Aivenue multi-agent workflow. The ${parentLabel} delegated this task to you.`,
    `Working directory: ${cwd}`,
    'Other agents may be working in the same directory at the same time: only touch what this task needs.',
    sub,
    '',
    'TASK:',
    task.trim(),
    '',
    SHOT,
    'When finished, reply with a concise report of what you did and the result (files changed, findings, test results).',
    'Write the report in the same language as the TASK.',
  ].join('\n');
}

export function nudgePrompt(tool: 'submit_plan' | 'submit_review' | 'submit_work'): string {
  const shape = tool === 'submit_plan' ? PLAN_SHAPE : tool === 'submit_review' ? REVIEW_SHAPE : WORK_SHAPE;
  return `You finished without calling \`${tool}\`. Call \`${tool}\` now with your result (do not redo the work). ${FALLBACK(tool, shape)}`;
}
