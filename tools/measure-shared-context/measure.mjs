// Measures how well Aivenue's shared context is used in recorded workflows. Read-only: it never writes to the data folder.
// node measure.mjs [--home <dataDir>] [--run <runId>] [--last <n>] [--out <report.md>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const home = opt('home', process.env.AIVENUE_HOME || path.join(os.homedir(), '.aivenue'));
const runsDir = path.join(home, 'runs');
const outFile = opt('out', 'shared-context-report.md');
if (!fs.existsSync(runsDir)) {
  console.error(`No runs folder at ${runsDir}. Pass --home <Aivenue data folder>.`);
  process.exit(1);
}

// Secrets never leave the machine: long tokens, key=value secrets and home paths are masked.
const mask = (s) =>
  String(s ?? '')
    .replace(/(api[_-]?key|token|secret|password|passwd|bearer|authorization)(\s*[:=]\s*|\s+)\S+/gi, '$1$2***')
    .replace(/\b(sk|ghp|gho|github_pat|xox[bp]|AIza)[A-Za-z0-9_\-]{8,}/g, '***')
    .replace(/\b[A-Za-z0-9+/_\-]{32,}={0,2}\b/g, '***')
    .replace(new RegExp(os.homedir().replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'), 'gi'), '~');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// The same command written slightly differently counts as the same: no leading "cd <dir> &&", quotes or extra spaces.
const norm = (cmd) =>
  flat(cmd)
    .replace(/^(cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*)+/i, '')
    .replace(/["']/g, '')
    .replace(/\\/g, '/')
    .toLowerCase();
const KIND = [
  ['test', /\b(test|pytest|jest|vitest|mocha|go test|cargo test|npm (run )?test|unittest)\b/],
  ['build', /\b(build|tsc|compile|make|cargo build|gradle|mvn|webpack|vite build|esbuild)\b/],
  ['install', /\b(install|pip |npm i\b|npm ci|yarn add|pnpm add|apt|brew)\b/],
  ['git', /^git\b/],
  ['list/find', /^(ls|dir|find|tree|get-childitem|gci|fd|rg --files)\b/],
  ['read file', /^(cat|type|head|tail|get-content|sed -n|less|more)\b/],
  ['search', /^(grep|rg|findstr|select-string|ag)\b/],
  ['env/version', /(--version|\bwhich\b|\bwhere\b|nvidia-smi|python -v|node -v|pip (list|show)|env\b|printenv)/],
];
const kindOf = (c) => KIND.find(([, re]) => re.test(c))?.[0] ?? 'other';
// Waiting on or peeking at a background job: its output changes without any agent editing a file, so a repeat is not waste.
const POLL = /\b(sleep|until|while|pgrep|watch|tail -f|nvidia-smi|ps\b|date\b)|\.(log|out|err|exit_code)\b/;
// Shell commands that change files count as edits, like the edit tool does.
const SHELL_EDIT = /(\bsed\s+-i|(^|[^0-9&>|])>{1,2}\s*(?!&|\/dev\/null)\S|\btee\b|^(mv|cp|rm|touch|mkdir|patch)\b|[;&|]\s*(mv|cp|rm|touch|patch)\b|\bgit\s+(checkout|apply|reset|stash|restore|merge|pull)\b)/;
// A command that just prints one file ("cat f", "sed -n 1,80p f", "head -n 50 f"): the file it reads, else undefined.
const fileRead = (c) => {
  if (/[|;&<>`$]/.test(c)) return undefined;
  const m = /^(cat|type|get-content|less|more|head|tail|sed -n)\s+(.+)$/.exec(c);
  if (!m) return undefined;
  const parts = m[2].split(' ').filter((p) => !p.startsWith('-') && !/^\d+$/.test(p) && !(m[1] === 'sed -n' && /^[\d,$]+p$/.test(p)));
  return parts.length === 1 ? parts[0] : undefined;
};

function readEvents(dir, agentId) {
  const f = path.join(dir, 'events', `${agentId}.jsonl`);
  if (!fs.existsSync(f)) return [];
  const out = [];
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/** The SHARED CONTEXT part of a prompt Aivenue sent (from its header to the read_context footer). */
function sharedPart(prompt) {
  const i = prompt.search(/\nSHARED CONTEXT/);
  if (i < 0) return undefined;
  const rest = prompt.slice(i);
  // The footer, before and after 0.2.2 ("…, and list what you learned in `findings` when you submit.").
  const m = /to tell all later agents about a decision, a gotcha or where something lives(?:\.|, and list what you learned in `findings` when you submit\.)/.exec(rest);
  const stop = m ? m.index + m[0].length : -1;
  const block = stop >= 0 ? rest.slice(0, stop) : rest;
  const tail = stop >= 0 ? rest.slice(stop) : '';
  const full = /FULL TRANSCRIPT OF THE PREVIOUS AGENT/.exec(tail);
  return { chars: block.length + (full ? tail.length - full.index : 0), shortened: /shortened to fit your model|older item\(s\) left out/.test(block), nothingNew: /nothing new from the other agents/.test(block) };
}

const SHARED_TOOLS = ['read_context', 'search_records', 'post_note', 'ask_advisor', 'wait_subagent', 'spawn_subagent'];
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
const hours = (ms) => `${(ms / 3600000).toFixed(1)} h`;

function measure(id) {
  const dir = path.join(runsDir, id);
  const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
  const agents = Object.values(run.agents ?? {}).filter((a) => a.role !== 'test');
  const roles = {};
  for (const a of agents) roles[a.role] = (roles[a.role] ?? 0) + 1;

  const cmds = []; // { ts, agent, role, key, kind, poll, ok, outLen }
  const reads = []; // { ts, agent, file, viaShell }
  const edits = []; // ts
  const toolUse = Object.fromEntries(SHARED_TOOLS.map((t) => [t, 0]));
  const shared = []; // per prompt
  const compactions = [];
  let outputChars = 0;
  let webCalls = 0;
  let windowMax = 0;

  for (const a of agents) {
    const ev = readEvents(dir, a.id);
    let lastUsed = 0;
    for (const e of ev) {
      if (e.kind === 'prompt' && e.text) {
        const s = sharedPart(e.text);
        shared.push({ agent: a.id, role: a.role, promptChars: e.text.length, ...(s ?? { chars: 0, none: true }) });
      }
      if (e.context?.used) {
        // Its own conversation shrank sharply: the CLI compacted it.
        if (lastUsed > 20000 && e.context.used < lastUsed * 0.6) compactions.push({ agent: a.id, role: a.role, from: lastUsed, to: e.context.used });
        lastUsed = e.context.used;
        if (e.context.window) windowMax = Math.max(windowMax, e.context.window);
      }
      const t = e.tool;
      if (e.kind !== 'tool' || !t || t.status === 'running') continue;
      const name = String(t.name ?? '').toLowerCase();
      for (const s of SHARED_TOOLS) if (name.includes(s)) toolUse[s]++;
      outputChars += (t.output ?? '').length;
      if (t.category === 'web') webCalls++;
      if (t.category === 'edit') edits.push(e.ts);
      if (t.category === 'read') reads.push({ ts: e.ts, agent: a.id, file: flat(t.title).replace(/\\/g, '/').toLowerCase(), viaShell: false });
      if (t.category === 'command' || t.category === 'search') {
        const key = norm(t.title || t.input);
        if (!key) continue;
        if (SHELL_EDIT.test(key)) edits.push(e.ts);
        const file = t.category === 'command' ? fileRead(key) : undefined;
        if (file) reads.push({ ts: e.ts, agent: a.id, file, viaShell: true });
        else cmds.push({ ts: e.ts, agent: a.id, role: a.role, key, kind: kindOf(key), poll: POLL.test(key), ok: t.status === 'ok', outLen: (t.output ?? '').length });
      }
    }
  }
  edits.sort((x, y) => x - y);
  const editBetween = (t1, t2) => edits.some((t) => t > t1 && t < t2);

  // A repeat: the same command run before. "Wasted" when no file was edited in between, so the old result still held.
  const byKey = new Map();
  for (const c of cmds.sort((x, y) => x.ts - y.ts)) (byKey.get(c.key) ?? byKey.set(c.key, []).get(c.key)).push(c);
  let repeats = 0;
  let pollRepeats = 0;
  let wasted = 0;
  let crossAgentWasted = 0;
  const kindStats = {};
  const top = [];
  for (const [key, list] of byKey) {
    let w = 0;
    let cross = 0;
    for (let i = 1; i < list.length; i++) {
      repeats++;
      if (list[i].poll) {
        pollRepeats++;
        continue;
      }
      const prev = list[i - 1];
      if (!editBetween(prev.ts, list[i].ts)) {
        w++;
        if (!list.slice(0, i).some((p) => p.agent === list[i].agent)) cross++;
      }
    }
    wasted += w;
    crossAgentWasted += cross;
    const ks = (kindStats[list[0].kind] ??= { runs: 0, wasted: 0 });
    ks.runs += list.length;
    ks.wasted += w;
    if (list.length > 1) top.push({ key, times: list.length, agents: new Set(list.map((c) => c.agent)).size, wasted: w, kind: list[0].poll ? 'poll' : list[0].kind, avgOut: Math.round(list.reduce((s, c) => s + c.outLen, 0) / list.length) });
  }
  top.sort((x, y) => y.wasted - x.wasted || y.times - x.times);

  const readsBy = new Map();
  for (const r of reads.sort((x, y) => x.ts - y.ts)) (readsBy.get(r.file) ?? readsBy.set(r.file, []).get(r.file)).push(r);
  let rereads = 0;
  let rereadsByOthers = 0;
  let logRereads = 0;
  for (const [file, list] of readsBy)
    for (let i = 1; i < list.length; i++)
      if (POLL.test(file)) logRereads++;
      else if (!editBetween(list[i - 1].ts, list[i].ts)) {
        rereads++;
        if (!list.slice(0, i).some((p) => p.agent === list[i].agent)) rereadsByOthers++;
      }

  const withShared = shared.filter((s) => !s.none);
  const sizes = withShared.map((s) => s.chars).sort((x, y) => x - y);
  const notes = run.notes ?? [];
  const started = run.createdAt ?? Math.min(...agents.map((a) => a.startedAt ?? Infinity));
  const ended = Math.max(...agents.map((a) => a.endedAt ?? a.startedAt ?? 0));
  return {
    id,
    title: mask(run.config?.title ?? ''),
    status: run.status,
    duration: ended > started ? ended - started : 0,
    sharing: run.config?.contextSharing ?? 'on_demand (default)',
    agents: agents.length,
    roles,
    commands: cmds.length,
    distinctCommands: byKey.size,
    repeats,
    pollRepeats,
    edits: edits.length,
    shellReads: reads.filter((r) => r.viaShell).length,
    logRereads,
    wasted,
    crossAgentWasted,
    kindStats,
    top: top.slice(0, 25),
    reads: reads.length,
    distinctFiles: readsBy.size,
    rereads,
    rereadsByOthers,
    toolUse,
    webCalls,
    notes: notes.length,
    noteKinds: notes.reduce((m, n) => ((m[n.agentId === 'user' ? 'user' : (n.kind ?? 'none')] = (m[n.agentId === 'user' ? 'user' : (n.kind ?? 'none')] ?? 0) + 1), m), {}),
    noteChars: notes.reduce((s, n) => s + (n.text ?? '').length, 0),
    memoryChars: run.memory?.summary?.length ?? 0,
    memoryUpdates: run.memory ? 1 : 0,
    prompts: shared.length,
    promptsWithShared: withShared.length,
    sharedMedian: sizes[Math.floor(sizes.length / 2)] ?? 0,
    sharedMax: sizes[sizes.length - 1] ?? 0,
    sharedShortened: withShared.filter((s) => s.shortened).length,
    sharedNothingNew: withShared.filter((s) => s.nothingNew).length,
    outputChars,
    compactions,
    windowMax,
  };
}

const all = fs
  .readdirSync(runsDir)
  .filter((d) => fs.existsSync(path.join(runsDir, d, 'run.json')))
  .sort();
const pick = opt('run') ? [opt('run')] : all.slice(-Number(opt('last', 3)));
const results = [];
for (const id of pick) {
  try {
    results.push(measure(id));
  } catch (e) {
    console.error(`${id}: ${e.message}`);
  }
}

const md = [];
md.push(`# Aivenue shared-context measurement`, '', `Generated ${new Date().toISOString()} · ${results.length} workflow(s) · read-only`, '');
for (const r of results) {
  md.push(`## ${r.id} — ${r.title || '(untitled)'}`, '');
  md.push(`- Status: ${r.status} · duration ≈ ${hours(r.duration)} · context sharing: ${r.sharing}`);
  md.push(`- Agents: ${r.agents} (${Object.entries(r.roles).map(([k2, v]) => `${k2} ${v}`).join(', ')})`);
  md.push('', '### Repeated work', '');
  md.push(`| | count |`, `|---|---|`);
  md.push(`| Commands run | ${r.commands} (${r.distinctCommands} distinct) |`);
  md.push(`| Repeats of an earlier command | ${r.repeats} (${pct(r.repeats, r.commands)}) |`);
  md.push(`| …polling a background job (not waste) | ${r.pollRepeats} |`);
  md.push(`| …with no file edited in between (old result still valid) | ${r.wasted} (${pct(r.wasted, r.commands)}) |`);
  md.push(`| …of those, run by an agent that had not run it itself (shared context should have covered it) | ${r.crossAgentWasted} |`);
  md.push(`| File edits (edit tool + shell commands that change files) | ${r.edits} |`);
  md.push(`| File reads | ${r.reads} (${r.distinctFiles} distinct files; ${r.shellReads} via cat/sed/head/tail) |`);
  md.push(`| Re-reads with no edit in between | ${r.rereads} (by an agent that had not read it itself: ${r.rereadsByOthers}) |`);
  md.push(`| Re-reads of log/output files (not waste) | ${r.logRereads} |`);
  md.push('', '| Command kind | runs | wasted repeats |', '|---|---|---|');
  for (const [kd, s] of Object.entries(r.kindStats).sort((x, y) => y[1].wasted - x[1].wasted)) md.push(`| ${kd} | ${s.runs} | ${s.wasted} |`);
  if (r.top.length) {
    md.push('', 'Most repeated commands (masked, shortened):', '', '| times | agents | wasted | kind | avg output | command |', '|---|---|---|---|---|---|');
    for (const t of r.top) md.push(`| ${t.times} | ${t.agents} | ${t.wasted} | ${t.kind} | ${k(t.avgOut)} chars | \`${clip(mask(t.key), 100).replace(/\|/g, '\\|').replace(/`/g, "'")}\` |`);
  }
  md.push('', '### Use of the shared context', '');
  md.push(`| | count |`, `|---|---|`);
  for (const [t, n] of Object.entries(r.toolUse)) md.push(`| ${t} calls | ${n} |`);
  md.push(`| Web/doc fetches (not shared today) | ${r.webCalls} |`);
  md.push(`| Shared notes | ${r.notes} (${Object.entries(r.noteKinds).map(([k2, v]) => `${k2} ${v}`).join(', ') || '—'}), ${k(r.noteChars)} chars |`);
  md.push(`| Shared memory summary | ${k(r.memoryChars)} chars |`);
  md.push(`| Prompts sent | ${r.prompts}, ${r.promptsWithShared} with a SHARED CONTEXT block |`);
  md.push(`| Shared block size | median ${k(r.sharedMedian)} chars, max ${k(r.sharedMax)} chars |`);
  md.push(`| Blocks cut to fit the model | ${r.sharedShortened} |`);
  md.push(`| "Nothing new" blocks | ${r.sharedNothingNew} |`);
  md.push(`| Tool output recorded in total (what could be shared) | ${k(r.outputChars)} chars |`);
  md.push('', '### Agents compacting their own conversation', '');
  md.push(`- Compactions detected: ${r.compactions.length}${r.windowMax ? ` · largest window seen ${k(r.windowMax)} tokens` : ''}`);
  for (const c of r.compactions.slice(0, 15)) md.push(`  - ${c.role} ${c.agent.slice(0, 8)}: ${k(c.from)} → ${k(c.to)} tokens`);
  md.push('');
}
fs.writeFileSync(outFile, md.join('\n'));
console.log(`Wrote ${path.resolve(outFile)} (${results.length} workflow(s)).`);
