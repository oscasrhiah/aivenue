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
    /** Args that turn off every built-in tool, for text-only calls such as the context compactor. */
    noTools?: ArgGroup[];
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
  modes?: { write?: ArgGroup[]; readonly?: ArgGroup[]; plan?: ArgGroup[]; ask?: ArgGroup[]; edit?: ArgGroup[]; full?: ArgGroup[] };
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
  /** Models (regex on the model id) that take no reasoning effort: {effort} is left out of their command line. */
  noEffortModels?: string;
  /** models.dev providers to look a model's context size up in, when the model list has none (e.g. ["anthropic"]). */
  contextCatalog?: string[];
  /** Where to discover the available models: Codex's local cache, a CLI command that prints them, or the provider catalog. */
  modelSource?: { type: 'codex-cache' } | { type: 'command'; args: string[] } | { type: 'catalog'; providerId: string } | { type: 'extension' };
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

/** full = whole-computer access: like auto, and the CLIs that keep a folder sandbox (Codex) or a workspace limit (Qwen) drop it. */
export type PermissionLevel = 'plan' | 'ask' | 'edit' | 'auto' | 'full';
export type ModeKey = 'write' | 'readonly' | 'plan' | 'ask' | 'edit' | 'full';

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
  /** Free models of unknown strength (a free-tier router): automatic assignment only uses it for sub-agents and compaction. */
  helperOnly?: boolean;
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
  /** Built-in extensions (all off until the user turns them on). */
  extensions?: ExtensionsConfig;
}

export type ExtensionId = 'ponytail' | 'agent-skills' | 'graphify' | 'omniroute';
export type PonytailLevel = 'lite' | 'full' | 'ultra';

export interface ExtensionsConfig {
  ponytail?: { enabled: boolean; level?: PonytailLevel };
  /** skills: per-skill on/off over the defaults. */
  'agent-skills'?: { enabled: boolean; skills?: Record<string, boolean> };
  graphify?: { enabled: boolean };
  /** port: where OmniRoute listens (picked once, kept). pinned: models picked from an auto pool, kept in the menus. */
  omniroute?: { enabled: boolean; port?: number; pinned?: string[] };
}

/** One bundled skill of an extension, as the settings list it. */
export interface ExtensionSkill {
  name: string;
  description: string;
  roles: InstructionRole[];
  enabled: boolean;
  /** Needs a person to answer questions, so it is off by default in a headless run. */
  interactive?: boolean;
}

/** One model an OmniRoute auto pool may route to, as OmniRoute reports it right now. */
export interface OmniCandidate {
  /** Model id agents use ("omniroute/groq/llama-4-scout"). */
  id: string;
  provider: string;
  /** ok: can be picked now · cooldown: resting after errors or a quota · limited: no-sign-in, too short for agents · excluded: not reachable / not allowed. */
  state: 'ok' | 'cooldown' | 'limited' | 'excluded';
}

/** Can an OmniRoute connection run an agent (a long prompt that must come back as a tool call)? */
export interface OmniTest {
  state: 'testing' | 'ok' | 'fail';
  at: number;
  model?: string;
  message?: string;
}

export interface ExtensionStatus {
  id: ExtensionId;
  enabled: boolean;
  /** off · working (installing / starting) · ready · error */
  state: 'off' | 'working' | 'ready' | 'error';
  /** What is happening or what went wrong, in the user's language. */
  message?: string;
  /** While installing: when the current step began and the last line its tool printed. */
  progress?: { since?: number; line?: string; /** Estimated, 0–100. */ percent?: number };
  version?: string;
  skills?: ExtensionSkill[];
  level?: PonytailLevel;
  /** OmniRoute: where it runs, which upstream providers are connected, how many models agents can use. */
  omniroute?: {
    url: string;
    dashboardUrl: string;
    connections: number;
    models: number;
    free: number;
    /** Upstream providers connected in OmniRoute, with the result of Aivenue's agent check. */
    connected?: { id: string; provider: string; name?: string; active: boolean; test?: OmniTest }[];
  };
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
  /** Undoes installCommand (winget / npm / Homebrew), when the CLI found is the one it installed. */
  uninstallCommand?: string;
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
  /** How full the agent's own conversation is (tokens of its latest model call) and its model's limit, when the CLI says. */
  context?: { used?: number; window?: number };
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
  /** The same numbers per model (most used in the last 7 days first); "" = the CLI's own default model. */
  models?: { model: string; today: UsageTotals; last7: UsageTotals }[];
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
  /** Models without tool calling: not offered (agents need tools), but known, so a model list can say so. */
  noTools?: string[];
}

export interface CatalogModel {
  id: string;
  name: string;
  tools: boolean;
  vision: boolean;
  /** Input types from the catalog ("text", "image", "pdf", "audio", "video"). */
  inputs?: string[];
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
  /** Largest context the model takes (tokens), and where that number comes from. */
  context?: number;
  contextSource?: 'cli' | 'catalog' | 'measured';
  /** Costs nothing to use (free tier / free model). */
  free?: boolean;
  /** What the model reads besides text: "image", "pdf", "audio", "video" (unknown when not set: the provider's profile decides). */
  inputs?: string[];
  /** Calls tools (false: Aivenue's tools do not work; it answers in text). Unknown when not set. */
  tools?: boolean;
  /** Thinks / takes a reasoning effort (false: an effort setting has no effect). Unknown when not set. */
  reasoning?: boolean;
}

export interface StageConfig {
  enabled: boolean;
  author: RoleConfig;
  /** null = no review, the author's output is accepted directly. */
  reviewer: RoleConfig | null;
  /** Author ↔ reviewer rounds before asking the user; 0 = no limit. */
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
/**
 * Aivenue's shared context: how big it may grow (the pie's 100%), when it is compacted automatically, who compacts it,
 * and when to ask about compacting an agent's own conversation.
 */
export interface ContextConfig {
  /** Tokens (default 256K). */
  capacity?: number;
  /** Share of the capacity that triggers automatic compaction (default 0.8). */
  compactAt?: number;
  /** Who condenses it; empty = automatic (a mid-priced signed-in model). */
  compactor?: { provider: string; model?: string; effort?: string };
  /** Share of an agent's own window that asks the user about compacting it (default 0.8; 0 = never ask). */
  agentAskAt?: number;
}

export interface SharedMemory {
  summary: string;
  /** Notes and agent results up to this time are represented by the summary. */
  upto: number;
  updatedAt: number;
  /** Who wrote it (provider · model). */
  by?: string;
  /** Tokens before → after the last compaction. */
  before?: number;
  after?: number;
  /** Items the validation found missing and appended verbatim. */
  kept?: string[];
}

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
  /** cross mode: rounds of sub-agent fact-finding before the advisor may read the code itself (default 3; 0 = never, sub-agents only). */
  factRounds?: number;
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
  /** fact (checked), inference (a judgement, not verified) or decision (what was decided). */
  kind?: 'fact' | 'inference' | 'decision';
  /** Who wrote it, kept when the note carries over to a follow-up message (its agent is in the earlier workflow). */
  by?: string;
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
  /** Size and compaction of the shared context (Aivenue's own, not the models' windows). */
  context?: ContextConfig;
  /** Advisor mode (off by default). */
  advisor?: AdvisorConfig;
  /** This message is an edited version of the one in that workflow. */
  replaces?: string;
  /** A follow-up message: the workflow it continues (its notes, shared memory and agent conversations carry over). */
  continueFrom?: string;
  /** The conversation this message belongs to (the id of its first workflow); one entry in the sidebar. */
  threadId?: string;
  /** External actions the user approved in advance ("allow and continue" after a denial); each is used once. */
  preApproved?: { kind: string; target: string; details: string }[];
  /** Goal verification after the code review (off unless enabled). */
  verify?: VerifyConfig;
  /** Stops for time, cost, retries and lack of progress (off by default). */
  limits?: LimitsConfig;
  /** Only check environment, paths, providers and resources; no agent runs. */
  dryRun?: boolean;
}

/**
 * Goal verification: the planner sets a goal with measurable acceptance metrics; after the code review a verifier
 * checks them and the controller routes the result (defect → implementer, bad evidence → implementer, goal missed →
 * planner). The workflow only completes when the goal is met.
 */
export interface VerifyConfig {
  enabled: boolean;
  /** "planner": the planner verifies its own goal; "independent": a separate verifier role. */
  by: 'planner' | 'independent';
  /** The independent verifier (default: another vendor than the implementer). */
  verifier?: RoleConfig;
  /** The same issue failing this many fixes in a row sends it back to the planner to re-diagnose (default 3; 0 = never). */
  repeatLimit?: number;
}

export interface LimitsConfig {
  enabled: boolean;
  /** Whole workflow wall time (minutes). */
  maxMinutes?: number;
  /** Spend reported by CLIs that report cost (USD). */
  maxCostUsd?: number;
  /** Fix / re-plan cycles after a failed verification. */
  maxCycles?: number;
  /** No new tool call, file change or submission for this long (minutes): ask the user. */
  noProgressMinutes?: number;
}

/** What the planner commits to: the goal that must pass before the workflow may end. */
export interface GoalSpec {
  statement: string;
  metrics: { id: string; name: string; target: string; how: string }[];
  expected?: string;
  cost?: string;
  constraints?: string;
  /** Data files or folders the results depend on (datasets, fixtures, weights): their version is recorded with every result. */
  data?: string[];
}

/** Where a result was measured: the code version, environment and data it applies to. */
export interface EvidenceStamp {
  at: number;
  /** git commit (when the folder is a repo) and a hash of the working tree's files. */
  commit?: string;
  treeHash: string;
  env: Record<string, string>;
  /** Data files the plan names, with their sizes and modification times. */
  data?: string;
}

export type VerifyOutcome = 'met' | 'not_met' | 'invalid_evidence' | 'defect';

export interface Verification {
  outcome: VerifyOutcome;
  summary: string;
  metrics: { id: string; value: string; met: boolean; evidence: string }[];
  issues: ReviewIssue[];
  evidence?: EvidenceStamp;
  /** The code changed after this was measured: it no longer counts until checked again. */
  stale?: boolean;
}

/** Where the controller sent the work after a review or verification, and why. */
export interface RouteDecision {
  to: 'done' | 'implementer' | 'planner' | 'adjudicate' | 'user';
  reason: string;
  /** Issues that caused it (ids). */
  issues?: string[];
  /** The same problem survived several fixes: the planner looks for the root cause, not just a new plan. */
  rediagnose?: boolean;
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
  /** Carried over from an earlier message of the conversation: agents still get it, this message does not show it. */
  earlier?: boolean;
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

export type AgentRole = 'planner' | 'plan_reviewer' | 'executor' | 'code_reviewer' | 'verifier' | 'adjudicator' | 'subagent' | 'advisor' | 'compactor' | 'test';
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
  stage?: PhaseKey;
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
  /** Spend the CLI reported for it (USD), for the cost limit. */
  costUsd?: number;
  /** Last time it showed any sign of life (an event from its CLI). */
  lastEventAt?: number;
  /** The user closed it (a stopped or finished sub-agent hidden from the agent map). */
  closed?: boolean;
  /** A sub-agent its parent handed off instead of waiting for it: who takes over its result. */
  handoff?: string;
  /** Started again by the user from this agent. */
  rerunOf?: string;
  /** A sub-agent's short name (given by its parent, else taken from the task) and its full task. */
  title?: string;
  brief?: string;
  /** Its own conversation: tokens in use now and the model's limit (when the CLI reports them). */
  context?: { used?: number; window?: number; estimated?: boolean; compactedAt?: number };
  /** Shared notes / agent results it has already been given (time), so later turns only get what is new. */
  sharedSeenAt?: number;
  /** Through a router (OmniRoute): the models that actually answered ("groq/llama-4-scout"). */
  servedBy?: string[];
  /** Skills put in its prompt as always on (e.g. "ponytail · level full"). */
  alwaysOn?: string[];
  /** Settings it ran with (taken when its turn started), to tell what a later change did and did not reach. */
  snapshot?: AgentSnapshot;
  /** Skills it reported applying (report_skill_use): reading a skill alone does not count as following it. */
  skillUses?: SkillUse[];
  /** Why it is waiting (a condition, a GPU, an approval), shown as the blocking reason. */
  waiting?: string;
  /** The CLI ended without the result its role must submit: the process finished, the task did not. */
  endedWithoutResult?: boolean;
  /** The last failure, classified (rate limit, quota, network…) and how it is being handled. */
  failure?: { kind: FailureKind; message: string; action: string };
}

export type FailureKind = 'rate_limit' | 'quota' | 'network' | 'auth' | 'model_service' | 'logic' | 'unknown';

export interface AgentSnapshot {
  at: number;
  model?: string;
  effort?: string;
  permission?: PermissionLevel;
  /** Hash of the role instructions and skills index it was given. */
  instructions?: string;
  skills: string[];
  /** Messages the user sent mid-run that it had received when the turn started. */
  userMessages: number;
}

export interface SkillUse {
  name: string;
  version?: string;
  reason: string;
  deliverables?: string;
  /** How following it was checked (tests, review…), and whether that passed. */
  verification?: string;
  verified?: boolean;
  ts: number;
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
  /** The goal that must be met before the workflow may end (goal verification). */
  goal?: GoalSpec;
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
  /** The code version the review looked at. */
  evidence?: EvidenceStamp;
  stale?: boolean;
}

export interface IssueResponse {
  issue_id: string;
  action: 'fixed' | 'rebutted';
  note?: string;
}

export type StageKey = 'plan' | 'implement';
/** A stage that can run rounds: the two review stages and goal verification. */
export type PhaseKey = StageKey | 'verify';

export interface Round {
  n: number;
  authorAgentId?: string;
  reviewerAgentId?: string;
  /** What the author submitted (plan or work summary). */
  submission?: { summary: string; plan?: PlanDoc; responses?: IssueResponse[] };
  review?: Review;
  /** Goal verification of this round (verify stage). */
  verification?: Verification;
  /** Where the controller sent the work next. */
  route?: RouteDecision;
  /** Feedback from the user that started this round. */
  userFeedback?: string;
  /** Hand-off summary written when the round ended, with links back to the agents and issues it came from. */
  handoff?: Handoff;
}

/** A round's hand-off: what was decided, what is open, and where the evidence is. */
export interface Handoff {
  ts: number;
  stage: PhaseKey;
  round: number;
  facts: string[];
  decisions: string[];
  open: string[];
  /** Agent ids and issue ids to open for the evidence. */
  links: { agentId?: string; issueId?: string; label: string }[];
}

export interface StageRun {
  key: PhaseKey;
  status: 'pending' | 'running' | 'approved' | 'skipped' | 'failed' | 'cancelled';
  rounds: Round[];
  authorSessionId?: string;
  reviewerSessionId?: string;
  /** A compacted conversation that could not be compacted in place: its next turn starts fresh from this summary. */
  authorHandoff?: string;
  reviewerHandoff?: string;
  /** Rounds allowed (grows when the user grants more). */
  /** 0 = no limit. */
  roundLimit: number;
}

export interface HumanDecision {
  id: string;
  stage: PhaseKey | 'run';
  message: string;
  options: { id: string; label: string }[];
  allowText: boolean;
}

/** "incomplete": it ended (a limit, or the user stopped retrying) without meeting the goal — never reported as done. */
export type WorkflowStatus = 'running' | 'paused' | 'waiting_human' | 'completed' | 'incomplete' | 'failed' | 'cancelled' | 'interrupted';

export interface WorkflowRun {
  id: string;
  config: WorkflowConfig;
  status: WorkflowStatus;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  stages: { plan: StageRun; implement: StageRun; verify?: StageRun };
  /** Plan → implement → verify cycles so far (goal verification). */
  cycles?: number;
  /** GPU locks agents of this run hold. */
  gpuLocks?: { gpus: number[]; agentId: string; since: number }[];
  /** Condition waits in progress (persisted, so a restart resumes them). */
  waits?: ConditionWait[];
  /** Side-effect actions already done (approved external actions), so a resumed run does not repeat them. */
  sideEffects?: { kind: string; target: string; details: string; agentId: string; ts: number }[];
  /** Why it stopped short: a limit hit or the goal not reached. */
  incompleteReason?: string;
  /** Rulings made when agents disagreed (adjudication). */
  rulings?: { issueId: string; ruling: string; by: string; ts: number }[];
  /** Results of the checks done before starting (and of a dry run). */
  preflight?: PreflightItem[];
  /** Only checked, nothing was run (dry run). */
  dryRun?: boolean;
  /** Last tool call, file change or submission (no-progress limit). */
  lastProgressAt?: number;
  /** Background processes agents registered (track_process): alive or not, and who cleans them up. */
  processes?: TrackedProcess[];
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
  /** The compacted shared memory: what notes and agent results up to `upto` were condensed into. */
  memory?: SharedMemory;
  /** Estimated size of the shared context (tokens), refreshed as it changes. */
  sharedTokens?: number;
  /** An agent whose own conversation passed the ask threshold: the user decides whether to compact it. */
  contextAsk?: { agentId: string; used: number; window: number; level: number };
  /** Highest ask level already shown per agent conversation (session id), and conversations the user muted. */
  contextAsked?: Record<string, number>;
  contextMuted?: string[];
  /** A compaction in progress (shared context or an agent), for the conversation view. */
  compacting?: { target: 'shared' | string; by?: string; startedAt: number };
  /** External actions the user denied in this run (shown with "allow and continue"). */
  deniedActions?: DeniedAction[];
  /** Files agents changed outside the working folder and the extra folders (absolute paths, from their file tools). */
  outsideChanges?: string[];
  /** The message was edited and re-sent as that workflow. */
  replacedBy?: string;
  /** Agent conversations continued from the previous message (session ids); a fresh one replaces any that cannot be resumed. */
  carriedSessions?: string[];
  /** Screenshots agents took with `capture_screenshot` (PNG files under <cwd>/.aivenue/screenshots). */
  screenshots?: { path: string; url: string; agentId: string; width: number; height: number; ts: number }[];
  /** Actions waiting for the user's approval ("ask" permission level). */
  approvals?: ApprovalRequest[];
  /** Worktree isolation: where the agents work and what happened to the result. */
  worktree?: { path: string; branch: string; baseCommit: string; repo: string; origCwd: string; cwd: string; state: 'active' | 'applied' | 'discarded' | 'kept'; note?: string };
  /** `chat` entries are shown as divider lines in the conversation. */
  log: { ts: number; text: string; level: 'info' | 'warn' | 'error'; chat?: boolean }[];
  /** Messages the user sent while the workflow was running (handed to the working agents and every later one). */
  userMessages?: { ts: number; text: string; attachments?: Attachment[]; /** Agents it reached. */ deliveredTo?: string[] }[];
}

export interface ConditionWait {
  id: string;
  agentId: string;
  /** Shell command; the condition holds when it exits 0 (and its output contains `contains`, if set). */
  check: string;
  contains?: string;
  intervalSec: number;
  timeoutAt: number;
  startedAt: number;
  lastCheck?: number;
  lastOutput?: string;
  /** Also take a GPU lock once the condition holds. */
  gpus?: number;
  state: 'waiting' | 'met' | 'timeout' | 'cancelled';
}

export interface TrackedProcess {
  pid: number;
  purpose: string;
  /** aivenue: stopped when the workflow ends; agent: the agent stops it; keep: meant to keep running. */
  cleanup: 'aivenue' | 'agent' | 'keep';
  agentId: string;
  startedAt: number;
  alive?: boolean;
  checkedAt?: number;
}

export interface PreflightItem {
  level: 'ok' | 'warn' | 'error';
  area: 'provider' | 'model' | 'path' | 'tool' | 'resource' | 'recovery';
  message: string;
}

export interface WorkflowSummary {
  id: string;
  /** The conversation it belongs to (its own id for a conversation's first message). */
  threadId: string;
  /** Set when the message was edited and re-sent as another workflow. */
  replacedBy?: string;
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
  | { topic: 'extensions'; data: ExtensionStatus[] }
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
