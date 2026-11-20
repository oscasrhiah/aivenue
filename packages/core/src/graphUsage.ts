import type { AgentEvent } from './types';

/*
 * How much one agent used the project's graphs, counted the way the user's scripts/graphify-usage.mjs counts Graphify
 * (shared by the agent map and anything else that needs the numbers), with CodeGraph's tools and commands counted the
 * same way. Pure: no file or process access, so the page can use it.
 */

/** A graph lookup in a shell command. */
export const GRAPH_COMMAND = /(^|[\s;&|("'])graphify(\.exe)?\s+(query|path|explain)\b/;
/** A graph build in a shell command. */
export const BUILD_COMMAND = /(^|[\s;&|("'])graphify(\.exe)?\s+update\b/;
/** A CodeGraph lookup in a shell command (its CLI prints what its tools return). */
export const CODEGRAPH_COMMAND = /(^|[\s;&|("'])codegraph(\.cmd|\.exe)?\s+(explore|node|query|callers|callees|impact|files)\b/;
/** A CodeGraph index build or update in a shell command. */
export const CODEGRAPH_BUILD_COMMAND = /(^|[\s;&|("'])codegraph(\.cmd|\.exe)?\s+(init|index|sync)\b/;
/** A plain search or file read in a shell command. */
export const SEARCH_COMMAND = /(^|[\s;&|("'])(rg|grep|findstr|Select-String|Get-ChildItem|find|ls|cat|head|tail|Get-Content|sed -n)\b/;
/**
 * A graph tool: Aivenue's Graphify tools (graph_query, graph_path, graph_explain) and CodeGraph's (codegraph_explore,
 * codegraph_node, codegraph_search, codegraph_callers, codegraph_callees, codegraph_impact), however the CLI prefixes
 * MCP tool names.
 */
export const GRAPH_TOOL = /(^|[^a-z])(graph_(query|path|explain)|codegraph_(explore|node|search|callers|callees|impact))$/i;

export interface GraphUsage {
  /** Graph lookups: graphify query / path / explain and CodeGraph lookup commands, and the graph tools. */
  graph: number;
  /** graphify update and codegraph init / index / sync commands. */
  build: number;
  /** grep-like commands, search tools and file reads. */
  search: number;
  /** Of those, the ones made before the first graph lookup (all of them when it never looked anything up). */
  before: number;
}

type ToolLike = NonNullable<AgentEvent['tool']>;

/** A graph tool called from code: OpenCode's code mode runs several tools in one call (tools.aivenue.graph_query({…})). */
const GRAPH_TOOL_IN_CODE = /\b(graph_(?:query|path|explain)|codegraph_(?:explore|node|search|callers|callees|impact))\s*\(/g;

/** The graph tools one tool call ran, by name: the tool itself, or each one called from the code of a code-mode call. */
export function graphToolNames(t: Pick<ToolLike, 'name' | 'category' | 'input'>): string[] {
  const own = t.category === 'hub' ? GRAPH_TOOL.exec(t.name ?? '') : null;
  if (own) return [own[2].toLowerCase()];
  if (t.category !== 'hub' && t.category !== 'other') return [];
  let code = '';
  try {
    code = String((JSON.parse(t.input || '{}') as { code?: unknown }).code ?? '');
  } catch {
    // not JSON
  }
  return [...code.matchAll(GRAPH_TOOL_IN_CODE)].map((m) => m[1]);
}

/**
 * How many graph tools one tool call ran: 1 for the tool itself, or each one called from the code of a code-mode call
 * (whose event is named after its first tool, e.g. report_progress, or is a plain "execute").
 */
export function graphToolCalls(t: Pick<ToolLike, 'name' | 'category' | 'input'>): number {
  return graphToolNames(t).length;
}

/** The command a tool ran: its input's `command`, else its title. */
function commandOf(t: ToolLike): string {
  let cmd: unknown = '';
  try {
    cmd = (JSON.parse(t.input || '{}') as { command?: unknown }).command ?? '';
  } catch {
    // input that is not JSON
  }
  return String(cmd || t.title || '');
}

/** Each tool call once (by its id, the last version of it), in the order the calls first appeared. */
function toolCalls(events: Pick<AgentEvent, 'kind' | 'tool'>[]): ToolLike[] {
  const tools = new Map<string, ToolLike>();
  for (const e of events) if (e.kind === 'tool' && e.tool) tools.set(e.tool.id, e.tool);
  return [...tools.values()];
}

/** The graph lookups of one call, by name ("graphify query", "codegraph callers", "codegraph_explore"…). */
function lookupsOf(t: ToolLike): string[] {
  const named = graphToolNames(t);
  if (named.length) return named;
  if (t.category !== 'command') return [];
  const cmd = commandOf(t);
  const g = GRAPH_COMMAND.exec(cmd) ?? CODEGRAPH_COMMAND.exec(cmd);
  return g ? [`${/codegraph/i.test(g[0]) ? 'codegraph' : 'graphify'} ${g[3]}`] : [];
}

export function graphUsage(events: Pick<AgentEvent, 'kind' | 'tool'>[]): GraphUsage {
  const r: GraphUsage = { graph: 0, build: 0, search: 0, before: 0 };
  for (const t of toolCalls(events)) {
    const cmd = t.category === 'command' ? commandOf(t) : '';
    const lookups = lookupsOf(t).length;
    if (lookups) r.graph += lookups;
    else if (t.category === 'command' && (BUILD_COMMAND.test(cmd) || CODEGRAPH_BUILD_COMMAND.test(cmd))) r.build++;
    else if (t.category === 'search' || t.category === 'read' || (t.category === 'command' && SEARCH_COMMAND.test(cmd))) {
      r.search++;
      if (!r.graph) r.before++;
    }
  }
  return r;
}

/** The graph lookups by tool or command, most used first: what a 查圖 count is made of. */
export function graphLookupsByTool(events: Pick<AgentEvent, 'kind' | 'tool'>[]): [string, number][] {
  const by = new Map<string, number>();
  for (const t of toolCalls(events)) for (const n of lookupsOf(t)) by.set(n, (by.get(n) ?? 0) + 1);
  return [...by].sort((a, b) => b[1] - a[1]);
}
