import { useEffect, useRef, useState } from 'react';
import type { PermissionLevel, ProviderInfo, WorkflowRun } from '../../../core/src/types';
import { hub } from '../api';
import { useT, type T } from '../i18n';
import { cx, providerName } from '../util';

export const PERMISSION_ICON: Record<PermissionLevel, string> = { plan: '📋', ask: '✋', edit: '✏️', auto: '⚡', full: '🛑' };

const LEVELS: PermissionLevel[] = ['plan', 'ask', 'edit', 'auto', 'full'];

export const permissionLabel = (t: T, p: PermissionLevel) =>
  ({ plan: t('Plan 唯讀', 'Plan (read-only)'), ask: t('手動核准', 'Ask me'), edit: t('自動編輯', 'Auto-edit'), auto: t('完全 Auto', 'Full auto'), full: t('完整電腦存取', 'Whole computer') })[p];

const permissionHint = (t: T, p: PermissionLevel) =>
  ({
    plan: t('只能讀檔與規劃，不改檔、不執行有副作用的指令。', 'Read and plan only: no file changes, no side-effect commands.'),
    ask: t('每次改檔或執行指令都會在這裡詢問你。', 'Every file change or command asks you here first.'),
    edit: t('自動允許工作資料夾內的編輯；執行指令依各家沙箱限制或被擋下。', 'Edits in the working folder are auto-approved; commands are sandboxed or blocked per provider.'),
    auto: t('全部自動核准。Codex 只能寫入工作資料夾；其他 CLI 的工具與指令仍可能改到資料夾外的檔案。建議搭配隔離模式。', "Everything auto-approved. Codex can only write in the working folder; other CLIs' tools and commands may still change files outside it. Pair it with isolation."),
    full: t('AI 可以讀寫整台電腦的檔案、執行任何指令（拿掉 Codex 的沙箱）。只對這段對話有效，對外動作仍要你核准。', "The AI may read and change files anywhere on this computer and run any command (Codex's sandbox is removed). This conversation only; outside actions still need your OK."),
  })[p];

/**
 * Picking whole-computer access goes through a confirmation; every other level applies at once.
 * Returns the picker and the dialog to render.
 */
function useGuardedPermission(current: PermissionLevel, onChange?: (v: { permission?: PermissionLevel; isolation?: boolean }) => void) {
  const [asking, setAsking] = useState(false);
  const pick = (p: PermissionLevel) => {
    if (p === 'full' && current !== 'full') setAsking(true);
    else onChange?.({ permission: p });
  };
  const dialog = asking ? (
    <FullAccessConfirm
      onCancel={() => setAsking(false)}
      onConfirm={() => {
        setAsking(false);
        onChange?.({ permission: 'full' });
      }}
    />
  ) : null;
  return { pick, dialog };
}

/** Warning before whole-computer access: what it allows, what still holds, and an explicit "I understand". */
export function FullAccessConfirm({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const t = useT();
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="modal-back" onMouseDown={onCancel}>
      <div className="modal full-confirm" role="alertdialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <h3>🛑 {t('開啟完整電腦存取？', 'Allow whole-computer access?')}</h3>
        <p>{t('這段對話中的 AI 將可以：', 'In this conversation the AI will be able to:')}</p>
        <ul>
          <li>{t('讀取、修改、刪除電腦上任何檔案，不只工作資料夾', 'read, change and delete any file on this computer, not just the working folder')}</li>
          <li>{t('執行任何指令與程式（Codex 的沙箱也會拿掉）', 'run any command or program (Codex’s sandbox is removed too)')}</li>
        </ul>
        <p className="muted small">
          {t(
            '仍然有效：規劃者、審查者、顧問維持唯讀；推送、PR、發布等對外動作要你核准；AI 被要求不碰登入憑證與系統設定、外部改動要列在回報中。這些要求是規則，不是技術上的鎖；隔離模式也只保護工作資料夾。只對這段對話有效，新對話會回到完全 Auto。',
            'Still in place: planners, reviewers and advisors stay read-only; pushes, PRs, releases and other outside actions need your OK; the AI is told not to touch credentials or system settings and to list outside changes in its report. Those are rules, not locks, and isolation only protects the working folder. This conversation only; new conversations go back to Full auto.',
          )}
        </p>
        <label className="check">
          <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} autoFocus />
          {t('我了解風險，允許這段對話使用完整電腦存取', 'I understand the risk; allow whole-computer access for this conversation')}
        </label>
        <div className="row gap end">
          <button className="btn" onClick={onCancel}>
            {t('取消', 'Cancel')}
          </button>
          <button className="btn danger" disabled={!ok} onClick={onConfirm}>
            🛑 {t('開啟', 'Allow')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Red strip at the top of a conversation running with whole-computer access. */
export function FullAccessBanner({ run }: { run: WorkflowRun }) {
  const t = useT();
  if (run.config.permission !== 'full') return null;
  return (
    <div className="full-banner">
      🛑 {t('完整電腦存取：這段對話的 AI 可以讀寫整台電腦的檔案、執行任何指令。', 'Whole-computer access: the AI in this conversation may change files anywhere on this computer and run any command.')}
    </div>
  );
}

/** Files agents changed outside the working folder and the extra folders, from their file tools. */
export function OutsideChanges({ run }: { run: WorkflowRun }) {
  const t = useT();
  const files = run.outsideChanges ?? [];
  if (!files.length) return null;
  return (
    <div className="decision outside-changes">
      <div className="decision-q">📂 {t(`工作資料夾外的改動（${files.length}）`, `Changes outside the working folder (${files.length})`)}</div>
      <div className="mono small">
        {files.map((f) => (
          <div key={f}>{f}</div>
        ))}
      </div>
      <div className="muted tiny">
        {t('由 agent 的寫檔工具記錄；用指令（shell）改的檔案不一定列得出來。', 'Recorded from the agents’ file tools; files changed through shell commands may be missing.')}
      </div>
    </div>
  );
}

/** Composer button showing the permission level; opens a small pick-list (or the settings window when read-only). */
export function PermissionButton({ permission, isolation, onChange, onOpen }: { permission: PermissionLevel; isolation: boolean; onChange?: (v: { permission?: PermissionLevel; isolation?: boolean }) => void; onOpen: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const { pick, dialog } = useGuardedPermission(permission, onChange);
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
      <button className={cx('pill-btn perm-btn', permission === 'full' && 'danger-on')} title={`${t('權限', 'Permissions')}：${permissionLabel(t, permission)}`} onClick={() => (onChange ? setOpen(!open) : onOpen())}>
        {PERMISSION_ICON[permission]} <span className="perm-label">{permissionLabel(t, permission)}</span>
        {isolation && ' 🧪'}
      </button>
      {open && onChange && (
        <div className="perm-menu" role="menu">
          {LEVELS.map((p) => (
            <button
              key={p}
              role="menuitemradio"
              aria-checked={p === permission}
              className={cx('perm-item', p === permission && 'on', p === 'full' && 'danger')}
              onClick={() => {
                pick(p);
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
      {dialog}
    </span>
  );
}

/** Permission level + isolation controls (role drawer). */
export function SafetySection({ permission, isolation, providers, roleProviders, onChange, disabled, isolationLocked }: { permission: PermissionLevel; isolation: boolean; providers: ProviderInfo[]; roleProviders: string[]; onChange: (v: { permission?: PermissionLevel; isolation?: boolean }) => void; disabled?: boolean; isolationLocked?: boolean }) {
  const t = useT();
  const { pick, dialog } = useGuardedPermission(permission, onChange);
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
        {LEVELS.map((p) => (
          <button key={p} disabled={disabled} className={cx(permission === p && 'on', p === 'full' && 'danger')} onClick={() => pick(p)}>
            {PERMISSION_ICON[p]} {permissionLabel(t, p)}
          </button>
        ))}
      </div>
      <div className={cx('small', permission === 'full' ? 'note warn' : 'muted')}>{permissionHint(t, permission)}</div>
      {dialog}
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
