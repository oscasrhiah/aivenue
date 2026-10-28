import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AdvisorConfig,
  AgentEvent,
  AgentRole,
  ApprovalRequest,
  Attachment,
  AssignmentResult,
  PermissionLevel,
  ProviderSpec,
  AgentRunInfo,
  IssueResponse,
  ModelInfo,
  PlanDoc,
  PreflightItem,
  PushMessage,
  Review,
  ReviewIssue,
  RoleConfig,
  Round,
  RouteDecision,
  StageKey,
  PhaseKey,
  Verification,
  VerifyConfig,
  HumanDecision,
  TestResult,
  WorkflowConfig,
  WorkflowRun,
  WorkflowSummary,
} from './types';
import { runAgent, type BridgeLaunch, type RunAgentResult } from './agentRunner';
import { capture, findNode } from './proc';
import type { ProviderRegistry } from './providers/registry';
import { RunStore } from './store';
import { extractJson, parsePlan, parseReview, parseRulings, parseSkillUse, parseVerification, parseWork, planFromText, TOOL_DEFS, toolsForRole, type ToolDef } from './hubTools';
import { disputedIssues, limitHit, nextPhase, repeatedIssues, routeVerification } from './router';
import { buildHandoff, evidenceStamp, markStale, searchRecords, type RecordQuery } from './records';
import { killPid, pidAlive, ResourceManager } from './resources';
import { classifyFailure, recoveryFor } from './failures';
import { exportBundle, distilProjectSkill } from './bundle';
import { classifyTool } from './providers/parsers';
import { L } from './i18n';
import { LIMIT_PATTERN, type UsageTracker } from './usage';
import type { CapabilityStore, ResolvedMcpServer } from './capabilities';
import { attachmentsBlock, isImage, type AttachmentStore } from './attachments';
import { profileForInputs } from './readability';
import { autoAssign, DEFAULT_AUTO } from './assign';
import { diffSnapshots, snapshot, type Snapshot } from './outputs';
import { captureScreenshot, isLoopbackUrl, resolveTarget } from './screenshot';
import { CliPool } from './cliPool';
import { agentLabel, agentResult, allNotes, contextBlock, formatTranscript, overview, sharingOf } from './context';
import { codexContext, compactCodexThread, estimateTokens } from './agentContext';
import { applyWorktree, createWorktree, gitStamp, keepWorktree, removeWorktree, safeGit } from './worktree';
import * as P from './prompts';
import { advisorPairing } from './advisorPairing';
import { taskTitle } from './taskTitle';

export interface OrchestratorDeps {
  registry: ProviderRegistry;
  store: RunStore;
  usage: UsageTracker;
  capabilities: CapabilityStore;
  attachments: AttachmentStore;
  dataDir: string;
  /** Absolute path of the bundled MCP bridge script. */
  bridgePath: string;
  hubUrl: () => string;
  push: (m: PushMessage) => void;
  /** GitHub access agents are told about (gh signed in; GitHub MCP on). */
  github?: () => { gh: boolean; user?: string; mcp: boolean } | undefined;
  /** Through a router provider (OmniRoute): the models that actually answered between two times. */
  servedBy?: (provider: string, model: string | undefined, from: number, to: number) => Promise<string[] | undefined>;
  /** nvidia-smi's CSV output (tests pass their own). */
  gpuQuery?: () => string;
}

class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

/** Ended short of the goal: a limit was hit or the user stopped retrying. Never reported as done. */
class Incomplete extends Error {}

type Expect = 'submit_plan' | 'submit_review' | 'submit_work' | 'submit_verification' | 'submit_ruling';

interface Submission {
  plan?: { plan: PlanDoc; responses?: IssueResponse[] };
  review?: Review;
  work?: { summary: string; responses?: IssueResponse[] };
  verification?: Verification;
  rulings?: { issue_id: string; ruling: 'uphold' | 'dismiss'; reason: string }[];
}

/** How a stage is re-entered after a verification or a re-diagnosis: the first prompt of that pass. */
interface Entry {
  prompt: () => string;
}

/** A sub-agent with no sign of life this long is reported to its parent as stalled. */
const STALL_MS = 10 * 60000;

interface Session {
  workflowId: string;
  agentId: string;
  /** Set for provider connectivity tests. */
  onTestCall?: () => void;
  /** Shared MCP servers the bridge must proxy (CLIs with a static MCP registration). */
  proxyServers?: ResolvedMcpServer[];
  /** "ask": the bridge exposes the approval tool for this agent. */
  permission?: PermissionLevel;
}

const roleLabel = (r: AgentRole): string =>
  ({
    planner: L('計畫撰寫', 'Planner'),
    plan_reviewer: L('計畫審查', 'Plan reviewer'),
    executor: L('實作', 'Implementer'),
    code_reviewer: L('程式審查', 'Code reviewer'),
    verifier: L('目標驗收', 'Goal verifier'),
    adjudicator: L('裁定', 'Adjudicator'),
    subagent: 'Sub agent',
    advisor: L('顧問', 'Advisor'),
    compactor: L('上下文壓縮', 'Context compactor'),
    test: L('連線測試', 'Connectivity test'),
  })[r];

const ICON: Record<string, string> = { read: '📖', edit: '✏️', command: '▶', search: '🔎', web: '🌐', hub: '🔗', agent: '🤖', todo: '☑', other: '🔧' };

function activityOf(e: AgentEvent): string | undefined {
  if (e.kind === 'tool' && e.tool) return `${ICON[e.tool.category] ?? '🔧'} ${e.tool.title}`.slice(0, 140);
  if (e.kind === 'message' && e.text) return `💬 ${e.text.replace(/\s+/g, ' ').slice(0, 120)}`;
  if (e.kind === 'thinking') return L('🤔 思考中…', '🤔 Thinking…');
  if (e.kind === 'error' && e.text) return `⚠️ ${e.text.slice(0, 120)}`;
  return undefined;
}

const routeName = (to: RouteDecision['to']) => ({ done: L('完成', 'done'), implementer: L('交回實作者', 'back to the implementer'), planner: L('交回計畫者重新規劃', 'back to the planner'), adjudicate: L('交付裁定', 'to adjudication'), user: L('交給你', 'to you') })[to];

const outcomeLabel = (o: Verification['outcome']) => ({ met: L('達標', 'met'), not_met: L('目標未達成', 'goal not met'), invalid_evidence: L('證據無效', 'invalid evidence'), defect: L('有缺陷', 'defects') })[o];

const now = () => Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What "always allow" covers: a shell command's program (allowing `npm test` does not allow `curl`),
 * otherwise the tool itself.
 */
function alwaysKey(tool: string, input: unknown): string {
  const cmd = typeof (input as { command?: unknown })?.command === 'string' ? ((input as { command: string }).command as string) : undefined;
  if (cmd === undefined) return tool;
  // A chained or substituted command is only covered by the exact same line.
  if (/[;&|`$<>\n]/.test(cmd)) return `${tool}\0${cmd.trim()}`;
  return `${tool}\0${cmd.trim().split(/\s+/)[0] ?? ''}`;
}

/**
 * Extra folders as given by the user: absolute, existing folders, not the working folder itself,
 * without duplicates (max 20). Throws with a clear message for one that can't be used.
 */
function checkExtraDirs(dirs: string[] | undefined, cwd: string): string[] {
  const out: string[] = [];
  const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  for (const raw of dirs ?? []) {
    const d = path.resolve(String(raw ?? '').trim());
    if (!String(raw ?? '').trim()) continue;
    if (!path.isAbsolute(String(raw).trim())) throw new Error(L(`額外資料夾要用完整路徑：${raw}`, `Extra folders need a full path: ${raw}`));
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) throw new Error(L(`找不到額外資料夾：${d}`, `Extra folder not found: ${d}`));
    if (same(d, path.resolve(cwd)) || out.some((x) => same(x, d))) continue;
    out.push(d);
  }
  if (out.length > 20) throw new Error(L('額外資料夾最多 20 個', 'At most 20 extra folders'));
  return out;
}

/** Agents don't always use the tool's kind names ("git push", "PR", "tag"): map them so cards and pre-approvals match. */
function normalizeKind(raw: string): string {
  const k = raw.trim().toLowerCase();
  if (/pull[\s_-]*request|\bpr\b/.test(k)) return 'pull_request';
  if (/merge/.test(k)) return 'merge';
  if (/release|\btag\b/.test(k)) return 'release';
  if (/push/.test(k)) return 'push';
  if (/comment|review/.test(k)) return 'comment';
  if (/issue/.test(k)) return 'issue';
  if (/deploy|workflow|dispatch/.test(k)) return 'deploy';
  return k ? k.slice(0, 30) : 'other';
}

/** Approval card text for confirm_external_action. */
function externalLabel(input: unknown): { name: string; title: string } {
  const i = (input ?? {}) as { command?: string; target?: string };
  const kinds: Record<string, [string, string]> = {
    push: ['推送', 'Push'],
    pull_request: ['開 Pull Request', 'Open a pull request'],
    merge: ['合併', 'Merge'],
    comment: ['留言', 'Comment'],
    issue: ['Issue', 'Issue'],
    release: ['發布版本', 'Publish a release'],
    deploy: ['部署', 'Deploy'],
  };
  const k = kinds[i.command ?? ''] ?? ['對外動作', 'External action'];
  return { name: L('對外動作', 'External action'), title: `${L(k[0], k[1])} → ${i.target ?? ''}` };
}

/** Model and effort names an agent may pick for a sub-agent: they end up on a command line. */
const SAFE_ARG = /^[A-Za-z0-9][\w.:/@+-]{0,99}$/;

/** Most sub-agents one conversation may start in total. */
const MAX_SUBAGENTS = 40;

/** Shared context capacity when the user picks none (tokens), and the share of an agent's model it may fill in a prompt. */
const DEFAULT_CAPACITY = 256_000;
const SHARE_OF_WINDOW = 0.2;
/** Below this (tokens of material) a summary is not worth it. */
const MIN_COMPACT_TOKENS = 1000;

/** Automatic compactor: the first signed-in of these (mid-priced models, not the tiniest free ones). */
// OmniRoute (when on and connected) first: compaction needs no tools, so a free model does, and the result is checked anyway.
const AUTO_COMPACTORS: { provider: string; model?: string }[] = [{ provider: 'omniroute' }, { provider: 'claude', model: 'haiku' }, { provider: 'codex' }, { provider: 'antigravity' }, { provider: 'copilot' }, { provider: 'qwen' }, { provider: 'opencode' }];

/** 158000 → "158K". */
const fmtK = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

/** Rounds of sub-agent fact-finding an advisor goes through before it may read the code itself (the user can change it). */
const ADVISOR_FACT_ROUNDS = 3;

/** The advisor's round limit from its settings; 0 means it never reads the code itself. */
const factRoundsOf = (cfg?: { factRounds?: number }) => (cfg?.factRounds === 0 ? 0 : Math.min(50, Math.max(1, Math.round(cfg?.factRounds ?? ADVISOR_FACT_ROUNDS))));

export class Orchestrator {
  readonly runs = new Map<string, WorkflowRun>();
  private aborts = new Map<string, AbortController>();
  private agentAborts = new Map<string, AbortController>();
  private sessions = new Map<string, Session>();
  private submissions = new Map<string, Submission>();
  private agentDone = new Map<string, Promise<void>>();
  /** Shared context a conversation (run|session id) was already given, compactions in flight, and catalog limits. */
  private sharedSeen = new Map<string, number>();
  private compactingShared = new Map<string, Promise<void>>();
  private agentCompactions = new Map<string, Promise<void>>();
  private queuedAgentCompact = new Map<string, string>();
  private catalogWindows = new Map<string, number | undefined>();
  /** Shared size at the last automatic compaction that did not shrink it: no new try until it grows by a fifth. */
  private noGainAt = new Map<string, number>();
  /** Native-advisor pairings already reported as unusable (run|main|advisor). */
  private advisorWarned = new Set<string>();
  /** Fact-finding rounds per advisor, and which round each of its sub-agents belongs to. */
  private factRounds = new Map<string, { round: number; lastSpawnAt: number }>();
  private factRoundOf = new Map<string, number>();
  private decisionWaiters = new Map<string, (d: { optionId: string; text?: string }) => void>();
  private pushTimers = new Map<string, NodeJS.Timeout>();

  /** GPU locks and condition waits. */
  readonly resources: ResourceManager;
  /** Agents the user stopped (no automatic failover or retry for them). */
  private stoppedByUser = new Set<string>();
  /** Agents stopped to start again with changed settings. */
  private redispatch = new Set<string>();
  /** A sub-agent's full task and mode, to run it again. */
  private subSpecs = new Map<string, { task: string; mode: 'write' | 'readonly' }>();
  /** Notices for a parent (a sub-agent failed, stalled, was stopped or re-run), added to its next Aivenue tool result. */
  private inbox = new Map<string, string[]>();
  private stallNoted = new Set<string>();
  private watchdogs = new Map<string, NodeJS.Timeout>();
  private noProgressAskedAt = new Map<string, number>();
  /** Runs stopped by a limit: they end as "incomplete". */
  private incompleteWhy = new Map<string, string>();

  constructor(private d: OrchestratorDeps) {
    for (const r of d.store.loadAll()) this.runs.set(r.id, r);
    this.resources = new ResourceManager(d.dataDir, d.gpuQuery);
  }

  // ---------- public API ----------

  summaries(): WorkflowSummary[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt).map(RunStore.summary);
  }

  /** Auto mode: pick providers per role from what is ready right now. */
  autoAssignment(config: Pick<WorkflowConfig, 'assignment' | 'attachments'>): AssignmentResult {
    return autoAssign({
      providers: this.d.registry.list(),
      usage: this.d.usage.cachedSummary(this.d.registry.specs()),
      prefs: config.assignment?.auto ?? DEFAULT_AUTO,
      needsVision: (config.attachments ?? []).some(isImage),
      needsAudio: (config.attachments ?? []).some((a) => a.kind === 'audio'),
      needsVideo: (config.attachments ?? []).some((a) => a.kind === 'video'),
    });
  }

  private applyAssignment(config: WorkflowConfig, a: AssignmentResult): WorkflowConfig {
    const stage = (s: WorkflowConfig['plan'], who: { author?: string; reviewer?: string }) => ({
      ...s,
      author: { provider: who.author ?? s.author.provider },
      // "No review" chosen by the user stays off in auto mode too.
      reviewer: s.reviewer === null ? null : { provider: who.reviewer ?? s.reviewer.provider },
    });
    return {
      ...config,
      plan: stage(config.plan, a.plan),
      implement: stage(config.implement, a.implement),
      subagents: { ...config.subagents, allowed: a.subagents },
    };
  }

  /** Next provider to try for a role after `tried` failed (auto mode with failover). */
  private failoverTarget(run: WorkflowRun, kind: 'plan' | 'review' | 'code', tried: Set<string>): string | undefined {
    if (run.config.assignment?.mode !== 'auto' || !run.config.assignment.auto.failover || !run.assignment) return undefined;
    const ready = new Set(this.d.registry.list().filter((p) => p.installed && p.auth.state === 'logged_in').map((p) => p.spec.id));
    return run.assignment.ranking[kind].find((id) => !tried.has(id) && ready.has(id));
  }

  start(config: WorkflowConfig): WorkflowRun {
    if (!config.goal?.trim()) throw new Error(L('請填寫任務內容', 'Please describe the task'));
    if (!config.cwd || !fs.existsSync(config.cwd) || !fs.statSync(config.cwd).isDirectory()) throw new Error(L(`工作資料夾不存在：${config.cwd}`, `Working folder does not exist: ${config.cwd}`));
    // In auto mode the roles are replaced below, so stale providers in the draft don't matter.
    if (config.assignment?.mode !== 'auto') {
      for (const role of [config.plan.enabled && config.plan.author, config.plan.enabled && config.plan.reviewer, config.implement.enabled && config.implement.author, config.implement.enabled && config.implement.reviewer]) {
        if (role && !this.d.registry.get(role.provider)) throw new Error(L(`未知的供應商：${role.provider}`, `Unknown provider: ${role.provider}`));
      }
    }
    if (!config.plan.enabled && !config.implement.enabled) throw new Error(L('至少要啟用一個階段', 'Enable at least one stage'));
    // A pre-approval is never inherited by follow-ups or edits; only continueDenied() sets one.
    config = { ...config, extraDirs: checkExtraDirs(config.extraDirs, config.cwd), preApproved: undefined };
    const assignment = config.assignment?.mode === 'auto' ? this.autoAssignment(config) : undefined;
    if (assignment) config = this.applyAssignment(config, assignment);
    const id = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + randomUUID().slice(0, 6);
    const attachments = this.d.attachments.adopt(id, config.attachments);
    // A follow-up stays in its conversation (one sidebar entry) and goes on from the message it continues.
    const prev = config.continueFrom ? this.runs.get(config.continueFrom) : undefined;
    // An edited message stays in the conversation of the one it replaces.
    const replaced = config.replaces ? this.runs.get(config.replaces) : undefined;
    const threadId = prev ? prev.config.threadId ?? prev.id : replaced ? replaced.config.threadId ?? replaced.id : config.threadId;
    const run: WorkflowRun = {
      id,
      assignment,
      config: { ...config, threadId, attachments, title: config.title?.trim() || config.goal.trim().split('\n')[0].slice(0, 60) },
      status: 'running',
      createdAt: now(),
      updatedAt: now(),
      stages: {
        plan: { key: 'plan', status: 'pending', rounds: [], roundLimit: Math.max(1, config.plan.maxRounds) },
        implement: { key: 'implement', status: 'pending', rounds: [], roundLimit: Math.max(1, config.implement.maxRounds) },
        ...(config.verify?.enabled ? { verify: { key: 'verify' as const, status: 'pending' as const, rounds: [], roundLimit: 999 } } : {}),
      },
      lastProgressAt: now(),
      steps: [],
      agents: {},
      log: [],
    };
    if (prev) this.carryOver(prev, run);
    this.runs.set(id, run);
    this.aborts.set(id, new AbortController());
    this.log(run, L(`工作流開始：${run.config.title}`, `Workflow started: ${run.config.title}`));
    const execution = this.execute(run).finally(() => this.executions.delete(id));
    this.executions.set(id, execution);
    if (config.replaces) {
      const old = this.runs.get(config.replaces);
      if (old) {
        old.replacedBy = id;
        this.touch(old);
      }
    }
    return run;
  }

  // ---------- pause / resume ----------

  /** Paused workflows: agents wait on `gate` before starting; `note` is what the user typed when resuming. */
  /** pending: messages sent while paused, handed over on resume. */
  private pauses = new Map<string, { gate: Promise<void>; release: () => void; note?: string; pending?: string }>();
  /** Messages the user sent to a working agent, handed over when it continues. */
  private agentNotes = new Map<string, string>();
  /** Agents stopped by a pause (not a cancel), to be continued on resume. */
  private pausedAgents = new Set<string>();

  /** Stop the agents working right now and hold new ones until resume(). */
  pause(id: string): void {
    const run = this.runs.get(id);
    if (!run) throw new Error(L('找不到工作流', 'Workflow not found'));
    if (run.status !== 'running') throw new Error(L('只有執行中的工作流可以暫停', 'Only a running workflow can be paused'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    this.pauses.set(id, { gate, release });
    for (const a of Object.values(run.agents)) {
      if (a.status !== 'running') continue;
      this.pausedAgents.add(a.id);
      this.agentAborts.get(a.id)?.abort();
    }
    run.status = 'paused';
    this.log(run, L('已暫停：正在工作的 agent 已停下，按「繼續」會從原本的進度接著做', 'Paused: working agents stopped; Resume continues where they left off'), 'info', true);
    this.touch(run);
  }

  /** Continue a paused workflow; `note` is passed to the agents that were stopped. */
  resume(id: string, note?: string): void {
    const run = this.runs.get(id);
    const p = this.pauses.get(id);
    if (!run || !p) throw new Error(L('這個工作流沒有暫停', 'This workflow is not paused'));
    this.pauses.delete(id);
    run.status = 'running';
    this.log(run, note?.trim() ? L(`繼續執行，並告訴 agent：${note.trim()}`, `Resumed, telling the agents: ${note.trim()}`) : L('繼續執行', 'Resumed'), 'info', true);
    this.touch(run);
    p.note = [p.pending, note?.trim()].filter(Boolean).join('\n') || undefined;
    p.release();
  }

  /**
   * A message sent while the workflow runs: working agents stop and continue their own conversation with it right
   * away; it also becomes a shared note, so every agent that starts later sees it.
   */
  async interject(id: string, text: string, files: Attachment[] = []): Promise<void> {
    const run = this.runs.get(id);
    if (!run) throw new Error(L('找不到工作流', 'Workflow not found'));
    if (!text.trim() && !files.length) throw new Error(L('訊息是空的', 'The message is empty'));
    if (!['running', 'paused', 'waiting_human'].includes(run.status)) throw new Error(L('這段對話已經結束，請直接送出新訊息', 'This conversation has finished; send a new message instead'));
    // Files sent with the message join the run's attachments (converted like the first message's) and are named in it.
    let added: Attachment[] = [];
    if (files.length) {
      const adopted = this.d.attachments.adopt(run.id, files, run.config.attachments ?? []);
      added = (await this.d.attachments.prepare(adopted)).attachments;
      // Marked "earlier" so the first message does not show them; the mid-run message shows them itself.
      run.config.attachments = [...(run.config.attachments ?? []), ...added.map((a) => ({ ...a, earlier: true }))];
    }
    const listed = added.map((a) => `- ${a.name}: ${a.companion?.path ?? a.path}${a.companion ? ` (Aivenue's readable version of ${a.path})` : ''}`);
    const msg = [text.trim().slice(0, 8000), listed.length ? `The user attached these files; read them:\n${listed.join('\n')}` : ''].filter(Boolean).join('\n\n');
    (run.userMessages ??= []).push({ ts: now(), text: text.trim().slice(0, 8000), attachments: added.length ? added : undefined });
    (run.notes ??= []).push({ id: randomUUID().slice(0, 8), agentId: 'user', by: 'USER (sent while you were working — follow it)', text: msg, ts: now() });
    const p = this.pauses.get(id);
    if (run.status === 'paused' && p) {
      // Paused: handed over together with whatever the user adds on resume.
      p.pending = [p.pending, msg].filter(Boolean).join('\n');
    } else if (run.status === 'running') {
      // Stop each working agent; invokePausable continues its own conversation with the message.
      for (const a of Object.values(run.agents)) {
        if (a.status !== 'running' || a.role === 'compactor') continue;
        this.agentNotes.set(a.id, [this.agentNotes.get(a.id), msg].filter(Boolean).join('\n'));
        this.pausedAgents.add(a.id);
        this.agentAborts.get(a.id)?.abort();
      }
    }
    this.touch(run);
  }

  /** Wait while the workflow is paused; returns what the user typed on resume. */
  private async waitIfPaused(run: WorkflowRun): Promise<string | undefined> {
    const p = this.pauses.get(run.id);
    if (!p) return undefined;
    await p.gate;
    this.checkCancelled(run);
    return p.note;
  }

  /**
   * invoke(), surviving pauses: an agent stopped by a pause waits for resume and then continues its own
   * session (or starts the same turn again when the CLI cannot resume).
   */
  private async invokePausable(run: WorkflowRun, info: AgentRunInfo, prompt: string, mode: 'write' | 'readonly', resume?: string, seqStart?: number): Promise<RunAgentResult> {
    await this.waitIfPaused(run);
    let res = await this.invoke(run, info, prompt, mode, resume, seqStart);
    while (this.pausedAgents.delete(info.id) && !this.aborted(run)) {
      info.status = 'paused';
      this.touch(run);
      const said = this.agentNotes.get(info.id);
      this.agentNotes.delete(info.id);
      const note = [said, await this.waitIfPaused(run)].filter(Boolean).join('\n') || undefined;
      const session = res.sessionId ?? info.sessionId;
      const spec = this.d.registry.get(info.provider);
      const canResume = !!(session && spec?.run.resume && spec.capabilities?.resume !== false);
      const extra = note ? `\n\nThe user added: ${note}` : '';
      res = canResume
        ? await this.invoke(run, info, P.resumeAfterPause() + extra, mode, session, res.lastSeq)
        : await this.invoke(run, info, prompt + extra, mode, resume, res.lastSeq);
    }
    return res;
  }

  /**
   * The user changed their mind about a denied external action: start a follow-up (same settings and folder) that
   * does it, plus whatever was skipped because of it, with that one action pre-approved.
   */
  continueDenied(id: string, deniedId: string): string {
    const run = this.runs.get(id);
    const denied = run?.deniedActions?.find((d) => d.id === deniedId);
    if (!run || !denied) throw new Error(L('找不到這個被拒絕的動作', 'Denied action not found'));
    if (['running', 'paused', 'waiting_human'].includes(run.status)) throw new Error(L('請等這段對話結束後再繼續', 'Wait until this conversation has finished'));
    if (denied.continuedIn) return denied.continuedIn;
    const kind = normalizeKind(denied.kind);
    const label = externalLabel({ command: kind, target: denied.target }).title;
    const prev = Object.values(run.agents)
      .filter((a) => (a.role === 'executor' || a.role === 'planner') && a.finalText)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0]?.finalText;
    const goal = [
      L(`先前被我拒絕的對外動作，現在改成允許：${label}`, `I now allow the external action I denied before: ${label}`),
      L(`內容：${denied.details}`, `Details: ${denied.details}`),
      L('請完成這個動作，以及先前因為它被拒絕而略過的後續步驟，然後回報結果。執行前一樣呼叫 confirm_external_action（這一次會直接通過）；其他對外動作仍要另外核准。', 'Do it, plus the steps that were skipped because it was denied, then report. Still call confirm_external_action first (this one goes through directly); any other external action needs its own approval.'),
    ].join('\n');
    const next = this.start({
      ...run.config,
      cwd: run.worktree?.origCwd ?? run.config.cwd,
      title: L(`改成允許並繼續：${label}`, `Allowed and continued: ${label}`).slice(0, 60),
      goal: `${goal}\n\n(Context: this continues an earlier task in the same folder: "${run.config.goal.slice(0, 800)}". Its outcome: ${(prev ?? run.status).slice(0, 1500)})`,
      replaces: undefined,
      continueFrom: run.id,
    });
    // Set after start() (which drops inherited ones), before any agent can ask.
    next.config.preApproved = [{ kind, target: denied.target, details: denied.details }];
    denied.continuedIn = next.id;
    this.touch(run);
    return next.id;
  }

  /**
   * A follow-up message goes on from the previous one: its shared notes and shared memory, and each role's agent
   * conversation when the same CLI fills it in the same folder (not across an isolated worktree).
   */
  private carryOver(prev: WorkflowRun, run: WorkflowRun) {
    const label = (agentId: string) => {
      const a = prev.agents[agentId];
      return a ? `${roleLabel(a.role)} ${a.provider}` : undefined;
    };
    run.notes = (prev.notes ?? []).map((n) => ({ ...n, by: n.by ?? label(n.agentId) }));
    if (prev.sideEffects?.length) run.sideEffects = [...prev.sideEffects];
    const waits = (prev.waits ?? []).filter((w) => w.state === 'waiting' && w.timeoutAt > now());
    if (waits.length) run.waits = waits.map((w) => ({ ...w }));
    if (prev.memory) run.memory = { ...prev.memory };
    if (prev.contextMuted) run.contextMuted = [...prev.contextMuted];
    if (prev.contextAsked) run.contextAsked = { ...prev.contextAsked };
    const sameFolder = !prev.worktree && run.config.isolation !== 'worktree' && path.resolve(prev.config.cwd) === path.resolve(run.config.cwd);
    if (!sameFolder) return;
    const carried: string[] = [];
    for (const key of ['plan', 'implement'] as StageKey[]) {
      const from = prev.stages[key];
      const to = run.stages[key];
      const was = prev.config[key];
      const now = run.config[key];
      if (from.authorSessionId && was.author.provider === now.author.provider) carried.push((to.authorSessionId = from.authorSessionId));
      else if (from.authorHandoff && was.author.provider === now.author.provider) to.authorHandoff = from.authorHandoff;
      if (from.reviewerSessionId && was.reviewer && now.reviewer && was.reviewer.provider === now.reviewer.provider) carried.push((to.reviewerSessionId = from.reviewerSessionId));
    }
    // They already have what the previous message gave them.
    for (const sid of carried) {
      const seen = this.sharedSeen.get(`${prev.id}|${sid}`);
      if (seen) this.sharedSeen.set(`${run.id}|${sid}`, seen);
    }
    if (carried.length) run.carriedSessions = carried;
  }

  /** Running workflows, so an edit can wait until the old one really stopped. */
  private executions = new Map<string, Promise<void>>();

  /**
   * Edit a sent message: stop that workflow if it still runs (and wait until its agents are gone),
   * then start the edited message as a new workflow with the same settings. The old one stays in history.
   */
  async editAndResend(id: string, goal: string, config?: WorkflowConfig): Promise<string> {
    const old = this.runs.get(id);
    if (!old) throw new Error(L('找不到工作流', 'Workflow not found'));
    if (!goal.trim()) throw new Error(L('請填寫任務內容', 'Please describe the task'));
    if (old.status === 'running' || old.status === 'paused' || old.status === 'waiting_human') {
      this.cancel(id);
      this.log(old, L('你編輯了這則訊息，已中止這次的工作流', 'You edited this message; this workflow was stopped'), 'warn', true);
      await Promise.race([this.executions.get(id), sleep(15000)]);
    }
    const base = config ?? old.config;
    // A follow-up keeps the context of the earlier task it continued.
    const context = /\n\n\(Context: this continues[\s\S]*$/.exec(old.config.goal)?.[0] ?? '';
    const next = this.start({
      ...base,
      cwd: old.worktree?.origCwd ?? base.cwd,
      title: goal.trim().split('\n')[0].slice(0, 60),
      goal: goal.trim() + context,
      replaces: id,
    });
    return next.id;
  }

  /**
   * Change settings of a conversation while it runs. Applies to agents started from now on;
   * running agents keep theirs. The working folder and isolation are fixed once a run started.
   */
  updateConfig(id: string, patch: Partial<Pick<WorkflowConfig, 'plan' | 'implement' | 'subagents' | 'permission' | 'contextSharing' | 'context' | 'assignment' | 'advisor' | 'extraDirs' | 'verify' | 'limits'>>, restart = false): WorkflowRun {
    const run = this.runs.get(id);
    if (!run) throw new Error(L('找不到工作流', 'Workflow not found'));
    // "Apply now": the agents of a changed role stop and start again with the new settings (same round, same task).
    if (restart && run.status === 'running') {
      for (const key of ['plan', 'implement'] as StageKey[]) {
        const next = patch[key];
        if (!next) continue;
        const cur = run.config[key];
        const changed = (a?: RoleConfig | null, b?: RoleConfig | null) => !!a && (!b || a.provider !== b.provider || (a.model ?? '') !== (b.model ?? '') || (a.effort ?? '') !== (b.effort ?? ''));
        const roles: AgentRole[] = [];
        if (changed(next.author, cur.author)) roles.push(key === 'plan' ? 'planner' : 'executor');
        if (next.reviewer !== undefined && changed(next.reviewer, cur.reviewer)) roles.push(key === 'plan' ? 'plan_reviewer' : 'code_reviewer');
        for (const a of Object.values(run.agents)) {
          if (a.status !== 'running' || a.stage !== key || !roles.includes(a.role)) continue;
          this.redispatch.add(a.id);
          this.agentAborts.get(a.id)?.abort();
        }
      }
    }
    for (const key of ['plan', 'implement'] as StageKey[]) {
      const next = patch[key];
      if (!next) continue;
      const cur = run.config[key];
      const stage = run.stages[key];
      // A session belongs to one vendor: a new author / reviewer starts fresh.
      if (next.author && next.author.provider !== cur.author.provider) stage.authorSessionId = undefined;
      if (next.reviewer !== undefined && next.reviewer?.provider !== cur.reviewer?.provider) stage.reviewerSessionId = undefined;
      if (next.maxRounds && next.maxRounds !== cur.maxRounds) stage.roundLimit = Math.max(1, next.maxRounds, stage.rounds.length);
      // Mutated in place: a stage that is already running reads the same object every round.
      Object.assign(cur, next);
    }
    if (patch.subagents) Object.assign(run.config.subagents, patch.subagents);
    if (patch.permission) run.config.permission = patch.permission;
    if (patch.contextSharing) run.config.contextSharing = patch.contextSharing;
    if (patch.context) run.config.context = patch.context;
    if (patch.assignment) run.config.assignment = patch.assignment;
    if (patch.advisor) run.config.advisor = patch.advisor;
    if (patch.extraDirs) run.config.extraDirs = checkExtraDirs(patch.extraDirs, run.worktree?.origCwd ?? run.config.cwd);
    if (patch.verify) {
      run.config.verify = patch.verify;
      if (patch.verify.enabled) run.stages.verify ??= { key: 'verify', status: 'pending', rounds: [], roundLimit: 999 };
    }
    if (patch.limits) run.config.limits = patch.limits;
    this.log(
      run,
      restart
        ? L('你調整了設定並立即套用：受影響的 agent 停下後用新設定重新派發', 'You changed the settings and applied them now: affected agents stop and are re-dispatched with them')
        : L('你調整了這段對話的設定（套用到接下來開始的 agent）', 'You changed this conversation\'s settings (applies to agents started from now on)'),
    );
    this.touch(run);
    return run;
  }

  cancel(id: string): void {
    const run = this.runs.get(id);
    if (!run) throw new Error(L('找不到工作流', 'Workflow not found'));
    this.aborts.get(id)?.abort();
    for (const a of Object.values(run.agents)) if (a.status === 'running') this.agentAborts.get(a.id)?.abort();
    // A paused workflow's agents are waiting to resume: let them go so they see the cancel.
    const p = this.pauses.get(id);
    if (p) {
      this.pauses.delete(id);
      for (const a of Object.values(run.agents)) if (a.status === 'paused') a.status = 'cancelled';
      p.release();
    }
  }

  decide(id: string, decisionId: string, optionId: string, text?: string): void {
    const run = this.runs.get(id);
    if (!run?.pending || run.pending.id !== decisionId) throw new Error(L('這個決定已經失效', 'This decision is no longer pending'));
    if (!run.pending.options.some((o) => o.id === optionId)) throw new Error(L('無效的選項', 'Invalid option'));
    this.decisionWaiters.get(id)?.({ optionId, text: text?.trim() || undefined });
  }

  delete(id: string): void {
    const run = this.runs.get(id);
    if (!run) return;
    if (run.status === 'running' || run.status === 'paused' || run.status === 'waiting_human') throw new Error(L('請先停止這個工作流', 'Stop this workflow first'));
    this.runs.delete(id);
    this.d.store.delete(id);
    this.d.push({ topic: 'workflows', data: this.summaries() });
  }

  events(workflowId: string, agentId: string): AgentEvent[] {
    return this.d.store.getEvents(workflowId, agentId);
  }

  /** Stop one agent. A role then goes to the usual "what next" question (no automatic failover); a sub-agent's parent is told. */
  stopAgent(workflowId: string, agentId: string): void {
    const run = this.runs.get(workflowId);
    const a = run?.agents[agentId];
    if (!run || !a) throw new Error(L('找不到這個 agent', 'Agent not found'));
    if (!['running', 'queued', 'paused'].includes(a.status)) return;
    this.stoppedByUser.add(a.id);
    this.pausedAgents.delete(a.id);
    this.agentAborts.get(a.id)?.abort();
    this.log(run, L(`你停止了 ${this.label(a)}`, `You stopped ${this.label(a)}`), 'warn', true);
    this.touch(run);
  }

  /** Hide a finished or stopped agent from the agent map (its records stay). */
  closeAgent(workflowId: string, agentId: string): void {
    const run = this.runs.get(workflowId);
    const a = run?.agents[agentId];
    if (!run || !a) throw new Error(L('找不到這個 agent', 'Agent not found'));
    if (['running', 'queued', 'paused'].includes(a.status)) throw new Error(L('請先停止這個 agent', 'Stop this agent first'));
    a.closed = true;
    this.touch(run);
  }

  /**
   * Providers a sub-agent's task can move to: signed in, other than the one it used, with whether their quota looks
   * spent (a recent usage-limit error, or the official quota reports the limit reached). Usable ones first.
   */
  switchTargets(workflowId: string, agentId: string): { id: string; name: string; quota: 'ok' | 'limited'; note?: string; model?: string }[] {
    const run = this.runs.get(workflowId);
    const a = run?.agents[agentId];
    if (!run || !a) throw new Error(L('找不到這個 agent', 'Agent not found'));
    const usage = this.d.usage.cachedSummary(this.d.registry.specs());
    const RECENT = 5 * 3600000;
    return this.d.registry
      .list()
      .filter((p) => p.installed && p.auth.state === 'logged_in' && p.spec.id !== a.provider)
      .map((p) => {
        const u = usage.find((x) => x.providerId === p.spec.id);
        const recent = u?.limitHit && Date.now() - u.limitHit.at < RECENT ? u.limitHit : undefined;
        const limited = !!recent || !!u?.official?.limitReached;
        const pinned = run.config.subagents.models?.[p.spec.id];
        return {
          id: p.spec.id,
          name: p.spec.name,
          quota: limited ? ('limited' as const) : ('ok' as const),
          note: recent ? L(`${Math.round((Date.now() - recent.at) / 60000)} 分鐘前碰到用量上限`, `hit a usage limit ${Math.round((Date.now() - recent.at) / 60000)} min ago`) : u?.official?.limitReached ? L('官方額度已用完', 'official quota used up') : undefined,
          model: pinned?.model || this.d.registry.defaults(p.spec.id).model,
        };
      })
      .sort((x, y) => (x.quota === y.quota ? 0 : x.quota === 'ok' ? -1 : 1));
  }

  /**
   * Run a sub-agent's task again (same task; same provider, or `provider` to move it to another one, e.g. when its quota
   * ran out); its parent is told the new id. A running role restarts its turn.
   */
  rerunAgent(workflowId: string, agentId: string, provider?: string): string {
    const run = this.runs.get(workflowId);
    const a = run?.agents[agentId];
    if (!run || !a) throw new Error(L('找不到這個 agent', 'Agent not found'));
    if (!['running', 'paused', 'waiting_human'].includes(run.status)) throw new Error(L('這段對話已經結束，請直接送出新訊息', 'This conversation has finished; send a new message instead'));
    if (a.role !== 'subagent') {
      if (a.status !== 'running') throw new Error(L('只有執行中的角色可以重跑', 'Only a running role can be re-run'));
      this.redispatch.add(a.id);
      this.agentAborts.get(a.id)?.abort();
      this.log(run, L(`你重新派發了 ${this.label(a)}`, `You re-dispatched ${this.label(a)}`), 'info', true);
      return a.id;
    }
    const parent = a.parentId ? run.agents[a.parentId] : undefined;
    if (!parent || !['running', 'paused', 'queued'].includes(parent.status)) throw new Error(L('它的上層 agent 已經結束，無法交回結果', 'Its parent has finished, so a re-run has nobody to report to'));
    if (['running', 'queued', 'paused'].includes(a.status)) this.stopAgent(workflowId, agentId);
    const spec = this.subSpecs.get(a.id) ?? { task: a.brief ?? a.task, mode: a.readonly ? ('readonly' as const) : ('write' as const) };
    const moved = !!provider && provider !== a.provider;
    if (moved && !this.d.registry.list().some((p) => p.spec.id === provider && p.installed && p.auth.state === 'logged_in')) throw new Error(L(`${this.providerName(provider!)} 沒有安裝或尚未登入`, `${this.providerName(provider!)} is not installed or not signed in`));
    // On another provider: that provider's model for sub-agents (or its default), not the old one's.
    const pinned = moved ? run.config.subagents.models?.[provider!] : undefined;
    const target = moved
      ? { provider: provider!, model: pinned?.model || this.d.registry.defaults(provider!).model, effort: pinned?.effort || this.d.registry.defaults(provider!).effort }
      : { provider: a.provider, model: a.model, effort: a.effort };
    const child = this.launchChild(run, parent, { ...target, task: spec.task, mode: spec.mode, rerunOf: a.id, title: a.title });
    if (moved) this.log(run, L(`你把 sub agent「${a.title ?? a.task.slice(0, 40)}」改由 ${this.providerName(provider!)} 重跑`, `You moved sub-agent "${a.title ?? a.task.slice(0, 40)}" to ${this.providerName(provider!)}`), 'info', true);
    this.notifyParent(run, child, `the user re-ran sub-agent ${a.id}${moved ? ` on another provider (${provider})` : ''} as ${child.id}; collect it with wait_subagent {subagent_id: "${child.id}"} (ignore ${a.id}).`);
    return child.id;
  }

  /** Search a run's records (the user's search box). */
  search(id: string, q: RecordQuery) {
    const run = this.runs.get(id);
    if (!run) throw new Error(L('找不到工作流', 'Workflow not found'));
    return searchRecords(run, (aid) => this.events(run.id, aid), q);
  }

  gpus() {
    return this.resources.gpus();
  }

  private gpuSeen?: { at: number; has: boolean };
  /** Whether this computer has an NVIDIA GPU (checked every 5 minutes): GPU tools are only offered when it does. */
  private hasGpu(): boolean {
    if (!this.gpuSeen || Date.now() - this.gpuSeen.at > 300000) this.gpuSeen = { at: Date.now(), has: this.resources.gpus().length > 0 };
    return this.gpuSeen.has;
  }

  /** The shared context as agents see it through read_context {} (for the user to look at). */
  sharedContext(id: string): string {
    const run = this.runs.get(id);
    if (!run) throw new Error(L('找不到工作流', 'Workflow not found'));
    return overview(run, (aid) => this.events(run.id, aid));
  }

  /**
   * Checks before a run starts (and the whole of a dry run): folders, providers signed in, models and efforts that
   * exist, tools, GPUs and disk, and that Aivenue can save the run to recover it.
   */
  async preflight(config: WorkflowConfig): Promise<PreflightItem[]> {
    const out: PreflightItem[] = [];
    const add = (level: PreflightItem['level'], area: PreflightItem['area'], message: string) => out.push({ level, area, message });
    if (config.assignment?.mode === 'auto' && !config.dryRun) config = this.applyAssignment(config, this.autoAssignment(config));
    // folders
    const writable = (d: string) => {
      try {
        fs.accessSync(d, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    };
    if (!config.cwd || !fs.existsSync(config.cwd) || !fs.statSync(config.cwd).isDirectory()) add('error', 'path', L(`工作資料夾不存在：${config.cwd}`, `Working folder does not exist: ${config.cwd}`));
    else if (!writable(config.cwd)) add('error', 'path', L(`工作資料夾不能寫入：${config.cwd}`, `Working folder is not writable: ${config.cwd}`));
    else add('ok', 'path', L(`工作資料夾可讀寫：${config.cwd}`, `Working folder is readable and writable: ${config.cwd}`));
    for (const d of config.extraDirs ?? []) if (!fs.existsSync(d)) add('error', 'path', L(`找不到額外資料夾：${d}`, `Extra folder not found: ${d}`));
    // providers, models, efforts
    const infos = this.d.registry.list();
    const roles: [string, RoleConfig | null | undefined][] = [];
    if (config.plan.enabled) roles.push([L('計畫撰寫', 'Planner'), config.plan.author], [L('計畫審查', 'Plan reviewer'), config.plan.reviewer]);
    if (config.implement.enabled) roles.push([L('實作', 'Implementer'), config.implement.author], [L('程式審查', 'Code reviewer'), config.implement.reviewer]);
    if (config.verify?.enabled) roles.push([L('目標驗收', 'Goal verifier'), config.verify.by === 'planner' ? (config.plan.enabled ? config.plan.author : config.implement.author) : config.verify.verifier]);
    if (config.advisor?.mode === 'cross' && config.advisor.provider) roles.push([L('顧問', 'Advisor'), { provider: config.advisor.provider, model: config.advisor.model }]);
    for (const [label, role] of roles) {
      if (!role) continue;
      const p = infos.find((x) => x.spec.id === role.provider);
      if (!p) {
        add('error', 'provider', L(`${label}：未知的供應商 ${role.provider}`, `${label}: unknown provider ${role.provider}`));
        continue;
      }
      if (!p.installed) add('error', 'provider', L(`${label}：${p.spec.name} 沒有安裝`, `${label}: ${p.spec.name} is not installed`));
      else if (p.auth.state !== 'logged_in') add('error', 'provider', L(`${label}：${p.spec.name} 尚未登入`, `${label}: ${p.spec.name} is not signed in`));
      else add('ok', 'provider', L(`${label}：${p.spec.name} 已就緒`, `${label}: ${p.spec.name} is ready`));
      const model = role.model || this.d.registry.defaults(role.provider).model;
      const effort = role.effort || this.d.registry.defaults(role.provider).effort;
      if (!model || !p.installed) continue;
      const models = await this.d.registry.listModels(role.provider).catch(() => [] as ModelInfo[]);
      const m = models.find((x) => x.id === model || x.id.endsWith(`/${model}`));
      if (models.length && !m) add('warn', 'model', L(`${label}：${p.spec.name} 的模型清單裡沒有「${model}」`, `${label}: "${model}" is not in ${p.spec.name}'s model list`));
      else if (m?.tools === false) add('warn', 'model', L(`${label}：模型 ${model} 不支援工具呼叫，Aivenue 的工具（交結果、sub agent、等待條件…）都不能用，只能用文字格式交結果`, `${label}: model ${model} cannot call tools, so Aivenue's tools (submitting, sub-agents, waits…) do not work; it can only answer in text`));
      else if (m?.reasoning === false && effort) add('warn', 'model', L(`${label}：模型 ${model} 不會思考，思考程度「${effort}」不會有作用`, `${label}: model ${model} does not think, so effort "${effort}" has no effect`));
      else if (m && effort && m.efforts?.length && !m.efforts.includes(effort)) add('warn', 'model', L(`${label}：模型 ${model} 不支援思考程度「${effort}」（支援：${m.efforts.join('、')}）`, `${label}: model ${model} does not take effort "${effort}" (it takes: ${m.efforts.join(', ')})`));
    }
    if (config.verify?.enabled && !config.plan.enabled) add('warn', 'model', L('目標驗收已開啟但沒有計畫階段：驗收者會自己從任務推導驗收指標', 'Goal verification is on without a planning stage: the verifier derives the metrics from the task'));
    // tools
    const git = await capture('git', ['--version'], { timeoutMs: 10000 }).catch(() => undefined);
    if (git?.code === 0) add('ok', 'tool', `git ${/(\d+\.\d+\.\d+)/.exec(git.stdout)?.[1] ?? ''}`.trim());
    else add('warn', 'tool', L('找不到 git：變更摘要會改用 agent 的檔案紀錄，證據不含 commit', 'git not found: change summaries use the agents\' file records and evidence has no commit'));
    // resources
    const gpus = this.resources.gpus();
    if (gpus.length) add('ok', 'resource', L(`GPU：${gpus.length} 張，${gpus.filter((g) => !g.lockedBy && g.memUsedMB <= 1024).length} 張空閒`, `GPU: ${gpus.length}, ${gpus.filter((g) => !g.lockedBy && g.memUsedMB <= 1024).length} free`));
    else add('ok', 'resource', L('沒有偵測到 NVIDIA GPU（不需要 GPU 的任務不受影響）', 'No NVIDIA GPU detected (tasks that need none are not affected)'));
    try {
      const st = fs.statfsSync(config.cwd);
      const freeGB = (st.bavail * st.bsize) / 1024 ** 3;
      add(freeGB < 2 ? 'warn' : 'ok', 'resource', L(`磁碟剩餘 ${freeGB.toFixed(1)} GB`, `${freeGB.toFixed(1)} GB free on disk`));
    } catch {
      // unknown
    }
    // recovery
    if (writable(this.d.dataDir)) add('ok', 'recovery', L('工作流狀態即時存檔：中斷後可在同一段對話接續，已核准的對外動作不會重做', 'The run is saved as it goes: after an interruption it continues in the same conversation, and approved external actions are not repeated'));
    else add('error', 'recovery', L(`Aivenue 資料夾不能寫入：${this.d.dataDir}`, `Aivenue's data folder is not writable: ${this.d.dataDir}`));
    if (config.limits?.enabled) {
      const l = config.limits;
      add('ok', 'recovery', L(`執行限制：${[l.maxMinutes && `${l.maxMinutes} 分鐘`, l.maxCostUsd && `$${l.maxCostUsd}`, l.maxCycles && `${l.maxCycles} 次循環`, l.noProgressMinutes && `${l.noProgressMinutes} 分鐘沒進展就詢問`].filter(Boolean).join('、') || '未設定數值'}`, `Limits: ${[l.maxMinutes && `${l.maxMinutes} min`, l.maxCostUsd && `$${l.maxCostUsd}`, l.maxCycles && `${l.maxCycles} cycles`, l.noProgressMinutes && `ask after ${l.noProgressMinutes} min without progress`].filter(Boolean).join(', ') || 'no values set'}`));
    }
    return out;
  }

  /** Dry run: the checks, a save-and-reload of the run, and the routes the controller would take. Runs no agent. */
  private dryRun(run: WorkflowRun) {
    run.dryRun = true;
    this.d.store.saveNow(run);
    const back = this.d.store.loadAll().find((r) => r.id === run.id);
    (run.preflight ??= []).push(back ? { level: 'ok', area: 'recovery', message: L('存檔後可重新載入（中斷可恢復）', 'Saved and reloaded (an interruption can be recovered)') } : { level: 'error', area: 'recovery', message: L('存檔後無法重新載入', 'The run could not be reloaded after saving') });
    const stages = [run.config.plan.enabled && L('計畫 → 計畫審查', 'plan → plan review'), run.config.implement.enabled && L('實作 → 程式審查', 'implement → code review'), run.config.verify?.enabled && L(`目標驗收（${run.config.verify.by === 'planner' ? '計畫者' : '獨立驗收者'}）`, `goal verification (${run.config.verify.by === 'planner' ? 'planner' : 'independent'})`)].filter(Boolean);
    this.log(run, L(`試跑：流程 ${stages.join(' → ')}`, `Dry run: ${stages.join(' → ')}`), 'info', true);
    if (run.config.verify?.enabled) {
      const m = [{ id: 'M1', value: '-', met: false, evidence: '-' }];
      const sims: [string, Verification][] = [
        ['met', { outcome: 'met', summary: '', metrics: [{ ...m[0], met: true }], issues: [] }],
        ['defect', { outcome: 'defect', summary: '', metrics: m, issues: [{ id: 'V1', severity: 'major', title: 'x' }] }],
        ['invalid_evidence', { outcome: 'invalid_evidence', summary: '', metrics: m, issues: [{ id: 'V1', severity: 'major', title: 'x' }] }],
        ['not_met', { outcome: 'not_met', summary: '', metrics: m, issues: [] }],
      ];
      for (const [name, v] of sims) this.log(run, L(`試跑：驗收結果「${outcomeLabel(v.outcome)}」→ ${routeName(routeVerification(v, []).to)}`, `Dry run: verification ${name} → ${routeName(routeVerification(v, []).to)}`), 'info', true);
    }
    const errors = (run.preflight ?? []).filter((p) => p.level === 'error').length;
    run.status = errors ? 'failed' : 'completed';
    if (errors) run.error = L(`試跑發現 ${errors} 個問題`, `The dry run found ${errors} problem(s)`);
    this.log(run, errors ? L(`試跑結束：${errors} 個問題要先處理（沒有執行任何 agent）`, `Dry run finished: ${errors} problem(s) to fix first (no agent was run)`) : L('試跑結束：一切就緒（沒有執行任何 agent）', 'Dry run finished: everything is ready (no agent was run)'), errors ? 'warn' : 'info', true);
  }

  /** A traceable bundle of a run: settings, every agent's records, notes, reviews and verifications; secrets masked. */
  exportRun(id: string, mask = true): { path: string; bytes: number; masked: number } {
    const run = this.runs.get(id);
    if (!run) throw new Error(L('找不到工作流', 'Workflow not found'));
    return exportBundle(this.d.dataDir, run, (aid) => this.events(run.id, aid), mask);
  }

  /** Write the run's verified rules (facts, decisions, rulings, how the goal was measured) into the project's Skill. */
  distilSkill(id: string): { path: string; added: number } {
    const run = this.runs.get(id);
    if (!run) throw new Error(L('找不到工作流', 'Workflow not found'));
    return distilProjectSkill(run.worktree?.origCwd ?? run.config.cwd, run);
  }

  // ---------- MCP bridge entry points ----------

  /** Shared servers a bridge should proxy for this session (empty when the CLI got them natively). */
  proxyServersFor(secret: string): ResolvedMcpServer[] {
    return this.sessions.get(secret)?.proxyServers ?? [];
  }

  toolsFor(secret: string): ToolDef[] {
    const s = this.sessions.get(secret);
    if (!s) return [];
    if (s.onTestCall) return toolsForRole('test', false);
    const run = this.runs.get(s.workflowId);
    const info = run?.agents[s.agentId];
    if (!run || !info) return [];
    const tools = toolsForRole(info.role, this.canSpawn(run, info), sharingOf(run) !== 'summary', this.crossAdvisor(run), this.hasGpu());
    return s.permission === 'ask' ? [...tools, TOOL_DEFS.approval_prompt] : tools;
  }

  private approvalWaiters = new Map<string, (d: { allow: boolean; always?: boolean; message?: string }) => void>();
  private allowAlways = new Map<string, Set<string>>();

  /** Ask the user to approve one tool call ("ask" permission level). Resolves when they decide or the run stops. */
  private requestApproval(run: WorkflowRun, info: AgentRunInfo, tool: string, input: unknown): Promise<{ allow: boolean; message?: string }> {
    // Aivenue's own tools and anything the user already allowed for this run go through.
    const key = alwaysKey(tool, input);
    if (/^mcp__aivenue__/.test(tool) || this.allowAlways.get(run.id)?.has(key)) return Promise.resolve({ allow: true });
    if (tool === 'external_action') {
      // "Allow and continue": the action the user approved after denying it goes through once, without asking again.
      const kind = (input as { command?: string })?.command;
      const left = run.config.preApproved ?? [];
      const i = left.findIndex((p) => p.kind === kind);
      if (i >= 0) {
        const [p] = left.splice(i, 1);
        this.log(run, L(`依你的「改成允許並繼續」執行：${externalLabel(input).title}`, `Done as you allowed afterwards: ${externalLabel(input).title}`), 'info', true);
        this.touch(run);
        return Promise.resolve({ allow: true, message: L(`使用者先前允許的動作：${p.details.slice(0, 300)}`, `The action the user allowed: ${p.details.slice(0, 300)}`) });
      }
    }
    const c = tool === 'external_action' ? externalLabel(input) : classifyTool(tool, input, run.config.cwd);
    const req: ApprovalRequest = { id: randomUUID().slice(0, 8), agentId: info.id, provider: info.provider, tool: c.name, summary: c.title, input: JSON.stringify(input ?? {}, null, 2).slice(0, 4000), ts: now() };
    run.approvals = [...(run.approvals ?? []), req];
    this.touch(run);
    const wf = this.aborts.get(run.id);
    return new Promise((resolve) => {
      const done = (d: { allow: boolean; always?: boolean; message?: string }) => {
        wf?.signal.removeEventListener('abort', onAbort);
        this.approvalWaiters.delete(req.id);
        run.approvals = (run.approvals ?? []).filter((a) => a.id !== req.id);
        if (d.allow && d.always) {
          const set = this.allowAlways.get(run.id) ?? new Set<string>();
          set.add(key);
          this.allowAlways.set(run.id, set);
        }
        this.log(run, d.allow ? L(`你允許了：${c.name} ${c.title}`, `You allowed: ${c.name} ${c.title}`) : L(`你拒絕了：${c.name} ${c.title}`, `You denied: ${c.name} ${c.title}`), d.allow ? 'info' : 'warn');
        this.touch(run);
        resolve(d);
      };
      const onAbort = () => done({ allow: false, message: 'The workflow was stopped.' });
      wf?.signal.addEventListener('abort', onAbort, { once: true });
      this.approvalWaiters.set(req.id, done);
    });
  }

  approve(runId: string, approvalId: string, decision: 'allow' | 'always' | 'deny', message?: string): void {
    const fn = this.approvalWaiters.get(approvalId);
    if (!fn) throw new Error(L('這個核准請求已經失效', 'This approval request is no longer pending'));
    fn({ allow: decision !== 'deny', always: decision === 'always', message: message?.trim() || undefined });
  }

  async callTool(secret: string, name: string, args: Record<string, unknown>): Promise<string> {
    const s = this.sessions.get(secret);
    if (!s) throw new Error('Aivenue session expired');
    if (s.onTestCall) {
      s.onTestCall();
      return JSON.stringify(this.d.registry.list().map((p) => ({ id: p.spec.id, name: p.spec.name, installed: p.installed })));
    }
    const run = this.runs.get(s.workflowId);
    const info = run?.agents[s.agentId];
    if (!run || !info) throw new Error('Aivenue session not found');
    // A CLI kept running after its turn (or a leftover background process) can't act on a finished conversation.
    if (!['running', 'paused', 'waiting_human'].includes(run.status) || !['running', 'queued', 'paused'].includes(info.status)) throw new Error('This agent turn has ended; Aivenue tools are no longer available to it');
    if (!this.toolsFor(secret).some((t) => t.name === name)) throw new Error(`Tool ${name} is not available to the ${info.role} role`);
    const text = await this.runTool(run, info, name, args);
    // Notices about its sub-agents ride along with the parent's next tool result.
    const notes = this.inbox.get(info.id);
    if (!notes?.length) return text;
    this.inbox.delete(info.id);
    return `${text}\n\nAIVENUE NOTICE (about your sub-agents; decide: retry it, adjust its task, replace it with another provider, or do it yourself):\n${notes.map((n) => `- ${n}`).join('\n')}`;
  }

  private async runTool(run: WorkflowRun, info: AgentRunInfo, name: string, args: Record<string, unknown>): Promise<string> {
    const sub = this.submissions.get(info.id) ?? {};
    this.submissions.set(info.id, sub);
    if (name.startsWith('submit_')) {
      this.requireChildrenSettled(run, info);
      run.lastProgressAt = now();
    }
    switch (name) {
      case 'submit_plan': {
        const p = parsePlan(args);
        if (!p) throw new Error('Invalid plan: provide summary, markdown and steps[]');
        if (run.config.verify?.enabled && !p.plan.goal?.metrics.length) throw new Error('Goal verification is on: include goal {statement, metrics: [{id, name, target, how}]} with measurable acceptance metrics.');
        sub.plan = p;
        return 'Plan received by Aivenue. You can finish your turn now.';
      }
      case 'submit_review': {
        const r = parseReview(args);
        if (!r) throw new Error('Invalid review: verdict must be "approve" or "revise"');
        sub.review = r;
        return 'Review received by Aivenue. You can finish your turn now.';
      }
      case 'submit_work': {
        const w = parseWork(args);
        if (!w) throw new Error('Invalid submission: provide summary');
        sub.work = w;
        return 'Work received by Aivenue. You can finish your turn now.';
      }
      case 'submit_verification': {
        const v = parseVerification(args);
        if (!v) throw new Error('Invalid verification: outcome must be met, not_met, invalid_evidence or defect');
        if (!v.metrics.length) throw new Error('List every acceptance metric you measured (id, value, met, evidence).');
        sub.verification = v;
        return 'Verification received by Aivenue; it decides who works next. You can finish your turn now.';
      }
      case 'submit_ruling': {
        const r = parseRulings(args);
        if (!r?.length) throw new Error('Give one ruling per disputed issue: {issue_id, ruling: "uphold"|"dismiss", reason}');
        sub.rulings = r;
        return 'Ruling received by Aivenue. You can finish your turn now.';
      }
      case 'search_records': {
        const str = (k: string) => (typeof args[k] === 'string' && (args[k] as string).trim() ? (args[k] as string).trim().slice(0, 300) : undefined);
        const q: RecordQuery = { q: str('q'), role: str('role'), agentId: str('agent_id'), stage: str('stage'), round: Number(args.round) || undefined, file: str('file'), issueId: str('issue_id'), limit: Number(args.limit) || undefined };
        const hits = searchRecords(run, (id) => this.events(run.id, id), q);
        return hits.length ? JSON.stringify(hits) : 'No matching records.';
      }
      case 'report_skill_use': {
        const u = parseSkillUse(args);
        if (!u) throw new Error('name is required');
        const list = (info.skillUses ??= []);
        const same = list.findIndex((x) => x.name === u.name);
        if (same >= 0) list[same] = { ...list[same], ...Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined)), ts: now() };
        else if (list.length < 50) list.push({ ...u, ts: now() });
        this.touch(run);
        return u.verified ? 'Recorded as applied and verified.' : 'Recorded as applied. Report again with verified=true once you checked it.';
      }
      case 'wait_for':
        return this.waitFor(run, info, args);
      case 'gpu_status':
        return JSON.stringify(this.resources.gpus());
      case 'gpu_acquire': {
        const count = Math.min(16, Math.max(1, Math.round(Number(args.count) || 1)));
        if (!this.resources.gpus().length) throw new Error('No NVIDIA GPU found (nvidia-smi is not available).');
        const got = this.resources.acquire({ workflowId: run.id, agentId: info.id }, count, { maxUsedMB: Number(args.max_used_mb) || undefined });
        if (!got) return JSON.stringify({ status: 'busy', hint: 'Not enough free GPUs right now. Use wait_for {check, gpus} to wait for them.', gpus: this.resources.gpus() });
        this.noteGpus(run, info, got);
        return JSON.stringify({ status: 'locked', gpus: got, hint: `Run your job with CUDA_VISIBLE_DEVICES=${got.join(',')}. Call gpu_release when it is done.` });
      }
      case 'gpu_release': {
        const freed = this.resources.release(run.id, info.id);
        run.gpuLocks = (run.gpuLocks ?? []).filter((l) => l.agentId !== info.id);
        this.touch(run);
        return freed.length ? `Released GPU ${freed.join(', ')}.` : 'You held no GPU.';
      }
      case 'track_process': {
        const pid = Math.round(Number(args.pid));
        if (!pid || pid <= 0) throw new Error('pid must be a process id');
        const cleanup = ['aivenue', 'agent', 'keep'].includes(String(args.cleanup)) ? (String(args.cleanup) as 'aivenue') : 'agent';
        const list = (run.processes ??= []).filter((p) => p.pid !== pid);
        if (list.length >= 50) throw new Error('At most 50 tracked processes');
        list.push({ pid, purpose: String(args.purpose ?? '').slice(0, 200), cleanup, agentId: info.id, startedAt: now(), alive: pidAlive(pid), checkedAt: now() });
        run.processes = list;
        this.touch(run);
        return pidAlive(pid) ? `Tracking process ${pid}.` : `Process ${pid} is not running (registered anyway).`;
      }
      case 'stop_subagent': {
        const id = String(args.subagent_id ?? '');
        const child = run.agents[id];
        if (!child || child.parentId !== info.id) throw new Error(`${id} is not one of your sub-agents`);
        if (typeof args.handoff === 'string' && args.handoff.trim()) {
          child.handoff = args.handoff.trim().slice(0, 300);
          this.touch(run);
          return `${id} keeps running after your turn; hand-off noted.`;
        }
        if (child.status === 'running' || child.status === 'queued' || child.status === 'paused') {
          this.stoppedByUser.add(id);
          this.agentAborts.get(id)?.abort();
        }
        return `Stopped ${id}.`;
      }
      case 'report_progress': {
        const stepId = String(args.step_id ?? '').trim();
        const status = ['in_progress', 'done', 'blocked', 'skipped'].includes(String(args.status)) ? (String(args.status) as 'in_progress') : 'in_progress';
        const note = args.note ? String(args.note).slice(0, 500) : undefined;
        let step = run.steps.find((st) => st.id === stepId.slice(0, 40));
        if (!step) {
          if (run.steps.length >= 100) throw new Error('Too many steps; update existing step ids instead');
          step = { id: stepId.slice(0, 40) || String(run.steps.length + 1), title: note ?? `${L('步驟', 'Step')} ${stepId}`, status: 'pending' };
          run.steps.push(step);
        }
        step.status = status;
        if (note) step.note = note;
        this.touch(run);
        return 'ok';
      }
      case 'list_providers':
        return JSON.stringify(this.spawnable(run));
      case 'approval_prompt': {
        // Claude Code's --permission-prompt-tool contract.
        const d = await this.requestApproval(run, info, String(args.tool_name ?? 'tool'), args.input);
        return JSON.stringify(d.allow ? { behavior: 'allow', updatedInput: args.input ?? {} } : { behavior: 'deny', message: d.message ?? 'The user denied this action.' });
      }
      case 'read_context': {
        const id = String(args.agent_id ?? '').trim();
        if (!id) return overview(run, (aid) => this.events(run.id, aid));
        if (id === 'notes') return allNotes(run);
        const target = run.agents[id] ?? Object.values(run.agents).find((a) => a.id.startsWith(id));
        if (!target) throw new Error(`Unknown agent_id ${id}. Call read_context {} to list agents.`);
        return `TRANSCRIPT OF ${agentLabel(target)} [${target.status}]\n\n${formatTranscript(this.events(run.id, target.id), { budget: 40000, prompts: args.include_prompts === true })}`;
      }
      case 'post_note': {
        const text = String(args.text ?? '').trim().slice(0, 2000);
        if (!text) throw new Error('text is required');
        if ((run.notes?.length ?? 0) >= 200) throw new Error('This conversation already has 200 shared notes, the limit');
        const kind = ['fact', 'inference', 'decision'].includes(String(args.kind)) ? (String(args.kind) as 'fact') : 'inference';
        (run.notes ??= []).push({ id: randomUUID().slice(0, 8), agentId: info.id, text, kind, ts: now() });
        this.refreshShared(run);
        this.touch(run);
        return 'Note shared with all later agents.';
      }
      case 'ask_advisor':
        return this.askAdvisor(run, info, args);
      case 'confirm_external_action': {
        // Always asked, whatever the permission level: pushes, PRs and comments are visible to others and hard to take back.
        const kind = normalizeKind(String(args.kind ?? 'other'));
        const input = { command: kind, target: String(args.target ?? '').slice(0, 300), details: String(args.details ?? '').slice(0, 4000) };
        // A resumed or repeated turn must not push, publish or comment twice.
        const done = run.sideEffects?.find((e) => e.kind === kind && e.target === input.target && e.details === input.details);
        if (done) return `already done earlier in this workflow (${new Date(done.ts).toISOString()}): do not do it again.`;
        const d = await this.requestApproval(run, info, 'external_action', input);
        if (d.allow) {
          (run.sideEffects ??= []).push({ kind, target: input.target, details: input.details, agentId: info.id, ts: now() });
          this.touch(run);
        }
        if (!d.allow && !this.aborted(run)) {
          (run.deniedActions ??= []).push({ id: randomUUID().slice(0, 8), agentId: info.id, kind: input.command, target: input.target, details: input.details, note: d.message, ts: now() });
          this.touch(run);
        }
        return d.allow
          ? `approved${d.message ? ` — the user added: ${d.message}` : ''}. Go ahead with exactly what you described.`
          : `denied${d.message ? `: ${d.message}` : ''}. Do not do it (nor a variant of it); say in your report that it was skipped.`;
      }
      case 'capture_screenshot':
        return this.screenshot(run, info, args);
      case 'spawn_subagent':
        return this.spawnSubagent(run, info, args);
      case 'wait_subagent':
        return this.waitSubagent(run, args);
    }
    throw new Error(`Unknown tool ${name}`);
  }

  // ---------- provider connectivity test ----------

  testProvider(providerId: string): string {
    const spec = this.d.registry.get(providerId);
    if (!spec) throw new Error(L(`未知的供應商：${providerId}`, `Unknown provider: ${providerId}`));
    const testId = 'test-' + randomUUID().slice(0, 8);
    const dir = path.join(this.d.dataDir, 'tmp', testId);
    fs.mkdirSync(dir, { recursive: true });
    let mcpCalled = false;
    const secret = randomUUID();
    this.sessions.set(secret, { workflowId: testId, agentId: 'test', onTestCall: () => (mcpCalled = true) });
    const started = now();
    this.d.usage.recordRun(providerId, this.d.registry.defaults(providerId).model);
    void Promise.all([this.d.registry.runAuth(providerId), this.d.capabilities.serversFor(providerId)])
      .then(([auth, mcpServers]) => {
        if (spec.mcpRegistration) this.sessions.get(secret)!.proxyServers = mcpServers;
        const def = this.d.registry.defaults(providerId);
        return runAgent({
          spec,
          mcpServers,
          model: def.model,
          effort: def.effort,
          prompt:
            'This is a connectivity test from Aivenue. If an MCP tool named `list_providers` (server "aivenue") is available, call it once. Then reply with exactly: AIVENUE_OK',
          cwd: dir,
          mode: 'readonly',
          bridge: this.bridgeLaunch(secret),
          tmpDir: path.join(this.d.dataDir, 'tmp'),
          signal: AbortSignal.timeout(240000),
          auth,
          onEvent: (event, isUpdate) => {
            this.trackUsage(providerId, event, isUpdate, this.d.registry.defaults(providerId).model);
            this.d.push({ topic: 'test', data: { testId, providerId, event, isUpdate } });
          },
        });
      })
      .then((res) => {
        const ok = /AIVENUE_OK/.test(res.finalText);
        const result: TestResult = {
          ok: !res.error && ok,
          finalText: res.finalText,
          error: res.error ?? (ok ? undefined : L('回覆內容不符合預期', 'Unexpected reply')),
          mcpCalled,
          durationMs: now() - started,
        };
        this.d.push({ topic: 'test', data: { testId, providerId, result } });
      })
      .catch((e) => this.d.push({ topic: 'test', data: { testId, providerId, result: { ok: false, finalText: '', error: String(e?.message ?? e), mcpCalled, durationMs: now() - started } } }))
      .finally(() => {
        this.sessions.delete(secret);
        fs.rm(dir, { recursive: true, force: true }, () => undefined);
      });
    return testId;
  }

  // ---------- workflow execution ----------

  private baselines = new Map<string, Snapshot>();
  /** CLIs kept running between turns of a session, closed after 5 idle minutes. */
  private pool = new CliPool();
  /** Model each agent was started with (agent.model later shows what the CLI reports it actually uses). */
  private requestedModel = new Map<string, string | undefined>();

  /** Close every CLI kept running for later turns (app shutdown). */
  shutdown() {
    this.pool.closeAll();
  }

  /** Recompute what changed in the working folder since the run started. */
  private updateOutputs(run: WorkflowRun) {
    const base = this.baselines.get(run.id);
    if (!base) return;
    const now = snapshot(run.config.cwd);
    run.outputs = diffSnapshots(run.config.cwd, base, now);
    run.outputsTruncated = base.truncated || now.truncated;
    this.touch(run);
  }

  /** True when the path is a file some run produced (so the UI may preview / open it). */
  isOutputFile(abs: string): boolean {
    const p = path.resolve(abs);
    for (const r of this.runs.values()) {
      if (r.outputs?.some((o) => o.status !== 'deleted' && path.resolve(o.abs) === p)) return true;
      if (r.screenshots?.some((s) => path.resolve(s.path) === p)) return true;
    }
    return false;
  }

  /** `capture_screenshot`: render a page headlessly into <cwd>/.aivenue/screenshots and show it in the conversation. */
  private async screenshot(run: WorkflowRun, info: AgentRunInfo, args: Record<string, unknown>): Promise<string> {
    const target = String(args.target ?? '').trim();
    if (!target) throw new Error('target is required');
    const cwd = run.config.cwd;
    // Other hosts than this machine: not from a read-only plan, and only with the user's OK in manual approval.
    if (!isLoopbackUrl(resolveTarget(target, cwd, run.config.extraDirs))) {
      const level = run.config.permission ?? 'auto';
      if (level === 'plan') throw new Error('In plan (read-only) mode only local pages and files in the working folder can be captured.');
      if (level === 'ask') {
        const d = await this.requestApproval(run, info, 'capture_screenshot', { target });
        if (!d.allow) throw new Error(d.message ?? 'The user denied this screenshot.');
      }
    }
    const aivenueDir = path.join(cwd, '.aivenue');
    if (fs.existsSync(aivenueDir) && fs.lstatSync(aivenueDir).isSymbolicLink()) throw new Error('.aivenue in the working folder is a link; refusing to write screenshots through it');
    const dir = path.join(cwd, '.aivenue', 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    // Keep screenshots out of the user's git history.
    const ignore = path.join(cwd, '.aivenue', '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
    const base = String(args.name ?? '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'screenshot';
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    const shot = await captureScreenshot({
      target,
      extraRoots: run.config.extraDirs,
      cwd,
      out: path.join(dir, `${base}-${stamp}.png`),
      width: Number(args.width) || undefined,
      height: Number(args.height) || undefined,
      fullPage: args.full_page === true || args.full_page === 'true',
      waitMs: args.wait_ms === undefined ? undefined : Number(args.wait_ms),
      signal: this.agentAborts.get(info.id)?.signal,
    });
    // The conversation keeps its own copy: the working folder may be a temporary worktree or get cleaned up.
    const keep = path.join(this.d.dataDir, 'runs', run.id, 'screenshots', path.basename(shot.path));
    fs.mkdirSync(path.dirname(keep), { recursive: true });
    fs.copyFileSync(shot.path, keep);
    (run.screenshots ??= []).push({ path: keep, url: shot.url, agentId: info.id, width: shot.width, height: shot.height, ts: now() });
    this.log(run, L(`${this.label(info)} 拍了一張截圖：${target}`, `${this.label(info)} took a screenshot: ${target}`));
    this.touch(run);
    return JSON.stringify({ saved: shot.path, url: shot.url, viewport: `${shot.width}x${shot.height}`, note: 'The user can see this screenshot. Open the PNG with your image/file reading tool if you need to inspect it yourself.' });
  }

  /** Text preview of a produced file (first 200 KB). */
  readOutput(abs: string): { text: string; truncated: boolean } {
    if (!this.isOutputFile(abs)) throw new Error('not an output of any run');
    const buf = fs.readFileSync(abs);
    const head = buf.subarray(0, 200 * 1024);
    if (head.includes(0)) throw new Error(L('這是二進位檔，無法預覽', 'Binary file, no preview'));
    return { text: head.toString('utf8'), truncated: buf.length > head.length };
  }

  /** Apply / keep / discard the result of an isolated (worktree) run. */
  async worktreeAction(id: string, action: 'apply' | 'discard' | 'keep'): Promise<string> {
    const run = this.runs.get(id);
    const wt = run?.worktree;
    if (!run || !wt) throw new Error(L('這個工作流沒有使用隔離模式', 'This workflow does not use isolation'));
    if (run.status === 'running' || run.status === 'paused' || run.status === 'waiting_human') throw new Error(L('請等工作流結束或先停止它', 'Wait for the workflow to finish or stop it first'));
    if (wt.state !== 'active') throw new Error(L('這個隔離副本已經處理過了', 'This isolated copy was already handled'));
    const w = { cwd: wt.cwd, path: wt.path, branch: wt.branch, baseCommit: wt.baseCommit, repo: wt.repo };
    // CLIs kept running for this conversation still have the copy open (Windows then refuses to delete it).
    await this.pool.closeSessions(Object.values(run.agents).flatMap((a) => (a.sessionId ? [a.sessionId] : [])));
    const note = action === 'apply' ? await applyWorktree(w) : action === 'keep' ? await keepWorktree(w) : (await removeWorktree(w), L('已捨棄隔離副本', 'Isolated copy discarded'));
    run.worktree = { ...wt, state: action === 'apply' ? 'applied' : action === 'keep' ? 'kept' : 'discarded', note };
    // Follow-ups and "open folder" now point back at the user's project.
    run.config.cwd = wt.origCwd;
    this.log(run, note, 'info', true);
    this.touch(run);
    return note;
  }

  private async execute(run: WorkflowRun) {
    // Git config as it was before any agent ran; describeChanges only runs git while it is unchanged.
    this.gitStamps.set(run.id, gitStamp(run.config.cwd));
    if (run.config.isolation === 'worktree' && !run.worktree) {
      try {
        const wt = await createWorktree(run.config.cwd, this.d.dataDir, run.id);
        run.worktree = { path: wt.path, branch: wt.branch, baseCommit: wt.baseCommit, repo: wt.repo, origCwd: run.config.cwd, cwd: wt.cwd, state: 'active' };
        run.config.cwd = wt.cwd;
        this.gitStamps.set(run.id, gitStamp(wt.cwd));
        this.log(run, L(`隔離模式：agent 在獨立的副本（分支 ${wt.branch}）中工作，完成後由你決定是否套用`, `Isolation: agents work in a separate copy (branch ${wt.branch}); you decide whether to apply it afterwards`), 'info', true);
      } catch (e) {
        run.status = 'failed';
        run.error = (e as Error).message;
        run.endedAt = now();
        this.aborts.delete(run.id);
        this.log(run, run.error, 'error', true);
        this.touch(run);
        this.d.store.saveNow(run);
        return;
      }
    }
    this.baselines.set(run.id, snapshot(run.config.cwd));
    try {
      if (run.config.attachments?.length) {
        const { attachments, warnings } = await this.d.attachments.prepare(run.config.attachments);
        run.config.attachments = attachments;
        const converted = attachments.filter((a) => a.companion).map((a) => a.name);
        if (converted.length) this.log(run, L(`已將 ${converted.join('、')} 轉成 agent 可讀的格式`, `Converted ${converted.join(', ')} into agent-readable form`), 'info', true);
        for (const w of warnings) this.log(run, w, 'warn', true);
        this.touch(run);
      }
      run.preflight = await this.preflight(run.config);
      for (const p of run.preflight.filter((x) => x.level !== 'ok')) this.log(run, `${L('預檢', 'Preflight')}：${p.message}`, p.level === 'error' ? 'error' : 'warn', true);
      if (run.config.dryRun) {
        this.dryRun(run);
        return;
      }
      this.startWatchdog(run);
      await this.cycle(run);
      run.status = 'completed';
      this.log(run, run.config.verify?.enabled ? L('工作流完成 ✅ 目標驗收通過', 'Workflow completed ✅ goal verified') : L('工作流完成 ✅', 'Workflow completed ✅'), 'info', true);
    } catch (e) {
      const why = e instanceof Incomplete ? e.message : this.incompleteWhy.get(run.id);
      const cancelled = !why && (e instanceof Cancelled || this.aborts.get(run.id)?.signal.aborted);
      run.status = why ? 'incomplete' : cancelled ? 'cancelled' : 'failed';
      if (why) run.incompleteReason = why;
      else if (!cancelled) run.error = (e as Error).message;
      this.log(
        run,
        why
          ? L(`工作流未完成：${why}。目標沒有達成，不算完成。`, `Workflow incomplete: ${why}. The goal was not met, so it is not done.`)
          : cancelled
            ? L('工作流已取消', 'Workflow cancelled')
            : L(`工作流失敗：${(e as Error).message}`, `Workflow failed: ${(e as Error).message}`),
        cancelled || why ? 'warn' : 'error',
        true,
      );
      for (const st of Object.values(run.stages)) if (st && (st.status === 'running' || st.status === 'pending')) st.status = cancelled || why ? 'cancelled' : 'failed';
      for (const a of Object.values(run.agents)) {
        if (a.status === 'running' || a.status === 'queued') {
          this.agentAborts.get(a.id)?.abort();
          a.status = 'cancelled';
          a.endedAt ??= now();
        }
      }
    } finally {
      this.endRunResources(run);
      this.updateOutputs(run);
      this.baselines.delete(run.id);
      run.pending = undefined;
      run.endedAt = now();
      this.aborts.delete(run.id);
      this.touch(run);
      this.d.store.saveNow(run);
      setTimeout(() => this.d.store.release(run.id), 60000);
    }
  }

  /**
   * plan → implement (with code review) → goal verification, until the goal is met. The controller routes on the
   * structured results: defects and bad evidence go back to the implementer, a missed goal (or the same problem
   * surviving several fixes) back to the planner. Without goal verification it is plan → implement, as before.
   */
  private async cycle(run: WorkflowRun) {
    let planEntry: Entry | undefined;
    let implEntry: Entry | undefined;
    for (let first = true; ; first = false) {
      if (first || planEntry) {
        await this.runStage(run, 'plan', planEntry);
        if (planEntry) implEntry = { prompt: () => P.implementRevisedPrompt(run.plan) };
        planEntry = undefined;
      }
      const impl = await this.runStage(run, 'implement', implEntry);
      implEntry = undefined;
      if (impl.replan) {
        this.nextCycle(run);
        planEntry = { prompt: () => P.replanPrompt(run.config, impl.replan!.why, impl.replan!.detail, true) };
        continue;
      }
      const vcfg = run.config.verify;
      if (!vcfg?.enabled) return;
      const { route, verification } = await this.runVerify(run, vcfg);
      const next = nextPhase(route, run.config.plan.enabled);
      if (next === 'done') return;
      this.nextCycle(run);
      if (next === 'plan') {
        planEntry = { prompt: () => P.replanPrompt(run.config, route.reason, P.verificationText(verification), !!route.rediagnose) };
      } else {
        // No planning stage: the implementer also changes the approach.
        const r = route.to === 'planner' ? { ...route, reason: `${route.reason} (there is no planning stage: change the approach yourself)` } : route;
        implEntry = { prompt: () => P.verifyFixPrompt(verification, r) };
      }
    }
  }

  /** One more fix / re-plan cycle; stops the run as incomplete when a limit is reached. */
  private nextCycle(run: WorkflowRun) {
    run.cycles = (run.cycles ?? 0) + 1;
    const hit = limitHit(run.config.limits, { startedAt: run.createdAt, now: now(), costUsd: this.runCost(run), cycles: run.cycles });
    if (hit) throw new Incomplete(hit);
    this.touch(run);
  }

  private runCost(run: WorkflowRun): number {
    return Object.values(run.agents).reduce((sum, a) => sum + (a.costUsd ?? 0), 0);
  }

  /** Goal verification: the planner or an independent verifier measures every metric; the router decides what is next. */
  private async runVerify(run: WorkflowRun, vcfg: VerifyConfig): Promise<{ route: RouteDecision; verification: Verification }> {
    const stage = (run.stages.verify ??= { key: 'verify', status: 'pending', rounds: [], roundLimit: 999 });
    stage.status = 'running';
    const n = stage.rounds.length + 1;
    const round: Round = { n };
    stage.rounds.push(round);
    const earlier = stage.rounds.slice(0, -1).flatMap((r) => (r.verification ? [r.verification] : []));
    const byPlanner = vcfg.by === 'planner';
    const planner = run.config.plan.enabled ? run.config.plan.author : run.config.implement.author;
    let who: RoleConfig = byPlanner ? planner : (vcfg.verifier ?? { provider: this.otherVendor(run, run.config.implement.author.provider) });
    this.log(run, L(`目標驗收 第 ${n} 次（${byPlanner ? '由計畫者' : '獨立驗收者'}：${this.providerName(who.provider)}）`, `Goal verification · check ${n} (${byPlanner ? 'by the planner' : 'independent verifier'}: ${this.providerName(who.provider)})`), 'info', true);
    this.touch(run);
    const work = [...run.stages.implement.rounds].reverse().find((r) => r.submission)?.submission?.summary ?? '';
    const tried = new Set<string>();
    let verification: Verification | undefined;
    for (;;) {
      const spec = this.d.registry.get(who.provider);
      const canResume = !!(spec?.run.resume && spec.capabilities?.resume !== false);
      // The planner verifies in its own conversation (it knows why it set each metric); a verifier keeps its own.
      const own = byPlanner && who.provider === run.config.plan.author.provider && run.config.plan.enabled ? run.stages.plan.authorSessionId : stage.authorSessionId;
      const resume = canResume ? own : undefined;
      const evidence = evidenceStamp(run.config.cwd, run.plan?.goal?.data);
      const r = await this.runRole(run, {
        role: 'verifier',
        roleCfg: who,
        stage: 'verify',
        round: n,
        prompt: P.verifyPrompt(run.config, run.plan, work, await this.describeChanges(run), earlier, byPlanner, this.subBlock(run, 0)),
        mode: 'readonly',
        resume,
        expect: 'submit_verification',
        task: byPlanner ? L('計畫者驗收目標', 'Planner verifies the goal') : L('獨立驗收目標', 'Verify the goal'),
      });
      round.reviewerAgentId = r.info.id;
      if (r.info.sessionId) {
        if (byPlanner && who.provider === run.config.plan.author.provider && run.config.plan.enabled) run.stages.plan.authorSessionId = r.info.sessionId;
        else stage.authorSessionId = r.info.sessionId;
      }
      verification = r.sub?.verification;
      if (verification) {
        verification.evidence = evidence;
        break;
      }
      tried.add(who.provider);
      const fallback = this.stoppedByUser.has(r.info.id) ? undefined : this.failoverTarget(run, 'review', new Set([...tried, run.config.implement.author.provider])) ?? this.failoverTarget(run, 'review', tried);
      if (fallback) {
        this.log(run, L(`自動換手：驗收者 ${this.providerName(who.provider)} 失敗，改由 ${this.providerName(fallback)} 驗收`, `Auto failover: verifier ${this.providerName(who.provider)} failed; ${this.providerName(fallback)} verifies instead`), 'warn', true);
        who = { provider: fallback };
        stage.authorSessionId = undefined;
        continue;
      }
      // There is no "accept as met": an unverified goal is not a met goal.
      const dec = await this.ask(run, 'verify', L(`驗收者（${this.providerName(r.info.provider)}）沒有交出驗收結果：${r.res.error ?? '未呼叫 submit_verification'}`, `The verifier (${this.providerName(r.info.provider)}) submitted no verification: ${r.res.error ?? 'submit_verification was not called'}`), [
        { id: 'retry', label: L('重新驗收', 'Verify again') },
        ...this.switchOptions(who.provider),
        { id: 'incomplete', label: L('停止（標記為未完成）', 'Stop (mark incomplete)') },
      ]);
      if (dec.optionId === 'incomplete') throw new Incomplete(L('目標驗收沒有完成', 'goal verification did not finish'));
      if (dec.optionId.startsWith('switch:')) {
        who = { provider: dec.optionId.slice(7) };
        stage.authorSessionId = undefined;
      }
    }
    round.verification = verification;
    const route = routeVerification(verification, earlier, Math.max(2, vcfg.repeatLimit ?? 3));
    round.route = route;
    round.handoff = buildHandoff(run, 'verify', round);
    const met = verification.metrics.filter((m) => m.met).length;
    this.log(
      run,
      route.to === 'done'
        ? L(`目標驗收通過 ✅ ${met}/${verification.metrics.length} 項指標達成`, `Goal verified ✅ ${met}/${verification.metrics.length} metrics met`)
        : L(`目標驗收未通過（${met}/${verification.metrics.length} 項達成，${outcomeLabel(verification.outcome)}）→ ${routeName(route.to)}`, `Goal not verified (${met}/${verification.metrics.length} met, ${outcomeLabel(verification.outcome)}) → ${routeName(route.to)}`),
      route.to === 'done' ? 'info' : 'warn',
      true,
    );
    stage.status = route.to === 'done' ? 'approved' : 'running';
    this.touch(run);
    return { route, verification };
  }

  /** A logged-in provider other than `not` (another vendor checks the work), or `not` itself when there is none. */
  private otherVendor(run: WorkflowRun, not: string, also: (string | undefined)[] = []): string {
    const avoid = new Set([not, ...also].filter(Boolean) as string[]);
    const ready = this.d.registry.list().filter((p) => p.installed && p.auth.state === 'logged_in').map((p) => p.spec.id);
    const ranked = run.assignment?.ranking.review ?? [];
    return [...ranked, ...ready].find((id) => ready.includes(id) && !avoid.has(id)) ?? not;
  }

  /**
   * Issues the author rebutted and the reviewer raised again: an independent agent (another vendor when possible)
   * rules on each from the evidence. Returns the rulings (empty when it gave none).
   */
  private async adjudicate(run: WorkflowRun, key: StageKey, round: number, disputed: ReviewIssue[]) {
    const cfg = run.config[key];
    const stage = run.stages[key];
    const provider = this.otherVendor(run, cfg.author.provider, [cfg.reviewer?.provider]);
    const history = (i: ReviewIssue) =>
      stage.rounds
        .filter((r) => r.review)
        .map((r) => {
          const mine = r.review!.issues.find((x) => x.title.trim().toLowerCase() === i.title.trim().toLowerCase());
          const answer = stage.rounds.find((x) => x.n === r.n + 1)?.submission?.responses?.find((x) => mine && x.issue_id === mine.id);
          return mine ? `Round ${r.n} reviewer: ${mine.detail ?? mine.title}${mine.location ? ` (${mine.location})` : ''}${answer ? `\nAuthor (${answer.action}): ${answer.note ?? ''}` : ''}` : '';
        })
        .filter(Boolean)
        .join('\n');
    this.log(run, L(`審查者與作者對 ${disputed.map((i) => i.id).join('、')} 意見不合，交由 ${this.providerName(provider)} 依證據裁定`, `The reviewer and the author disagree on ${disputed.map((i) => i.id).join(', ')}; ${this.providerName(provider)} rules on the evidence`), 'warn', true);
    const r = await this.runRole(run, {
      role: 'adjudicator',
      roleCfg: { provider },
      stage: key,
      round,
      prompt: P.adjudicatePrompt(run.config, disputed.map((i) => ({ id: i.id, title: i.title, history: history(i) }))),
      mode: 'readonly',
      expect: 'submit_ruling',
      task: L('依證據裁定爭議', 'Rule on the disputes'),
    });
    const rulings = (r.sub?.rulings ?? []).filter((x) => disputed.some((i) => i.id === x.issue_id));
    if (!rulings.length) {
      this.log(run, L('裁定者沒有交出裁定，爭議的問題維持原狀', 'The adjudicator gave no ruling; the disputed issues stay'), 'warn', true);
      return [];
    }
    for (const x of rulings) {
      (run.rulings ??= []).push({ issueId: x.issue_id, ruling: `${x.ruling}: ${x.reason}`.slice(0, 1000), by: r.info.id, ts: now() });
      (run.notes ??= []).push({ id: randomUUID().slice(0, 8), agentId: r.info.id, kind: 'decision', text: `Ruling on ${x.issue_id}: ${x.ruling === 'uphold' ? 'UPHELD (must be fixed)' : 'DISMISSED (the author is right)'} — ${x.reason}`.slice(0, 2000), ts: now() });
    }
    this.log(run, L(`裁定：${rulings.map((x) => `${x.issue_id} ${x.ruling === 'uphold' ? '維持' : '駁回'}`).join('、')}`, `Ruling: ${rulings.map((x) => `${x.issue_id} ${x.ruling === 'uphold' ? 'upheld' : 'dismissed'}`).join(', ')}`), 'info', true);
    this.touch(run);
    return rulings;
  }

  /** Options to retry a failed role with another logged-in provider. */
  private switchOptions(current: string): { id: string; label: string }[] {
    return this.d.registry
      .list()
      .filter((p) => p.spec.id !== current && p.installed && p.auth.state === 'logged_in')
      .map((p) => ({ id: `switch:${p.spec.id}`, label: L(`改用 ${p.spec.name}`, `Use ${p.spec.name} instead`) }));
  }

  private async runStage(run: WorkflowRun, key: StageKey, entry?: Entry): Promise<{ replan?: { why: string; detail: string } }> {
    const cfg = run.config[key];
    const stage = run.stages[key];
    const isPlan = key === 'plan';
    const stageName = isPlan ? L('計畫階段', 'Planning') : L('實作階段', 'Implementation');
    if (!cfg.enabled) {
      stage.status = 'skipped';
      this.touch(run);
      return {};
    }
    stage.status = 'running';
    // Another pass (after a verification or a re-diagnosis) gets its own rounds.
    const firstN = stage.rounds.length + 1;
    if (entry) stage.roundLimit = Math.max(stage.roundLimit, stage.rounds.length + Math.max(1, cfg.maxRounds));
    this.log(run, entry ? L(`${stageName}重新開始（第 ${(run.cycles ?? 0) + 1} 輪循環）`, `${stageName} again (cycle ${(run.cycles ?? 0) + 1})`) : L(`${stageName}開始`, `${stageName} started`), 'info', true);
    this.touch(run);

    let pendingReview: Review | undefined;
    let userFeedback: string | undefined;
    let prevIssueKey: string | undefined;

    for (;;) {
      this.checkCancelled(run);
      if (stage.rounds.length >= stage.roundLimit) {
        const dec = await this.ask(run, key, L(`${stageName}已進行 ${stage.rounds.length} 輪，審查仍未通過。要怎麼處理？`, `${stageName} has gone ${stage.rounds.length} rounds without approval. What next?`), [
          { id: 'more', label: L('再進行 2 輪', 'Allow 2 more rounds') },
          { id: 'accept', label: L('視為通過，繼續', 'Accept and continue') },
          { id: 'abort', label: L('中止工作流', 'Stop the workflow') },
        ]);
        if (dec.optionId === 'abort') throw new Cancelled();
        if (dec.optionId === 'accept') break;
        stage.roundLimit += 2;
        if (dec.text) userFeedback = dec.text;
      }

      const n = stage.rounds.length + 1;
      const round: Round = { n, userFeedback };
      stage.rounds.push(round);
      this.log(run, L(`${stageName} 第 ${n} 輪`, `${stageName} · round ${n}`), 'info', true);
      this.touch(run);

      // ----- author -----
      const subText = this.subBlock(run, 0);
      const buildPrompt = () => {
        const authorSpec = this.d.registry.get(cfg.author.provider);
        const resume = !!(stage.authorSessionId && authorSpec?.run.resume && authorSpec.capabilities?.resume !== false);
        if (entry && n === firstN) {
          if (resume) return { resume, prompt: entry.prompt() };
          const base = isPlan
            ? `${P.planDraftPrompt(run.config, subText)}\n\nYOUR PREVIOUS PLAN:\n${P.planBlock(run.plan)}`
            : `${P.implementPrompt(run.config, run.plan, subText)}\n\nYou (or another agent) already implemented this earlier; the current code is in the working directory.`;
          return { resume, prompt: `${base}\n\n${entry.prompt()}` };
        }
        if (n === 1 && !pendingReview) {
          return { resume, prompt: isPlan ? P.planDraftPrompt(run.config, subText, userFeedback) : P.implementPrompt(run.config, run.plan, subText, userFeedback) };
        }
        const revise = isPlan ? P.planRevisePrompt(run.config, pendingReview, userFeedback) : P.fixPrompt(pendingReview, userFeedback);
        if (resume) return { resume, prompt: revise };
        const base = isPlan
          ? `${P.planDraftPrompt(run.config, subText)}\n\nYOUR PREVIOUS PLAN:\n${P.planBlock(run.plan)}`
          : `${P.implementPrompt(run.config, run.plan, subText)}\n\nYou (or another agent) already implemented this earlier; the current code is in the working directory.`;
        return { resume, prompt: `${base}\n\n${revise}` };
      };

      let authorResult: Submission | undefined;
      let note = '';
      const authorTried = new Set<string>();
      for (;;) {
        const { resume, prompt } = buildPrompt();
        const a = await this.runRole(run, {
          role: isPlan ? 'planner' : 'executor',
          roleCfg: cfg.author,
          stage: key,
          round: n,
          // A conversation compacted into a summary goes on in a fresh one that starts from it.
          prompt: prompt + note + (!resume && stage.authorHandoff ? P.handoffBlock(stage.authorHandoff) : ''),
          mode: isPlan ? 'readonly' : 'write',
          resume: resume ? stage.authorSessionId : undefined,
          expect: isPlan ? 'submit_plan' : 'submit_work',
          task: isPlan ? (n === 1 ? L('撰寫計畫草稿', 'Draft the plan') : L('依審查意見修改計畫', 'Revise the plan')) : n === 1 ? L('依計畫實作', 'Implement the plan') : L('依審查意見修正', 'Fix review issues'),
        });
        round.authorAgentId = a.info.id;
        if (!resume) stage.authorHandoff = undefined;
        if (a.info.sessionId) stage.authorSessionId = a.info.sessionId;
        if (a.sub) {
          authorResult = a.sub;
          break;
        }
        if (this.redispatch.delete(a.info.id)) {
          this.log(run, L(`依新的設定重新派發${roleLabel(a.info.role)}（${this.providerName(cfg.author.provider)}）`, `Re-dispatching the ${roleLabel(a.info.role)} with the new settings (${this.providerName(cfg.author.provider)})`), 'info', true);
          continue;
        }
        authorTried.add(cfg.author.provider);
        const fallback = this.stoppedByUser.has(a.info.id) ? undefined : this.failoverTarget(run, isPlan ? 'plan' : 'code', authorTried);
        if (fallback) {
          this.log(run, L(`自動換手：${this.providerName(cfg.author.provider)} 失敗（${a.res.error ?? '沒有產出結果'}），改由 ${this.providerName(fallback)} 擔任${roleLabel(a.info.role)}`, `Auto failover: ${this.providerName(cfg.author.provider)} failed (${a.res.error ?? 'no result'}); ${this.providerName(fallback)} takes over as ${roleLabel(a.info.role)}`), 'warn', true);
          cfg.author = { provider: fallback };
          stage.authorSessionId = undefined;
          continue;
        }
        const dec = await this.ask(run, key, L(`${roleLabel(a.info.role)}（${this.providerName(a.info.provider)}）沒有產出結果：${a.res.error ?? '未知原因'}`, `${roleLabel(a.info.role)} (${this.providerName(a.info.provider)}) produced no result: ${a.res.error ?? 'unknown reason'}`), [
          { id: 'retry', label: L('重試', 'Retry') },
          ...this.switchOptions(cfg.author.provider),
          { id: 'abort', label: L('中止工作流', 'Stop the workflow') },
        ]);
        if (dec.optionId === 'abort') throw new Cancelled();
        if (dec.optionId.startsWith('switch:')) {
          cfg.author = { provider: dec.optionId.slice(7) };
          stage.authorSessionId = undefined;
          this.log(run, L(`改由 ${this.providerName(cfg.author.provider)} 擔任${roleLabel(a.info.role)}`, `${this.providerName(cfg.author.provider)} takes over as ${roleLabel(a.info.role)}`), 'info', true);
        }
        note = dec.text ? `\n\nUSER NOTE: ${dec.text}` : '';
      }

      if (isPlan && authorResult.plan) {
        const { plan, responses } = authorResult.plan;
        round.submission = { summary: plan.summary, plan, responses };
        run.plan = plan;
        run.steps = plan.steps.map((st) => ({ ...st, status: 'pending' }));
      } else if (authorResult.work) {
        round.submission = { summary: authorResult.work.summary, responses: authorResult.work.responses };
        // Reviews and verifications of the code before this change no longer count.
        if (this.hasEvidence(run)) {
          const stale = markStale(run, evidenceStamp(run.config.cwd, run.plan?.goal?.data));
          if (stale) this.log(run, L(`程式碼、資料或環境已變更：${stale} 筆先前的審查／驗收結果標為需重驗`, `The code, data or environment changed: ${stale} earlier review / verification result(s) need checking again`));
        }
      }
      userFeedback = undefined;
      run.lastProgressAt = now();
      this.touch(run);

      // ----- reviewer -----
      if (!cfg.reviewer) {
        round.handoff = buildHandoff(run, key, round);
        if (cfg.humanGate) {
          const g = await this.gate(run, key, L(`${stageName}已完成（未設定審查者）。請確認結果。`, `${stageName} finished (no reviewer). Please check the result.`));
          if (g.revise) {
            userFeedback = g.revise;
            pendingReview = undefined;
            stage.roundLimit = Math.max(stage.roundLimit, stage.rounds.length + 1);
            continue;
          }
        }
        break;
      }

      const prior = pendingReview ? { review: pendingReview, responses: round.submission?.responses } : undefined;
      let review: Review | undefined;
      let accepted = false;
      const reviewerTried = new Set<string>();
      for (;;) {
        const reviewerSpec = this.d.registry.get(cfg.reviewer.provider);
        const reviewerResume = !!(stage.reviewerSessionId && reviewerSpec?.run.resume && reviewerSpec.capabilities?.resume !== false);
        const changes = isPlan ? '' : await this.describeChanges(run);
        const evidence = isPlan ? undefined : evidenceStamp(run.config.cwd, run.plan?.goal?.data);
        const rprompt = isPlan
          ? P.planReviewPrompt(run.config, run.plan!, n, prior) + this.subBlock(run, 0)
          : P.codeReviewPrompt(run.config, run.plan, round.submission?.summary ?? '', changes, n, prior) + this.subBlock(run, 0);
        const r = await this.runRole(run, {
          role: isPlan ? 'plan_reviewer' : 'code_reviewer',
          roleCfg: cfg.reviewer,
          stage: key,
          round: n,
          prompt: rprompt + (!reviewerResume && stage.reviewerHandoff ? P.handoffBlock(stage.reviewerHandoff) : ''),
          mode: 'readonly',
          resume: reviewerResume ? stage.reviewerSessionId : undefined,
          expect: 'submit_review',
          task: isPlan ? L('審查計畫', 'Review the plan') : L('審查程式碼', 'Review the code'),
        });
        round.reviewerAgentId = r.info.id;
        if (!reviewerResume) stage.reviewerHandoff = undefined;
        if (r.info.sessionId) stage.reviewerSessionId = r.info.sessionId;
        review = r.sub?.review;
        if (review) {
          review.evidence = evidence;
          break;
        }
        if (this.redispatch.delete(r.info.id)) continue;
        reviewerTried.add(cfg.reviewer.provider);
        // Prefer a reviewer from another vendor than the author, if any is left.
        const fallback = this.stoppedByUser.has(r.info.id) ? undefined : (this.failoverTarget(run, 'review', new Set([...reviewerTried, cfg.author.provider])) ?? this.failoverTarget(run, 'review', reviewerTried));
        if (fallback) {
          this.log(run, L(`自動換手：審查者 ${this.providerName(cfg.reviewer.provider)} 失敗，改由 ${this.providerName(fallback)} 審查`, `Auto failover: reviewer ${this.providerName(cfg.reviewer.provider)} failed; ${this.providerName(fallback)} reviews instead`), 'warn', true);
          cfg.reviewer = { provider: fallback };
          stage.reviewerSessionId = undefined;
          continue;
        }
        const dec = await this.ask(run, key, L(`審查者（${this.providerName(r.info.provider)}）沒有提交審查結果：${r.res.error ?? '未呼叫 submit_review'}`, `The reviewer (${this.providerName(r.info.provider)}) submitted no verdict: ${r.res.error ?? 'submit_review was not called'}`), [
          { id: 'retry', label: L('重新審查', 'Review again') },
          ...this.switchOptions(cfg.reviewer.provider),
          { id: 'accept', label: L('視為通過', 'Accept as approved') },
          { id: 'abort', label: L('中止工作流', 'Stop the workflow') },
        ]);
        if (dec.optionId === 'abort') throw new Cancelled();
        if (dec.optionId === 'accept') {
          accepted = true;
          break;
        }
        if (dec.optionId.startsWith('switch:')) {
          cfg.reviewer = { provider: dec.optionId.slice(7) };
          stage.reviewerSessionId = undefined;
        }
      }
      if (accepted) break;
      round.review = review;
      this.touch(run);

      // Rebutted and raised again: an independent ruling on the evidence, not another round of the same argument.
      if (review!.verdict === 'revise') {
        const disputed = disputedIssues(stage.rounds.filter((r) => r.review).map((r) => ({ issues: r.review!.issues, responses: r.submission?.responses })), 1);
        if (disputed.length) {
          const rulings = await this.adjudicate(run, key, n, disputed);
          const dismissed = new Set(rulings.filter((x) => x.ruling === 'dismiss').map((x) => x.issue_id));
          const upheld = rulings.filter((x) => x.ruling === 'uphold');
          if (dismissed.size) review!.issues = review!.issues.filter((i) => !dismissed.has(i.id));
          if (upheld.length) userFeedback = [userFeedback, `An independent adjudicator UPHELD these issues; fix them, do not rebut them again:\n${upheld.map((x) => `- ${x.issue_id}: ${x.reason}`).join('\n')}`].filter(Boolean).join('\n\n');
          if (!review!.issues.length) {
            review!.verdict = 'approve';
            review!.summary += L('（裁定者駁回了剩下的爭議問題）', ' (the adjudicator dismissed the remaining disputed issues)');
          }
        }
      }
      round.handoff = buildHandoff(run, key, round);

      if (review!.verdict === 'approve') {
        this.log(run, L(`${stageName}審查通過 ✅`, `${stageName} approved ✅`), 'info', true);
        if (cfg.humanGate) {
          const g = await this.gate(run, key, isPlan ? L('計畫審查通過，要開始實作嗎？', 'The plan was approved. Start implementing?') : L('程式審查通過，確認完成嗎？', 'The code review passed. Mark as done?'));
          if (g.revise) {
            userFeedback = g.revise;
            pendingReview = undefined;
            stage.roundLimit = Math.max(stage.roundLimit, stage.rounds.length + 1);
            continue;
          }
        }
        break;
      }

      this.log(run, L(`${stageName}審查要求修改：${review!.issues.length} 個問題`, `${stageName} review requested changes: ${review!.issues.length} issue(s)`), 'warn', true);
      // The same issue failing fix after fix: the plan, not the code, is probably wrong — the planner re-diagnoses.
      const limit = Math.max(2, run.config.verify?.repeatLimit ?? 3);
      const stuck = !isPlan && run.config.plan.enabled ? repeatedIssues(stage.rounds.filter((r) => r.review).map((r) => r.review!.issues), limit) : [];
      if (stuck.length) {
        round.route = { to: 'planner', reason: `the same issue failed ${limit} code reviews in a row: re-diagnose`, issues: stuck.map((i) => i.id), rediagnose: true };
        round.handoff = buildHandoff(run, key, round);
        this.log(run, L(`同樣的問題（${stuck.map((i) => i.title).join('、').slice(0, 200)}）連續 ${limit} 輪修不好：交回計畫者重新診斷`, `The same issue (${stuck.map((i) => i.title).join(', ').slice(0, 200)}) failed ${limit} rounds in a row: back to the planner to re-diagnose`), 'warn', true);
        return { replan: { why: round.route.reason, detail: P.reviewText(review!) } };
      }
      const issueKey = review!.issues.map((i) => i.title.trim().toLowerCase()).sort().join('|');
      if (prevIssueKey && issueKey && issueKey === prevIssueKey && (isPlan || !run.config.plan.enabled)) {
        const dec = await this.ask(run, key, L('連續兩輪審查提出相同的問題，迴圈可能卡住了。要怎麼處理？', 'The reviewer raised the same issues two rounds in a row; the loop may be stuck. What next?'), [
          { id: 'more', label: L('繼續修改', 'Keep revising') },
          { id: 'accept', label: L('視為通過', 'Accept as approved') },
          { id: 'abort', label: L('中止工作流', 'Stop the workflow') },
        ]);
        if (dec.optionId === 'abort') throw new Cancelled();
        if (dec.optionId === 'accept') break;
        if (dec.text) userFeedback = dec.text;
      }
      prevIssueKey = issueKey;
      pendingReview = review;
    }
    stage.status = 'approved';
    this.touch(run);
    return {};
  }

  private hasEvidence(run: WorkflowRun): boolean {
    return [run.stages.implement, run.stages.verify].some((st) => st?.rounds.some((r) => r.review?.evidence || r.verification?.evidence));
  }

  private async gate(run: WorkflowRun, key: StageKey, message: string): Promise<{ revise?: string }> {
    const dec = await this.ask(run, key, message, [
      { id: 'continue', label: key === 'plan' ? L('開始實作', 'Start implementing') : L('完成', 'Done') },
      { id: 'revise', label: L('退回修改（請填寫意見）', 'Send back with feedback') },
      { id: 'abort', label: L('中止工作流', 'Stop the workflow') },
    ]);
    if (dec.optionId === 'abort') throw new Cancelled();
    if (dec.optionId === 'revise') return { revise: dec.text || 'Please improve it further.' };
    return {};
  }

  private async runRole(
    run: WorkflowRun,
    o: { role: AgentRole; roleCfg: RoleConfig; stage: PhaseKey; round: number; prompt: string; mode: 'write' | 'readonly'; resume?: string; expect: Expect; task: string },
  ): Promise<{ info: AgentRunInfo; res: RunAgentResult; sub?: Submission }> {
    const def = this.d.registry.defaults(o.roleCfg.provider);
    const info = this.newAgent(run, { role: o.role, provider: o.roleCfg.provider, model: o.roleCfg.model || def.model, effort: o.roleCfg.effort || def.effort, stage: o.stage, round: o.round, depth: 0, task: o.task });
    let res = await this.invokePausable(run, info, o.prompt, o.mode, o.resume);
    // A conversation carried over from the previous message that the CLI no longer has: start a fresh one.
    if (o.resume && run.carriedSessions?.includes(o.resume) && res.error && !res.finalText.trim() && !this.aborted(run)) {
      this.log(run, L(`${this.label(info)} 無法接續上一則訊息的對話，改開新的對話`, `${this.label(info)} could not continue the previous message's conversation; starting a fresh one`), 'warn', true);
      run.carriedSessions = run.carriedSessions.filter((s) => s !== o.resume);
      info.sessionId = undefined;
      res = await this.invokePausable(run, info, o.prompt, o.mode, undefined, res.lastSeq);
    }
    let sub = this.collect(info.id, o.expect, res);
    const spec = this.d.registry.get(info.provider);
    if (!sub && !res.error && res.sessionId && spec?.run.resume && spec.capabilities?.resume !== false && !this.aborted(run)) {
      this.log(run, L(`${this.label(info)} 沒有提交結果，要求補交`, `${this.label(info)} did not submit; asking again`), 'warn');
      res = await this.invokePausable(run, info, P.nudgePrompt(o.expect), o.mode, res.sessionId, res.lastSeq);
      sub = this.collect(info.id, o.expect, res);
    }
    // A failed turn: what kind of failure decides the recovery (wait and retry, hand over, or ask).
    for (let attempt = 1; !sub && res.error && !this.aborted(run) && !this.stoppedByUser.has(info.id) && !this.redispatch.has(info.id); attempt++) {
      const kind = classifyFailure(res.error);
      const rec = recoveryFor(kind, attempt, L);
      info.failure = { kind, message: res.error.slice(0, 500), action: rec.action };
      this.touch(run);
      if (!rec.retry) break;
      this.log(run, `${this.label(info)}：${rec.action}`, 'warn', true);
      info.waiting = rec.action;
      await this.sleepFor(run, info, rec.delayMs);
      info.waiting = undefined;
      if (this.aborted(run) || this.stoppedByUser.has(info.id)) break;
      const sid = res.sessionId ?? info.sessionId;
      res = sid && spec?.run.resume && spec.capabilities?.resume !== false ? await this.invokePausable(run, info, P.resumeAfterError(), o.mode, sid, res.lastSeq) : await this.invokePausable(run, info, o.prompt, o.mode, o.resume, res.lastSeq);
      sub = this.collect(info.id, o.expect, res);
    }
    if (sub) info.failure = undefined;
    // The CLI exited cleanly without the result its role must hand in: the process ended, the task did not.
    if (!sub && !res.error && !this.aborted(run)) {
      info.endedWithoutResult = true;
      res = { ...res, error: L('程序已結束，但沒有交出結果（這不是成功）', 'The process ended without handing in a result (this is not a success)') };
    }
    info.status = this.aborted(run) || this.stoppedByUser.has(info.id) || this.redispatch.has(info.id) ? 'cancelled' : res.error && !sub ? 'failed' : 'completed';
    info.error = res.error;
    info.endedAt = now();
    info.activity = undefined;
    info.waiting = undefined;
    this.endAgentResources(run, info);
    this.cancelChildren(run, info.id);
    this.updateOutputs(run);
    this.refreshShared(run);
    this.checkContextAsk(run, info);
    // A compaction the user asked for while this agent was working runs now that its turn is over.
    const queued = info.sessionId ? this.queuedAgentCompact.get(info.sessionId) : undefined;
    if (queued) {
      this.queuedAgentCompact.delete(info.sessionId!);
      await this.startAgentCompaction(run, info);
    }
    this.checkCancelled(run);
    return { info, res, sub };
  }

  private collect(agentId: string, expect: Expect, res: RunAgentResult): Submission | undefined {
    const sub = this.submissions.get(agentId) ?? {};
    const json = extractJson(res.finalText) as any;
    if (expect === 'submit_verification') {
      sub.verification ??= parseVerification(json);
      return sub.verification ? sub : undefined;
    }
    if (expect === 'submit_ruling') {
      sub.rulings ??= parseRulings(json);
      return sub.rulings?.length ? sub : undefined;
    }
    if (expect === 'submit_plan') {
      if (!sub.plan) {
        sub.plan = parsePlan(json);
        if (!sub.plan && !res.error) {
          const plan = planFromText(res.finalText);
          if (plan) sub.plan = { plan };
        }
      }
      return sub.plan ? sub : undefined;
    }
    if (expect === 'submit_review') {
      sub.review ??= parseReview(json);
      return sub.review ? sub : undefined;
    }
    sub.work ??= parseWork(json) ?? (res.error || !res.finalText.trim() ? undefined : { summary: res.finalText.trim() });
    return sub.work ? sub : undefined;
  }

  private newAgent(run: WorkflowRun, p: Pick<AgentRunInfo, 'role' | 'provider' | 'depth' | 'task'> & Partial<AgentRunInfo>): AgentRunInfo {
    const info: AgentRunInfo = { id: randomUUID().slice(0, 12), workflowId: run.id, status: 'queued', stats: { events: 0, tools: 0, commands: 0, filesChanged: [] }, ...p };
    this.requestedModel.set(info.id, info.model);
    run.agents[info.id] = info;
    this.touch(run);
    return info;
  }

  private bridgeLaunch(secret: string): BridgeLaunch {
    const env = { AIVENUE_URL: this.d.hubUrl(), AIVENUE_SESSION: secret };
    const node = findNode();
    if (node) return { command: node, args: [this.d.bridgePath], env };
    // No system Node: run the bridge with the Electron / VS Code binary in Node mode.
    return { command: process.execPath, args: [this.d.bridgePath], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
  }

  private async invoke(run: WorkflowRun, info: AgentRunInfo, prompt: string, mode: 'write' | 'readonly', resume?: string, seqStart?: number): Promise<RunAgentResult> {
    const spec = this.d.registry.get(info.provider);
    if (!spec) throw new Error(L(`未知的供應商：${info.provider}`, `Unknown provider: ${info.provider}`));
    // The compactor gets its prompt and nothing else; everyone else may first wait for a compaction.
    const plain = info.role === 'compactor';
    if (!plain) {
      await this.maybeAutoCompact(run);
      if (resume) await this.agentCompactions.get(resume);
    }
    const ac = new AbortController();
    this.agentAborts.set(info.id, ac);
    const wf = this.aborts.get(run.id);
    const onWfAbort = () => ac.abort();
    wf?.signal.addEventListener('abort', onWfAbort);
    if (wf?.signal.aborted) ac.abort();
    info.status = 'running';
    info.startedAt ??= now();
    info.readonly = mode === 'readonly';
    this.touch(run);
    const secret = randomUUID();
    this.sessions.set(secret, { workflowId: run.id, agentId: info.id, permission: run.config.permission });
    // The bridge session in use (a reused CLI keeps its own) and whether the CLI stays running afterwards.
    let liveSecret: string = secret;
    let keptAlive = false;
    this.d.usage.recordRun(info.provider, this.usageModel(info));
    try {
      let auth;
      let mcpServers;
      try {
        auth = await this.d.registry.runAuth(info.provider);
        mcpServers = await this.d.capabilities.serversFor(info.provider);
        if (spec.mcpRegistration) this.sessions.get(secret)!.proxyServers = mcpServers;
      } catch (e) {
        const error = (e as Error).message;
        const seq = (seqStart ?? 0) + 1;
        this.onAgentEvent(run, info, { seq, ts: now(), kind: 'error', text: error }, false);
        return { lastSeq: seq, exitCode: null, finalText: '', error, resumed: false };
      }
      const caps = this.d.capabilities;
      // Skills are announced once per conversation; a resumed session already has them.
      const skills = resume ? '' : caps.skillsBlock(info.role, run.config.cwd);
      // Shown on the agent's header: skills it follows the whole time (they never show up as a file it reads).
      const always = [...skills.matchAll(/ALWAYS ON — (\S+) \(Ponytail, ([^)]*)\)/g)].map((m) => `${m[1]} · ${m[2].split(' — ')[0]}`);
      if (always.length) info.alwaysOn = always;
      const attached = run.config.attachments ?? [];
      // Per provider: which version of each file to read, and an explicit note for what it cannot read.
      // What this model reads (images, video, audio, PDF): OpenCode, OmniRoute and Copilot reach models of every kind.
      const profile = attached.length ? await this.modelProfile(info.provider, spec, this.requestedModel.get(info.id) ?? info.model) : spec.profile;
      const files = resume ? '' : attachmentsBlock(attached, profile);
      // What the other agents did so far (empty in "summary" mode).
      // A resumed conversation already has what it was given before: only what is new, within this model's share.
      const seenKey = resume ? `${run.id}|${resume}` : undefined;
      const window = plain ? undefined : await this.windowFor(run, info, resume);
      const sharedAt = now();
      const shared = plain ? '' : contextBlock(run, info, (id) => this.events(run.id, id), { since: seenKey ? this.sharedSeen.get(seenKey) : undefined, maxChars: window ? Math.floor(window * SHARE_OF_WINDOW * 4) : undefined });
      // Advisor mode: Claude's own advisor (a CLI flag) or Aivenue's cross-vendor ask_advisor tool.
      const adv = run.config.advisor;
      const nativeAdvisor = plain ? undefined : this.nativeAdvisorFor(run, info, spec.run.advisor ? adv : undefined);
      const advisorText =
        info.role === 'advisor' || resume
          ? ''
          : this.crossAdvisor(run)
            ? P.advisorHint(`${this.providerName(adv!.provider!)}${adv!.model ? ` (${adv!.model})` : ''}`, Math.max(1, adv!.maxCalls ?? 5), this.canSpawn(run, info))
            : nativeAdvisor
              ? '\nADVISOR: Your built-in advisor tool is enabled. It runs a more expensive model, so use it only when you are genuinely stuck after investigating and trying yourself, or for a high-stakes decision the facts do not settle.'
              : '';
      // Extra folders are named every turn: they can be added while the conversation runs.
      const extraDirs = (run.config.extraDirs ?? []).filter((d) => fs.existsSync(d));
      const turnStart = now();
      const systemPrompt = caps.instructionsFor(info.role);
      // What this turn runs with, to tell later which settings and messages reached it.
      info.snapshot = {
        at: turnStart,
        model: this.requestedModel.get(info.id) ?? info.model,
        effort: info.effort,
        permission: run.config.permission,
        instructions: systemPrompt || skills ? createHash('sha1').update(`${systemPrompt ?? ''}\0${skills}`).digest('hex').slice(0, 10) : info.snapshot?.instructions,
        skills: skills ? [...skills.matchAll(/^- ([\w.-]+): /gm)].map((m) => m[1]) : (info.snapshot?.skills ?? []),
        userMessages: run.userMessages?.length ?? 0,
      };
      if (!plain) for (const m of run.userMessages ?? []) if (!(m.deliveredTo ??= []).includes(info.id)) m.deliveredTo.push(info.id);
      const res = await runAgent({
        spec,
        // Whole-computer access is said every turn: the user can turn it on or off while the conversation runs.
        prompt: plain ? prompt : prompt + P.extraDirsBlock(extraDirs) + (run.config.permission === 'full' && mode !== 'readonly' ? P.fullAccessRule(run.config.cwd) : '') + (resume ? '' : P.externalRule(this.d.github?.() ?? undefined)) + P.doneEffectsBlock(run.sideEffects) + shared + advisorText + files + skills,
        extraDirs,
        advisorModel: nativeAdvisor,
        mcpServers: plain ? [] : mcpServers,
        systemPrompt,
        skillsDir: skills && !plain ? caps.skillsDir : undefined,
        permission: run.config.permission,
        attachDir: attached.length ? this.d.attachments.runDir(run.id) : undefined,
        // Media the model takes natively ride along as files (images; video and audio too when it reads them).
        images: attached.filter((a) => (isImage(a) && profile?.vision !== false) || (a.kind === 'video' && profile?.video) || (a.kind === 'audio' && profile?.audio)).map((a) => a.path),
        cwd: run.config.cwd,
        mode,
        // What was asked for, not the resolved id the CLI reported (that would look like a settings change to the pool).
        model: this.requestedModel.has(info.id) ? this.requestedModel.get(info.id) : info.model,
        effort: info.effort,
        resumeSessionId: resume,
        // The compactor works from its prompt alone: no Aivenue tools, no built-in tools where the CLI can turn them off.
        bridge: plain ? undefined : this.bridgeLaunch(secret),
        noTools: plain,
        tmpDir: path.join(this.d.dataDir, 'tmp'),
        signal: ac.signal,
        seqStart,
        auth,
        keepAlive: {
          pool: this.pool,
          secret,
          // A running CLI keeps the bridge session it started with: point it at this agent.
          onReuse: (old) => {
            this.sessions.set(old, { ...this.sessions.get(secret)!, proxyServers: this.sessions.get(secret)?.proxyServers });
            this.sessions.delete(secret);
            liveSecret = old;
          },
          onClose: (s) => this.sessions.delete(s),
        },
        onEvent: (e, isUpdate) => this.onAgentEvent(run, info, e, isUpdate),
      });
      keptAlive = !!res.keptAlive;
      if (res.sessionId) info.sessionId = res.sessionId;
      if (res.sessionId && !plain && !res.error) this.sharedSeen.set(`${run.id}|${res.sessionId}`, sharedAt);
      await this.readAgentContext(info, spec, res.sessionId);
      const served = await this.d.servedBy?.(spec.accountOf ?? spec.id, this.requestedModel.get(info.id) ?? info.model, turnStart, now()).catch(() => undefined);
      if (served) info.servedBy = [...new Set([...(info.servedBy ?? []), ...served])];
      info.resumed = info.resumed || res.resumed;
      info.exitCode = res.exitCode;
      info.finalText = res.finalText;
      if (res.error && !ac.signal.aborted) this.d.usage.recordError(info.provider, res.error);
      return res;
    } finally {
      // A CLI kept running needs its bridge session until the pool closes it.
      if (!keptAlive) this.sessions.delete(liveSecret);
      wf?.signal.removeEventListener('abort', onWfAbort);
      this.agentAborts.delete(info.id);
    }
  }

  /** The model an agent's usage is counted under: what was asked for, else the provider default (the same key every turn). */
  private usageModel(info: AgentRunInfo): string | undefined {
    return this.requestedModel.get(info.id) ?? this.d.registry.defaults(info.provider).model ?? info.model;
  }

  private trackUsage(provider: string, e: AgentEvent, isUpdate: boolean, model?: string) {
    if (isUpdate) return;
    if (e.usage) this.d.usage.recordUsage(provider, e.usage, model);
    if ((e.kind === 'error' || e.kind === 'stderr') && e.text && LIMIT_PATTERN.test(e.text)) this.d.usage.recordError(provider, e.text);
  }

  private onAgentEvent(run: WorkflowRun, info: AgentRunInfo, e: AgentEvent, isUpdate: boolean) {
    this.d.store.appendEvent(run.id, info.id, e, isUpdate);
    info.lastEventAt = now();
    if (e.kind === 'tool' || e.files?.length) run.lastProgressAt = now();
    if (!isUpdate && e.usage?.costUsd) info.costUsd = (info.costUsd ?? 0) + e.usage.costUsd;
    this.trackUsage(info.provider, e, isUpdate, this.usageModel(info));
    // The model the CLI reports it is actually using (an alias like "opus" resolves to the full id).
    if (e.kind === 'session' && e.text?.trim() && !/\s/.test(e.text.trim())) info.model = e.text.trim();
    // How full its own conversation is (and the model's limit), as the CLI reports it.
    if (!isUpdate && e.context && (e.context.used || e.context.window)) info.context = { ...info.context, ...(e.context.used ? { used: e.context.used } : {}), ...(e.context.window ? { window: e.context.window } : {}) };
    // The CLI's own limit beats the catalog in the model menus from now on.
    if (!isUpdate && e.context?.window) for (const m of new Set([this.requestedModel.get(info.id), info.model])) this.d.registry.noteContext(info.provider, m, e.context.window);
    if (!isUpdate && e.usage) {
      const t = (info.tokens ??= { input: 0, output: 0, cached: 0 });
      t.input += e.usage.input ?? 0;
      t.output += e.usage.output ?? 0;
      t.cached += e.usage.cached ?? 0;
    }
    if (!isUpdate) {
      info.stats.events++;
      if (e.kind === 'tool') info.stats.tools++;
      if (e.tool?.category === 'command') info.stats.commands++;
    }
    for (const f of e.files ?? []) {
      const abs = path.resolve(run.config.cwd, f);
      // Inside the working folder: relative; outside it: the full path, not a long ..\..\ chain.
      const fromCwd = path.relative(run.config.cwd, abs);
      const rel = fromCwd && !fromCwd.startsWith('..') && !path.isAbsolute(fromCwd) ? fromCwd : abs;
      if (!info.stats.filesChanged.includes(rel)) info.stats.filesChanged.push(rel);
      // Changes outside the working folder and the extra folders are listed for the user (whole-computer access).
      const inside = [run.config.cwd, ...(run.config.extraDirs ?? [])].some((root) => {
        const r = path.relative(root, abs);
        return !r.startsWith('..') && !path.isAbsolute(r);
      });
      if (!inside && !(run.outsideChanges ??= []).includes(abs) && run.outsideChanges.length < 500) run.outsideChanges.push(abs);
    }
    const act = activityOf(e);
    if (act && !(isUpdate && e.tool?.status !== 'running')) info.activity = act;
    this.d.push({ topic: 'agentEvent', data: { workflowId: run.id, agentId: info.id, event: e } });
    this.touch(run);
  }

  // ---------- sub-agents ----------

  private spawnable(run: WorkflowRun) {
    const providers = this.d.registry.list();
    return run.config.subagents.allowed
      .map((id) => providers.find((p) => p.spec.id === id))
      .filter((p): p is NonNullable<typeof p> => !!p && p.installed)
      .map((p) => {
        const pinned = run.config.subagents.models?.[p.spec.id];
        const def = this.d.registry.defaults(p.spec.id);
        return {
          id: p.spec.id,
          name: p.spec.name,
          logged_in: p.auth.state === 'logged_in',
          model: pinned?.model || def.model,
          effort: pinned?.effort || def.effort,
          // The user's pick is fixed; otherwise the caller may choose a model.
          model_fixed: !!pinned?.model,
        };
      });
  }

  private canSpawn(run: WorkflowRun, info: AgentRunInfo): boolean {
    const s = run.config.subagents;
    return s.enabled && info.depth < s.maxDepth && this.spawnable(run).length > 0;
  }

  private subBlock(run: WorkflowRun, depth: number): string {
    return P.subagentBlock(run.config.subagents, depth, this.spawnable(run));
  }

  private async spawnSubagent(run: WorkflowRun, parent: AgentRunInfo, args: Record<string, unknown>): Promise<string> {
    const provider = String(args.provider ?? '');
    const task = String(args.task ?? '').trim();
    const cfg = run.config.subagents;
    if (!task) throw new Error('task is required');
    const allowed = this.spawnable(run);
    const target = allowed.find((a) => a.id === provider);
    if (!target) throw new Error(`Provider "${provider}" is not allowed. Allowed: ${allowed.map((a) => a.id).join(', ') || '(none)'}`);
    const subs = Object.values(run.agents).filter((a) => a.role === 'subagent');
    const running = subs.filter((a) => a.status === 'running' || a.status === 'queued' || a.status === 'paused').length;
    if (running >= cfg.maxConcurrent) throw new Error(`At most ${cfg.maxConcurrent} sub-agents may run at once. Wait for one with wait_subagent first.`);
    if (subs.length >= MAX_SUBAGENTS) throw new Error(`This conversation already started ${MAX_SUBAGENTS} sub-agents, the limit. Finish the work yourself.`);
    // Model: the user's setting for this provider, else what the caller asked for, else the provider default.
    const asked = (k: 'model' | 'effort') => {
      const v = typeof args[k] === 'string' ? (args[k] as string).trim() : '';
      if (v && !SAFE_ARG.test(v)) throw new Error(`Invalid ${k} "${v.slice(0, 60)}". Use a name from list_providers.`);
      return v || undefined;
    };
    const pinned = cfg.models?.[provider];
    const model = pinned?.model || asked('model') || target.model;
    const effort = pinned?.effort || asked('effort') || target.effort;
    // A sub-agent never gets more than its parent: a read-only agent can only start read-only helpers.
    const mode = args.mode === 'readonly' || parent.readonly ? 'readonly' : 'write';
    if ((run.config.permission ?? 'auto') === 'ask') {
      // The user approves each action, so starting another agent is theirs to decide too
      // (most CLIs can't ask per action and would fall back to their nearest setting).
      const spec = this.d.registry.get(provider);
      const d = await this.requestApproval(run, parent, 'spawn_subagent', {
        provider: target.name,
        mode,
        task: task.slice(0, 1500),
        ...(spec?.approvals?.type === 'fallback' ? { note: L(spec.approvals.zh, spec.approvals.en) } : {}),
      });
      if (!d.allow) throw new Error(d.message ?? 'The user did not allow this sub-agent.');
    }
    const title = typeof args.title === 'string' && args.title.trim() ? args.title.replace(/\s+/g, ' ').trim().slice(0, 60) : undefined;
    const child = this.launchChild(run, parent, { provider, model, effort, task, mode, title });
    const round = parent.role === 'advisor' ? this.nextFactRound(run, parent, child) : undefined;
    return JSON.stringify({ subagent_id: child.id, status: 'running', provider, model: model ?? 'default', effort: effort ?? 'default', ...(round ? { fact_finding_round: round } : {}) });
  }

  private launchChild(run: WorkflowRun, parent: AgentRunInfo, o: { provider: string; model?: string; effort?: string; task: string; mode: 'write' | 'readonly'; rerunOf?: string; title?: string }): AgentRunInfo {
    const child = this.newAgent(run, {
      role: 'subagent',
      provider: o.provider,
      model: o.model,
      effort: o.effort,
      parentId: parent.id,
      depth: parent.depth + 1,
      stage: parent.stage,
      round: parent.round,
      task: o.task.slice(0, 400),
      title: o.title ?? taskTitle(o.task),
      brief: o.task.slice(0, 8000),
      readonly: o.mode === 'readonly',
      rerunOf: o.rerunOf,
    });
    this.subSpecs.set(child.id, { task: o.task, mode: o.mode });
    this.log(run, L(`${this.label(parent)} 派出 sub agent：${this.providerName(o.provider)}`, `${this.label(parent)} spawned a sub-agent: ${this.providerName(o.provider)}`));
    const prompt = P.subagentPrompt(run.config.cwd, o.task, roleLabel(parent.role), this.subBlock(run, child.depth));
    const done = this.invokePausable(run, child, prompt, o.mode)
      .then((res) => {
        child.status = this.aborted(run) || this.agentAborts.get(child.id)?.signal.aborted || this.stoppedByUser.has(child.id) ? 'cancelled' : res.error && !res.finalText ? 'failed' : 'completed';
        child.error = res.error;
        if (child.status === 'failed') {
          const kind = classifyFailure(res.error);
          child.failure = { kind, message: (res.error ?? '').slice(0, 500), action: recoveryFor(kind, 1, L).action };
        }
      })
      .catch((e) => {
        child.status = 'failed';
        child.error = String(e?.message ?? e);
      })
      .finally(() => {
        if (child.status === 'running') child.status = 'cancelled';
        child.endedAt = now();
        child.activity = undefined;
        this.endAgentResources(run, child);
        this.cancelChildren(run, child.id);
        this.updateOutputs(run);
        if (child.status === 'failed') this.notifyParent(run, child, `sub-agent ${child.id} (${child.provider}) FAILED${child.failure ? ` [${child.failure.kind}]` : ''}: ${(child.error ?? '').slice(0, 300)}`);
        else if (child.status === 'cancelled' && this.stoppedByUser.has(child.id) && !this.aborted(run)) this.notifyParent(run, child, `sub-agent ${child.id} (${child.provider}) was STOPPED before it finished; its work may be partial.`);
      });
    this.agentDone.set(child.id, done);
    return child;
  }

  /** Tell a parent about one of its sub-agents (on its next Aivenue tool result) and show it in the conversation. */
  private notifyParent(run: WorkflowRun, child: AgentRunInfo, text: string) {
    const parent = child.parentId ? run.agents[child.parentId] : undefined;
    if (!parent || !['running', 'paused', 'queued'].includes(parent.status)) return;
    this.inbox.set(parent.id, [...(this.inbox.get(parent.id) ?? []), text]);
    this.log(run, L(`已通知 ${this.label(parent)}：${text}`, `Told ${this.label(parent)}: ${text}`), 'warn', true);
  }

  /** A parent may only hand in its result once each of its sub-agents finished, was stopped or was handed off. */
  private requireChildrenSettled(run: WorkflowRun, info: AgentRunInfo) {
    const open = Object.values(run.agents).filter((a) => a.parentId === info.id && !a.handoff && (a.status === 'running' || a.status === 'queued' || a.status === 'paused'));
    if (!open.length) return;
    throw new Error(`Your sub-agents ${open.map((a) => `${a.id} (${a.provider})`).join(', ')} are still running. Before you submit: wait for them (wait_subagent), stop them (stop_subagent), or hand them off (stop_subagent {subagent_id, handoff: "who takes over its result"}).`);
  }

  private async waitSubagent(run: WorkflowRun, args: Record<string, unknown>): Promise<string> {
    const id = String(args.subagent_id ?? '');
    const child = run.agents[id];
    // Also used to collect advice that took longer than ask_advisor waits.
    if (!child || (child.role !== 'subagent' && child.role !== 'advisor')) throw new Error(`Unknown subagent_id ${id}`);
    const timeout = Math.min(Math.max(Number(args.timeout_sec) || 50, 1), 55) * 1000;
    if (child.status === 'running' || child.status === 'queued') await Promise.race([this.agentDone.get(id), sleep(timeout)]);
    const finished = child.status !== 'running' && child.status !== 'queued';
    return JSON.stringify({
      subagent_id: id,
      provider: child.provider,
      status: child.status,
      ...(finished ? { result: (child.finalText ?? '').slice(0, 20000), error: child.error } : { activity: child.activity, hint: 'Still running; call wait_subagent again.' }),
      ...(child.status === 'failed' ? { failure: child.failure?.kind, next: 'Decide: retry it (spawn_subagent again), adjust the task, or replace it with another provider (list_providers).' } : {}),
      files_changed: child.stats.filesChanged,
      ...(finished ? this.factRoundNote(run, child) : {}),
    });
  }

  // ---------- context: size, compaction ----------

  /** Re-estimate the shared context (what read_context {} returns), the pie's numerator. */
  private refreshShared(run: WorkflowRun) {
    run.sharedTokens = sharingOf(run) === 'summary' ? 0 : estimateTokens(overview(run, (aid) => this.events(run.id, aid)));
  }

  /** Over the auto-compaction threshold: compact before the next agent reads the shared context. */
  private async maybeAutoCompact(run: WorkflowRun) {
    if (sharingOf(run) === 'summary') return;
    const cfg = run.config.context ?? {};
    this.refreshShared(run);
    const size = run.sharedTokens ?? 0;
    if (size < (cfg.capacity ?? DEFAULT_CAPACITY) * (cfg.compactAt ?? 0.8)) return;
    // The last try did not shrink it: wait until there is clearly more to condense.
    const noGain = this.noGainAt.get(run.id);
    if (noGain && size < noGain * 1.2) return;
    await this.compactShared(run, 'auto').catch((e) => this.log(run, L(`共用上下文自動壓縮失敗：${(e as Error).message}`, `Automatic compaction of the shared context failed: ${(e as Error).message}`), 'warn', true));
  }

  /** Who condenses: the user's pick, else a mid-priced model of a signed-in CLI. */
  private compactorFor(run: WorkflowRun): { provider: string; model?: string; effort?: string } | undefined {
    const ready = new Set(this.d.registry.list().filter((p) => p.installed && p.auth.state === 'logged_in').map((p) => p.spec.id));
    const pick = run.config.context?.compactor;
    if (pick?.provider && ready.has(pick.provider)) return pick;
    for (const c of AUTO_COMPACTORS) if (ready.has(c.provider)) return c;
    const any = [...ready][0];
    return any ? { provider: any } : undefined;
  }

  private compactorLabel(c: { provider: string; model?: string }) {
    return `${this.providerName(c.provider)}${c.model ? ` · ${c.model}` : ''}`;
  }

  /** Run the compactor (no tools, nothing but the prompt) and return its text. */
  private async runCompactor(run: WorkflowRun, who: { provider: string; model?: string; effort?: string }, prompt: string, task: string): Promise<string> {
    const def = this.d.registry.defaults(who.provider);
    const info = this.newAgent(run, { role: 'compactor', provider: who.provider, model: who.model || def.model, effort: who.effort || def.effort, depth: 0, task });
    const res = await this.invoke(run, info, prompt, 'readonly');
    info.status = res.error && !res.finalText.trim() ? 'failed' : 'completed';
    info.error = res.error;
    info.endedAt = now();
    info.activity = undefined;
    this.touch(run);
    if (!res.finalText.trim()) throw new Error(res.error ?? L('壓縮者沒有回覆內容', 'The compactor returned nothing'));
    return res.finalText.trim();
  }

  /** Facts kept verbatim outside the shared memory (structured data): orientation for the compactor. */
  private keptVerbatim(run: WorkflowRun): string {
    const parts = [`Goal: ${run.config.goal.slice(0, 2000)}`];
    if (run.plan) parts.push(`Plan: ${run.plan.summary}\n${run.plan.steps.map((s) => `${s.id}. ${s.title}`).join('\n')}`);
    for (const key of ['plan', 'implement'] as StageKey[]) {
      const last = [...run.stages[key].rounds].reverse().find((r) => r.review);
      if (last?.review?.verdict === 'revise') parts.push(`Open ${key} review issues:\n${last.review.issues.map((i) => `${i.id} ${i.title}`).join('\n')}`);
      for (const r of run.stages[key].rounds) if (r.userFeedback) parts.push(`User feedback: ${r.userFeedback}`);
    }
    return parts.join('\n\n');
  }

  /** What a summary must still mention: file paths and review issue ids found in the material. */
  private mustKeep(run: WorkflowRun, material: string): string[] {
    // Paths with a known file extension only ("require/module.exports" is not a file).
    const paths = material.match(/(?:[A-Za-z]:)?(?:[\w.-]+[\\/])*[\w-][\w.-]*\.(?:tsx?|jsx?|mjs|cjs|json|md|py|go|rs|java|kt|cs|cpp|h|css|scss|html|vue|svelte|ya?ml|toml|ini|sh|ps1|bat|sql|txt|csv|lock)\b/g) ?? [];
    const ids = Object.values(run.stages).flatMap((s) => s.rounds.flatMap((r) => r.review?.issues.map((i) => i.id) ?? []));
    const issueIds = ids.filter((id) => new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(material));
    return [...new Set([...paths, ...issueIds])].slice(0, 60);
  }

  /** Compact the shared context now (one at a time per conversation). */
  compactSharedNow(id: string): void {
    const run = this.runs.get(id);
    if (!run) throw new Error(L('找不到工作流', 'Workflow not found'));
    if (sharingOf(run) === 'summary') throw new Error(L('這段對話的共用上下文是「只交摘要」，沒有需要壓縮的內容', 'This conversation shares summaries only; there is nothing to compact'));
    void this.compactShared(run, 'manual').catch((e) => this.log(run, L(`壓縮共用上下文失敗：${(e as Error).message}`, `Compacting the shared context failed: ${(e as Error).message}`), 'warn', true));
  }

  private compactShared(run: WorkflowRun, reason: 'auto' | 'manual'): Promise<void> {
    const busy = this.compactingShared.get(run.id);
    if (busy) return busy;
    const p = this.doCompactShared(run, reason).finally(() => {
      this.compactingShared.delete(run.id);
      if (run.compacting?.target === 'shared') run.compacting = undefined;
      this.touch(run);
    });
    this.compactingShared.set(run.id, p);
    return p;
  }

  private async doCompactShared(run: WorkflowRun, reason: 'auto' | 'manual') {
    const upto = now();
    const prev = run.memory?.upto ?? 0;
    const notes = (run.notes ?? []).filter((n) => n.ts > prev && n.ts <= upto);
    const agents = Object.values(run.agents).filter((a) => a.role !== 'test' && a.role !== 'compactor' && a.endedAt && a.endedAt > prev && a.endedAt <= upto);
    const material = [
      run.memory?.summary ? `PREVIOUS SHARED MEMORY:\n${run.memory.summary}` : '',
      notes.length ? `SHARED NOTES:\n${notes.map((n) => `- [${run.agents[n.agentId] ? `${roleLabel(run.agents[n.agentId].role)} ${run.agents[n.agentId].provider}` : 'agent'}] ${n.text}`).join('\n')}` : '',
      agents.length ? `AGENT RESULTS:\n${agents.map((a) => `- ${agentLabel(a)}: ${(agentResult(run, a) || a.finalText || '').trim().slice(0, 1500) || '—'}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    if (!notes.length && !agents.length) {
      if (reason === 'manual') throw new Error(L('上次壓縮後還沒有新的內容可以壓縮', 'Nothing new to compact since the last compaction'));
      return;
    }
    // A summary of very little is not shorter than the original.
    const size = estimateTokens(material);
    if (size < MIN_COMPACT_TOKENS) {
      if (reason === 'manual') throw new Error(L(`目前可以壓縮的內容只有約 ${fmtK(size)} token，壓縮也不會變小`, `Only about ${fmtK(size)} tokens could be compacted; a summary would not be smaller`));
      return;
    }
    const who = this.compactorFor(run);
    if (!who) throw new Error(L('沒有已登入的 CLI 可以壓縮', 'No signed-in CLI can compact'));
    const label = this.compactorLabel(who);
    this.refreshShared(run);
    const before = run.sharedTokens ?? 0;
    run.compacting = { target: 'shared', by: label, startedAt: now() };
    this.log(run, L(`${reason === 'auto' ? '共用上下文快滿了，' : ''}正在由 ${label} 壓縮共用上下文…`, `${reason === 'auto' ? 'The shared context is nearly full; ' : ''}${label} is compacting it…`), 'info', true);
    this.touch(run);
    const kept = this.keptVerbatim(run);
    const target = Math.max(300, Math.min(8000, Math.round(estimateTokens(material) * 0.25)));
    const required = this.mustKeep(run, material);
    const task = L('壓縮共用上下文', 'Compact the shared context');
    let summary = await this.runCompactor(run, who, P.compactSharedPrompt(material, kept, target), task);
    let missing = required.filter((r) => !summary.includes(r));
    // One more try with the list of what it dropped; whatever is still missing is kept word for word.
    if (missing.length) {
      summary = await this.runCompactor(run, who, P.compactSharedPrompt(material, kept, target, missing), task);
      missing = required.filter((r) => !summary.includes(r));
    }
    if (missing.length) summary += `\n\n## Kept verbatim\n${missing.map((m) => `- ${m}`).join('\n')}`;
    const previous = run.memory;
    run.memory = { summary, upto, updatedAt: now(), by: label, before, kept: missing.length ? missing : undefined };
    this.refreshShared(run);
    // Not smaller: keep what was there.
    if ((run.sharedTokens ?? 0) >= before) {
      run.memory = previous;
      this.refreshShared(run);
      this.noGainAt.set(run.id, before);
      this.log(run, L(`壓縮後沒有變小（${label}），保留原本的共用上下文`, `The summary was not smaller (${label}); the shared context stays as it was`), 'info', true);
      return;
    }
    run.memory.after = run.sharedTokens;
    this.log(
      run,
      L(`已壓縮共用上下文：約 ${fmtK(before)} → ${fmtK(run.sharedTokens ?? 0)}（${label}）${missing.length ? `，另外逐字保留 ${missing.length} 項摘要漏掉的內容` : ''}。原文仍可用 read_context 讀取。`, `Shared context compacted: about ${fmtK(before)} → ${fmtK(run.sharedTokens ?? 0)} (${label})${missing.length ? `; ${missing.length} item(s) the summary dropped were kept word for word` : ''}. The originals stay readable with read_context.`),
      'info',
      true,
    );
  }

  /** An agent's conversation passed the ask threshold (80% by default, again at 90%): let the user decide. */
  private checkContextAsk(run: WorkflowRun, info: AgentRunInfo) {
    const sid = info.sessionId;
    const c = info.context;
    if (!sid || !c?.used || !c.window || info.role === 'compactor') return;
    const askAt = run.config.context?.agentAskAt ?? 0.8;
    if (!askAt) return;
    const ratio = c.used / c.window;
    if (ratio < askAt || (run.contextMuted ?? []).includes(sid)) return;
    const level = ratio >= 0.9 && askAt < 0.9 ? 0.9 : askAt;
    if (((run.contextAsked ??= {})[sid] ?? 0) >= level) return;
    run.contextAsked[sid] = level;
    run.contextAsk = { agentId: info.id, used: c.used, window: c.window, level };
    this.log(run, L(`${this.label(info)} 的對話已用 ${Math.round(ratio * 100)}%（${fmtK(c.used)} / ${fmtK(c.window)}）`, `${this.label(info)}'s conversation is ${Math.round(ratio * 100)}% full (${fmtK(c.used)} / ${fmtK(c.window)})`), 'warn', true);
    this.touch(run);
  }

  /** The user's answer to the ask: compact now, later (asked again at 90%), or never for this conversation. */
  answerContextAsk(id: string, action: 'compact' | 'later' | 'mute'): void {
    const run = this.runs.get(id);
    if (!run?.contextAsk) return;
    const agentId = run.contextAsk.agentId;
    const sid = run.agents[agentId]?.sessionId;
    run.contextAsk = undefined;
    if (action === 'mute' && sid) (run.contextMuted ??= []).push(sid);
    if (action === 'compact') this.compactAgentNow(id, agentId);
    this.touch(run);
  }

  /** Compact one agent's own conversation: right away, or before its next turn when it is working right now. */
  compactAgentNow(id: string, agentId: string): void {
    const run = this.runs.get(id);
    const info = run?.agents[agentId];
    if (!run || !info?.sessionId) throw new Error(L('這個 agent 沒有可以壓縮的對話', 'This agent has no conversation to compact'));
    const sid = info.sessionId;
    if (this.agentCompactions.has(sid)) return;
    if (Object.values(run.agents).some((a) => a.sessionId === sid && a.status === 'running')) {
      this.queuedAgentCompact.set(sid, agentId);
      this.log(run, L(`${this.label(info)} 正在工作，這一輪結束後再壓縮它的對話`, `${this.label(info)} is working; its conversation is compacted after this turn`), 'info', true);
      return;
    }
    this.startAgentCompaction(run, info);
  }

  private startAgentCompaction(run: WorkflowRun, info: AgentRunInfo): Promise<void> {
    const sid = info.sessionId!;
    const p = this.doCompactAgent(run, info)
      .catch((e) => this.log(run, L(`壓縮 ${this.label(info)} 的對話失敗：${(e as Error).message}`, `Compacting ${this.label(info)}'s conversation failed: ${(e as Error).message}`), 'warn', true))
      .finally(() => {
        this.agentCompactions.delete(sid);
        if (run.compacting?.target === info.id) run.compacting = undefined;
        this.touch(run);
      });
    this.agentCompactions.set(sid, p);
    return p;
  }

  private async doCompactAgent(run: WorkflowRun, info: AgentRunInfo) {
    const sid = info.sessionId!;
    const spec = this.d.registry.get(info.provider);
    if (!spec) throw new Error(L(`未知的供應商：${info.provider}`, `Unknown provider: ${info.provider}`));
    const before = info.context?.used;
    const native = spec.output === 'codex-jsonl' ? 'codex' : spec.output === 'claude-stream' || spec.output === 'agy-stream' ? 'slash' : undefined;
    const who = native ? undefined : this.compactorFor(run);
    run.compacting = { target: info.id, by: native ? this.providerName(info.provider) : who && this.compactorLabel(who), startedAt: now() };
    this.log(run, L(`正在壓縮 ${this.label(info)} 的對話…`, `Compacting ${this.label(info)}'s conversation…`), 'info', true);
    this.touch(run);
    // A kept-alive CLI on this conversation would race the compaction.
    await this.pool.closeSessions([sid]);
    let after: number | undefined;
    if (native === 'codex') {
      await compactCodexThread(spec, sid);
      // Right after compacting Codex reports 0; the real size comes with the next turn.
      const c = codexContext(spec, sid);
      after = c?.used || undefined;
      info.context = { ...info.context, window: c?.window ?? info.context?.window, used: after, compactedAt: now() };
    } else if (native === 'slash') {
      // The CLI's own /compact, sent into its conversation.
      const helper = this.newAgent(run, { role: 'compactor', provider: info.provider, model: this.requestedModel.get(info.id) ?? info.model, depth: 0, task: L(`壓縮 ${this.label(info)} 的對話`, `Compact ${this.label(info)}'s conversation`) });
      const res = await this.invoke(run, helper, '/compact', 'readonly', sid);
      helper.status = res.error ? 'failed' : 'completed';
      helper.error = res.error;
      helper.endedAt = now();
      helper.activity = undefined;
      await this.pool.closeSessions([sid]);
      if (res.error) throw new Error(res.error);
      info.context = { ...info.context, used: undefined, compactedAt: now() };
    } else {
      // Not compactable from outside: a hand-off summary, and the next turn starts a fresh conversation from it.
      if (!who) throw new Error(L('沒有已登入的 CLI 可以整理交接摘要', 'No signed-in CLI can write the hand-off summary'));
      const turns = Object.values(run.agents).filter((a) => a.sessionId === sid).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
      const transcript = turns.map((a) => formatTranscript(this.events(run.id, a.id), { budget: 120000 })).join('\n\n---\n\n');
      const summary = await this.runCompactor(run, who, P.handoffSummaryPrompt(agentLabel(info), transcript, 3000), L(`整理 ${this.label(info)} 的交接摘要`, `Hand-off summary of ${this.label(info)}`));
      // The slot this conversation fills (its stage's author or reviewer) starts fresh next turn, from the summary.
      const stage = info.stage ? run.stages[info.stage] : undefined;
      const reviewer = info.role === 'plan_reviewer' || info.role === 'code_reviewer';
      if (stage && reviewer) (stage.reviewerSessionId = undefined), (stage.reviewerHandoff = summary);
      else if (stage) (stage.authorSessionId = undefined), (stage.authorHandoff = summary);
      for (const a of turns) a.sessionId = undefined;
      after = estimateTokens(summary);
      info.context = { ...info.context, used: after, compactedAt: now() };
    }
    this.log(
      run,
      L(`已壓縮 ${this.label(info)} 的對話${before ? `：約 ${fmtK(before)} → ${after ? fmtK(after) : '下一輪更新'}` : ''}`, `Compacted ${this.label(info)}'s conversation${before ? `: about ${fmtK(before)} → ${after ? fmtK(after) : 'updated next turn'}` : ''}`),
      'info',
      true,
    );
  }

  /** The model limit to size the shared context for: this agent's, or its conversation's earlier reading, or the catalog's. */
  private async windowFor(run: WorkflowRun, info: AgentRunInfo, resume?: string): Promise<number | undefined> {
    if (info.context?.window) return info.context.window;
    const earlier = resume ? Object.values(run.agents).filter((a) => a.sessionId === resume && a.context?.window).pop() : undefined;
    return earlier?.context?.window ?? (await this.catalogWindow(info.provider, this.requestedModel.get(info.id) ?? info.model));
  }

  /** The provider's profile narrowed to what this model reads (from the model list), for attachments. */
  private async modelProfile(provider: string, spec: ProviderSpec, model?: string): Promise<ProviderSpec['profile']> {
    const models = await this.d.registry.listModels(provider).catch(() => [] as ModelInfo[]);
    const id = model ?? this.d.registry.defaults(provider).model;
    return profileForInputs(spec.profile, models.find((m) => m.id === id)?.inputs);
  }

  /** A model's context size as the model menus show it (what a run measured, the CLI's list, or the catalog). */
  private async catalogWindow(provider: string, model?: string): Promise<number | undefined> {
    const key = `${provider} ${model ?? ''}`;
    if (this.catalogWindows.has(key)) return this.catalogWindows.get(key);
    const models = await this.d.registry.listModels(provider).catch(() => [] as ModelInfo[]);
    const id = model ?? this.d.registry.defaults(provider).model;
    const w = models.find((m) => m.id === id)?.context;
    this.catalogWindows.set(key, w);
    return w;
  }

  /** After a turn: Codex's reading from its rollout file, and a catalog limit when the CLI gave none. */
  private async readAgentContext(info: AgentRunInfo, spec: ProviderSpec, sessionId?: string) {
    if (spec.output === 'codex-jsonl' && sessionId) {
      try {
        const c = codexContext(spec, sessionId);
        if (c) info.context = { ...info.context, ...c };
      } catch {
        // no reading this time
      }
    }
    if (info.context?.used && !info.context.window) {
      const w = await this.catalogWindow(info.provider, this.requestedModel.get(info.id) ?? info.model);
      if (w) info.context = { ...info.context, window: w };
    }
  }

  // ---------- advisor ----------

  /**
   * Claude's own advisor model for this agent, or undefined. Claude Code ignores an advisor weaker than the agent's
   * model, and refuses to start for a model that can't advise or a main model that can't take one; in those cases the
   * agent runs without the flag and the conversation says why (once per pairing).
   */
  private nativeAdvisorFor(run: WorkflowRun, info: AgentRunInfo, adv?: AdvisorConfig): string | undefined {
    if (adv?.mode !== 'claude' || info.role === 'advisor') return undefined;
    const advisor = adv.claudeModel || 'opus';
    const main = info.model || this.d.registry.defaults(info.provider).model;
    const pairing = advisorPairing(main, advisor);
    if (pairing === 'ok' || pairing === 'unknown') return advisor;
    const key = `${run.id}|${main}|${advisor}`;
    if (!this.advisorWarned.has(key)) {
      this.advisorWarned.add(key);
      const msg = {
        weaker: L(`Claude 顧問 ${advisor} 比 ${this.label(info)} 的模型 ${main} 弱，Claude Code 不會使用它；用這個模型的 agent 這次沒有顧問。請在顧問設定改選更強的模型。`, `The Claude advisor ${advisor} is weaker than ${main} used by ${this.label(info)}, so Claude Code would not use it; agents on this model run without an advisor. Pick a stronger advisor model.`),
        'not-advisor': L(`${advisor} 不能當 Claude 顧問（例如 Haiku 4.5），這次不使用顧問。請在顧問設定改選其他模型。`, `${advisor} cannot act as a Claude advisor (e.g. Haiku 4.5); running without an advisor. Pick another advisor model.`),
        'main-unsupported': L(`${this.label(info)} 的模型 ${main} 不支援 Claude 顧問，這次不使用顧問。`, `${main} used by ${this.label(info)} does not support the Claude advisor; running without one.`),
      }[pairing];
      this.log(run, msg, 'warn', true);
    }
    return undefined;
  }

  /**
   * An advisor's sub-agents come in rounds: a spawn after one of its earlier sub-agents reported back starts a new round
   * (the advisor read the results and digs again); spawns in a row before that are one parallel round.
   */
  private nextFactRound(run: WorkflowRun, advisor: AgentRunInfo, child: AgentRunInfo): number {
    const st = this.factRounds.get(advisor.id) ?? { round: 0, lastSpawnAt: 0 };
    const reported = Object.values(run.agents).some((a) => a.parentId === advisor.id && a.id !== child.id && a.endedAt && a.endedAt > st.lastSpawnAt);
    if (!st.round || reported) st.round++;
    st.lastSpawnAt = now();
    this.factRounds.set(advisor.id, st);
    this.factRoundOf.set(child.id, st.round);
    return st.round;
  }

  /** Told to the advisor with each finished sub-agent report: which round it was, and whether it may look itself now. */
  private factRoundNote(run: WorkflowRun, child: AgentRunInfo): Record<string, unknown> {
    const round = this.factRoundOf.get(child.id);
    if (!round) return {};
    const limit = factRoundsOf(run.config.advisor);
    return {
      fact_finding_round: round,
      advisor_note: !limit
        ? `Round ${round}: if this report is incomplete, vague or doubtful, send a sub-agent again with a sharper task; you do not read the code yourself.`
        : round >= limit
          ? `This was fact-finding round ${round}. If the reports still do not give you the fact you need, you may now read those specific files yourself (read-only, only what is missing).`
          : `Round ${round} of ${limit}: if this report is incomplete, vague or doubtful, send a sub-agent again with a sharper task instead of reading the code yourself.`,
    };
  }

  /** Cross-vendor advisor mode is on and has someone to ask. */
  private crossAdvisor(run: WorkflowRun): boolean {
    const a = run.config.advisor;
    return a?.mode === 'cross' && !!a.provider && !!this.d.registry.get(a.provider);
  }

  /**
   * `ask_advisor`: a stronger (possibly other-vendor) model reads the whole situation and advises.
   * Runs as a read-only child agent; its advice also becomes a shared note.
   */
  private async askAdvisor(run: WorkflowRun, asker: AgentRunInfo, args: Record<string, unknown>): Promise<string> {
    const cfg = run.config.advisor!;
    const question = String(args.question ?? '').trim();
    if (!question) throw new Error('question is required');
    const context = String(args.context ?? '').trim().slice(0, 30000);
    const used = Object.values(run.agents).filter((a) => a.role === 'advisor').length;
    const max = Math.max(1, cfg.maxCalls ?? 5);
    if (used >= max) throw new Error(`The advisor was already consulted ${used} times in this conversation (limit ${max}). Continue on your own.`);
    const def = this.d.registry.defaults(cfg.provider!);
    const child = this.newAgent(run, {
      role: 'advisor',
      provider: cfg.provider!,
      model: cfg.model || def.model,
      effort: cfg.effort || def.effort,
      parentId: asker.id,
      // Same level as the asker: the advisor works on its behalf, so it may send helpers just as the asker could.
      depth: asker.depth,
      stage: asker.stage,
      round: asker.round,
      task: question.slice(0, 400),
    });
    this.log(run, L(`${this.label(asker)} 請教顧問 ${this.providerName(cfg.provider!)}`, `${this.label(asker)} consulted the advisor ${this.providerName(cfg.provider!)}`));
    // Only the latest part of the asker's transcript: the question and context carry the rest, and the advisor is the priciest reader.
    const recent = formatTranscript(this.events(run.id, asker.id), { budget: context ? 12000 : 30000 });
    const prompt = P.advisorPrompt(run.config, agentLabel(asker), question, context, overview(run, (aid) => this.events(run.id, aid)), recent, this.subBlock(run, child.depth), factRoundsOf(cfg));
    const done = this.invokePausable(run, child, prompt, 'readonly')
      .then((res) => {
        child.status = this.aborted(run) ? 'cancelled' : res.error && !res.finalText ? 'failed' : 'completed';
        child.error = res.error;
        const advice = res.finalText.trim();
        // Later agents see the advice too.
        if (advice) (run.notes ??= []).push({ id: randomUUID().slice(0, 8), agentId: child.id, text: `${L('顧問建議', 'Advisor')} → ${this.label(asker)}: ${advice.slice(0, 1500)}`, ts: now() });
      })
      .catch((e) => {
        child.status = 'failed';
        child.error = String(e?.message ?? e);
      })
      .finally(() => {
        if (child.status === 'running') child.status = 'cancelled';
        child.endedAt = now();
        child.activity = undefined;
        this.touch(run);
      });
    this.agentDone.set(child.id, done);
    // Most advice arrives within a tool call's time limit; otherwise hand back an id to wait on.
    await Promise.race([done, sleep(55000)]);
    if (child.status === 'running' || child.status === 'queued') {
      return JSON.stringify({ advisor_id: child.id, status: 'running', hint: `The advisor is still thinking. Call wait_subagent {"subagent_id": "${child.id}"} to get the advice.` });
    }
    if (child.status !== 'completed') throw new Error(`The advisor failed: ${child.error ?? child.status}`);
    return JSON.stringify({ advisor: `${this.providerName(child.provider)}${child.model ? ` (${child.model})` : ''}`, advice: (child.finalText ?? '').slice(0, 20000), calls_left: max - used - 1 });
  }

  private cancelChildren(run: WorkflowRun, parentId: string) {
    for (const a of Object.values(run.agents)) {
      // A handed-off sub-agent keeps running; it ends with the workflow.
      if (a.parentId === parentId && !a.handoff && (a.status === 'running' || a.status === 'queued')) {
        this.log(run, L(`${this.label(a)} 的上層 agent 已結束，停止此 sub agent`, `${this.label(a)}: its parent finished, stopping this sub-agent`), 'warn');
        this.agentAborts.get(a.id)?.abort();
      }
    }
  }

  // ---------- helpers ----------

  private gitStamps = new Map<string, string>();

  private async describeChanges(run: WorkflowRun): Promise<string> {
    const cwd = run.config.cwd;
    // An agent that rewrote the git config could make git run its programs here, outside the agent's sandbox.
    const stamp = gitStamp(cwd);
    const trusted = !!stamp && this.gitStamps.get(run.id) === stamp;
    if (stamp && !trusted) this.log(run, L('git 設定在工作中被改動，為了安全這次不執行 git 來整理變更', 'The git configuration changed during the run, so Aivenue skips git when summarizing changes'), 'warn');
    const st = trusted ? await safeGit(cwd, ['status', '--porcelain'], { timeoutMs: 15000 }) : { code: 1, stdout: '' };
    if (st.code === 0) {
      const stat = await safeGit(cwd, ['diff', '--stat', '--no-ext-diff', '--no-textconv'], { timeoutMs: 15000 });
      return [`git status --porcelain:\n${st.stdout.trim() || '(clean)'}`, stat.stdout.trim() ? `git diff --stat:\n${stat.stdout.trim()}` : ''].filter(Boolean).join('\n\n');
    }
    const files = new Set<string>();
    for (const a of Object.values(run.agents)) if (a.stage === 'implement') a.stats.filesChanged.forEach((f) => files.add(f));
    return files.size ? [...files].map((f) => `- ${f}`).join('\n') + '\n(not a git repository; list collected from agent tool calls)' : '';
  }

  private ask(run: WorkflowRun, stage: HumanDecision['stage'], message: string, options: { id: string; label: string }[], allowText = true): Promise<{ optionId: string; text?: string }> {
    const wf = this.aborts.get(run.id);
    return new Promise((resolve, reject) => {
      if (!wf || wf.signal.aborted) return reject(new Cancelled());
      const onAbort = () => {
        this.decisionWaiters.delete(run.id);
        reject(new Cancelled());
      };
      wf.signal.addEventListener('abort', onAbort, { once: true });
      run.pending = { id: randomUUID().slice(0, 8), stage, message, options, allowText };
      run.status = 'waiting_human';
      this.touch(run);
      this.decisionWaiters.set(run.id, (dec) => {
        wf.signal.removeEventListener('abort', onAbort);
        this.decisionWaiters.delete(run.id);
        const label = run.pending?.options.find((o) => o.id === dec.optionId)?.label ?? dec.optionId;
        run.pending = undefined;
        run.status = 'running';
        this.log(run, `${L('你的決定', 'Your decision')}: ${label}${dec.text ? ` — ${dec.text}` : ''}`, 'info', true);
        this.touch(run);
        resolve(dec);
      });
    });
  }

  /** Sleep that ends early when the run or this agent is stopped. */
  private async sleepFor(run: WorkflowRun, info: AgentRunInfo, ms: number) {
    const until = now() + ms;
    while (now() < until && !this.aborted(run) && !this.stoppedByUser.has(info.id)) await sleep(Math.min(1000, until - now()));
  }

  private noteGpus(run: WorkflowRun, info: AgentRunInfo, gpus: number[]) {
    (run.gpuLocks ??= []).push({ gpus, agentId: info.id, since: now() });
    this.log(run, L(`${this.label(info)} 鎖定 GPU ${gpus.join(', ')}`, `${this.label(info)} locked GPU ${gpus.join(', ')}`), 'info', true);
    this.touch(run);
  }

  /** wait_for: check a condition every interval until it holds (then lock GPUs if asked), up to ~50 s per call. */
  private async waitFor(run: WorkflowRun, info: AgentRunInfo, args: Record<string, unknown>): Promise<string> {
    const wid = typeof args.wait_id === 'string' ? args.wait_id.trim() : '';
    let w = wid ? run.waits?.find((x) => x.id === wid) : undefined;
    if (wid && !w) throw new Error(`Unknown wait_id ${wid}`);
    if (!w) {
      const check = String(args.check ?? '').trim();
      if (!check) throw new Error('check is required');
      w = this.resources.newWait(info.id, { check: check.slice(0, 2000), contains: typeof args.contains === 'string' ? args.contains.slice(0, 300) : undefined, interval_sec: Number(args.interval_sec) || undefined, timeout_min: Number(args.timeout_min) || undefined, gpus: Number(args.gpus) || undefined });
      run.waits = [...(run.waits ?? []).filter((x) => x.state === 'waiting').slice(-49), w];
    }
    // After a restart another turn of the agent continues it.
    w.agentId = info.id;
    let gpus: number[] | undefined;
    const until = now() + 50000;
    info.waiting = L(`等待條件：${w.check.slice(0, 80)}${w.gpus ? `（之後鎖定 ${w.gpus} 張 GPU）` : ''}`, `Waiting for: ${w.check.slice(0, 80)}${w.gpus ? ` (then lock ${w.gpus} GPU)` : ''}`);
    this.touch(run);
    try {
      while (w.state === 'waiting' && !this.aborted(run) && !this.stoppedByUser.has(info.id)) {
        if (now() > w.timeoutAt) {
          w.state = 'timeout';
          break;
        }
        if (now() >= (w.lastCheck ?? 0) + w.intervalSec * 1000) {
          const c = await this.resources.check(w, run.config.cwd);
          w.lastCheck = now();
          w.lastOutput = c.output.slice(-500);
          if (c.ok && !w.gpus) w.state = 'met';
          else if (c.ok) {
            const got = this.resources.acquire({ workflowId: run.id, agentId: info.id }, w.gpus!);
            if (got) {
              // Still true under the lock? Otherwise let the cards go and keep waiting.
              const again = await this.resources.check(w, run.config.cwd);
              if (again.ok) {
                gpus = got;
                w.state = 'met';
                this.noteGpus(run, info, got);
              } else this.resources.release(run.id, info.id, got);
            }
          }
          this.touch(run);
        }
        if (w.state !== 'waiting' || now() >= until) break;
        await this.sleepFor(run, info, Math.max(500, Math.min(until, (w.lastCheck ?? now()) + w.intervalSec * 1000, w.timeoutAt) - now()));
      }
    } finally {
      info.waiting = undefined;
      this.touch(run);
    }
    const left = Math.max(0, Math.round((w.timeoutAt - now()) / 60000));
    return JSON.stringify({
      wait_id: w.id,
      status: w.state,
      last_output: w.lastOutput,
      ...(gpus ? { gpus, hint: `Run your job with CUDA_VISIBLE_DEVICES=${gpus.join(',')}; call gpu_release when it is done.` } : {}),
      ...(w.state === 'waiting' ? { minutes_left: left, hint: 'Not yet. Call wait_for {wait_id} again to keep waiting.' } : {}),
      ...(w.state === 'timeout' ? { hint: 'Timed out: the condition never held. Report it; do not treat the job as finished.' } : {}),
    });
  }

  /** An agent's turn ended: its GPU locks and waits go, and a process it should have stopped is reported. */
  private endAgentResources(run: WorkflowRun, info: AgentRunInfo) {
    const freed = this.resources.release(run.id, info.id);
    if (freed.length) {
      run.gpuLocks = (run.gpuLocks ?? []).filter((l) => l.agentId !== info.id);
      this.log(run, L(`${this.label(info)} 結束，釋放 GPU ${freed.join(', ')}`, `${this.label(info)} ended; released GPU ${freed.join(', ')}`));
    }
    for (const p of run.processes ?? []) {
      if (p.agentId !== info.id || p.cleanup !== 'agent') continue;
      p.alive = pidAlive(p.pid);
      p.checkedAt = now();
      if (p.alive) this.log(run, L(`${this.label(info)} 結束了，但它負責清理的程序 ${p.pid}（${p.purpose}）還在執行`, `${this.label(info)} ended but process ${p.pid} (${p.purpose}) it was to clean up is still running`), 'warn', true);
    }
  }

  /** The run ended: every lock goes, open waits are cancelled, processes Aivenue owns are stopped. */
  private endRunResources(run: WorkflowRun) {
    const t = this.watchdogs.get(run.id);
    if (t) clearInterval(t);
    this.watchdogs.delete(run.id);
    this.incompleteWhy.delete(run.id);
    this.resources.release(run.id);
    run.gpuLocks = [];
    for (const w of run.waits ?? []) if (w.state === 'waiting') w.state = 'cancelled';
    for (const p of run.processes ?? []) {
      if (p.cleanup === 'aivenue' && pidAlive(p.pid)) {
        killPid(p.pid);
        this.log(run, L(`已停止背景程序 ${p.pid}（${p.purpose}）`, `Stopped background process ${p.pid} (${p.purpose})`));
      }
      p.alive = pidAlive(p.pid);
      p.checkedAt = now();
    }
  }

  /** Every 15 s while a run is active: limits, stalled sub-agents, background processes. */
  private startWatchdog(run: WorkflowRun) {
    const t = setInterval(() => this.watch(run), 15000);
    t.unref?.();
    this.watchdogs.set(run.id, t);
  }

  private watch(run: WorkflowRun) {
    if (!['running', 'waiting_human', 'paused'].includes(run.status)) return;
    const lim = run.config.limits;
    // Time and cost: the run stops as incomplete (a cycle limit is checked between cycles).
    const hit = run.status !== 'paused' ? limitHit(lim ? { ...lim, maxCycles: undefined } : undefined, { startedAt: run.createdAt, now: now(), costUsd: this.runCost(run), cycles: 0 }) : undefined;
    if (hit) {
      this.incompleteWhy.set(run.id, hit);
      this.cancel(run.id);
      return;
    }
    if (lim?.enabled && lim.noProgressMinutes && run.status === 'running' && !run.pending) {
      const quiet = now() - Math.max(run.lastProgressAt ?? run.createdAt, this.noProgressAskedAt.get(run.id) ?? 0);
      if (quiet > lim.noProgressMinutes * 60000) {
        this.noProgressAskedAt.set(run.id, now());
        void this.ask(run, 'run', L(`已經 ${lim.noProgressMinutes} 分鐘沒有進展（沒有工具呼叫、檔案變更或提交）。要怎麼處理？`, `No progress for ${lim.noProgressMinutes} minutes (no tool call, file change or submission). What next?`), [
          { id: 'continue', label: L('繼續等', 'Keep going') },
          { id: 'stop', label: L('停止（標記為未完成）', 'Stop (mark incomplete)') },
        ])
          .then((d) => {
            if (d.optionId !== 'stop') return;
            this.incompleteWhy.set(run.id, L(`${lim.noProgressMinutes} 分鐘沒有進展`, `no progress for ${lim.noProgressMinutes} min`));
            this.cancel(run.id);
          })
          .catch(() => undefined);
      }
    }
    let changed = false;
    for (const a of Object.values(run.agents)) {
      if (a.role !== 'subagent' || a.status !== 'running' || a.waiting || this.stallNoted.has(a.id)) continue;
      if (now() - (a.lastEventAt ?? a.startedAt ?? now()) < STALL_MS) continue;
      this.stallNoted.add(a.id);
      this.notifyParent(run, a, `sub-agent ${a.id} (${a.provider}) has shown no activity for ${Math.round(STALL_MS / 60000)} minutes; it may be stuck.`);
      changed = true;
    }
    for (const p of run.processes ?? []) {
      const alive = pidAlive(p.pid);
      p.checkedAt = now();
      if (alive !== p.alive) {
        p.alive = alive;
        changed = true;
      }
    }
    if (changed) this.touch(run);
  }

  private aborted(run: WorkflowRun) {
    return !!this.aborts.get(run.id)?.signal.aborted;
  }

  private checkCancelled(run: WorkflowRun) {
    if (this.aborted(run)) throw new Cancelled();
  }

  private providerName(id: string) {
    return this.d.registry.get(id)?.name ?? id;
  }

  private label(info: AgentRunInfo) {
    return `${roleLabel(info.role)} (${this.providerName(info.provider)})`;
  }

  private log(run: WorkflowRun, text: string, level: 'info' | 'warn' | 'error' = 'info', chat = false) {
    run.log.push({ ts: now(), text, level, chat });
    if (run.log.length > 500) run.log.splice(0, run.log.length - 500);
    this.touch(run);
  }

  private touch(run: WorkflowRun) {
    run.updatedAt = now();
    this.d.store.save(run);
    if (this.pushTimers.has(run.id)) return;
    this.pushTimers.set(
      run.id,
      setTimeout(() => {
        this.pushTimers.delete(run.id);
        this.d.push({ topic: 'workflow', data: run });
        this.d.push({ topic: 'workflows', data: this.summaries() });
      }, 250),
    );
  }
}
