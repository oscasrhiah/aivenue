// Shared types between the hub (core) and the UI. Keep this file free of Node imports.

/**
 * A group of CLI arguments. Tokens like `{sessionId}` are substituted at run time;
 * if any token in the group has no value, the whole group is dropped.
 */
export type ArgGroup = string[];

export type OutputFormat = 'claude-stream' | 'codex-jsonl' | 'gemini-stream' | 'agy-stream' | 'opencode-json' | 'copilot-json' | 'text';

export interface ProviderSpec {
  id: string;
  name: string;
  description?: string;
  /** Executable name on PATH or an absolute path. */
  command: string;
  /** Preferred executables checked before `command` (~ expands to home), e.g. a CLI bundled with a desktop app. */
  commandPaths?: string[];
  /** Shell command that installs the CLI (run in a visible terminal). */
  install?: string;
  /** Install command for a specific OS, used instead of `install` there (e.g. winget on Windows, a script elsewhere). */
  installOn?: Partial<Record<'win32' | 'darwin' | 'linux', string>>;
  docsUrl?: string;
  /** Interactive login: run `command ...args` in a new terminal window; the CLI opens the browser. */
  login?: { args: string[]; note?: string };
  logout?: { args: string[] };
  status?: {
    /** Command args to run; logged in when exit code is 0 and the checks below pass. */
    args?: string[];
    stdoutIncludes?: string;
    /** Dot path in JSON stdout that must be truthy, e.g. "loggedIn". */
    jsonPath?: string;
    /** Logged in if any of these files exist (~ expands to home). */
    files?: string[];
    /** Logged in if the file contains the text. */
    fileContains?: { path: string; text: string }[];
    /** Logged in if any of these environment variables is set. */
    env?: string[];
    /** Usable without signing in (e.g. free models) once installed. */
    ready?: boolean;
  };
  run: {
    /** Args that carry the user's role instructions ({systemPrompt}); without them the text is prepended to the prompt. */
    systemPrompt?: ArgGroup[];
    /** Native image input, rendered once per attached image ({image}); other files are referenced by path. */
    images?: ArgGroup[];
    /** Makes a folder outside the working folder readable, rendered once per extra folder ({extraDir}). */
    extraDir?: ArgGroup[];
    /** Environment needed to read outside the working folder; JSON object values are merged with modeEnv's. */
    extraDirEnv?: Record<string, string>;
    /** Always used. */
    common: ArgGroup[];
    /** Used for a fresh session. */
    fresh?: ArgGroup[];
    /** Used when continuing a session ({sessionId}). */
    resume?: ArgGroup[];
    /** Appended last (e.g. "-" to read the prompt from stdin). */
    tail?: ArgGroup[];
    env?: Record<string, string>;
    /** How the prompt is delivered. "arg" uses the {prompt} token. */
    prompt: 'stdin' | 'arg';
    /** For prompt "stdin": a line template written instead of the raw prompt, e.g. {"event":"user","message":{"content":{promptJson}}}. */
    stdinTemplate?: string;
    /** Args for the CLI's own advisor model ({advisorModel}), used in Claude-native advisor mode. */
    advisor?: ArgGroup[];
    /**
     * The CLI can stay running and take one message per stdin line (each turn ends with a result event).
     * Aivenue then keeps it open between turns of the same session instead of restarting it.
     */
    persistent?: { args: ArgGroup[]; stdinTemplate: string };
  };
  /**
   * For CLIs without a per-run MCP config option: Aivenue keeps one "aivenue" entry in the CLI's
   * own MCP config file. The entry reads the run's session from environment variables ($VAR
   * expansion), and the bridge proxies the shared MCP servers.
   */
  mcpRegistration?: {
    file: string;
    /** Allow-rules the CLI needs so its headless modes can call the bridge's tools (only these rules are added). */
    permissions?: { file: string; allow: string[] };
  };
  /**
   * Extra args per permission mode. write = full auto, readonly = reviewers in full auto;
   * plan / ask / edit = the user's permission levels (missing ones fall back to safer/looser ones).
   */
  modes?: { write?: ArgGroup[]; readonly?: ArgGroup[]; plan?: ArgGroup[]; ask?: ArgGroup[]; edit?: ArgGroup[] };
  /** Extra environment per permission mode. */
  modeEnv?: Partial<Record<ModeKey, Record<string, string>>>;
  /**
   * How the "ask" level behaves: "prompt-tool" = each action is approved in Aivenue
   * ({approvalTool} names the bridge tool); otherwise a description of the fallback shown to the user.
   */
  approvals?: { type: 'prompt-tool' } | { type: 'fallback'; zh: string; en: string };
  output: OutputFormat;
  /** Extra fields merged into this provider's MCP server entry (e.g. {"trust": true}). */
  mcpServerExtra?: Record<string, unknown>;
  /**
   * API-key mode (instead of the subscription login). The key is kept in the OS secret
   * store and handed to the CLI only through the environment of each run.
   */
  apiKey?: {
    /** Environment variable that receives the key. */
    env: string;
    /** Environment variable that receives the custom base URL (OpenAI/Anthropic-compatible endpoints). */
    baseUrlEnv?: string;
    /** Extra args in API mode. */
    args?: ArgGroup[];
    /** Extra environment variables in API mode. */
    extraEnv?: Record<string, string>;
    /** Merged into the top level of {mcpConfigFile} in API mode (Gemini reads it as system settings). */
    settingsExtra?: Record<string, unknown>;
    note?: string;
  };
  capabilities?: {
    /** Supports resuming a session by id. */
    resume?: boolean;
    /** Can load the Aivenue MCP bridge (needed for sub-agents and structured submissions). */
    mcp?: boolean;
  };
  /** Suggested models shown in the UI. */
  models?: string[];
  /** Model used when neither the role nor the user's provider settings choose one. */
  defaultModel?: string;
  /** Reasoning-effort levels the CLI accepts ({effort}). */
  efforts?: string[];
  /** Where to discover the available models: Codex's local cache, a CLI command that prints them, or the provider catalog. */
  modelSource?: { type: 'codex-cache' } | { type: 'command'; args: string[] } | { type: 'catalog'; providerId: string };
  /** Set for providers added from the catalog (run through OpenCode). */
  catalog?: { providerId: string; kind: CatalogProvider['kind'] };
  /** Built-in reader for the official plan quota the CLI stores locally. */
  quota?: { reader: 'codex-sessions' | 'antigravity' | 'copilot' | 'claude' };
  /**
   * Per-MCP-server args for CLIs that take servers as flags instead of {mcpConfigFile} (Codex).
   * Rendered once per server with {mcpName} {mcpCommandToml} {mcpArgsToml} {mcpEnvToml} {mcpEnvVarsToml}
   * {mcpUrlToml} {mcpHeadersToml} {mcpEnvHeadersToml}.
   */
  mcpFlags?: ArgGroup[];
  /** How HTTP MCP servers are written into {mcpConfigFile}: Claude ({type:"http",url}) or Gemini/Qwen ({httpUrl}). */
  mcpHttpStyle?: 'claude' | 'gemini';
  /** Schema of {mcpConfigFile} / {mcpConfigJson}: "standard" {"mcpServers":…} or OpenCode's {"mcp":…}. */
  mcpConfigFormat?: 'standard' | 'opencode';
  /** Strengths used by automatic role assignment (0–5; unspecified = 3). */
  profile?: ProviderProfile;
  /** Where the CLI keeps its own default model / effort (regex with one capture group, top-level keys only). */
  configDefaults?: { file: string; model?: string; effort?: string };
  /**
   * The CLI can run several accounts side by side: `env` points it at a config folder other than `home`
   * (its default, e.g. ~/.claude), so each account keeps its own sign-in.
   */
  accounts?: { env: string; home: string };
  /** Set on an extra account: the provider it is an account of, its name, and its config folder. */
  accountOf?: string;
  accountName?: string;
  accountHome?: string;
}

export type PermissionLevel = 'plan' | 'ask' | 'edit' | 'auto';
export type ModeKey = 'write' | 'readonly' | 'plan' | 'ask' | 'edit';

export interface ApprovalRequest {
  id: string;
  agentId: string;
  provider: string;
  tool: string;
  /** Short human-readable description (command line, file path…). */
  summary: string;
  input?: string;
  ts: number;
}

export interface ProviderProfile {
  plan?: number;
  review?: number;
  code?: number;
  /** Speed / generosity of the plan's limits. */
  speed?: number;
  /** Can look at images. */
  vision?: boolean;
  /** Reads PDF files natively (otherwise Aivenue's extracted text is used). */
  pdf?: boolean;
  /** Understands audio / video files. */
  audio?: boolean;
  video?: boolean;
}

// ---------- Automatic role assignment ----------

export interface AutoAssignPrefs {
  priority: 'quality' | 'balanced' | 'economy';
  /** Reviewer must be a different provider than the author. */
  crossReview: boolean;
  /** When an agent fails (e.g. usage limit), switch to the next best provider automatically. */
  failover: boolean;
}

export interface AssignmentResult {
  plan: { author?: string; reviewer?: string };
  implement: { author?: string; reviewer?: string };
  subagents: string[];
  notes: string[];
  /** Ranked candidates per role kind, best first (used for failover). */
  ranking: Record<'plan' | 'review' | 'code', string[]>;
}

// ---------- Capabilities shared by every agent ----------

/** A value that is either plain text or kept in the OS secret store. */
/**
 * A plain value, a secret kept in the secret store, or the GitHub CLI's signed-in token
 * (read when an agent starts, never stored by Aivenue), with an optional prefix such as "Bearer ".
 */
export type ConfigValue = string | { secret: true } | { ghToken: true; prefix?: string };

/** GitHub on this computer: git, the GitHub CLI and its sign-in. */
export interface GithubStatus {
  git: { installed: boolean; version?: string };
  gh: { installed: boolean; version?: string };
  auth: { loggedIn: boolean; user?: string; error?: string };
  /** git uses the gh sign-in for https://github.com (gh auth setup-git). */
  gitCredential: boolean;
  checkedAt: number;
}

export interface McpServerConfig {
  id: string;
  name?: string;
  enabled: boolean;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, ConfigValue>;
  url?: string;
  headers?: Record<string, ConfigValue>;
  /** Provider ids that get this server; empty = all. */
  providers?: string[];
  description?: string;
}

export type InstructionRole = 'all' | 'planner' | 'plan_reviewer' | 'executor' | 'code_reviewer' | 'subagent';

export interface CapabilitiesConfig {
  mcpServers: McpServerConfig[];
  instructions: Partial<Record<InstructionRole, string>>;
  /** Per-skill settings (skill content lives in <dataDir>/skills/<name>/SKILL.md). */
  skills: Record<string, { enabled: boolean; roles?: InstructionRole[] }>;
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  roles?: InstructionRole[];
  files: number;
}

export interface ProviderInfo {
  spec: ProviderSpec;
  builtin: boolean;
  /** Spec differs from the built-in default. */
  customized: boolean;
  installed: boolean;
  resolvedPath?: string;
  /** The install command for the hub's OS. */
  installCommand?: string;
  auth: { state: 'logged_in' | 'logged_out' | 'unknown' | 'checking'; detail?: string; checkedAt?: number };
  /** Subscription = the CLI's own login; api = API key stored by Aivenue. */
  authMode: AuthMode;
  hasApiKey: boolean;
  baseUrl?: string;
  /** Used when a role does not pick its own model / effort (also in auto assignment). */
  defaultModel?: string;
  defaultEffort?: string;
}

export type AuthMode = 'subscription' | 'api';

// ---------- Agent events (normalized across providers) ----------

export type ToolCategory = 'read' | 'edit' | 'command' | 'search' | 'web' | 'hub' | 'agent' | 'todo' | 'other';

export interface AgentEvent {
  seq: number;
  ts: number;
  kind: 'session' | 'message' | 'thinking' | 'tool' | 'error' | 'stderr' | 'result' | 'info' | 'prompt';
  text?: string;
  tool?: {
    id: string;
    name: string;
    category: ToolCategory;
    title: string;
    input?: string;
    output?: string;
    status: 'running' | 'ok' | 'error';
  };
  files?: string[];
  sessionId?: string;
  /** Token/cost usage reported by the CLI (usually on the final event). */
  usage?: TokenUsage;
}

export interface TokenUsage {
  input?: number;
  output?: number;
  cached?: number;
  costUsd?: number;
}

// ---------- Usage / quota ----------

export interface UsageTotals {
  runs: number;
  input: number;
  output: number;
  cached: number;
  costUsd: number;
  errors: number;
}

export interface ProviderUsage {
  providerId: string;
  today: UsageTotals;
  last7: UsageTotals;
  daily: ({ date: string } & UsageTotals)[];
  /** Last time the provider reported hitting a usage/rate limit. */
  limitHit?: { at: number; message: string };
  /** Official plan quota, when the CLI records it locally. */
  /** Official plan quota: read live from the CLI (codex-live) or from its local logs (codex-sessions, as of its last run). */
  official?: {
    plan?: string;
    /** minutes: the window length (0 = per model); label: shown instead of a window name (e.g. a model). */
    windows: { minutes: number; usedPercent: number; resetsAt?: number; label?: string; /** A second line under the meter (the models in a shared pool, request counts…). */ detail?: string }[];
    updatedAt: number;
    source: 'codex-sessions' | 'codex-live' | 'antigravity-live' | 'copilot-live' | 'claude-live';
    /** The account the numbers belong to (when known). */
    account?: string;
    limitReached?: boolean;
    /** Free "reset my limits" credits the account still has. */
    resetCredits?: number;
  };
  /** Why the official quota could not be read (e.g. a sign-in that expired). */
  officialError?: string;
  /** When these numbers were computed. */
  checkedAt?: number;
}

// ---------- App settings (stored by the hub so every shell shares them) ----------

export type Locale = 'zh-TW' | 'en';

export interface AppSettings {
  locale: Locale;
  theme: 'system' | 'light' | 'dark';
  accent: string;
  /** Last role configuration used for a new conversation. */
  draft?: Omit<WorkflowConfig, 'goal' | 'title'>;
}

// ---------- Workflow configuration ----------

export interface RoleConfig {
  provider: string;
  /** Empty = the provider's default model (Settings → Providers). */
  model?: string;
  /** Reasoning effort; empty = the provider's default. */
  effort?: string;
}

/** A provider from the models.dev catalog (usable through OpenCode). */
export interface CatalogProvider {
  id: string;
  name: string;
  /** Environment variables the provider uses (API key first). */
  env: string[];
  api?: string;
  npm?: string;
  doc?: string;
  /** plan = subscription (coding / token plan), api = pay-as-you-go, local = runs on this machine. */
  kind: 'plan' | 'api' | 'local';
  featured: boolean;
  models: CatalogModel[];
}

export interface CatalogModel {
  id: string;
  name: string;
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  context?: number;
  free?: boolean;
}

export interface ModelInfo {
  id: string;
  label?: string;
  description?: string;
  efforts?: string[];
  defaultEffort?: string;
}

export interface StageConfig {
  enabled: boolean;
  author: RoleConfig;
  /** null = no review, the author's output is accepted directly. */
  reviewer: RoleConfig | null;
  maxRounds: number;
  /** Pause for the user's approval after the reviewer approves. */
  humanGate: boolean;
}

export type ContextSharing = 'summary' | 'on_demand' | 'full';

/**
 * A stronger model agents can consult when stuck.
 * - claude: Claude Code's own advisor (`--advisor`), Claude agents only.
 * - cross: Aivenue's `ask_advisor` tool for every vendor; the advice is visible and kept as a shared note.
 */
export interface AdvisorConfig {
  mode: 'off' | 'claude' | 'cross';
  /** claude mode: the advisor model (e.g. opus, fable). */
  claudeModel?: string;
  /** cross mode: who advises. */
  provider?: string;
  model?: string;
  effort?: string;
  /** cross mode: consultations allowed per conversation (default 5). */
  maxCalls?: number;
}

/** An external action (push, PR, release…) the user denied. */
export interface DeniedAction {
  id: string;
  agentId: string;
  kind: string;
  target: string;
  details: string;
  /** What the user wrote when denying. */
  note?: string;
  ts: number;
  /** The follow-up run started by "allow and continue". */
  continuedIn?: string;
}

/** A note an agent shared with all later agents (`post_note`). */
export interface SharedNote {
  id: string;
  agentId: string;
  text: string;
  ts: number;
}

export interface SubagentConfig {
  enabled: boolean;
  /** Provider ids an agent may spawn. */
  allowed: string[];
  maxDepth: number;
  maxConcurrent: number;
  /** Model / reasoning effort per provider when it runs as a sub-agent (empty = provider default). */
  models?: Record<string, { model?: string; effort?: string }>;
}

export interface WorkflowConfig {
  title: string;
  goal: string;
  cwd: string;
  plan: StageConfig;
  implement: StageConfig;
  subagents: SubagentConfig;
  /**
   * Folders besides `cwd` that every agent may read and explore (like Claude Code's --add-dir),
   * e.g. a library's source or a docs folder. Absolute paths.
   */
  extraDirs?: string[];
  /** Files the user attached to the task (copied into the run folder when it starts). */
  attachments?: Attachment[];
  /** "auto" lets Aivenue pick providers per role when the run starts; "manual" (default) uses the roles as set. */
  assignment?: { mode: 'manual' | 'auto'; auto: AutoAssignPrefs };
  /** What agents may do without asking (default "auto"). */
  permission?: PermissionLevel;
  /** "worktree": agents work in a separate git worktree; the user applies the result afterwards. */
  isolation?: 'none' | 'worktree';
  /**
   * How much agents see of each other's work: hand-off summaries only; summaries plus `read_context`
   * on demand (default); or the previous agent's full transcript inlined in the prompt.
   */
  contextSharing?: ContextSharing;
  /** Advisor mode (off by default). */
  advisor?: AdvisorConfig;
  /** This message is an edited version of the one in that workflow. */
  replaces?: string;
  /** External actions the user approved in advance ("allow and continue" after a denial); each is used once. */
  preApproved?: { kind: string; target: string; details: string }[];
}

export interface Attachment {
  name: string;
  /** Absolute path on the hub machine. */
  path: string;
  size: number;
  mime: string;
  kind?: AttachmentKind;
  /** Agent-readable version made by Aivenue (extracted text, or an unpacked folder). */
  companion?: { path: string; type: 'text' | 'folder'; note?: string };
}

export interface OutputFile {
  /** Relative to the working folder. */
  path: string;
  abs: string;
  status: 'added' | 'modified' | 'deleted';
  size: number;
}

export type AttachmentKind = 'text' | 'image' | 'image-other' | 'pdf' | 'office' | 'legacy-office' | 'notebook' | 'archive' | 'audio' | 'video' | 'binary';

export interface WorkflowPreset {
  id: string;
  name: string;
  config: Omit<WorkflowConfig, 'goal' | 'cwd' | 'title'>;
}

// ---------- Workflow run state ----------

export type AgentRole = 'planner' | 'plan_reviewer' | 'executor' | 'code_reviewer' | 'subagent' | 'advisor' | 'test';
export type AgentStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface AgentRunInfo {
  id: string;
  workflowId: string;
  role: AgentRole;
  provider: string;
  model?: string;
  effort?: string;
  parentId?: string;
  depth: number;
  stage?: StageKey;
  round?: number;
  status: AgentStatus;
  task: string;
  startedAt?: number;
  endedAt?: number;
  sessionId?: string;
  resumed?: boolean;
  finalText?: string;
  error?: string;
  exitCode?: number | null;
  /** Latest thing the agent is doing, for the progress tree. */
  activity?: string;
  /** Ran read-only; its sub-agents may not get more. */
  readonly?: boolean;
  /** Tokens the CLI reported for this agent (all its turns). */
  tokens?: { input: number; output: number; cached: number };
  stats: { events: number; tools: number; commands: number; filesChanged: string[] };
}

export interface PlanStep {
  id: string;
  title: string;
  detail?: string;
  status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'skipped';
  note?: string;
}

export interface PlanDoc {
  summary: string;
  markdown: string;
  steps: { id: string; title: string; detail?: string }[];
}

export interface ReviewIssue {
  id: string;
  severity: 'blocker' | 'major' | 'minor';
  title: string;
  detail?: string;
  location?: string;
}

export interface Review {
  verdict: 'approve' | 'revise';
  summary: string;
  issues: ReviewIssue[];
}

export interface IssueResponse {
  issue_id: string;
  action: 'fixed' | 'rebutted';
  note?: string;
}

export type StageKey = 'plan' | 'implement';

export interface Round {
  n: number;
  authorAgentId?: string;
  reviewerAgentId?: string;
  /** What the author submitted (plan or work summary). */
  submission?: { summary: string; plan?: PlanDoc; responses?: IssueResponse[] };
  review?: Review;
  /** Feedback from the user that started this round. */
  userFeedback?: string;
}

export interface StageRun {
  key: StageKey;
  status: 'pending' | 'running' | 'approved' | 'skipped' | 'failed' | 'cancelled';
  rounds: Round[];
  authorSessionId?: string;
  reviewerSessionId?: string;
  /** Rounds allowed (grows when the user grants more). */
  roundLimit: number;
}

export interface HumanDecision {
  id: string;
  stage: StageKey;
  message: string;
  options: { id: string; label: string }[];
  allowText: boolean;
}

export type WorkflowStatus = 'running' | 'paused' | 'waiting_human' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface WorkflowRun {
  id: string;
  config: WorkflowConfig;
  status: WorkflowStatus;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  stages: Record<StageKey, StageRun>;
  plan?: PlanDoc;
  steps: PlanStep[];
  agents: Record<string, AgentRunInfo>;
  pending?: HumanDecision;
  error?: string;
  /** Result of automatic assignment (auto mode only). */
  assignment?: AssignmentResult;
  /** Files created / modified / deleted in the working folder during this run. */
  outputs?: OutputFile[];
  outputsTruncated?: boolean;
  /** Shared notes board (`post_note`), visible to every later agent and in the conversation. */
  notes?: SharedNote[];
  /** External actions the user denied in this run (shown with "allow and continue"). */
  deniedActions?: DeniedAction[];
  /** The message was edited and re-sent as that workflow. */
  replacedBy?: string;
  /** Screenshots agents took with `capture_screenshot` (PNG files under <cwd>/.aivenue/screenshots). */
  screenshots?: { path: string; url: string; agentId: string; width: number; height: number; ts: number }[];
  /** Actions waiting for the user's approval ("ask" permission level). */
  approvals?: ApprovalRequest[];
  /** Worktree isolation: where the agents work and what happened to the result. */
  worktree?: { path: string; branch: string; baseCommit: string; repo: string; origCwd: string; cwd: string; state: 'active' | 'applied' | 'discarded' | 'kept'; note?: string };
  /** `chat` entries are shown as divider lines in the conversation. */
  log: { ts: number; text: string; level: 'info' | 'warn' | 'error'; chat?: boolean }[];
}

export interface WorkflowSummary {
  id: string;
  title: string;
  status: WorkflowStatus;
  createdAt: number;
  updatedAt: number;
  cwd: string;
}

// ---------- Hub <-> UI protocol ----------

export interface RpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  id: number;
  result?: unknown;
  error?: string;
}

export type PushMessage =
  | { topic: 'workflow'; data: WorkflowRun }
  | { topic: 'workflows'; data: WorkflowSummary[] }
  | { topic: 'agentEvent'; data: { workflowId: string; agentId: string; event: AgentEvent } }
  | { topic: 'providers'; data: ProviderInfo[] }
  | { topic: 'settings'; data: AppSettings }
  | { topic: 'usage'; data: ProviderUsage[] }
  | { topic: 'github'; data: GithubStatus }
  | { topic: 'capabilities'; data: { config: CapabilitiesConfig; skills: SkillInfo[] } }
  | { topic: 'test'; data: { testId: string; providerId: string; event?: AgentEvent; isUpdate?: boolean; result?: TestResult } };

export interface TestResult {
  ok: boolean;
  finalText: string;
  error?: string;
  /** The agent successfully called the Aivenue MCP bridge. */
  mcpCalled: boolean;
  durationMs: number;
}

export interface HostInfo {
  host: 'desktop' | 'vscode' | 'browser';
  defaultCwd?: string;
  dataDir: string;
  version: string;
  canPickFolder: boolean;
  canPickFiles: boolean;
  /** API keys are encrypted by the OS (false in standalone browser mode). */
  secureSecrets: boolean;
}
