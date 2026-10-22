import { useEffect, useRef, useState } from 'react';
import type { PermissionLevel, ProviderInfo, WorkflowRun } from '../../../core/src/types';
import { hub } from '../api';
import { useT, type T } from '../i18n';
import { cx, providerName } from '../util';

export const PERMISSION_ICON: Record<PermissionLevel, string> = { plan: '📋', ask: '✋', edit: '✏️', auto: '⚡' };

export const permissionLabel = (t: T, p: PermissionLevel) =>
  ({ plan: t('Plan 唯讀', 'Plan (read-only)'), ask: t('手動核准', 'Ask me'), edit: t('自動編輯', 'Auto-edit'), auto: t('完全 Auto', 'Full auto') })[p];

const permissionHint = (t: T, p: PermissionLevel) =>
  ({
    plan: t('只能讀檔與規劃，不改檔、不執行有副作用的指令。', 'Read and plan only: no file changes, no side-effect commands.'),
    ask: t('每次改檔或執行指令都會在這裡詢問你。', 'Every file change or command asks you here first.'),
    edit: t('自動允許工作資料夾內的編輯；執行指令依各家沙箱限制或被擋下。', 'Edits in the working folder are auto-approved; commands are sandboxed or blocked per provider.'),
    auto: t('全部自動核准（Codex 仍保留工作資料夾沙箱）。建議搭配隔離模式。', 'Everything auto-approved (Codex keeps its folder sandbox). Pair it with isolation.'),
  })[p];

/** Composer button showing the permission level; opens a small pick-list (or the settings window when read-only). */
export function PermissionButton({ permission, isolation, onChange, onOpen }: { permission: PermissionLevel; isolation: boolean; onChange?: (v: { permission?: PermissionLevel; isolation?: boolean }) => void; onOpen: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <span className="perm-wrap" ref={ref}>
      <button className="pill-btn perm-btn" title={`${t('權限', 'Permissions')}：${permissionLabel(t, permission)}`} onClick={() => (onChange ? setOpen(!open) : onOpen())}>
        {PERMISSION_ICON[permission]} <span className="perm-label">{permissionLabel(t, permission)}</span>
        {isolation && ' 🧪'}
      </button>
      {open && onChange && (
        <div className="perm-menu" role="menu">
          {(['plan', 'ask', 'edit', 'auto'] as PermissionLevel[]).map((p) => (
            <button
              key={p}
              role="menuitemradio"
              aria-checked={p === permission}
              className={cx('perm-item', p === permission && 'on')}
              onClick={() => {
                onChange({ permission: p });
                setOpen(false);
              }}
            >
              <span className="perm-item-icon">{PERMISSION_ICON[p]}</span>
              <span>
                <span className="perm-item-title">{permissionLabel(t, p)}</span>
                <span className="perm-item-hint">{permissionHint(t, p)}</span>
              </span>
            </button>
          ))}
          <label className="check perm-iso">
            <input type="checkbox" checked={isolation} onChange={(e) => onChange({ isolation: e.target.checked })} />
            {t('隔離模式（在 git worktree 副本中工作）', 'Isolation (work in a git worktree copy)')}
          </label>
        </div>
      )}
    </span>
  );
}

/** Permission level + isolation controls (role drawer). */
export function SafetySection({ permission, isolation, providers, roleProviders, onChange, disabled, isolationLocked }: { permission: PermissionLevel; isolation: boolean; providers: ProviderInfo[]; roleProviders: string[]; onChange: (v: { permission?: PermissionLevel; isolation?: boolean }) => void; disabled?: boolean; isolationLocked?: boolean }) {
  const t = useT();
  const notes =
    permission === 'ask'
      ? [...new Set(roleProviders)]
          .map((id) => providers.find((p) => p.spec.id === id))
          .filter((p): p is ProviderInfo => !!p && p.spec.approvals?.type === 'fallback')
          .map((p) => {
            const a = p.spec.approvals as { zh: string; en: string };
            return t(a.zh, a.en);
          })
      : [];
  return (
    <section className="sect">
      <div className="sect-title">{t('權限與安全', 'Permissions & safety')}</div>
      <div className="seg wide">
        {(['plan', 'ask', 'edit', 'auto'] as PermissionLevel[]).map((p) => (
          <button key={p} disabled={disabled} className={cx(permission === p && 'on')} onClick={() => onChange({ permission: p })}>
            {PERMISSION_ICON[p]} {permissionLabel(t, p)}
          </button>
        ))}
      </div>
      <div className="muted small">{permissionHint(t, permission)}</div>
      {notes.map((n, i) => (
        <div key={i} className="note warn small">
          {n}
        </div>
      ))}
      <label className="check">
        <input type="checkbox" disabled={disabled || isolationLocked} checked={isolation} onChange={(e) => onChange({ isolation: e.target.checked })} />
        {t('隔離模式：在獨立的 git worktree 副本中工作，完成後再決定是否套用（需要 git 專案）', 'Isolation: work in a separate git worktree and decide afterwards whether to apply (needs a git repo)')}
      </label>
    </section>
  );
}

/** Pending approvals ("ask" level) for a run. */
export function Approvals({ run, providers }: { run: WorkflowRun; providers: ProviderInfo[] }) {
  const t = useT();
  const [open, setOpen] = useState<string>();
  const list = run.approvals ?? [];
  if (!list.length) return null;
  const decide = (approvalId: string, decision: 'allow' | 'always' | 'deny') => hub.call('workflows.approve', { id: run.id, approvalId, decision }).catch(() => undefined);
  return (
    <div className="approvals">
      {list.map((a) => (
        <div key={a.id} className="approval">
          <div className="approval-q">
            ✋ {t(`${providerName(providers, a.provider)} 想要執行`, `${providerName(providers, a.provider)} wants to run`)} <b>{a.tool}</b>
          </div>
          <div className="approval-summary mono">{a.summary}</div>
          {a.input && (
            <button className="link" onClick={() => setOpen(open === a.id ? undefined : a.id)}>
              {open === a.id ? t('收起細節', 'Hide details') : t('查看細節', 'Details')}
            </button>
          )}
          {open === a.id && <pre className="approval-input">{a.input}</pre>}
          <div className="row gap wrap">
            <button className="btn primary" onClick={() => decide(a.id, 'allow')}>
              {t('允許', 'Allow')}
            </button>
            <button className="btn" onClick={() => decide(a.id, 'always')}>
              {t(`這次對話都允許「${a.tool}」`, `Always allow "${a.tool}" in this chat`)}
            </button>
            <button className="btn danger" onClick={() => decide(a.id, 'deny')}>
              {t('拒絕', 'Deny')}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Result of an isolated run: apply / keep / discard. */
export function WorktreeCard({ run }: { run: WorkflowRun }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const wt = run.worktree;
  if (!wt) return null;
  const finished = run.status !== 'running' && run.status !== 'waiting_human';
  if (wt.state !== 'active') return <div className="note">🧪 {wt.note}</div>;
  if (!finished) return null;
  const act = async (action: 'apply' | 'keep' | 'discard') => {
    if (action === 'discard' && !confirm(t('捨棄隔離副本中的所有變更？', 'Discard all changes in the isolated copy?'))) return;
    setBusy(true);
    setError(undefined);
    try {
      await hub.call('workflows.worktree', { id: run.id, action });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="decision">
      <div className="decision-q">🧪 {t('這次的變更在隔離副本中，要怎麼處理？', 'The changes are in an isolated copy. What should happen to them?')}</div>
      <div className="muted small mono">{wt.branch}</div>
      <div className="row gap wrap">
        <button className="btn primary" disabled={busy} onClick={() => act('apply')}>
          {t('套用到我的專案', 'Apply to my project')}
        </button>
        <button className="btn" disabled={busy} onClick={() => act('keep')}>
          {t('保留為 git 分支', 'Keep as a git branch')}
        </button>
        <button className="btn danger" disabled={busy} onClick={() => act('discard')}>
          {t('捨棄', 'Discard')}
        </button>
      </div>
      {error && <div className="note err">{error}</div>}
    </div>
  );
}
