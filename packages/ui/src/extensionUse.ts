import type { AgentEvent } from '../../core/src/types';
import { GRAPH_TOOL, graphToolNames } from '../../core/src/graphUsage';

/** A tool call that used a skill (read its SKILL.md), Graphify or CodeGraph (a command or one of the graph tools). */
export type ExtensionUse = { kind: 'skill'; name: string } | { kind: 'graphify' | 'codegraph'; action: string; arg?: string };

/** What a tool event did with the skills / Graphify / CodeGraph, read from its title and input. */
export function extensionUse(e: AgentEvent): ExtensionUse | undefined {
  const tool = e.tool;
  if (!tool) return undefined;
  const text = `${tool.title ?? ''}\n${tool.input ?? ''}`;
  // A skill folder's SKILL.md (Aivenue's library, a bundled extension, or ~/.claude/skills).
  const skill = /[\\/]skills[\\/]([^\\/"'\s]+)[\\/]SKILL\.md/i.exec(text);
  if (skill && (tool.category === 'read' || /read|view|cat|type|get-content/i.test(tool.name + text))) return { kind: 'skill', name: skill[1] };
  const g = /\bgraphify(?:\.exe)?\s+(update|query|path|explain|add|install)\b\s*("[^"]*"|'[^']*'|\S+)?/i.exec(text);
  if (g && tool.category === 'command') return { kind: 'graphify', action: g[1].toLowerCase(), arg: g[2]?.replace(/^["']|["']$/g, '') };
  const c = /\bcodegraph(?:\.cmd|\.exe)?\s+(explore|node|query|callers|callees|impact|files|init|index|sync|status)\b\s*("[^"]*"|'[^']*'|\S+)?/i.exec(text);
  if (c && tool.category === 'command') return { kind: 'codegraph', action: c[1].toLowerCase(), arg: c[2]?.replace(/^["']|["']$/g, '') };
  // The graph tools (graph_query… for Graphify, codegraph_explore… for CodeGraph): the same lookups as the commands.
  const m = tool.category === 'hub' ? GRAPH_TOOL.exec(tool.name ?? '') : null;
  if (m) return { kind: m[3] ? 'graphify' : 'codegraph', action: (m[3] ?? m[4]).toLowerCase(), arg: /:\s*(.+)$/.exec(tool.title ?? '')?.[1] };
  // Called from the code of an OpenCode code-mode call (its event is named after its first tool).
  const named = graphToolNames(tool);
  if (named.length) {
    const first = named[0];
    return first.startsWith('codegraph_') ? { kind: 'codegraph', action: first.slice('codegraph_'.length) } : { kind: 'graphify', action: first.slice('graph_'.length) };
  }
  return undefined;
}

/** Skills, Graphify and CodeGraph uses of one agent, for its header; `codegraphTools` says which CodeGraph tools. */
export function extensionSummary(events: AgentEvent[]): { skills: string[]; graphify: number; codegraph: number; codegraphTools: string[] } {
  const skills = new Set<string>();
  // A tool call shows up when it starts and again when it ends: count each call once (its last version).
  const calls = new Map<string, { graphify: number; codegraph: string[] }>();
  for (const e of events) {
    if (e.kind !== 'tool' || !e.tool) continue;
    const u = extensionUse(e);
    if (u?.kind === 'skill') skills.add(u.name);
    const key = e.tool.id ?? String(e.seq);
    if (u?.kind !== 'graphify' && u?.kind !== 'codegraph') {
      calls.delete(key);
      continue;
    }
    const named = graphToolNames(e.tool);
    if (named.length) calls.set(key, { graphify: named.filter((n) => n.startsWith('graph_')).length, codegraph: named.filter((n) => n.startsWith('codegraph_')) });
    else calls.set(key, u.kind === 'graphify' ? { graphify: 1, codegraph: [] } : { graphify: 0, codegraph: [`codegraph ${u.action}`] });
  }
  const all = [...calls.values()];
  const cg = all.flatMap((x) => x.codegraph);
  return { skills: [...skills], graphify: all.reduce((a, x) => a + x.graphify, 0), codegraph: cg.length, codegraphTools: [...new Set(cg)] };
}
