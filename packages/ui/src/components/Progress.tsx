import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Circle, CircleCheck, CircleDashed, CircleDot, CircleHelp, CircleMinus, CircleX, Hand, Lock, MessageCircleQuestionMark, Pause, RefreshCw, Signpost, Target, type LucideIcon } from 'lucide-react';
import { Ico } from '../icons';
import type { AgentRole, ProviderInfo, StageKey, Verification, WorkflowRun } from '../../../core/src/types';
import { useT } from '../i18n';
import { askerOf, cx, modelLabel, providerName, subTitle, waitWord } from '../util';
import { batchCounts, runBatches, runOverview, stepState, verdictWords } from '../timeline';
import { AgentWindow, GpuWindow, ProcessWindow, Window } from './DetailWindows';

type ItemState = 'done' | 'active' | 'pending' | 'failed' | 'skipped' | 'unreported';
interface Item {
  key: string;
  label: string;
  meta?: string;
  /** What the meta line leaves out: the model each agent ran on. */
  title?: string;
  state: ItemState;
  sub?: boolean;
}

const STAGE_ROLES: Record<StageKey, [AgentRole, AgentRole]> = { plan: ['planner', 'plan_reviewer'], implement: ['executor', 'code_reviewer'] };

/** Checklist of where the workflow is: stages, review loops and the plan's steps. */
function buildItems(run: WorkflowRun, providers: ProviderInfo[], t: ReturnType<typeof useT>): Item[] {
  const agents = Object.values(run.agents);
  const ended = run.status !== 'running' && run.status !== 'paused' && run.status !== 'waiting_human';
  const items: Item[] = [];
  for (const key of ['plan', 'implement'] as StageKey[]) {
    const cfg = run.config[key];
    const st = run.stages[key];
    if (!cfg.enabled || st.status === 'skipped') continue;
    const [authorRole, reviewerRole] = STAGE_ROLES[key];
    const round = st.rounds[st.rounds.length - 1];
    const roundMeta = st.rounds.length > 1 ? t(`第 ${st.rounds.length} 輪`, `round ${st.rounds.length}`) : undefined;
    const running = (role: AgentRole) => agents.some((a) => a.stage === key && a.role === role && (a.status === 'running' || a.status === 'paused' || a.status === 'queued'));
    const who = (role: AgentRole, fallback?: string) => {
      const a = agents.filter((x) => x.stage === key && x.role === role).sort((x, y) => (y.startedAt ?? 0) - (x.startedAt ?? 0))[0];
      const id = a?.provider ?? fallback;
      return id ? providerName(providers, id) : undefined;
    };
    const modelOf = (role: AgentRole) => {
      const a = agents.filter((x) => x.stage === key && x.role === role).sort((x, y) => (y.startedAt ?? 0) - (x.startedAt ?? 0))[0];
      return a?.model ? `${providerName(providers, a.provider)} · ${modelLabel(a.model)}` : undefined;
    };
    const failed = st.status === 'failed' || st.status === 'cancelled';
    const stateOf = (isRunning: boolean, isDone: boolean): ItemState => (isRunning ? 'active' : isDone ? 'done' : failed || (ended && st.status !== 'approved') ? 'failed' : 'pending');

    // Independent review: nobody implements; the one item is the review and its verdict (in the words of its report).
    if (key === 'implement' && run.config.review) {
      const w = round?.review && !running(reviewerRole) ? verdictWords(t, round.review, true) : undefined;
      const verdict = w && [w.label, w.count].filter(Boolean).join(t('，', ', '));
      items.push({
        key: 'review-only',
        label: t('獨立審查', 'Independent review'),
        meta: [who(reviewerRole, (cfg.reviewer ?? cfg.author).provider), verdict].filter(Boolean).join(' · '),
        title: [t('只審查，不實作', 'Review only, no implementation'), modelOf(reviewerRole)].filter(Boolean).join('\n'),
        state: stateOf(running(reviewerRole), st.status === 'approved'),
      });
      continue;
    }
    const authorDone = st.status === 'approved' || (!!round?.submission && !running(authorRole));
    items.push({
      key: `${key}-author`,
      label: key === 'plan' ? t('撰寫計畫', 'Write the plan') : t('實作', 'Implement'),
      meta: [who(authorRole, cfg.author.provider), roundMeta].filter(Boolean).join(' · '),
      title: modelOf(authorRole),
      state: stateOf(running(authorRole), authorDone),
    });
    if (key === 'implement')
      for (const s of run.steps)
        items.push({
          key: `step-${s.id}`,
          // Steps reported without a plan use free-form ids and often repeat the note as the title.
          label: /^\d/.test(s.id) ? `${s.id}. ${s.title}` : s.title,
          meta: [
            s.rework?.length ? t(`審查退回，需修正：${s.rework.join('、')}`, `Sent back by the review: ${s.rework.join(', ')}`) : s.note && !s.title.includes(s.note.slice(0, 20)) ? s.note : undefined,
            // As reported: a step its agent never marked done is not shown as done, whatever the stage's outcome.
            stepState(s, st.status, ended) === 'unreported' ? t('未回報完成', 'not reported done') : undefined,
          ]
            .filter(Boolean)
            .join(t('，', ', ')),
          sub: true,
          state: stepState(s, st.status, ended),
        });
    if (cfg.reviewer)
      items.push({
        key: `${key}-review`,
        label: key === 'plan' ? t('審查計畫', 'Review the plan') : t('審查程式碼', 'Review the code'),
        meta: [who(reviewerRole, cfg.reviewer.provider), round?.review?.verdict === 'revise' && !running(reviewerRole) && st.status === 'running' ? t('要求修改，退回重做', 'changes requested, back to the author') : undefined].filter(Boolean).join(' · '),
        title: modelOf(reviewerRole),
        state: stateOf(running(reviewerRole), st.status === 'approved'),
      });
  }
  // Goal verification: after the code review, until every metric is met.
  const vst = run.stages.verify;
  if (run.config.verify?.enabled && vst) {
    const last = vst.rounds[vst.rounds.length - 1];
    const runningV = agents.some((a) => a.role === 'verifier' && (a.status === 'running' || a.status === 'paused' || a.status === 'queued'));
    const v = last?.verification;
    items.push({
      key: 'verify',
      label: t('目標驗收', 'Goal verification'),
      meta: [run.config.verify.by === 'planner' ? t('由計畫者', 'by the planner') : t('獨立驗收', 'independent'), v && !runningV ? outcomeText(t, v) : vst.rounds.length > 1 ? t(`第 ${vst.rounds.length} 次`, `check ${vst.rounds.length}`) : undefined]
        .filter(Boolean)
        .join(' · '),
      title: v && !runningV && vst.rounds.length > 1 ? t(`第 ${vst.rounds.length} 次驗收`, `check ${vst.rounds.length}`) : undefined,
      state: runningV ? 'active' : vst.status === 'approved' ? 'done' : ended ? 'failed' : 'pending',
    });
  }
  return items;
}

/**
 * A workflow whose progress has nothing more to say: it completed, every stage and plan step was reported done (or
 * skipped), no sub-agent batch is blocked or still running and no background process is alive. Its result then carries
 * the progress as a quiet "進度 7/7" button instead of a panel of its own.
 */
export function progressSettled(run: WorkflowRun, providers: ProviderInfo[], t: ReturnType<typeof useT>): boolean {
  if (run.status !== 'completed') return false;
  const items = buildItems(run, providers, t);
  const batches = batchCounts(runBatches(Object.values(run.agents), subTitle));
  return items.length > 0 && items.every((i) => i.state === 'done' || i.state === 'skipped') && !batches.blocked && !batches.running && !(run.processes ?? []).some((p) => p.alive);
}

const STATE_ICON: Record<ItemState, LucideIcon> = { done: CircleCheck, active: CircleDot, pending: Circle, failed: CircleX, skipped: CircleMinus, unreported: CircleHelp };

/** The checklist rows: stages, review loops and the plan's steps, each with its state (a line icon in its colour, named). */
function ProgressItems({ items }: { items: Item[] }) {
  const t = useT();
  const name: Record<ItemState, string> = { done: t('完成', 'done'), active: t('進行中', 'in progress'), pending: t('尚未開始', 'not started'), failed: t('失敗', 'failed'), skipped: t('略過', 'skipped'), unreported: t('未回報完成', 'not reported done') };
  return (
    <div className="pp-list">
      {items.map((i) => (
        <div key={i.key} className={cx('pp-item', i.state, i.sub && 'sub')} title={i.title}>
          <span className={cx('pp-icon', i.state)}>
            <Ico i={STATE_ICON[i.state]} size={i.sub ? 14 : 16} label={name[i.state]} />
          </span>
          <span className="pp-label">{i.label}</span>
          {i.meta && <span className="pp-meta">{i.meta}</span>}
        </div>
      ))}
    </div>
  );
}

/** Why a goal reading is to be checked again, beside 「變更後需重驗」 wherever it is said. */
const staleWhy = (t: ReturnType<typeof useT>) => t('量測之後程式碼改過', 'the code changed after it was measured');

/** The goal's progress as a button that opens every metric (target, latest measurement, evidence). */
function GoalButton({ run }: { run: WorkflowRun }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const gap = goalGap(run);
  if (!gap.rows.length) return null;
  return (
    <>
      <button type="button" className={cx('pp-goal-btn', gap.met === gap.rows.length && 'ok', gap.stale && 'warn')} onClick={() => setOpen(true)} title={t('點一下查看每個驗收目標的目標值、最新量測與證據', 'Click to see each acceptance metric: target, latest measurement and evidence')}>
        <Ico i={Target} size={14} /> {t('目標', 'Goal')} {gap.met}/{gap.rows.length}
        {gap.stale && (
          <>
            <span className="state-word warn">
              <Ico i={RefreshCw} size={13} /> {t('變更後需重驗', 'Re-check after changes')}
            </span>
            <span className="pp-goal-why">{staleWhy(t)}</span>
          </>
        )}
      </button>
      {open && <GoalWindow run={run} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The checklist's count: steps done, of all; the skipped ones said apart (a skipped step is not a done one). */
function stepCount(t: ReturnType<typeof useT>, items: Item[]): string {
  const done = items.filter((i) => i.state === 'done').length;
  const skipped = items.filter((i) => i.state === 'skipped').length;
  return [`${done}/${items.length}`, skipped ? t(`略過 ${skipped}`, `${skipped} skipped`) : ''].filter(Boolean).join(' · ');
}

/**
 * "進度 7/7" ("進度 5/7 · 略過 2"): a settled workflow's progress, from its result's header (the list opens in the result,
 * see ProgressList). A workflow of one step has nothing to list that its result card does not say (who did it, how it
 * ended).
 */
export function ProgressToggle({ run, providers, open, onToggle }: { run: WorkflowRun; providers: ProviderInfo[]; open: boolean; onToggle: () => void }) {
  const t = useT();
  const items = buildItems(run, providers, t);
  if (items.length < 2 && !goalGap(run).rows.length) return null;
  return (
    <button type="button" className="progress-toggle" aria-expanded={open} onClick={onToggle}>
      <Ico i={open ? ChevronDown : ChevronRight} size={14} /> {t('進度', 'Progress')} {stepCount(t, items)}
    </button>
  );
}

/** A settled workflow's progress, opened in its result: the same checklist as the panel, the batches, the goal. */
export function ProgressList({ run, providers }: { run: WorkflowRun; providers: ProviderInfo[] }) {
  const t = useT();
  const items = buildItems(run, providers, t);
  // What the panel's line said besides "complete": the delegated batches (all done here).
  const more = runOverview(t, run, subTitle).slice(1);
  return (
    <div className="progress-list">
      {more.length > 0 && <div className="muted small">{more.join(t('，', ', '))}</div>}
      <ProgressItems items={items} />
      <GoalButton run={run} />
    </div>
  );
}

export const outcomeText = (t: ReturnType<typeof useT>, v: Verification) =>
  ({ met: t('目標達成', 'goal met'), not_met: t('目標未達成，重新規劃', 'goal not met, re-plan'), invalid_evidence: t('證據無效，重新驗證', 'invalid evidence, re-test'), defect: t('有缺陷，退回修正', 'defects, back to fix') })[v.outcome];

/** Latest measurement of each acceptance metric (the gap to the goal). */
export function goalGap(run: WorkflowRun) {
  const metrics = run.plan?.goal?.metrics ?? [];
  const checks = (run.stages.verify?.rounds ?? []).flatMap((r) => (r.verification ? [r.verification] : []));
  const last = checks[checks.length - 1];
  // A code review newer than the last verification also reads the metrics: that is the progress shown.
  const review = [...(run.stages.implement?.rounds ?? [])].reverse().find((r) => r.review?.goal?.length)?.review;
  const byReview = !!review && (!last || (review.evidence?.at ?? 0) > (last.evidence?.at ?? 0));
  const reading = byReview ? { metrics: review!.goal!, stale: review!.stale } : last;
  // The planner's metrics, plus what the verifier measured besides them (the user's own criteria, "U1"…).
  const extra = (reading?.metrics ?? []).filter((m) => !metrics.some((x) => x.id === m.id)).map((m) => ({ id: m.id, name: '', target: '', how: '' }));
  const rows = [...metrics, ...extra].map((m) => {
    const got = reading?.metrics.find((x) => x.id === m.id);
    return { ...m, value: got?.value, met: got?.met, evidence: got?.evidence };
  });
  return { rows, met: rows.filter((r) => r.met).length, stale: !!reading?.stale, last, byReview };
}

/** Every acceptance metric in full: target, how it is measured, the latest value and its evidence. */
export function GoalWindow({ run, onClose }: { run: WorkflowRun; onClose: () => void }) {
  const t = useT();
  const gap = goalGap(run);
  const goal = run.plan?.goal;
  return (
    <Window title={t(`驗收目標 · ${gap.met}/${gap.rows.length} 項達成`, `Acceptance goal · ${gap.met}/${gap.rows.length} met`)} onClose={onClose}>
      {goal?.statement && <div className="gw-statement">{goal.statement}</div>}
      <div className="muted small gw-meta">
        <div>
          {gap.byReview
            ? t('下面是最近一輪程式碼審查的進度讀數，正式結果以目標驗收為準。', 'Below: progress as read by the latest code review; goal verification has the final say.')
            : gap.last
              ? t(`最新驗收：${outcomeText(t, gap.last)}`, `Latest verification: ${outcomeText(t, gap.last)}`)
              : t('還沒有驗收過', 'Not verified yet')}
        </div>
        {gap.byReview && gap.last && <div>{t(`上次驗收：${outcomeText(t, gap.last)}`, `Last verification: ${outcomeText(t, gap.last)}`)}</div>}
        {(run.cycles ?? 0) > 0 && <div>{t(`第 ${(run.cycles ?? 0) + 1} 輪循環`, `Cycle ${(run.cycles ?? 0) + 1}`)}</div>}
      </div>
      {gap.stale && (
        <div className="gw-stale">
          <span className="state-word warn">
            <Ico i={RefreshCw} size={14} /> {t('變更後需重驗', 'Re-check after changes')}
          </span>{' '}
          <span className="muted small">{staleWhy(t)}</span>
        </div>
      )}
      <div className="gw-list">
        {gap.rows.map((m) => (
          <div key={m.id} className={cx('gw-metric', m.met === true ? 'ok' : m.met === false ? 'no' : 'todo')}>
            {/* Its state as an icon and a coloured word (no box): met, not met, not measured yet. */}
            <div className="gw-head">
              <b>{m.id}</b> {m.name || (m.id.startsWith('U') ? t('你的驗收標準', 'your criterion') : '')}
              <span className={cx('state-word', m.met === true ? 'ok' : m.met === false ? 'err' : undefined)}>
                <Ico i={m.met === true ? CircleCheck : m.met === false ? CircleX : CircleDashed} size={14} /> {m.met === true ? t('達成', 'met') : m.met === false ? t('未達成', 'not met') : t('尚未量測', 'not measured')}
              </span>
            </div>
            {m.target && (
              <div className="gw-row">
                <span className="muted">{t('目標', 'Target')}</span>
                <span>{m.target}</span>
              </div>
            )}
            {m.value !== undefined && (
              <div className="gw-row">
                <span className="muted">{t('量測值', 'Measured')}</span>
                <span>{m.value}</span>
              </div>
            )}
            {m.how && (
              <div className="gw-row">
                <span className="muted">{t('量測方式', 'How')}</span>
                <span>{m.how}</span>
              </div>
            )}
            {m.evidence && (
              <div className="gw-row">
                <span className="muted">{t('證據', 'Evidence')}</span>
                <span>{m.evidence}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </Window>
  );
}

/**
 * What holds the workflow up right now, in words (empty when nothing does), each with its icon: paused; your answer to an
 * agent's question (who asked; the card above has the question), your decision, your approval (one word per kind, as in
 * the header); an agent waiting for something or recovering from a failure. `word` is the waiting word it starts with and
 * `rest` what it adds to that word (none for a question: the card above names who asks).
 */
export function blockers(run: WorkflowRun, providers: ProviderInfo[], t: ReturnType<typeof useT>): { text: string; icon?: LucideIcon; word?: string; rest?: string }[] {
  const out: { text: string; icon?: LucideIcon; word?: string; rest?: string }[] = [];
  if (run.status === 'paused') out.push({ text: t('已暫停', 'Paused'), icon: Pause, word: t('已暫停', 'Paused') });
  if (run.pending?.question) {
    const who = askerOf(t, run, providers);
    const word = waitWord(t, 'question');
    out.push({ text: who ? t(`${word} ${who} 的問題`, `${word} to ${who}'s question`) : word, icon: MessageCircleQuestionMark, word });
  } else if (run.pending) out.push({ text: `${waitWord(t, 'decision')} · ${run.pending.message}`, icon: Signpost, word: waitWord(t, 'decision'), rest: run.pending.message });
  if (run.approvals?.length) {
    const word = waitWord(t, 'approval');
    const rest = t(`${run.approvals.length} 個動作`, `${run.approvals.length} action(s)`);
    out.push({ text: t(`${word} ${rest}`, `${word} on ${rest}`), icon: Hand, word, rest });
  }
  for (const a of Object.values(run.agents)) {
    if (!['running', 'paused', 'queued'].includes(a.status)) continue;
    const who = `${providerName(providers, a.provider)}`;
    if (a.waiting) out.push({ text: `${who}：${a.waiting}` });
    else if (a.failure && a.status === 'running') out.push({ text: `${who}：${a.failure.action}` });
  }
  return out;
}

/**
 * The workflow's progress above the input: open while it runs, folded to its one line once it ended. When it completed
 * with every step done and a result card is shown (`resultShown`), there is nothing left to say here: the panel goes, and
 * the result's header carries the same list behind a quiet "進度 7/7" (ProgressToggle).
 */
export function ProgressPanel({ run, providers, resultShown = false }: { run: WorkflowRun; providers: ProviderInfo[]; resultShown?: boolean }) {
  const t = useT();
  const isLive = run.status === 'running' || run.status === 'paused' || run.status === 'waiting_human';
  const [open, setOpen] = useState(isLive);
  // When the workflow ends, the panel folds to its one line: the final result is what is read then, and the space
  // above the input is freed. A step not reported done is still said on that line; the list is one click away.
  const wasLive = useRef(isLive);
  useEffect(() => {
    if (wasLive.current && !isLive) setOpen(false);
    wasLive.current = isLive;
  }, [isLive]);
  // A detail window opened from a tag: an agent, the GPUs or a background process.
  const [detail, setDetail] = useState<{ agent: string } | { gpu: true } | { pid: number }>();
  const items = buildItems(run, providers, t);
  if (!items.length || (resultShown && progressSettled(run, providers, t))) return null;
  const unreported = items.filter((i) => i.state === 'unreported').length;
  const current = items.find((i) => i.state === 'active');
  const live = run.status === 'running' || run.status === 'paused' || run.status === 'waiting_human';
  const block = live ? blockers(run, providers, t) : [];
  const working = live ? Object.values(run.agents).filter((a) => a.status === 'running' && a.role !== 'compactor') : [];
  const runningProcs = (run.processes ?? []).filter((p) => p.alive);
  const overview = runOverview(t, run, subTitle);
  // What holds it up beyond what the phase already says (「已暫停」 is the phase itself): the 「卡在」 line draws only
  // that. A blocker that starts with the phase's own word (「等你核准」 under 「等你核准 1 個動作」) adds only its rest
  // there (「1 個動作」), or nothing (a question: the card above names who asks); its whole text stays in the tooltip.
  const held = block.filter((b) => b.text !== overview[0]);
  const heldShown = held.map((b) => (b.word && b.word === overview[0] ? (b.rest ?? '') : b.text)).filter(Boolean);
  const steps = t(`工作流步驟 ${stepCount(t, items)}`, `workflow steps ${stepCount(t, items)}`);
  // Folded, the line names what holds it up unless the phase already says it (「等你核准」 and 「等你核准 1 個動作」).
  const second = live && !open ? held.find((b) => !(b.word && b.word === overview[0]) && !b.text.startsWith(overview[0])) : undefined;
  const secondText = second ? undefined : live ? steps : unreported > 0 ? t(`${unreported} 個步驟未回報完成`, `${unreported} step(s) not reported done`) : overview[1];
  const lineTitle = [...overview, live ? steps : '', !live && unreported > 0 ? t(`${unreported} 個步驟未回報完成`, `${unreported} step(s) not reported done`) : '', ...held.map((b) => b.text), live && current ? t(`目前：${current.label}`, `Now: ${current.label}`) : ''].filter(Boolean).join('\n');
  return (
    <div className="progress-panel">
      <div className="pp-headrow">
        <button className="pp-head" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Ico i={open ? ChevronDown : ChevronRight} size={14} className="pp-chev" />
          <span className="pp-title">{t('進度', 'Progress')}</span>
          <span className="muted small pp-summary" title={lineTitle}>
            {/* This round's phase and the one thing to know next (what holds it up, else the steps); the batches and
                background processes in its tooltip and in the open panel. */}
            {overview[0]}
            {second ? (
              <>
                {' · '}
                {second.icon && <Ico i={second.icon} size={14} />} {second.text}
              </>
            ) : secondText ? (
              ` · ${secondText}`
            ) : (
              ''
            )}
          </span>
        </button>
        <GoalButton run={run} />
      </div>
      {open && (
        // The expanded part scrolls inside itself, so the message box never moves however much is in it.
        <div className="pp-body">
      {(working.length > 0 || heldShown.length > 0 || overview.length > 1 || !!run.gpuLocks?.length || runningProcs.length > 0) && (
        <div className="pp-status">
          {overview.length > 1 && <div className="muted small">{overview.slice(1).join(t('，', ', '))}</div>}
          {working.length > 0 && (
            <div className="pp-now">
              <span className="pp-sub">{t('目前', 'Now')}</span>
              {working.map((a) => (
                <button key={a.id} className="pp-chip clickable" title={t('點一下查看它正在做什麼', 'Click to see what it is doing')} onClick={() => setDetail({ agent: a.id })}>
                  <span className={cx('am-dot', 'live')} /> {providerName(providers, a.provider)} · {a.role === 'subagent' ? subTitle(a) : a.task}
                </button>
              ))}
            </div>
          )}
          {/* One quiet line, no box: what to do is in the card right above it. */}
          {heldShown.length > 0 && (
            <div className="pp-block">
              <span className="pp-sub">{t('卡在', 'Blocked by')}</span>
              <span className="pp-block-text" title={held.map((b) => b.text).join('\n')}>
                {heldShown.join(t('、', ', '))}
              </span>
            </div>
          )}
          {!!run.gpuLocks?.length && (
            <div className="pp-now">
              <span className="pp-sub">GPU</span>
              {run.gpuLocks.map((l, i) => (
                <button key={i} className="pp-chip clickable" title={t('點一下查看 GPU 的使用狀態', 'Click to see the GPU status')} onClick={() => setDetail({ gpu: true })}>
                  <Ico i={Lock} size={13} /> GPU {l.gpus.join(', ')} · {providerName(providers, run.agents[l.agentId]?.provider ?? '')}
                </button>
              ))}
            </div>
          )}
          {!!run.processes?.some((p) => p.alive) && (
            <div className="pp-now">
              <span className="pp-sub">{t('背景程序', 'Background')}</span>
              {/* Ended ones move to the agent map, next to the round that started them. */}
              {run.processes.filter((p) => p.alive).map((p) => (
                <button key={p.pid} className={cx('pp-chip clickable', !p.alive && 'muted')} title={`${p.alive ? t('執行中', 'alive') : t('已結束', 'ended')}\n${t('點一下查看進度、速度與日誌', 'Click to see its progress, speed and log')}`} onClick={() => setDetail({ pid: p.pid })}>
                  <span className={cx('am-dot', p.alive && 'live')} /> {p.pid} · {p.purpose}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
        <ProgressItems items={items} />
        </div>
      )}
      {detail && 'agent' in detail && <AgentWindow run={run} agentId={detail.agent} providers={providers} onClose={() => setDetail(undefined)} />}
      {detail && 'gpu' in detail && <GpuWindow run={run} providers={providers} onClose={() => setDetail(undefined)} />}
      {detail && 'pid' in detail && <ProcessWindow run={run} pid={detail.pid} providers={providers} onClose={() => setDetail(undefined)} />}
    </div>
  );
}
