import type { ProviderSpec } from '../types';

/**
 * Built-in provider presets. They are plain data: users can override any field
 * (or add entirely new providers) from the UI; overrides live in ~/.aivenue/providers.json.
 *
 * Tokens available in args/env:
 *   {prompt} {cwd} {model} {sessionId} {newSessionId}
 *   {mcpConfigFile}  path to {"mcpServers":{"aivenue":{...}}} (Claude/Gemini/Qwen format)
 *   {mcpCommandToml} {mcpArgsToml} {mcpEnvToml}  the same server as TOML values (Codex -c)
 */
export const BUILTIN_PROVIDERS: ProviderSpec[] = [
  {
    id: 'claude',
    contextCatalog: ['anthropic'],
    name: 'Claude Code',
    description: 'Anthropic Claude Code CLI（Claude Pro / Max 訂閱）',
    command: 'claude',
    install: 'npm install -g @anthropic-ai/claude-code',
    installNoNpm: 'curl -fsSL https://claude.ai/install.sh | bash',
    docsUrl: 'https://docs.claude.com/en/docs/claude-code',
    login: { args: ['auth', 'login'], note: '會開啟瀏覽器到 claude.ai 登入' },
    logout: { args: ['auth', 'logout'] },
    status: { args: ['auth', 'status'], jsonPath: 'loggedIn' },
    run: {
      systemPrompt: [['--append-system-prompt', '{systemPrompt}']],
      common: [['-p'], ['--output-format', 'stream-json'], ['--verbose'], ['--mcp-config', '{mcpConfigFile}'], ['--model', '{model}'], ['--effort', '{effort}'], ['--add-dir', '{skillsDir}'], ['--add-dir', '{attachDir}']],
      extraDir: [['--add-dir', '{extraDir}']],
      fresh: [['--session-id', '{newSessionId}']],
      resume: [['--resume', '{sessionId}']],
      env: { MCP_TOOL_TIMEOUT: '600000' },
      prompt: 'stdin',
      // Claude Code's built-in advisor (a stronger model it consults on its own).
      advisor: [['--advisor', '{advisorModel}']],
      noTools: [['--tools', '']],
      // Stays running between turns: one user message per stdin line, each turn ends with a "result" event.
      persistent: {
        args: [['--input-format', 'stream-json']],
        stdinTemplate: '{"type":"user","message":{"role":"user","content":[{"type":"text","text":{promptJson}}]}}',
      },
    },
    modes: {
      write: [['--dangerously-skip-permissions']],
      readonly: [['--dangerously-skip-permissions'], ['--disallowed-tools', 'Edit,Write,NotebookEdit']],
      plan: [['--permission-mode', 'plan']],
      // Each permission request goes to Aivenue's approval tool, so the user decides in the UI.
      ask: [['--permission-mode', 'default'], ['--permission-prompt-tool', '{approvalTool}']],
      edit: [['--permission-mode', 'acceptEdits']],
    },
    approvals: { type: 'prompt-tool' },
    output: 'claude-stream',
    accounts: { env: 'CLAUDE_CONFIG_DIR', home: '~/.claude' },
    // The 5-hour and weekly plan limits, read with Claude Code's own sign-in.
    quota: { reader: 'claude' },
    apiKey: { env: 'ANTHROPIC_API_KEY', baseUrlEnv: 'ANTHROPIC_BASE_URL', note: 'Anthropic API 金鑰；Base URL 可填其他 Anthropic 相容端點' },
    capabilities: { resume: true, mcp: true },
    profile: { plan: 5, review: 5, code: 5, speed: 3, vision: true, pdf: true },
    models: ['opus', 'sonnet', 'haiku', 'fable', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'codex',
    contextCatalog: ['openai'],
    name: 'Codex',
    description: 'OpenAI Codex CLI（ChatGPT Plus / Pro 訂閱）',
    command: 'codex',
    install: 'npm install -g @openai/codex',
    docsUrl: 'https://developers.openai.com/codex/cli',
    login: { args: ['login'], note: '會開啟瀏覽器到 ChatGPT 登入（可選 Google / Microsoft / Apple）' },
    logout: { args: ['logout'] },
    status: { args: ['login', 'status'], stdoutIncludes: 'Logged in' },
    run: {
      fresh: [['exec']],
      resume: [['exec', 'resume', '{sessionId}']],
      common: [['--json'], ['--skip-git-repo-check'], ['-m', '{model}'], ['-c', 'model_reasoning_effort="{effort}"']],
      // Placed right after `exec` so the variadic -i never swallows the trailing "-".
      images: [['-i', '{image}']],
      tail: [['-']],
      prompt: 'stdin',
    },
    // Codex takes MCP servers as -c overrides, rendered once per server.
    mcpFlags: [
      ['-c', 'mcp_servers.{mcpName}.command={mcpCommandToml}'],
      ['-c', 'mcp_servers.{mcpName}.args={mcpArgsToml}'],
      ['-c', 'mcp_servers.{mcpName}.env={mcpEnvToml}'],
      ['-c', 'mcp_servers.{mcpName}.env_vars={mcpEnvVarsToml}'],
      ['-c', 'mcp_servers.{mcpName}.url={mcpUrlToml}'],
      ['-c', 'mcp_servers.{mcpName}.http_headers={mcpHeadersToml}'],
      ['-c', 'mcp_servers.{mcpName}.env_http_headers={mcpEnvHeadersToml}'],
      ['-c', 'mcp_servers.{mcpName}.tool_timeout_sec=600'],
      ['-c', 'mcp_servers.{mcpName}.startup_timeout_sec=30'],
      // approval_policy="never" rejects MCP calls unless the server's tools are pre-approved
      ['-c', 'mcp_servers.{mcpName}.default_tools_approval_mode="approve"'],
    ],
    // Codex keeps its OS sandbox even in full auto: writes are confined to the working folder.
    modes: {
      write: [['-c', 'sandbox_mode="workspace-write"'], ['-c', 'approval_policy="never"']],
      readonly: [['-c', 'sandbox_mode="workspace-write"'], ['-c', 'approval_policy="never"']],
      plan: [['-c', 'sandbox_mode="read-only"'], ['-c', 'approval_policy="never"']],
      edit: [['-c', 'sandbox_mode="workspace-write"'], ['-c', 'approval_policy="never"']],
      // Whole-computer access: no sandbox at all.
      full: [['-c', 'sandbox_mode="danger-full-access"'], ['-c', 'approval_policy="never"']],
    },
    approvals: { type: 'fallback', zh: 'Codex 的 headless 模式無法逐項詢問：改為沙箱內自動執行（只能寫入工作資料夾）', en: "Codex headless can't ask per action: runs inside its sandbox instead (writes limited to the working folder)" },
    output: 'codex-jsonl',
    apiKey: { env: 'CODEX_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL', note: 'OpenAI API 金鑰' },
    quota: { reader: 'codex-sessions' },
    modelSource: { type: 'codex-cache' },
    accounts: { env: 'CODEX_HOME', home: '~/.codex' },
    configDefaults: { file: '~/.codex/config.toml', model: '^\\s*model\\s*=\\s*"([^"]+)"', effort: '^\\s*model_reasoning_effort\\s*=\\s*"([^"]+)"' },
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    capabilities: { resume: true, mcp: true },
    profile: { plan: 5, review: 5, code: 5, speed: 3, vision: true, pdf: false },
  },
  {
    id: 'antigravity',
    contextCatalog: ['google', 'anthropic', 'openai'],
    name: 'Antigravity',
    description: 'Google Antigravity CLI（Google AI Pro / Ultra 訂閱）',
    command: 'agy',
    // The official script installs to ~/.local/bin (also checked below, in case it is not on PATH yet).
    install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    installOn: { win32: 'winget install --id Google.AntigravityCLI -e' },
    commandPaths: ['~/.local/bin/agy'],
    // Per-model remaining share from Google, after connecting a Google account on the Usage page.
    quota: { reader: 'antigravity' },
    docsUrl: 'https://antigravity.google/docs/cli/headless/',
    login: { args: [], note: '在開啟的終端機中依提示用 Google 帳號登入（會開啟瀏覽器）；完成後輸入 /quit 離開' },
    // Credentials live in the OS keyring; signing in creates the default project file.
    status: { files: ['~/.gemini/antigravity-cli/cache/default_project_id.txt'] },
    run: {
      // Prompts go through stdin as stream-json, so long prompts never hit the Windows command-line limit.
      common: [['--input-format', 'stream-json'], ['--output-format', 'stream-json'], ['--model', '{model}'], ['--effort', '{effort}'], ['--add-dir', '{skillsDir}'], ['--add-dir', '{attachDir}']],
      extraDir: [['--add-dir', '{extraDir}']],
      resume: [['--conversation', '{sessionId}']],
      prompt: 'stdin',
      stdinTemplate: '{"event":"user","message":{"content":{promptJson}}}',
      // stream-json input already runs one turn per line: keep it open between turns.
      persistent: { args: [], stdinTemplate: '{"event":"user","message":{"content":{promptJson}}}' },
    },
    modes: {
      write: [['--dangerously-skip-permissions']],
      readonly: [['--dangerously-skip-permissions']],
      plan: [['--mode', 'plan']],
      // Without auto-approval, headless agy allows workspace reads/writes and soft-denies commands.
      ask: [],
      edit: [['--mode', 'accept-edits']],
    },
    approvals: { type: 'fallback', zh: 'Antigravity 的 headless 模式無法逐項詢問：允許工作資料夾內的讀寫，需要核准的指令會被拒絕', en: "Antigravity headless can't ask per action: workspace reads/writes are allowed, commands needing approval are refused" },
    output: 'agy-stream',
    // Headless agy auto-denies MCP calls it cannot prompt for (e.g. in plan mode), so Aivenue's own tools are allowed explicitly.
    mcpRegistration: { file: '~/.gemini/config/mcp_config.json', permissions: { file: '~/.gemini/antigravity-cli/settings.json', allow: ['mcp(aivenue/*)'] } },
    modelSource: { type: 'command', args: ['models'] },
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    // Claude and GPT-OSS through Antigravity refuse --effort (Gemini's level is part of its model name).
    noEffortModels: '^(claude|gpt-oss)',
    capabilities: { resume: true, mcp: true },
    profile: { plan: 5, review: 5, code: 5, speed: 4, vision: true, pdf: true },
  },
  {
    id: 'opencode',
    contextCatalog: ['opencode'],
    name: 'OpenCode',
    description: 'OpenCode CLI — 內建 OpenCode Zen 免費模型，也能接上百家 API；優先使用 OpenCode Desktop 附的 CLI。注意：部分免費模型會用你的資料改進模型',
    command: 'opencode',
    // OpenCode Desktop's CLI on Windows; the official installer's folder on Linux / macOS.
    commandPaths: ['~/AppData/Local/Programs/@opencodedesktop/resources/opencode-cli.exe', '~/.opencode/bin/opencode'],
    install: 'npm install -g opencode-ai',
    installNoNpm: 'curl -fsSL https://opencode.ai/install | bash',
    docsUrl: 'https://opencode.ai/docs/zen/',
    // The OpenCode account (device sign-in in the browser) links every plan of that account: Zen, Go…
    // Browser sign-in (device code) exists from OpenCode 2 (shipped with OpenCode Desktop). The CLI you can download
    // (npm / opencode.ai/install) is OpenCode 1, which only takes an API key from the OpenCode console.
    login: {
      args: ['auth', 'login', 'opencode', '--method', 'device'],
      minVersion: '2.0.0',
      older: {
        args: ['auth', 'login', '-p', 'opencode-go'],
        zh: '登入 OpenCode Go（貼 API key）',
        en: 'Sign in to OpenCode Go (paste an API key)',
        noteZh: '這個 OpenCode 是 1.x（目前 npm 與官方安裝程式提供的版本），只能用 API key 登入，沒有網頁登入。到 https://opencode.ai/auth 建立或複製你的 API key（Go 方案用同一個帳號的金鑰），按下面的按鈕後貼上；登入後模型清單自動加入 Go 的模型。免費模型不登入也能用。',
        noteEn: 'This OpenCode is 1.x (what npm and the official installer provide), which signs in with an API key only, no browser sign-in. Create or copy your API key at https://opencode.ai/auth (the Go plan uses the same account key), press the button below and paste it; the model list then adds the Go models. Free models work without signing in.',
        hint: 'https://opencode.ai/auth',
      },
      note: '用瀏覽器登入 OpenCode 帳號，Zen、Go 等付費方案會一起連動，登入後模型清單自動更新；免費模型不登入也能用' },
    loginOptions: [
      { id: 'go-key', zh: '貼上 OpenCode Go 的 API key', en: 'Paste an OpenCode Go API key', args: ['auth', 'login', 'opencode-go', '--method', 'key'], olderArgs: ['auth', 'login', '-p', 'opencode-go'] },
      { id: 'zen-key', zh: '貼上 OpenCode Zen 的 API key', en: 'Paste an OpenCode Zen API key', args: ['auth', 'login', 'opencode', '--method', 'key'], olderArgs: ['auth', 'login', '-p', 'opencode'] },
      { id: 'other', zh: '其他供應商（OpenCode 的選單）', en: 'Another provider (OpenCode picker)', args: ['auth', 'login'] },
    ],
    logout: { args: ['auth', 'logout'] },
    // OpenCode 2: "No authenticated integrations"; OpenCode 1: "Credentials <file>" … "0 credentials".
    status: { ready: true, accounts: { args: ['auth', 'list'], none: '^(No authenticated|0 credentials)', skip: '^(Credentials\\b|\\d+ credentials)' } },
    run: {
      // `run` is the subcommand, so it leads both the fresh and the resumed form.
      fresh: [['run']],
      resume: [['run'], ['--session', '{sessionId}']],
      // --standalone: a private server per run, so the user's OpenCode Desktop is untouched and our MCP config applies.
      common: [['?--standalone'], ['--format', 'json'], ['--model', '{model}']],
      images: [['--file', '{image}']],
      env: { OPENCODE_CONFIG_CONTENT: '{mcpConfigJson}' },
      // No flag for extra folders: reading outside the working folder is a permission of its own.
      extraDirEnv: { OPENCODE_PERMISSION: '{"external_directory":"allow"}' },
      prompt: 'stdin',
    },
    modes: { write: [['--auto']], readonly: [['--auto']], plan: [['--agent', 'plan']], edit: [['--auto']] },
    // "edit": file edits are auto-approved, shell commands are denied.
    modeEnv: { edit: { OPENCODE_PERMISSION: '{"bash":"deny"}' }, ask: { OPENCODE_PERMISSION: '{"bash":"deny"}' }, full: { OPENCODE_PERMISSION: '{"external_directory":"allow"}' } },
    approvals: { type: 'fallback', zh: 'OpenCode 的 headless 模式無法逐項詢問：允許編輯檔案，禁止執行指令', en: "OpenCode headless can't ask per action: file edits allowed, shell commands denied" },
    output: 'opencode-json',
    mcpConfigFormat: 'opencode',
    // A fresh install may not reach its background service: a private server answers instead.
    modelSource: { type: 'command', args: ['models'], retryArgs: ['models', '--standalone'] },
    defaultModel: 'opencode/big-pickle',
    models: ['opencode/big-pickle', 'opencode/deepseek-v4.1-flash-free', 'opencode/glm-5.3-flash-free', 'opencode/minimax-m3.1-flash-free', 'opencode/mimo-v2.6-flash-free'],
    capabilities: { resume: true, mcp: true },
    profile: { plan: 3, review: 3, code: 4, speed: 4, vision: false, pdf: false },
  },
  {
    id: 'qwen',
    contextCatalog: ['alibaba', 'qwen'],
    name: 'Qwen Code',
    description: 'Alibaba Qwen Code CLI（QwenCloud Token Plan 訂閱）',
    command: 'qwen',
    install: 'npm install -g @qwen-code/qwen-code',
    docsUrl: 'https://qwenlm.github.io/qwen-code-docs/',
    login: { args: [], note: '在開啟的終端機輸入 /auth 選擇登入方式（Qwen OAuth 免費方案已於 2026-04-15 停止）' },
    status: {
      files: ['~/.qwen/oauth_creds.json'],
      fileContains: [{ path: '~/.qwen/settings.json', text: 'selectedType' }],
      env: ['QWENCLOUD_API_KEY', 'QWENCLOUD_TOKEN_PLAN_API_KEY'],
    },
    run: {
      systemPrompt: [['--append-system-prompt', '{systemPrompt}']],
      common: [['-o', 'stream-json'], ['--mcp-config', '{mcpConfigFile}'], ['-m', '{model}'], ['--include-directories', '{skillsDir}'], ['--include-directories', '{attachDir}']],
      extraDir: [['--include-directories', '{extraDir}']],
      fresh: [['--session-id', '{newSessionId}']],
      resume: [['--resume', '{sessionId}']],
      env: { QWEN_CODE_SUPPRESS_YOLO_WARNING: '1' },
      prompt: 'stdin',
    },
    // Whole-computer access: its file tools also reach the user's home folder (commands are not limited either way).
    modes: { write: [['--approval-mode', 'yolo']], readonly: [['--approval-mode', 'yolo']], plan: [['--approval-mode', 'plan']], edit: [['--approval-mode', 'auto-edit']], full: [['--approval-mode', 'yolo'], ['--include-directories', '{homeDir}']] },
    approvals: { type: 'fallback', zh: 'Qwen Code 的 headless 模式無法逐項詢問：自動核准編輯，需要核准的指令會失敗', en: "Qwen Code headless can't ask per action: edits auto-approved, commands needing approval fail" },
    output: 'claude-stream',
    mcpServerExtra: { trust: true, timeout: 600000 },
    mcpHttpStyle: 'gemini',
    apiKey: {
      env: 'OPENAI_API_KEY',
      baseUrlEnv: 'OPENAI_BASE_URL',
      args: [['--auth-type', 'openai']],
      note: '任何 OpenAI 相容 API（DashScope、Kimi、DeepSeek、Grok、OpenRouter…）：填金鑰與 Base URL，並在角色設定指定模型',
    },
    capabilities: { resume: true, mcp: true },
    profile: { plan: 3, review: 3, code: 4, speed: 4, vision: false, pdf: false },
  },
  {
    id: 'copilot',
    contextCatalog: ['github-copilot'],
    name: 'GitHub Copilot',
    description: 'GitHub Copilot CLI（Copilot Pro / Pro+ / Business 訂閱，可選 Claude、GPT、Gemini 等模型）',
    command: 'copilot',
    // npm works everywhere (Node.js 22+); winget is the usual way on Windows.
    install: 'npm install -g @github/copilot',
    installOn: { win32: 'winget install --id GitHub.Copilot -e' },
    docsUrl: 'https://docs.github.com/copilot/how-tos/copilot-cli',
    login: { args: ['login'], note: '會開啟瀏覽器到 GitHub 授權' },
    // The token sits in the OS credential store; the config file records the signed-in account.
    // Older Copilot CLIs wrote "logged_in_user"; v1 keeps "loggedInUsers": [{ login, … }].
    status: { fileContains: [{ path: '~/.copilot/config.json', text: 'logged_in_user' }, { path: '~/.copilot/config.json', text: '"login"' }], env: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN'] },
    run: {
      // Piped stdin runs non-interactively, so long prompts never hit the Windows command-line limit.
      common: [['--output-format', 'json'], ['--no-ask-user'], ['--no-auto-update'], ['--model', '{model}'], ['--reasoning-effort', '{effort}'], ['--additional-mcp-config', '@{mcpConfigFile}'], ['--add-dir', '{skillsDir}'], ['--add-dir', '{attachDir}']],
      extraDir: [['--add-dir', '{extraDir}']],
      fresh: [['--session-id', '{newSessionId}']],
      resume: [['--resume', '{sessionId}']],
      images: [['--attachment', '{image}']],
      prompt: 'stdin',
    },
    // Writes outside the working folder (and --add-dir folders) still need --allow-all-paths, which only full auto adds.
    modes: {
      write: [['--allow-all']],
      readonly: [['--allow-all-tools'], ['--deny-tool', 'write']],
      plan: [['--allow-all-tools'], ['--deny-tool', 'write'], ['--deny-tool', 'shell']],
      edit: [['--allow-all-tools'], ['--deny-tool', 'shell']],
    },
    approvals: { type: 'fallback', zh: 'Copilot 的 headless 模式無法逐項詢問：允許編輯工作資料夾內的檔案，禁止執行指令', en: "Copilot headless can't ask per action: edits in the working folder allowed, shell commands denied" },
    output: 'copilot-json',
    mcpServerExtra: { tools: ['*'] },
    accounts: { env: 'COPILOT_HOME', home: '~/.copilot' },
    // Monthly premium requests, read with the GitHub sign-in (gh).
    quota: { reader: 'copilot' },
    apiKey: {
      env: 'COPILOT_PROVIDER_API_KEY',
      baseUrlEnv: 'COPILOT_PROVIDER_BASE_URL',
      note: '自帶金鑰（BYOK）：填 OpenAI 相容端點的 Base URL 與金鑰，並在角色設定指定模型；不需要 GitHub 帳號',
    },
    // From `copilot help config`; availability depends on the plan.
    models: ['auto', 'claude-opus-5.5', 'claude-sonnet-5.5', 'claude-haiku-5.5', 'claude-fable-5.1', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.3-codex', 'gemini-4-argon', 'gemini-3.8-flash', 'grok-4.7', 'kimi-k3', 'mai-code-1.1-flash'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    capabilities: { resume: true, mcp: true },
    profile: { plan: 4, review: 4, code: 4, speed: 4, vision: true, pdf: true },
  },
];

/** Former built-ins: saved overrides of these are dropped instead of resurfacing as custom providers. */
export const RETIRED_BUILTINS = ['gemini'];

/** Starting points for user-defined providers, shown in the "add provider" dialog. */
export const PROVIDER_TEMPLATES: { id: string; label: string; spec: ProviderSpec }[] = [
  {
    id: 'claude-like',
    label: 'Claude 相容（stream-json：system / assistant / user / result）',
    spec: {
      id: 'my-agent',
      name: 'My Agent',
      command: 'my-agent',
      login: { args: ['login'] },
      status: { args: ['auth', 'status'] },
      run: {
        common: [['-p'], ['--output-format', 'stream-json'], ['--mcp-config', '{mcpConfigFile}'], ['--model', '{model}']],
        fresh: [],
        resume: [['--resume', '{sessionId}']],
        prompt: 'stdin',
      },
      modes: { write: [['--yolo']], readonly: [['--yolo']] },
      output: 'claude-stream',
      capabilities: { resume: true, mcp: true },
    },
  },
  {
    id: 'gemini-like',
    label: 'Gemini CLI 衍生版（stream-json：init / message / tool_use / tool_result）',
    spec: {
      id: 'my-gemini-fork',
      name: 'My Gemini Fork',
      command: 'my-gemini-fork',
      login: { args: [] },
      status: { files: ['~/.my-gemini-fork/oauth_creds.json'] },
      run: {
        common: [['-p', 'Follow the task instructions provided above.'], ['-o', 'stream-json'], ['-m', '{model}']],
        resume: [['--resume', '{sessionId}']],
        prompt: 'stdin',
      },
      modes: { write: [['--yolo']], readonly: [['--yolo']] },
      output: 'gemini-stream',
      mcpServerExtra: { trust: true },
      capabilities: { resume: true, mcp: false },
    },
  },
  {
    id: 'text',
    label: '純文字輸出（任何能從 stdin 讀提示並印出結果的 CLI）',
    spec: {
      id: 'my-text-agent',
      name: 'My Text Agent',
      command: 'my-text-agent',
      login: { args: ['login'] },
      run: { common: [], prompt: 'stdin' },
      output: 'text',
      capabilities: { resume: false, mcp: false },
    },
  },
];
