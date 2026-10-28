import { useMemo, useState } from 'react';
import type { AgentRunInfo, FailureKind, Handoff, ProviderInfo, Round, WorkflowRun } from '../../../core/src/types';
import { fileUrl, hub, useAgentEvents } from '../api';
import { useT } from '../i18n';
import { agentStatus, cx, elapsed, firstLine, saidOwner, modelLabel, providerColor, providerName, roleLabel, roleTone, similar, STEP_ICON, subTitle } from '../util';
import { Clamp } from './Clamp';
import { SwitchProvider } from './RunTools';
import { Transcript, visible } from './Transcript';
import { Markdown } from './Markdown';
import { extensionSummary } from '../extensionUse';
import { outcomeText } from './Progress';

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

function roundOf(run: WorkflowRun, a: AgentRunInfo): Round | undefined {
  if (!a.stage) return undefined;
  return run.stages[a.stage]?.rounds.find((r) => r.n === a.round);
}

const routeLabel = (t: ReturnType<typeof useT>, to: string) => ({ done: t('完成', 'done'), implementer: t('交回實作者', 'back to the implementer'), planner: t('交回計畫者', 'back to the planner'), adjudicate: t('交付裁定', 'to adjudication'), user: t('交給你', 'to you') })[to] ?? to;

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
        {round.handoff && <HandoffBlock h={round.handoff} />}
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
        {round.route && <div className="route small">➜ {routeLabel(t, round.route.to)}：{round.route.reason}</div>}
        {round.handoff && <HandoffBlock h={round.handoff} />}
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
        {done && agent.finalText && agent.finalText.trim() !== lastMessage?.trim() && (
          <div className="block">
            <Clamp height={140}>
              <Markdown className="prose" text={agent.finalText} />
            </Clamp>
          </div>
        )}
        <Files files={agent.stats.filesChanged} />
      </>
    );
  }
  return null;
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
        // A note that repeats the result shown in this card adds nothing on screen (agents still get it).
        const same = against.some((x) => x && similar(n.text, x));
        return (
          <div
            key={n.id}
            className={cx('note-line', shown && 'open')}
            title={t('分享給後面所有 agent 的筆記；點一下展開或收起', 'Shared with every later agent; click to expand or collapse')}
            onClick={() => setOpen((s) => new Set(s.has(n.id) ? [...s].filter((x) => x !== n.id) : [...s, n.id]))}
          >
            <span className="note-pin">📌</span>
            {NOTE_KIND(t, n.kind) && <span className={cx('pill', n.kind === 'fact' ? 'ok' : n.kind === 'decision' ? '' : 'warn')}>{NOTE_KIND(t, n.kind)}</span>}
            <span className="note-text">{shown ? n.text : same ? t('筆記（與這張卡片的結果相同）', 'Note (same as this card\'s result)') : n.text}</span>
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
  const allChildren = Object.values(run.agents)
    .filter((a) => a.parentId === agent.id)
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const steps = visible(events, false);
  const ext = useMemo(() => extensionSummary(events), [events]);
  const said = (run.userMessages ?? []).filter((m) => saidOwner(run, m.ts) === agent.id);
  const hidden = Math.max(0, steps.length - LIVE_LINES);
  const [showClosed, setShowClosed] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  // The result this card shows (to spot notes that only repeat it).
  const round = roundOf(run, agent);
  const shownResult = [round?.review?.summary, round?.verification?.summary, round?.submission?.summary, agent.finalText].filter((x): x is string => !!x);
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
    <div className={cx('turn', roleTone(agent.role), (agent.role === 'subagent' || agent.role === 'advisor') && 'sub', agent.role === 'advisor' && 'advisor', running && 'live')}>
      <div className="turn-head">
        <span className="mark" style={{ background: providerColor(agent.provider) }} />
        <span className="turn-who">{name}</span>
        <span className="turn-role">
          {roleLabel(t, agent.role)}
          {agent.round && agent.role !== 'subagent' && agent.role !== 'advisor' ? ` · ${t(`第 ${agent.round} 輪`, `round ${agent.round}`)}` : ''}
          {' · '}
          <span className="turn-model" title={[agent.model ?? t('供應商預設模型', 'Provider default model'), snapText].filter(Boolean).join('\n')}>
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
        {(agent.alwaysOn?.length || ext.skills.length || agent.skillUses?.length || ext.graphify > 0) && (
          <span className="turn-ext">
            {agent.alwaysOn?.map((a) => (
              <span key={a} className="ext-chip" title={t(`整個任務都套用：${a}`, `Applied for the whole task: ${a}`)}>
                🪮 {a}
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
        {expanded ? (
          <Transcript events={events} raw={raw} said={said} />
        ) : (
          <>
            {hidden > 0 && (
              <button className="more" onClick={() => setExpanded(true)}>
                + {t(`另外 ${hidden} 個步驟`, `${hidden} earlier steps`)}
              </button>
            )}
            <Transcript events={events} limit={LIVE_LINES} said={said} />
          </>
        )}
        {running && (
          <div className="working">
            <span className="spark">✻</span> {agent.waiting ?? agent.activity?.replace(/^\S+\s/, '') ?? t('啟動中…', 'Starting…')}
            <span className="muted"> · {elapsed(agent.startedAt)}</span>
          </div>
        )}
        {/* An advisor's note repeats its advice, which the card already shows. */}
        {agent.role !== 'advisor' && <Notes run={run} agentId={agent.id} against={shownResult} />}
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

      {allChildren.length > 0 && (
        <div className="subs">
          {allChildren
            .filter((c) => !c.closed || showClosed)
            .map((c) => (
              <AgentTurn key={c.id} run={run} agent={c} providers={providers} />
            ))}
          {allChildren.some((c) => c.closed) && (
            <button className="link small" onClick={() => setShowClosed(!showClosed)}>
              {showClosed ? t('隱藏已關閉的 sub agent', 'Hide closed sub-agents') : t(`顯示 ${allChildren.filter((c) => c.closed).length} 個已關閉的 sub agent`, `Show ${allChildren.filter((c) => c.closed).length} closed sub-agent(s)`)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
