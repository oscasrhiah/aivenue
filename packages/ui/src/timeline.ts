// What a workflow's timeline shows by default, as plain data (no React): the live line of a working agent, routine
// activity folded into one line, the one-line result of a finished turn, why work came back, a readable preview of
// a result, and the state of a plan step. The cards render these; the full records stay one click away.
import type { AgentEvent, AgentRunInfo, ObservedCheck, PlanStep, Review, Round, WorkflowRun } from '../../core/src/types';

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
  // A file read or edited twice is named once (the label counts it once).
  if (kind === 'read' || kind === 'write') return [...new Set(titles)].map((s) => s.split(/[\\/]/).pop() ?? s);
  return titles.map((s) => shortTitle(s, max));
}

/**
 * "讀 3 個檔案", "搜尋 2 次": the line a folded group shows, in the words of the activity log's line (activityLabel). `n`:
 * files for reads and edits (each file once), calls for the rest.
 */
export function groupLabel(t: Tr, kind: ActKind, n: number): string {
  switch (kind) {
    case 'read':
      return t(`讀 ${n} 個檔案`, `Read ${n} file(s)`);
    case 'search':
      return t(`搜尋 ${n} 次`, `${n} search(es)`);
    case 'write':
      return t(`修改 ${n} 個檔案`, `Edited ${n} file(s)`);
    case 'command':
      return t(`執行 ${n} 個指令`, `Ran ${n} command(s)`);
    default:
      return t(`${n} 個動作`, `${n} action(s)`);
  }
}

/** How many a folded group counts: the files it read or edited (a file twice is one), else its calls. */
export const groupCount = (kind: ActKind, titles: string[]) => (kind === 'read' || kind === 'write' ? new Set(titles).size : titles.length);

/** The latest state of each tool call (an update replaces its call in place: the last event of a seq wins). */
const latestCalls = (events: AgentEvent[]) => [...new Map(events.filter((e) => e.kind === 'tool').map((e) => [e.seq, e])).values()];

/** What a turn did, by kind: files read and edited (each file once), searches, terminal commands, anything else. */
export interface ActivityCounts {
  read: number;
  search: number;
  command: number;
  write: number;
  other: number;
}

/** The counts behind an activity log's one line. Aivenue's own calls (records, progress, the submission) are not counted. */
export function activityCounts(events: AgentEvent[]): ActivityCounts {
  const calls = latestCalls(events).filter((e) => !isInternal(e));
  const of = (k: ActKind) => calls.filter((e) => actKind(e) === k);
  // A file read twice is one file; an edit that failed changed nothing that is known.
  const files = (list: AgentEvent[]) => new Set(list.map((e) => e.tool!.title)).size;
  return { read: files(of('read')), search: of('search').length, command: of('command').length, write: files(of('write').filter((e) => e.tool?.status !== 'error')), other: of('other').length };
}

/**
 * An activity log's closed line, said as what happened: "讀 3 個檔案、執行 2 個指令、修改 3 個檔案" ("Read 3 files, ran 2
 * commands, edited 3 files"), and the notes it shared. Empty when it did none of these.
 */
export function activityLabel(t: Tr, c: ActivityCounts, notes = 0): string {
  const s = [
    c.read ? t(`讀 ${c.read} 個檔案`, `read ${c.read} file(s)`) : '',
    c.search ? t(`搜尋 ${c.search} 次`, `${c.search} search(es)`) : '',
    c.command ? t(`執行 ${c.command} 個指令`, `ran ${c.command} command(s)`) : '',
    c.write ? t(`修改 ${c.write} 個檔案`, `edited ${c.write} file(s)`) : '',
    c.other ? t(`其他 ${c.other} 個動作`, `${c.other} other action(s)`) : '',
    notes ? t(`${notes} 則筆記`, `${notes} note(s)`) : '',
  ]
    .filter(Boolean)
    .join(t('、', ', '));
  return s && s[0].toUpperCase() + s.slice(1);
}

/** A review's issues as its verdict counts them: those in the reviewed change, and those found outside it (listed apart). */
export function issueCounts(r: Pick<Review, 'issues'>): { inChange: number; before: number } {
  const before = r.issues.filter((i) => i.preExisting).length;
  return { inChange: r.issues.length - before, before };
}

/** "另有 1 個既有問題": the issues outside the change, said apart from the verdict's count (empty when there are none). */
export const preExistingText = (t: Tr, n: number) => (n ? t(`另有 ${n} 個既有問題`, `${n} more pre-existing`) : '');

/**
 * A review's conclusion in the same words wherever it is said (the reviewer's turn, its one line, the review report, the
 * progress): an incomplete report is never a verdict; an independent review's approval is a recommendation ("建議通過"),
 * a workflow's own review approves ("審查通過"); "要求修改" with the issues in the change ("2 個問題", never "0 個問題") and
 * those outside it apart.
 */
export function verdictWords(t: Tr, r: Pick<Review, 'verdict' | 'issues' | 'incomplete'>, independent: boolean): { kind: 'incomplete' | 'approve' | 'revise'; label: string; count: string; before: string } {
  const c = issueCounts(r);
  const count = c.inChange ? t(`${c.inChange} 個問題`, `${c.inChange} issue(s)`) : '';
  const before = preExistingText(t, c.before);
  if (r.incomplete?.length) return { kind: 'incomplete', label: t('報告不完整，不算審查結果', 'Incomplete report, not a result'), count: '', before: '' };
  if (r.verdict === 'approve') return { kind: 'approve', label: independent ? t('建議通過', 'Approve') : t('審查通過', 'Approved'), count, before };
  return { kind: 'revise', label: t('要求修改', 'Changes requested'), count, before };
}

/**
 * Why work came back, counted as the verdict counts: "審查要求修改 2 個問題：R1、R2，另有 1 個既有問題" (the ids of the
 * issues in the change; those outside it only counted).
 */
export function reviseReason(t: Tr, r: Pick<Review, 'issues'>): string {
  const mine = r.issues.filter((i) => !i.preExisting);
  const ids = mine.map((i) => i.id);
  const named = ids.length > 6 ? `${ids.slice(0, 6).join(t('、', ', '))}…` : ids.join(t('、', ', '));
  return [mine.length ? t(`審查要求修改 ${mine.length} 個問題：${named}`, `changes requested, ${mine.length} issue(s): ${named}`) : t('審查要求修改', 'changes requested'), preExistingText(t, r.issues.length - mine.length)]
    .filter(Boolean)
    .join(t('，', ', '));
}

/**
 * A line of the workflow's own record, as the chat shows it: where a stage starts (a heading: 「計畫」「實作」「驗收」, and
 * one for each round after the first, with why it came back), or an event said once (you stopped an agent, answered a
 * question, the plan changed, a failure…).
 */
export interface ChatLine {
  ts: number;
  key: string;
  kind: 'stage' | 'event';
  level: 'info' | 'warn' | 'error';
  /**
   * What an event is about, for its icon: a question to you (said quietly: its card is right below), someone stopping
   * an agent or the workflow, work sent back, the workflow's failure. A warning without one is a warning.
   */
  tone?: 'question' | 'stopped' | 'revise' | 'failed';
  text: string;
  /** A heading's detail: which round and why, what is reviewed, which check and who verifies. */
  detail?: string;
}

// The record's lines are written in the language of the moment (core/src/orchestrator.ts): both are read here.
const STAGE = '(計畫階段|實作階段|Planning|Implementation)';
const LINE = {
  start: new RegExp(`^${STAGE}(?:開始| started)$`),
  resumed: new RegExp(`^${STAGE}(?:接續| resumed)$`),
  again: new RegExp(`^${STAGE}(?:重新開始（第 (\\d+) 輪循環）| again \\(cycle (\\d+)\\))$`),
  round: new RegExp(`^${STAGE}(?: 第 (\\d+) 輪| · round (\\d+))$`),
  approved: new RegExp(`^${STAGE}(?:審查通過| approved) ✅$`),
  revise: new RegExp(`^${STAGE}(?:審查要求修改：(\\d+) 個問題| review requested changes: (\\d+) issue\\(s\\))$`),
  done: /^(?:本輪工作流完成 ✅(?: 目標驗收通過)?|This round of the workflow is complete ✅(?: goal verified)?)$/,
  reviewStart: /^(?:獨立審查開始（不實作）：|Independent review started \(no implementation\): )([\s\S]*)$/,
  reviewDone: /^(?:獨立審查完成：|Independent review done: )/,
  verify: /^(?:目標驗收 第 (\d+) 次（([\s\S]*)）|Goal verification · check (\d+) \(([\s\S]*)\))$/,
  question: /^(?:.+ 有問題要問你|.+ has a question for you)$/,
  stopped: /^(?:你停止了 |You stopped |工作流已取消$|Workflow cancelled$)/,
  failed: /^(?:工作流失敗：|Workflow failed: )([\s\S]*)$/,
  incomplete: /^(?:工作流未完成：([\s\S]*)。目標沒有達成，不算完成。|Workflow incomplete: ([\s\S]*)\. The goal was not met, so it is not done\.)$/,
};

/**
 * The record's lines the chat shows, each thing said once. A stage gets one heading where it starts, restarts or resumes
 * (the round it starts with joins it: "實作 · 重新開始 · 第 2 輪循環 · 第 3 輪"), and one for each round after, joined
 * to the review that sent the work back ("第 2 輪 · 審查要求修改 2 個問題：R1、R2"). A "changes requested" line that
 * stays apart (a decision of yours came between) is counted the same way. Left out: a review's approval (the reviewer's
 * turn says it), an independent review's verdict and "this round of the workflow is complete" when the result card below
 * says them (`resultShown`). The workflow's failure (or its end without meeting the goal) is said in a word when the
 * note at the end of the chat gives its reason (`endNote`). Every other line stays as it was.
 */
export function chatLines(t: Tr, run: WorkflowRun, resultShown: boolean, endNote = false): ChatLine[] {
  const out: ChatLine[] = [];
  type Stage = 'plan' | 'implement';
  const stageOf = (s: string): Stage => (s === '計畫階段' || s === 'Planning' ? 'plan' : 'implement');
  const name = (k: Stage) => (k === 'plan' ? t('計畫', 'Plan') : t('實作', 'Implement'));
  // The round a "changes requested" line speaks of: the stage's last review that sent the work back before the line was
  // written (when its reviewer ended, else its hand-off); without either, the next such review in order.
  const sentOrder: Record<Stage, number> = { plan: 0, implement: 0 };
  const reviewAt = (r: Round) => run.agents?.[r.reviewerAgentId ?? '']?.endedAt ?? r.handoff?.ts;
  const revisedBy = (stage: Stage, ts: number): Review | undefined => {
    const sent = (run.stages[stage]?.rounds ?? []).filter((r) => r.review?.verdict === 'revise');
    const k = sentOrder[stage]++;
    const timed = sent.filter((r) => reviewAt(r) !== undefined);
    return (timed.length ? [...timed].reverse().find((r) => reviewAt(r)! <= ts) : sent[k])?.review;
  };
  // A "changes requested" line (with why, as the verdict counts it, and the record's own count), until the next line says
  // whether the round it sends the work back to starts right after; a stage's heading, until the next line says which
  // round it starts with.
  let sentBack: { at: number; stage: Stage; why?: string; n: number } | undefined;
  let opened: { at: number; stage: Stage } | undefined;
  run.log.forEach((l, i) => {
    if (!l.chat) return;
    const held = sentBack;
    const head = opened;
    sentBack = undefined;
    opened = undefined;
    const text = l.text.trim();
    const line = (x: Pick<ChatLine, 'kind' | 'text'> & Partial<ChatLine>): ChatLine => ({ ts: l.ts, key: `log${i}`, level: x.kind === 'stage' ? 'info' : l.level, ...x });
    const heading = (stage: Stage, detail?: string) => {
      opened = { at: out.length, stage };
      out.push(line({ kind: 'stage', text: name(stage), detail }));
    };
    let m: RegExpExecArray | null;
    if ((m = LINE.start.exec(text))) return heading(stageOf(m[1]));
    if ((m = LINE.resumed.exec(text))) return heading(stageOf(m[1]), t('接續', 'resumed'));
    if ((m = LINE.again.exec(text))) return heading(stageOf(m[1]), t(`重新開始 · 第 ${m[2] ?? m[3]} 輪循環`, `again · cycle ${m[2] ?? m[3]}`));
    if ((m = LINE.round.exec(text))) {
      const n = Number(m[2] ?? m[3]);
      // The stage's heading starts its first round.
      if (n < 2) return;
      const stage = stageOf(m[1]);
      const round = t(`第 ${n} 輪`, `round ${n}`);
      // Right after the stage's heading (a restart, a resumption): the round joins it.
      if (head?.stage === stage) {
        out[head.at] = { ...out[head.at], detail: [out[head.at].detail, round].filter(Boolean).join(' · ') };
        return;
      }
      if (held?.stage !== stage) return void out.push(line({ kind: 'stage', text: t(`第 ${n} 輪`, `Round ${n}`) }));
      // Sent back right before: one line for both, counted as the verdict counts (issues outside the change apart).
      const review = run.stages[stage]?.rounds.find((r) => r.n === n - 1)?.review;
      const why = review?.verdict === 'revise' ? reviseReason(t, review) : (held.why ?? t(`審查要求修改 ${held.n} 個問題`, `changes requested, ${held.n} issue(s)`));
      out[held.at] = line({ kind: 'stage', text: t(`第 ${n} 輪`, `Round ${n}`), detail: why });
      return;
    }
    if ((m = LINE.revise.exec(text))) {
      const stage = stageOf(m[1]);
      const review = revisedBy(stage, l.ts);
      // Counted as the reviewer's verdict counts (the record's own number has every issue, those outside the change too).
      const why = review ? reviseReason(t, review) : undefined;
      sentBack = { at: out.length, stage, why, n: Number(m[2] ?? m[3]) };
      return void out.push(line({ kind: 'event', tone: 'revise', text: why ? t(`${m[1]}${why}`, `${m[1]}: ${why}`) : text }));
    }
    if (LINE.approved.test(text)) return;
    if ((m = LINE.reviewStart.exec(text))) return void out.push(line({ kind: 'stage', text: t('獨立審查', 'Independent review'), detail: [t('不實作', 'no implementation'), m[1].trim()].filter(Boolean).join(' · ') }));
    if ((m = LINE.verify.exec(text))) {
      const n = Number(m[1] ?? m[3]);
      return void out.push(line({ kind: 'stage', text: t('驗收', 'Verify'), detail: [n > 1 ? t(`第 ${n} 次`, `check ${n}`) : '', (m[2] ?? m[4] ?? '').trim()].filter(Boolean).join(' · ') || undefined }));
    }
    if (resultShown && (LINE.done.test(text) || LINE.reviewDone.test(text))) return;
    // A question to you: said quietly, its card (with the question) is right below while it waits.
    if (LINE.question.test(text)) return void out.push(line({ kind: 'event', tone: 'question', level: 'info', text }));
    // You stopped an agent: what you did, said quietly; the workflow cancelled keeps its colour.
    if (LINE.stopped.test(text)) return void out.push(line({ kind: 'event', tone: 'stopped', level: /^(?:你停止了 |You stopped )/.test(text) ? 'info' : l.level, text }));
    // The workflow failed, or ended without meeting its goal: when the note at the end of the chat gives the same reason,
    // said here in a word (with its time).
    const failure = run.status === 'failed' && run.error?.trim();
    if ((m = LINE.failed.exec(text)) || (failure && l.level === 'error' && text === failure)) {
      const short = endNote && !!failure && (m ? m[1].trim() : text) === failure;
      return void out.push(line({ kind: 'event', tone: 'failed', text: short ? t('工作流失敗', 'Workflow failed') : text }));
    }
    if ((m = LINE.incomplete.exec(text)) && endNote && run.status === 'incomplete' && (m[1] ?? m[2] ?? '').trim() === (run.incompleteReason ?? '').trim()) return void out.push(line({ kind: 'event', text: t('工作流未完成', 'Workflow incomplete') }));
    out.push(line({ kind: 'event', text }));
  });
  return out;
}

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

/**
 * What the final result shows as the implementer's account: its last reply or the summary it submitted, whichever says
 * more. A reply that is the whole answer (a question asked) wins over a short summary; a one-line "submitted" after
 * a full report (a table of the steps) does not hide the report. A reply that is only the submission's JSON is the
 * summary's.
 */
export function resultText(reply: string | undefined, summary: string | undefined): string | undefined {
  const r = isSubmissionText(reply) ? '' : (reply ?? '').trim();
  const s = (summary ?? '').trim();
  return (s.length > r.length ? s : r) || undefined;
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
  // The round's submission, review or verification is this turn's only when it handed it in: an attempt that failed or
  // was stopped (another agent then did the round) has none of its own.
  const of = roundOf(run, a);
  const authored = a.role === 'planner' || a.role === 'executor';
  const round = of && (authored ? of.authorAgentId === a.id : of.reviewerAgentId === a.id) ? of : undefined;
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
      // The verdict counts the issues in the change; those outside it are said apart (as the report and the hub do). An
      // incomplete report is not a verdict.
      if (r) {
        const w = verdictWords(t, r, !!run.config?.review);
        head = [w.label, w.count].filter(Boolean).join(' · ');
        if (w.before) extra.push(w.before);
      }
      if (r?.needsValidation?.length && !r.incomplete?.length) extra.push(t(`${r.needsValidation.length} 項待驗證`, `${r.needsValidation.length} to validate`));
      break;
    }
    case 'executor': {
      head = round?.submission ? t('實作完成', 'Implemented') : '';
      const c = checkCounts(round);
      // Every check once: passed and failed side by side (a pass is not hidden behind a failure, nor the reverse).
      if (c) extra.push(c.passed || c.failed ? [c.passed ? t(`${c.passed} 項檢查通過`, `${c.passed} check(s) passed`) : '', c.failed ? t(`${c.failed} 項檢查失敗`, `${c.failed} check(s) failed`) : ''].filter(Boolean).join(t('、', ', ')) : c.all ? t('檢查要看輸出', 'checks: read the output') : t('尚未執行檢查', 'no check run'));
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
 * Why this turn exists, when the work came back for a reason the chat does not say elsewhere: the goal verification that
 * routed it back ("目標驗收：…，開始第 2 輪實作"), or the route the round before it took. Work a review sent back has
 * none: the round's heading says that review ("第 2 輪 · 審查要求修改 2 個問題：R1、R2"), the review's issues are listed
 * in its turn.
 */
export function reworkLine(t: Tr, run: WorkflowRun, a: AgentRunInfo): string | undefined {
  if ((a.role !== 'executor' && a.role !== 'planner') || !a.stage || a.stage === 'verify' || !a.round || a.round < 2) return undefined;
  const prev = run.stages[a.stage]?.rounds.find((r) => r.n === a.round! - 1);
  if (prev?.review?.verdict === 'revise') return undefined;
  const what = a.stage === 'plan' ? t(`開始第 ${a.round} 輪計畫`, `planning round ${a.round}`) : t(`開始第 ${a.round} 輪實作`, `implementation round ${a.round}`);
  const v = [...(run.stages.verify?.rounds ?? [])].reverse().find((r) => r.verification && r.route && r.route.to !== 'done' && (run.agents[r.reviewerAgentId ?? '']?.endedAt ?? 0) <= (a.startedAt ?? Infinity));
  if (v?.route) return t(`目標驗收：${v.route.reason.slice(0, 160)}，${what}`, `Goal verification: ${v.route.reason.slice(0, 160)}; ${what}`);
  if (prev?.route && prev.route.to !== 'done') return t(`${prev.route.reason.slice(0, 160)}，${what}`, `${prev.route.reason.slice(0, 160)}; ${what}`);
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
 * One state of the result's verification, as the result card shows it: its kind, said in its own words (a failed
 * check, no check run, a check to run again after a change, too little evidence) and never merged into one
 * "unverified"; how many; and, when it matters, why. Taken from the records only — the checks Aivenue saw at the last
 * submission, what the last review left unconfirmed, the goal verification — not from what an agent says it verified.
 */
export interface VerificationState {
  kind: 'failed' | 'not_run' | 'recheck' | 'weak' | 'passed' | 'goal';
  cls: 'ok' | 'bad' | 'warn';
  label: string;
  detail?: string;
}

export function verificationStates(t: Tr, run: WorkflowRun): VerificationState[] {
  const impl = run.stages.implement?.rounds ?? [];
  const last = [...impl].reverse().find((r) => r.submission);
  const checks = last?.submission?.checks;
  const out: VerificationState[] = [];
  const list = (parts: string[]) => parts.filter(Boolean).join(t('、', ', '));
  let unsure = 0;
  let inOutput = 0;
  if (checks) {
    // Each check counted once, by its state. A failure stays a failure (a change after it is said with it); a pass
    // with a change after it is no longer a pass of the code as it is: to run again.
    const failed = checks.filter((c) => c.outcome === 'failed' || c.outcome === 'output_failure');
    const changed = (c: ObservedCheck) => c.outdated || c.maybeOutdated;
    const recheck = checks.filter((c) => !failed.includes(c) && changed(c));
    const passed = checks.filter((c) => c.outcome === 'passed' && !changed(c));
    unsure = checks.filter((c) => c.outcome === 'may_not_run' && !changed(c)).length;
    inOutput = checks.filter((c) => c.outcome === 'in_longer_command' && !changed(c)).length;
    const failedChanged = failed.filter(changed).length;
    if (failed.length)
      out.push({ kind: 'failed', cls: 'bad', label: t(`檢查失敗 ${failed.length} 項`, `${failed.length} check(s) failed`), detail: failedChanged ? t(`其中 ${failedChanged} 項之後有改檔，要重跑才知道現在的結果`, `${failedChanged} of them changed after: run again to know the result now`) : undefined });
    if (!checks.length)
      out.push({ kind: 'not_run', cls: 'warn', label: t('尚未執行檢查', 'No check run'), detail: t('沒有看到任何檢查執行；結果裡的「通過」是 agent 自述', 'No check was seen running; any "passed" in the result is the agent\'s own account') });
    if (recheck.length) {
      const sure = recheck.filter((c) => c.outdated).length;
      out.push({
        kind: 'recheck',
        cls: 'warn',
        label: t(`變更後需重驗 ${recheck.length} 項`, `${recheck.length} to re-check after changes`),
        detail: list([sure ? t(`${sure} 項之後有改檔`, `${sure} with files changed after`) : '', recheck.length - sure ? t(`${recheck.length - sure} 項之後有失敗的編輯或寫檔指令，檔案可能已變`, `${recheck.length - sure} with a failed edit or file-writing command after (files may have changed)`) : '']),
      });
    }
  }
  const review = [...impl].reverse().find((r) => r.review)?.review;
  const unconfirmed = review?.needsValidation?.length ?? 0;
  const weak = unsure + inOutput + unconfirmed;
  if (weak)
    out.push({
      kind: 'weak',
      cls: 'warn',
      label: t(`證據不足 ${weak} 項`, `${weak} with too little evidence`),
      detail: list([
        unsure ? t(`${unsure} 項不確定是否執行`, `${unsure} not known whether they ran`) : '',
        inOutput ? t(`${inOutput} 項在較長的指令中執行，結果要看輸出`, `${inOutput} ran within a longer command: read the output`) : '',
        unconfirmed ? t(`${unconfirmed} 項審查未能確認`, `${unconfirmed} not confirmed by the review`) : '',
      ]),
    });
  const passed = checks?.filter((c) => c.outcome === 'passed' && !c.outdated && !c.maybeOutdated).length ?? 0;
  if (passed) out.push({ kind: 'passed', cls: 'ok', label: t(`檢查通過 ${passed} 項`, `${passed} check(s) passed`) });
  const v = [...(run.stages.verify?.rounds ?? [])].reverse().find((r) => r.verification)?.verification;
  if (v) {
    const met = v.metrics.filter((m) => m.met).length;
    const n = `${met}/${v.metrics.length}`;
    // A result measured on code that changed since is history: said as the last one, to be checked again.
    if (v.stale) out.push({ kind: 'recheck', cls: 'warn', label: t(`上次目標驗收 ${n}，之後有改動，需重驗`, `last goal verification ${n}; changed since, needs checking again`) });
    else out.push({ kind: 'goal', cls: met === v.metrics.length ? 'ok' : 'bad', label: t(`目標驗收 ${n}`, `goal ${n}`) });
  }
  return out;
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
  /**
   * Its state as the result's verification counts it (verificationStates), each with its own icon: passed, failed, to
   * re-check after a change (a pass or an unsure run with a change after it), too little evidence (not known whether it
   * ran, or ran within a longer command).
   */
  kind: 'passed' | 'failed' | 'recheck' | 'weak';
  cls: 'ok' | 'bad' | 'warn';
  status: string;
  /** Shown on the row: a rerun, a change after it. (Whether a check was in the task's scope is not guessed from free text.) */
  notes: string[];
  /** Behind the row: files changed after it, who ran it. */
  details: string[];
  /** Every run of it, oldest first, with what it printed (as kept at submission). */
  runs: { ts: number; outcome: ObservedCheck['outcome']; output?: string; seq?: number; latest: boolean }[];
}
export function checkRow(t: Tr, c: ObservedCheck): CheckRow {
  const failedLike = (o: ObservedCheck['outcome']) => o === 'failed' || o === 'output_failure';
  const said =
    c.outcome === 'passed'
      ? t('通過', 'passed')
      : c.outcome === 'failed'
        ? t('失敗', 'failed')
        : c.outcome === 'output_failure'
          ? t('執行完成，但輸出回報失敗', 'ran; its output reports a failure')
          : c.outcome === 'may_not_run'
            ? c.lineOk === false
              ? t('不確定是否執行（整行失敗）', 'not known whether it ran (the line failed)')
              : t('不確定是否執行（整行成功）', 'not known whether it ran (the line ended fine)')
            : t('在較長的指令中執行，結果要看輸出', 'ran within a longer command; see its output');
  const changed = !!(c.outdated || c.maybeOutdated);
  // A failure stays a failure (a change after it is said with it); anything else with a change after it is not a result
  // of the code as it is now: to run again.
  const kind: CheckRow['kind'] = failedLike(c.outcome) ? 'failed' : changed ? 'recheck' : c.outcome === 'passed' ? 'passed' : 'weak';
  const earlier = c.earlier ?? [];
  const notes: string[] = [];
  if (earlier.some((e) => failedLike(e.outcome))) notes.push(c.outcome === 'passed' ? t('先前失敗，重跑通過', 'failed before, passed on rerun') : t(`重跑 ${earlier.length} 次`, `rerun ${earlier.length} time(s)`));
  // Why it is to be checked again, on the row (its state says that it is).
  const why = c.outdated ? t('之後有改檔', 'files changed after it') : c.maybeOutdated ? t('之後有失敗的編輯或寫檔指令，檔案可能已變', 'a failed edit or file-writing command came after it: files may have changed') : '';
  if (why) notes.push(kind === 'failed' ? t(`${why}，變更後需重驗`, `${why}: re-check after changes`) : why);
  const details: string[] = [];
  if (c.outdated) details.push(t('這項檢查之後有改檔：要確認現在的程式碼，需要重跑', 'files changed after this check: re-run it to check the code as it is now'));
  else if (c.maybeOutdated) details.push(t('這項檢查之後有失敗的編輯或寫檔指令：檔案可能已變，請確認', 'a failed edit or file-writing command came after this check: files may have changed'));
  details.push(t(`${c.by} 執行`, `run by ${c.by}`));
  return {
    kind,
    cls: kind === 'passed' ? 'ok' : kind === 'failed' ? 'bad' : 'warn',
    status: kind === 'recheck' ? t(`${said} · 變更後需重驗`, `${said} · re-check after changes`) : said,
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

