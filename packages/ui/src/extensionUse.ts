import type { AgentEvent } from '../../core/src/types';

/** A tool call that used a skill (read its SKILL.md) or the graphify command. */
export type ExtensionUse = { kind: 'skill'; name: string } | { kind: 'graphify'; action: string; arg?: string };

/** What a tool event did with the skills / Graphify, read from its title and input. */
export function extensionUse(e: AgentEvent): ExtensionUse | undefined {
  const tool = e.tool;
  if (!tool) return undefined;
  const text = `${tool.title ?? ''}\n${tool.input ?? ''}`;
  // A skill folder's SKILL.md (Aivenue's library, a bundled extension, or ~/.claude/skills).
  const skill = /[\\/]skills[\\/]([^\\/"'\s]+)[\\/]SKILL\.md/i.exec(text);
  if (skill && (tool.category === 'read' || /read|view|cat|type|get-content/i.test(tool.name + text))) return { kind: 'skill', name: skill[1] };
  const g = /\bgraphify(?:\.exe)?\s+(update|query|path|explain|add|install)\b\s*("[^"]*"|'[^']*'|\S+)?/i.exec(text);
  if (g && tool.category === 'command') return { kind: 'graphify', action: g[1].toLowerCase(), arg: g[2]?.replace(/^["']|["']$/g, '') };
  return undefined;
}

/** Skills and Graphify uses of one agent, for its header. */
export function extensionSummary(events: AgentEvent[]): { skills: string[]; graphify: number } {
  const skills = new Set<string>();
  // A tool call shows up when it starts and again when it ends: count each call once.
  const calls = new Set<string>();
  for (const e of events) {
    if (e.kind !== 'tool') continue;
    const u = extensionUse(e);
    if (u?.kind === 'skill') skills.add(u.name);
    if (u?.kind === 'graphify') calls.add(e.tool?.id ?? String(e.seq));
  }
  return { skills: [...skills], graphify: calls.size };
}
