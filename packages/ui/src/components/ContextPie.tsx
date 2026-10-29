import { useEffect, useRef, useState } from 'react';
import type { AgentRunInfo, ProviderInfo, WorkflowRun } from '../../../core/src/types';
import { hub } from '../api';
import { useT } from '../i18n';
import { cx, fmtTokens, providerName, roleLabel } from '../util';

/** Same defaults as the engine (orchestrator.ts). */
const DEFAULT_CAPACITY = 256_000;
const MAIN_ROLES = ['planner', 'plan_reviewer', 'executor', 'code_reviewer'];

const level = (pct: number) => (pct >= 90 ? 'err' : pct >= 70 ? 'warn' : '');

/** The main agents' conversations: the latest turn of each (they resume one session per role). */
function conversations(run: WorkflowRun): AgentRunInfo[] {
  const bySession = new Map<string, AgentRunInfo>();
  for (const a of Object.values(run.agents)) {
    if (!MAIN_ROLES.includes(a.role) || !a.sessionId) continue;
    const cur = bySession.get(a.sessionId);
    if (!cur || (a.startedAt ?? 0) >= (cur.startedAt ?? 0)) bySession.set(a.sessionId, a);
  }
  return [...bySession.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

/** How an agent's conversation gets compacted, by what its CLI allows. */
function methodOf(t: ReturnType<typeof useT>, providers: ProviderInfo[], provider: string): string {
  const out = providers.find((p) => p.spec.id === provider)?.spec.output;
  if (out === 'claude-stream') return t('用 Claude Code 自己的 /compact 壓縮', "Claude Code's own /compact");
  if (out === 'codex-jsonl') return t('用 Codex 的壓縮功能（app-server）', "Codex's compaction (app-server)");
  if (out === 'agy-stream') return t('用 Antigravity 的 /compact（效果無法驗證）', "Antigravity's /compact (effect can't be verified)");
  return t('由壓縮者整理交接摘要，下一輪開新對話', 'The compactor writes a hand-off summary; the next turn starts a fresh conversation');
}

/** Pie in the composer: how full the shared context is; hover or click for details and compaction. */
export function ContextPie({ run, providers }: { run: WorkflowRun; providers: ProviderInfo[] }) {
  const t = useT();
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const [error, setError] = useState<string>();
  const [organizing, setOrganizing] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!pinned) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setPinned(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [pinned]);

  const cfg = run.config.context ?? {};
  const every = cfg.organizeEvery ?? 30;
  const fresh = (run.notes ?? []).filter((n) => n.ts > (run.knowledge?.upto ?? 0)).length;
  const cap = cfg.capacity ?? DEFAULT_CAPACITY;
  const at = cfg.compactAt ?? 0.8;
  const summaryOnly = (run.config.contextSharing ?? 'on_demand') === 'summary';
  const used = run.sharedTokens ?? 0;
  const pct = Math.min(100, (used / cap) * 100);
  const r = 7;
  const circ = 2 * Math.PI * r;
  const busy = !!run.compacting;
  const compactor = cfg.compactor ? `${providerName(providers, cfg.compactor.provider)}${cfg.compactor.model ? ` · ${cfg.compactor.model}` : ''}` : t('自動', 'Automatic');
  const call = (method: string, params: Record<string, unknown>) => {
    setError(undefined);
    hub.call(method, params).catch((e) => setError((e as Error).message));
  };
  const open = pinned || hover;
  return (
    <span className="ctx-wrap" ref={ref} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button className={cx('pill-btn ctx-pie', level(pct), busy && 'busy')} onClick={() => setPinned(!pinned)} aria-label={t('共用上下文用量', 'Shared context usage')}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="9" cy="9" r={r} className="ctx-track" />
          <circle cx="9" cy="9" r={r} className="ctx-fill" strokeDasharray={`${(pct / 100) * circ} ${circ}`} transform="rotate(-90 9 9)" />
        </svg>
        <span className="ctx-pct">{summaryOnly ? '—' : `${Math.round(pct)}%`}</span>
      </button>
      {open && (
        <div className="ctx-pop" role="dialog">
          <div className="ctx-head">{t('Aivenue 共用上下文', 'Aivenue shared context')}</div>
          {summaryOnly ? (
            <div className="muted small">{t('這段對話設為「只交摘要」，agent 之間不共用上下文。', 'This conversation shares summaries only; agents share no context.')}</div>
          ) : (
            <>
              <div className="ctx-big">
                {t(`已用 ${Math.round(pct)}%`, `${Math.round(pct)}% used`)} <span className="muted small">（{fmtTokens(used)} / {fmtTokens(cap)}，{t('估計', 'estimated')}）</span>
              </div>
              <div className="ctx-bar">
                <div className={cx('ctx-bar-fill', level(pct))} style={{ width: `${pct}%` }} />
                <div className="ctx-bar-mark" style={{ left: `${at * 100}%` }} title={t('自動壓縮門檻', 'Auto-compaction threshold')} />
              </div>
              <div className="muted small">
                {used >= cap * at
                  ? t('已超過自動壓縮門檻，下一個 agent 開始前會先壓縮。', 'Over the threshold: compacted before the next agent starts.')
                  : t(`再約 ${fmtTokens(cap * at - used)} 會自動壓縮（${Math.round(at * 100)}%）。`, `Compacts automatically in about ${fmtTokens(cap * at - used)} (${Math.round(at * 100)}%).`)}
              </div>
              {run.memory && (
                <div className="muted small">
                  {t(`上次壓縮：約 ${fmtTokens(run.memory.before ?? 0)} → ${fmtTokens(run.memory.after ?? 0)}（${run.memory.by ?? ''}）`, `Last compaction: about ${fmtTokens(run.memory.before ?? 0)} → ${fmtTokens(run.memory.after ?? 0)} (${run.memory.by ?? ''})`)}
                  {run.memory.kept?.length ? t(`，逐字保留 ${run.memory.kept.length} 項`, `, ${run.memory.kept.length} item(s) kept verbatim`) : ''}
                </div>
              )}
              <div className="row gap ctx-actions">
                <button className="btn small" disabled={busy || !used} onClick={() => call('workflows.compactShared', { id: run.id })}>
                  {busy && run.compacting?.target === 'shared' ? t('壓縮中…', 'Compacting…') : t('現在壓縮', 'Compact now')}
                </button>
                <span className="muted tiny">{t(`壓縮者：${compactor}，約讀 ${fmtTokens(used)} tokens`, `Compactor: ${compactor}, reads about ${fmtTokens(used)} tokens`)}</span>
              </div>
              <div className="ctx-head sub">{t('共用知識', 'Shared knowledge')}</div>
              <div className="muted small">
                {run.knowledge
                  ? t(`已把 ${run.knowledge.notes} 則筆記依主題整理（${run.knowledge.by ?? ''}）`, `${run.knowledge.notes} notes organized by subject (${run.knowledge.by ?? ''})`)
                  : t('還沒整理過。', 'Not organized yet.')}{' '}
                {t(`新筆記 ${fresh} 則`, `${fresh} new note(s)`)}
                {every ? t(`，滿 ${every} 則自動整理。`, `; organized automatically at ${every}.`) : t('，不自動整理。', '; not organized automatically.')}
              </div>
              <div className="row gap ctx-actions">
                <button
                  className="btn small"
                  disabled={organizing || !fresh}
                  onClick={() => {
                    setError(undefined);
                    setOrganizing(true);
                    hub
                      .call('workflows.organizeShared', { id: run.id })
                      .catch((e) => setError((e as Error).message))
                      .finally(() => setOrganizing(false));
                  }}
                >
                  {organizing ? t('整理中…', 'Organizing…') : t('現在整理', 'Organize now')}
                </button>
                <span className="muted tiny">{t('依主題整理筆記與 findings，每一條附出處；原本的筆記不變', 'Sorts the notes and findings by subject, each line with its source; the notes stay as they are')}</span>
              </div>
            </>
          )}
          <div className="ctx-head sub">{t('各 agent 自己的對話', "Each agent's own conversation")}</div>
          {conversations(run).length === 0 && <div className="muted small">{t('還沒有 agent 的對話。', 'No agent conversation yet.')}</div>}
          {conversations(run).map((a) => {
            const c = a.context;
            const p = c?.used && c.window ? Math.min(100, (c.used / c.window) * 100) : undefined;
            const compactingThis = run.compacting?.target === a.id;
            return (
              <div key={a.id} className="ctx-agent">
                <span className="grow">
                  {roleLabel(t, a.role)} · {providerName(providers, a.provider)}
                  <span className={cx('small', p !== undefined ? level(p) && `${level(p)}-text` : 'muted')}>
                    {' '}
                    {p !== undefined
                      ? `${Math.round(p)}%（${fmtTokens(c!.used!)} / ${fmtTokens(c!.window!)}）`
                      : c?.compactedAt
                        ? t('已壓縮，下一輪更新', 'compacted; updates next turn')
                        : c?.used
                          ? `${fmtTokens(c.used)} · ${t('上限無法取得', 'limit unknown')}`
                          : t('無法取得', 'unknown')}
                  </span>
                </span>
                <button className="btn tiny" disabled={busy} title={methodOf(t, providers, a.provider)} onClick={() => call('workflows.compactAgent', { id: run.id, agentId: a.id })}>
                  {compactingThis ? t('壓縮中…', 'Compacting…') : t('壓縮', 'Compact')}
                </button>
              </div>
            );
          })}
          {error && <div className="note err small">{error}</div>}
        </div>
      )}
    </span>
  );
}

/** Asked when an agent's own conversation passes the threshold (80% by default, again at 90%). */
export function ContextAsk({ run, providers }: { run: WorkflowRun; providers: ProviderInfo[] }) {
  const t = useT();
  const ask = run.contextAsk;
  const agent = ask ? run.agents[ask.agentId] : undefined;
  if (!ask || !agent) return null;
  const pct = Math.round((ask.used / ask.window) * 100);
  const who = `${roleLabel(t, agent.role)} · ${providerName(providers, agent.provider)}`;
  const answer = (action: 'compact' | 'later' | 'mute') => hub.call('workflows.contextAsk', { id: run.id, action }).catch(() => undefined);
  return (
    <div className="modal-back">
      <div className="modal ctx-ask" role="alertdialog" aria-modal="true">
        <h3>{t(`「${who}」的對話快滿了`, `${who}'s conversation is nearly full`)}</h3>
        <p>
          {t(`已用 ${pct}%（${fmtTokens(ask.used)} / ${fmtTokens(ask.window)}）。要現在壓縮它的對話嗎？`, `${pct}% used (${fmtTokens(ask.used)} / ${fmtTokens(ask.window)}). Compact its conversation now?`)}
        </p>
        <p className="muted small">
          {methodOf(t, providers, agent.provider)}
          {t('。工作中的 agent 會在這一輪結束後再壓縮；不處理的話，CLI 快滿時也會自己壓縮。', '. A working agent is compacted after its current turn; if you skip it, the CLI compacts on its own when it is about to be full.')}
        </p>
        <div className="row gap end">
          <button className="btn ghost" onClick={() => answer('mute')}>
            {t('這個 agent 不再詢問', "Don't ask again for this agent")}
          </button>
          <button className="btn" onClick={() => answer('later')}>
            {t('稍後（90% 再問）', 'Later (ask again at 90%)')}
          </button>
          <button className="btn primary" onClick={() => answer('compact')}>
            {t('現在壓縮', 'Compact now')}
          </button>
        </div>
      </div>
    </div>
  );
}
