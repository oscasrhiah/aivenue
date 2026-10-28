import { useEffect, useRef, useState } from 'react';
import type { PreflightItem, ProviderInfo, WorkflowRun } from '../../../core/src/types';
import { hub } from '../api';
import { useT } from '../i18n';
import { cx, providerName, roleLabel } from '../util';

interface Hit {
  agentId?: string;
  role?: string;
  stage?: string;
  round?: number;
  kind: string;
  text: string;
}

/** The ⋯ menu of a conversation: search its records, export them, distil the verified rules into a project Skill. */
export function RunMenu({ run, providers }: { run: WorkflowRun; providers: ProviderInfo[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState(false);
  const [shared, setShared] = useState<string>();
  const [note, setNote] = useState<string>();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const exportRun = async () => {
    setOpen(false);
    try {
      const r = await hub.call<{ path: string; bytes: number; masked: number }>('workflows.export', { id: run.id, mask: true });
      setNote(t(`已匯出（${Math.ceil(r.bytes / 1024)} KB，遮罩了 ${r.masked} 處金鑰／信箱）：${r.path}。保存 30 天後自動刪除。`, `Exported (${Math.ceil(r.bytes / 1024)} KB, ${r.masked} keys / emails masked): ${r.path}. Deleted automatically after 30 days.`));
      void hub.call('host.openPath', { path: r.path.replace(/[\\/][^\\/]+$/, '') }).catch(() => undefined);
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  const distil = async () => {
    setOpen(false);
    try {
      const r = await hub.call<{ path: string; added: number }>('workflows.distilSkill', { id: run.id });
      setNote(r.added ? t(`已把 ${r.added} 條驗證過的規則寫進專案 Skill：${r.path}。之後在這個資料夾工作的 agent 都會優先讀它。`, `Added ${r.added} verified rule(s) to the project Skill: ${r.path}. Agents working in this folder read it first from now on.`) : t(`沒有新的已驗證規則可加（推論不會收錄）。檔案：${r.path}`, `No new verified rules to add (inferences are left out). File: ${r.path}`));
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  return (
    <div className="run-menu" ref={ref}>
      <button className="icon-btn" title={t('更多', 'More')} onClick={() => setOpen(!open)}>
        ⋯
      </button>
      {open && (
        <div className="menu">
          <button onClick={() => (setOpen(false), void hub.call<string>('workflows.sharedContext', { id: run.id }).then(setShared, (e) => setNote((e as Error).message)))}>🧠 {t('檢視共享上下文（agent 看到的內容）', 'View the shared context (what agents see)')}</button>
          <button onClick={() => (setOpen(false), setSearch(true))}>🔎 {t('搜尋紀錄', 'Search records')}</button>
          <button onClick={exportRun}>📦 {t('匯出完整紀錄（遮罩金鑰）', 'Export full records (keys masked)')}</button>
          <button onClick={distil}>📐 {t('把驗證過的規則存成專案 Skill', 'Save verified rules as a project Skill')}</button>
        </div>
      )}
      {note && (
        <div className="modal-back" onClick={() => setNote(undefined)}>
          <div className="modal small-modal" onClick={(e) => e.stopPropagation()}>
            <div className="small break">{note}</div>
            <div className="wf-modal-foot">
              <button className="btn primary" onClick={() => setNote(undefined)}>
                {t('好', 'OK')}
              </button>
            </div>
          </div>
        </div>
      )}
      {shared !== undefined && (
        <div className="modal-back" onClick={() => setShared(undefined)}>
          <div className="modal wf-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head wf-modal-head">
              <h3>{t('共享上下文', 'Shared context')}</h3>
              <button className="icon-btn" onClick={() => setShared(undefined)} aria-label="close">
                ✕
              </button>
            </div>
            <div className="muted small">{t(`agent 用 read_context 讀到的完整總覽：目標與差距、目前狀態（等待、GPU 鎖、背景程序）、審查與驗收、交接摘要、專案結構（Graphify）、每個 agent 跑過的指令與結果。約 ${Math.round(shared.length / 4).toLocaleString()} tokens。`, `The full overview agents read with read_context: goal and gap, current status (waits, GPU locks, background processes), reviews and verifications, hand-offs, project structure (Graphify), and every agent's commands and results. About ${Math.round(shared.length / 4).toLocaleString()} tokens.`)}</div>
            <pre className="shared-view">{shared}</pre>
          </div>
        </div>
      )}
      {search && <RecordSearch run={run} providers={providers} onClose={() => setSearch(false)} />}
    </div>
  );
}

/** Search every agent's messages, tool calls and output, notes and issues, by text, role, stage, round, file or issue id. */
function RecordSearch({ run, providers, onClose }: { run: WorkflowRun; providers: ProviderInfo[]; onClose: () => void }) {
  const t = useT();
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [stage, setStage] = useState('');
  const [file, setFile] = useState('');
  const [issueId, setIssueId] = useState('');
  const [hits, setHits] = useState<Hit[]>();
  const [err, setErr] = useState<string>();
  const roles = [...new Set(Object.values(run.agents).map((a) => a.role))];
  const go = () => {
    setErr(undefined);
    hub
      .call<Hit[]>('workflows.search', { id: run.id, query: { q: q || undefined, role: role || undefined, stage: stage || undefined, file: file || undefined, issueId: issueId || undefined, limit: 100 } })
      .then(setHits)
      .catch((e) => setErr((e as Error).message));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal wf-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head wf-modal-head">
          <h3>{t('搜尋紀錄', 'Search records')}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="close">
            ✕
          </button>
        </div>
        <div className="row gap wrap">
          <input className="grow" autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} placeholder={t('文字（訊息、指令、輸出、筆記、問題）', 'Text (messages, commands, output, notes, issues)')} />
          <button className="btn primary" onClick={go}>
            {t('搜尋', 'Search')}
          </button>
        </div>
        <div className="row gap wrap small">
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">{t('所有角色', 'Any role')}</option>
            {roles.map((r) => (
              <option key={r} value={r}>
                {roleLabel(t, r)}
              </option>
            ))}
          </select>
          <select value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">{t('所有階段', 'Any stage')}</option>
            <option value="plan">{t('計畫', 'Plan')}</option>
            <option value="implement">{t('實作', 'Build')}</option>
            <option value="verify">{t('目標驗收', 'Goal check')}</option>
          </select>
          <input className="mono" style={{ width: 160 }} value={file} onChange={(e) => setFile(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} placeholder={t('檔案', 'File')} />
          <input className="mono" style={{ width: 90 }} value={issueId} onChange={(e) => setIssueId(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} placeholder={t('問題編號', 'Issue id')} />
        </div>
        {err && <div className="err-text small">{err}</div>}
        {hits && (
          <div className="search-hits">
            <div className="muted small">{t(`${hits.length} 筆`, `${hits.length} hit(s)`)}</div>
            {hits.map((h, i) => {
              const a = h.agentId ? run.agents[h.agentId] : undefined;
              return (
                <div key={i} className="search-hit">
                  <div className="tiny muted">
                    {a ? `${providerName(providers, a.provider)} · ${roleLabel(t, a.role)}` : h.agentId === 'user' ? t('你', 'You') : ''}
                    {h.stage ? ` · ${h.stage}` : ''}
                    {h.round ? ` · ${t(`第 ${h.round} 輪`, `round ${h.round}`)}` : ''} · <span className="mono">{h.kind}</span>
                    {h.agentId && <span className="mono"> · {h.agentId.slice(0, 8)}</span>}
                  </div>
                  <div className="small break">{h.text}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const AREA = (t: ReturnType<typeof useT>, a: PreflightItem['area']) => ({ provider: t('供應商', 'Provider'), model: t('模型', 'Model'), path: t('路徑', 'Path'), tool: t('工具', 'Tool'), resource: t('資源', 'Resources'), recovery: t('恢復', 'Recovery') })[a];

/** Preflight results: errors first; "ok" lines folded unless asked for. */
export function PreflightList({ items, showOk }: { items: PreflightItem[]; showOk?: boolean }) {
  const t = useT();
  const sorted = [...items].sort((a, b) => ['error', 'warn', 'ok'].indexOf(a.level) - ['error', 'warn', 'ok'].indexOf(b.level));
  return (
    <div className="preflight">
      {sorted
        .filter((p) => showOk || p.level !== 'ok')
        .map((p, i) => (
          <div key={i} className={cx('pf-item', p.level)}>
            <span className="pf-icon">{p.level === 'ok' ? '✓' : p.level === 'warn' ? '!' : '✕'}</span>
            <span className="pf-area">{AREA(t, p.area)}</span>
            <span>{p.message}</span>
          </div>
        ))}
    </div>
  );
}

interface SwitchTarget {
  id: string;
  name: string;
  quota: 'ok' | 'limited';
  note?: string;
  model?: string;
}

/** "⇄": run a sub-agent's task again on another signed-in provider (e.g. when its quota ran out). */
export function SwitchProvider({ workflowId, agentId, compact, urgent }: { workflowId: string; agentId: string; compact?: boolean; urgent?: boolean }) {
  const t = useT();
  const [list, setList] = useState<SwitchTarget[]>();
  const [err, setErr] = useState<string>();
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!list) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setList(undefined);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [list]);
  const open = () =>
    list
      ? setList(undefined)
      : hub
          .call<SwitchTarget[]>('agents.switchTargets', { workflowId, agentId })
          .then((l) => (setErr(undefined), setList(l)))
          .catch((e) => setErr((e as Error).message));
  const pick = (id: string) =>
    hub
      .call('agents.rerun', { workflowId, agentId, provider: id })
      .then(() => setList(undefined))
      .catch((e) => setErr((e as Error).message));
  const title = t('改用另一家供應商重跑這個 sub agent 的任務（例如額度用完時）', 'Run this sub-agent\'s task again on another provider (e.g. when its quota ran out)');
  return (
    <span className={cx('switch-prov', !compact && 'wide')} ref={ref}>
      {compact ? (
        <button className={cx('icon-btn tiny', urgent && 'warn-text')} title={title} onClick={open}>
          ⇄
        </button>
      ) : (
        <button className={cx('btn small', urgent && 'warn')} title={title} onClick={open}>
          ⇄ {t('換一家重跑', 'Run on another provider')}
        </button>
      )}
      {list && (
        <div className="menu switch-menu">
          {list.length === 0 && <div className="muted small pad">{t('沒有其他已登入的供應商', 'No other signed-in provider')}</div>}
          {list.map((p) => (
            <button key={p.id} onClick={() => pick(p.id)} title={p.note}>
              <span className="grow">
                {p.name}
                {p.model && <span className="muted"> · {p.model}</span>}
              </span>
              <span className={cx('pill', p.quota === 'ok' ? 'ok' : 'warn')}>{p.quota === 'ok' ? t('有額度', 'has quota') : t('額度可能用完', 'quota may be out')}</span>
            </button>
          ))}
        </div>
      )}
      {err && <span className="err-text small"> {err}</span>}
    </span>
  );
}
