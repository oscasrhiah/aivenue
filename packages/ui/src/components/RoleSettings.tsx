import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AdvisorConfig, AssignmentResult, AutoAssignPrefs, ContextSharing, PermissionLevel, ProviderInfo, RoleConfig, StageConfig, WorkflowConfig, WorkflowPreset } from '../../../core/src/types';
import { ModelPicker } from './ModelPicker';
import { PERMISSION_ICON, PermissionButton, permissionLabel, SafetySection } from './Safety';
import { hub } from '../api';
import { useT } from '../i18n';
import { cx, providerColor, providerName } from '../util';

export type RoleDraft = Omit<WorkflowConfig, 'goal' | 'title'>;

export function defaultDraft(providers: ProviderInfo[], cwd = ''): RoleDraft {
  const ready = providers.filter((p) => p.installed && p.auth.state === 'logged_in').map((p) => p.spec.id);
  const ids = ready.length ? ready : providers.filter((p) => p.installed).map((p) => p.spec.id);
  const author = ids.includes('claude') ? 'claude' : ids[0] ?? 'claude';
  const reviewer = ids.includes('codex') && author !== 'codex' ? 'codex' : ids.find((x) => x !== author) ?? author;
  const stage = (): StageConfig => ({ enabled: true, author: { provider: author }, reviewer: { provider: reviewer }, maxRounds: 3, humanGate: false });
  return {
    cwd,
    plan: stage(),
    implement: stage(),
    subagents: { enabled: true, allowed: ids, maxDepth: 1, maxConcurrent: 2 },
    assignment: { mode: 'auto', auto: DEFAULT_AUTO },
  };
}

export const DEFAULT_AUTO: AutoAssignPrefs = { priority: 'balanced', crossReview: true, failover: true };

export const isAuto = (d: RoleDraft) => d.assignment?.mode === 'auto';

/** Live preview of what auto mode would pick right now. */
export function useAssignPreview(draft: RoleDraft | null, providers: ProviderInfo[]): { result?: AssignmentResult; error?: string } {
  const [state, setState] = useState<{ result?: AssignmentResult; error?: string }>({});
  const key = JSON.stringify([draft?.assignment, providers.map((p) => [p.spec.id, p.auth.state, p.installed])]);
  useEffect(() => {
    if (!draft || !isAuto(draft)) return setState({});
    let alive = true;
    hub
      .call<AssignmentResult>('assign.preview', { config: { assignment: draft.assignment } })
      .then((result) => alive && setState({ result }))
      .catch((e) => alive && setState({ error: e.message }));
    return () => {
      alive = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

function Dot({ id }: { id: string }) {
  return <span className="mark" style={{ background: providerColor(id) }} />;
}

/**
 * Workflow summary in the composer. Full pills when there is room; otherwise (and always when `compact`, e.g. in VS Code)
 * just a permission button and a role-settings button that opens the settings window.
 */
export function RolePills({ draft, providers, onOpen, preview, compact, onSafety, onAdvisor }: { draft: RoleDraft; providers: ProviderInfo[]; onOpen: () => void; preview?: AssignmentResult; compact?: boolean; onSafety?: (v: { permission?: PermissionLevel; isolation?: boolean }) => void; onAdvisor?: (v: AdvisorConfig) => void }) {
  const t = useT();
  const name = (id: string) => providerName(providers, id);
  const auto = isAuto(draft);
  // Before the run starts, auto mode shows what it would pick now; afterwards the config holds the real picks.
  const view = (s: StageConfig, who?: { author?: string; reviewer?: string }): StageConfig =>
    preview && who ? { ...s, author: { provider: who.author ?? s.author.provider }, reviewer: s.reviewer && { provider: who.reviewer ?? s.reviewer.provider } } : s;
  const plan = view(draft.plan, preview?.plan);
  const implement = view(draft.implement, preview?.implement);
  const subs = preview?.subagents ?? draft.subagents.allowed;
  const priority = { quality: t('品質優先', 'Quality'), balanced: t('平衡', 'Balanced'), economy: t('省額度', 'Economy') }[draft.assignment?.auto.priority ?? 'balanced'];
  const permission = draft.permission ?? 'auto';
  const stage = (label: string, s: StageConfig) => `${label}：${s.enabled ? [s.author.provider, s.reviewer?.provider].filter((x): x is string => !!x).map(name).join(' → ') : t('略過', 'skip')}`;
  // Everything lives in the settings window; the button carries just a hint and the full summary as a tooltip.
  const details = [
    `${t('資料夾', 'Folder')}：${draft.cwd || t('未選擇', 'none')}`,
    `${t('權限', 'Permissions')}：${permissionLabel(t, permission)}${draft.isolation === 'worktree' ? ` · ${t('隔離', 'isolated')}` : ''}`,
    auto ? `${t('自動指派', 'Auto assignment')} · ${priority}` : '',
    stage(t('計畫', 'Plan'), plan),
    stage(t('實作', 'Build'), implement),
    `Sub agents：${draft.subagents.enabled ? subs.map(name).join(', ') || '—' : t('關閉', 'off')}`,
  ].filter(Boolean);
  const short =
    (auto ? `✦ ${t('自動指派', 'Auto')}` : implement.enabled ? name(implement.author.provider) : name(plan.author.provider)) +
    (!plan.enabled && implement.enabled ? ` · ${t('直接實作', 'no plan')}` : '');
  const pair = (s: StageConfig) => [s.author.provider, s.reviewer?.provider].filter((x): x is string => !!x).map(name).join(' → ');
  const long = [
    auto ? `✦ ${t('自動指派', 'Auto')} · ${priority}` : '',
    plan.enabled ? `${t('計畫', 'Plan')} ${pair(plan)}` : t('不規劃', 'No plan'),
    implement.enabled ? `${t('實作', 'Build')} ${pair(implement)}` : '',
    draft.subagents.enabled && subs.length ? t(`${subs.length} 個 sub agent`, `${subs.length} sub-agents`) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const folder = draft.cwd ? draft.cwd.split(/[\\/]/).filter(Boolean).slice(-1)[0] : t('選擇資料夾', 'Choose folder');
  // One tidy row: folder, permission, role summary. Narrow composers (and VS Code) drop the folder and shorten the summary.
  return (
    <span className={cx('wf-bar', compact && 'compact')}>
      <button className="pill-btn wf-folder" onClick={onOpen} title={draft.cwd}>
        📁 {folder}
      </button>
      <PermissionButton permission={permission} isolation={draft.isolation === 'worktree'} onChange={onSafety} onOpen={onOpen} />
      <AdvisorButton value={draft.advisor ?? { mode: 'off' }} providers={providers} onChange={onAdvisor} onOpen={onOpen} />
      <button className="pill-btn wf-btn" onClick={onOpen} title={details.join('\n')}>
        <span className="wf-gear">⚙</span>
        <span className="wf-hint wf-long">{long}</span>
        <span className="wf-hint wf-short">{short}</span>
      </button>
    </span>
  );
}

function ProviderSelect({ value, providers, onChange, disabled }: { value: RoleConfig | null; providers: ProviderInfo[]; onChange: (v: RoleConfig | null) => void; disabled?: boolean }) {
  const t = useT();
  const info = providers.find((p) => p.spec.id === value?.provider);
  const inherit = info?.defaultModel || info?.defaultEffort ? t(`供應商預設（${[info.defaultModel, info.defaultEffort].filter(Boolean).join(' · ')}）`, `Provider default (${[info.defaultModel, info.defaultEffort].filter(Boolean).join(' · ')})`) : undefined;
  return (
    <div className="role-pick">
      <select disabled={disabled} value={value?.provider ?? ''} onChange={(e) => onChange(e.target.value ? { provider: e.target.value } : null)}>
        {providers.map((p) => (
          <option key={p.spec.id} value={p.spec.id}>
            {p.spec.name}
            {p.auth.state === 'logged_in' ? '' : p.installed ? t('（未登入）', ' (signed out)') : t('（未安裝）', ' (not installed)')}
          </option>
        ))}
      </select>
      {value && <ModelPicker provider={info} model={value.model} effort={value.effort} disabled={disabled} inheritLabel={inherit} inheritEffort={info?.defaultEffort} onChange={(v) => onChange({ ...value, ...v })} />}
    </div>
  );
}

function StageSection({ title, hint, authorLabel, reviewerLabel, stage, providers, onChange, disabled, auto }: { title: string; hint: string; authorLabel: string; reviewerLabel: string; stage: StageConfig; providers: ProviderInfo[]; onChange: (s: StageConfig) => void; disabled?: boolean; auto?: boolean }) {
  const t = useT();
  return (
    <section className="sect">
      <div className="sect-head">
        <div>
          <div className="sect-title">{title}</div>
          <div className="muted small">{hint}</div>
        </div>
        <label className="switch">
          <input type="checkbox" disabled={disabled} checked={stage.enabled} onChange={(e) => onChange({ ...stage, enabled: e.target.checked })} />
          <span />
        </label>
      </div>
      {stage.enabled && (
        <div className="sect-body">
          {!auto && (
            <div className="kv">
              <label>{authorLabel}</label>
              <ProviderSelect disabled={disabled} value={stage.author} providers={providers} onChange={(v) => v && onChange({ ...stage, author: v })} />
            </div>
          )}
          <div className="sub-switch">
            <div>
              <div>{reviewerLabel}</div>
              <div className="muted tiny">{t('由另一家 agent 審查，有問題就退回修改，直到通過', 'Another agent reviews and sends it back until it passes')}</div>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                disabled={disabled}
                checked={stage.reviewer !== null}
                onChange={(e) => {
                  // Default to a different vendor than the author.
                  const other = providers.find((p) => p.spec.id !== stage.author.provider && p.installed && p.auth.state === 'logged_in')?.spec.id ?? stage.author.provider;
                  onChange({ ...stage, reviewer: e.target.checked ? { provider: other } : null });
                }}
              />
              <span />
            </label>
          </div>
          {!auto && stage.reviewer && (
            <div className="kv">
              <label>{t('審查者', 'Reviewer')}</label>
              <ProviderSelect disabled={disabled} value={stage.reviewer} providers={providers} onChange={(v) => v && onChange({ ...stage, reviewer: v })} />
            </div>
          )}
          {stage.reviewer && (
            <div className="kv">
              <label>{t('最多來回', 'Max rounds')}</label>
              <input disabled={disabled} type="number" min={1} max={20} value={stage.maxRounds} onChange={(e) => onChange({ ...stage, maxRounds: Math.max(1, Number(e.target.value) || 1) })} />
            </div>
          )}
          <label className="check">
            <input disabled={disabled} type="checkbox" checked={stage.humanGate} onChange={(e) => onChange({ ...stage, humanGate: e.target.checked })} />
            {t('審查通過後先問我', 'Ask me after approval')}
          </label>
        </div>
      )}
    </section>
  );
}

const advisorModeLabel = (t: ReturnType<typeof useT>, m: AdvisorConfig['mode']) => ({ off: t('關閉', 'Off'), claude: t('Claude 原生', 'Claude native'), cross: t('跨家顧問', 'Cross-vendor') })[m];

const advisorModeHint = (t: ReturnType<typeof useT>, m: AdvisorConfig['mode']) =>
  ({
    off: t('不使用顧問。', 'No advisor.'),
    claude: t('只對 Claude Code 的 agent 生效：使用 Claude 官方的 advisor，由 Claude 自己決定何時請教更強的模型。建議內容是加密的，看不到。', "Only for Claude Code agents: Claude's official advisor, which decides on its own when to consult a stronger model. The advice is encrypted and not shown."),
    cross: t('agent 真的卡住時才呼叫 ask_advisor，請教你指定的模型（可以跨家，例如 Codex 做事、Claude Opus 當顧問）。顧問只負責判斷：查資料交給 sub agent，建議會顯示在對話中並記進共用筆記。', "Agents call ask_advisor only when truly stuck, consulting the model you pick (cross-vendor, e.g. Codex works while Claude Opus advises). The advisor only judges: sub-agents fetch the facts. The advice shows in the conversation and becomes a shared note."),
  })[m];

/** Picking a mode fills in sensible defaults (Opus for Claude's advisor; a signed-in provider, Claude first, for cross mode). */
function withMode(value: AdvisorConfig, m: AdvisorConfig['mode'], providers: ProviderInfo[]): AdvisorConfig {
  const ready = providers.filter((p) => p.installed && p.auth.state === 'logged_in');
  const defaultAdvisor = ready.find((p) => p.spec.id === 'claude')?.spec.id ?? ready[0]?.spec.id;
  return { ...value, mode: m, provider: m === 'cross' ? value.provider ?? defaultAdvisor : value.provider, claudeModel: value.claudeModel ?? 'opus' };
}

/** Mode-specific options: Claude's advisor model, or who advises and how often. */
function AdvisorOptions({ value, onChange, providers, disabled }: { value: AdvisorConfig; onChange: (v: AdvisorConfig) => void; providers: ProviderInfo[]; disabled?: boolean }) {
  const t = useT();
  if (value.mode === 'claude')
    return (
      <div className="kv">
        <label>{t('顧問模型', 'Advisor model')}</label>
        <select disabled={disabled} value={value.claudeModel ?? 'opus'} onChange={(e) => onChange({ ...value, claudeModel: e.target.value })}>
          <option value="opus">Opus</option>
          <option value="fable">Fable</option>
          <option value="sonnet">Sonnet</option>
        </select>
      </div>
    );
  if (value.mode === 'cross')
    return (
      <>
        <div className="kv">
          <label>{t('顧問', 'Advisor')}</label>
          <ProviderSelect
            disabled={disabled}
            value={value.provider ? { provider: value.provider, model: value.model, effort: value.effort } : null}
            providers={providers}
            onChange={(v) => v && onChange({ ...value, provider: v.provider, model: v.model, effort: v.effort })}
          />
        </div>
        <div className="kv">
          <label>{t('最多請教', 'Max calls')}</label>
          <input disabled={disabled} type="number" min={1} max={20} value={value.maxCalls ?? 5} onChange={(e) => onChange({ ...value, maxCalls: Math.max(1, Number(e.target.value) || 1) })} />
        </div>
        <div className="muted tiny">{t('每段對話的請教次數上限。', 'Consultations allowed per conversation.')}</div>
        <FactRounds value={value} onChange={onChange} disabled={disabled} />
      </>
    );
  return null;
}

/**
 * How many rounds of sub-agent fact-finding the advisor goes through before it may read the code itself:
 * the default (3), a number of the user's own, or unlimited (sub-agents only).
 */
function FactRounds({ value, onChange, disabled }: { value: AdvisorConfig; onChange: (v: AdvisorConfig) => void; disabled?: boolean }) {
  const t = useT();
  const kind = value.factRounds === undefined ? 'default' : value.factRounds === 0 ? 'unlimited' : 'custom';
  return (
    <>
      <div className="kv">
        <label>{t('查證輪數', 'Fact-finding rounds')}</label>
        <div className="row gap">
          <select
            disabled={disabled}
            value={kind}
            onChange={(e) => onChange({ ...value, factRounds: e.target.value === 'default' ? undefined : e.target.value === 'unlimited' ? 0 : value.factRounds || 5 })}
          >
            <option value="default">{t('預設（3 輪）', 'Default (3 rounds)')}</option>
            <option value="custom">{t('自訂輪數', 'Custom')}</option>
            <option value="unlimited">{t('無限', 'Unlimited')}</option>
          </select>
          {kind === 'custom' && (
            <input
              disabled={disabled}
              type="number"
              min={1}
              max={50}
              value={value.factRounds}
              onChange={(e) => onChange({ ...value, factRounds: Math.min(50, Math.max(1, Math.round(Number(e.target.value)) || 1)) })}
            />
          )}
        </div>
      </div>
      <div className="muted tiny">
        {kind === 'unlimited'
          ? t('顧問永遠不自己讀檔，資料一律由 sub agent 查，回報不夠就一直派到查清楚為止。', 'The advisor never reads the code itself: sub-agents fetch every fact, sent again until the facts are solid.')
          : t(
              `顧問先派 sub agent 查資料，回報不夠就再派；連續 ${value.factRounds || 3} 輪都查不到需要的資訊時，才自己讀那幾個檔案。`,
              `The advisor sends sub-agents to fetch facts and sends them again when a report falls short; only after ${value.factRounds || 3} rounds without the fact it needs does it read those files itself.`,
            )}
      </div>
    </>
  );
}

/** Advisor switch right in the composer, so it is seen without opening the settings window. */
export function AdvisorButton({ value, providers, onChange, onOpen }: { value: AdvisorConfig; providers: ProviderInfo[]; onChange?: (v: AdvisorConfig) => void; onOpen: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
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
  // In a narrow panel (VS Code's sidebar) the menu would run past the right edge: move it left to fit.
  useLayoutEffect(() => {
    if (!open || !menu.current) return setShift(0);
    const r = menu.current.getBoundingClientRect();
    const over = r.right - shift - (document.documentElement.clientWidth - 8);
    setShift(over > 0 ? Math.min(over, r.left - shift - 8) : 0);
  }, [open, value.mode]);
  const who =
    value.mode === 'claude'
      ? `Claude · ${(value.claudeModel ?? 'opus').replace(/^./, (c) => c.toUpperCase())}`
      : value.mode === 'cross'
        ? [value.provider && providerName(providers, value.provider), value.model].filter(Boolean).join(' · ') || t('未選擇', 'not set')
        : t('關閉', 'off');
  return (
    <span className="perm-wrap" ref={ref}>
      <button className={cx('pill-btn adv-btn', value.mode !== 'off' && 'on')} title={`${t('顧問模式', 'Advisor')}：${advisorModeLabel(t, value.mode)}`} onClick={() => (onChange ? setOpen(!open) : onOpen())}>
        💡 <span className="adv-label">{t('顧問', 'Advisor')}</span>
        <span className="adv-who">{who}</span>
      </button>
      {open && onChange && (
        <div className="perm-menu adv-menu" role="menu" ref={menu} style={shift ? { left: -shift } : undefined}>
          {(['off', 'claude', 'cross'] as const).map((m) => (
            <button key={m} role="menuitemradio" aria-checked={m === value.mode} className={cx('perm-item', m === value.mode && 'on')} onClick={() => onChange(withMode(value, m, providers))}>
              <span className="perm-item-icon">{{ off: '○', claude: '✳', cross: '⇄' }[m]}</span>
              <span>
                <span className="perm-item-title">{advisorModeLabel(t, m)}</span>
                <span className="perm-item-hint">{advisorModeHint(t, m)}</span>
              </span>
            </button>
          ))}
          {value.mode !== 'off' && (
            <div className="adv-options">
              <AdvisorOptions value={value} onChange={onChange} providers={providers} />
            </div>
          )}
        </div>
      )}
    </span>
  );
}

/** Advisor mode: off, Claude Code's own advisor, or Aivenue's cross-vendor ask_advisor. */
function AdvisorSection({ value, onChange, providers, disabled }: { value: AdvisorConfig; onChange: (v: AdvisorConfig) => void; providers: ProviderInfo[]; disabled?: boolean }) {
  const t = useT();
  return (
    <section className="sect">
      <div className="sect-title">{t('顧問模式', 'Advisor')}</div>
      <div className="seg wide">
        {(['off', 'claude', 'cross'] as const).map((m) => (
          <button key={m} disabled={disabled} className={cx(value.mode === m && 'on')} onClick={() => onChange(withMode(value, m, providers))}>
            {advisorModeLabel(t, m)}
          </button>
        ))}
      </div>
      <div className="muted small">{advisorModeHint(t, value.mode)}</div>
      <AdvisorOptions value={value} onChange={onChange} providers={providers} disabled={disabled} />
    </section>
  );
}

/** Model / effort each provider uses when it runs as a sub-agent. */
function SubagentModels({ providers, models, onChange, disabled }: { providers: ProviderInfo[]; models: Record<string, { model?: string; effort?: string }>; onChange: (m: Record<string, { model?: string; effort?: string }>) => void; disabled?: boolean }) {
  const t = useT();
  if (!providers.length) return null;
  return (
    <div className="sub-models">
      <div className="muted small">{t('當 sub agent 時使用的模型（不選就用供應商預設；指定後呼叫的 agent 也不能更改）', 'Model when used as a sub-agent (empty = provider default; once set, the calling agent cannot change it)')}</div>
      {providers.map((p) => {
        const v = models[p.spec.id] ?? {};
        const inherit = p.defaultModel || p.defaultEffort ? t(`供應商預設（${[p.defaultModel, p.defaultEffort].filter(Boolean).join(' · ')}）`, `Provider default (${[p.defaultModel, p.defaultEffort].filter(Boolean).join(' · ')})`) : undefined;
        return (
          <div key={p.spec.id} className="kv">
            <label className="row gap-s">
              <Dot id={p.spec.id} />
              {p.spec.name}
            </label>
            <ModelPicker
              provider={p}
              model={v.model}
              effort={v.effort}
              disabled={disabled}
              inheritLabel={inherit}
              inheritEffort={p.defaultEffort}
              onChange={(next) => {
                const merged = { ...v, ...next };
                const rest = { ...models };
                if (merged.model || merged.effort) rest[p.spec.id] = merged;
                else delete rest[p.spec.id];
                onChange(rest);
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

export function RoleSettings({
  draft,
  providers,
  onChange,
  onClose,
  readOnly,
  canPickFolder,
  onReuse,
  notice,
  lockFolder,
}: {
  draft: RoleDraft;
  providers: ProviderInfo[];
  onChange: (d: RoleDraft) => void;
  onClose: () => void;
  readOnly?: boolean;
  canPickFolder: boolean;
  onReuse?: () => void;
  /** When the changes take effect (shown inside a conversation). */
  notice?: string;
  /** Folder and isolation cannot change once a run started. */
  lockFolder?: boolean;
}) {
  const t = useT();
  const [presets, setPresets] = useState<WorkflowPreset[]>([]);
  const [presetName, setPresetName] = useState('');
  useEffect(() => {
    hub.call<WorkflowPreset[]>('presets.list').then(setPresets).catch(() => undefined);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const set = (patch: Partial<RoleDraft>) => onChange({ ...draft, ...patch });
  const sub = draft.subagents;
  const auto = isAuto(draft) && !readOnly;
  const prefs = draft.assignment?.auto ?? DEFAULT_AUTO;
  const setPrefs = (patch: Partial<AutoAssignPrefs>) => set({ assignment: { mode: 'auto', auto: { ...prefs, ...patch } } });
  const preview = useAssignPreview(readOnly ? null : draft, providers);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal wf-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head wf-modal-head">
          <h3>{notice || readOnly ? t('這段對話的設定', 'Settings of this conversation') : t('工作流設定', 'Workflow settings')}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="close">
            ✕
          </button>
        </div>
        {notice && <div className="note small">{notice}</div>}

        {!readOnly && (
          <div className="seg wide">
            <button className={cx(auto && 'on')} onClick={() => set({ assignment: { mode: 'auto', auto: prefs } })}>
              ✦ {t('自動指派', 'Auto assign')}
            </button>
            <button className={cx(!auto && 'on')} onClick={() => set({ assignment: { mode: 'manual', auto: prefs } })}>
              {t('自訂指派', 'Choose myself')}
            </button>
          </div>
        )}
        {readOnly && isAuto(draft) && <div className="muted small">✦ {t('這段對話使用自動指派，以下是實際分配到的供應商。', 'This conversation used auto assignment; these are the providers it picked.')}</div>}

        {auto && (
          <section className="sect">
            <div className="sect-title">{t('自動指派偏好', 'Auto assignment')}</div>
            <div className="seg">
              {(['quality', 'balanced', 'economy'] as const).map((p) => (
                <button key={p} className={cx(prefs.priority === p && 'on')} onClick={() => setPrefs({ priority: p })}>
                  {p === 'quality' ? t('品質優先', 'Quality') : p === 'balanced' ? t('平衡', 'Balanced') : t('省額度', 'Economy')}
                </button>
              ))}
            </div>
            <div className="muted small">
              {prefs.priority === 'quality'
                ? t('每個角色都找能力最強的一家，即使同一家負責多個角色。', 'Strongest provider for each role, even if one does several.')
                : prefs.priority === 'balanced'
                  ? t('兼顧能力，並把角色分散給不同家，額度不會集中燒在同一家。', 'Strong providers, spread across vendors so no single quota burns out.')
                  : t('偏好速度快、額度寬鬆的供應商。', 'Prefer fast providers with generous limits.')}
            </div>
            <label className="check">
              <input type="checkbox" checked={prefs.crossReview} onChange={(e) => setPrefs({ crossReview: e.target.checked })} />
              {t('審查者一定和撰寫者不同家', 'Reviewer is always a different vendor than the author')}
            </label>
            <label className="check">
              <input type="checkbox" checked={prefs.failover} onChange={(e) => setPrefs({ failover: e.target.checked })} />
              {t('執行失敗或額度用完時，自動換下一家', 'On failure or usage limit, switch to the next provider automatically')}
            </label>
            <div className="assign-preview">
              <div className="block-label">{t('目前會這樣分配', 'Current picks')}</div>
              {preview.error && <div className="err-text small">{preview.error}</div>}
              {preview.result?.notes.map((n, i) => (
                <div key={i} className="small">
                  {n}
                </div>
              ))}
              <div className="muted tiny">{t('實際指派在送出時依當下的登入與額度狀態決定；能力分數可在供應商的「進階設定」調整（profile 欄位）。', 'Final picks are made when you send, based on sign-in and quota at that moment; tune scores in a provider\'s Advanced settings (profile).')}</div>
            </div>
          </section>
        )}

        {!readOnly && presets.length > 0 && (
          <div className="presets">
            {presets.map((p) => (
              <span key={p.id} className="preset">
                <button className="chip-btn" onClick={() => onChange({ ...p.config, cwd: draft.cwd })}>
                  {p.name}
                </button>
                <button className="icon-btn tiny" title={t('刪除', 'Delete')} onClick={() => hub.call<WorkflowPreset[]>('presets.delete', { id: p.id }).then(setPresets)}>
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}

        <SafetySection
          disabled={readOnly}
          permission={draft.permission ?? 'auto'}
          isolation={draft.isolation === 'worktree'}
          providers={providers}
          roleProviders={[draft.plan.author.provider, draft.plan.reviewer?.provider, draft.implement.author.provider, draft.implement.reviewer?.provider].filter((x): x is string => !!x)}
          isolationLocked={lockFolder}
          onChange={(v) => set({ ...(v.permission ? { permission: v.permission } : {}), ...(v.isolation !== undefined ? { isolation: v.isolation ? 'worktree' : 'none' } : {}) })}
        />

        <section className="sect">
          <div className="sect-title">{t('工作資料夾', 'Working folder')}</div>
          <div className="row gap">
            <input disabled={readOnly || lockFolder} className="grow mono" value={draft.cwd} onChange={(e) => set({ cwd: e.target.value })} placeholder="C:\\path\\to\\project" />
            {canPickFolder && !readOnly && !lockFolder && (
              <button
                className="btn"
                onClick={async () => {
                  const p = await hub.call<string | null>('host.pickFolder');
                  if (p) set({ cwd: p });
                }}
              >
                {t('瀏覽…', 'Browse…')}
              </button>
            )}
          </div>
        </section>

        <ExtraDirs disabled={readOnly} dirs={draft.extraDirs ?? []} canPick={canPickFolder} onChange={(extraDirs) => set({ extraDirs })} />

        <StageSection
          disabled={readOnly}
          title={t('計畫', 'Plan')}
          hint={t('一家撰寫計畫，另一家審查，來回修改直到通過。簡單的任務可以關掉，直接實作', 'One agent drafts, another reviews, until approved. Turn it off for simple tasks to go straight to building')}
          authorLabel={t('撰寫', 'Author')}
          reviewerLabel={t('審查計畫', 'Review the plan')}
          stage={draft.plan}
          providers={providers}
          auto={auto}
          onChange={(plan) => set({ plan })}
        />
        <StageSection
          disabled={readOnly}
          title={t('實作', 'Build')}
          hint={t('依計畫實作；可以只做規劃時關掉，只要計畫不要動手', 'Implement the plan; turn it off when you only want a plan')}
          authorLabel={t('實作', 'Implementer')}
          reviewerLabel={t('審查程式碼', 'Review the code')}
          stage={draft.implement}
          providers={providers}
          auto={auto}
          onChange={(implement) => set({ implement })}
        />

        <section className="sect">
          <div className="sect-head">
            <div>
              <div className="sect-title">Sub agents</div>
              <div className="muted small">{t('任何角色都能把子任務交給以下供應商', 'Any role may delegate sub-tasks to these providers')}</div>
            </div>
            <label className="switch">
              <input disabled={readOnly} type="checkbox" checked={sub.enabled} onChange={(e) => set({ subagents: { ...sub, enabled: e.target.checked } })} />
              <span />
            </label>
          </div>
          {sub.enabled && (
            <div className="sect-body">
              {auto ? (
                <div className="muted small">{t('自動：所有可用的供應商都能被調用。', 'Auto: every ready provider can be called.')}</div>
              ) : (
              <div className="row gap wrap">
                {providers.map((p) => (
                  <label key={p.spec.id} className={cx('chip-check', sub.allowed.includes(p.spec.id) && 'on')}>
                    <input
                      disabled={readOnly}
                      type="checkbox"
                      checked={sub.allowed.includes(p.spec.id)}
                      onChange={(e) => set({ subagents: { ...sub, allowed: e.target.checked ? [...sub.allowed, p.spec.id] : sub.allowed.filter((x) => x !== p.spec.id) } })}
                    />
                    <Dot id={p.spec.id} />
                    {p.spec.name}
                  </label>
                ))}
              </div>
              )}
              <SubagentModels
                disabled={readOnly}
                providers={providers.filter((p) => (auto ? p.installed && p.auth.state === 'logged_in' : sub.allowed.includes(p.spec.id)))}
                models={sub.models ?? {}}
                onChange={(models) => set({ subagents: { ...sub, models } })}
              />
              <div className="kv">
                <label>{t('最多巢狀層數', 'Max depth')}</label>
                <input disabled={readOnly} type="number" min={1} max={5} value={sub.maxDepth} onChange={(e) => set({ subagents: { ...sub, maxDepth: Math.max(1, Number(e.target.value) || 1) } })} />
              </div>
              <div className="kv">
                <label>{t('同時執行上限', 'Max concurrent')}</label>
                <input disabled={readOnly} type="number" min={1} max={10} value={sub.maxConcurrent} onChange={(e) => set({ subagents: { ...sub, maxConcurrent: Math.max(1, Number(e.target.value) || 1) } })} />
              </div>
            </div>
          )}
        </section>

        <section className="sect">
          <div className="sect-title">{t('上下文分享', 'Context sharing')}</div>
          <div className="seg wide">
            {(['summary', 'on_demand', 'full'] as ContextSharing[]).map((m) => (
              <button key={m} disabled={readOnly} className={cx((draft.contextSharing ?? 'on_demand') === m && 'on')} onClick={() => set({ contextSharing: m })}>
                {{ summary: t('只交摘要', 'Summaries'), on_demand: t('摘要＋可查閱', 'Summaries + lookup'), full: t('完整紀錄', 'Full transcript') }[m]}
              </button>
            ))}
          </div>
          <div className="muted small">
            {
              {
                summary: t('agent 之間只交接計畫、審查意見與摘要；最省 context。', 'Agents only hand over the plan, reviews and summaries; uses the least context.'),
                on_demand: t('每個 agent 會看到其他人做了什麼與共用筆記，需要時可用 read_context 讀任何人的完整紀錄（回覆、指令與輸出），也能用 post_note 留筆記給後面的人。', 'Each agent sees who did what plus shared notes, can read anyone\'s full transcript (replies, commands, output) with read_context when needed, and can leave notes with post_note.'),
                full: t('另外把上一棒的完整紀錄直接附給下一棒（最多 100 萬字）；細節最完整，但會用掉較多 context 與額度，紀錄很長時可能超過部分模型的 context 上限。', 'Also hands the previous agent\'s full transcript to the next one (up to 1M characters); most detail, but uses more context and quota, and very long transcripts may exceed some models\' context window.'),
              }[draft.contextSharing ?? 'on_demand']
            }
          </div>
        </section>

        <AdvisorSection disabled={readOnly} providers={providers} value={draft.advisor ?? { mode: 'off' }} onChange={(advisor) => set({ advisor })} />

        {!readOnly && (
          <div className="row gap">
            <input className="grow" placeholder={t('存成常用組合，例如「Claude 寫、Codex 審」', 'Save as preset, e.g. "Claude writes, Codex reviews"')} value={presetName} onChange={(e) => setPresetName(e.target.value)} />
            <button
              className="btn"
              disabled={!presetName.trim()}
              onClick={() => {
                const { cwd: _cwd, ...config } = draft;
                hub
                  .call<WorkflowPreset[]>('presets.save', { preset: { id: String(Date.now()), name: presetName.trim(), config } })
                  .then(setPresets)
                  .then(() => setPresetName(''));
              }}
            >
              {t('存成組合', 'Save preset')}
            </button>
          </div>
        )}

        <div className="wf-modal-foot">
          {(readOnly || notice) && onReuse && (
            <button className="btn" onClick={onReuse}>
              {t('用這組設定開新對話', 'New chat with these settings')}
            </button>
          )}
          <button className="btn primary" onClick={onClose}>
            {t('完成', 'Done')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Folders besides the working folder that every agent may read and explore (like Claude Code's --add-dir). */
function ExtraDirs({ dirs, disabled, canPick, onChange }: { dirs: string[]; disabled?: boolean; canPick: boolean; onChange: (dirs: string[]) => void }) {
  const t = useT();
  const [text, setText] = useState('');
  const add = (p: string) => {
    const v = p.trim().replace(/^"(.*)"$/, '$1');
    if (v && !dirs.includes(v)) onChange([...dirs, v]);
    setText('');
  };
  return (
    <section className="sect">
      <div className="sect-title">{t('額外資料夾', 'Extra folders')}</div>
      <div className="muted small">{t('工作資料夾以外，所有 agent 都能讀取和探索的資料夾，例如函式庫原始碼、文件或另一個專案。agent 會把它們當參考資料，不會修改，除非你要求。', 'Folders besides the working folder that every agent may read and explore, e.g. a library\'s source, docs or another project. Agents treat them as reference and leave them unchanged unless you ask.')}</div>
      {dirs.length > 0 && (
        <ul className="extra-dirs">
          {dirs.map((d) => (
            <li key={d}>
              <span className="mono grow" title={d}>
                📁 {d}
              </span>
              {!disabled && (
                <button className="link tiny" onClick={() => onChange(dirs.filter((x) => x !== d))} aria-label={t('移除', 'Remove')}>
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!disabled && (
        <div className="row gap">
          <input className="grow mono" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add(text)} placeholder={t('貼上完整路徑後按 Enter', 'Paste a full path and press Enter')} />
          {text.trim() ? (
            <button className="btn" onClick={() => add(text)}>
              {t('加入', 'Add')}
            </button>
          ) : (
            canPick && (
              <button
                className="btn"
                onClick={async () => {
                  const p = await hub.call<string | null>('host.pickFolder');
                  if (p) add(p);
                }}
              >
                {t('瀏覽…', 'Browse…')}
              </button>
            )
          )}
        </div>
      )}
    </section>
  );
}
