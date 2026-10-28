import { useEffect, useState } from 'react';
import type { AgentRunInfo, ProviderInfo, WorkflowRun } from '../../../core/src/types';
import { hub, useAgentEvents } from '../api';
import { failureLabel } from './AgentTurn';
import { useT } from '../i18n';
import { agentStatus, cx, elapsed, fmtTokens, modelLabel, providerColor, providerName, roleLabel } from '../util';
import { Markdown } from './Markdown';
import { Transcript, visible } from './Transcript';

type T = ReturnType<typeof useT>;

const isLive = (a: AgentRunInfo) => a.status === 'running' || a.status === 'queued' || a.status === 'paused';

/** Re-render every second while something runs, so elapsed times tick. */
function useTick(on: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [on]);
}

/** What the agent is for: a sub-agent's task, or its role in the workflow. */
function titleOf(t: T, a: AgentRunInfo): string {
  if (a.role === 'subagent') return a.task || 'Sub agent';
  if (a.role === 'advisor') return `❓ ${a.task || roleLabel(t, a.role)}`;
  return `${roleLabel(t, a.role)}${a.round ? ` · ${t(`第 ${a.round} 輪`, `round ${a.round}`)}` : ''}`;
}

const tokensOf = (a: AgentRunInfo) => (a.tokens ? a.tokens.input + a.tokens.output : 0);

function byStart(a: AgentRunInfo, b: AgentRunInfo) {
  return (a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER);
}

/** "Agent map": every agent of the conversation as a tree (who started whom); click one for its details. */
export function AgentMap({ run, providers, onClose }: { run: WorkflowRun; providers: ProviderInfo[]; onClose: () => void }) {
  const t = useT();
  const [selected, setSelected] = useState<string | undefined>();
  // Closed agents leave the map (their records stay in the conversation).
  const agents = Object.values(run.agents).filter((a) => a.role !== 'test' && !a.closed);
  useTick(agents.some(isLive));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (selected) setSelected(undefined);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, selected]);

  const roots = agents.filter((a) => !a.parentId || !run.agents[a.parentId]).sort(byStart);
  const childrenOf = (id: string) => agents.filter((a) => a.parentId === id).sort(byStart);
  const subs = agents.filter((a) => a.role === 'subagent' || a.role === 'advisor').length;
  const live = agents.filter(isLive).length;
  const current = selected ? run.agents[selected] : undefined;
  const sections = groupRoots(roots);
  // A conversation of several messages: number them in the section titles.
  const messages = [...new Set(sections.map((s) => s.workflowId))];
  const stageName = (s?: string) => (s === 'plan' ? t('計畫', 'Plan') : s === 'implement' ? t('實作與審查', 'Implement & review') : s === 'verify' ? t('目標驗收', 'Goal verification') : t('其他', 'Other'));

  // An agent with the agents it started hanging below it.
  const tree = (a: AgentRunInfo) => {
    const kids = childrenOf(a.id);
    return (
      <div className="am-tree" key={a.id}>
        <Node t={t} agent={a} providers={providers} onOpen={() => setSelected(a.id)} />
        {kids.length > 0 && <div className="am-sub">{kids.map(tree)}</div>}
      </div>
    );
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal am-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {current ? (
          <Detail t={t} run={run} agent={current} providers={providers} onBack={() => setSelected(undefined)} onOpen={setSelected} onClose={onClose} />
        ) : (
          <>
            <div className="am-head">
              <h3>Agent map</h3>
              <button className="icon-btn" onClick={onClose} aria-label="close">
                ✕
              </button>
            </div>
            <div className="muted small">
              {t(`${agents.length} 個 agent`, `${agents.length} agents`)}
              {subs > 0 && t(`（${subs} 個 sub agent／顧問）`, ` (${subs} sub-agents / advisors)`)}
              {live > 0 && t(` · ${live} 個執行中`, ` · ${live} running`)}
              {' · '}
              {t('點一下 agent 看詳細內容', 'click an agent for details')}
            </div>
            {agents.length === 0 ? (
              <div className="muted">{t('還沒有 agent 開始工作。', 'No agent has started yet.')}</div>
            ) : (
              <div className="am-canvas">
                {sections.map((sec, i) => (
                  <section className="am-stage" key={i}>
                    <div className="am-stage-head">
                      <span>{messages.length > 1 ? t(`第 ${messages.indexOf(sec.workflowId) + 1} 則訊息 · `, `Message ${messages.indexOf(sec.workflowId) + 1} · `) : ''}{stageName(sec.stage)}</span>
                    </div>
                    {sec.rows.map((row, j) => (
                      <div className="am-round" key={j}>
                        <div className="am-round-label">{row.round ? t(`第 ${row.round} 輪`, `Round ${row.round}`) : ''}</div>
                        <div className="am-round-body">
                          {row.agents.map((a, k) => (
                            <div className="am-step" key={a.id}>
                              {k > 0 && <span className="am-arrow" aria-hidden="true" />}
                              {tree(a)}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

type Section = { stage?: string; workflowId: string; rows: { round?: number; agents: AgentRunInfo[] }[] };

/**
 * The main agents in start order, grouped into stages (plan, implement…) and rounds within a stage. A follow-up message
 * that starts the stage over (its round goes back to 1) opens a new section, so each request reads top to bottom.
 */
function groupRoots(roots: AgentRunInfo[]): Section[] {
  const out: Section[] = [];
  let last: { stage?: string; round: number; workflowId: string } | undefined;
  for (const a of roots) {
    const round = a.round ?? 0;
    let sec = out[out.length - 1];
    // Each message of a conversation (its own workflow) gets its own sections.
    if (!sec || !last || sec.stage !== a.stage || sec.workflowId !== a.workflowId || (a.stage && round < last.round)) {
      sec = { stage: a.stage, workflowId: a.workflowId, rows: [] };
      out.push(sec);
    }
    // Agents with no round (direct answers, retries outside the loop) each get a row of their own.
    let row = round ? sec.rows.find((r) => r.round === round) : undefined;
    if (!row) sec.rows.push((row = { round: round || undefined, agents: [] }));
    row.agents.push(a);
    last = { stage: a.stage, round, workflowId: a.workflowId };
  }
  return out;
}

function Dot({ t, agent }: { t: T; agent: AgentRunInfo }) {
  const st = agentStatus(t, agent.status);
  return <span className={cx('am-dot', st.cls, isLive(agent) && 'live')} title={st.label} />;
}

function Node({ t, agent, providers, onOpen }: { t: T; agent: AgentRunInfo; providers: ProviderInfo[]; onOpen: () => void }) {
  const tokens = tokensOf(agent);
  const main = agent.role !== 'subagent' && agent.role !== 'advisor';
  return (
    <button className={cx('am-node', main && 'am-root', isLive(agent) && 'live')} onClick={onOpen} title={titleOf(t, agent)}>
      <div className="am-node-title">
        <Dot t={t} agent={agent} />
        {/* The round is on the row's label already. */}
        <span className="am-title-text">{main ? roleLabel(t, agent.role) : titleOf(t, agent)}</span>
      </div>
      <div className="am-node-meta">
        <span className="am-mark" style={{ background: providerColor(agent.provider) }} />
        {providerName(providers, agent.provider)}
        {' · '}
        {agent.model ? modelLabel(agent.model) : t('預設模型', 'default model')}
      </div>
      <div className="am-node-meta muted">
        {agent.startedAt ? elapsed(agent.startedAt, agent.endedAt) : agentStatus(t, agent.status).label}
        {tokens > 0 && ` · ${fmtTokens(tokens)} tokens`}
        {agent.stats.tools > 0 && ` · ${agent.stats.tools} ${t('個動作', 'actions')}`}
      </div>
      {isLive(agent) && agent.activity && <div className="am-node-doing">{agent.activity.replace(/^\S+\s/, '')}</div>}
    </button>
  );
}

function Detail({ t, run, agent, providers, onBack, onOpen, onClose }: { t: T; run: WorkflowRun; agent: AgentRunInfo; providers: ProviderInfo[]; onBack: () => void; onOpen: (id: string) => void; onClose: () => void }) {
  // In a conversation's map the agent may belong to an earlier message (its own workflow).
  const events = useAgentEvents(agent.workflowId ?? run.id, agent.id);
  const [raw, setRaw] = useState(false);
  const st = agentStatus(t, agent.status);
  const parent = agent.parentId ? run.agents[agent.parentId] : undefined;
  const kids = Object.values(run.agents)
    .filter((a) => a.parentId === agent.id)
    .sort(byStart);
  const tokens = agent.tokens;
  const steps = visible(events, raw);
  const answer = agent.finalText?.trim();
  return (
    <>
      <div className="am-head">
        <button className="icon-btn" onClick={onBack} aria-label={t('返回', 'Back')}>
          ←
        </button>
        <Dot t={t} agent={agent} />
        <h3 className="am-detail-title">{titleOf(t, agent)}</h3>
        <button className="icon-btn" onClick={onClose} aria-label="close">
          ✕
        </button>
      </div>
      <div className="am-facts">
        <div>
          <span className={cx('status', st.cls)}>{st.label}</span>
          {' · '}
          <span className="am-mark" style={{ background: providerColor(agent.provider) }} />
          {providerName(providers, agent.provider)}
          {' · '}
          <b>{agent.model ? modelLabel(agent.model) : t('預設模型', 'default model')}</b>
          {agent.servedBy?.length ? ` → ${t('實際', 'served by')} ${agent.servedBy.join('、')}` : ''}
          {agent.effort && ` · ${t('推理', 'effort')} ${agent.effort}`}
          {' · '}
          {roleLabel(t, agent.role)}
          {agent.readonly && ` · ${t('唯讀', 'read-only')}`}
        </div>
        <div className="muted">
          {parent ? (
            <>
              {t('由 ', 'Spawned by ')}
              <button className="link" onClick={() => onOpen(parent.id)}>
                {providerName(providers, parent.provider)} · {titleOf(t, parent)}
              </button>
              {t(' 派出', '')}
            </>
          ) : (
            t('工作流的主要 agent', 'A main agent of the workflow')
          )}
        </div>
        <div className="muted">
          {agent.startedAt ? elapsed(agent.startedAt, agent.endedAt) : '—'}
          {tokens && ` · ${fmtTokens(tokens.input + tokens.output)} tokens（${t('輸入', 'in')} ${fmtTokens(tokens.input)}${tokens.cached ? ` / ${t('快取', 'cached')} ${fmtTokens(tokens.cached)}` : ''} · ${t('輸出', 'out')} ${fmtTokens(tokens.output)}）`}
          {` · ${agent.stats.tools} ${t('個動作', 'actions')}`}
          {agent.stats.commands > 0 && ` · ${agent.stats.commands} ${t('個指令', 'commands')}`}
          {agent.stats.filesChanged.length > 0 && ` · ${agent.stats.filesChanged.length} ${t('個檔案', 'files')}`}
        </div>
      </div>

      <AgentActions t={t} run={run} agent={agent} />

      {(agent.role === 'subagent' || agent.role === 'advisor') && agent.task && (
        <div className="am-section">
          <div className="am-label">{agent.role === 'advisor' ? t('問題', 'Question') : t('任務', 'Task')}</div>
          <div className="am-task">{agent.task}</div>
        </div>
      )}

      {isLive(agent) && (
        <div className="am-section">
          <div className="am-label">{t('現在正在做', 'Doing now')}</div>
          <div className="working">
            <span className="spark">✻</span> {agent.activity?.replace(/^\S+\s/, '') ?? t('啟動中…', 'Starting…')}
          </div>
        </div>
      )}

      {kids.length > 0 && (
        <div className="am-section">
          <div className="am-label">{t(`派出的 agent（${kids.length}）`, `Agents it started (${kids.length})`)}</div>
          <div className="am-kid-list">
            {kids.map((k) => (
              <button key={k.id} className="am-kid" onClick={() => onOpen(k.id)}>
                <Dot t={t} agent={k} /> {providerName(providers, k.provider)} · {k.model ? modelLabel(k.model) : t('預設模型', 'default model')} — {titleOf(t, k)}
              </button>
            ))}
          </div>
        </div>
      )}

      {!isLive(agent) && answer && (
        <div className="am-section">
          <div className="am-label">{t('結果', 'Result')}</div>
          <Markdown className="am-answer" text={answer.length > 20000 ? answer.slice(0, 20000) + '\n…' : answer} />
        </div>
      )}
      {agent.status === 'failed' && agent.error && <div className="tx-err">✕ {agent.error}</div>}

      {agent.stats.filesChanged.length > 0 && (
        <div className="am-section">
          <div className="am-label">{t('改動的檔案', 'Files changed')}</div>
          <div className="am-files mono small">
            {agent.stats.filesChanged.map((f) => (
              <div key={f}>{f}</div>
            ))}
          </div>
        </div>
      )}

      <div className="am-section">
        <div className="am-label row gap">
          <span className="grow">{t(`處理過程（${steps.length} 個步驟）`, `What it did (${steps.length} steps)`)}</span>
          <label className="toggle">
            <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> {t('原始紀錄', 'Raw log')}
          </label>
        </div>
        {events.length ? <Transcript events={events} raw={raw} /> : <div className="muted small">{t('載入中…', 'Loading…')}</div>}
      </div>
    </>
  );
}

/** Stop, re-run and close one agent; plus why it failed or what it waits for. */
function AgentActions({ t, run, agent }: { t: T; run: WorkflowRun; agent: AgentRunInfo }) {
  const live = run.status === 'running' || run.status === 'paused' || run.status === 'waiting_human';
  const act = (method: string) => hub.call(method, { workflowId: agent.workflowId ?? run.id, agentId: agent.id }).catch((e) => alert((e as Error).message));
  const parentLive = !agent.parentId || isLive(run.agents[agent.parentId] ?? agent);
  const canRerun = live && ((agent.role === 'subagent' && parentLive) || (agent.role !== 'subagent' && agent.role !== 'advisor' && agent.status === 'running'));
  return (
    <div className="am-section">
      {agent.waiting && <div className="small">⏳ {agent.waiting}</div>}
      {agent.failure && agent.status !== 'completed' && (
        <div className="small warn-text">
          {failureLabel(t, agent.failure.kind)}：{agent.failure.action}
        </div>
      )}
      {agent.endedWithoutResult && <div className="small warn-text">{t('程序已結束，但沒有交出結果（不是成功）', 'The process ended without a result (not a success)')}</div>}
      {live && agent.role !== 'compactor' && (
        <div className="row gap">
          {isLive(agent) && (
            <button className="btn small danger" onClick={() => act('agents.stop')}>
              ■ {t('停止', 'Stop')}
            </button>
          )}
          {canRerun && (
            <button className="btn small" onClick={() => act('agents.rerun')}>
              ↻ {agent.role === 'subagent' ? t('重跑', 'Re-run') : t('重新派發', 'Re-dispatch')}
            </button>
          )}
          {agent.role === 'subagent' && !isLive(agent) && (
            <button className="btn small" onClick={() => act('agents.close')}>
              ✕ {t('關閉', 'Close')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
