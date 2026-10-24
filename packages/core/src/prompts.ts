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
/** Told to writing agents when the user granted whole-computer access. Prompt rules only: nothing enforces them. */
export function fullAccessRule(cwd: string): string {
  return [
    '',
    `WHOLE-COMPUTER ACCESS: the user allowed you to read and change files anywhere on this computer and to run any command, not only in ${cwd}. Use it only when the task needs it, and stay in the working folder otherwise.`,
    '- Before you delete, move or overwrite a file outside the working folder, make sure the task requires it, and list every such file (full path) in your final report.',
    '- Never read, copy or change credentials or secrets: SSH keys (~/.ssh), browser profiles and cookies, password managers, cloud and API credentials, the sign-in files of AI CLIs (~/.claude, ~/.codex, ~/.gemini, ~/.copilot…).',
    '- Do not change system settings, security settings, the registry, services, scheduled tasks or startup items, and do not install system-wide software unless the task explicitly asks for it.',
  ].join('\n');
}

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

// ---------- Context compaction ----------

const COMPACT_SECTIONS = ['## Decisions', '## Known problems and open questions', '## Where things are (files, commands, settings)', '## Done so far', '## Still to do'].join('\n');

/**
 * Condense the shared notes and agent results of a workflow. The facts kept verbatim elsewhere (goal, plan, open review
 * issues, user instructions) are given for orientation only, so the summary does not spend room on them.
 */
export function compactSharedPrompt(material: string, keptVerbatim: string, targetTokens: number, missing?: string[]): string {
  return [
    'You condense the shared context of an Aivenue multi-agent workflow so later agents can keep working with a short version of it.',
    'Do not use any tools, do not read files, do not run commands: work only from the text below, and reply with the summary only.',
    '',
    'RULES:',
    '- Keep every decision and its reason, every unresolved problem or error (with its exact message), every file path, command, setting name and identifier that later work may need, and every instruction the user gave.',
    '- Drop chatter, repetition, step-by-step narration and anything already settled that no later step depends on.',
    '- Write facts, not a story. Be specific: names, paths and numbers exactly as written in the material.',
    `- Aim for at most about ${targetTokens} tokens. Use these sections (leave one out if it has nothing):`,
    COMPACT_SECTIONS,
    LANG,
    missing?.length ? `\nYOUR PREVIOUS SUMMARY LEFT THESE OUT. Include each of them this time:\n${missing.map((m) => `- ${m}`).join('\n')}` : '',
    '',
    'ALREADY KEPT VERBATIM (for orientation; do not repeat it):',
    keptVerbatim || '(nothing)',
    '',
    'MATERIAL TO CONDENSE:',
    material,
  ].join('\n');
}

/** Hand-off summary of one agent's conversation, for a CLI whose conversation cannot be compacted from outside. */
export function handoffSummaryPrompt(label: string, transcript: string, targetTokens: number): string {
  return [
    `You condense the conversation of ${label} in an Aivenue multi-agent workflow. It will continue in a fresh conversation that starts from your summary instead of the full history.`,
    'Do not use any tools, do not read files, do not run commands: work only from the transcript below, and reply with the summary only.',
    'Keep what the agent needs to carry on: its task, what it already did (files changed, commands run and their outcome), decisions and reasons, errors still open (exact messages), and what is left to do. Keep paths, names and numbers exactly.',
    `Aim for at most about ${targetTokens} tokens, in these sections:`,
    COMPACT_SECTIONS,
    LANG,
    '',
    'TRANSCRIPT:',
    transcript,
  ].join('\n');
}

/** Prepended to the first prompt of a conversation that replaced a compacted one. */
export function handoffBlock(summary: string): string {
  return `\n\nYOUR EARLIER WORK IN THIS WORKFLOW (your previous conversation was compacted into this summary; the files on disk are current):\n${summary}`;
}

// ---------- Advisor ----------

/**
 * The advisor is a consultant: a stronger (pricier) model that judges from what the asker tells it. Exploring the code
 * is the cheap agents' job, so when facts are missing it sends sub-agents to fetch them instead of reading files itself.
 */
export function advisorPrompt(cfg: WorkflowConfig, askerLabel: string, question: string, context: string, overview: string, recent: string, sub: string, factRounds: number): string {
  return [
    'You are the ADVISOR in an Aivenue multi-agent workflow: a senior consultant that another agent asks when it is stuck. You are the most expensive model here, so spend your effort on judgment, not on legwork.',
    `Working directory: ${cfg.cwd}`,
    '',
    'HOW TO WORK:',
    '- Answer from what you are given: the question, the context the asker wrote, the workflow so far and the latest part of its transcript. That is usually enough.',
    sub
      ? factRounds > 0
        ? `- Do NOT browse the code yourself (no reading files, searching or running commands) while sub-agents can fetch the facts. The one exception: after ${factRounds} round${factRounds > 1 ? 's' : ''} of sub-agents still have not given you a fact you cannot do without, you may read those specific files yourself, read-only and only what is missing; say in your advice which fact the sub-agents could not deliver. Aivenue tells you the round number in each spawn/wait result. Never modify anything.`
        : '- Do NOT browse the code yourself (no reading files, searching or running commands), however many rounds it takes: the facts always come from sub-agents. Never modify anything.'
      : '- Do NOT browse the code yourself: no reading files, searching or running commands. Never modify anything.',
    sub
      ? [
          '- If the context is empty or not enough to answer, that is exactly when to use sub-agents: do not send the asker away to look things up itself. Only if a fact you cannot do without is missing, delegate the legwork: start read-only sub-agents with `spawn_subagent` (mode "readonly"), each with one narrow fact-finding task (what to look at, what to find out, and to reply briefly with findings, quoting the code with file:line; no fixes). Run independent questions in parallel and collect them with `wait_subagent`.',
          '- Check every report before you rely on it: does it answer exactly what you asked, quote the code, and agree with the other facts you have? If it is incomplete, vague, contradicts something or looks wrong, send a sub-agent again with a sharper task that says what was missing or doubtful. Repeat until the facts are solid, then answer; do not keep digging once you can answer.',
        ].join('\n')
      : '- If a fact you need is missing, do not go looking for it: answer with what you have, state your assumption, and name exactly what the asker should check (which file or command) to confirm it.',
    '- Then give concrete, prioritized advice the asking agent can act on right away: what is wrong, what to do next, what to avoid. Say so plainly if its approach is fine.',
    LANG,
    sub,
    '',
    `QUESTION FROM ${askerLabel}:`,
    question,
    '',
    `CONTEXT FROM ${askerLabel}:`,
    context || '(none given; rely on its latest transcript below)',
    '',
    'WORKFLOW SO FAR:',
    overview,
    '',
    `LATEST PART OF ${askerLabel}'S TRANSCRIPT:`,
    recent,
    '',
    'Reply with your advice only.',
  ].join('\n');
}

/** Told to every agent when an advisor is available. */
export function advisorHint(who: string, max: number, canSpawn: boolean): string {
  return [
    '',
    `ADVISOR: ${who} is available as an advisor through the Aivenue tool \`ask_advisor\` {question, context}. It is the most expensive model in this workflow, so it is a last resort: ask only when you are genuinely stuck, i.e. you investigated${canSpawn ? ' (yourself or with read-only sub-agents fetching the facts)' : ''} and tried fixes and still cannot resolve it, or you face a high-stakes decision you cannot settle from the facts. Do not ask it for routine work or for things you can find out by reading the code.`,
    `${canSpawn ? 'Do the legwork before asking: send read-only sub-agents to look things up and check their reports. ' : ''}The advisor does not explore the code itself, so in \`context\` say where you are, what you tried and what happened (exact errors), and the relevant code or file:line. At most ${max} consultations per conversation.`,
  ].join('\n');
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
