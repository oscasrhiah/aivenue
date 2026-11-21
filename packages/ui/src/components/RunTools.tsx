import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { ArrowLeftRight, BookCheck, ChartColumn, CircleCheck, CircleX, Download, Ellipsis, FileText, Layers, Library, Pencil, Search, Trash2, TriangleAlert, type LucideIcon } from 'lucide-react';
import { Ico } from '../icons';
import type { PreflightItem, ProviderInfo, WorkflowRun } from '../../../core/src/types';
import { hub } from '../api';
import { useT, type T } from '../i18n';
import { cx, providerName, roleLabel } from '../util';
import { ask } from './Ask';
import { RunMemoryWindow } from './Memory';
import { CostWindow } from './Cost';
import { Dialog, Hint } from './Kit';
import { menuEntries } from '../settingsView';

/**
 * The keyboard of a menu that opens from a button (the WAI-ARIA menu button pattern): when it opens, the focus goes to
 * the checked item (else the first); Up, Down, Home and End move through the items; Esc closes it and gives the focus
 * back to its button; Tab closes it and goes on from the button. The items are the list's [role^=menuitem] elements.
 * `tabCloses` false: a popup that also holds fields (the advisor's dialog: its modes, a model and limits) lets Tab go
 * into them, and closes when the focus leaves it; the arrows then move only between its items (`items`, e.g. its
 * radio buttons), not inside a field.
 */
export function useMenuKeys(open: boolean, list: RefObject<HTMLElement | null>, button: RefObject<HTMLElement | null>, close: () => void, tabCloses = true, itemSelector = '[role^="menuitem"]') {
  useEffect(() => {
    const el = list.current;
    if (!open || !el) return;
    const items = () => [...el.querySelectorAll<HTMLElement>(`${itemSelector}:not(:disabled)`)];
    (items().find((i) => i.getAttribute('aria-checked') === 'true') ?? items()[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      const all = items();
      const at = all.indexOf(document.activeElement as HTMLElement);
      const go = (n: number) => {
        e.preventDefault();
        all[(n + all.length) % all.length]?.focus();
      };
      const inField = e.target instanceof HTMLElement && !!e.target.closest('input, select, textarea');
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        button.current?.focus();
      } else if (inField) return;
      else if (e.key === 'ArrowDown') go(at + 1);
      else if (e.key === 'ArrowUp') go(at < 0 ? all.length - 1 : at - 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(all.length - 1);
      else if (e.key === 'Tab' && tabCloses) {
        close();
        button.current?.focus();
      }
    };
    const onOut = (e: FocusEvent) => {
      const to = e.relatedTarget as Node | null;
      if (!tabCloses && to && !el.contains(to) && !button.current?.contains(to)) close();
    };
    el.addEventListener('keydown', onKey);
    el.addEventListener('focusout', onOut);
    return () => {
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('focusout', onOut);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
}

export interface MenuEntry {
  label: string;
  /** A second, quieter line: what the item is about (instead of a parenthesis in its label). */
  hint?: string;
  icon?: LucideIcon;
  danger?: boolean;
  /** Shown but not usable right now (e.g. while it runs). */
  disabled?: boolean;
  onSelect: () => void;
}


/**
 * A ⋯ button and its menu (WAI-ARIA menu button: aria-haspopup, aria-expanded, role menu and menuitem, the keyboard of
 * useMenuKeys; a click outside closes it). The menu is drawn fixed under the button, or over it near the window's
 * bottom, so a scrolling list (the chat list) does not cut it. `openSignal`: opened from elsewhere (a right-click on the
 * row) when it changes.
 */
export function MoreMenu({ label, items, className, openSignal }: { label: string; items: (MenuEntry | 'sep' | false | undefined)[]; className?: string; openSignal?: number }) {
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const open = !!pos;
  const place = () => {
    const b = btn.current?.getBoundingClientRect();
    if (!b) return;
    const up = b.bottom > window.innerHeight * 0.6;
    setPos({ right: Math.max(8, window.innerWidth - b.right), ...(up ? { bottom: window.innerHeight - b.top + 4 } : { top: b.bottom + 4 }) });
  };
  const close = () => setPos(null);
  useEffect(() => {
    if (openSignal) place();
  }, [openSignal]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && close();
    // Only a scroll that moves the button (the chat list scrolled): the thread growing under the header leaves it open.
    const onScroll = (e: Event) => e.target instanceof Node && !!btn.current && e.target.contains(btn.current) && close();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);
  // Kept inside the window: in a narrow column (the VS Code side bar) a menu wider than the space left of its button
  // moves right until it is a margin from the edge.
  useLayoutEffect(() => {
    const el = list.current;
    if (!pos || !el || pos.left !== undefined) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    if (r.left < margin) setPos({ ...pos, right: undefined, left: margin });
  }, [pos]);
  useMenuKeys(open, list, btn, close);
  const entries = menuEntries(items);
  return (
    <span className={cx('more', open && 'open', className)} ref={wrap}>
      <button
        ref={btn}
        type="button"
        className="icon-btn more-btn"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? close() : place())}
        onKeyDown={(e) => {
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) {
            e.preventDefault();
            place();
          }
        }}
      >
        <Ico i={Ellipsis} size={16} />
      </button>
      {pos && (
        <div className="more-menu" role="menu" id={id} aria-label={label} ref={list} style={pos}>
          {entries.map((e, i) =>
            e === 'sep' ? (
              <div key={`sep${i}`} role="separator" className="menu-sep" />
            ) : (
              <button
                key={e.label}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={cx('menu-item', e.danger && 'danger')}
                disabled={e.disabled}
                onClick={() => {
                  close();
                  // Back on ⋯ first: an item that opens a window or a box moves the focus on from there.
                  btn.current?.focus();
                  e.onSelect();
                }}
              >
                {e.icon && <Ico i={e.icon} />}
                <span className="menu-text">
                  <span className="menu-label">{e.label}</span>
                  {e.hint && <span className="menu-hint">{e.hint}</span>}
                </span>
              </button>
            ),
          )}
        </div>
      )}
    </span>
  );
}

/**
 * Delete a conversation (every message of it) after one confirmation, the same from the chat's ⋯ and from its row in
 * the chat list. Project files are not touched. True when it was deleted.
 */
export async function deleteConversation(t: T, ids: string[]): Promise<boolean> {
  const sure = await ask(ids.length > 1 ? t(`刪除這段對話的 ${ids.length} 則訊息？`, `Delete this chat's ${ids.length} messages?`) : t('刪除這段對話？', 'Delete this chat?'), {
    detail: t('紀錄一起刪除，無法復原。不會動到專案檔案。', 'Its records go too, for good. Project files are not touched.'),
    danger: true,
    ok: t('刪除對話', 'Delete chat'),
    cancel: t('取消', 'Cancel'),
  });
  if (!sure) return false;
  try {
    for (const id of ids) await hub.call('workflows.delete', { id });
    return true;
  } catch {
    return false;
  }
}

interface Hit {
  agentId?: string;
  role?: string;
  stage?: string;
  round?: number;
  kind: string;
  text: string;
}

/**
 * The ⋯ menu of a conversation: rename it; look at its shared context, cost and project memory; search, export or distil
 * its records into a project Skill; delete it (`onDelete`, only while it does not run).
 */
export function RunMenu({ run, providers, onRename, onDelete }: { run: WorkflowRun; providers: ProviderInfo[]; onRename: () => void; onDelete?: () => void }) {
  const t = useT();
  const [search, setSearch] = useState(false);
  const [shared, setShared] = useState<string>();
  const [memory, setMemory] = useState(false);
  const [cost, setCost] = useState(false);
  const [note, setNote] = useState<string>();
  const exportPdf = async () => {
    setNote(t('正在產生 PDF…', 'Making the PDF…'));
    try {
      const r = await hub.call<{ path: string; bytes: number; masked: number }>('workflows.exportPdf', { id: run.id });
      setNote(t(`已匯出 PDF（${Math.ceil(r.bytes / 1024)} KB），遮罩了 ${r.masked} 處金鑰／信箱：${r.path}。保存 30 天後自動刪除。`, `Exported a PDF (${Math.ceil(r.bytes / 1024)} KB, ${r.masked} keys / emails masked): ${r.path}. Deleted automatically after 30 days.`));
      void hub.call('host.openPath', { path: r.path }).catch(() => undefined);
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  const exportRun = async () => {
    try {
      const r = await hub.call<{ path: string; bytes: number; masked: number }>('workflows.export', { id: run.id, mask: true });
      setNote(t(`已匯出 ${Math.ceil(r.bytes / 1024)} KB，遮罩了 ${r.masked} 處金鑰／信箱：${r.path}。保存 30 天後自動刪除。`, `Exported (${Math.ceil(r.bytes / 1024)} KB, ${r.masked} keys / emails masked): ${r.path}. Deleted automatically after 30 days.`));
      void hub.call('host.openPath', { path: r.path.replace(/[\\/][^\\/]+$/, '') }).catch(() => undefined);
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  const distil = async () => {
    try {
      const r = await hub.call<{ path: string; added: number }>('workflows.distilSkill', { id: run.id });
      setNote(r.added ? t(`已把 ${r.added} 條驗證過的規則寫進專案 Skill：${r.path}。之後在這個資料夾工作的 agent 都會優先讀它。`, `Added ${r.added} verified rule(s) to the project Skill: ${r.path}. Agents working in this folder read it first from now on.`) : t(`沒有新的已驗證規則可加（推論不會收錄）。檔案：${r.path}`, `No new verified rules to add (inferences are left out). File: ${r.path}`));
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  return (
    <div className="run-menu">
      <MoreMenu
        label={t('更多', 'More')}
        items={[
          { label: t('重新命名', 'Rename'), icon: Pencil, onSelect: onRename },
          'sep',
          { label: t('檢視共用上下文', 'View the shared context'), hint: t('agent 看到的內容', 'What agents see'), icon: Layers, onSelect: () => void hub.call<string>('workflows.sharedContext', { id: run.id }).then(setShared, (e) => setNote((e as Error).message)) },
          { label: t('成本分解', 'Cost breakdown'), hint: t('token、時間、prompt 組成', 'Tokens, time, prompt makeup'), icon: ChartColumn, onSelect: () => setCost(true) },
          { label: t('專案記憶', 'Project memory'), hint: t('這次帶入了什麼、記憶模式', 'What this run was given, memory mode'), icon: Library, onSelect: () => setMemory(true) },
          { label: t('搜尋紀錄', 'Search records'), icon: Search, onSelect: () => setSearch(true) },
          { label: t('匯出完整紀錄（PDF）', 'Export full records (PDF)'), hint: t('金鑰會遮罩', 'Keys masked'), icon: FileText, onSelect: () => void exportPdf() },
          { label: t('匯出原始紀錄（JSON）', 'Export raw records (JSON)'), hint: t('給除錯用，金鑰會遮罩', 'For troubleshooting, keys masked'), icon: Download, onSelect: () => void exportRun() },
          { label: t('存成專案 Skill', 'Save as a project Skill'), hint: t('只收驗證過的規則', 'Verified rules only'), icon: BookCheck, onSelect: () => void distil() },
          !!onDelete && 'sep',
          !!onDelete && { label: t('刪除對話…', 'Delete chat…'), icon: Trash2, danger: true, onSelect: onDelete },
        ]}
      />
      {memory && <RunMemoryWindow run={run} onClose={() => setMemory(false)} />}
      {cost && <CostWindow run={run} onClose={() => setCost(false)} />}
      {note && (
        <Dialog
          title={t('結果', 'Result')}
          size="sm"
          onClose={() => setNote(undefined)}
          foot={
            <button className="btn primary" onClick={() => setNote(undefined)}>
              {t('好', 'OK')}
            </button>
          }
        >
          <div className="small break">{note}</div>
        </Dialog>
      )}
      {shared !== undefined && (
        <Dialog title={t('共用上下文', 'Shared context')} size="lg" onClose={() => setShared(undefined)} back="detail-back">
          <Hint
            className="muted small"
            text={t(`agent 用 read_context 讀到的完整總覽，約 ${Math.round(shared.length / 4).toLocaleString()} tokens。內容有目標與差距、目前狀態（等待、GPU 鎖、背景程序）、審查與驗收、交接摘要、專案結構（Graphify），以及每個 agent 跑過的指令與結果。`, `The full overview agents read with read_context, about ${Math.round(shared.length / 4).toLocaleString()} tokens. It holds the goal and gap, current status (waits, GPU locks, background processes), reviews and verifications, hand-offs, project structure (Graphify), and every agent's commands and results.`)}
          />
          <pre className="shared-view" tabIndex={0} aria-label={t('共用上下文全文', 'Shared context, full text')}>
            {shared}
          </pre>
        </Dialog>
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
  return (
    <Dialog title={t('搜尋紀錄', 'Search records')} size="lg" onClose={onClose} back="detail-back">
        <div className="row gap wrap">
          <input className="grow" aria-label={t('搜尋文字', 'Search text')} autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} placeholder={t('文字：訊息、指令、輸出、筆記、問題', 'Text: messages, commands, output, notes, issues')} />
          <button className="btn primary" onClick={go}>
            {t('搜尋', 'Search')}
          </button>
        </div>
        <div className="row gap wrap small">
          <select aria-label={t('角色', 'Role')} value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">{t('所有角色', 'Any role')}</option>
            {roles.map((r) => (
              <option key={r} value={r}>
                {roleLabel(t, r)}
              </option>
            ))}
          </select>
          <select aria-label={t('階段', 'Stage')} value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">{t('所有階段', 'Any stage')}</option>
            <option value="plan">{t('計畫', 'Plan')}</option>
            <option value="implement">{t('實作', 'Build')}</option>
            <option value="verify">{t('目標驗收', 'Goal check')}</option>
          </select>
          <input className="mono" aria-label={t('檔案', 'File')} style={{ width: 160 }} value={file} onChange={(e) => setFile(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} placeholder={t('檔案', 'File')} />
          <input className="mono" aria-label={t('問題編號', 'Issue id')} style={{ width: 90 }} value={issueId} onChange={(e) => setIssueId(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} placeholder={t('問題編號', 'Issue id')} />
        </div>
        {err && <div className="err-text small">{err}</div>}
        {hits && (
          <div className="search-hits">
            <div className="muted small num">{t(`${hits.length} 筆`, `${hits.length} hit(s)`)}</div>
            {hits.map((h, i) => {
              const a = h.agentId ? run.agents[h.agentId] : undefined;
              return (
                <div key={i} className="search-hit">
                  <div className="tiny muted">
                    {/* Who, then where; the record's kind and the agent's id in the tooltip. */}
                    <span title={[h.kind, h.agentId?.slice(0, 8)].filter(Boolean).join('\n')}>
                      {a ? `${providerName(providers, a.provider)} · ${roleLabel(t, a.role)}` : h.agentId === 'user' ? t('你', 'You') : ''}
                      {h.stage || h.round ? t('，', ', ') : ''}
                      {[h.stage, h.round ? t(`第 ${h.round} 輪`, `round ${h.round}`) : ''].filter(Boolean).join(' ')}
                    </span>
                  </div>
                  <div className="small break">{h.text}</div>
                </div>
              );
            })}
          </div>
        )}
    </Dialog>
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
            <Ico i={p.level === 'ok' ? CircleCheck : p.level === 'warn' ? TriangleAlert : CircleX} size={14} className="pf-icon" />
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
  const title = t('改用另一家供應商重跑這個子 agent 的任務，例如額度用完時', 'Run this sub-agent\'s task again on another provider (e.g. when its quota ran out)');
  return (
    <span className={cx('switch-prov', !compact && 'wide')} ref={ref}>
      {compact ? (
        <button className={cx('icon-btn tiny', urgent && 'warn-text')} title={title} aria-label={title} onClick={open}>
          <Ico i={ArrowLeftRight} size={13} />
        </button>
      ) : (
        <button className={cx('btn small', urgent && 'warn')} title={title} onClick={open}>
          <Ico i={ArrowLeftRight} size={14} /> {t('換一家重跑', 'Run on another provider')}
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
