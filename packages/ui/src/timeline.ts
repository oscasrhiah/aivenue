// What a workflow's timeline shows by default, as plain data (no React): the live line of a working agent, routine
// activity folded into one line, the one-line result of a finished turn, why work came back, a readable preview of
// a result, and the state of a plan step. The cards render these; the full records stay one click away.
import type { AgentEvent, AgentRunInfo, ObservedCheck, PlanStep, Round, WorkflowRun } from '../../core/src/types';

export type Tr = (zh: string, en: string) => string;

/** What a tool call did, as far as the event says reliably: a shell command is a terminal command, whatever it ran. */
export type ActKind = 'read' | 'search' | 'write' | 'command' | 'other';
export const actKind = (e: AgentEvent): ActKind =>
  e.tool?.category === 'read' ? 'read' : e.tool?.category === 'search' ? 'search' : e.tool?.category === 'edit' ? 'write' : e.tool?.category === 'command' ? 'command' : 'other';

export type FeedItem =
  /** Two or more routine calls of one kind in a row (all ended fine): one line, each call behind it. */
  | { type: 'group'; kind: ActKind; events: AgentEvent[] }
  | { type: 'event'; e: AgentEvent; important: boolean };

/** A failure stays in view: a failed tool call or an error. A running call too (it is what happens now). */
export const isImportant = (e: AgentEvent) => e.kind === 'error' || (e.kind === 'tool' && (e.tool?.status === 'error' || e.tool?.status === 'running'));

/**
 * The default feed of an agent's events: what it said, failures and running calls one by one; routine calls of the
 * same kind that ended fine, one after another, folded into one line. Thinking and raw lines are left to the full log.
 */
export function feed(events: AgentEvent[]): FeedItem[] {
  const out: FeedItem[] = [];
  for (const e of events) {
    if (e.kind !== 'tool' && e.kind !== 'message' && e.kind !== 'error') continue;
    if (e.kind === 'message' && !e.text?.trim()) continue;
    const routine = e.kind === 'tool' && e.tool?.status === 'ok' && actKind(e) !== 'other';
    const last = out[out.length - 1];
    if (routine && last) {
      if (last.type === 'group' && last.kind === actKind(e)) {
        last.events.push(e);
        continue;
      }
      if (last.type === 'event' && last.e.kind === 'tool' && last.e.tool?.status === 'ok' && actKind(last.e) === actKind(e)) {
        out[out.length - 1] = { type: 'group', kind: actKind(e), events: [last.e, e] };
        continue;
      }
    }
    out.push({ type: 'event', e, important: isImportant(e) });
  }
  return out;
}

/**
 * The newest `limit` items, plus every earlier important one (a failure is not pushed out by what came after).
 * `skipped`: how many items are left out before each kept one (for a "… N more" line).
 */
export function preview(items: FeedItem[], limit: number, pinned?: (item: FeedItem) => boolean): { item: FeedItem; skipped: number }[] {
  const out: { item: FeedItem; skipped: number }[] = [];
  let skipped = 0;
  items.forEach((item, i) => {
    // `pinned`: what the reader opened stays where it is while new events come in.
    const keep = i >= items.length - limit || (item.type === 'event' && item.important) || !!pinned?.(item);
    if (!keep) return void skipped++;
    out.push({ item, skipped });
    skipped = 0;
  });
  return out;
}

/**
 * What a folded group names after its label: the file names of reads and writes, the commands themselves (on one line,
 * cut) of commands and searches — never the tail of a path inside a command (`node test/a.js` is not `a.js`).
 */
export function groupNames(kind: ActKind, titles: string[], max = 40): string[] {
  return titles.map((s) => (kind === 'read' || kind === 'write' ? (s.split(/[\\/]/).pop() ?? s) : shortTitle(s, max)));
}

/** "Read 3 files", "2 searches": the line a folded group shows. */
export function groupLabel(t: Tr, kind: ActKind, n: number): string {
  switch (kind) {
    case 'read':
      return t(`讀取 ${n} 個檔案`, `Read ${n} files`);
    case 'search':
      return t(`搜尋 ${n} 次`, `${n} searches`);
    case 'write':
      return t(`寫入 ${n} 次`, `${n} edits`);
    case 'command':
      return t(`執行 ${n} 個終端指令`, `${n} terminal commands`);
    default:
      return t(`${n} 個動作`, `${n} actions`);
  }
}

/** The latest state of each tool call (an update replaces its call in place: the last event of a seq wins). */
const latestCalls = (events: AgentEvent[]) => [...new Map(events.filter((e) => e.kind === 'tool').map((e) => [e.seq, e])).values()];

/**
 * The live line under a working agent: what it waits for, else nothing extra while a tool call runs (that call is in
 * the feed, in place, with its own time), else "working" — never a finished command as if it still ran.
 */
export function liveLine(agent: Pick<AgentRunInfo, 'status' | 'waiting'>, events: AgentEvent[], approvals = 0, paused = false): { kind: 'paused' } | { kind: 'waiting'; text: string } | { kind: 'approval'; n: number } | { kind: 'tool'; calls: AgentEvent[] } | { kind: 'working' } | undefined {
  if (agent.status !== 'running' && agent.status !== 'queued' && agent.status !== 'paused') return undefined;
  // Held up by the user: said as such, not as work going on.
  if (paused || agent.status === 'paused') return { kind: 'paused' };
  if (approvals) return { kind: 'approval', n: approvals };
  if (agent.waiting) return { kind: 'waiting', text: agent.waiting };
  const calls = latestCalls(events).filter((e) => e.tool?.status === 'running');
  return calls.length ? { kind: 'tool', calls } : { kind: 'working' };
}

/** A message that is a submission's JSON (the text fallback): the card shows the parsed result instead. */
export function isSubmissionText(text: string | undefined): boolean {
  const s = (text ?? '').trim().replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return false;
  try {
    const v = JSON.parse(s);
    return !!v && typeof v === 'object' && ['summary', 'verdict', 'ops', 'steps', 'metrics', 'markdown'].some((k) => k in v);
  } catch {
    return false;
  }
}

export function roundOf(run: WorkflowRun, a: AgentRunInfo): Round | undefined {
  if (!a.stage || !a.round) return undefined;
  const st = a.stage === 'verify' ? run.stages.verify : run.stages[a.stage];
  return st?.rounds.find((r) => r.n === a.round);
}

/** The checks this turn ran, as Aivenue saw them: from its submission. */
function checkCounts(round: Round | undefined) {
  const c = round?.submission?.checks;
  if (!c) return undefined;
  return { failed: c.filter((x) => x.outcome === 'failed' || x.outcome === 'output_failure').length, passed: c.filter((x) => x.outcome === 'passed').length, all: c.length };
}

/**
 * One line saying how a finished turn ended: "Implemented · 2 files changed · 1 check failed". Only facts from the
 * records (its status, its submission, what Aivenue saw); empty while it still works.
 */
export function turnSummary(t: Tr, run: WorkflowRun, a: AgentRunInfo): string[] {
  if (a.status === 'running' || a.status === 'queued' || a.status === 'paused') return [];
  const round = roundOf(run, a);
  const files = a.stats.filesChanged.length;
  const maybe = a.stats.filesMaybeChanged?.length ?? 0;
  // Only edits made with the edit tool are the agent's own record; a file written by a terminal command shows in the
  // workflow's file list, not here, so the line says which it counts.
  const fileParts = [files ? t(`以編輯工具改了 ${files} 個檔案`, `${files} file(s) changed with the edit tool`) : '', maybe ? t(`${maybe} 個可能改動`, `${maybe} possibly changed`) : ''];
  const ended = a.status === 'failed' ? t('失敗', 'Failed') : a.status === 'cancelled' ? t('已停止', 'Stopped') : '';
  let head = '';
  const extra: string[] = [];
  switch (a.role) {
    case 'planner':
      head = round?.submission?.plan ? t(`計畫完成 · ${round.submission.plan.steps.length} 個步驟`, `Plan written · ${round.submission.plan.steps.length} step(s)`) : '';
      break;
    case 'plan_reviewer':
    case 'code_reviewer': {
      const r = round?.review;
      if (r) head = r.verdict === 'approve' ? t('審查通過', 'Approved') : t(`要求修改 · ${r.issues.length} 個問題`, `Changes requested · ${r.issues.length} issue(s)`);
      if (r?.needsValidation?.length) extra.push(t(`${r.needsValidation.length} 項待驗證`, `${r.needsValidation.length} to validate`));
      break;
    }
    case 'executor': {
      head = round?.submission ? t('實作完成', 'Implemented') : '';
      const c = checkCounts(round);
      // Every check once: passed and failed side by side (a pass is not hidden behind a failure, nor the reverse).
      if (c) extra.push(c.passed || c.failed ? [c.passed ? t(`${c.passed} 項檢查通過`, `${c.passed} check(s) passed`) : '', c.failed ? t(`${c.failed} 項檢查失敗`, `${c.failed} check(s) failed`) : ''].filter(Boolean).join(t('、', ', ')) : c.all ? t('檢查要看輸出', 'checks: read the output') : t('沒看到檢查', 'no check seen'));
      break;
    }
    case 'verifier': {
      const v = round?.verification;
      if (v) head = round?.route?.to === 'done' ? t('目標達成', 'Goal met') : t(`目標驗收 ${v.metrics.filter((m) => m.met).length}/${v.metrics.length}`, `Goal ${v.metrics.filter((m) => m.met).length}/${v.metrics.length}`);
      break;
    }
    case 'compactor':
      head = a.status === 'completed' ? t('共用記憶已整理', 'Shared memory updated') : '';
      break;
    default:
      head = a.status === 'completed' ? t('完成', 'Done') : '';
  }
  if (a.endedWithoutResult) extra.push(t('沒有交出結果', 'no result handed in'));
  return [ended || head || t('已結束', 'Ended'), ...(ended && head ? [head] : []), ...fileParts, ...extra].filter(Boolean);
}

/**
 * Why this turn exists, when the work came back: "The review found R1, R2 → implementation round 2". From the
 * round before it in the same stage (its review), or the goal verification that routed the work back.
 */
export function reworkLine(t: Tr, run: WorkflowRun, a: AgentRunInfo): string | undefined {
  if ((a.role !== 'executor' && a.role !== 'planner') || !a.stage || a.stage === 'verify' || !a.round || a.round < 2) return undefined;
  const prev = run.stages[a.stage]?.rounds.find((r) => r.n === a.round! - 1);
  const what = a.stage === 'plan' ? t(`開始第 ${a.round} 輪計畫`, `planning round ${a.round}`) : t(`開始第 ${a.round} 輪實作`, `implementation round ${a.round}`);
  if (prev?.review?.verdict === 'revise') {
    const ids = prev.review.issues.map((i) => i.id);
    return `${t('審查發現', 'The review found')} ${ids.length ? ids.join(t('、', ', ')) : t('需要修改', 'changes needed')} → ${what}`;
  }
  const v = [...(run.stages.verify?.rounds ?? [])].reverse().find((r) => r.verification && r.route && r.route.to !== 'done' && (run.agents[r.reviewerAgentId ?? '']?.endedAt ?? 0) <= (a.startedAt ?? Infinity));
  if (v?.route) return `${t('目標驗收', 'Goal verification')}: ${v.route.reason.slice(0, 160)} → ${what}`;
  if (prev?.route && prev.route.to !== 'done') return `${prev.route.reason.slice(0, 160)} → ${what}`;
  return undefined;
}

/**
 * A short readable preview of Markdown: link text instead of link syntax, a long path as its file name, no
 * markers, code or images; whole words up to `max` characters.
 */
export function plainPreview(md: string, max = 280): string {
  let s = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, (_m, text: string) => text)
    .replace(/<((https?|file):[^>\s]+)>/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(\S[\s\S]*?\S|\S)\1/g, '$2');
  // A path of several folders reads as its last part (the file).
  s = s.replace(/(?:[A-Za-z]:)?(?:[\\/][^\s\\/'"()<>[\]]+){3,}/g, (p) => p.split(/[\\/]/).filter(Boolean).pop() ?? p);
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

export type StepState = 'done' | 'active' | 'pending' | 'failed' | 'skipped' | 'unreported';

/**
 * A plan step as reported. A step its agent never reported done stays unreported once the stage is over — not
 * done, whatever the workflow's outcome.
 */
export function stepState(s: Pick<PlanStep, 'status' | 'rework'>, stageStatus: string, runEnded: boolean): StepState {
  if (s.rework?.length && stageStatus !== 'approved') return 'failed';
  if (s.status === 'done') return 'done';
  if (s.status === 'skipped') return 'skipped';
  if (s.status === 'blocked') return 'failed';
  const over = stageStatus === 'approved' || stageStatus === 'failed' || stageStatus === 'cancelled' || runEnded;
  if (over) return 'unreported';
  return s.status === 'in_progress' ? 'active' : 'pending';
}

// ---------- long workflows: sub-agents as batches, the overview, files by folder ----------

// Batches are defined once, in core (the hub's completion note says the same as the screen).
export { batchState, batchesOf, batchCounts, runBatches, type Batch, type BatchState } from '../../core/src/batches';
import { batchCounts, runBatches } from '../../core/src/batches';

/**
 * The workflow at a glance, kept apart: this round's agents (running, ended, waiting for you), the delegated batches
 * of every agent, and background processes that outlive the round — so "the workflow ended" never reads as "the
 * task is done" while batches are blocked or processes still run.
 */
export function runOverview(t: Tr, run: WorkflowRun, titleOf: (a: AgentRunInfo) => string): string[] {
  const live = run.status === 'running' || run.status === 'paused' || run.status === 'waiting_human';
  const phase =
    run.status === 'waiting_human' || run.pending || run.approvals?.length
      ? t('等你處理', 'Waiting for you')
      : run.status === 'paused'
        ? t('已暫停', 'Paused')
        : live
          ? t('本輪執行中', 'This round is running')
          : run.status === 'completed'
            ? t('本輪工作流已完成', 'This round of the workflow is complete')
            : run.status === 'cancelled'
              ? t('本輪已停止', 'This round was stopped')
              : run.status === 'failed'
                ? t('本輪失敗', 'This round failed')
                : run.status === 'incomplete'
                  ? t('本輪結束，目標未達成', 'This round ended without meeting the goal')
                  : t('本輪已結束', 'This round has ended');
  const parts = [phase];
  const all = runBatches(Object.values(run.agents), titleOf);
  if (all.length) {
    const c = batchCounts(all);
    parts.push(
      [
        t(`子代理批次 ${c.done}/${all.length} 完成`, `sub-agent batches ${c.done}/${all.length} done`),
        c.running ? t(`${c.running} 執行中`, `${c.running} running`) : '',
        c.blocked ? t(`${c.blocked} 受阻`, `${c.blocked} blocked`) : '',
      ]
        .filter(Boolean)
        .join(t('、', ', ')),
    );
  }
  const procs = (run.processes ?? []).filter((p) => p.alive).length;
  if (procs) parts.push(t(`背景程序 ${procs} 個仍在執行`, `${procs} background process(es) still running`));
  return parts;
}

/** Paths grouped by their folder, the biggest group first; `label` is the folder's last two parts. */
export function byFolder(paths: string[]): { dir: string; label: string; files: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    const dir = cut > 0 ? p.slice(0, cut) : '';
    (groups.get(dir) ?? groups.set(dir, []).get(dir)!).push(cut >= 0 ? p.slice(cut + 1) : p);
  }
  return [...groups.entries()]
    .map(([dir, files]) => {
      const parts = dir.split(/[\\/]/).filter(Boolean);
      return { dir, label: parts.length > 2 ? `…/${parts.slice(-2).join('/')}/` : `${dir}/`, files };
    })
    .sort((a, b) => b.files.length - a.files.length || a.dir.localeCompare(b.dir));
}

/** A tool call's title for one line: a very long one (a whole script) cut, the full text left to its details. */
export const shortTitle = (s: string, max = 160) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** What the workflow produced, most telling first: added files, then modified ones (folders standing for many last). */
export function deliverables(run: WorkflowRun, max = 6): { shown: string[]; total: number } {
  const out = (run.outputs ?? []).filter((o) => o.status !== 'deleted');
  const rank = (o: (typeof out)[number]) => (o.status === 'added' ? 0 : 1) + (o.count ? 2 : 0);
  const sorted = [...out].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
  return { shown: sorted.slice(0, max).map((o) => o.path), total: out.length };
}

/**
 * How far the result was checked, from the records: the checks Aivenue saw at the last submission, what the last
 * review left unconfirmed, and the goal verification — not what an agent says it verified.
 */
export function verificationScope(t: Tr, run: WorkflowRun): string[] {
  const impl = run.stages.implement?.rounds ?? [];
  const last = [...impl].reverse().find((r) => r.submission);
  const checks = last?.submission?.checks;
  const parts: string[] = [];
  if (checks) {
    // Each check counted once, by its state; a later file change is said on the check's own row, not as one more.
    const passed = checks.filter((c) => c.outcome === 'passed').length;
    const failed = checks.filter((c) => c.outcome === 'failed' || c.outcome === 'output_failure').length;
    const skipped = checks.filter((c) => c.outcome === 'may_not_run').length;
    const read = checks.length - passed - failed - skipped;
    parts.push(
      checks.length
        ? `${t(`${checks.length} 項檢查：`, `${checks.length} check(s): `)}${[passed ? t(`${passed} 通過`, `${passed} passed`) : '', failed ? t(`${failed} 失敗`, `${failed} failed`) : '', read > 0 ? t(`${read} 要看輸出`, `${read} to read in the output`) : '', skipped ? t(`${skipped} 不確定是否執行`, `${skipped} not known whether they ran`) : '']
            .filter(Boolean)
            .join(t('、', ', '))}`
        : t('沒看到任何檢查執行（結果裡的「通過」是 agent 自述）', 'no check seen run (any "passed" in the result is the agent\'s own account)'),
    );
  }
  const review = [...impl].reverse().find((r) => r.review)?.review;
  if (review?.needsValidation?.length) parts.push(t(`${review.needsValidation.length} 項待驗證（審查未能確認）`, `${review.needsValidation.length} item(s) not confirmed by the review`));
  const v = [...(run.stages.verify?.rounds ?? [])].reverse().find((r) => r.verification)?.verification;
  if (v) {
    const n = `${v.metrics.filter((m) => m.met).length}/${v.metrics.length}`;
    // A result measured on code that changed since is history: said as the last one, to be checked again.
    parts.push(v.stale ? t(`上次目標驗收 ${n}，之後有改動，需重驗`, `last goal verification ${n}; changed since, needs checking again`) : t(`目標驗收 ${n}`, `goal ${n}`));
  }
  return parts.filter(Boolean);
}

/**
 * An error as a person reads it: a provider's JSON error body becomes its message ("The '…' model is not supported…");
 * anything else stays as it is. The full text stays in the attempt's details.
 */
export function readableError(s: string | undefined): string {
  const text = (s ?? '').trim();
  const at = text.indexOf('{');
  if (at < 0) return text;
  try {
    const v = JSON.parse(text.slice(at));
    const msg = v?.error?.message ?? v?.message ?? v?.detail ?? (typeof v?.error === 'string' ? v.error : undefined);
    const code = v?.error?.code ?? v?.code;
    return typeof msg === 'string' && msg.trim() ? `${text.slice(0, at).trim() ? `${text.slice(0, at).trim()} ` : ''}${msg.trim()}${typeof code === 'string' ? ` (${code})` : ''}` : text;
  } catch {
    return text;
  }
}

/** One row per check: its state, what to know at a glance, and what is behind it (earlier runs, later changes). */
export interface CheckRow {
  cls: 'ok' | 'bad' | 'warn' | 'muted';
  status: string;
  /** Shown on the row: a rerun. (Whether a check was in the task's scope is not guessed from free text.) */
  notes: string[];
  /** Behind the row: files changed after it, who ran it. */
  details: string[];
  /** Every run of it, oldest first, with what it printed (as kept at submission). */
  runs: { ts: number; outcome: ObservedCheck['outcome']; output?: string; seq?: number; latest: boolean }[];
}
export function checkRow(t: Tr, c: ObservedCheck): CheckRow {
  const failedLike = (o: ObservedCheck['outcome']) => o === 'failed' || o === 'output_failure';
  const status =
    c.outcome === 'passed'
      ? { cls: 'ok' as const, text: t('通過', 'passed') }
      : c.outcome === 'failed'
        ? { cls: 'bad' as const, text: t('失敗', 'failed') }
        : c.outcome === 'output_failure'
          ? { cls: 'bad' as const, text: t('執行完成，但輸出回報失敗', 'ran; its output reports a failure') }
          : c.outcome === 'may_not_run'
            ? { cls: 'warn' as const, text: c.lineOk === false ? t('不確定是否執行（整行失敗）', 'not known whether it ran (the line failed)') : t('不確定是否執行（整行成功）', 'not known whether it ran (the line ended fine)') }
            : { cls: 'muted' as const, text: t('在較長的指令中執行，結果要看輸出', 'ran within a longer command; see its output') };
  const earlier = c.earlier ?? [];
  const notes: string[] = [];
  if (earlier.some((e) => failedLike(e.outcome))) notes.push(c.outcome === 'passed' ? t('先前失敗，重跑通過', 'failed before, passed on rerun') : t(`重跑 ${earlier.length} 次`, `rerun ${earlier.length} time(s)`));
  const details: string[] = [];
  if (c.outdated) details.push(t('這項檢查之後有改檔：要確認現在的程式碼，需要重跑', 'files changed after this check: re-run it to check the code as it is now'));
  else if (c.maybeOutdated) details.push(t('這項檢查之後有失敗的編輯：檔案可能已變，請確認', 'a failed edit came after this check: files may have changed'));
  details.push(t(`${c.by} 執行`, `run by ${c.by}`));
  return {
    cls: status.cls,
    status: status.text,
    notes,
    details,
    runs: [...earlier.map((e) => ({ ...e, latest: false })), { ts: c.ts, outcome: c.outcome, output: c.output, seq: c.seq, latest: true }],
  };
}

/**
 * The lines of a failed command's output a person needs first: the error message and, when given, what was expected
 * against what came (`actual` / `expected`, or the `+`/`-` lines of a diff), not the stack. Else its first lines.
 */
export function errorPreview(out: string | undefined, max = 3): string[] {
  const lines = (out ?? '').replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  const stack = (l: string) => /^\s+at\s|^\s*\^+\s*$|^node:|^\s*throw\b|^\s*[{}]\s*$|^Node\.js v\d/.test(l);
  const message = lines.findIndex((l) => !stack(l) && /\b\w*(?:Error|Exception)\b|^error\b|\bFAIL(?:ED)?\b|Traceback|failing\b/i.test(l));
  if (message < 0) return lines.filter((l) => !stack(l)).slice(0, max);
  const pick = [lines[message]];
  const pair = lines.filter((l) => /^\s*(?:actual|expected)\s*:/i.test(l));
  if (pair.length) pick.push(...pair.slice(0, 2).map((l) => l.trim()));
  else pick.push(...lines.slice(message + 1).filter((l) => /^\s*[+-]\s+\S/.test(l) && !/^\s*\+ actual - expected/.test(l)).slice(0, 2).map((l) => l.trim()));
  return pick.slice(0, max);
}

/** A tool call of Aivenue's own (records, progress, submission): kept in the details, not in the default view. */
export const isInternal = (e: AgentEvent) => e.kind === 'tool' && e.tool?.category === 'hub' && e.tool.status !== 'running' && e.tool.status !== 'error';

/**
 * What the workflow produced, from its file list (added first): each with the agents whose edit tool changed it; none
 * means the change was found only by comparing the folder (a terminal command, a script).
 */
export function deliverableRows(run: WorkflowRun): { path: string; status: 'added' | 'modified'; count?: number; editedBy: string[] }[] {
  const cwd = run.config.cwd;
  return (run.outputs ?? [])
    .filter((o): o is typeof o & { status: 'added' | 'modified' } => o.status !== 'deleted')
    .sort((a, b) => (a.status === 'added' ? 0 : 1) - (b.status === 'added' ? 0 : 1) || a.path.localeCompare(b.path))
    .map((o) => {
      // The same file only: both as full paths under the working folder (`C:/other/src/slug.js` is not `src/slug.js`).
      const target = fullPath(o.abs || o.path, cwd);
      return {
        path: o.path,
        status: o.status,
        ...(o.count ? { count: o.count } : {}),
        editedBy: target
          ? Object.values(run.agents)
              .filter((a) => a.stats.filesChanged.some((f) => fullPath(f, cwd) === target))
              .map((a) => a.id)
          : [],
      };
    });
}

/**
 * A path as one full, comparable path: relative ones taken from the working folder, `.` and `..` resolved, slashes
 * evened, a Windows path in lower case (its file system ignores case). Undefined when there is no folder to start from.
 */
export function fullPath(p: string, cwd: string | undefined): string | undefined {
  const fwd = (s: string) => s.replace(/\\/g, '/');
  let s = fwd(p.trim());
  if (!/^(?:[a-z]:)?\//i.test(s)) {
    if (!cwd) return undefined;
    s = `${fwd(cwd).replace(/\/+$/, '')}/${s}`;
  }
  const drive = /^[a-z]:/i.exec(s)?.[0] ?? '';
  const parts: string[] = [];
  for (const seg of s.slice(drive.length).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const out = `${drive}/${parts.join('/')}`;
  return drive ? out.toLowerCase() : out;
}

