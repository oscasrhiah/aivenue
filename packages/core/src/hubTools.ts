import type { AgentRole, IssueResponse, PlanDoc, Review, ReviewIssue } from './types';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

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
        responses: responsesSchema,
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
        issues: {
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
        },
      },
      required: ['verdict', 'summary', 'issues'],
    },
  },
  submit_work: {
    name: 'submit_work',
    description: 'Tell Aivenue you finished implementing: summary of changes and verification, plus responses to review issues if any.',
    inputSchema: {
      type: 'object',
      properties: { summary: { type: 'string' }, responses: responsesSchema },
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
      'Read what other agents in this workflow did. Without agent_id: an overview with the full plan, every review with all issues, each agent\'s summary and the shared notes. With agent_id: that agent\'s full transcript (its messages, tool calls, commands and their output). Use it when a hand-off summary is not enough.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'An agent id from the overview. Omit for the overview. "notes" lists every original shared note, also those condensed into the shared memory.' },
        include_prompts: { type: 'boolean', description: 'Also include the instructions Aivenue gave that agent (default false).' },
      },
    },
  },
  post_note: {
    name: 'post_note',
    description: 'Share a short note with every later agent in this workflow (e.g. a decision, a gotcha, where something lives). The user sees it too.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The note, at most a few sentences.' } },
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

export function toolsForRole(role: AgentRole, canSpawn: boolean, shareContext = false, advisor = false): ToolDef[] {
  const names: string[] = [];
  if (role === 'planner') names.push('submit_plan');
  if (role === 'plan_reviewer' || role === 'code_reviewer') names.push('submit_review');
  if (role === 'executor') names.push('report_progress', 'submit_work');
  if (role === 'subagent') names.push('report_progress');
  // The compactor only reads the material in its prompt.
  if (role === 'compactor') return [];
  if (role === 'test') names.push('list_providers');
  else names.push('capture_screenshot');
  // Anything that changes GitHub or another outside service needs the user's OK first (the advisor only advises).
  if (role !== 'test' && role !== 'advisor') names.push('confirm_external_action');
  if (shareContext && role !== 'test') names.push('read_context', 'post_note');
  if (canSpawn) names.push('spawn_subagent', 'wait_subagent', 'list_providers');
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
  return { plan: { summary: s(v.summary), markdown: s(v.markdown) || s(v.summary), steps }, responses: parseResponses(v.responses) };
}

export function parseReview(v: any): Review | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const verdict = s(v.verdict).toLowerCase();
  if (!['approve', 'approved', 'revise', 'reject', 'changes_requested'].includes(verdict)) return undefined;
  const issues: ReviewIssue[] = Array.isArray(v.issues)
    ? v.issues.map((i: any, n: number) => ({
        id: s(i.id) || `R${n + 1}`,
        severity: ['blocker', 'major', 'minor'].includes(i.severity) ? i.severity : 'major',
        title: s(i.title) || s(i.detail).slice(0, 80),
        detail: i.detail ? s(i.detail) : undefined,
        location: i.location ? s(i.location) : undefined,
      }))
    : [];
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
