import type { AgentRole, GoalSpec, IssueResponse, PlanDoc, Review, ReviewIssue, SkillUse, Verification, VerifyOutcome } from './types';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const issuesSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '"R1", "R2", ...' },
      severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
      title: { type: 'string' },
      detail: { type: 'string' },
      location: { type: 'string', description: 'File/line or plan step the issue refers to.' },
    },
    required: ['id', 'severity', 'title'],
  },
};

const goalSchema = {
  type: 'object',
  description: 'The goal that must be met before the workflow may end. Required when goal verification is on.',
  properties: {
    statement: { type: 'string', description: 'What done means, in one or two sentences.' },
    metrics: {
      type: 'array',
      description: 'Acceptance metrics: each one measurable, with a target and how to measure it.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '"M1", "M2", ...' },
          name: { type: 'string' },
          target: { type: 'string', description: 'e.g. "all tests pass", "accuracy >= 0.92", "p95 < 200 ms".' },
          how: { type: 'string', description: 'The command or check that measures it.' },
        },
        required: ['id', 'name', 'target', 'how'],
      },
    },
    expected: { type: 'string', description: 'Expected effect.' },
    cost: { type: 'string', description: 'Expected cost (time, compute, money).' },
    constraints: { type: 'string', description: 'What must not change or be broken.' },
    data: { type: 'array', items: { type: 'string' }, description: 'Data files or folders the results depend on (datasets, fixtures, model weights), relative to the working directory. Their version is recorded with every result.' },
  },
  required: ['statement', 'metrics'],
};

const responsesSchema = {
  type: 'array',
  description: 'One entry per review issue you were asked to address.',
  items: {
    type: 'object',
    properties: {
      issue_id: { type: 'string' },
      action: { type: 'string', enum: ['fixed', 'rebutted'] },
      note: { type: 'string' },
    },
    required: ['issue_id', 'action'],
  },
};

/** What an agent learned, kept as shared facts for every later agent. */
const findingsSchema = {
  type: 'array',
  description:
    'What you learned that later agents should not have to find out again: the environment and versions, where things live, the cause of a failure, an approach that did not work and why. One finding per item, as long as needed.',
  items: { type: 'string' },
};

export const TOOL_DEFS: Record<string, ToolDef> = {
  submit_plan: {
    name: 'submit_plan',
    description: 'Submit your implementation plan to Aivenue (call once when the plan is ready; call again after revisions with the full updated plan).',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One-paragraph summary of the plan.' },
        markdown: { type: 'string', description: 'The full plan in Markdown.' },
        steps: {
          type: 'array',
          description: 'Numbered steps the implementer will follow and report progress on.',
          items: {
            type: 'object',
            properties: { id: { type: 'string', description: '"1", "2", ...' }, title: { type: 'string' }, detail: { type: 'string' } },
            required: ['id', 'title'],
          },
        },
        goal: goalSchema,
        responses: responsesSchema,
        findings: findingsSchema,
      },
      required: ['summary', 'markdown', 'steps'],
    },
  },
  submit_review: {
    name: 'submit_review',
    description: 'Submit your review verdict to Aivenue. Use verdict "approve" when it is ready, "revise" when changes are required.',
    inputSchema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['approve', 'revise'] },
        summary: { type: 'string' },
        issues: issuesSchema,
        findings: findingsSchema,
      },
      required: ['verdict', 'summary', 'issues'],
    },
  },
  submit_verification: {
    name: 'submit_verification',
    description:
      'Submit the goal verification to Aivenue: each acceptance metric measured, with its value and evidence. Aivenue decides from it who works next; you do not decide whether the workflow is done.',
    inputSchema: {
      type: 'object',
      properties: {
        outcome: {
          type: 'string',
          enum: ['met', 'not_met', 'invalid_evidence', 'defect'],
          description: 'met: every metric meets its target. defect: bugs or missing work stop it. invalid_evidence: the measurement itself is wrong, missing or not trustworthy. not_met: the work is valid but the goal is missed (the approach must change).',
        },
        summary: { type: 'string' },
        metrics: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'The metric id from the goal ("M1"…).' },
              value: { type: 'string', description: 'What you measured.' },
              met: { type: 'boolean' },
              evidence: { type: 'string', description: 'The command you ran and the relevant output, or file:line.' },
            },
            required: ['id', 'value', 'met', 'evidence'],
          },
        },
        issues: issuesSchema,
      },
        findings: findingsSchema,
      required: ['outcome', 'summary', 'metrics'],
    },
  },
  submit_ruling: {
    name: 'submit_ruling',
    description: 'Submit your ruling on each disputed issue to Aivenue.',
    inputSchema: {
      type: 'object',
      properties: {
        rulings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              issue_id: { type: 'string' },
              ruling: { type: 'string', enum: ['uphold', 'dismiss'], description: 'uphold: the reviewer is right, it must be fixed. dismiss: the author is right.' },
              reason: { type: 'string', description: 'The evidence that decides it (file:line, command output).' },
            },
            required: ['issue_id', 'ruling', 'reason'],
          },
        },
      },
      required: ['rulings'],
    },
  },
  search_records: {
    name: 'search_records',
    description:
      "Search this workflow's records before you run a command, read a file or investigate something another agent may already have done: every agent's messages, tool calls and their output, shared notes and findings, review and verification issues. A few keywords in any order (records with all of them first, newest first); filter by role, agent, stage, round, file or issue id. Returns matching snippets with the agent id (open one in full with read_context {agent_id}).",
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Keywords, any order, case-insensitive (e.g. "dataset path sample rate").' },
        role: { type: 'string', enum: ['planner', 'plan_reviewer', 'executor', 'code_reviewer', 'verifier', 'adjudicator', 'subagent', 'advisor'] },
        agent_id: { type: 'string' },
        stage: { type: 'string', enum: ['plan', 'implement', 'verify'] },
        round: { type: 'number' },
        file: { type: 'string', description: 'A file path (or part of it).' },
        issue_id: { type: 'string', description: 'e.g. "R2" or "M1".' },
        limit: { type: 'number', description: 'Default 50.' },
      },
    },
  },
  report_skill_use: {
    name: 'report_skill_use',
    description:
      'Tell Aivenue you applied a skill: which one, why, what it produced and how you checked that you followed it. Reading a SKILL.md alone does not count as following it; report it once you actually applied it (again with verified=true after checking).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        version: { type: 'string', description: 'Version from its frontmatter, if any.' },
        reason: { type: 'string', description: 'Why it applies here.' },
        deliverables: { type: 'string', description: 'What following it produced (files, checks, outputs).' },
        verification: { type: 'string', description: 'How you checked you followed it (test, command, review).' },
        verified: { type: 'boolean', description: 'true when that check passed.' },
      },
      required: ['name', 'reason'],
    },
  },
  wait_for: {
    name: 'wait_for',
    description:
      'Wait until a condition holds, checking it every interval_sec (e.g. a training run finished, a file exists, a server answers, a GPU is free). Waits up to ~50 s per call and returns status "waiting" with a wait_id: call again with that wait_id to keep waiting (the timeout and history are kept, also across an Aivenue restart). With gpus, Aivenue also locks that many free GPUs as soon as the condition holds (re-checked under the lock) and returns their indices.',
    inputSchema: {
      type: 'object',
      properties: {
        wait_id: { type: 'string', description: 'Continue an earlier wait.' },
        check: { type: 'string', description: 'Shell command; the condition holds when it exits 0. Runs in bash (Git Bash on Windows) unless it is clearly PowerShell or cmd syntax, or you set shell.' },
        shell: { type: 'string', enum: ['auto', 'bash', 'powershell', 'cmd'], description: 'The shell for check (default auto).' },
        contains: { type: 'string', description: 'Also require this text in its output.' },
        interval_sec: { type: 'number', description: 'Default 30 (5–600).' },
        timeout_min: { type: 'number', description: 'Give up after this long (default 60).' },
        gpus: { type: 'number', description: 'Lock this many GPUs once the condition holds.' },
      },
    },
  },
  gpu_status: {
    name: 'gpu_status',
    description: 'List the GPUs (nvidia-smi): memory, utilization and which Aivenue agent holds each one.',
    inputSchema: { type: 'object', properties: {} },
  },
  gpu_acquire: {
    name: 'gpu_acquire',
    description:
      'Lock free GPUs for your job so no other agent or workflow uses them, and get their indices (set CUDA_VISIBLE_DEVICES to them). Released when you call gpu_release or your turn ends. Use wait_for {gpus} to wait for GPUs that are busy.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Default 1.' },
        max_used_mb: { type: 'number', description: 'A GPU counts as free with at most this much memory in use (default 1024).' },
      },
    },
  },
  gpu_release: {
    name: 'gpu_release',
    description: 'Release the GPUs you locked.',
    inputSchema: { type: 'object', properties: {} },
  },
  track_process: {
    name: 'track_process',
    description:
      'Register a background process you started (a download, a server, a training job) so the user can see whether it is alive, how far it is and who cleans it up. Required for every background job: Aivenue refuses your submission while one is unregistered. Give its progress source so the user sees a percentage: watch_file + expected_size for anything that writes a file or folder of known size (a download, extracted data), and log for its output file (redirect stdout/stderr there; a "45%" in it is read as progress). cleanup "aivenue": Aivenue stops it when the workflow ends; "agent": you stop it yourself before you finish; "keep": it is meant to keep running.',
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'number' },
        purpose: { type: 'string' },
        cleanup: { type: 'string', enum: ['aivenue', 'agent', 'keep'] },
        log: { type: 'string', description: 'The file its output goes to (path relative to the working directory or absolute).' },
        watch_file: { type: 'string', description: 'The file or folder it writes, whose size shows its progress.' },
        expected_size: { type: 'string', description: 'The final size of watch_file, e.g. "15.6GB" or a number of bytes.' },
      },
      required: ['pid', 'purpose', 'cleanup'],
    },
  },
  reply_user: {
    name: 'reply_user',
    description:
      'Answer a message the user sent while you were working, before you go on: one or two sentences on how you understood it and what you will do. Set changes_plan to true when it changes what must be built, the approach or the acceptance criteria (not for a clarification you can just follow).',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, changes_plan: { type: 'boolean' } },
      required: ['text'],
    },
  },
  update_process: {
    name: 'update_process',
    description: 'Report the progress of a background process you registered with track_process, when neither its file size nor its log shows it (e.g. "epoch 3/10" → 30).',
    inputSchema: {
      type: 'object',
      properties: { pid: { type: 'number' }, percent: { type: 'number', description: '0–100' }, note: { type: 'string', description: 'A short status, e.g. "epoch 3/10, loss 0.42".' } },
      required: ['pid'],
    },
  },
  stop_subagent: {
    name: 'stop_subagent',
    description: 'Stop one of your sub-agents (it failed, stalled or is no longer needed), or hand it off: with handoff, it keeps running after your turn and the note says who takes over its result.',
    inputSchema: {
      type: 'object',
      properties: { subagent_id: { type: 'string' }, handoff: { type: 'string', description: 'Keep it running and say who uses its result.' } },
      required: ['subagent_id'],
    },
  },
  submit_work: {
    name: 'submit_work',
    description: 'Tell Aivenue you finished implementing: summary of changes and verification, plus responses to review issues if any.',
    inputSchema: {
      type: 'object',
      properties: { summary: { type: 'string' }, responses: responsesSchema, findings: findingsSchema },
      required: ['summary'],
    },
  },
  report_progress: {
    name: 'report_progress',
    description: 'Report progress on a plan step so the user can follow along.',
    inputSchema: {
      type: 'object',
      properties: {
        step_id: { type: 'string' },
        status: { type: 'string', enum: ['in_progress', 'done', 'blocked', 'skipped'] },
        note: { type: 'string' },
      },
      required: ['step_id', 'status'],
    },
  },
  spawn_subagent: {
    name: 'spawn_subagent',
    description: 'Delegate a self-contained task to another AI agent (possibly another vendor). Returns a subagent_id immediately; use wait_subagent to get the result.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Provider id, see list_providers.' },
        task: { type: 'string', description: 'Complete, self-contained instructions. The sub-agent cannot see your conversation.' },
        title: { type: 'string', description: 'A short name for the task (a few words, e.g. "Write expense tests"), shown to the user.' },
        mode: { type: 'string', enum: ['write', 'readonly'], description: 'readonly = must not modify files. Default write.' },
        model: { type: 'string', description: 'Optional model id for that provider. Ignored when the user fixed a model for it.' },
        effort: { type: 'string', description: 'Optional reasoning effort (e.g. low, medium, high). Ignored when the user fixed one.' },
      },
      required: ['provider', 'task'],
    },
  },
  wait_subagent: {
    name: 'wait_subagent',
    description: 'Wait (up to ~50s) for a sub-agent and return its status and result. Call again while status is "running".',
    inputSchema: {
      type: 'object',
      properties: { subagent_id: { type: 'string' }, timeout_sec: { type: 'number' } },
      required: ['subagent_id'],
    },
  },
  list_providers: {
    name: 'list_providers',
    description: 'List AI providers you may spawn as sub-agents.',
    inputSchema: { type: 'object', properties: {} },
  },
  confirm_external_action: {
    name: 'confirm_external_action',
    description:
      'Ask the user to approve an action that changes something outside this computer BEFORE doing it: git push, creating/merging/closing a pull request, commenting on or creating/closing an issue, publishing a release, triggering a deployment or workflow, or any other write to GitHub or another external service. Blocks until the user decides. Returns "approved" or "denied" (with the user\'s note). Reading (git fetch/pull, gh pr view, listing issues, viewing CI) needs no approval.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['push', 'pull_request', 'merge', 'comment', 'issue', 'release', 'deploy', 'other'], description: 'What kind of external action.' },
        target: { type: 'string', description: 'Where it goes, e.g. "origin main", "owner/repo#12", "owner/repo".' },
        details: { type: 'string', description: 'Exactly what will be done: the command(s), the PR title/body or comment text, the commits being pushed.' },
      },
      required: ['kind', 'target', 'details'],
    },
  },
  ask_advisor: {
    name: 'ask_advisor',
    description:
      'Consult the advisor, the most expensive model in the workflow, only as a last resort: when you investigated (yourself or with sub-agents) and tried, and are still genuinely stuck, or face a high-stakes decision the facts do not settle. The advisor is a consultant, not a second worker: it does not explore the code itself, so put what it needs in `context` (where you are, what you tried, the exact error, the relevant code or file:line). It sees the goal, the plan, the reviews and only the latest part of your transcript, and replies with advice (it does not change files). Returns the advice, or an advisor_id to pass to wait_subagent if it needs more time. Calls per conversation are limited, so ask focused questions.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The one decision or problem you need advice on.' },
        context: { type: 'string', description: 'What you are working on, what you already tried and what happened (exact error messages), and the relevant code snippets or file:line references.' },
      },
      required: ['question'],
    },
  },
  read_context: {
    name: 'read_context',
    description:
      'Read what other agents in this workflow did. With topic: everything on one subject at once — a file (who read and changed it, what it showed, notes and issues naming it), a command (every run and its output), an issue (its whole history), or "facts", "decisions", "inferences", "checkpoints", "knowledge" (the organized shared knowledge), "index" (every topic). Without arguments: an overview with the full plan, every review with all issues, each agent\'s summary and the shared notes. With agent_id: that agent\'s full transcript (its messages, tool calls, commands and their output).',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'A topic key or part of one: "file:src/model.py", "model.py", "command:pytest", "issue:R2", "facts", "decisions", "checkpoints", "knowledge", "index".' },
        agent_id: { type: 'string', description: 'An agent id from the overview. Omit for the overview. "notes" lists every original shared note, also those condensed into the shared memory.' },
        include_prompts: { type: 'boolean', description: 'Also include the instructions Aivenue gave that agent (default false).' },
      },
    },
  },
  post_note: {
    name: 'post_note',
    description: 'Share a note with every later agent in this workflow (e.g. a decision, a gotcha, where something lives, what a long command printed). The user sees it too. Say what kind it is: a checked fact, an inference (a judgement not verified) or a decision.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The note, as long as it needs to be.' }, kind: { type: 'string', enum: ['fact', 'inference', 'decision'], description: 'Default inference.' } },
      required: ['text'],
    },
  },
  capture_screenshot: {
    name: 'capture_screenshot',
    description:
      'Take a screenshot of a web page or local HTML file in a headless browser. Use it to check what a UI you built or are reviewing actually looks like; the user sees the image in the conversation. Returns the PNG path, which you can open with your image/file reading tool to look at it.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'http(s) URL (e.g. a dev server like http://localhost:5173) or an HTML file path relative to the working directory.' },
        width: { type: 'number', description: 'Viewport width in px (default 1280). Widths up to 600 emulate a phone, e.g. 390.' },
        height: { type: 'number', description: 'Viewport height in px (default 800).' },
        full_page: { type: 'boolean', description: 'Capture the whole scrollable page instead of only the viewport.' },
        wait_ms: { type: 'number', description: 'Extra time for scripts/animations after the page loaded (default 1000).' },
        name: { type: 'string', description: 'Short file name, e.g. "home-mobile".' },
      },
      required: ['target'],
    },
  },
  approval_prompt: {
    name: 'approval_prompt',
    description: 'Permission prompt handled by Aivenue: asks the user to approve a tool call.',
    inputSchema: {
      type: 'object',
      properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
      required: ['tool_name'],
    },
  },
};

export function toolsForRole(role: AgentRole, canSpawn: boolean, shareContext = false, advisor = false, gpu = true): ToolDef[] {
  const names: string[] = [];
  if (role === 'planner') names.push('submit_plan');
  if (role === 'plan_reviewer' || role === 'code_reviewer') names.push('submit_review');
  if (role === 'verifier') names.push('submit_verification');
  if (role === 'adjudicator') names.push('submit_ruling');
  if (role === 'executor') names.push('report_progress', 'submit_work');
  if (role === 'subagent') names.push('report_progress');
  // The compactor only reads the material in its prompt.
  if (role === 'compactor') return [];
  // Jobs that run long or need a GPU: implementers, their helpers and the verifier (who measures).
  if (role === 'executor' || role === 'subagent' || role === 'verifier') names.push('wait_for', 'track_process', 'update_process', ...(gpu ? ['gpu_status', 'gpu_acquire', 'gpu_release'] : []));
  if (role !== 'test' && role !== 'advisor') names.push('search_records', 'report_skill_use');
  if (role !== 'test' && role !== 'advisor' && role !== 'adjudicator') names.push('reply_user');
  if (role === 'test') names.push('list_providers');
  else names.push('capture_screenshot');
  // Anything that changes GitHub or another outside service needs the user's OK first (the advisor only advises).
  if (role !== 'test' && role !== 'advisor') names.push('confirm_external_action');
  if (shareContext && role !== 'test') names.push('read_context', 'post_note');
  if (canSpawn) names.push('spawn_subagent', 'wait_subagent', 'stop_subagent', 'list_providers');
  // The advisor itself does not consult another advisor.
  if (advisor && role !== 'test' && role !== 'advisor') names.push('ask_advisor', 'wait_subagent');
  return [...new Set(names)].map((n) => TOOL_DEFS[n]);
}

// ---------- Lenient parsing of submissions (tool args or fallback JSON) ----------

const s = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

function parseResponses(v: unknown): IssueResponse[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v
    .filter((r) => r && typeof r === 'object')
    .map((r: any) => ({ issue_id: s(r.issue_id ?? r.id), action: r.action === 'rebutted' ? 'rebutted' : 'fixed', note: r.note ? s(r.note) : undefined }));
}

export function parsePlan(v: any): { plan: PlanDoc; responses?: IssueResponse[] } | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const steps = Array.isArray(v.steps)
    ? v.steps.map((st: any, i: number) => (typeof st === 'string' ? { id: String(i + 1), title: st } : { id: s(st.id) || String(i + 1), title: s(st.title), detail: st.detail ? s(st.detail) : undefined }))
    : [];
  if (!v.markdown && !v.summary && !steps.length) return undefined;
  return { plan: { summary: s(v.summary), markdown: s(v.markdown) || s(v.summary), steps, goal: parseGoal(v.goal) }, responses: parseResponses(v.responses) };
}

export function parseGoal(v: any): GoalSpec | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const metrics = Array.isArray(v.metrics)
    ? v.metrics.filter((m: any) => m && typeof m === 'object').map((m: any, i: number) => ({ id: s(m.id) || `M${i + 1}`, name: s(m.name) || s(m.target), target: s(m.target), how: s(m.how) }))
    : [];
  if (!s(v.statement) && !metrics.length) return undefined;
  return { statement: s(v.statement), metrics, expected: v.expected ? s(v.expected) : undefined, cost: v.cost ? s(v.cost) : undefined, constraints: v.constraints ? s(v.constraints) : undefined, data: Array.isArray(v.data) ? v.data.map(s).filter(Boolean).slice(0, 20) : undefined };
}

function parseIssues(v: unknown, prefix = 'R'): ReviewIssue[] {
  return Array.isArray(v)
    ? v.map((i: any, n: number) => ({
        id: s(i?.id) || `${prefix}${n + 1}`,
        severity: ['blocker', 'major', 'minor'].includes(i?.severity) ? i.severity : 'major',
        title: s(i?.title) || s(i?.detail).slice(0, 80),
        detail: i?.detail ? s(i.detail) : undefined,
        location: i?.location ? s(i.location) : undefined,
      }))
    : [];
}

export function parseVerification(v: any): Verification | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const outcome = s(v.outcome).toLowerCase().replace(/[\s-]+/g, '_') as VerifyOutcome;
  if (!['met', 'not_met', 'invalid_evidence', 'defect'].includes(outcome)) return undefined;
  const metrics = Array.isArray(v.metrics)
    ? v.metrics.filter((m: any) => m && typeof m === 'object').map((m: any, i: number) => ({ id: s(m.id) || `M${i + 1}`, value: s(m.value), met: m.met === true || s(m.met).toLowerCase() === 'true', evidence: s(m.evidence) }))
    : [];
  return { outcome, summary: s(v.summary), metrics, issues: parseIssues(v.issues, 'V') };
}

export function parseRulings(v: any): { issue_id: string; ruling: 'uphold' | 'dismiss'; reason: string }[] | undefined {
  const list = Array.isArray(v?.rulings) ? v.rulings : Array.isArray(v) ? v : undefined;
  if (!list) return undefined;
  return list.filter((r: any) => r && r.issue_id).map((r: any) => ({ issue_id: s(r.issue_id), ruling: s(r.ruling).toLowerCase() === 'dismiss' ? 'dismiss' : 'uphold', reason: s(r.reason) }));
}

export function parseSkillUse(v: any): Omit<SkillUse, 'ts'> | undefined {
  if (!v || typeof v !== 'object' || !s(v.name).trim()) return undefined;
  return {
    name: s(v.name).trim().slice(0, 80),
    version: v.version ? s(v.version).slice(0, 40) : undefined,
    reason: s(v.reason).slice(0, 500),
    deliverables: v.deliverables ? s(v.deliverables).slice(0, 1000) : undefined,
    verification: v.verification ? s(v.verification).slice(0, 1000) : undefined,
    verified: v.verified === true,
  };
}

export function parseReview(v: any): Review | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const verdict = s(v.verdict).toLowerCase();
  if (!['approve', 'approved', 'revise', 'reject', 'changes_requested'].includes(verdict)) return undefined;
  const issues = parseIssues(v.issues);
  return { verdict: verdict.startsWith('approve') ? 'approve' : 'revise', summary: s(v.summary), issues };
}

export function parseWork(v: any): { summary: string; responses?: IssueResponse[] } | undefined {
  if (!v || typeof v !== 'object' || !v.summary) return undefined;
  return { summary: s(v.summary), responses: parseResponses(v.responses) };
}

/** Last ```json fenced block in a reply. */
export function extractJson(text: string): unknown {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (const b of blocks.reverse()) {
    try {
      return JSON.parse(b);
    } catch {
      // try the next one
    }
  }
  return undefined;
}

/** Build a plan from free text when the planner did not submit one. */
export function planFromText(text: string): PlanDoc | undefined {
  if (!text.trim()) return undefined;
  const steps = [...text.matchAll(/^\s{0,3}(?:#+\s*)?(?:Step\s*|步驟\s*)?(\d+)[.)、:：]\s+(.+)$/gim)].map((m) => ({ id: m[1], title: m[2].trim().slice(0, 200) }));
  const seen = new Set<string>();
  const unique = steps.filter((st) => (seen.has(st.id) ? false : (seen.add(st.id), true)));
  return { summary: text.trim().split('\n')[0].slice(0, 300), markdown: text, steps: unique };
}
