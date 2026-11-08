import { useMemo, useState } from 'react';
import type { AgentRunInfo, FailureKind, Handoff, IssueResponse, ObservedCheck, ProviderInfo, Round, WorkflowRun } from '../../../core/src/types';
import { fileUrl, hub, useAgentEvents } from '../api';
import { useT } from '../i18n';
import { agentStatus, cx, elapsed, firstLine, saidOwner, modelLabel, providerColor, providerName, roleLabel, roleTone, similar, subTitle } from '../util';
import { Clamp } from './Clamp';
import { SwitchProvider } from './RunTools';
import { LiveFeed, Transcript, visible } from './Transcript';
import { Approvals } from './Safety';
import { batchCounts, batchesOf, isInternal, liveLine, readableError, reworkLine, roundOf, turnSummary, type Batch, type BatchState } from '../timeline';
import { Markdown } from './Markdown';
import { CheckRows } from './Checks';
import { extensionSummary } from '../extensionUse';
import { outcomeText } from './Progress';
import { RememberButton } from './Memory';

export const failureLabel = (t: ReturnType<typeof useT>, k: FailureKind) =>
  ({ rate_limit: t('限流', 'Rate limited'), quota: t('額度用完', 'Out of quota'), network: t('網路', 'Network'), auth: t('登入失效', 'Signed out'), model_service: t('模型服務故障', 'Model service'), logic: t('執行錯誤', 'Task error'), unknown: t('未知錯誤', 'Unknown') })[k];

const NOTE_KIND = (t: ReturnType<typeof useT>, k?: string) => (k === 'fact' ? t('事實', 'Fact') : k === 'decision' ? t('決策', 'Decision') : k === 'inference' ? t('推論', 'Inference') : undefined);

/** A round's hand-off: facts, decisions and open issues, each linking back to where it came from. */
function HandoffBlock({ h }: { h: Handoff }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!h.facts.length && !h.decisions.length && !h.open.length) return null;
  return (
    <div className="block handoff">
      <button className="link" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {t('交接摘要', 'Hand-off')} · {t(`${h.decisions.length} 個決策、${h.open.length} 個未解`, `${h.decisions.length} decisions, ${h.open.length} open`)}
      </button>
      {open && (
        <div className="handoff-body small">
          {h.decisions.map((x, i) => (
            <div key={`d${i}`}>
              <span className="pill ok">{t('決策', 'Decision')}</span> {x}
            </div>
          ))}
          {h.facts.map((x, i) => (
            <div key={`f${i}`}>
              <span className="pill">{t('事實', 'Fact')}</span> {x}
            </div>
          ))}
          {h.open.map((x, i) => (
            <div key={`o${i}`}>
              <span className="pill warn">{t('未解', 'Open')}</span> {x}
            </div>
          ))}
          <div className="muted tiny">{t('證據：', 'Evidence: ')}{h.links.map((l) => (l.issueId ? l.issueId : `${l.label} ${l.agentId?.slice(0, 6) ?? ''}`)).join(' · ')}</div>
        </div>
      )}
    </div>
  );
}

function Stale({ stale, evidence }: { stale?: boolean; evidence?: { commit?: string; treeHash: string; at: number } }) {
  const t = useT();
  if (!evidence) return null;
  const where = `${evidence.commit ? `commit ${evidence.commit} · ` : ''}tree ${evidence.treeHash.slice(0, 8)}`;
  return stale ? (
    <span className="badge warn" title={t(`量測於 ${where}；之後程式碼改過，這份結果要重新驗證`, `Measured on ${where}; the code changed since, so it needs checking again`)}>
      {t('過期', 'stale')}
    </span>
  ) : (
    <span className="badge muted" title={t(`綁定程式版本：${where}`, `Bound to code version ${where}`)}>
      {evidence.commit ?? evidence.treeHash.slice(0, 8)}
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
        {t('對審查意見的回應', 'Responses to review')}
        {t('（', ' (')}
        {counts.map(([a, n]) => `${label(a)} ${n}`).join(t('・', ', '))}
        {t('）', ')')}
      </div>
      {rs.map((r, i) => (
        <div key={`${r.issue_id}-${i}`} className="resp">
          <span className={cx('pill', kind(r) === 'fixed' ? 'ok' : 'warn')}>{label(kind(r))}</span>
          <b>{r.issue_id}</b>{' '}
          {r.unmatched ? (
            <span className="muted">
              {t(`（不是這一輪的審查問題；作者送出「${r.action === 'unclassified' ? r.given || '無' : label(r.action)}」，不計入）`, `(not a review issue of this round; sent as "${r.action === 'unclassified' ? r.given || 'none' : label(r.action)}", not counted)`)}{' '}
            </span>
          ) : (
            r.action === 'unclassified' && <span className="muted">{r.given ? t(`（作者寫的是「${r.given}」，不是已修正或反駁）`, `(the author wrote "${r.given}": neither fixed nor rebutted)`) : t('（作者沒有寫處理方式）', '(the author gave no action)')} </span>
          )}
          {r.conflict && <span className="pill warn">{t(`與待決事項 ${r.conflict} 矛盾`, `Conflicts with ${r.conflict}`)}</span>}
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
          <span className={cx('pill', d.status === 'decided' ? 'ok' : 'warn')}>{d.status === 'decided' ? t('已決定', 'Decided') : t('待決定', 'Open')}</span>
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

/** The structured outcome of an agent turn: plan, review verdict, or work summary. */
function Outcome({ run, agent, lastMessage }: { run: WorkflowRun; agent: AgentRunInfo; lastMessage?: string }) {
  const t = useT();
  const [showPlan, setShowPlan] = useState(false);
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
        <div className="block">
          <div className="block-label">{t('計畫', 'Plan')}</div>
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
          <button className="link" onClick={() => setShowPlan(!showPlan)}>
            {showPlan ? t('收起完整計畫', 'Hide full plan') : t('查看完整計畫', 'View full plan')}
          </button>
          {showPlan && <Markdown className="doc" text={plan.markdown} />}
        </div>
      </>
    );
  }

  if (agent.role === 'verifier' && isReviewer && round?.verification) {
    const v = round.verification;
    return (
      <div className="block">
        <div className={cx('verdict', v.outcome === 'met' && round.route?.to === 'done' ? 'ok' : 'warn')}>
          {round.route?.to === 'done' ? `✓ ${t('目標達成', 'Goal met')}` : `↺ ${outcomeText(t, v)}`} · {v.metrics.filter((m) => m.met).length}/{v.metrics.length} <Stale stale={v.stale} evidence={v.evidence} />
        </div>
        {v.summary && <Markdown className="prose" text={v.summary} />}
        <div className="metrics">
          {v.metrics.map((m) => (
            <div key={m.id} className={cx('metric', m.met ? 'ok' : 'no')}>
              <div className="metric-head">
                <span className="metric-icon">{m.met ? '✓' : '✕'}</span>
                <span className="mono">{m.id}</span>
                <span className="metric-name">{run.plan?.goal?.metrics.find((x) => x.id === m.id)?.name ?? ''}</span>
              </div>
              <div className="metric-value small">{m.value}</div>
              {m.evidence && <div className="metric-evidence muted tiny mono">{m.evidence}</div>}
            </div>
          ))}
        </div>
        {v.issues.map((i) => (
          <div key={i.id} className={cx('issue', i.severity)}>
            <div>
              <span className="issue-id">{i.id}</span>
              {i.title}
              {i.location && <span className="muted"> · {i.location}</span>}
            </div>
            {i.detail && <div className="muted small">{i.detail}</div>}
          </div>
        ))}
        {round.route && round.route.to !== 'done' && <div className="route small">➜ {routeLabel(t, round.route.to)}：{round.route.reason}</div>}
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
            <span className={cx('pill', r.ruling.startsWith('uphold') ? 'warn' : 'ok')}>{r.ruling.startsWith('uphold') ? t('維持', 'Upheld') : t('駁回', 'Dismissed')}</span>
            <b>{r.issueId}</b> <span className="muted">{r.ruling.replace(/^(uphold|dismiss):\s*/, '')}</span>
          </div>
        ))}
      </div>
    );
  }

  if ((agent.role === 'plan_reviewer' || agent.role === 'code_reviewer') && isReviewer && round?.review) {
    const r = round.review;
    return (
      <div className="block">
        <div className={cx('verdict', r.verdict === 'approve' ? 'ok' : 'warn')}>
          {r.verdict === 'approve' ? `✓ ${t('通過', 'Approved')}` : `↺ ${t('需要修改', 'Changes requested')} · ${r.issues.length}`} <Stale stale={r.stale} evidence={r.evidence} />
        </div>
        {r.summary && <Markdown className="prose" text={r.summary} />}
        {r.issues.map((i) => (
          <div key={i.id} className={cx('issue', i.severity)}>
            <div>
              <span className="issue-id">{i.id}</span>
              <span className={cx('sev', i.severity)}>{i.severity === 'blocker' ? t('嚴重', 'Blocker') : i.severity === 'major' ? t('重要', 'Major') : t('次要', 'Minor')}</span>
              {i.title}
              {i.location && <span className="muted"> · {i.location}</span>}
            </div>
            {i.detail && <div className="muted small">{i.detail}</div>}
          </div>
        ))}
        {/* Not confirmed, no severity, never sends the work back; older reviews have none. */}
        {(r.needsValidation?.length ?? 0) > 0 && (
          <div className="needs-validation">
            <div className="block-label">{t('待驗證（未確認，不分嚴重度，不會要求修改）', 'Needs validation (not confirmed, no severity, does not ask for changes)')}</div>
            {r.needsValidation!.map((n) => (
              <div key={n.id} className="issue nv">
                <div>
                  <span className="issue-id">{n.id}</span>
                  {n.title}
                  {n.location && <span className="muted"> · {n.location}</span>}
                </div>
                {n.missing && (
                  <div className="muted small">
                    {t('缺少的證據：', 'Missing evidence: ')}
                    {n.missing}
                  </div>
                )}
                {n.how && (
                  <div className="muted small">
                    {t('如何安全確認：', 'How to confirm safely: ')}
                    {n.how}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {round.route && <div className="route small">➜ {routeLabel(t, round.route.to)}：{round.route.reason}</div>}
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
          </div>
        )}
      </>
    );
  }
  return null;
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
          <div className="block-label">{t('實作摘要（agent 自己的說法）', "Summary (the agent's own account)")}</div>
          <Markdown className="prose" text={round.submission.summary} />
        </div>
      )}
      {isAuthor && agent.role === 'executor' && <ObservedChecks run={run} checks={round?.submission?.checks} />}
      {(agent.stats.filesChanged.length > 0 || (agent.stats.filesMaybeChanged?.length ?? 0) > 0) && (
        <div className="block">
          <div className="block-label">{t('以編輯工具改動的檔案（終端指令寫入的檔案不在這裡，見工作流的「這次產生或修改的檔案」）', "Files edited with the edit tool (files written by terminal commands are not here: see the workflow's files produced or changed)")}</div>
          <Files files={agent.stats.filesChanged} maybe={agent.stats.filesMaybeChanged} />
        </div>
      )}
      {isReviewer && round?.handoff && <HandoffBlock h={round.handoff} />}
      {submitted && (
        <details className="raw-submission">
          <summary>{t('原始提交資料', 'Submission as received')}</summary>
          <pre>{JSON.stringify(submitted, null, 2)}</pre>
        </details>
      )}
    </>
  );
}

/** Notes this agent shared with the others (`post_note`): one line each, the full text on click. */
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
          <div
            key={n.id}
            className={cx('note-line', shown && 'open')}
            title={
              handoff
                ? t('這個 agent 寫給接手者的交接：下一個 agent 讀這份，而不是它的整段對話；點一下展開或收起', "This agent's hand-off: the next agent reads this instead of its whole conversation; click to expand or collapse")
                : t('分享給後面所有 agent 的筆記；點一下展開或收起', 'Shared with every later agent; click to expand or collapse')
            }
            onClick={() => setOpen((s) => new Set(s.has(n.id) ? [...s].filter((x) => x !== n.id) : [...s, n.id]))}
          >
            <span className="note-pin">{handoff ? '🤝' : '📌'}</span>
            {handoff ? <span className="pill">{t('交接', 'Hand-off')}</span> : NOTE_KIND(t, n.kind) && <span className={cx('pill', n.kind === 'fact' ? 'ok' : n.kind === 'decision' ? '' : 'warn')}>{NOTE_KIND(t, n.kind)}</span>}
            <span className="note-text">{shown ? text : same ? t('筆記（與這張卡片的結果相同）', 'Note (same as this card\'s result)') : text}</span>
            {shown && !handoff && <RememberButton runId={run.id} text={text} noteId={n.id} ts={n.ts} />}
          </div>
        );
      })}
    </div>
  );
}

/** Screenshots this agent took with `capture_screenshot`; click to enlarge. */
function Screenshots({ run, agentId }: { run: WorkflowRun; agentId: string }) {
  const t = useT();
  const [open, setOpen] = useState<string>();
  const shots = (run.screenshots ?? []).filter((s) => s.agentId === agentId);
  if (!shots.length) return null;
  return (
    <div className="shots">
      {shots.map((s) => (
        <figure key={s.path} className="shot" onClick={() => setOpen(fileUrl(s.path))} title={t('點一下放大', 'Click to enlarge')}>
          <img src={fileUrl(s.path)} alt={s.url} loading="lazy" />
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
        <div className="lightbox" onClick={() => setOpen(undefined)}>
          <img src={open} alt="" />
        </div>
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
  const label = t('Aivenue 看到的檢查（提交時；不是 agent 的自述）', "Checks Aivenue saw run (at submission; not the agent's own account)");
  return (
    <div className="block">
      <div className="block-label">{label}</div>
      {checks.length ? (
        <CheckRows checks={checks} />
      ) : (
        <span className="ext-chip warn">{t('沒有看到任何檢查執行：摘要裡說的通過或完成，是 agent 自己的說法', "No check seen: any 'passed' or 'done' in the summary is the agent's own account")}</span>
      )}
    </div>
  );
}

const LIVE_LINES = 6;

export function AgentTurn({ run, agent, providers }: { run: WorkflowRun; agent: AgentRunInfo; providers: ProviderInfo[] }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [raw, setRaw] = useState(false);
  const events = useAgentEvents(run.id, agent.id);
  const name = providerName(providers, agent.provider);
  const st = agentStatus(t, agent.status);
  const running = agent.status === 'running' || agent.status === 'queued';
  const allChildren = Object.values(run.agents)
    .filter((a) => a.parentId === agent.id)
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const steps = visible(events, false);
  const ext = useMemo(() => extensionSummary(events), [events]);
  const said = (run.userMessages ?? []).filter((m) => saidOwner(run, m.ts) === agent.id);
  const [showClosed, setShowClosed] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const summary = turnSummary(t, run, agent);
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
        `這一輪的設定（${new Date(snap.at).toLocaleTimeString()}）：模型 ${snap.model ?? '預設'}、思考 ${snap.effort ?? '預設'}、權限 ${snap.permission ?? 'auto'}、技能 ${snap.skills.length} 個、已收到 ${snap.userMessages} 則中途訊息`,
        `Settings of this turn (${new Date(snap.at).toLocaleTimeString()}): model ${snap.model ?? 'default'}, effort ${snap.effort ?? 'default'}, permission ${snap.permission ?? 'auto'}, ${snap.skills.length} skills, ${snap.userMessages} mid-run messages received`,
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
        roleCfg?.effort && roleCfg.effort !== snap.effort && t('思考程度', 'effort'),
        (cfg.permission ?? 'auto') !== (snap.permission ?? 'auto') && t('權限', 'permission'),
        roleCfg && roleCfg.provider !== agent.provider && t('供應商', 'provider'),
      ].filter((x): x is string => !!x)
    : [];
  const unread = (run.userMessages ?? []).filter((m) => m.ts > (agent.startedAt ?? 0) && !m.deliveredTo?.includes(agent.id)).length;

  return (
    <div data-agent-id={agent.id} className={cx('turn', roleTone(agent.role), (agent.role === 'subagent' || agent.role === 'advisor') && 'sub', agent.role === 'advisor' && 'advisor', running && 'live')}>
      <div className="turn-head">
        <span className="mark" style={{ background: providerColor(agent.provider) }} />
        <span className="turn-who">{name}</span>
        <span className="turn-role">
          {roleLabel(t, agent.role)}
          {agent.round && agent.role !== 'subagent' && agent.role !== 'advisor' ? ` · ${t(`第 ${agent.round} 輪`, `round ${agent.round}`)}` : ''}
          {' · '}
          <span className="turn-model" title={[agent.model ? `${agent.modelDefault ? t('預設模型：', 'Default model: ') : ''}${agent.model}` : t('供應商預設模型', 'Provider default model'), snapText].filter(Boolean).join('\n')}>
            {!agent.model ? t('預設模型', 'default model') : agent.modelDefault ? `${t('預設模型', 'default model')} · ${modelLabel(agent.model)}` : modelLabel(agent.model)}
          </span>
          {agent.servedBy?.length ? (
            <span className="turn-served" title={t(`實際回答的模型：${agent.servedBy.join('、')}`, `Models that actually answered: ${agent.servedBy.join(', ')}`)}>
              {' → '}
              {agent.servedBy.join('、')}
            </span>
          ) : null}
          {agent.effort ? ` · ${t('推理', 'effort')} ${agent.effort}` : ''}
        </span>
        {(agent.alwaysOn?.length || ext.skills.length || agent.skillUses?.length || ext.graphify > 0) && (
          <span className="turn-ext">
            {agent.alwaysOn?.map((a) => (
              <span key={a} className="ext-chip" title={t(`整個任務都套用：${a}`, `Applied for the whole task: ${a}`)}>
                🎀 {a}
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
                🧰 {u.name} {u.verified ? '✓' : '…'}
              </span>
            ))}
            {skillsRead.length > 0 && (
              <span className="ext-chip muted" title={t(`只讀了，沒有回報套用：${skillsRead.join('、')}（只讀不算遵循）`, `Read but not reported as applied: ${skillsRead.join(', ')} (reading is not following)`)}>
                📖 {skillsRead.length === 1 ? skillsRead[0] : t(`讀了 ${skillsRead.length} 個技能`, `read ${skillsRead.length} skills`)}
              </span>
            )}
            {ext.graphify > 0 && (
              <span className="ext-chip" title={t(`執行了 ${ext.graphify} 次 graphify 指令`, `Ran graphify ${ext.graphify} times`)}>
                🕸️ Graphify × {ext.graphify}
              </span>
            )}
          </span>
        )}
        <span className="turn-meta">
          {agent.failure && agent.status !== 'completed' && (
            <span className="badge warn" title={`${agent.failure.message}\n${agent.failure.action}`}>
              {failureLabel(t, agent.failure.kind)}
            </span>
          )}
          {running && outdated.length > 0 && (
            <span className="badge warn" title={t(`這個 agent 開始這一回合之後，你改了：${outdated.join('、')}。它下一回合才會套用；要立刻套用，請在設定裡按「立即套用（重新派發）」。`, `You changed ${outdated.join(', ')} after this agent's turn started. It applies from its next turn; to apply now, press "Apply now (re-dispatch)" in the settings.`)}>
              {t('設定未套用', 'settings pending')}
            </span>
          )}
          {running && unread > 0 && <span className="badge warn" title={t('你送出的訊息還沒送到這個 agent', 'Your message has not reached this agent yet')}>{t(`${unread} 則訊息未送達`, `${unread} message(s) not delivered`)}</span>}
          {agent.endedWithoutResult &&<span className="badge warn" title={t('CLI 已經結束，但沒有交出這個角色要交的結果', 'The CLI exited without handing in the result its role must submit')}>{t('程序結束≠完成', 'ended ≠ done')}</span>}
          {agent.handoff && <span className="badge" title={agent.handoff}>{t('已交接', 'handed off')}</span>}
          {!running && <span className={cx('status', st.cls)}>{st.label}</span>}
          <span>{elapsed(agent.startedAt, agent.endedAt)}</span>
          {live && agent.role !== 'compactor' && (
            <span className="turn-actions">
              {running && (
                <button className="icon-btn tiny" title={t('停止這個 agent', 'Stop this agent')} onClick={() => act('agents.stop')}>
                  ■
                </button>
              )}
              {((agent.role === 'subagent' && parentLive) || (agent.role !== 'subagent' && agent.role !== 'advisor' && running)) && (
                <button className="icon-btn tiny" title={agent.role === 'subagent' ? t('用同樣的任務重跑（會通知上層 agent）', 'Run the same task again (its parent is told)') : t('停下並重新派發這個角色', 'Stop and re-dispatch this role')} onClick={() => act('agents.rerun')}>
                  ↻
                </button>
              )}
              {agent.role === 'subagent' && parentLive && <SwitchProvider compact workflowId={run.id} agentId={agent.id} urgent={agent.failure?.kind === 'quota' || agent.failure?.kind === 'rate_limit'} />}
              {agent.role === 'subagent' && !running && (
                <button className="icon-btn tiny" title={t('關閉（從 agent 地圖隱藏，紀錄保留）', 'Close (hide from the agent map; records stay)')} onClick={() => act('agents.close')}>
                  ✕
                </button>
              )}
            </span>
          )}
        </span>
      </div>

      {agent.role === 'subagent' && (
        <div className="turn-task">
          <span className="turn-title">{subTitle(agent)}</span>
          <span className="muted">{agent.readonly ? t(' · 唯讀', ' · read-only') : t(' · 可寫入', ' · can write')}</span>
          {(agent.brief ?? agent.task) !== subTitle(agent) && (
            <button className="link small" onClick={() => setTaskOpen(!taskOpen)}>
              {taskOpen ? t('收起任務', 'Hide task') : t('任務全文', 'Full task')}
            </button>
          )}
          {taskOpen && <div className="turn-brief">{agent.brief ?? agent.task}</div>}
        </div>
      )}
      {agent.role === 'advisor' && <div className="turn-task">❓ {agent.task}</div>}

      <div className="turn-body">
        {/* Why the work came back here, joined to the round that starts now. */}
        {rework && <div className="turn-rework">↺ {rework}</div>}
        {/* Working: what it does now (routine calls folded, failures kept in view). Done: one line on how it ended. */}
        {/* A failure is said once: by its error line below, not again as a bare "Failed" here. */}
        {running ? <LiveFeed events={events} said={said} limit={LIVE_LINES} hideMessages={agent.role === 'compactor'} /> : summary.length > 0 && !(agent.status === 'failed' && agent.error && summary.length === 1) && <div className={cx('turn-summary', agent.status === 'failed' && 'bad')}>{summary.join(' · ')}</div>}
        {now?.kind === 'waiting' && (
          <div className="working">
            <span className="spark">✻</span> {now.text}
            <span className="muted"> · {elapsed(agent.startedAt)}</span>
          </div>
        )}
        {now?.kind === 'paused' && (
          <div className="working">
            <span className="spark">❚❚</span> {t('已暫停：按 ▶ 繼續', 'Paused: press ▶ to continue')}
          </div>
        )}
        {now?.kind === 'approval' && (
          <div className="working">
            <span className="spark">✋</span> {t(`等你核准 ${now.n} 個動作（在下方）`, `Waiting for your approval of ${now.n} action(s) (below)`)}
          </div>
        )}
        {now?.kind === 'working' && (
          <div className="working">
            <span className="spark">✻</span> {events.length ? t('正在處理', 'Working') : t('啟動中…', 'Starting…')}
            <span className="muted"> · {elapsed(agent.startedAt)}</span>
          </div>
        )}
        {/* An approval this agent waits for: beside its work, not at the bottom of the page. */}
        {mine.length > 0 && <Approvals run={run} providers={providers} agentId={agent.id} />}
        {agent.role !== 'compactor' && <Outcome run={run} agent={agent} lastMessage={events.filter((e) => e.kind === 'message').pop()?.text} />}
        {agent.status === 'failed' && agent.error && <div className="tx-err">✕ {agent.error}</div>}
        {/* The details: always here, in the same place, for every card. */}
        <div className="turn-foot">
          <button className="link activity-toggle" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
            {expanded ? '▾' : '▸'} {t('活動紀錄', 'Activity log')}
          </button>
          <span className="muted">
            {agent.stats.tools} {t('個動作', 'actions')}
            {agent.stats.filesChanged.length > 0 && ` · ${t(`以編輯工具改 ${agent.stats.filesChanged.length} 個檔案`, `${agent.stats.filesChanged.length} file(s) changed with the edit tool`)}`}
            {noteCount > 0 && ` · ${t(`${noteCount} 則筆記`, `${noteCount} note(s)`)}`}
            {agent.sessionId && ` · ${agent.resumed ? '↻ ' : ''}${agent.sessionId.slice(0, 8)}`}
          </span>
          {expanded && (
            <label className="toggle">
              <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> {t('原始紀錄', 'Raw log')}
            </label>
          )}
        </div>
        {expanded && (
          <div className="turn-details">
            {steps.length > 0 || raw ? <Transcript events={events} raw={raw} said={said} /> : <div className="muted small">{t('還沒有紀錄', 'Nothing recorded yet')}</div>}
            {!raw && internalCount + (agent.role !== 'advisor' ? noteCount : 0) > 0 && (
              <details className="internal-log">
                <summary>{t(`Aivenue 的紀錄、進度回報、筆記與交接（${internalCount + (agent.role !== 'advisor' ? noteCount : 0)}）`, `Aivenue's records, progress reports, notes and hand-offs (${internalCount + (agent.role !== 'advisor' ? noteCount : 0)})`)}</summary>
                <Transcript events={events} internal />
                {agent.role !== 'advisor' && <Notes run={run} agentId={agent.id} against={[]} />}
              </details>
            )}
            <Screenshots run={run} agentId={agent.id} />
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
        <button className="link small" onClick={() => setShowClosed(!showClosed)}>
          {showClosed ? t('隱藏已關閉的 sub agent', 'Hide closed sub-agents') : t(`顯示 ${allChildren.filter((c) => c.closed).length} 個已關閉的 sub agent`, `Show ${allChildren.filter((c) => c.closed).length} closed sub-agent(s)`)}
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
        {t('子代理批次', 'Sub-agent batches')} ·{' '}
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
              <button className="link small" onClick={() => setShowDone(!showDone)}>
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
  const icon = { blocked: '✕', running: '●', stopped: '■', done: '✓' }[b.state];
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
          <span className={cx('batch-icon', b.state)}>{icon}</span>
          <span className="batch-title">{b.title}</span>
          <span className="batch-who muted">{who}</span>
          {b.attempts.length > 1 && <span className="badge muted">{t(`第 ${b.attempts.length} 次嘗試`, `attempt ${b.attempts.length}`)}</span>}
          <span className={cx('batch-why', b.state === 'blocked' && 'bad')}>{why}</span>
        </button>
        {b.state === 'blocked' && parentLive && (
          <span className="batch-actions">
            <button className="btn small" onClick={rerun} title={t('用同樣的任務、同一個模型再試一次（會通知上層 agent）', 'Try the same task again with the same model (its parent is told)')}>
              ↻ {t('重試', 'Retry')}
            </button>
            <SwitchProvider compact workflowId={run.id} agentId={a.id} urgent={a.failure?.kind === 'quota' || a.failure?.kind === 'rate_limit'} />
          </span>
        )}
      </div>
      {/* What to do about it, while something still can be done here; once the work has ended, it is history. */}
      {b.state === 'blocked' && parentLive && a.failure?.action && <div className="batch-next muted small">➜ {a.failure.action}</div>}
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
