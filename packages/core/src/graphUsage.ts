import type { AgentEvent } from './types';

/*
 * How much one agent used the project graph, counted the way the user's scripts/graphify-usage.mjs counts it (shared by
 * the agent map and anything else that needs the numbers). Pure: no file or process access, so the page can use it.
 */

/** A graph lookup in a shell command. */
export const GRAPH_COMMAND = /(^|[\s;&|("'])graphify(\.exe)?\s+(query|path|explain)\b/;
/** A graph build in a shell command. */
export const BUILD_COMMAND = /(^|[\s;&|("'])graphify(\.exe)?\s+update\b/;
/** A plain search or file read in a shell command. */
export const SEARCH_COMMAND = /(^|[\s;&|("'])(rg|grep|findstr|Select-String|Get-ChildItem|find|ls|cat|head|tail|Get-Content|sed -n)\b/;
/** Aivenue's own graph tools (graph_query, graph_path, graph_explain), however the CLI prefixes MCP tool names. */
export const GRAPH_TOOL = /(^|[^a-z])graph_(query|path|explain)$/i;

export interface GraphUsage {
  /** Graph lookups: graphify query / path / explain commands and Aivenue's graph tools. */
  graph: number;
  /** graphify update commands. */
  build: number;
  /** grep-like commands, search tools and file reads. */
  search: number;
  /** Of those, the ones made before the first graph lookup (all of them when it never looked anything up). */
  before: number;
}

type ToolLike = NonNullable<AgentEvent['tool']>;

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

/**
 * The counts over an agent's events: each tool call once (by its id, the last version of it), in the order the calls
 * first appeared.
 */
export function graphUsage(events: Pick<AgentEvent, 'kind' | 'tool'>[]): GraphUsage {
  const tools = new Map<string, ToolLike>();
  for (const e of events) if (e.kind === 'tool' && e.tool) tools.set(e.tool.id, e.tool);
  const r: GraphUsage = { graph: 0, build: 0, search: 0, before: 0 };
  for (const t of tools.values()) {
    const cmd = t.category === 'command' ? commandOf(t) : '';
    if ((t.category === 'command' && GRAPH_COMMAND.test(cmd)) || (t.category === 'hub' && GRAPH_TOOL.test(t.name ?? ''))) r.graph++;
    else if (t.category === 'command' && BUILD_COMMAND.test(cmd)) r.build++;
    else if (t.category === 'search' || t.category === 'read' || (t.category === 'command' && SEARCH_COMMAND.test(cmd))) {
      r.search++;
      if (!r.graph) r.before++;
    }
  }
  return r;
}
