import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ChevronDown, ChevronRight, ClipboardList, FolderOpen, GitBranch, Hand, Pencil, ShieldAlert, Square, SquareCheck, Zap, type LucideIcon } from 'lucide-react';
import { Ico } from '../icons';
import type { PermissionLevel, ProviderInfo, WorkflowRun } from '../../../core/src/types';
import { hub } from '../api';
import { useT, type T } from '../i18n';
import { cx, providerName } from '../util';
import { ask } from './Ask';
import { useMenuKeys } from './RunTools';
import { byFolder } from '../timeline';
import { RadioList, useDialogKeys } from './Kit';

export const PERMISSION_ICON: Record<PermissionLevel, LucideIcon> = { plan: ClipboardList, ask: Hand, edit: Pencil, auto: Zap, full: ShieldAlert };

const LEVELS: PermissionLevel[] = ['plan', 'ask', 'edit', 'auto', 'full'];

/**
 * Whether a list that opens upwards from a composer control (the permission and advisor menus) must open downwards
 * instead: when the room above it, inside the scrolling page that holds it (the new chat's page, its composer near the
 * top), is smaller than the list and there is more room below. Measured once it is drawn, and again on `again`.
 */
export function useOpensDown(open: boolean, menu: RefObject<HTMLElement | null>, again?: unknown): boolean {
  const [down, setDown] = useState(false);
  useLayoutEffect(() => {
    const el = menu.current;
    const anchor = el?.parentElement;
    if (!open || !el || !anchor) return setDown(false);
    let top = 0;
    let bottom = window.innerHeight;
    for (let p = anchor.parentElement; p; p = p.parentElement) {
      if (getComputedStyle(p).overflowY === 'visible') continue;
      const r = p.getBoundingClientRect();
      top = Math.max(top, r.top);
      bottom = Math.min(bottom, r.bottom);
      break;
    }
    const a = anchor.getBoundingClientRect();
    const above = a.top - top;
    const below = bottom - a.bottom;
    setDown(above < el.offsetHeight + 6 && below > above);
  }, [open, again]); // eslint-disable-line react-hooks/exhaustive-deps
  return down;
}

export const permissionLabel = (t: T, p: PermissionLevel) =>
  ({ plan: t('唯讀規劃', 'Plan (read-only)'), ask: t('手動核准', 'Ask me'), edit: t('自動編輯', 'Auto-edit'), auto: t('全自動', 'Full auto'), full: t('完整電腦存取', 'Whole computer') })[p];

const permissionHint = (t: T, p: PermissionLevel) =>
  ({
    plan: t('只能讀檔與規劃，不改檔、不執行有副作用的指令。', 'Read and plan only: no file changes, no side-effect commands.'),
    ask: t('每次改檔或執行指令都會在這裡詢問你。', 'Every file change or command asks you here first.'),
    edit: t('自動允許工作資料夾內的編輯，執行指令依各家沙箱限制或被擋下。', 'Edits in the working folder are auto-approved; commands are sandboxed or blocked per provider.'),
    auto: t('全部自動核准。Codex 只能寫入工作資料夾，其他 CLI 的工具與指令仍可能改到資料夾外的檔案，建議搭配隔離模式。', "Everything auto-approved. Codex can only write in the working folder; other CLIs' tools and commands may still change files outside it. Pair it with isolation."),
    full: t('AI 可以讀寫整台電腦的檔案、執行任何指令，Codex 的沙箱也會拿掉。只對這段對話有效，對外動作仍要你核准。', "The AI may read and change files anywhere on this computer and run any command (Codex's sandbox is removed). This conversation only; outside actions still need your OK."),
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
  const box = useRef<HTMLDivElement>(null);
  // Esc cancels, Tab and Shift+Tab stay in it, and the focus goes back to the option that asked (the shared dialog keys).
  useDialogKeys(box, onCancel);
  return (
    <div className="modal-back" onMouseDown={onCancel}>
      <div ref={box} tabIndex={-1} className="modal full-confirm" role="alertdialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <h3><Ico i={ShieldAlert} size={18} /> {t('開啟完整電腦存取？', 'Allow whole-computer access?')}</h3>
        <p>{t('這段對話中的 AI 將可以：', 'In this conversation the AI will be able to:')}</p>
        <ul>
          <li>{t('讀取、修改、刪除電腦上任何檔案，不只工作資料夾', 'read, change and delete any file on this computer, not just the working folder')}</li>
          <li>{t('執行任何指令與程式，Codex 的沙箱也會拿掉', 'run any command or program (Codex’s sandbox is removed too)')}</li>
        </ul>
        <p className="muted small">
          {t(
            '仍然有效：計畫者、審查者、顧問維持唯讀；推送、PR、發布等對外動作要你核准；AI 被要求不碰登入憑證與系統設定、外部改動要列在回報中。這些要求是規則，不是技術上的鎖；隔離模式也只保護工作資料夾。只對這段對話有效，新對話會回到全自動。',
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
            <Ico i={ShieldAlert} /> {t('開啟', 'Allow')}
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
      <Ico i={ShieldAlert} /> {t('完整電腦存取：這段對話的 AI 可以讀寫整台電腦的檔案、執行任何指令。', 'Whole-computer access: the AI in this conversation may change files anywhere on this computer and run any command.')}
    </div>
  );
}

/** Files agents changed outside the working folder and the extra folders, from their file tools. */
export function OutsideChanges({ run }: { run: WorkflowRun }) {
  const t = useT();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const files = run.outsideChanges ?? [];
  if (!files.length) return null;
  // By folder: the warning stays, the file names one click away.
  const groups = byFolder(files);
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
  const goal = norm(run.config.goal);
  return (
    <div className="decision outside-changes">
      <div className="decision-q">
        <Ico i={FolderOpen} /> {t(`工作資料夾外有 ${files.length} 筆寫檔工具紀錄`, `${files.length} file-tool write(s) outside the working folder`)}
        {groups.length > 1 && <span className="muted small">{t(`，${groups.length} 個資料夾`, `, ${groups.length} folders`)}</span>}
      </div>
      <div className="outside-groups">
        {groups.map((g) => (
          <div key={g.dir} className="outside-group">
            <button type="button" className="link mono small" title={g.dir} aria-expanded={open.has(g.dir)} onClick={() => setOpen((s) => new Set(s.has(g.dir) ? [...s].filter((x) => x !== g.dir) : [...s, g.dir]))}>
              <Ico i={open.has(g.dir) ? ChevronDown : ChevronRight} size={14} /> {g.label} · {t(`${g.files.length} 個檔案`, `${g.files.length} file(s)`)}
            </button>
            {/* Only a hint: the request's own text names this folder (Aivenue does not know it was meant as the output). */}
            {g.dir && goal.includes(norm(g.dir)) && <span className="badge muted">{t('任務文字提到這個資料夾', 'named in the request')}</span>}
            {open.has(g.dir) && (
              <div className="mono small outside-files">
                <div className="muted">{g.dir}</div>
                {g.files.map((f) => (
                  <div key={f}>{f}</div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="muted tiny">
        {t('由 agent 的寫檔工具記錄，用終端指令改的檔案不一定列得出來。', 'Recorded from the agents’ file tools; files changed through shell commands may be missing.')}
      </div>
    </div>
  );
}

/**
 * How much a permission level can do beyond the working folder, as its colour: whole-computer access is red; full auto
 * without isolation (everything approved, and CLIs other than Codex may write outside the folder) is amber. Read-only,
 * ask, auto-edit, and full auto in an isolated copy stay neutral, whether or not they are the default.
 */
export const permissionRisk = (p: PermissionLevel, isolation: boolean): '' | 'warn' | 'err' => (p === 'full' ? 'err' : p === 'auto' && !isolation ? 'warn' : '');

/**
 * Composer control showing the permission level in words, coloured by what it can do (permissionRisk); opens a pick-list
 * (or the settings window when read-only). The list is a menu: the focus goes to the level in use, the arrows move,
 * Esc closes it and gives the focus back.
 */
export function PermissionButton({ permission, isolation, onChange, onOpen }: { permission: PermissionLevel; isolation: boolean; onChange?: (v: { permission?: PermissionLevel; isolation?: boolean }) => void; onOpen: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
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
  useMenuKeys(open, list, btn, () => setOpen(false));
  const down = useOpensDown(open, list);
  const label = `${t('權限', 'Permissions')}：${permissionLabel(t, permission)}${isolation ? ` · ${t('隔離模式', 'Isolation')}` : ''}`;
  return (
    <span className="perm-wrap" ref={ref}>
      <button
        ref={btn}
        className={cx('wf-ctl perm-btn', permissionRisk(permission, isolation))}
        title={label}
        aria-label={label}
        aria-haspopup={onChange ? 'menu' : 'dialog'}
        aria-expanded={onChange ? open : undefined}
        onClick={() => (onChange ? setOpen(!open) : onOpen())}
      >
        <Ico i={PERMISSION_ICON[permission]} size={16} /> <span className="perm-label">{permissionLabel(t, permission)}</span>
        {isolation && <Ico i={GitBranch} size={14} />}
        {onChange && <Ico i={ChevronDown} size={14} className="wf-chev" />}
      </button>
      {open && onChange && (
        <div className={cx('perm-menu', down && 'down')} role="menu" aria-label={t('權限', 'Permissions')} ref={list}>
          {LEVELS.map((p) => (
            <button
              key={p}
              role="menuitemradio"
              tabIndex={-1}
              aria-checked={p === permission}
              className={cx('perm-item', p === permission && 'on', p === 'full' && 'danger')}
              onClick={() => {
                pick(p);
                setOpen(false);
                btn.current?.focus();
              }}
            >
              <Ico i={PERMISSION_ICON[p]} size={16} className="perm-item-icon" />
              <span>
                <span className="perm-item-title">{permissionLabel(t, p)}</span>
                <span className="perm-item-hint">{permissionHint(t, p)}</span>
              </span>
            </button>
          ))}
          <button type="button" role="menuitemcheckbox" tabIndex={-1} aria-checked={isolation} className={cx('perm-item perm-iso', isolation && 'on')} onClick={() => onChange({ isolation: !isolation })}>
            <Ico i={GitBranch} size={16} className="perm-item-icon" />
            <span>
              <span className="perm-item-title">{t('隔離模式', 'Isolation')}</span>
              <span className="perm-item-hint">{t('在隔離副本中工作', 'Work in an isolated copy')}</span>
            </span>
            <Ico i={isolation ? SquareCheck : Square} size={16} className="perm-iso-box" />
          </button>
        </div>
      )}
      {dialog}
    </span>
  );
}

/**
 * Permission level + isolation controls (the workflow settings window): the five levels one under the other, each with
 * its icon, name (in its risk colour, as on the composer) and what it allows, the chosen one a filled radio; isolation
 * as a check box right under them. Whole-computer access, once chosen, says what it allows in a warning box.
 */
export function SafetySection({ permission, isolation, providers, roleProviders, onChange, disabled, isolationLocked }: { permission: PermissionLevel; isolation: boolean; providers: ProviderInfo[]; roleProviders: string[]; onChange: (v: { permission?: PermissionLevel; isolation?: boolean }) => void; disabled?: boolean; isolationLocked?: boolean }) {
  const t = useT();
  const titleId = useId();
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
      <h4 className="sect-title" id={titleId}>
        {t('權限與安全', 'Permissions & safety')}
      </h4>
      <RadioList
        className="perm-radio"
        labelledBy={titleId}
        value={permission}
        disabled={disabled}
        onChange={pick}
        choices={LEVELS.map((p) => ({ value: p, icon: PERMISSION_ICON[p], label: permissionLabel(t, p), hint: p === 'full' && permission === 'full' ? undefined : permissionHint(t, p), tone: permissionRisk(p, isolation) }))}
      />
      {/* Whole-computer access chosen: what it allows is a warning under the list, framed as before round C (said once). */}
      {permission === 'full' && <div className="note warn small">{permissionHint(t, 'full')}</div>}
      {dialog}
      {notes.map((n, i) => (
        <div key={i} className="note warn small">
          {n}
        </div>
      ))}
      <label className="check iso-check">
        <input type="checkbox" disabled={disabled || isolationLocked} checked={isolation} onChange={(e) => onChange({ isolation: e.target.checked })} />
        <span>
          {t('隔離模式', 'Isolation')}
          <span className="muted small" title={t('隔離副本是 git worktree，需要 git 專案。', 'The isolated copy is a git worktree; it needs a git repo.')}> {t('在隔離副本中工作，完成後再決定是否套用，需要 git 專案', 'work in an isolated copy and decide afterwards whether to apply; needs a git repo')}</span>
        </span>
      </label>
    </section>
  );
}

/** Pending approvals ("ask" level) for a run. */
/**
 * Actions waiting for the user's approval. With `agentId`: that agent's, shown in its card beside its work; with
 * `unclaimed`: those no card of this message shows (an agent of another message, or one not listed).
 */
export function Approvals({ run, providers, agentId, unclaimed }: { run: WorkflowRun; providers: ProviderInfo[]; agentId?: string; unclaimed?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState<string>();
  const list = (run.approvals ?? []).filter((a) => (agentId ? a.agentId === agentId : unclaimed ? !run.agents[a.agentId] : true));
  if (!list.length) return null;
  const decide = (approvalId: string, decision: 'allow' | 'always' | 'deny') => hub.call('workflows.approve', { id: run.id, approvalId, decision }).catch(() => undefined);
  return (
    <div className="approvals">
      {list.map((a) => (
        <div key={a.id} className="approval">
          <div className="approval-q">
            <Ico i={Hand} /> {t(`${providerName(providers, a.provider)} 想要執行`, `${providerName(providers, a.provider)} wants to run`)} <b>{a.tool}</b>
          </div>
          <div className="approval-summary mono">{a.summary}</div>
          {a.input && (
            <button type="button" className="link" aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? undefined : a.id)}>
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
  if (wt.state !== 'active') return <div className="note"><Ico i={GitBranch} /> {wt.note}</div>;
  if (!finished) return null;
  const act = async (action: 'apply' | 'keep' | 'discard') => {
    if (action === 'discard' && !(await ask(t('捨棄隔離副本中的所有變更？', 'Discard all changes in the isolated copy?'), { danger: true }))) return;
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
      <div className="decision-q"><Ico i={GitBranch} /> {t('這次的變更在隔離副本中，要怎麼處理？', 'The changes are in an isolated copy. What should happen to them?')}</div>
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
