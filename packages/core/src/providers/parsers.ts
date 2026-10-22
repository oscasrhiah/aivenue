import * as path from 'node:path';
import type { AgentEvent, OutputFormat, ToolCategory } from '../types';
import { L } from '../i18n';

export type EventDraft = Omit<AgentEvent, 'seq' | 'ts'>;

export interface ParserSink {
  /** Emit a new event; returns its sequence number. */
  emit(e: EventDraft): number;
  /** Update a previously emitted tool event (e.g. when the tool finishes). */
  updateTool(seq: number, patch: Partial<NonNullable<AgentEvent['tool']>>, files?: string[]): void;
}

export interface StreamParser {
  line(raw: string): void;
  end(): void;
  finalText(): string;
  sessionId?: string;
  /** Error reported by the CLI itself (auth failure, quota, ...). */
  error?: string;
}

export function trunc(s: string | undefined, n: number): string | undefined {
  if (s === undefined) return undefined;
  return s.length > n ? s.slice(0, n) + `\n… (+${s.length - n})` : s;
}

function str(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

const READ = new Set(['read', 'read_file', 'readfile', 'view', 'read_many_files', 'notebookread', 'cat', 'view_file', 'view_file_outline', 'view_code_item']);
const EDIT = new Set(['edit', 'write', 'multiedit', 'write_file', 'replace', 'edit_file', 'notebookedit', 'apply_patch', 'str_replace_editor', 'create_file', 'create', 'smart_edit', 'write_to_file', 'replace_file_content', 'multi_replace_file_content']);
const COMMAND = new Set(['bash', 'powershell', 'run_shell_command', 'shell', 'exec_command', 'local_shell', 'run_command', 'terminal', 'command_status', 'send_command_input']);
const SEARCH = new Set(['grep', 'rg', 'glob', 'ls', 'list_directory', 'search_file_content', 'find', 'codebase_search', 'list_files', 'grep_search', 'file_search', 'list_dir', 'find_by_name']);
const WEB = new Set(['webfetch', 'websearch', 'web_fetch', 'google_web_search', 'web_search', 'search_web', 'read_url_content']);
const HUB_SUFFIX = /(?:^|[_:./-])(submit_plan|submit_review|submit_work|report_progress|spawn_subagent|wait_subagent|list_providers|capture_screenshot|read_context|post_note|ask_advisor|confirm_external_action)$/;
const AGENT = new Set(['task', 'agent']);
const TODO = new Set(['todowrite', 'todo_write', 'write_todos', 'update_plan', 'todo_list']);

const HUB_TITLES: Record<string, [string, string]> = {
  submit_plan: ['提交計畫', 'Submit plan'],
  submit_review: ['提交審查結果', 'Submit review'],
  submit_work: ['提交實作結果', 'Submit work'],
  report_progress: ['回報進度', 'Report progress'],
  spawn_subagent: ['派出 sub agent', 'Spawn sub-agent'],
  wait_subagent: ['等待 sub agent', 'Wait for sub-agent'],
  list_providers: ['查詢可用供應商', 'List providers'],
  capture_screenshot: ['拍截圖', 'Take screenshot'],
  read_context: ['查閱其他 agent 的紀錄', 'Read shared context'],
  post_note: ['留下共用筆記', 'Post a shared note'],
  ask_advisor: ['請教顧問', 'Ask the advisor'],
  confirm_external_action: ['請你核准對外動作', 'Ask to approve an external action'],
};

export function classifyTool(rawName: string, input: unknown, cwd: string): { category: ToolCategory; title: string; name: string } {
  let name = rawName;
  let hub = false;
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(rawName);
  if (mcp) {
    hub = mcp[1] === 'aivenue';
    name = mcp[2];
  } else {
    // Other CLIs prefix MCP tools differently (e.g. "aivenue_submit_plan", "mcp_aivenue_submit_plan").
    const h = HUB_SUFFIX.exec(rawName);
    if (h && /aivenue/i.test(rawName)) {
      hub = true;
      name = h[1];
    }
  }
  const lower = name.toLowerCase();
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof inp[k] === 'string' && inp[k]) return inp[k] as string;
    return undefined;
  };
  const rel = (p?: string) => {
    if (!p) return p;
    const r = path.relative(cwd, p);
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p;
  };
  if (hub || HUB_TITLES[lower]) {
    const t = HUB_TITLES[lower];
    let title = t ? L(t[0], t[1]) : name;
    if (lower === 'spawn_subagent') title += `: ${pick('provider') ?? ''} — ${(pick('task') ?? '').slice(0, 80)}`;
    if (lower === 'report_progress') title += `: ${pick('step_id') ?? '?'} → ${pick('status') ?? ''}`;
    if (lower === 'submit_review') title += `: ${pick('verdict') ?? ''}`;
    if (lower === 'capture_screenshot') title += `: ${pick('target') ?? ''}`;
    if (lower === 'read_context') title += pick('agent_id') ? `: ${pick('agent_id')}` : L('：總覽', ': overview');
    if (lower === 'post_note') title += `: ${(pick('text') ?? '').slice(0, 80)}`;
    if (lower === 'ask_advisor') title += `: ${(pick('question') ?? '').slice(0, 80)}`;
    if (lower === 'confirm_external_action') title += `: ${pick('kind') ?? ''} → ${(pick('target') ?? '').slice(0, 80)}`;
    return { category: 'hub', title, name };
  }
  if (READ.has(lower)) return { category: 'read', title: rel(pick('file_path', 'path', 'absolute_path', 'filePath', 'AbsolutePath', 'TargetFile')) ?? name, name };
  if (EDIT.has(lower)) return { category: 'edit', title: rel(pick('file_path', 'path', 'absolute_path', 'filePath', 'TargetFile', 'AbsolutePath')) ?? name, name };
  if (COMMAND.has(lower)) return { category: 'command', title: pick('command', 'cmd', 'CommandLine') ?? name, name };
  if (SEARCH.has(lower)) return { category: 'search', title: `${name} ${pick('pattern', 'query', 'Query', 'Pattern', 'path', 'dir_path', 'DirectoryPath', 'SearchPath') ?? ''}`.trim(), name };
  if (WEB.has(lower)) return { category: 'web', title: pick('url', 'Url', 'query', 'prompt') ?? name, name };
  if (AGENT.has(lower)) return { category: 'agent', title: pick('description', 'prompt') ?? name, name };
  if (TODO.has(lower)) return { category: 'todo', title: L('更新待辦清單', 'Update todo list'), name };
  return { category: 'other', title: mcp ? `${mcp[1]} · ${name}` : name, name };
}

function filesOf(category: ToolCategory, input: unknown): string[] | undefined {
  if (category !== 'edit' || !input || typeof input !== 'object') return undefined;
  const i = input as Record<string, unknown>;
  const p = i.file_path ?? i.path ?? i.absolute_path ?? i.filePath ?? i.TargetFile;
  return typeof p === 'string' ? [p] : undefined;
}

function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x === 'object' && 'text' in x ? String((x as { text: unknown }).text) : str(x))).join('\n');
  return str(c);
}

function parseJson(raw: string): Record<string, any> | undefined {
  const t = raw.trim();
  if (!t.startsWith('{')) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

// ---------- Claude Code / Qwen Code (stream-json) ----------

class ClaudeStreamParser implements StreamParser {
  sessionId?: string;
  error?: string;
  private tools = new Map<string, { seq: number; category: ToolCategory; input: unknown }>();
  private lastText = '';
  private result?: string;

  constructor(private sink: ParserSink, private cwd: string) {}

  /** Claude's built-in advisor calls still waiting for their result. */
  private advisorPending = new Set<string>();

  /** Mark one advisor call (or all pending ones) as answered. */
  private finishAdvisor(id?: string) {
    for (const pending of id ? [id] : [...this.advisorPending]) {
      const t = this.tools.get(pending);
      if (t && this.advisorPending.delete(pending)) this.sink.updateTool(t.seq, { status: 'ok', output: L('顧問已回覆（內容由 Claude 加密，只有 agent 看得到）', 'The advisor replied (Claude encrypts the advice; only the agent can read it)') });
    }
  }

  line(raw: string): void {
    const ev = parseJson(raw);
    if (!ev) {
      if (raw.trim()) this.sink.emit({ kind: 'stderr', text: raw });
      return;
    }
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init' || ev.subtype === 'session_start') {
          this.sessionId = ev.session_id ?? this.sessionId;
          this.sink.emit({ kind: 'session', sessionId: this.sessionId, text: ev.model });
        }
        break;
      case 'assistant': {
        for (const block of ev.message?.content ?? []) {
          // The CLI doesn't always print the advisor's (encrypted) result: once the agent moves on, the consultation is over.
          if (block.type !== 'advisor_tool_result' && !(block.type === 'server_tool_use' && block.name === 'advisor')) this.finishAdvisor();
          if (block.type === 'text' && block.text?.trim()) {
            this.lastText = block.text;
            this.sink.emit({ kind: 'message', text: block.text });
          } else if (block.type === 'thinking' && block.thinking?.trim()) {
            this.sink.emit({ kind: 'thinking', text: block.thinking });
          } else if (block.type === 'tool_use') {
            const c = classifyTool(block.name, block.input, this.cwd);
            const seq = this.sink.emit({
              kind: 'tool',
              tool: { id: block.id, name: c.name, category: c.category, title: c.title, input: trunc(str(block.input), 4000), status: 'running' },
            });
            this.tools.set(block.id, { seq, category: c.category, input: block.input });
          } else if (block.type === 'server_tool_use' && block.name === 'advisor') {
            // Claude Code's built-in advisor (--advisor): a stronger model reviews the conversation server-side.
            const seq = this.sink.emit({
              kind: 'tool',
              tool: { id: block.id, name: 'Advisor', category: 'agent', title: L('請教顧問（Claude 原生）', 'Consulting the advisor (Claude native)'), status: 'running' },
            });
            this.tools.set(block.id, { seq, category: 'agent', input: {} });
            this.advisorPending.add(block.id);
          } else if (block.type === 'advisor_tool_result') {
            this.finishAdvisor(block.tool_use_id);
          }
        }
        break;
      }
      case 'user': {
        const content = ev.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          const t = this.tools.get(block.tool_use_id);
          if (!t) continue;
          this.sink.updateTool(t.seq, { status: block.is_error ? 'error' : 'ok', output: trunc(contentText(block.content), 4000) }, block.is_error ? undefined : filesOf(t.category, t.input));
        }
        break;
      }
      case 'result': {
        this.finishAdvisor();
        this.sessionId = ev.session_id ?? this.sessionId;
        this.result = typeof ev.result === 'string' ? ev.result : undefined;
        const isError = ev.is_error || (typeof ev.subtype === 'string' && ev.subtype.startsWith('error'));
        if (isError) this.error = this.result || ev.subtype || 'error';
        const u = ev.usage ?? {};
        // The advisor's own model calls are listed as separate iterations, not in the totals.
        const advisorCalls = (Array.isArray(u.iterations) ? u.iterations : []).filter((i: { type?: string }) => i?.type === 'advisor_message');
        const sum = (k: string) => advisorCalls.reduce((n: number, i: Record<string, number>) => n + (Number(i[k]) || 0), 0);
        const usage = {
          input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + sum('input_tokens') + sum('cache_creation_input_tokens'),
          output: (u.output_tokens ?? 0) + sum('output_tokens'),
          cached: (u.cache_read_input_tokens ?? 0) + sum('cache_read_input_tokens'),
          costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
        };
        this.sink.emit({ kind: isError ? 'error' : 'result', text: this.result ?? ev.subtype ?? '', usage });
        break;
      }
    }
  }

  end(): void {}

  finalText(): string {
    return this.result ?? this.lastText;
  }
}

// ---------- OpenAI Codex (exec --json) ----------

class CodexParser implements StreamParser {
  sessionId?: string;
  error?: string;
  private items = new Map<string, number>();
  private lastText = '';
  private todoSeq?: number;

  constructor(private sink: ParserSink, private cwd: string) {}

  private toolFor(item: any): { name: string; category: ToolCategory; title: string; input?: string } | undefined {
    switch (item.type) {
      case 'command_execution':
        return { name: 'shell', category: 'command', title: unwrapShell(item.command), input: item.command };
      case 'mcp_tool_call': {
        const c = classifyTool(`mcp__${item.server}__${item.tool}`, item.arguments, this.cwd);
        return { name: c.name, category: c.category, title: c.title, input: trunc(str(item.arguments), 4000) };
      }
      case 'web_search':
        return { name: 'web_search', category: 'web', title: item.query ?? 'web search' };
      case 'file_change': {
        const files = (item.changes ?? []).map((c: any) => `${c.kind ?? ''} ${path.relative(this.cwd, c.path) || c.path}`.trim());
        return { name: 'apply_patch', category: 'edit', title: files.join(', ') || L('修改檔案', 'Edit files') };
      }
    }
    return undefined;
  }

  line(raw: string): void {
    const ev = parseJson(raw);
    if (!ev) {
      if (raw.trim()) this.sink.emit({ kind: 'stderr', text: raw });
      return;
    }
    switch (ev.type) {
      case 'thread.started':
        this.sessionId = ev.thread_id;
        this.sink.emit({ kind: 'session', sessionId: ev.thread_id });
        break;
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = ev.item ?? {};
        const done = ev.type === 'item.completed';
        if (item.type === 'agent_message') {
          if (done && item.text?.trim()) {
            this.lastText = item.text;
            this.sink.emit({ kind: 'message', text: item.text });
          }
          break;
        }
        if (item.type === 'reasoning') {
          if (done && item.text?.trim()) this.sink.emit({ kind: 'thinking', text: item.text });
          break;
        }
        if (item.type === 'todo_list') {
          const text = (item.items ?? []).map((t: any) => `${t.completed ? '☑' : '☐'} ${t.text}`).join('\n');
          if (this.todoSeq === undefined) {
            this.todoSeq = this.sink.emit({ kind: 'tool', tool: { id: item.id, name: 'todo_list', category: 'todo', title: L('待辦清單', 'Todo list'), output: text, status: 'running' } });
          } else {
            this.sink.updateTool(this.todoSeq, { output: text, status: done ? 'ok' : 'running' });
          }
          break;
        }
        if (item.type === 'error') {
          this.sink.emit({ kind: 'error', text: item.message });
          break;
        }
        const t = this.toolFor(item);
        if (!t) break;
        let seq = this.items.get(item.id);
        if (seq === undefined) {
          seq = this.sink.emit({ kind: 'tool', tool: { id: item.id, ...t, status: 'running' } });
          this.items.set(item.id, seq);
        }
        if (done) {
          const failed = item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0) || !!item.error;
          let output: string | undefined;
          if (item.type === 'command_execution') output = item.aggregated_output;
          else if (item.type === 'mcp_tool_call') output = item.error ? str(item.error) : contentText(item.result?.content);
          const files = item.type === 'file_change' ? (item.changes ?? []).map((c: any) => c.path) : undefined;
          this.sink.updateTool(seq, { status: failed ? 'error' : 'ok', output: trunc(output, 4000), title: t.title }, files);
        }
        break;
      }
      case 'turn.failed':
        this.error = ev.error?.message ?? 'turn failed';
        this.sink.emit({ kind: 'error', text: this.error });
        break;
      case 'error':
        if (/reconnect/i.test(ev.message ?? '')) this.sink.emit({ kind: 'info', text: ev.message });
        else {
          this.error = ev.message;
          this.sink.emit({ kind: 'error', text: ev.message });
        }
        break;
      case 'turn.completed': {
        const u = ev.usage;
        // Codex reports cached tokens as part of input_tokens.
        if (u) this.sink.emit({ kind: 'info', usage: { input: (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0), output: u.output_tokens ?? 0, cached: u.cached_input_tokens ?? 0 } });
        break;
      }
    }
  }

  end(): void {
    if (this.lastText) this.sink.emit({ kind: 'result', text: this.lastText });
  }

  finalText(): string {
    return this.lastText;
  }
}

/** Codex wraps commands as `"powershell.exe" -Command '...'`; show the inner command. */
function unwrapShell(command: string | undefined): string {
  if (!command) return 'shell';
  const m = /-Command\s+(['"])([\s\S]*)\1\s*$/.exec(command) ?? /-lc\s+(['"])([\s\S]*)\1\s*$/.exec(command);
  return m ? m[2] : command;
}

// ---------- Gemini CLI (stream-json) ----------

class GeminiParser implements StreamParser {
  sessionId?: string;
  error?: string;
  private tools = new Map<string, { seq: number; category: ToolCategory; input: unknown }>();
  private buffer = '';
  private lastText = '';

  constructor(private sink: ParserSink, private cwd: string) {}

  private flush() {
    if (this.buffer.trim()) {
      this.lastText = this.buffer;
      this.sink.emit({ kind: 'message', text: this.buffer });
    }
    this.buffer = '';
  }

  line(raw: string): void {
    const ev = parseJson(raw);
    if (!ev) {
      if (raw.trim()) this.sink.emit({ kind: 'stderr', text: raw });
      return;
    }
    switch (ev.type) {
      case 'init':
        this.sessionId = ev.session_id;
        this.sink.emit({ kind: 'session', sessionId: ev.session_id, text: ev.model });
        break;
      case 'message':
        if (ev.role !== 'assistant') break;
        if (ev.delta) this.buffer += ev.content ?? '';
        else {
          this.flush();
          this.buffer = ev.content ?? '';
          this.flush();
        }
        break;
      case 'tool_use': {
        this.flush();
        const c = classifyTool(ev.tool_name, ev.parameters, this.cwd);
        const seq = this.sink.emit({
          kind: 'tool',
          tool: { id: ev.tool_id, name: c.name, category: c.category, title: c.title, input: trunc(str(ev.parameters), 4000), status: 'running' },
        });
        this.tools.set(ev.tool_id, { seq, category: c.category, input: ev.parameters });
        break;
      }
      case 'tool_result': {
        const t = this.tools.get(ev.tool_id);
        if (!t) break;
        const ok = ev.status !== 'error';
        this.sink.updateTool(t.seq, { status: ok ? 'ok' : 'error', output: trunc(ok ? str(ev.output) : str(ev.error?.message ?? ev.output), 4000) }, ok ? filesOf(t.category, t.input) : undefined);
        break;
      }
      case 'error':
        this.sink.emit({ kind: ev.severity === 'warning' ? 'info' : 'error', text: ev.message });
        break;
      case 'result': {
        this.flush();
        const st = ev.stats ?? {};
        const usage = { input: st.input_tokens ?? st.input ?? 0, output: st.output_tokens ?? st.output ?? 0, cached: st.cached ?? st.cached_tokens ?? 0 };
        if (ev.status === 'error') {
          this.error = ev.error?.message ?? 'error';
          this.sink.emit({ kind: 'error', text: this.error, usage });
        } else {
          this.sink.emit({ kind: 'result', text: this.lastText, usage });
        }
        break;
      }
    }
  }

  end(): void {
    this.flush();
  }

  finalText(): string {
    return this.lastText;
  }
}

// ---------- Antigravity CLI (agy --output-format stream-json) ----------

/** Antigravity / OpenCode route MCP calls through one generic tool; recover "mcp__<server>__<tool>" from its parameters. */
function agyToolName(name: string, params: unknown): string {
  if (!(/mcp/i.test(name) || name === 'execute') || !params || typeof params !== 'object') return name;
  // OpenCode v2 calls MCP tools from generated code: `await tools.<server>.<tool>(...)`.
  const code = (params as Record<string, unknown>).code;
  if (typeof code === 'string') {
    const m = /tools\.([\w-]+)\.([\w-]+)\s*\(/.exec(code);
    return m && m[1] !== 'opencode' ? `mcp__${m[1]}__${m[2]}` : name;
  }
  const p = Object.fromEntries(Object.entries(params as Record<string, unknown>).map(([k, v]) => [k.toLowerCase().replace(/_/g, ''), v]));
  const server = p.servername ?? p.server ?? p.mcpserver;
  const tool = p.toolname ?? p.tool ?? p.name;
  return typeof server === 'string' && typeof tool === 'string' ? `mcp__${server}__${tool}` : name;
}

class AgyParser implements StreamParser {
  sessionId?: string;
  error?: string;
  private texts = new Map<number, { kind: 'message' | 'thinking'; text: string }>();
  private tools = new Map<number, { seq: number; category: ToolCategory; input: unknown }>();
  private lastText = '';
  private result?: string;

  constructor(private sink: ParserSink, private cwd: string) {}

  private flush(idx: number) {
    const t = this.texts.get(idx);
    if (!t) return;
    this.texts.delete(idx);
    if (!t.text.trim()) return;
    if (t.kind === 'message') this.lastText = t.text;
    this.sink.emit({ kind: t.kind, text: t.text });
  }

  line(raw: string): void {
    const ev = parseJson(raw);
    if (!ev) {
      if (raw.trim()) this.sink.emit({ kind: 'stderr', text: raw });
      return;
    }
    const kind: string = ev.event ?? ev.type;
    // The payload sits under a key named after the event (fall back to the top level).
    const body = (ev[kind] && typeof ev[kind] === 'object' ? ev[kind] : ev) as Record<string, any>;
    const conv = body.conversation_id ?? ev.conversation_id;
    if (conv) this.sessionId = conv;
    switch (kind) {
      case 'init':
        this.sink.emit({ kind: 'session', sessionId: conv, text: body.model ?? body.init?.model });
        break;
      case 'step_update': {
        const idx = Number(body.step_index ?? -1);
        const type = String(body.step_type ?? '').toLowerCase();
        const done = String(body.state ?? '').toUpperCase() === 'DONE';
        if (type === 'tool' || body.tool_name || body.tool_info) {
          const info = body.tool_info ?? {};
          let t = this.tools.get(idx);
          if (!t) {
            const c = classifyTool(agyToolName(body.tool_name ?? info.name ?? 'tool', info.parameters), info.parameters, this.cwd);
            const seq = this.sink.emit({ kind: 'tool', tool: { id: String(idx), name: c.name, category: c.category, title: c.title, input: trunc(str(info.parameters), 4000), status: 'running' } });
            t = { seq, category: c.category, input: info.parameters };
            this.tools.set(idx, t);
          } else if (info.parameters && !t.input) {
            const c = classifyTool(agyToolName(body.tool_name ?? info.name ?? 'tool', info.parameters), info.parameters, this.cwd);
            t.input = info.parameters;
            this.sink.updateTool(t.seq, { title: c.title, input: trunc(str(info.parameters), 4000) });
          }
          if (done) {
            const failed = !!info.error;
            this.sink.updateTool(t.seq, { status: failed ? 'error' : 'ok', output: trunc(failed ? str(info.error?.message ?? info.error) : str(info.output), 4000) }, failed ? undefined : filesOf(t.category, t.input));
          }
        } else if (typeof body.text_delta === 'string' || type.includes('response') || type.includes('think')) {
          const k = type.includes('think') ? 'thinking' : 'message';
          const cur = this.texts.get(idx) ?? { kind: k, text: '' };
          cur.text += body.text_delta ?? '';
          this.texts.set(idx, cur);
          if (done) this.flush(idx);
        }
        if (body.subagent_info && done) this.sink.emit({ kind: 'info', text: `subagent: ${trunc(str(body.subagent_info), 300)}` });
        break;
      }
      case 'result': {
        for (const idx of [...this.texts.keys()]) this.flush(idx);
        this.result = typeof body.response === 'string' ? body.response : undefined;
        const status = String(body.status ?? 'SUCCESS').toUpperCase();
        const u = body.usage ?? {};
        const usage = { input: u.input_tokens ?? 0, output: (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0), cached: u.cache_read_tokens ?? 0 };
        if (status !== 'SUCCESS') {
          this.error = body.error || status;
          this.sink.emit({ kind: 'error', text: this.error, usage });
        } else this.sink.emit({ kind: 'result', text: this.result ?? this.lastText, usage });
        break;
      }
    }
  }

  end(): void {
    for (const idx of [...this.texts.keys()]) this.flush(idx);
  }

  finalText(): string {
    return this.result ?? this.lastText;
  }
}

// ---------- OpenCode (opencode run --format json) ----------

class OpenCodeParser implements StreamParser {
  sessionId?: string;
  error?: string;
  private tools = new Map<string, { seq: number; category: ToolCategory; input: unknown }>();
  private texts = new Set<string>();
  private lastText = '';

  constructor(private sink: ParserSink, private cwd: string) {}

  line(raw: string): void {
    const ev = parseJson(raw);
    if (!ev) {
      if (raw.trim()) this.sink.emit({ kind: 'stderr', text: raw });
      return;
    }
    const part = (ev.part ?? {}) as Record<string, any>;
    const sid = ev.sessionID ?? part.sessionID;
    if (sid && !this.sessionId) {
      this.sessionId = sid;
      this.sink.emit({ kind: 'session', sessionId: sid });
    }
    switch (ev.type) {
      case 'text': {
        // A text part may be re-sent while streaming; emit each part once with its final text.
        if (part.text?.trim() && part.time?.end !== undefined && !this.texts.has(part.id)) {
          this.texts.add(part.id);
          this.lastText = part.text;
          this.sink.emit({ kind: 'message', text: part.text });
        }
        break;
      }
      case 'reasoning':
        if (part.text?.trim()) this.sink.emit({ kind: 'thinking', text: part.text });
        break;
      case 'tool_use': {
        const st = part.state ?? {};
        const key = String(part.callID ?? part.id ?? part.partID);
        let t = this.tools.get(key);
        if (!t) {
          const c = classifyTool(agyToolName(String(part.tool ?? 'tool'), st.input), st.input, this.cwd);
          const seq = this.sink.emit({ kind: 'tool', tool: { id: key, name: c.name, category: c.category, title: c.title, input: trunc(str(st.input), 4000), status: 'running' } });
          t = { seq, category: c.category, input: st.input };
          this.tools.set(key, t);
        }
        if (st.status === 'completed' || st.status === 'error') {
          const failed = st.status === 'error';
          this.sink.updateTool(t.seq, { status: failed ? 'error' : 'ok', output: trunc(str(failed ? st.error ?? st.output : st.output), 4000) }, failed ? undefined : filesOf(t.category, t.input));
        }
        break;
      }
      case 'step_finish': {
        const tk = part.tokens ?? {};
        this.sink.emit({ kind: 'info', usage: { input: tk.input ?? 0, output: (tk.output ?? 0) + (tk.reasoning ?? 0), cached: tk.cache?.read ?? 0, costUsd: typeof part.cost === 'number' ? part.cost : undefined } });
        break;
      }
      case 'error': {
        const e = ev.error ?? part.error ?? {};
        this.error = e.data?.message ?? e.message ?? str(e);
        this.sink.emit({ kind: 'error', text: this.error });
        break;
      }
    }
  }

  end(): void {
    if (this.lastText) this.sink.emit({ kind: 'result', text: this.lastText });
  }

  finalText(): string {
    return this.lastText;
  }
}

// ---------- GitHub Copilot CLI (--output-format json) ----------

class CopilotParser implements StreamParser {
  sessionId?: string;
  error?: string;
  private tools = new Map<string, { seq: number; category: ToolCategory; input: unknown }>();
  private lastText = '';

  constructor(private sink: ParserSink, private cwd: string) {}

  line(raw: string): void {
    const ev = parseJson(raw);
    if (!ev) {
      if (raw.trim()) this.sink.emit({ kind: 'stderr', text: raw });
      return;
    }
    const d = ev.data ?? {};
    switch (ev.type) {
      case 'session.tools_updated':
        if (d.model) this.sink.emit({ kind: 'session', text: d.model });
        break;
      case 'assistant.reasoning':
        if (typeof d.content === 'string' && d.content.trim()) this.sink.emit({ kind: 'thinking', text: d.content });
        break;
      case 'assistant.message':
        if (typeof d.content === 'string' && d.content.trim()) {
          this.lastText = d.content;
          this.sink.emit({ kind: 'message', text: d.content });
        }
        break;
      case 'tool.execution_start': {
        // MCP tools arrive as "<server>-<tool>"; normalize so hub tools are recognized.
        const rawName = d.mcpServerName && d.mcpToolName ? `mcp__${d.mcpServerName}__${d.mcpToolName}` : String(d.toolName ?? 'tool');
        const c = classifyTool(rawName, d.arguments, this.cwd);
        const seq = this.sink.emit({ kind: 'tool', tool: { id: d.toolCallId, name: c.name, category: c.category, title: c.title, input: trunc(str(d.arguments), 4000), status: 'running' } });
        this.tools.set(d.toolCallId, { seq, category: c.category, input: d.arguments });
        break;
      }
      case 'tool.execution_complete': {
        const t = this.tools.get(d.toolCallId);
        if (!t) break;
        const ok = d.success !== false;
        const output = ok ? (d.result?.content ?? contentText(d.result?.contents)) : (d.error?.message ?? str(d.error));
        this.sink.updateTool(t.seq, { status: ok ? 'ok' : 'error', output: trunc(str(output), 4000) }, ok ? filesOf(t.category, t.input) : undefined);
        break;
      }
      case 'result':
        this.sessionId = ev.sessionId ?? this.sessionId;
        if (ev.exitCode && !this.error) this.error = L(`Copilot 結束代碼 ${ev.exitCode}`, `Copilot exited with code ${ev.exitCode}`);
        this.sink.emit({ kind: this.error ? 'error' : 'result', text: this.error ?? this.lastText });
        break;
      default:
        if (typeof ev.type === 'string' && ev.type.endsWith('.error')) {
          this.error = d.message ?? str(d);
          this.sink.emit({ kind: 'error', text: this.error });
        }
    }
  }

  end(): void {}

  finalText(): string {
    return this.lastText;
  }
}

// ---------- Plain text ----------

class TextParser implements StreamParser {
  private all: string[] = [];
  constructor(private sink: ParserSink) {}
  line(raw: string): void {
    this.all.push(raw);
    if (raw.trim()) this.sink.emit({ kind: 'message', text: raw });
  }
  end(): void {
    this.sink.emit({ kind: 'result', text: this.finalText() });
  }
  finalText(): string {
    return this.all.join('\n').trim();
  }
}

export function createParser(format: OutputFormat, sink: ParserSink, cwd: string): StreamParser {
  switch (format) {
    case 'claude-stream':
      return new ClaudeStreamParser(sink, cwd);
    case 'codex-jsonl':
      return new CodexParser(sink, cwd);
    case 'gemini-stream':
      return new GeminiParser(sink, cwd);
    case 'agy-stream':
      return new AgyParser(sink, cwd);
    case 'opencode-json':
      return new OpenCodeParser(sink, cwd);
    case 'copilot-json':
      return new CopilotParser(sink, cwd);
    default:
      return new TextParser(sink);
  }
}
