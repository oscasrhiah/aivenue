import { useState } from 'react';
import type { AgentRunInfo, ProviderInfo, Round, WorkflowRun } from '../../../core/src/types';
import { fileUrl, useAgentEvents } from '../api';
import { useT } from '../i18n';
import { agentStatus, cx, elapsed, modelLabel, providerColor, providerName, roleLabel, STEP_ICON } from '../util';
import { Transcript, visible } from './Transcript';
import { Markdown } from './Markdown';

function roundOf(run: WorkflowRun, a: AgentRunInfo): Round | undefined {
  if (!a.stage) return undefined;
  return run.stages[a.stage].rounds.find((r) => r.n === a.round);
}

function Responses({ round }: { round: Round }) {
  const t = useT();
  const rs = round.submission?.responses;
  if (!rs?.length) return null;
  return (
    <div className="block">
      <div className="block-label">{t('對審查意見的回應', 'Responses to review')}</div>
      {rs.map((r) => (
        <div key={r.issue_id} className="resp">
          <span className={cx('pill', r.action === 'fixed' ? 'ok' : 'warn')}>{r.action === 'fixed' ? t('已修正', 'Fixed') : t('反駁', 'Rebutted')}</span>
          <b>{r.issue_id}</b> <span className="muted">{r.note}</span>
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

  if ((agent.role === 'plan_reviewer' || agent.role === 'code_reviewer') && isReviewer && round?.review) {
    const r = round.review;
    return (
      <div className="block">
        <div className={cx('verdict', r.verdict === 'approve' ? 'ok' : 'warn')}>
          {r.verdict === 'approve' ? `✓ ${t('通過', 'Approved')}` : `↺ ${t('需要修改', 'Changes requested')} · ${r.issues.length}`}
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
      </div>
    );
  }

  if (agent.role === 'executor') {
    const latestExecutor = Object.values(run.agents)
      .filter((a) => a.role === 'executor')
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
    return (
      <>
        {round && <Responses round={round} />}
        {latestExecutor?.id === agent.id && run.steps.length > 0 && (
          <div className="block">
            <div className="block-label">{t('計畫進度', 'Plan progress')}</div>
            {run.steps.map((s) => (
              <div key={s.id} className={cx('pstep', s.status)}>
                <span className="pstep-icon">{STEP_ICON[s.status]}</span>
                <span>
                  {/^\d/.test(s.id) ? `${s.id}. ${s.title}` : s.title}
                  {s.note && !s.title.includes(s.note.slice(0, 20)) && <span className="muted"> — {s.note}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
        {done && isAuthor && round?.submission?.summary && round.submission.summary.trim() !== agent.finalText?.trim() && (
          <div className="block">
            <div className="block-label">{t('實作摘要', 'Summary')}</div>
            <Markdown className="prose" text={round.submission.summary} />
          </div>
        )}
        <Files files={agent.stats.filesChanged} />
      </>
    );
  }

  if (agent.role === 'subagent' || agent.role === 'advisor') {
    return (
      <>
        {/* The transcript usually already ends with this text. */}
        {done && agent.finalText && agent.finalText.trim() !== lastMessage?.trim() && <Markdown className="prose clamp" text={agent.finalText} />}
        <Files files={agent.stats.filesChanged} />
      </>
    );
  }
  return null;
}

/** Notes this agent shared with the others (`post_note`). */
function Notes({ run, agentId }: { run: WorkflowRun; agentId: string }) {
  const t = useT();
  const notes = (run.notes ?? []).filter((n) => n.agentId === agentId);
  if (!notes.length) return null;
  return (
    <div className="notes">
      {notes.map((n) => (
        <div key={n.id} className="note-shared" title={t('分享給後面所有 agent 的筆記', 'Shared with every later agent')}>
          <span className="note-pin">📌</span>
          <span>{n.text}</span>
        </div>
      ))}
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

function Files({ files }: { files: string[] }) {
  if (!files.length) return null;
  return (
    <div className="files">
      {files.map((f) => (
        <span key={f} className="file">
          {f}
        </span>
      ))}
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
  const children = Object.values(run.agents)
    .filter((a) => a.parentId === agent.id)
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const steps = visible(events, false);
  const hidden = Math.max(0, steps.length - LIVE_LINES);

  return (
    <div className={cx('turn', (agent.role === 'subagent' || agent.role === 'advisor') && 'sub', agent.role === 'advisor' && 'advisor', running && 'live')}>
      <div className="turn-head">
        <span className="mark" style={{ background: providerColor(agent.provider) }} />
        <span className="turn-who">{name}</span>
        <span className="turn-role">
          {roleLabel(t, agent.role)}
          {agent.round && agent.role !== 'subagent' && agent.role !== 'advisor' ? ` · ${t(`第 ${agent.round} 輪`, `round ${agent.round}`)}` : ''}
          {' · '}
          <span className="turn-model" title={agent.model ?? t('供應商預設模型', 'Provider default model')}>
            {agent.model ? modelLabel(agent.model) : t('預設模型', 'default model')}
          </span>
          {agent.servedBy?.length ? (
            <span className="turn-served" title={t(`實際回答的模型：${agent.servedBy.join('、')}`, `Models that actually answered: ${agent.servedBy.join(', ')}`)}>
              {' → '}
              {agent.servedBy.join('、')}
            </span>
          ) : null}
          {agent.effort ? ` · ${t('推理', 'effort')} ${agent.effort}` : ''}
        </span>
        <span className="turn-meta">
          {!running && <span className={cx('status', st.cls)}>{st.label}</span>}
          <span>{elapsed(agent.startedAt, agent.endedAt)}</span>
        </span>
      </div>

      {agent.role === 'subagent' && <div className="turn-task">{agent.task}</div>}
      {agent.role === 'advisor' && <div className="turn-task">❓ {agent.task}</div>}

      <div className="turn-body">
        {expanded ? (
          <Transcript events={events} raw={raw} />
        ) : (
          <>
            {hidden > 0 && (
              <button className="more" onClick={() => setExpanded(true)}>
                + {t(`另外 ${hidden} 個步驟`, `${hidden} earlier steps`)}
              </button>
            )}
            <Transcript events={events} limit={running ? LIVE_LINES : LIVE_LINES} />
          </>
        )}
        {running && (
          <div className="working">
            <span className="spark">✻</span> {agent.activity?.replace(/^\S+\s/, '') ?? t('啟動中…', 'Starting…')}
            <span className="muted"> · {elapsed(agent.startedAt)}</span>
          </div>
        )}
        {/* An advisor's note repeats its advice, which the card already shows. */}
        {agent.role !== 'advisor' && <Notes run={run} agentId={agent.id} />}
        <Screenshots run={run} agentId={agent.id} />
        <Outcome run={run} agent={agent} lastMessage={events.filter((e) => e.kind === 'message').pop()?.text} />
        {agent.status === 'failed' && agent.error && <div className="tx-err">✕ {agent.error}</div>}
        <div className="turn-foot">
          {(expanded || hidden === 0) && steps.length > 0 && (
            <button className="link" onClick={() => setExpanded(!expanded)}>
              {expanded ? t('收起', 'Collapse') : t('完整紀錄', 'Full log')}
            </button>
          )}
          {expanded && (
            <label className="toggle">
              <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> {t('原始紀錄', 'Raw log')}
            </label>
          )}
          <span className="muted">
            {agent.stats.tools} {t('個動作', 'actions')}
            {agent.stats.filesChanged.length > 0 && ` · ${agent.stats.filesChanged.length} ${t('個檔案', 'files')}`}
            {agent.sessionId && ` · ${agent.resumed ? '↻ ' : ''}${agent.sessionId.slice(0, 8)}`}
          </span>
        </div>
      </div>

      {children.length > 0 && (
        <div className="subs">
          {children.map((c) => (
            <AgentTurn key={c.id} run={run} agent={c} providers={providers} />
          ))}
        </div>
      )}
    </div>
  );
}
