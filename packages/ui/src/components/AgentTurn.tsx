import { useMemo, useState, type ReactNode } from 'react';
import { BookOpen, ChevronDown, ChevronRight, CircleCheck, CircleDashed, CircleHelp, CircleStop, CircleX, CornerDownRight, Hand, Handshake, Hourglass, LoaderCircle, MessageCircleQuestionMark, Network, Pause, Pin, RefreshCw, RotateCw, Ribbon, Square, TriangleAlert, Undo2, Wrench, X, type LucideIcon, Braces } from 'lucide-react';
import { Ico } from '../icons';
import type { AgentRunInfo, FailureKind, Handoff, IssueResponse, ObservedCheck, ProviderInfo, ReviewIssue, Round, WorkflowRun } from '../../../core/src/types';
import { fileUrl, hub, useAgentEvents } from '../api';
import { useT } from '../i18n';
import { cx, duration, firstLine, fullTime, saidOwner, modelLabel, providerName, roleLabel, similar, subTitle, waitWord } from '../util';
import { Clamp } from './Clamp';
import { SwitchProvider } from './RunTools';
import { LiveFeed, Transcript, visible } from './Transcript';
import { Approvals, permissionLabel } from './Safety';
import { activityCounts, activityLabel, batchCounts, batchesOf, isInternal, liveLine, readableError, reworkLine, roundOf, turnSummary, verdictWords, type Batch, type BatchState } from '../timeline';
import { Markdown } from './Markdown';
import { CopyButton } from './CopyButton';
import { reviewMarkdown } from '../reviewText';
import { CheckRows } from './Checks';
import { extensionSummary } from '../extensionUse';
import { outcomeText } from './Progress';
import { RememberButton } from './Memory';
import { reviewShown, VERDICT_CLS, VERDICT_ICON } from './ReviewResult';

export const failureLabel = (t: ReturnType<typeof useT>, k: FailureKind) =>
  ({ rate_limit: t('限流', 'Rate limited'), quota: t('額度用完', 'Out of quota'), network: t('網路', 'Network'), auth: t('登入失效', 'Signed out'), model_service: t('模型服務故障', 'Model service'), logic: t('執行錯誤', 'Task error'), unknown: t('未知錯誤', 'Unknown') })[k];

const NOTE_KIND = (t: ReturnType<typeof useT>, k?: string) => (k === 'fact' ? t('事實', 'Fact') : k === 'decision' ? t('決策', 'Decision') : k === 'inference' ? t('推論', 'Inference') : undefined);

/** A part of a turn that opens in place: a real button with its chevron and state (Tab, Enter, Space). */
function FoldButton({ open, onToggle, children, className }: { open: boolean; onToggle: () => void; children: ReactNode; className?: string }) {
  return (
    <button type="button" className={cx('fold-btn', className)} aria-expanded={open} onClick={onToggle}>
      <Ico i={open ? ChevronDown : ChevronRight} size={14} /> {children}
    </button>
  );
}

/** A round's hand-off: facts, decisions and open issues, each linking back to where it came from. */
function HandoffBlock({ h }: { h: Handoff }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!h.facts.length && !h.decisions.length && !h.open.length) return null;
  return (
    <div className="block handoff">
      <FoldButton open={open} onToggle={() => setOpen(!open)}>
        {t('交接摘要', 'Hand-off')} · {t(`${h.decisions.length} 個決策、${h.open.length} 個未解`, `${h.decisions.length} decisions, ${h.open.length} open`)}
      </FoldButton>
      {open && (
        <div className="handoff-body small">
          {h.decisions.map((x, i) => (
            <div key={`d${i}`}>
              <span className="state-word ok">{t('決策', 'Decision')}</span> {x}
            </div>
          ))}
          {h.facts.map((x, i) => (
            <div key={`f${i}`}>
              <span className="state-word">{t('事實', 'Fact')}</span> {x}
            </div>
          ))}
          {h.open.map((x, i) => (
            <div key={`o${i}`}>
              <span className="state-word warn">{t('未解', 'Open')}</span> {x}
            </div>
          ))}
          <div className="muted tiny">{t('證據：', 'Evidence: ')}{h.links.map((l) => (l.issueId ? l.issueId : `${l.label} ${l.agentId?.slice(0, 6) ?? ''}`)).join(' · ')}</div>
        </div>
      )}
    </div>
  );
}

/**
 * What a review or verification was measured on, said the same way current or not (「版本 …」; the commit and the
 * working tree's hash, which tells two reviews of one commit apart, in its tooltip). Out of date: 「變更後需重驗」 with why
 * in view (the code changed after that version); else the version, quietly.
 */
function Evidence({ stale, evidence }: { stale?: boolean; evidence?: { commit?: string; treeHash: string; at: number } }) {
  const t = useT();
  if (!evidence) return null;
  // 「版本」: the commit when there is one, else the working tree's hash; both in the tooltip.
  const version = (evidence.commit ?? evidence.treeHash).slice(0, 8);
  const full = `${evidence.commit ? `commit ${evidence.commit}\n` : ''}tree ${evidence.treeHash}`;
  return stale ? (
    <span className="verdict-stale">
      <span className="state-word warn">
        <Ico i={RefreshCw} size={14} /> {t('變更後需重驗', 'Re-check after changes')}
      </span>
      <span className="verdict-why" title={t(`量測於版本 ${version}\n${full}`, `Measured on version ${version}\n${full}`)}>
        {t(`版本 ${version} 之後程式碼改過`, `code changed after version ${version}`)}
      </span>
    </span>
  ) : (
    <span className="verdict-version" title={t(`量測於這個程式版本\n${full}`, `Measured on this code version\n${full}`)}>
      {t(`版本 ${version}`, `version ${version}`)}
    </span>
  );
}

const routeLabel = (t: ReturnType<typeof useT>, to: string) => ({ done: t('完成', 'done'), implementer: t('交回實作者', 'back to the implementer'), planner: t('交回計畫者', 'back to the planner'), adjudicate: t('交付裁定', 'to adjudication'), user: t('交給你', 'to you') })[to] ?? to;

function Responses({ round }: { round: Round }) {
  const t = useT();
  const rs = round.submission?.responses;
  if (!rs?.length) return null;
  // An id that is not a review issue of the round (e.g. a GitHub thread) counts as nothing, whatever action it was sent with.
  const kind = (r: IssueResponse) => (r.unmatched ? 'unmatched' : r.action);
  const label = (a: string) => (a === 'fixed' ? t('已修正', 'Fixed') : a === 'rebutted' ? t('反駁', 'Rebutted') : a === 'unmatched' ? t('非本輪問題', 'Not an issue here') : t('未分類', 'Unclassified'));
  const counts = (['fixed', 'rebutted', 'unclassified', 'unmatched'] as const).map((a) => [a, rs.filter((r) => kind(r) === a).length] as const).filter(([, n]) => n);
  return (
    <div className="block">
      <div className="block-label">
        {t('對審查意見的回應', 'Responses to review')} · {counts.map(([a, n]) => `${label(a)} ${n}`).join(t('、', ', '))}
      </div>
      {rs.map((r, i) => (
        <div key={`${r.issue_id}-${i}`} className="resp">
          <span className={cx('state-word', kind(r) === 'fixed' ? 'ok' : 'warn')}>{label(kind(r))}</span>
          <b>{r.issue_id}</b>{' '}
          {r.unmatched ? (
            <span className="muted">
              {t(`這一輪沒有這個審查問題，作者送出「${r.action === 'unclassified' ? r.given || '無' : label(r.action)}」，不計入`, `Not a review issue of this round; sent as "${r.action === 'unclassified' ? r.given || 'none' : label(r.action)}", not counted`)}{' '}
            </span>
          ) : (
            r.action === 'unclassified' && <span className="muted">{r.given ? t(`作者寫的是「${r.given}」，既不是已修正也不是反駁`, `The author wrote "${r.given}": neither fixed nor rebutted`) : t('作者沒有寫處理方式', 'The author gave no action')} </span>
          )}
          {r.conflict && <span className="state-word warn">{t(`與待決事項 ${r.conflict} 矛盾`, `Conflicts with ${r.conflict}`)}</span>}
          <span className="muted">{r.note}</span>
        </div>
      ))}
    </div>
  );
}

/** Points the author left for the user: every side with its source, open until the user decides. */
function OpenDecisions({ round }: { round: Round }) {
  const t = useT();
  const ds = round.submission?.openDecisions;
  if (!ds?.length) return null;
  const open = ds.filter((d) => d.status !== 'decided').length;
  return (
    <div className="block">
      <div className="block-label">
        {t('待你決定', 'For you to decide')}
        {t('（', ' (')}
        {[open && `${t('待決定', 'Open')} ${open}`, ds.length - open && `${t('已決定', 'Decided')} ${ds.length - open}`].filter(Boolean).join(t('・', ', '))}
        {t('）', ')')}
      </div>
      {ds.map((d, i) => (
        <div key={`${d.id}-${i}`} className="resp resp-decision">
          <span className={cx('state-word', d.status === 'decided' ? 'ok' : 'warn')}>{d.status === 'decided' ? t('已決定', 'Decided') : t('待決定', 'Open')}</span>
          <b>{d.id}</b> {d.question}
          {d.status === 'decided' && (
            <div className="muted">
              {t(`由 ${d.decidedBy} 決定：`, `Decided by ${d.decidedBy}: `)}
              {d.decision} ({d.decisionSource})
            </div>
          )}
          {d.proposal && <div className="muted">{t(`作者的提議（不是決定）：${d.proposal}`, `The author's proposal (not a decision): ${d.proposal}`)}</div>}
          {d.positions.map((p, i) => (
            <div key={i} className="muted">
              <b>{p.by}</b>: {p.view}
              {p.source ? ` (${p.source})` : ''}
            </div>
          ))}
          {d.sources.length > 0 && <div className="muted">{t('來源', 'Sources')}: {d.sources.join('; ')}</div>}
        </div>
      ))}
    </div>
  );
}

/** Issues as a list: id, severity word (its colour), title, outside the change or not, where; the detail under it. */
function IssueList({ issues }: { issues: ReviewIssue[] }) {
  const t = useT();
  if (!issues.length) return null;
  const sev = (s: ReviewIssue['severity']) => (s === 'blocker' ? t('嚴重', 'Blocker') : s === 'major' ? t('重要', 'Major') : t('次要', 'Minor'));
  return (
    <ul className="issues">
      {issues.map((i) => (
        <li key={i.id} className={cx('issue', i.severity)}>
          <div className="issue-line">
            <span className="issue-id">{i.id}</span>
            <span className={cx('sev', i.severity)}>{sev(i.severity)}</span>
            <span className="issue-title">{i.title}</span>
            {i.preExisting && <span className="issue-loc">{t('既有問題', 'pre-existing')}</span>}
            {i.location && <span className="issue-loc">{i.location}</span>}
          </div>
          {i.detail && <div className="issue-detail">{i.detail}</div>}
        </li>
      ))}
    </ul>
  );
}

/**
 * A review's or verification's conclusion, in the turn's first line (its one-line summary): the state as an icon and
 * a coloured word — in the words the review report and the progress use (an independent review's approval is
 * 「建議通過」; an incomplete report is no verdict at all, with what it lacks unless the report below lists it) — then the
 * counts (issues in the change, those outside it, points left to validate) and what it was measured on, 「變更後需重驗」
 * with its reason when the code changed since.
 */
function VerdictLine({ run, agent }: { run: WorkflowRun; agent: AgentRunInfo }) {
  const t = useT();
  const round = roundOf(run, agent);
  const v = agent.role === 'verifier' ? round?.verification : undefined;
  const r = agent.role !== 'verifier' ? round?.review : undefined;
  if (v) {
    const met = round?.route?.to === 'done';
    return (
      <div className="verdict">
        <span className={cx('state-word', met && v.outcome === 'met' ? 'ok' : 'warn')}>
          <Ico i={met ? CircleCheck : Undo2} size={14} /> {met ? t('目標達成', 'Goal met') : outcomeText(t, v)}
        </span>{' '}
        <span className="verdict-more">
          {v.metrics.filter((m) => m.met).length}/{v.metrics.length}
        </span>{' '}
        <Evidence stale={v.stale} evidence={v.evidence} />
      </div>
    );
  }
  if (!r) return null;
  const w = verdictWords(t, r, !!run.config.review);
  if (w.kind === 'incomplete') {
    // The report below (審查報告) lists what it lacks when it is this round's.
    const listedBelow = reviewShown(run) && round === run.stages.implement.rounds.at(-1);
    return (
      <div className="verdict">
        <span className={cx('state-word', VERDICT_CLS.incomplete)}>
          <Ico i={VERDICT_ICON.incomplete} size={14} /> {w.label}
        </span>{' '}
        {!listedBelow && <span className="verdict-why">{r.incomplete!.join(t('、', ', '))}</span>}
      </div>
    );
  }
  const more = [w.count, w.before, r.needsValidation?.length ? t(`${r.needsValidation.length} 項待驗證`, `${r.needsValidation.length} to validate`) : ''].filter(Boolean);
  return (
    <div className="verdict">
      <span className={cx('state-word', VERDICT_CLS[w.kind])}>
        <Ico i={VERDICT_ICON[w.kind]} size={14} /> {w.label}
      </span>{' '}
      {more.length > 0 && <span className="verdict-more">{more.join(' · ')}</span>}{' '}
      <Evidence stale={r.stale} evidence={r.evidence} />
    </div>
  );
}

/** Whether a turn's first line is its verdict (a review or a verification it handed in). */
function hasVerdict(run: WorkflowRun, agent: AgentRunInfo): boolean {
  const round = roundOf(run, agent);
  if (round?.reviewerAgentId !== agent.id) return false;
  return agent.role === 'verifier' ? !!round.verification : (agent.role === 'plan_reviewer' || agent.role === 'code_reviewer') && !!round.review;
}

/** The structured outcome of an agent turn: plan, review, verification, or work summary. The verdict is its first line. */
function Outcome({ run, agent, lastMessage }: { run: WorkflowRun; agent: AgentRunInfo; lastMessage?: string }) {
  const t = useT();
  const [showPlan, setShowPlan] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const round = roundOf(run, agent);
  const done = agent.status !== 'running' && agent.status !== 'queued';
  const isAuthor = round?.authorAgentId === agent.id;
  const isReviewer = round?.reviewerAgentId === agent.id;

  if (agent.role === 'planner' && isAuthor && round?.submission?.plan) {
    const plan = round.submission.plan;
    return (
      <>
        <Responses round={round} />
        <OpenDecisions round={round} />
        <div className="block plan">
          <Markdown className="prose" text={plan.summary} />
          {plan.steps.length > 0 && (
            <ol className="plan-steps">
              {plan.steps.map((s) => (
                <li key={s.id}>
                  <span className="muted">{s.id}.</span> {s.title}
                </li>
              ))}
            </ol>
          )}
          <CopyRow text={plan.markdown?.trim() || plan.summary} label={t('複製計畫', 'Copy plan')}>
            <FoldButton open={showPlan} onToggle={() => setShowPlan(!showPlan)}>
              {t('完整計畫', 'Full plan')}
            </FoldButton>
          </CopyRow>
          {showPlan && <Markdown className="doc" text={plan.markdown} />}
        </div>
      </>
    );
  }

  if (agent.role === 'verifier' && isReviewer && round?.verification) {
    const v = round.verification;
    return (
      <div className="block">
        {v.summary && <Markdown className="prose" text={v.summary} />}
        <ul className="metrics">
          {v.metrics.map((m) => (
            <li key={m.id} className={cx('metric', m.met ? 'ok' : 'no')}>
              <div className="metric-head">
                <Ico i={m.met ? CircleCheck : CircleX} size={14} className="metric-icon" />
                <span className="mono">{m.id}</span>
                <span className="metric-name">{run.plan?.goal?.metrics.find((x) => x.id === m.id)?.name ?? ''}</span>
              </div>
              <div className="metric-value small">{m.value}</div>
              {m.evidence && <div className="metric-evidence muted tiny mono">{m.evidence}</div>}
            </li>
          ))}
        </ul>
        <IssueList issues={v.issues} />
        {round.route && round.route.to !== 'done' && <div className="route small"><Ico i={CornerDownRight} size={14} /> {routeLabel(t, round.route.to)}{t('：', ': ')}{round.route.reason}</div>}
        {v.summary && <CopyRow text={v.summary} label={t('複製回覆', 'Copy reply')} />}
      </div>
    );
  }

  if (agent.role === 'adjudicator') {
    const mine = (run.rulings ?? []).filter((r) => r.by === agent.id);
    if (!mine.length) return null;
    return (
      <div className="block">
        <div className="block-label">{t('裁定', 'Rulings')}</div>
        {mine.map((r) => (
          <div key={r.issueId} className="resp">
            <span className={cx('state-word', r.ruling.startsWith('uphold') ? 'warn' : 'ok')}>{r.ruling.startsWith('uphold') ? t('維持', 'Upheld') : t('駁回', 'Dismissed')}</span>
            <b>{r.issueId}</b> <span className="muted">{r.ruling.replace(/^(uphold|dismiss):\s*/, '')}</span>
          </div>
        ))}
      </div>
    );
  }

  if ((agent.role === 'plan_reviewer' || agent.role === 'code_reviewer') && isReviewer && round?.review) {
    const r = round.review;
    // An independent review's report is drawn in full below (審查報告): here it folds, the verdict line stays.
    const inReport = !!run.config.review && reviewShown(run) && round === run.stages.implement.rounds.at(-1);
    const body = (
      <>
        {r.summary && <Markdown className="prose" text={r.summary} />}
        <IssueList issues={r.issues} />
        {/* Not confirmed, no severity, never sends the work back; older reviews have none. */}
        {(r.needsValidation?.length ?? 0) > 0 && (
          <div className="needs-validation">
            <div className="block-label">
              {t('待驗證', 'Needs validation')} <span className="block-hint">{t('未確認的疑點，不分嚴重度，不會要求修改', 'not confirmed, no severity, does not ask for changes')}</span>
            </div>
            <ul className="issues">
              {r.needsValidation!.map((n) => (
                <li key={n.id} className="issue nv">
                  <div className="issue-line">
                    <span className="issue-id">{n.id}</span>
                    <span className="issue-title">{n.title}</span>
                    {n.location && <span className="issue-loc">{n.location}</span>}
                  </div>
                  {n.missing && (
                    <div className="issue-detail">
                      {t('缺少的證據：', 'Missing evidence: ')}
                      {n.missing}
                    </div>
                  )}
                  {n.how && (
                    <div className="issue-detail">
                      {t('如何安全確認：', 'How to confirm safely: ')}
                      {n.how}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {round.route && <div className="route small"><Ico i={CornerDownRight} size={14} /> {routeLabel(t, round.route.to)}{t('：', ': ')}{round.route.reason}</div>}
      </>
    );
    return (
      <div className="block review">
        {!inReport && body}
        {/* The whole review: verdict, summary, issues with why they block, decisions left to it, what it rests on. */}
        <CopyRow text={() => reviewMarkdown(t, r, run.config.review ? run.reviewTarget : undefined)} label={t('複製審查報告', 'Copy review report')}>
          {inReport && (
            <FoldButton open={showReview} onToggle={() => setShowReview(!showReview)}>
              {t('審查內容 · 與下方的審查報告相同', 'The review · the same as the report below')}
            </FoldButton>
          )}
        </CopyRow>
        {inReport && showReview && body}
      </div>
    );
  }

  if (agent.role === 'executor') {
    // The plan's steps are listed once, in the progress panel. Once the workflow is done the final result is where the
    // outcome is read (deliverables, every check): the card keeps its one line, the summary moves to its activity log.
    const final = run.status === 'completed';
    return (
      <>
        {round && <Responses round={round} />}
        {round && <OpenDecisions round={round} />}
        {done && isAuthor && !final && round?.submission?.summary && (
          <div className="block">
            <div className="block-label">{t('實作摘要', 'Summary')}</div>
            <Clamp height={160}>
              <Markdown className="prose" text={round.submission.summary} />
            </Clamp>
            <CopyRow text={round.submission.summary} label={t('複製回覆', 'Copy reply')} />
          </div>
        )}
        {done && isAuthor && !final && <ObservedChecks run={run} checks={round?.submission?.checks} />}
      </>
    );
  }

  if (agent.role === 'subagent' || agent.role === 'advisor') {
    return (
      <>
        {/* The transcript usually already ends with this text. */}
        {done && agent.finalText && agent.finalText.trim() !== lastMessage?.trim() && (
          <div className="block">
            <Clamp height={140}>
              <Markdown className="prose" text={agent.finalText} />
            </Clamp>
            <CopyRow text={agent.finalText} label={t('複製回覆', 'Copy reply')} />
          </div>
        )}
      </>
    );
  }
  return null;
}

/**
 * A copy button at the end of an agent's text (a quiet text button): the text as written (Markdown), even when it is
 * folded above. `children`: what opens more of that text, at the start of the same line.
 */
function CopyRow({ text, label, children }: { text: string | (() => string); label: string; children?: ReactNode }) {
  return (
    <div className="copy-row">
      {children}
      <CopyButton text={text} label={label} />
    </div>
  );
}

/**
 * Where a turn's time runs to: now while it works or waits; else when it ended — or, when that was not recorded (a run
 * interrupted by a restart), when the workflow did. A turn that is over never keeps counting.
 */
const turnEnd = (run: WorkflowRun, a: AgentRunInfo) => (a.status === 'running' || a.status === 'queued' || a.status === 'paused' ? undefined : (a.endedAt ?? run.endedAt ?? run.updatedAt));

/**
 * When the turn ran and on what, in its activity log (the head keeps only how long it took): its start and end, the
 * model as named and the effort it ran with, the settings of the turn, and its CLI session.
 */
function TurnFacts({ run, agent }: { run: WorkflowRun; agent: AgentRunInfo }) {
  const t = useT();
  const snap = agent.snapshot;
  const took = duration(t, agent.startedAt, turnEnd(run, agent), 1);
  const facts = [
    agent.startedAt ? t(`開始 ${fullTime(agent.startedAt)}`, `Started ${fullTime(agent.startedAt)}`) : '',
    agent.endedAt ? t(`結束 ${fullTime(agent.endedAt)}`, `ended ${fullTime(agent.endedAt)}`) : '',
    took ? t(`耗時 ${took}`, `took ${took}`) : '',
    agent.model ? t(`模型 ${agent.model}${agent.modelDefault ? '，供應商預設' : ''}`, `model ${agent.model}${agent.modelDefault ? ', the provider default' : ''}`) : t('供應商預設模型', 'provider default model'),
    agent.effort ? t(`推理強度 ${agent.effort}`, `effort ${agent.effort}`) : '',
    agent.servedBy?.length ? t(`實際回答的模型 ${agent.servedBy.join('、')}`, `answered by ${agent.servedBy.join(', ')}`) : '',
  ].filter(Boolean);
  return (
    <div className="turn-facts">
      {facts.map((f) => (
        <div key={f}>{f}</div>
      ))}
      {snap && (
        <div>
          {t(
            `這一回合 ${new Date(snap.at).toLocaleTimeString()} 的設定：模型 ${snap.model ?? '預設'}、推理強度 ${snap.effort ?? '預設'}、權限 ${permissionLabel(t, snap.permission ?? 'auto')}、Skill ${snap.skills.length} 個、已收到 ${snap.userMessages} 則中途訊息`,
            `Settings of this turn at ${new Date(snap.at).toLocaleTimeString()}: model ${snap.model ?? 'default'}, effort ${snap.effort ?? 'default'}, permission ${permissionLabel(t, snap.permission ?? 'auto')}, ${snap.skills.length} skills, ${snap.userMessages} mid-run messages received`,
          )}
        </div>
      )}
      {agent.sessionId && (
        <div>
          {t('工作階段', 'Session')} <span className="mono">{agent.sessionId}</span>
          {agent.resumed && (
            <>
              {' · '}
              <Ico i={RotateCw} size={12} /> {t('接續先前的對話', 'resumed session')}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The skills it applied or only read, and Graphify, with what each tooltip on the head says, in its activity log. */
function TurnSkills({ agent, read, graphify, codegraph }: { agent: AgentRunInfo; read: string[]; graphify: number; codegraph?: { count: number; tools: string[] } }) {
  const t = useT();
  if (!agent.alwaysOn?.length && !agent.skillUses?.length && !read.length && !graphify && !codegraph?.count) return null;
  return (
    <div className="block">
      <div className="block-label">{t('Skill 與擴充功能', 'Skills and extensions')}</div>
      <ul className="turn-skills small">
        {agent.alwaysOn?.map((a) => (
          <li key={a}>
            <Ico i={Ribbon} size={13} /> {a} <span className="muted">· {t('整個任務都套用', 'applied for the whole task')}</span>
          </li>
        ))}
        {agent.skillUses?.map((u) => (
          <li key={u.name}>
            <Ico i={Wrench} size={13} /> {u.name} <span className={cx('state-word', u.verified ? 'ok' : 'warn')}>{u.verified ? t('已套用並驗證', 'applied and verified') : t('已套用，尚未驗證', 'applied, not verified yet')}</span>
            {[`${t('原因', 'Why')}：${u.reason}`, u.deliverables && `${t('產出', 'Produced')}：${u.deliverables}`, u.verification && `${t('驗證', 'Checked by')}：${u.verification}`, u.version && `${t('版本', 'Version')} ${u.version}`]
              .filter(Boolean)
              .map((x) => (
                <div key={x as string} className="muted">
                  {x}
                </div>
              ))}
          </li>
        ))}
        {read.length > 0 && (
          <li>
            <Ico i={BookOpen} size={13} /> {read.join('、')} <span className="muted">· {t('只讀了，沒有回報套用，只讀不算遵循', 'read but not reported as applied: reading is not following')}</span>
          </li>
        )}
        {graphify > 0 && (
          <li>
            <Ico i={Network} size={13} /> {t(`執行了 ${graphify} 次 graphify 指令`, `Ran graphify ${graphify} times`)}
          </li>
        )}
        {!!codegraph?.count && (
          <li>
            <Ico i={Braces} size={13} /> {t(`查了 ${codegraph.count} 次 CodeGraph`, `Looked things up in CodeGraph ${codegraph.count} times`)} <span className="muted">· {codegraph.tools.join(t('、', ', '))}</span>
          </li>
        )}
      </ul>
    </div>
  );
}

/**
 * The evidence behind a turn, in its activity log: the checks Aivenue saw, the files, the round's hand-off and the
 * submission as it came in (the main line shows it parsed).
 */
function TurnDetails({ run, agent }: { run: WorkflowRun; agent: AgentRunInfo }) {
  const t = useT();
  const round = roundOf(run, agent);
  const isAuthor = round?.authorAgentId === agent.id;
  const isReviewer = round?.reviewerAgentId === agent.id;
  const submitted = isAuthor ? round?.submission : isReviewer ? (round?.review ?? round?.verification) : undefined;
  return (
    <>
      {isAuthor && agent.role === 'executor' && run.status === 'completed' && round?.submission?.summary && (
        <div className="block">
          <div className="block-label">
            {t('實作摘要', 'Summary')} <span className="block-hint">{t('agent 自述', "the agent's own account")}</span>
          </div>
          <Markdown className="prose" text={round.submission.summary} />
        </div>
      )}
      {isAuthor && agent.role === 'executor' && <ObservedChecks run={run} checks={round?.submission?.checks} />}
      {(agent.stats.filesChanged.length > 0 || (agent.stats.filesMaybeChanged?.length ?? 0) > 0) && (
        <div className="block">
          <div className="block-label">
            {t('改過的檔案', 'Files changed')} <span className="block-hint">{t('只算編輯工具的改動，終端指令寫入的見結果下方的「檔案」', 'edit-tool changes only; files written by terminal commands are under Files below the result')}</span>
          </div>
          <Files files={agent.stats.filesChanged} maybe={agent.stats.filesMaybeChanged} />
        </div>
      )}
      {isReviewer && round?.handoff && <HandoffBlock h={round.handoff} />}
      {submitted && (
        <details className="raw-submission">
          <summary>
            <Ico i={ChevronRight} size={14} className="fold-chev" /> {t('原始提交資料', 'Submission as received')}
          </summary>
          <pre>{JSON.stringify(submitted, null, 2)}</pre>
        </details>
      )}
    </>
  );
}

/** Notes this agent shared with the others (`post_note`): one line each, a button that opens the full text. */
function Notes({ run, agentId, against }: { run: WorkflowRun; agentId: string; against: string[] }) {
  const t = useT();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const notes = (run.notes ?? []).filter((n) => n.agentId === agentId);
  if (!notes.length) return null;
  return (
    <div className="notes">
      {notes.map((n) => {
        const shown = open.has(n.id);
        // The agent's hand-off for whoever takes over: labelled as such, without the prefix the models read.
        const handoff = /^HAND-OFF\b/.test(n.text);
        const text = handoff ? n.text.replace(/^HAND-OFF \([^)]*\):\s*/, '') : n.text;
        // A note that repeats the result shown in this card adds nothing on screen (agents still get it).
        const same = against.some((x) => x && similar(text, x));
        return (
          <div key={n.id} className={cx('note-line', shown && 'open')}>
            <button
              type="button"
              className="note-toggle"
              aria-expanded={shown}
              title={handoff ? t('這個 agent 寫給接手者的交接：下一個 agent 讀這份，而不是它的整段對話', "This agent's hand-off: the next agent reads this instead of its whole conversation") : t('分享給後面所有 agent 的筆記', 'Shared with every later agent')}
              onClick={() => setOpen((s) => new Set(s.has(n.id) ? [...s].filter((x) => x !== n.id) : [...s, n.id]))}
            >
              <Ico i={handoff ? Handshake : Pin} size={14} className="note-pin" />
              {handoff ? <span className="state-word">{t('交接', 'Hand-off')}</span> : NOTE_KIND(t, n.kind) && <span className={cx('state-word', n.kind === 'fact' ? 'ok' : n.kind === 'decision' ? '' : 'warn')}>{NOTE_KIND(t, n.kind)}</span>}
              <span className="note-text">{shown ? text : same ? t('筆記，與這張卡片的結果相同', "Note, the same as this card's result") : text}</span>
            </button>
            {shown && !handoff && <RememberButton runId={run.id} text={text} noteId={n.id} ts={n.ts} />}
          </div>
        );
      })}
    </div>
  );
}

type Shot = NonNullable<WorkflowRun['screenshots']>[number];

/**
 * Screenshots this agent took with `capture_screenshot`: each a button that enlarges it. The enlarged one keeps the
 * focus while open (Tab does not move behind it); a click, Enter, Space or Esc closes it and the focus goes back to the
 * thumbnail that opened it.
 */
function Screenshots({ run, agentId }: { run: WorkflowRun; agentId: string }) {
  const t = useT();
  const [open, setOpen] = useState<{ shot: Shot; from: HTMLElement | null }>();
  const shots = (run.screenshots ?? []).filter((s) => s.agentId === agentId);
  if (!shots.length) return null;
  const close = () => {
    open?.from?.focus();
    setOpen(undefined);
  };
  return (
    <div className="shots">
      {shots.map((s) => (
        <figure key={s.path} className="shot">
          <button type="button" className="shot-open" onClick={(e) => setOpen({ shot: s, from: e.currentTarget })} aria-label={t(`放大截圖：${s.url}`, `Enlarge the screenshot: ${s.url}`)}>
            <img src={fileUrl(s.path)} alt={s.url} loading="lazy" />
          </button>
          <figcaption>
            <span className="shot-url" title={s.url}>
              {/^file:/i.test(s.url) ? decodeURIComponent(s.url.split('/').pop() ?? s.url) : s.url.replace(/^https?:\/\//, '')}
            </span>
            <span className="muted">
              {s.width}×{s.height}
            </span>
          </figcaption>
        </figure>
      ))}
      {open && (
        <button
          type="button"
          className="lightbox"
          autoFocus
          onClick={close}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            else if (e.key === 'Tab') e.preventDefault();
          }}
          aria-label={t(`關閉放大的截圖：${open.shot.url}`, `Close the enlarged screenshot: ${open.shot.url}`)}
        >
          <img src={fileUrl(open.shot.path)} alt={open.shot.url} />
        </button>
      )}
    </div>
  );
}

/** Files an edit went through, then (marked) files whose every edit failed: they may or may not have changed. */
function Files({ files, maybe = [] }: { files: string[]; maybe?: string[] }) {
  const t = useT();
  if (!files.length && !maybe.length) return null;
  const tip = t('編輯失敗：可能有改動，也可能沒有，請確認', 'The edit failed: it may or may not have changed; check it');
  return (
    <div className="files">
      {files.map((f) => (
        <span key={f} className="file">
          {f}
        </span>
      ))}
      {maybe.map((f) => (
        <span key={f} className="file maybe" title={tip}>
          {f} · {t('可能改動', 'possibly changed')}
        </span>
      ))}
    </div>
  );
}

/**
 * The checks Aivenue itself saw run when the work was submitted — apart from the summary, which is the author's own
 * account: passed, failed, its output reports a failure, ran within a longer command, and re-verify after a change.
 * Shown only for submissions recorded with it (older ones have no `checks`).
 */
function ObservedChecks({ run, checks }: { run: WorkflowRun; checks?: ObservedCheck[] }) {
  const t = useT();
  if (!checks) return null;
  return (
    <div className="block">
      <div className="block-label">
        {t('Aivenue 看到的檢查', 'Checks Aivenue saw run')} <span className="block-hint">{t('提交時看到的，不是 agent 自述', "at submission, not the agent's own account")}</span>
      </div>
      {checks.length ? (
        <CheckRows checks={checks} />
      ) : (
        <div className="vstate-row">
          <span className="vstate state-word warn">
            <Ico i={CircleDashed} size={14} /> {t('尚未執行檢查', 'No check run')}
          </span>
          <span className="vstate-detail">{t('沒有看到任何檢查執行；摘要裡的「通過」或「完成」是 agent 自述', 'No check was seen running; any "passed" or "done" in the summary is the agent\'s own account')}</span>
        </div>
      )}
    </div>
  );
}

const LIVE_LINES = 6;

/** A turn's state in its head, said only when there is one to say: done is the summary line's to say. */
type TurnState = { cls: string; icon: LucideIcon; label: string; spin?: boolean };

export function AgentTurn({ run, agent, providers }: { run: WorkflowRun; agent: AgentRunInfo; providers: ProviderInfo[] }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [raw, setRaw] = useState(false);
  const events = useAgentEvents(run.id, agent.id);
  const name = providerName(providers, agent.provider);
  const running = agent.status === 'running' || agent.status === 'queued';
  const allChildren = Object.values(run.agents)
    .filter((a) => a.parentId === agent.id)
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const steps = visible(events, false);
  const ext = useMemo(() => extensionSummary(events), [events]);
  const counts = useMemo(() => activityCounts(events), [events]);
  const said = (run.userMessages ?? []).filter((m) => saidOwner(run, m.ts) === agent.id);
  const [showClosed, setShowClosed] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const rework = reworkLine(t, run, agent);
  const mine = (run.approvals ?? []).filter((a) => a.agentId === agent.id);
  const now = liveLine(agent, events, mine.length, run.status === 'paused');
  const noteCount = (run.notes ?? []).filter((n) => n.agentId === agent.id).length;
  const internalCount = new Set(events.filter(isInternal).map((e) => e.seq)).size;
  const live = run.status === 'running' || run.status === 'paused' || run.status === 'waiting_human';
  const act = (method: 'agents.stop' | 'agents.close' | 'agents.rerun') => hub.call(method, { workflowId: run.id, agentId: agent.id }).catch((e) => alert((e as Error).message));
  const parentLive = !agent.parentId || ['running', 'paused', 'queued'].includes(run.agents[agent.parentId]?.status ?? '');
  const snap = agent.snapshot;
  const snapText = snap
    ? t(
        `這一回合 ${new Date(snap.at).toLocaleTimeString()} 的設定：模型 ${snap.model ?? '預設'}、推理強度 ${snap.effort ?? '預設'}、權限 ${permissionLabel(t, snap.permission ?? 'auto')}、Skill ${snap.skills.length} 個、已收到 ${snap.userMessages} 則中途訊息`,
        `Settings of this turn (${new Date(snap.at).toLocaleTimeString()}): model ${snap.model ?? 'default'}, effort ${snap.effort ?? 'default'}, permission ${permissionLabel(t, snap.permission ?? 'auto')}, ${snap.skills.length} skills, ${snap.userMessages} mid-run messages received`,
      )
    : undefined;
  const skillsRead = ext.skills.filter((n) => !agent.skillUses?.some((u) => u.name === n));
  // What changed since this turn started, and messages that have not reached it.
  const cfg = run.config;
  const roleCfg =
    { planner: cfg.plan.author, plan_reviewer: cfg.plan.reviewer, executor: cfg.implement.author, code_reviewer: cfg.implement.reviewer, verifier: cfg.verify?.by === 'independent' ? cfg.verify.verifier : cfg.plan.author }[agent.role as string] ?? undefined;
  const outdated = snap
    ? [
        roleCfg?.model && roleCfg.model !== snap.model && !snap.model?.endsWith(`/${roleCfg.model}`) && t('模型', 'model'),
        roleCfg?.effort && roleCfg.effort !== snap.effort && t('推理強度', 'effort'),
        (cfg.permission ?? 'auto') !== (snap.permission ?? 'auto') && t('權限', 'permission'),
        roleCfg && roleCfg.provider !== agent.provider && t('供應商', 'provider'),
      ].filter((x): x is string => !!x)
    : [];
  const unread = (run.userMessages ?? []).filter((m) => m.ts > (agent.startedAt ?? 0) && !m.deliveredTo?.includes(agent.id)).length;

  // 「第 N 輪」 only when its stage went more than one round.
  const stage = agent.stage === 'verify' ? run.stages.verify : agent.stage ? run.stages[agent.stage] : undefined;
  const roundText = agent.round && agent.role !== 'subagent' && agent.role !== 'advisor' && (stage?.rounds.length ?? 0) > 1 ? ` ${t(`第 ${agent.round} 輪`, `round ${agent.round}`)}` : '';
  // How long it took, from ten seconds up (the clock times are its tooltip and in its activity log); a turn that is over
  // counts to its end, never on to now.
  const end = turnEnd(run, agent) ?? Date.now();
  const took = duration(t, agent.startedAt, end);
  const tookS = agent.startedAt ? Math.max(0, Math.round((end - agent.startedAt) / 1000)) : undefined;
  const tookIso = tookS !== undefined ? `PT${tookS}S` : undefined;
  const when = agent.startedAt ? (agent.endedAt ? t(`開始 ${fullTime(agent.startedAt)}，結束 ${fullTime(agent.endedAt)}`, `Started ${fullTime(agent.startedAt)}, ended ${fullTime(agent.endedAt)}`) : t(`開始 ${fullTime(agent.startedAt)}`, `Started ${fullTime(agent.startedAt)}`)) : undefined;
  // Asked you a question (ask_user) and waits for the answer: Aivenue holds its turn (paused) until you answer below.
  const asking = run.status === 'waiting_human' && !!run.pending?.question && (agent.status === 'paused' || (now?.kind === 'tool' && now.calls.some((e) => e.tool?.category === 'hub' && /ask_user$/.test(e.tool.name))));
  // Its state, coloured, only while it is not plainly done: running, waiting (an approval, your answer, a condition),
  // failed, stopped; paused and queued (not started yet) in grey, as the header says paused. A finished turn's first
  // line says how it ended.
  const state: TurnState | undefined =
    agent.status === 'failed'
      ? { cls: 'err', icon: CircleX, label: [t('失敗', 'Failed'), agent.failure && failureLabel(t, agent.failure.kind)].filter(Boolean).join(' · ') }
      : agent.status === 'cancelled'
        ? { cls: 'warn', icon: CircleStop, label: t('已停止', 'Stopped') }
        : asking
          ? { cls: 'warn', icon: MessageCircleQuestionMark, label: waitWord(t, 'question') }
          : now?.kind === 'paused'
            ? { cls: 'muted', icon: Pause, label: t('已暫停', 'Paused') }
            : now?.kind === 'approval'
              ? { cls: 'warn', icon: Hand, label: waitWord(t, 'approval') }
              : now?.kind === 'waiting'
                ? { cls: 'warn', icon: Hourglass, label: t('等待中', 'Waiting') }
                : agent.status === 'queued'
                  ? { cls: 'muted', icon: CircleDashed, label: t('排隊中', 'Queued') }
                  : running
                    ? { cls: 'run', icon: LoaderCircle, label: t('執行中', 'Running'), spin: true }
                    : undefined;
  // The one-line result, without what the head or the error line below already say (failed / stopped; no result, which
  // the error line of a failed turn says — a stopped turn has none, so it keeps it).
  const summary = turnSummary(t, run, agent).filter((s, i) => !(i === 0 && (agent.status === 'failed' || agent.status === 'cancelled')) && !(agent.status === 'failed' && agent.error && agent.endedWithoutResult && s === t('沒有交出結果', 'no result handed in')));
  const verdict = !running && hasVerdict(run, agent);
  // The one-line result shows its first two parts (how it ended, its checks); the rest (the files changed) is in its
  // tooltip, with what 「改了」 counts.
  const shown = summary.slice(0, 2);
  const fileWords = t(`改了 ${agent.stats.filesChanged.length} 個檔案`, `${agent.stats.filesChanged.length} file(s) changed`);
  const summaryTitle = [...summary.slice(2), agent.stats.filesChanged.length ? t('「改了」只算編輯工具的改動，終端指令寫入的見結果下方的「檔案」', '"Changed" counts edit-tool changes only; files written by terminal commands are under Files below the result') : ''].filter(Boolean).join('\n');
  // What it did, as the closed activity log says it, after its name ("活動紀錄 · 讀 3 個檔案、執行 2 個指令"). The files
  // its edit tool changed are said once: by the one-line result when it shows them, else here.
  const filesSaid = !running && !verdict && agent.stats.filesChanged.length > 0 && shown.includes(fileWords);
  const activity = activityLabel(t, { ...counts, write: filesSaid ? 0 : agent.stats.filesChanged.length || counts.write }, noteCount);
  const sub = agent.role === 'subagent' || agent.role === 'advisor';

  return (
    <div data-agent-id={agent.id} className={cx('turn', sub && 'sub', agent.role === 'advisor' && 'advisor', running && 'live')}>
      <div className="turn-head">
        {/* Who and in what role (round D: two parts, one 「·」); the model, what actually answered and the effort are in
            its tooltip and, with the clock times, in the activity log. */}
        <h3
          className="turn-id"
          title={[
            agent.model ? `${agent.modelDefault ? t('預設模型：', 'Default model: ') : t('模型：', 'Model: ')}${agent.model}` : t('供應商預設模型', 'Provider default model'),
            agent.servedBy?.length ? t(`實際回答的模型：${agent.servedBy.join('、')}`, `Models that actually answered: ${agent.servedBy.join(', ')}`) : '',
            agent.effort ? t(`推理強度 ${agent.effort}`, `effort ${agent.effort}`) : '',
            snapText,
          ]
            .filter(Boolean)
            .join('\n')}
        >
          <span className="turn-who">{name}</span>{' '}
          <span className="turn-role">
            {roleLabel(t, agent.role)}
            {roundText}
          </span>
        </h3>
        <span className="turn-meta" data-took-s={tookS}>
          {running && unread > 0 && (
            <span className="state-word warn" title={t('你送出的訊息還沒送到這個 agent', 'Your message has not reached this agent yet')}>
              {t(`${unread} 則訊息未送達`, `${unread} message(s) not delivered`)}
            </span>
          )}
          {agent.handoff && (
            <span className="state-word" title={agent.handoff}>
              {t('已交接', 'handed off')}
            </span>
          )}
          {/* A failure it is recovering from (rate limit, network…): what kind, while it is not over. */}
          {agent.failure && agent.status !== 'completed' && agent.status !== 'failed' && (
            <span className="state-word warn" title={`${agent.failure.message}\n${agent.failure.action}`}>
              {failureLabel(t, agent.failure.kind)}
            </span>
          )}
          {state && (
            <span className={cx('state-word', state.cls)} title={agent.failure && agent.status === 'failed' ? `${agent.failure.message}\n${agent.failure.action}` : undefined}>
              <Ico i={state.icon} size={14} className={state.spin ? 'spin' : undefined} /> {state.label}
            </span>
          )}
          {took && (
            <time className="turn-time" dateTime={tookIso} title={when}>
              {took}
            </time>
          )}
          {live && agent.role !== 'compactor' && (
            <span className="turn-actions">
              {running && (
                <button className="icon-btn tiny" title={t('停止這個 agent', 'Stop this agent')} onClick={() => act('agents.stop')} aria-label={t('停止這個 agent', 'Stop this agent')}>
                  <Ico i={Square} size={13} />
                </button>
              )}
              {((agent.role === 'subagent' && parentLive) || (agent.role !== 'subagent' && agent.role !== 'advisor' && running)) && (
                <button className="icon-btn tiny" title={agent.role === 'subagent' ? t('用同樣的任務重跑，上層 agent 會收到通知', 'Run the same task again; its parent is told') : t('停下並重新派發這個角色', 'Stop and re-dispatch this role')} onClick={() => act('agents.rerun')} aria-label={agent.role === 'subagent' ? t('重跑', 'Run again') : t('重新派發', 'Re-dispatch')}>
                  <Ico i={RotateCw} size={13} />
                </button>
              )}
              {agent.role === 'subagent' && parentLive && <SwitchProvider compact workflowId={run.id} agentId={agent.id} urgent={agent.failure?.kind === 'quota' || agent.failure?.kind === 'rate_limit'} />}
              {agent.role === 'subagent' && !running && (
                <button className="icon-btn tiny" title={t('關閉：從分工圖隱藏，紀錄保留', 'Close: hide from the agent map; records stay')} onClick={() => act('agents.close')} aria-label={t('關閉', 'Close')}>
                  <Ico i={X} size={13} />
                </button>
              )}
            </span>
          )}
        </span>
      </div>
      {/* Skills and Graphify it used: quiet words under the head (what each means, in full, in its activity log). */}
      {(agent.alwaysOn?.length || ext.skills.length || agent.skillUses?.length || ext.graphify > 0 || ext.codegraph > 0) && (
        <div className="turn-ext">
          {agent.alwaysOn?.map((a) => (
            <span key={a} className="ext-chip" title={t(`整個任務都套用：${a}`, `Applied for the whole task: ${a}`)}>
              <Ico i={Ribbon} size={13} /> {a}
            </span>
          ))}
          {agent.skillUses?.map((u) => (
            <span
              key={u.name}
              className={cx('ext-chip', u.verified ? 'ok' : 'warn')}
              title={[
                u.verified ? t('已套用並驗證', 'Applied and verified') : t('已套用，尚未驗證', 'Applied, not verified yet'),
                `${t('原因', 'Why')}：${u.reason}`,
                u.deliverables && `${t('產出', 'Produced')}：${u.deliverables}`,
                u.verification && `${t('驗證', 'Checked by')}：${u.verification}`,
                u.version && `${t('版本', 'Version')} ${u.version}`,
              ]
                .filter(Boolean)
                .join('\n')}
            >
              <Ico i={Wrench} size={13} /> {u.name} {u.verified ? <Ico i={CircleCheck} size={12} label={t('已驗證', 'verified')} /> : t('未驗證', 'not verified')}
            </span>
          ))}
          {skillsRead.length > 0 && (
            <span className="ext-chip muted" title={t(`只讀了，沒有回報套用：${skillsRead.join('、')}。只讀不算遵循。`, `Read but not reported as applied: ${skillsRead.join(', ')}. Reading is not following.`)}>
              <Ico i={BookOpen} size={13} /> {skillsRead.length === 1 ? skillsRead[0] : t(`讀了 ${skillsRead.length} 個 Skill`, `read ${skillsRead.length} skills`)}
            </span>
          )}
          {ext.graphify > 0 && (
            <span className="ext-chip" title={t(`執行了 ${ext.graphify} 次 graphify 指令`, `Ran graphify ${ext.graphify} times`)}>
              <Ico i={Network} size={13} /> Graphify × {ext.graphify}
            </span>
          )}
          {ext.codegraph > 0 && (
            <span className="ext-chip" title={t(`查了 ${ext.codegraph} 次 CodeGraph：${ext.codegraphTools.join('、')}`, `Looked things up in CodeGraph ${ext.codegraph} times: ${ext.codegraphTools.join(', ')}`)}>
              <Ico i={Braces} size={13} /> CodeGraph × {ext.codegraph}
            </span>
          )}
        </div>
      )}

      {agent.role === 'subagent' && (
        <div className="turn-task">
          <span className="turn-title">{subTitle(agent)}</span>
          <span className="muted">{agent.readonly ? t(' · 唯讀', ' · read-only') : t(' · 可寫入', ' · can write')}</span>
          {(agent.brief ?? agent.task) !== subTitle(agent) && (
            <FoldButton open={taskOpen} onToggle={() => setTaskOpen(!taskOpen)}>
              {t('任務全文', 'Full task')}
            </FoldButton>
          )}
          {taskOpen && <div className="turn-brief">{agent.brief ?? agent.task}</div>}
        </div>
      )}
      {agent.role === 'advisor' && <div className="turn-task"><Ico i={CircleHelp} size={14} /> {agent.task}</div>}

      <div className="turn-body">
        {/* Why the work came back here when nothing else says it (a goal verification's reason; a review's is the round's heading). */}
        {rework && <div className="turn-rework"><Ico i={Undo2} size={14} /> {rework}</div>}
        {/* Working: what it does now (routine calls folded, failures kept in view). Done: one line on how it ended — a
            review's or verification's verdict in its colour. A failure is said once: by its error line below. */}
        {running ? (
          <LiveFeed events={events} said={said} limit={LIVE_LINES} hideMessages={agent.role === 'compactor'} />
        ) : verdict ? (
          <VerdictLine run={run} agent={agent} />
        ) : (
          shown.length > 0 && (
            <div className="turn-summary" title={summaryTitle || undefined}>
              {shown.join(' · ')}
            </div>
          )
        )}
        {/* What it waits for, in words (its head says that it waits). Your answer, an approval or a pause: its head says
            so and the card or the record line right below says what to do — not said a third time here. */}
        {now?.kind === 'waiting' && (
          <div className="working">
            <Ico i={Hourglass} size={14} className="spark" /> {now.text}
          </div>
        )}
        {now?.kind === 'working' && !events.length && (
          <div className="working">
            <Ico i={LoaderCircle} size={14} className="spark spin" /> {t('啟動中…', 'Starting…')}
          </div>
        )}
        {/* Settings changed after this turn started: said in view, with when they apply. */}
        {running && outdated.length > 0 && (
          <div className="turn-note warn">
            <Ico i={TriangleAlert} size={14} /> {t(`設定未套用：這一回合開始後你改了${outdated.join('、')}，下一回合才會套用；要立刻套用，請在設定裡按「立即重新派發」`, `Settings pending: you changed ${outdated.join(', ')} after this turn started; it applies from the next turn. To apply now, press "Re-dispatch now" in the settings`)}
          </div>
        )}
        {/* An approval this agent waits for: beside its work, not at the bottom of the page. */}
        {mine.length > 0 && <Approvals run={run} providers={providers} agentId={agent.id} />}
        {agent.role !== 'compactor' && <Outcome run={run} agent={agent} lastMessage={events.filter((e) => e.kind === 'message').pop()?.text} />}
        {agent.status === 'failed' && agent.error && <div className="tx-err"><Ico i={CircleX} size={14} /> {agent.error}</div>}
        {agent.failure && agent.status === 'failed' && agent.failure.action && <div className="turn-note muted"><Ico i={CornerDownRight} size={14} /> {agent.failure.action}</div>}
        {/* The details: always here, in the same place, for every card — named (what the checks and files point to) and
            said as what it did. */}
        <div className="turn-foot">
          <button type="button" className="activity-toggle" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
            <Ico i={expanded ? ChevronDown : ChevronRight} size={14} />
            <span className="activity-name">{t('活動紀錄', 'Activity log')}</span>
            {activity && (
              <span className="activity-what" title={!filesSaid && (agent.stats.filesChanged.length || counts.write) ? t('「改了」只算編輯工具的改動', '"Changed" counts edit-tool changes only') : undefined}>
                · {activity}
              </span>
            )}
          </button>
          {expanded && (
            <label className="toggle">
              <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> {t('原始紀錄', 'Raw log')}
            </label>
          )}
        </div>
        {expanded && (
          <div className="turn-details">
            <TurnFacts run={run} agent={agent} />
            {steps.length > 0 || raw ? <Transcript events={events} raw={raw} said={said} /> : <div className="muted small">{t('還沒有紀錄', 'Nothing recorded yet')}</div>}
            {!raw && internalCount + (agent.role !== 'advisor' ? noteCount : 0) > 0 && (
              <details className="internal-log">
                <summary>
                  <Ico i={ChevronRight} size={14} className="fold-chev" /> <span title={t('Aivenue 的紀錄、進度回報、筆記與交接', "Aivenue's records, progress reports, notes and hand-offs")}>{t(`紀錄與交接 · ${internalCount + (agent.role !== 'advisor' ? noteCount : 0)}`, `Records and hand-offs · ${internalCount + (agent.role !== 'advisor' ? noteCount : 0)}`)}</span>
                </summary>
                <Transcript events={events} internal />
                {agent.role !== 'advisor' && <Notes run={run} agentId={agent.id} against={[]} />}
              </details>
            )}
            <Screenshots run={run} agentId={agent.id} />
            <TurnSkills agent={agent} read={skillsRead} graphify={ext.graphify} codegraph={{ count: ext.codegraph, tools: ext.codegraphTools }} />
            <TurnDetails run={run} agent={agent} />
          </div>
        )}
      </div>

      {allChildren.length > 0 && (
        <BatchOverview run={run} parent={agent} items={allChildren.filter((c) => c.role === 'subagent' && (!c.closed || showClosed))} providers={providers} />
      )}
      {allChildren.some((c) => c.role === 'advisor') && (
        <div className="subs">
          {allChildren
            .filter((c) => c.role === 'advisor' && (!c.closed || showClosed))
            .map((c) => (
              <AgentTurn key={c.id} run={run} agent={c} providers={providers} />
            ))}
        </div>
      )}
      {allChildren.some((c) => c.closed) && (
        <button type="button" className="link small" aria-expanded={showClosed} onClick={() => setShowClosed(!showClosed)}>
          {showClosed ? t('隱藏已關閉的子 agent', 'Hide closed sub-agents') : t(`顯示 ${allChildren.filter((c) => c.closed).length} 個已關閉的子 agent`, `Show ${allChildren.filter((c) => c.closed).length} closed sub-agent(s)`)}
        </button>
      )}
    </div>
  );
}

const BATCH_ORDER: BatchState[] = ['blocked', 'running', 'stopped', 'done'];

/**
 * A parent's sub-agents by the work they were given: one row per batch (re-runs joined to it) saying who has it
 * now, how its latest attempt ended, and — when it is stuck — why, with what can be done right there. Every attempt
 * (its time, errors and output) is behind the row.
 */
function BatchOverview({ run, parent, items, providers }: { run: WorkflowRun; parent: AgentRunInfo; items: AgentRunInfo[]; providers: ProviderInfo[] }) {
  const t = useT();
  const list = batchesOf(items, subTitle);
  const counts = batchCounts(list);
  // A few batches: the running ones stay open, so their live activity shows without a click.
  const [open, setOpen] = useState<Set<string>>(() => new Set(list.length <= 3 ? list.filter((b) => b.state === 'running').map((b) => b.key) : []));
  const [showDone, setShowDone] = useState(false);
  if (!list.length) return null;
  const parentLive = ['running', 'paused', 'queued'].includes(parent.status);
  const label: Record<BatchState, string> = { blocked: t('受阻', 'Blocked'), running: t('執行中', 'Running'), stopped: t('已停止', 'Stopped'), done: t('完成', 'Done') };
  const toggle = (k: string) => setOpen((s) => new Set(s.has(k) ? [...s].filter((x) => x !== k) : [...s, k]));
  return (
    <div className="subs batches">
      <div className="batch-head">
        {t('子 agent 批次', 'Sub-agent batches')} ·{' '}
        {BATCH_ORDER.filter((s) => counts[s])
          .map((s) => `${label[s]} ${counts[s]}`)
          .join(t('、', ', '))}
      </div>
      {BATCH_ORDER.map((state) => {
        const rows = list.filter((b) => b.state === state);
        if (!rows.length) return null;
        const folded = state === 'done' && rows.length > 5 && !showDone;
        return (
          <div key={state} className={cx('batch-group', state)}>
            {(folded ? [] : rows).map((b) => (
              <BatchRow key={b.key} run={run} b={b} providers={providers} open={open.has(b.key)} onToggle={() => toggle(b.key)} parentLive={parentLive} />
            ))}
            {state === 'done' && rows.length > 5 && (
              <button className="link small" onClick={() => setShowDone(!showDone)} aria-expanded={showDone}>
                {showDone ? t('收起已完成的批次', 'Hide finished batches') : t(`顯示 ${rows.length} 個已完成的批次`, `Show ${rows.length} finished batches`)}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function BatchRow({ run, b, providers, open, onToggle, parentLive }: { run: WorkflowRun; b: Batch; providers: ProviderInfo[]; open: boolean; onToggle: () => void; parentLive: boolean }) {
  const t = useT();
  const a = b.latest;
  const who = `${providerName(providers, a.provider)}${a.model ? ` · ${modelLabel(a.model)}` : ''}`;
  const icon = { blocked: CircleX, running: LoaderCircle, stopped: CircleStop, done: CircleCheck }[b.state];
  // Only the latest attempt's trouble is a blocker; earlier failures are in the attempts behind the row.
  const why =
    b.state === 'blocked'
      ? [a.failure ? failureLabel(t, a.failure.kind) : a.endedWithoutResult ? t('沒有交出結果', 'no result handed in') : t('失敗', 'failed'), firstLine(readableError(a.failure?.message ?? a.error)).slice(0, 200)].filter(Boolean).join(' · ')
      : b.state === 'running'
        ? run.status === 'paused'
          ? t('已暫停', 'paused')
          : (a.waiting ?? a.activity?.replace(/^\S+\s/, '') ?? t('正在處理', 'working')).slice(0, 160)
        : b.state === 'done'
          ? turnSummary(t, run, a).join(' · ')
          : t('已停止', 'stopped');
  const rerun = () => hub.call('agents.rerun', { workflowId: run.id, agentId: a.id }).catch((e) => alert((e as Error).message));
  return (
    <div className={cx('batch', b.state)}>
      <div className="batch-row">
        <button className="batch-main" onClick={onToggle} aria-expanded={open}>
          <Ico i={icon} size={14} className={cx('batch-icon', b.state, b.state === 'running' && 'spin')} />
          <span className="batch-title">{b.title}</span>
          <span className="batch-who muted">{who}</span>
          {b.attempts.length > 1 && <span className="batch-who muted">{t(`第 ${b.attempts.length} 次嘗試`, `attempt ${b.attempts.length}`)}</span>}
          <span className={cx('batch-why', b.state === 'blocked' && 'bad')}>{why}</span>
        </button>
        {b.state === 'blocked' && parentLive && (
          <span className="batch-actions">
            <button className="btn small" onClick={rerun} title={t('用同樣的任務、同一個模型再試一次，上層 agent 會收到通知', 'Try the same task again with the same model; its parent is told')}>
              <Ico i={RotateCw} size={14} /> {t('重試', 'Retry')}
            </button>
            <SwitchProvider compact workflowId={run.id} agentId={a.id} urgent={a.failure?.kind === 'quota' || a.failure?.kind === 'rate_limit'} />
          </span>
        )}
      </div>
      {/* What to do about it, while something still can be done here; once the work has ended, it is history. */}
      {b.state === 'blocked' && parentLive && a.failure?.action && <div className="batch-next muted small"><Ico i={CornerDownRight} size={14} /> {a.failure.action}</div>}
      {open && (
        <div className="batch-attempts">
          {b.attempts.map((x) => (
            <AgentTurn key={x.id} run={run} agent={x} providers={providers} />
          ))}
        </div>
      )}
    </div>
  );
}
