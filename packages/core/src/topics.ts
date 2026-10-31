import * as path from 'node:path';
import type { AgentEvent, AgentRunInfo, WorkflowRun } from './types';
import { fileReadOf, who } from './ledger';

/**
 * The shared records sorted by subject, without a model call: every file (who read and changed it, what it showed,
 * notes and issues that name it), every command (its runs and results), every review or verification issue, and the
 * notes by kind. The shared context shows a table of contents; `read_context {topic}` returns one subject whole.
 */

export type TopicKind = 'file' | 'command' | 'issue' | 'fact' | 'decision' | 'inference' | 'checkpoint';

export interface TopicItem {
  ts: number;
  agentId?: string;
  /** read / changed / ran / note / issue … */
  what: string;
  text: string;
  ok?: boolean;
}

export interface Topic {
  key: string;
  kind: TopicKind;
  title: string;
  items: TopicItem[];
  /** Newest item. */
  ts: number;
}

const flat = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// eslint-disable-next-line no-control-regex
const plain = (s: string | undefined) => (s ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();

/** One item per record, so a topic's full text stays bounded per item (the records keep everything). */
const ITEM_CHARS = 8000;

/** Paths with a file extension, as they appear in notes and issues. */
const PATHS = /(?:[A-Za-z]:)?(?:[\w.~-]+[\\/])*[\w-][\w.-]*\.(?:tsx?|jsx?|mjs|cjs|json|md|py|ipynb|go|rs|java|kt|cs|cpp|cc|c|h|hpp|css|scss|html|vue|svelte|ya?ml|toml|ini|cfg|sh|ps1|bat|sql|txt|csv|tsv|log|pt|pth|ckpt|onnx|wav|mp3|flac|parquet|lock)\b/g;

export function buildTopics(run: WorkflowRun, eventsOf: (agentId: string) => AgentEvent[]): Map<string, Topic> {
  const topics = new Map<string, Topic>();
  const rel = (f: string) => {
    const r = path.relative(run.config.cwd, path.resolve(run.config.cwd, f));
    return (r && !r.startsWith('..') && !path.isAbsolute(r) ? r : f).replace(/\\/g, '/');
  };
  const add = (key: string, kind: TopicKind, title: string, item: TopicItem) => {
    const t = topics.get(key) ?? topics.set(key, { key, kind, title, items: [], ts: 0 }).get(key)!;
    t.items.push({ ...item, text: clip(item.text, ITEM_CHARS) });
    t.ts = Math.max(t.ts, item.ts);
  };
  const fileKey = (f: string) => `file:${rel(f).toLowerCase()}`;
  for (const a of Object.values(run.agents)) {
    if (a.role === 'test' || a.role === 'compactor') continue;
    for (const e of eventsOf(a.id)) {
      if (e.kind !== 'tool' || !e.tool || e.tool.status === 'running') continue;
      const t = e.tool;
      if (t.category === 'edit') {
        for (const f of e.files?.length ? e.files : [t.title]) if (f) add(fileKey(f), 'file', rel(f), { ts: e.ts, agentId: a.id, what: 'changed', text: flat(t.title) });
        continue;
      }
      const cmd = flat(t.title || t.input);
      const read = t.category === 'read' ? flat(t.title) : t.category === 'command' && t.status === 'ok' ? fileReadOf(cmd) : undefined;
      if (read) {
        add(fileKey(read), 'file', rel(read), { ts: e.ts, agentId: a.id, what: 'read', text: plain(t.output) });
        continue;
      }
      if ((t.category === 'command' || t.category === 'search') && cmd) {
        const k = cmd.replace(/^(cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*)+/i, '');
        add(`command:${k.toLowerCase()}`, 'command', k, { ts: e.ts, agentId: a.id, what: 'ran', ok: t.status === 'ok', text: plain(t.output) });
      }
    }
  }
  // Notes by kind, and also under every file they name.
  for (const n of run.notes ?? []) {
    const kind: TopicKind = /^\s*CHECKPOINT\b/i.test(n.text) || /^Hand-off summary of /.test(n.text) || /^HAND-OFF\b/.test(n.text) ? 'checkpoint' : (n.kind ?? 'inference');
    const item = { ts: n.ts, agentId: n.agentId, what: `note (${kind})`, text: n.text };
    add(`${kind}s`, kind, `${kind}s`, item);
    for (const f of new Set(n.text.match(PATHS) ?? [])) if (topics.has(fileKey(f))) add(fileKey(f), 'file', rel(f), item);
  }
  // Review and verification issues, each with its whole history; also under the file it points at.
  for (const [stage, st] of Object.entries(run.stages)) {
    for (const r of st?.rounds ?? []) {
      for (const i of [...(r.review?.issues ?? []), ...(r.verification?.issues ?? [])]) {
        const text = `[${i.severity}] ${i.title}${i.location ? ` (${i.location})` : ''}${i.detail ? `\n${i.detail}` : ''}`;
        const by = r.reviewerAgentId ? run.agents[r.reviewerAgentId] : undefined;
        const item = { ts: by?.endedAt ?? by?.startedAt ?? 0, agentId: r.reviewerAgentId, what: `${stage} round ${r.n} issue ${i.id}`, text };
        add(`issue:${i.id.toLowerCase()}`, 'issue', `${i.id} ${i.title}`, item);
        const loc = i.location?.match(PATHS)?.[0];
        if (loc && topics.has(fileKey(loc))) add(fileKey(loc), 'file', rel(loc), item);
      }
      for (const resp of r.submission?.responses ?? []) {
        const key = `issue:${resp.issue_id.toLowerCase()}`;
        const author = r.authorAgentId ? run.agents[r.authorAgentId] : undefined;
        if (topics.has(key)) add(key, 'issue', topics.get(key)!.title, { ts: author?.endedAt ?? author?.startedAt ?? 0, agentId: r.authorAgentId, what: `response: ${resp.action}`, text: resp.note ?? '' });
      }
    }
  }
  return topics;
}

const LABEL: Record<TopicKind, string> = { file: 'files', command: 'commands', issue: 'issues', fact: 'facts', decision: 'decisions', inference: 'inferences', checkpoint: 'checkpoints' };

/** The table of contents for the shared context: how much there is on what, and what changed most recently. */
export function topicIndexBlock(topics: Map<string, Topic>, budget: number, since = 0): string {
  if (!topics.size) return '';
  const all = [...topics.values()];
  const count = (k: TopicKind) => all.filter((t) => t.kind === k).length;
  const sizes = (['file', 'command', 'issue', 'fact', 'decision', 'inference', 'checkpoint'] as TopicKind[])
    .map((k) => (k === 'file' || k === 'command' || k === 'issue' ? (count(k) ? `${count(k)} ${LABEL[k]}` : '') : topics.get(`${k}s`) ? `${topics.get(`${k}s`)!.items.length} ${LABEL[k]}` : ''))
    .filter(Boolean);
  const recent = all.filter((t) => t.ts > since && (t.kind === 'file' || t.kind === 'command' || t.kind === 'issue')).sort((x, y) => y.ts - x.ts);
  const lines: string[] = [];
  let used = 0;
  for (const t of recent) {
    const line = `- ${t.key.startsWith('command:') ? `command:${clip(t.title, 80)}` : t.key} (${t.items.length})`;
    if (used + line.length > budget - 600) break;
    lines.push(line);
    used += line.length + 1;
  }
  return [
    `SHARED RECORDS BY TOPIC: ${sizes.join(', ')}. Call \`read_context\` {topic} to get everything on one subject at once — e.g. {topic: "file:src/model.py"}, {topic: "command:pytest"}, {topic: "issue:R2"}, {topic: "facts"}, {topic: "decisions"}, {topic: "checkpoints"}, {topic: "knowledge"} for the organized knowledge, {topic: "index"} for every topic.`,
    lines.length ? `Recently active${since ? ' (since your last turn)' : ''}:\n${lines.join('\n')}${recent.length > lines.length ? `\n- (${recent.length - lines.length} more: read_context {topic: "index"})` : ''}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Every topic, for read_context {topic: "index"}. */
export function topicList(topics: Map<string, Topic>): string {
  const groups = new Map<TopicKind, Topic[]>();
  for (const t of topics.values()) (groups.get(t.kind) ?? groups.set(t.kind, []).get(t.kind)!).push(t);
  const out: string[] = ['ALL TOPICS (read_context {topic: "<key>"}; a part of a key works too):'];
  for (const [kind, list] of groups) {
    out.push(`\n${LABEL[kind].toUpperCase()}:`);
    for (const t of list.sort((x, y) => y.ts - x.ts)) out.push(`- ${t.key.startsWith('command:') ? `command:${clip(t.title, 120)}` : t.key} (${t.items.length}, last ${new Date(t.ts).toISOString().slice(0, 16).replace('T', ' ')} UTC)`);
  }
  return out.join('\n');
}

/**
 * One subject in full, newest last: the exact key, else every topic whose key contains the text ("model.py",
 * "pytest", "r2"). Over the budget, the oldest items go first.
 */
export function topicDetail(run: WorkflowRun, topics: Map<string, Topic>, query: string, budget = 60000): string {
  const q = query.trim().toLowerCase();
  const exact = topics.get(q) ?? topics.get(`${q.replace(/s$/, '')}s`);
  const kindPrefix = /^(file|command|issue):/.exec(q)?.[1];
  const part = kindPrefix ? q.slice(kindPrefix.length + 1) : q;
  const matches = exact ? [exact] : [...topics.values()].filter((t) => (!kindPrefix || t.kind === kindPrefix) && (t.key.includes(part) || t.title.toLowerCase().includes(part)));
  if (!matches.length) return `No topic matches "${query}". Call read_context {topic: "index"} for every topic, or search_records {q} to search all records.`;
  const agentOf = (id?: string): AgentRunInfo | undefined => (id ? run.agents[id] : undefined);
  const blocks: string[] = [];
  let used = 0;
  for (const t of matches.sort((x, y) => y.ts - x.ts).slice(0, 12)) {
    const items = [...t.items].sort((x, y) => x.ts - y.ts);
    const rows: string[] = [];
    // Newest first within the budget, shown oldest first.
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      const row = `- ${new Date(it.ts).toISOString().slice(11, 16)} ${it.agentId ? `[${who(agentOf(it.agentId))}] ` : ''}${it.what}${it.ok === false ? ' ✗' : ''}${it.text ? `:\n    ${it.text.replace(/\n/g, '\n    ')}` : ''}`;
      if (used + row.length > budget) {
        rows.unshift(`- (${i + 1} older item(s) left out; search_records finds them)`);
        break;
      }
      rows.unshift(row);
      used += row.length + 1;
    }
    blocks.push(`TOPIC ${t.key.startsWith('command:') ? `command:${t.title}` : t.key} (${t.items.length} item(s)):\n${rows.join('\n')}`);
    if (used >= budget) break;
  }
  if (matches.length > 12) blocks.push(`(${matches.length - 12} more topics match; be more specific)`);
  return blocks.join('\n\n');
}
