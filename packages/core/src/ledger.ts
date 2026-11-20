import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentEvent, AgentRunInfo, ObservedCheck, WorkflowRun } from './types';
import { withoutHeredocs } from './procdetect';
import { GRAPH_TOOL } from './graphUsage';

/**
 * What every agent did, built from their recorded events (no model call), for the shared context:
 * - the commands they ran and how each ended (so nobody re-runs a test or a scan to learn what is already known),
 * - the files they changed and read,
 * - what Graphify told them about the project (and the graph's own report),
 * - where the workflow stands: goal and gap, open issues, routing, waits, GPU locks, background processes, blockers.
 * Every line names the agent (id and role) it comes from.
 */

const ROLE: Record<string, string> = {
  planner: 'planner',
  plan_reviewer: 'plan reviewer',
  executor: 'implementer',
  code_reviewer: 'code reviewer',
  verifier: 'goal verifier',
  adjudicator: 'adjudicator',
  subagent: 'sub-agent',
  advisor: 'advisor',
};

export const who = (a: AgentRunInfo | undefined) => (a ? `${a.id.slice(0, 8)} ${ROLE[a.role] ?? a.role}` : 'agent');

const flat = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * `node ./test.js`: the `./` before the script path, the first word after `node`. Only a forward slash: in bash an
 * unquoted `\` escapes the next character (`node .\test.js` runs `.test.js`), and the record does not say which shell
 * ran it, so `.\` stays as written — in PowerShell that may list one check twice, never hide a failure.
 */
const SCRIPT_DOT = /^(node(?:\.exe)? )\.\/(?=[^\s"'-])/i;

/**
 * A command evened out outside its quotes only: runs of whitespace there become one space. Quoted text stays as
 * written — `--grep "Login  flow"` and `--grep "Login flow"` are two different filters. Nothing else is touched.
 */
function evenOut(s: string): string {
  let out = '';
  let quote: string | null = null;
  let space = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && quote === '"' && i + 1 < s.length) out += s[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (/\s/.test(ch)) {
      space = true;
      continue;
    }
    if (space && out) out += ' ';
    space = false;
    if (ch === '"' || ch === "'") quote = ch;
    out += ch;
  }
  return out;
}

/** The end of a command's output: usually its verdict ("12 passed", "exit 1", the error). */
function outcome(output: string | undefined, n = 180): string {
  // eslint-disable-next-line no-control-regex
  const lines = (output ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  const errs = lines.filter((l) => /error|fail|exception|traceback|not found|denied/i.test(l));
  const pick = errs.length ? [errs[0], lines[lines.length - 1]] : lines.slice(-2);
  return clip([...new Set(pick)].join(' ⏎ '), n);
}

/**
 * What a test, build or failed command printed that the next agent needs: its error lines and its last lines, up to
 * `n` characters (the full output stays in the records).
 */
function keyOutput(output: string | undefined, n: number): string {
  // eslint-disable-next-line no-control-regex
  const lines = (output ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  if (!lines.length) return '';
  const all = lines.join('\n');
  if (all.length <= n) return all;
  const errs = lines.filter((l) => /error|fail|exception|traceback|assert|not found|denied/i.test(l)).slice(0, 30);
  const tail: string[] = [];
  let used = errs.join('\n').length;
  for (let i = lines.length - 1; i >= 0 && used + lines[i].length + 1 <= n; i--) {
    if (errs.includes(lines[i])) continue;
    tail.unshift(lines[i]);
    used += lines[i].length + 1;
  }
  return clip([...errs, ...(errs.length ? ['…'] : []), ...tail].join('\n'), n);
}

/** Commands whose output the next agent would otherwise re-run for: tests, builds, checks of the environment. */
const IMPORTANT = /\b(test|pytest|jest|vitest|mocha|unittest|tsc|build|compile|make|cargo|gradle|mvn|lint|eslint|ruff|mypy|nvidia-smi|--version|pip (list|show)|npm (ls|list))\b/i;

/** A command that only prints one file (`cat f`, `sed -n 1,80p f`, `head -n 50 f`, `Get-Content f`): that file. */
export function fileReadOf(command: string): string | undefined {
  const c = flat(command).replace(/^(cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*)+/i, '');
  if (/[|;&<>`$]/.test(c)) return undefined;
  const m = /^(cat|type|get-content|gc|less|more|head|tail|sed -n|nl)\s+(.+)$/i.exec(c);
  if (!m) return undefined;
  const parts = m[2].split(' ').filter((p) => !p.startsWith('-') && !/^\d+$/.test(p) && !(/^sed -n$/i.test(m[1]) && /^'?[\d,$]+p'?$/.test(p)));
  return parts.length === 1 ? parts[0].replace(/^["']|["']$/g, '') : undefined;
}

/** Waiting on a background job by hand (`until …; sleep`, `while …; sleep`, `sleep 60 && tail log`). */
export const POLLING = /\b(until|while)\b[\s\S]*\bsleep\b|\bsleep\s+\d+\s*(;|&&)/i;

export interface LedgerEntry {
  ts: number;
  agent: AgentRunInfo;
  kind: 'command' | 'graph';
  /** For reading: whitespace evened out outside quotes. */
  what: string;
  /**
   * The command as the agent ran it (only trimmed): what recognising a check and telling two runs apart use, so
   * nothing in its arguments — the spaces inside quotes, a newline between steps — is rewritten.
   */
  command: string;
  ok: boolean;
  result: string;
  /** Files changed after it ran: its result may be out of date. */
  outdated?: boolean;
  /** Only a failed edit came after it: a file may or may not have changed. */
  maybeOutdated?: boolean;
  /**
   * The tool call it comes from, when that one call can be read again whole: its event number in the agent's records
   * (unique there) and the length of its output.
   */
  source?: { seq: number; chars: number };
}

/**
 * A file an edit touched. `sure`: an edit of it went through. Without one, every edit of it failed, which proves
 * neither that it changed (the edit may have been refused before writing) nor that it did not (it may have written
 * part): "possibly changed, check it".
 */
export interface ChangedFile {
  ts: number;
  by: AgentRunInfo;
  sure: boolean;
}

/** A file an agent read, with what it saw (the newest read). */
export interface ReadEntry {
  file: string;
  ts: number;
  agents: Set<string>;
  /** What the read showed. */
  excerpt: string;
  /** Changed after the newest read: read it again. */
  outdated?: boolean;
  /** Only a failed edit came after the newest read: it may have changed. */
  maybeOutdated?: boolean;
}

/**
 * The command ran, but what it printed says the check failed (a test run, `…; echo exit=$?`, a shell's "Exited with
 * code 1", Node's "AssertionError [ERR_ASSERTION]:").
 */
const FAILED = /\bexit(?: code)?[=: ]+[1-9]|\bExited with code [1-9]|\b\w*Error \[ERR_[A-Z0-9_]+\]|\bFAIL(ED)?\b|\b[1-9]\d* (failed|failing)\b|Traceback|\bError:|ParserError|\w+Exception\b|FullyQualifiedErrorId|command not found|No such file or directory|is not recognized as/;

const GRAPH = /\bgraphify\s+(query|path|explain|update|build|report)\b/i;

/**
 * Commands (and Graphify lookups) of every agent but `selfId` (or only of `onlyIds`), plus the files changed and read,
 * newer than `since`. Only the outputs are cut to their useful part; the blocks fit the rest to each agent's share.
 */
export function collectActivity(run: WorkflowRun, eventsOf: (agentId: string) => AgentEvent[], o: { since?: number; selfId?: string; onlyIds?: Set<string> } = {}) {
  const rel = (f: string) => {
    const r = path.relative(run.config.cwd, path.resolve(run.config.cwd, f));
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.replace(/\\/g, '/') : f;
  };
  const entries: LedgerEntry[] = [];
  const changed = new Map<string, ChangedFile>();
  const read = new Map<string, ReadEntry>();
  const addRead = (f: string, ts: number, a: AgentRunInfo, output?: string) => {
    if (!f) return;
    const r = read.get(f) ?? read.set(f, { file: f, ts, agents: new Set(), excerpt: '' }).get(f)!;
    r.agents.add(a.id.slice(0, 8));
    if (ts >= r.ts || !r.excerpt) {
      r.ts = Math.max(r.ts, ts);
      // eslint-disable-next-line no-control-regex
      if (output?.trim()) r.excerpt = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
    }
  };
  let lastEdit = 0;
  // When a command that writes files ran (Set-Content, sed -i, a redirect into a file…), by any agent: a check run
  // before it may no longer hold. Kept apart from `changed`: which files it wrote is not known. One that failed may
  // still have written before it failed (`Set-Content a.js x; throw`): "maybe", unless the CLI said which files it
  // changed (then sure).
  const commandWrites: { ts: number; sure: boolean }[] = [];
  for (const a of Object.values(run.agents)) {
    if (a.role === 'test' || a.role === 'compactor') continue;
    const events = eventsOf(a.id);
    // An event number that names one tool call only (a record read back from disk keeps the last version of each).
    const seqs = new Map<number, number>();
    for (const e of events) if (e.kind === 'tool') seqs.set(e.seq, (seqs.get(e.seq) ?? 0) + 1);
    for (const e of events) {
      if (e.kind !== 'tool' || !e.tool || e.tool.status === 'running') continue;
      const t = e.tool;
      if (t.category === 'edit') {
        lastEdit = Math.max(lastEdit, e.ts);
        const ok = t.status === 'ok';
        for (const f of e.files?.length ? e.files : [t.title]) {
          const key = rel(f);
          const was = changed.get(key);
          // A successful edit makes it changed for sure; a failed one only "possibly", and never undoes a success.
          if (ok) changed.set(key, { ts: e.ts, by: a, sure: true });
          else if (!was?.sure) changed.set(key, { ts: e.ts, by: a, sure: false });
          else if (e.ts > was.ts) changed.set(key, { ...was, ts: e.ts });
        }
        continue;
      }
      if (t.category === 'command' && writesFiles((t.title || t.input || '').trim(), run.config.cwd)) commandWrites.push({ ts: e.ts, sure: t.status === 'ok' || !!e.files?.length });
      if (o.onlyIds ? !o.onlyIds.has(a.id) : a.id === o.selfId) continue;
      if (t.category === 'read') {
        addRead(rel(flat(t.title)), e.ts, a, t.output);
        continue;
      }
      // A lookup with Aivenue's graph tools: shared like the same graphify command run in a shell.
      if (t.category === 'hub' && GRAPH_TOOL.test(t.name ?? '')) {
        const what = evenOut(`${t.name.replace(/^.*?(graph_\w+)$/, '$1')} ${flat(t.title)}`);
        entries.push({ ts: e.ts, agent: a, kind: 'graph', what, command: what, ok: t.status === 'ok', result: clip(flat(t.output), 2000) });
        continue;
      }
      if (t.category !== 'command' && t.category !== 'search') continue;
      const command = (t.title || t.input || '').trim();
      const what = evenOut(command);
      if (!what) continue;
      // Printing one file is reading it.
      const file = t.category === 'command' && t.status === 'ok' ? fileReadOf(what) : undefined;
      if (file) {
        addRead(rel(file), e.ts, a, t.output);
        continue;
      }
      const graph = GRAPH.test(what);
      const important = !graph && (t.status !== 'ok' || IMPORTANT.test(what) || FAILED.test(t.output ?? ''));
      const chars = plainOutput(t.output).length;
      const source = chars && seqs.get(e.seq) === 1 ? { seq: e.seq, chars } : undefined;
      entries.push({ ts: e.ts, agent: a, kind: graph ? 'graph' : 'command', what, command, ok: t.status === 'ok', result: graph ? clip(flat(t.output), 2000) : important ? keyOutput(t.output, 2000) : outcome(t.output, 400), ...(source ? { source } : {}) });
    }
  }
  const changes = [...changed.entries()];
  const sure = changes.filter(([, c]) => c.sure);
  const maybe = changes.filter(([, c]) => !c.sure);
  for (const en of entries) {
    en.outdated = sure.some(([, c]) => c.ts > en.ts) || commandWrites.some((w) => w.sure && w.ts > en.ts);
    en.maybeOutdated = !en.outdated && (maybe.some(([, c]) => c.ts > en.ts) || commandWrites.some((w) => w.ts > en.ts));
  }
  const same = (x: string, y: string) => x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
  for (const r of read.values()) {
    r.outdated = sure.some(([f, c]) => c.ts > r.ts && same(f, r.file));
    r.maybeOutdated = !r.outdated && maybe.some(([f, c]) => c.ts > r.ts && same(f, r.file));
  }
  const since = o.since ?? 0;
  return {
    entries: entries.filter((e) => e.ts > since).sort((x, y) => x.ts - y.ts),
    changed: changes.filter(([, c]) => c.ts > since),
    read: [...read.values()].filter((r) => r.ts > since).sort((x, y) => x.ts - y.ts),
    lastEdit,
  };
}

/** The same command run again keeps only its latest result. */
function latestPerCommand(entries: LedgerEntry[]): LedgerEntry[] {
  const by = new Map<string, LedgerEntry>();
  for (const e of entries) by.set(e.command, e);
  return [...by.values()].sort((x, y) => x.ts - y.ts);
}

/**
 * The latest run of each check. A later run replaces an earlier one only when the record shows it is the same check
 * in the same folder (`cd packages/api && npm test` and `cd packages/web && npm test` are two checks) and that it
 * surely ran (`true || node test.js` may have skipped it). Otherwise the earlier run — a confirmed failure, say —
 * stays, and the later command is listed beside it with its own state.
 */
function latestPerCheck(entries: LedgerEntry[]): (LedgerEntry & { earlier?: LedgerEntry[] })[] {
  const by = new Map<string, { main?: LedgerEntry; earlier: LedgerEntry[]; unsure: Map<string, LedgerEntry> }>();
  for (const e of entries) {
    const c = checkRun(e.command, e.ok, e.result);
    const slot = by.get(c.key) ?? by.set(c.key, { earlier: [], unsure: new Map() }).get(c.key)!;
    if (c.surelyRan) {
      // The runs it replaces stay with it as its history ("passed · failed before the fix").
      if (slot.main) slot.earlier.push(slot.main);
      slot.main = e;
      slot.unsure.clear();
    } else slot.unsure.set(e.command, e);
  }
  return [...by.values()].flatMap((s) => [...(s.main ? [s.earlier.length ? { ...s.main, earlier: s.earlier } : s.main] : []), ...s.unsure.values()]).sort((x, y) => x.ts - y.ts);
}

/**
 * A path as a key: forward slashes, no quotes or trailing slash. Its case is kept (only a drive letter is lowered):
 * on a case-sensitive file system `API` and `api` are two folders, and Aivenue cannot tell which kind it ran on.
 */
const pathKey = (p: string) => {
  const s = p.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/').replace(/\/+$/, '');
  return s.replace(/^([a-z]):/i, (_, d: string) => `${d.toLowerCase()}:`);
};

/** `dir` after `cd to` (relative to it unless absolute; `..` steps up). */
function moveTo(dir: string, to: string): string {
  const t = pathKey(to);
  if (/^([a-z]:)?\//i.test(t) || /^~/.test(t)) return t;
  const parts = dir ? dir.split('/') : [];
  for (const p of t.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  return parts.join('/');
}

/**
 * The top-level parts of a shell command and the separator after each (`;`, newline, `&&`, `||`, `|`; '' after the
 * last). Quoted text is kept whole: `printf 'x; node test.js'` is one part, its `;` is text, not a separator.
 */
export function shellParts(what: string): { text: string; sep: string }[] {
  const out: { text: string; sep: string }[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < what.length; i++) {
    const ch = what[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < what.length) cur += what[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    const two = what.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      out.push({ text: cur, sep: two });
      cur = '';
      i++;
    } else if (ch === ';' || ch === '|' || ch === '\n') {
      out.push({ text: cur, sep: ch });
      cur = '';
    } else cur += ch;
  }
  out.push({ text: cur, sep: '' });
  return out;
}

/** A shell saying a folder it was asked to enter is not there (bash, cmd, PowerShell, in English or Chinese). */
const CD_FAILED = /no such file or directory|cannot find path|cannot find the path|the system cannot find the path|系統找不到指定的路徑|找不到路徑/i;

/** Quoted text emptied (`printf "npm test"` → `printf ""`): what is inside quotes is an argument, never a command. */
const unquoted = (s: string) => s.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');

/** Commands that change files (at the start of a step): PowerShell and .NET writers, cmd's, Unix tools, git's. */
const WRITER =
  /^[\s(&.]*(?:(?:Set|Add|Clear)-Content|Out-File|Tee-Object|(?:New|Remove|Move|Copy|Rename)-Item|\[(?:System\.)?IO\.File\]::(?:Write|Append|Delete|Move|Copy|Replace)\w*|rm|mv|cp|touch|tee|truncate|del|erase|move|copy|ren|rename|sed\b.*\s(?:-[a-zA-Z]*i|--in-place)|perl\b.*\s-[a-zA-Z]*i|patch|git(?:\s+-[Cc]\s+\S+)*\s+(?:apply|checkout|restore|reset|stash|mv|rm|pull|merge|rebase|cherry-pick|am|revert)(?![\w-]))\b/i;
/** Formatters and fixers that rewrite files in place (unless run as a check: --check, --diff, --dry-run…). */
const FORMATTER =
  /^[\s(&.]*(?:(?:npx|pnpm\s+exec|pnpm\s+dlx|yarn|bunx)\s+)?(?:prettier\b.*\s--write|eslint\b.*\s--fix|biome\b.*\s--(?:write|apply)|go\s+fmt|gofmt\b.*\s-w|black|isort|autopep8\b.*\s(?:-i|--in-place)|rustfmt|cargo\s+fmt|dotnet\s+format|clang-format\b.*\s-i|ruff\s+(?:format|check\b.*\s--fix)|(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:format|fmt|fix|lint:fix|format:write)(?![\w:-]))\b/i;
// (Not -l: black and isort take it for the line length and still write; gofmt -l lists, and gofmt counts only with -w.)
const DRY_RUN = /\s--(?:check|check-only|diff|dry-run|verify-no-changes|list-different)\b/i;
/** A fix or write flag on any tool (`npm run lint -- --fix`, `pnpm lint --fix`); not --write-out and the like. */
const FIX_FLAG = /\s--(?:fix|write)(?![\w-])/i;
/** Moving or renaming: what it moves, even when named by a variable, leaves its place. */
const MOVER = /^[\s(&.]*(?:Move-Item|Rename-Item|mv|move|ren|rename)\b/i;
/** Steps that only pass a check's output on, so a `tee`/`Out-File` at their end writes the check's own log. */
const PIPES_ON = /^[\s(&.]*(?:grep|findstr|Select-String|head|tail|Select-Object|sort|uniq|cat|more|less|sed(?!\b.*\s(?:-[a-zA-Z]*i|--in-place)))\b/i;

/** Temporary folders: a scratch script or a log written there is not the project's. */
const TEMP_PATH =
  /\$env:(?:TEMP|TMP)\b|%(?:TEMP|TMP)%|\$\{?TMPDIR\b|(?:^|[\s"'=(,])\/tmp(?:\/|$)|[\\/]AppData[\\/]Local[\\/]Temp(?:[\\/]|$)|(?:\$\{?LOCALAPPDATA\}?|%LOCALAPPDATA%|\$env:LOCALAPPDATA)["']?[\\/]Temp(?:[\\/"']|$)|^\/var\/folders\/|GetTempPath\(\)/i;
/** A step that moves the shell to another folder, and where to. */
const CHANGE_DIR = /^\s*(?:cd|chdir|pushd|Set-Location|sl)\s+(?:-(?:Path|LiteralPath)\s+)?("[^"]*"|'[^']*'|[^\s&]+)\s*$/i;

/**
 * A command that changes files: a writer or formatter (WRITER, FORMATTER) at the start of any step, or output
 * redirected into a file. Not: output thrown away ($null, /dev/null, NUL) or into a temporary folder (outside
 * `cwd`), streams joined (2>&1), a check writing its own log (`npm test > test.log`, `npm test 2>&1 | tee test.log`),
 * a formatter run as a check (`prettier --check`), nor the body of a heredoc (data written to a file or a program's
 * input: the line that writes it counts). Which files it changed is not worked out: only that something may have.
 */
export function writesFiles(command: string, cwd?: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\/([a-z])\//i, '$1:/').toLowerCase();
  const inCwd = (p: string) => !!cwd && norm(p).startsWith(norm(cwd).replace(/\/?$/, '/'));
  const absolute = (p: string) => /^(?:[a-z]:[\\/]|[\\/~$%])/i.test(p);
  // In a temporary folder the line moved to (`cd /tmp/x && cat > run.mjs`), a relative path is temporary too.
  let inTemp = false;
  const temp = (p: string) => (TEMP_PATH.test(p) || (inTemp && !absolute(p))) && !inCwd(p);
  const bare = (w: string) => w.replace(/^["'(]+|["')]+$/g, '');
  // Where a check's own output may go without changing the project: a log (test.log, run.out, result.txt, logs/…)
  // or a temporary folder. `npm test > src/a.js` overwrites a source file: a change like any other.
  const logLike = (f: string) => temp(f) || /\.(?:log|out)$/i.test(f) || (/\.txt$/i.test(f) && /(?:log|out|result|test|report|run)[^\\/]*$/i.test(f)) || /(?:^|[\\/])(?:logs?|test-results|reports?)[\\/]/i.test(f);
  // The places a step names (its arguments, each a shell word: quoted and plain pieces run together, as in
  // `"$LOCALAPPDATA"/Temp/x`; outer quotes taken off), but not values given to -Value, -Encoding and the like.
  const places = (raw: string) => {
    const words = (raw.trim().match(/(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s,"'])+/g) ?? []).slice(1);
    return words.filter((w, i) => !w.startsWith('-') && !/^-(?:Value|Encoding|InputObject|ItemType|Stream|Delimiter)$/i.test(words[i - 1] ?? '')).map(bare);
  };
  const parts = shellParts(withoutHeredocs(command));
  for (let i = 0; i < parts.length; i++) {
    const text = parts[i].text;
    const step = unquoted(text).trim();
    // After `;`, a new line or `||` a step runs whether or not an earlier cd worked (`false && cd /tmp; echo > a`,
    // `cd /tmp/x; cat > a` with no /tmp/x): the folder is no longer known. After `&&` only if the step before worked.
    const before = i > 0 ? parts[i - 1].sep : '';
    if (before === ';' || before === '\n' || before === '||') inTemp = false;
    if (!step) continue;
    if (/^\s*popd\b/i.test(step)) {
      inTemp = false;
      continue;
    }
    // A step that is only a cd (`cd /tmp & echo > a` sends the cd to the background: the rest is read as a step).
    const dir = CHANGE_DIR.exec(text.trim());
    if (dir) {
      // Followed only into a temporary folder named in full; a relative cd or `cd -` may lead anywhere. And only when
      // the steps after it run only if it did: it starts the command or follows `&&` (`a || b && cd /tmp && w`), not
      // `||` (`true || cd /tmp && w` skips the cd and still writes), and its output is not piped (a pipeline runs it in
      // a subshell of its own).
      const to = bare(dir[1]);
      const certain = (before === '' || before === ';' || before === '\n' || before === '&&') && parts[i].sep !== '|';
      inTemp = certain && absolute(to) && to !== '-' && TEMP_PATH.test(to) && !inCwd(to);
      continue;
    }
    const writer = WRITER.test(step) || ((FORMATTER.test(step) || FIX_FLAG.test(step)) && !DRY_RUN.test(step));
    if (writer) {
      // A tee / Out-File at the end of a check's pipeline (`npm test 2>&1 | tee test.log`): the check's own log.
      let ownLog = false;
      if (/^[\s(&.]*(?:tee|Tee-Object|Out-File)\b/i.test(step)) {
        for (let j = i - 1; j >= 0 && parts[j].sep === '|'; j--) {
          if (runsCheck(parts[j].text)) ownLog = true;
          if (ownLog || !PIPES_ON.test(unquoted(parts[j].text).trim())) break;
        }
      }
      if (ownLog) {
        const logs = places(text);
        if (logs.length && logs.every(logLike)) continue;
      }
      // Only into temporary folders (a scratch script deleted, a log under /tmp): not the project's files.
      // (A plain $variable or a number given beside a temporary path is a value, not another place, except for a move:
      // `Move-Item $f $env:TEMP` takes a project file out of the project.)
      const named = places(text);
      const value = (p: string) => !MOVER.test(step) && (/^\$(?!env:)\w+$/i.test(p) || /^\d+$/.test(p));
      const onlyTemp = named.some(temp) && named.every((p) => temp(p) || value(p));
      if (!onlyTemp) return true;
      continue;
    }
    // A redirect outside quotes (`node -e "1 > 0"` writes nothing: quoted text is blanked, keeping its place), and its
    // target read as written (a quoted path too), to tell a temporary one. Not `2>&1` or `>&2` (streams joined).
    const blanked = text.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (q) => q[0] + ' '.repeat(q.length - 2) + q[q.length - 1]);
    const into: string[] = [];
    for (const m of blanked.matchAll(/>{1,2}[ \t]*/g)) {
      const rest = text.slice(m.index + m[0].length);
      if (rest.startsWith('&')) continue;
      const target = /^("[^"]*"|'[^']*'|[^\s|;&>]+)/.exec(rest)?.[1];
      if (target) into.push(bare(target));
    }
    const kept = into.filter((f) => !/^(\$null|\/dev\/null|nul)$/i.test(f) && !temp(f));
    if (kept.length > 0 && !(CHECK.test(step) && kept.every(logLike))) return true;
  }
  return false;
}

/** Whether a part of a command, outside its quotes, runs a check. */
const runsCheck = (part: string) => CHECK.test(unquoted(part.trim()));

/** A command that runs a check somewhere in it — outside quotes (a check named in a string or an echo is not one). */
export const isCheckCommand = (what: string) => shellParts(what).some((p) => runsCheck(p.text));

/**
 * A step that changes how the rest of the line runs, or whether it runs at all: leaving the shell (`exit`, `return`,
 * `exec`, `logout`, `throw`, `kill`), loops and branches, grouping and subshells, sourcing or evaluating other code,
 * a background job (`&`). After one of these, Aivenue cannot tell from the line what ran.
 */
const FLOW_WORD = /^(?:exit|return|exec|logout|throw|kill|break|continue|trap|source|eval|wait|if|then|else|elif|fi|for|while|until|do|done|case|esac|select|function)\b|^\.\s|(?:^|[^&])&\s*$/i;

/**
 * A step that changes the flow: a flow word, or brackets left open across a separator (`(cd x; npm test)` splits
 * into `(cd x` and `npm test)`: a subshell or a block). A group closed within the step — PowerShell's
 * `(Get-Content a) -replace …` — is only an expression.
 */
const isFlow = (step: string) => {
  const s = unquoted(step);
  const count = (re: RegExp) => (s.match(re) ?? []).length;
  return FLOW_WORD.test(s) || count(/\(/g) !== count(/\)/g) || count(/\{/g) !== count(/\}/g);
};

/** `set -e` (bash) or `$ErrorActionPreference = 'Stop'` (PowerShell): a failing step ends the line, whatever comes after. */
const ERREXIT = /^set\s+(?:-\w*e\w*|-o\s+errexit)\b|\$ErrorActionPreference\s*=\s*['"]?stop/i;

/** A change of folder; `popd` (and `cd -`) go back to a folder the line does not name. */
const CD = /^(?:cd|chdir|pushd|set-location|sl)\s+(?:-path\s+|\/d\s+)?(.+)$/i;
const CD_UNKNOWN = /^(?:popd|pop-location)\b|^cd\s+-\s*$|^cd\s*$/i;

/**
 * The check in a command and how sure the record is that it ran, and where. Its key is the folder it ran in
 * (relative to the agent's working folder) and the check itself. The rule is strict: it counts as surely run only
 * when the line shows that control reached it — every step before it was reached and passes control on, by `;`, a
 * newline or a pipe (or `&&` after a change of folder that did not report a failure), with nothing before it that may
 * leave the shell or change the flow (`exit`, a branch, a subshell, `set -e`…). One more case: in the last list of
 * the line, a chain of `&&` that ended fine ran every step. After `||` it ran only if what came before failed
 * (`mayNotRun`). Its folder counts only when every change of folder before it surely ran and the output reports no
 * failed cd; when not (`false && cd x; npm test`, `cd x; npm test` printing "No such file or directory"), where it
 * ran is not known, so it is not sure either. The check keeps its case. One rule over all of it: a record replaces an
 * earlier one only when it is the same check, in the same known folder, and surely ran; short of that, both are listed.
 */
export function checkRun(what: string, ok = true, output = ''): { key: string; check: string; dir: string; surelyRan: boolean; mayNotRun: boolean; why?: 'flow' | 'or' | 'and' | 'dir' } {
  const parts = shellParts(what);
  const ends = (p: { sep: string }) => p.sep === ';' || p.sep === '\n' || p.sep === '';
  const cdFailed = CD_FAILED.test(output);
  const errexit = parts.some((p) => ERREXIT.test(p.text.trim()));
  let dir = '';
  let dirKnown = true;
  // Whether control surely reached the current step, and whether something before it may have changed the flow.
  let reached = true;
  let flow = false;
  let afterOr = false;
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i].text.trim();
    if (i > 0) {
      const prev = parts[i - 1].text.trim();
      const sep = parts[i - 1].sep;
      if (isFlow(prev) || (errexit && !ok)) flow = true;
      const prevCd = CD.test(prev) && !cdFailed;
      if (sep === '|') {
        // a pipeline runs every stage
      } else if (sep === ';' || sep === '\n') {
        reached = true;
        afterOr = false;
      } else if (sep === '&&') reached = reached && prevCd;
      else if (sep === '||') {
        reached = false;
        afterOr = true;
      }
    }
    const cd = CD.exec(seg);
    // A change of folder counts only when it surely ran and nothing says it failed. When the output says a cd failed,
    // the line cannot say which one, nor where the shell stayed: every folder after a cd is unknown.
    if (CD_UNKNOWN.test(seg) || (cd && (!reached || flow || cdFailed))) dirKnown = false;
    else if (cd) dir = moveTo(dir, cd[1]);
    else if (runsCheck(seg)) {
      // The tool's own folder option: npm --prefix x, pnpm -C x, yarn --cwd x, make -C x, go -C x.
      const own = /\s(?:--prefix|-C|--cwd|--dir)[=\s]+("[^"]+"|'[^']+'|\S+)/.exec(seg);
      const at = own ? moveTo(dir, own[1]) : dir;
      // Only what is surely the same is evened out: spaces outside quotes, and the `./` of the script `node` is given
      // right after its name (a file path, read from the working folder either way). Everything
      // else stays as written: case (`tests/API.test.js`, `tests/api.test.js`), quoted text (`"Login  flow"`) and
      // any other argument (`--grep ./Login` is a pattern, not a path).
      const check = evenOut(seg.replace(own?.[0] ?? '', '')).replace(SCRIPT_DOT, '$1');
      // Its list: from just after the last `;`/newline before it to the next one (or the end).
      let start = i;
      while (start > 0 && !ends(parts[start - 1])) start--;
      let end = i;
      while (!ends(parts[end])) end++;
      const inList = parts.slice(start, end).map((p) => p.sep);
      // The last list decides how the line ended: `&&` only there, and the line ended fine, ran every step of it —
      // provided the list itself was reached (nothing before it may have left the shell).
      const chainOk = ok && end === parts.length - 1 && inList.every((s) => s === '&&' || s === '|') && !flow;
      const surelyRan = !flow && !isFlow(seg) && (reached || chainOk) && dirKnown;
      // Why it is not sure, in the order a reader would look for it.
      const why = surelyRan ? undefined : flow || isFlow(seg) ? 'flow' : afterOr ? 'or' : !(reached || chainOk) ? 'and' : 'dir';
      return { key: `${dirKnown ? at : '?'}::${check}`, check, dir: dirKnown ? at : '?', surelyRan, mayNotRun: afterOr, ...(why ? { why } : {}) };
    }
  }
  const check = evenOut(what.trim());
  return { key: `::${check}`, check, dir: '', surelyRan: true, mayNotRun: false };
}

/** The part of a command that is the check, with the folder it ran in (`cd app && npm test` → `app::npm test`). */
export const checkKey = (what: string) => checkRun(what).key;

/** As many of `lines` as fit in `budget`, newest (last) first, shown oldest first. */
export function fit(lines: string[], budget: number, head: string): string {
  if (!lines.length) return '';
  const out: string[] = [];
  let used = head.length;
  for (let i = lines.length - 1; i >= 0 && used + lines[i].length + 1 <= budget; i--) {
    out.unshift(lines[i]);
    used += lines[i].length + 1;
  }
  const dropped = lines.length - out.length;
  return [head, ...(dropped ? [`- (${dropped} older item(s) left out; search_records or read_context finds them)`] : []), ...out].join('\n');
}

const indent = (s: string) => s.replace(/\n/g, '\n    ');

/**
 * One command line: who ran it, how it ended and what it printed. With `mask`, the output of a successful run that
 * files changed after is left out for a reference to that very tool call — only when that call can be read again
 * whole. A failure, a warning and an output still current stay as they are.
 */
const commandLine = (e: LedgerEntry, showWho = true, mask = false) => {
  const mark = !e.ok ? '✗' : FAILED.test(e.result) ? '⚠' : '✓';
  const head = `- ${showWho ? `[${who(e.agent)}] ` : ''}${mark} \`${clip(e.what, 400)}\`${e.outdated ? ' (files changed since; re-run if it matters)' : e.maybeOutdated ? ' (a failed edit or file-writing command since may have changed files; check before relying on it)' : ''}`;
  const shown = e.result ? (e.result.includes('\n') ? `\n    ${indent(e.result)}` : ` → ${e.result}`) : '';
  if (mask && mark === '✓' && e.outdated && e.result && e.source) {
    const ref = `\n    (its output, ${e.source.chars} chars, is left out because files changed since: read_context {agent_id: "${e.agent.id}", event: ${e.source.seq}} has that run's output whole)`;
    // Only when it is shorter than the output itself.
    if (ref.length < shown.length) return `${head}${ref}`;
  }
  return `${head}${shown}`;
};

// eslint-disable-next-line no-control-regex
const plainOutput = (s: string | undefined) => (s ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();

/** Characters of output per page of `toolCallPage`. */
export const TOOL_OUTPUT_PAGE = 8000;

/**
 * One tool call of an agent, by its event number, with its output whole in pages of `size` characters (page 1 is
 * the start). The exact run a shortened entry points to, not every run of the same command.
 */
export function toolCallPage(events: AgentEvent[], label: string, seq: number, page = 1, size = TOOL_OUTPUT_PAGE): string {
  const calls = events.filter((e) => e.kind === 'tool' && e.seq === seq && e.tool);
  if (calls.length !== 1) return calls.length ? `Event ${seq} of ${label} is more than one record: read_context {agent_id, part: "tools"} lists its tool calls.` : `No tool call with event number ${seq} in the records of ${label}: read_context {agent_id, part: "tools"} lists its tool calls.`;
  const e = calls[0];
  const t = e.tool!;
  const out = plainOutput(t.output);
  const pages = Math.max(1, Math.ceil(out.length / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const from = (p - 1) * size;
  const part = out.slice(from, from + size);
  const input = t.input && flat(t.input) !== flat(t.title) ? `\nInput: ${clip(t.input, 2000)}` : '';
  return [
    `TOOL CALL (event ${seq}) OF ${label}, ${new Date(e.ts).toISOString().slice(0, 19).replace('T', ' ')} UTC: ${t.name} [${t.status}] \`${t.title}\`${input}`,
    out ? `OUTPUT, characters ${from + 1}–${from + part.length} of ${out.length} (page ${p} of ${pages}${p < pages ? `; next: read_context {agent_id, event: ${seq}, page: ${p + 1}}` : ', the end'}):` : 'OUTPUT: (none)',
    part,
  ].join('\n');
}

/** One file read: who read it and the start of what they saw. */
const readLine = (r: ReadEntry, excerpt: number, showWho = true) =>
  `- ${r.file}${showWho ? ` (read by ${[...r.agents].join(',')})` : ''}${r.outdated ? ' — CHANGED since, read it again' : r.maybeOutdated ? ' — possibly changed since (an edit of it failed): check it before relying on this' : ''}${r.excerpt && !r.outdated ? `\n    ${indent(clip(r.excerpt, excerpt))}` : ''}`;

/** Characters per file excerpt: fewer when many were read, so the newest ones all show something. */
const excerptSize = (budget: number, files: number) => Math.max(300, Math.min(6000, Math.floor(budget / Math.max(1, Math.min(files, 40)))));

/** Commands and their results, files read (with what they showed) and changed: newest first within `budget`. */
export function activityBlock(act: ReturnType<typeof collectActivity>, budget: number, o: { mask?: boolean } = {}): string {
  const cmds = latestPerCommand(act.entries.filter((e) => e.kind === 'command'));
  const mask = o.mask ?? true;
  const parts = [
    fit(
      cmds.map((e) => commandLine(e, true, mask)),
      Math.floor(budget * 0.5),
      'COMMANDS ALREADY RUN BY OTHER AGENTS (who, command, how it ended: ✓ ok, ⚠ ran but its output reports a failure, ✗ failed, then what it printed). Use these results instead of running the same command again; re-run only when files changed since or you need the full output (read_context {agent_id}):',
    ),
    fit(
      act.read.map((r) => readLine(r, excerptSize(budget * 0.4, act.read.length))),
      Math.floor(budget * 0.4),
      'FILES OTHER AGENTS ALREADY READ (with the start of what they saw; read again only what is marked CHANGED or what you need in full):',
    ),
    act.changed.some(([, c]) => c.sure) ? fit(act.changed.filter(([, c]) => c.sure).map(([f, c]) => `- ${f} (by ${who(c.by)})`), Math.floor(budget * 0.1), 'FILES CHANGED:') : '',
    act.changed.some(([, c]) => !c.sure)
      ? fit(act.changed.filter(([, c]) => !c.sure).map(([f, c]) => `- ${f} (by ${who(c.by)})`), Math.floor(budget * 0.05), 'FILES POSSIBLY CHANGED (every edit of them failed, which does not show whether they changed; check them):')
      : '',
  ];
  return parts.filter(Boolean).join('\n\n');
}

/**
 * What this agent's own conversation already did, for when its CLI compacted it: the files it read (with what they
 * showed), the commands it ran and their results, and the files it changed. Saves reading and running it all again.
 */
export function ownWorkBlock(run: WorkflowRun, eventsOf: (agentId: string) => AgentEvent[], ids: Set<string>, notes: string[], budget: number): string {
  const act = collectActivity(run, eventsOf, { onlyIds: ids });
  const mine = act.changed.filter(([, c]) => ids.has(c.by.id) && c.sure);
  const maybeMine = act.changed.filter(([, c]) => ids.has(c.by.id) && !c.sure);
  if (!act.entries.length && !act.read.length && !mine.length && !maybeMine.length && !notes.length) return '';
  return [
    'YOUR OWN WORK BEFORE YOUR CONVERSATION WAS COMPACTED (recorded by Aivenue; still valid unless marked CHANGED — use it instead of reading or running it again):',
    notes.length ? fit(notes.map((n) => `- ${n}`), Math.floor(budget * 0.15), 'What you reported:') : '',
    fit(act.read.map((r) => readLine(r, excerptSize(budget * 0.5, act.read.length), false)), Math.floor(budget * 0.5), 'Files you read:'),
    fit(latestPerCommand(act.entries.filter((e) => e.kind === 'command')).map((e) => commandLine(e, false)), Math.floor(budget * 0.3), 'Commands you ran:'),
    mine.length ? fit(mine.map(([f]) => `- ${f}`), Math.floor(budget * 0.05), 'Files you changed:') : '',
    maybeMine.length ? fit(maybeMine.map(([f]) => `- ${f}`), Math.floor(budget * 0.05), 'Files you possibly changed (your edits of them failed; check them):') : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * What is known about the project's structure: the Graphify report (when the folder has a graph) and every
 * Graphify lookup an agent made, so the next agent starts from that instead of exploring again.
 */
export function knowledgeBlock(run: WorkflowRun, act: ReturnType<typeof collectActivity>, budget: number, withReport: boolean): string {
  const parts: string[] = [];
  const out = path.join(run.config.cwd, 'graphify-out');
  if (withReport && fs.existsSync(path.join(out, 'graph.json'))) {
    const report = ['GRAPH_REPORT.md', 'report.md'].map((f) => path.join(out, f)).find((f) => fs.existsSync(f));
    const text = report ? fs.readFileSync(report, 'utf8').trim() : '';
    parts.push(
      text
        ? `PROJECT STRUCTURE (Graphify report of this folder, ${new Date(fs.statSync(report!).mtimeMs).toISOString().slice(0, 16)}):\n${clip(text, Math.floor(budget * 0.5))}`
        : 'PROJECT STRUCTURE: this folder has a Graphify graph (graphify-out/graph.json); ask it with `graphify query "<question>"` before exploring files.',
    );
  }
  const lookups = latestPerCommand(act.entries.filter((e) => e.kind === 'graph' && e.ok && e.result));
  if (lookups.length)
    parts.push(
      fit(
        lookups.map((e) => `- [${who(e.agent)}] \`${clip(e.what, 140)}\`${e.outdated ? ' (files changed since)' : ''}\n  ${e.result}`),
        budget - parts.join('').length,
        'WHAT GRAPHIFY ALREADY ANSWERED (reuse instead of asking again):',
      ),
    );
  return parts.join('\n\n');
}

/**
 * Checks Aivenue itself saw run (tests, builds, type checks, linters…) and how each ended, newest last: what the
 * records prove, as opposed to what an agent says it verified. Marked when files changed after it ran.
 */
export function verifiedChecks(act: ReturnType<typeof collectActivity>, limit = 5): string[] {
  return latestPerCheck(act.entries.filter((e) => e.kind === 'command' && isCheckCommand(e.command)))
    .slice(-limit)
    .map((e) => `- ${checkOutcome(e)}: \`${clip(e.what, 100)}\` (run by ${who(e.agent)})${e.outdated ? ' — files changed since: re-run it before relying on it' : e.maybeOutdated ? ' — a failed edit since may have changed files' : ''}`);
}

/** The latest run of each check (the same as verifiedChecks), as data: for the record of a submission and the UI. */
export function checkRecords(act: ReturnType<typeof collectActivity>, limit = 10, o: { output?: boolean | 'short' } = {}): (ObservedCheck & { output?: string })[] {
  return latestPerCheck(act.entries.filter((e) => e.kind === 'command' && isCheckCommand(e.command)))
    .slice(-limit)
    .map((e) => {
      // Whether it ran at all is not known (after `||`, or after `&&` where the line's end does not tell): said so,
      // with how the line ended — never as passed or failed.
      const unsure = !checkRun(e.command, e.ok, e.result).surelyRan;
      const outcomeOf = (x: LedgerEntry): ObservedCheck['outcome'] => (!x.ok ? 'failed' : FAILED.test(x.result) ? 'output_failure' : isCompound(x.command) ? 'in_longer_command' : 'passed');
      const outcome: ObservedCheck['outcome'] = unsure ? 'may_not_run' : outcomeOf(e);
      // Earlier runs of the same check (same folder, surely ran) that this one replaced: its history, oldest first.
      const earlier = e.earlier?.slice(-3).map((x) => ({ ts: x.ts, outcome: outcomeOf(x), ...(x.source ? { seq: x.source.seq } : {}), ...(o.output && x.result ? { output: clip(x.result, 1500) } : {}) }));
      return {
        command: clip(e.what, 200),
        agentId: e.agent.id,
        by: who(e.agent),
        ts: e.ts,
        outcome,
        ...(e.source ? { seq: e.source.seq } : {}),
        ...(unsure ? { lineOk: e.ok } : {}),
        ...(e.outdated ? { outdated: true } : e.maybeOutdated ? { maybeOutdated: true } : {}),
        ...(earlier?.length ? { earlier } : {}),
        ...(o.output && e.result ? { output: o.output === 'short' ? clip(e.result, 1500) : e.result } : {}),
      };
    });
}

/** Every check Aivenue saw run (not only the latest per command), with when and by whom: observed, not reported. */
export function observedChecks(act: ReturnType<typeof collectActivity>): { ts: number; agentId: string; line: string }[] {
  return act.entries
    .filter((e) => e.kind === 'command' && isCheckCommand(e.command))
    .map((e) => ({ ts: e.ts, agentId: e.agent.id, line: `${checkOutcome(e)}: \`${clip(e.what, 100)}\` (run by ${who(e.agent)})${e.outdated ? ' — files changed since' : ''}` }));
}

/**
 * How a check ended, as far as the record shows. A check run alone: the command's end is its end. One run with other
 * steps in the same command (`a; npm test; b`, `npm test | tail`): the command's end belongs to the whole line, so
 * success says only that it ran — its own result is in the output, to be read.
 */
/** Redirections that join output streams (`2>&1`, `>&2`, `&>log`, `&>>log`, PowerShell `*>&1`): an `&` that neither
 *  chains nor backgrounds a command, so a check written `npm test 2>&1` still ends with its own exit code. */
const JOIN_STREAMS = /[\d*]*>&(?:\d+|-)|&>>?/g;
const isCompound = (what: string) => /[;&|\n]/.test(what.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""').replace(JOIN_STREAMS, ' '));

function checkOutcome(e: LedgerEntry): string {
  const compound = isCompound(e.command);
  if (!compound) return !e.ok ? '✗ failed' : FAILED.test(e.result) ? '⚠ ran, its output reports a failure' : '✓ passed';
  // Whether it ran at all is not known: the record does not show it, whatever the line's end.
  const run = checkRun(e.command, e.ok, e.result);
  if (!run.surelyRan) {
    const why = { flow: 'a step before it may leave the shell or change the flow', or: 'it comes after `||`', and: "it comes after `&&` and the line's end does not show those steps succeeded", dir: 'a change of folder before it may not have happened, so where it ran is not known' }[run.why ?? 'and'];
    return `◦ not known whether it ran (${why}; the line ${e.ok ? 'ended fine' : 'failed'})`;
  }
  if (!e.ok) return '✗ the longer command it ran in failed (which step failed: check the output)';
  if (FAILED.test(e.result)) return '⚠ ran within a longer command whose output reports a failure';
  return '◦ ran within a longer command (the command ended fine; the check\'s own result: read the output)';
}

/**
 * A command that runs a check (tests, a build, a type check, a linter) — the tool itself, not a file that merely has
 * "test" in its name (`Get-Content test/a.test.js` edits or reads a file; it checks nothing). Node running a test
 * script is one (`node test.js`, `node tests/run.js`, `node src/a.test.js`); node running anything else is not.
 */
const CHECK = /(^|[;&|(]\s*)(npm(\.cmd)?\s+(run\s+)?(test|build|lint|typecheck)|pnpm\s+(run\s+)?(test|build|lint)|yarn\s+(test|build|lint)|node\s+--test|node\s+(\.?[\\/])?([\w.-]+[\\/])*((tests?|spec|__tests__)[\\/][\w.\\/-]+|(tests?|spec)\b[\w.-]*|[\w.-]+\.(test|spec))\.[cm]?[jt]s\b|npx\s+(tsc|vitest|jest|eslint|mocha)|pytest|python3?\s+-m\s+(pytest|unittest|mypy)|tsc\b|cargo\s+(test|build|check|clippy)|go\s+(test|build|vet)|dotnet\s+(test|build)|mvn\s|gradle\w*\s|make\b|eslint\b|ruff\b|mypy\b|vitest\b|jest\b)/i;

/** Where the workflow stands right now: goal and gap, open issues, routing, waits, locks, processes, blockers. */
export function statusBlock(run: WorkflowRun, o: { openIssues?: boolean } = {}): string {
  const lines: string[] = [];
  const goal = run.plan?.goal;
  const checks = (run.stages.verify?.rounds ?? []).flatMap((r) => (r.verification ? [{ v: r.verification, route: r.route }] : []));
  const last = checks[checks.length - 1];
  if (goal) {
    lines.push(`Goal that must be met: ${clip(flat(goal.statement), 300)}`);
    for (const m of goal.metrics) {
      const got = last?.v.metrics.find((x) => x.id === m.id);
      lines.push(`- ${m.id} ${m.name}: target ${clip(flat(m.target), 160)}${got ? ` — last measured: ${clip(flat(got.value), 120)} (${got.met ? 'met' : 'NOT met'}${last!.v.stale ? ', STALE: code changed since' : ''})` : ' — not measured yet'}`);
    }
    for (const m of last?.v.metrics.filter((x) => !goal.metrics.some((g) => g.id === x.id)) ?? []) lines.push(`- ${m.id} (the user's own criterion): ${clip(flat(m.value), 120)} (${m.met ? 'met' : 'NOT met'})`);
  }
  if (run.cycles) lines.push(`Cycle ${run.cycles + 1} (goal verification sent the work back ${run.cycles} time(s)).`);
  if (last?.route && last.route.to !== 'done') lines.push(`Last verification → ${last.route.to}: ${clip(last.route.reason, 200)}`);
  // Open issues of the latest review in each stage.
  for (const key of ['plan', 'implement'] as const) {
    const r = [...run.stages[key].rounds].reverse().find((x) => x.review);
    // Left out when the hand-off lists them already (contextBlock).
    if (o.openIssues !== false && r?.review?.verdict === 'revise' && r.review.issues.length) lines.push(`Open ${key} review issues (round ${r.n}${r.review.stale ? ', STALE' : ''}): ${r.review.issues.map((i) => `${i.id} [${i.severity}] ${clip(i.title, 80)}`).join('; ')}`);
    if (r?.route?.to === 'planner') lines.push(`Code review → planner: ${clip(r.route.reason, 200)}`);
  }
  if (last && last.v.issues.length && last.route?.to !== 'done') lines.push(`Verification issues: ${last.v.issues.map((i) => `${i.id} ${clip(i.title, 80)}`).join('; ')}`);
  for (const r of run.rulings ?? []) lines.push(`Ruling on ${r.issueId}: ${clip(r.ruling, 200)}`);
  const agentOf = (id: string) => run.agents[id];
  for (const w of run.waits ?? [])
    if (w.state === 'waiting')
      lines.push(`Waiting (wait_id ${w.id}, ${who(agentOf(w.agentId))}): \`${clip(w.check, 120)}\` every ${w.intervalSec}s until ${new Date(w.timeoutAt).toISOString().slice(11, 16)} UTC${w.gpus ? `, then lock ${w.gpus} GPU` : ''}${w.lastOutput ? `; last check: ${clip(flat(w.lastOutput), 120)}` : ''}. To keep waiting call wait_for {wait_id: "${w.id}"}.`);
  for (const l of run.gpuLocks ?? []) lines.push(`GPU ${l.gpus.join(', ')} locked by ${who(agentOf(l.agentId))}: do not use those cards.`);
  for (const p of run.processes ?? []) lines.push(`Background process ${p.pid} (${clip(p.purpose, 80)}) by ${who(agentOf(p.agentId))}: ${p.alive ? 'running' : 'ended'}; cleanup: ${p.cleanup}.`);
  for (const a of Object.values(run.agents)) {
    if (!['running', 'paused', 'queued'].includes(a.status)) continue;
    lines.push(`Working now: ${who(a)} (${a.provider}) — ${clip(flat(a.task), 100)}${a.waiting ? `; waiting: ${clip(a.waiting, 100)}` : ''}${a.failure ? `; recovering from ${a.failure.kind}: ${clip(a.failure.action, 100)}` : ''}`);
  }
  if (run.pending) lines.push(`Waiting for the user to decide: ${clip(run.pending.message, 160)}`);
  if (run.approvals?.length) lines.push(`${run.approvals.length} action(s) waiting for the user's approval.`);
  return lines.length ? `WORKFLOW STATUS NOW:\n${lines.join('\n')}` : '';
}

/** The latest hand-off of each stage: facts, decisions and open points, with the agents they come from. */
export function handoffsBlock(run: WorkflowRun, since = 0): string {
  const out: string[] = [];
  for (const [key, st] of Object.entries(run.stages)) {
    const r = [...(st?.rounds ?? [])].reverse().find((x) => x.handoff);
    const h = r?.handoff;
    if (!h || h.ts <= since) continue;
    const src = h.links.filter((l) => l.agentId && !l.issueId).map((l) => `${l.label} ${l.agentId!.slice(0, 8)}`).join(', ');
    out.push(
      [
        `${key} round ${h.round} (${src}):`,
        ...h.decisions.map((d) => `  DECISION: ${clip(flat(d), 240)}`),
        ...h.facts.map((d) => `  FACT: ${clip(flat(d), 240)}`),
        ...h.open.map((d) => `  OPEN: ${clip(flat(d), 200)}`),
      ].join('\n'),
    );
  }
  return out.length ? `HAND-OFFS (latest of each stage):\n${out.join('\n')}` : '';
}
