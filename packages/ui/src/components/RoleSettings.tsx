import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AdvisorConfig, AssignmentResult, AutoAssignPrefs, ContextConfig, ContextSharing, LimitsConfig, PermissionLevel, PreflightItem, ProviderInfo, RoleConfig, StageConfig, VerifyConfig, WorkflowConfig, WorkflowPreset } from '../../../core/src/types';
import { PreflightList } from './RunTools';
import { ModelPicker } from './ModelPicker';
import { PERMISSION_ICON, PermissionButton, permissionLabel, SafetySection } from './Safety';
import { hub, useModels } from '../api';
import { advisorPairing } from '../../../core/src/advisorPairing';
import { fmtContext } from '../../../core/src/modelContext';
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

/** A count the user may leave empty for "no limit" (stored as 0); any number from `min` up. */
function OptionalLimit({ value, min, onChange, disabled }: { value: number; min: number; onChange: (v: number) => void; disabled?: boolean }) {
  const t = useT();
  return (
    <span className="row gap">
      <input
        disabled={disabled}
        type="number"
        min={min}
        value={value === 0 ? '' : value}
        placeholder={t('無上限', 'No limit')}
        style={{ width: 96 }}
        onChange={(e) => onChange(e.target.value === '' || Number(e.target.value) <= 0 ? 0 : Math.max(min, Math.round(Number(e.target.value))))}
      />
      <span className="muted small">{value === 0 ? t('無上限', 'no limit') : t('留空＝無上限', 'empty = no limit')}</span>
    </span>
  );
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
      <AdvisorButton value={draft.advisor ?? { mode: 'off' }} providers={providers} onChange={onAdvisor} onOpen={onOpen} mains={claudeMains(t, draft, providers, preview)} />
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
              <OptionalLimit disabled={disabled} value={stage.maxRounds} min={1} onChange={(maxRounds) => onChange({ ...stage, maxRounds })} />
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

/** Goal verification: the planner sets a goal that must pass; the workflow does not end until it does. */
function GoalSection({ value, onChange, providers, disabled, auto, implementer }: { value: VerifyConfig; onChange: (v: VerifyConfig) => void; providers: ProviderInfo[]; disabled?: boolean; auto?: boolean; implementer: string }) {
  const t = useT();
  const other = providers.find((p) => p.spec.id !== implementer && p.installed && p.auth.state === 'logged_in')?.spec.id ?? implementer;
  return (
    <section className="sect">
      <div className="sect-head">
        <div>
          <div className="sect-title">{t('目標驗收', 'Goal verification')}</div>
          <div className="muted small">{t('計畫者設定一定要通過的最終目標（可量測的驗收指標）。程式審查通過後再逐項量測：有缺陷或證據無效就退回實作者，目標沒達成就退回計畫者重新規劃，直到全部達標才結束。', 'The planner sets a final goal that must pass (measurable acceptance metrics). After the code review each metric is measured: defects or bad evidence go back to the implementer, a missed goal back to the planner to re-plan, until every metric is met.')}</div>
        </div>
        <label className="switch">
          <input type="checkbox" disabled={disabled} checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} />
          <span />
        </label>
      </div>
      {value.enabled && (
        <div className="sect-body">
          <div className="seg wide">
            <button disabled={disabled} className={cx(value.by === 'planner' && 'on')} onClick={() => onChange({ ...value, by: 'planner' })}>
              {t('由計畫者驗收', 'The planner verifies')}
            </button>
            <button disabled={disabled} className={cx(value.by === 'independent' && 'on')} onClick={() => onChange({ ...value, by: 'independent', verifier: value.verifier ?? (auto ? undefined : { provider: other }) })}>
              {t('獨立驗收者', 'Independent verifier')}
            </button>
          </div>
          <div className="muted small">
            {value.by === 'planner'
              ? t('設定目標的計畫者在自己的對話中驗收：最清楚每個指標的用意。', 'The planner that set the goal verifies in its own conversation: it knows why each metric is there.')
              : t('另一家 agent 獨立量測，不看實作者的說法；預設和實作者不同家。', 'Another agent measures independently, without trusting the implementer; by default another vendor than the implementer.')}
          </div>
          {value.by === 'independent' && !auto && (
            <div className="kv">
              <label>{t('驗收者', 'Verifier')}</label>
              <ProviderSelect disabled={disabled} value={value.verifier ?? { provider: other }} providers={providers} onChange={(v) => v && onChange({ ...value, verifier: v })} />
            </div>
          )}
          <div className="kv">
            <label title={t('同一個問題連續修這麼多次還沒好，就交回計畫者重新診斷', 'The same problem failing this many fixes in a row goes back to the planner to re-diagnose')}>{t('重新診斷門檻', 'Re-diagnose after')}</label>
            <OptionalLimit disabled={disabled} value={value.repeatLimit ?? 3} min={2} onChange={(repeatLimit) => onChange({ ...value, repeatLimit })} />
          </div>
        </div>
      )}
    </section>
  );
}

/** Time, cost, retry and no-progress limits (off by default). A run that hits one ends as "incomplete", never as done. */
function LimitsSection({ value, onChange, disabled }: { value: LimitsConfig; onChange: (v: LimitsConfig) => void; disabled?: boolean }) {
  const t = useT();
  const num = (k: keyof Omit<LimitsConfig, 'enabled'>, label: string, unit: string) => (
    <div className="kv">
      <label>{label}</label>
      <span className="row gap">
        <input disabled={disabled} type="number" min={0} value={value[k] ?? ''} placeholder={t('不限', 'none')} onChange={(e) => onChange({ ...value, [k]: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })} />
        <span className="muted small">{unit}</span>
      </span>
    </div>
  );
  return (
    <section className="sect">
      <div className="sect-head">
        <div>
          <div className="sect-title">{t('執行限制', 'Limits')}</div>
          <div className="muted small">{t('預設關閉。開啟後碰到上限就停下並標成「未完成」，保留真實狀態，不會假裝成功。', 'Off by default. When on, reaching a limit stops the run and marks it "incomplete": the true state is kept, never a false success.')}</div>
        </div>
        <label className="switch">
          <input type="checkbox" disabled={disabled} checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} />
          <span />
        </label>
      </div>
      {value.enabled && (
        <div className="sect-body">
          {num('maxMinutes', t('總時間上限', 'Time limit'), t('分鐘', 'min'))}
          {num('maxCostUsd', t('費用上限', 'Cost limit'), t('美元（CLI 有回報費用時）', 'USD (when the CLI reports cost)'))}
          {num('maxCycles', t('修正／重新規劃次數', 'Fix / re-plan cycles'), t('次', 'times'))}
          {num('noProgressMinutes', t('沒有進展多久就問我', 'Ask me after no progress for'), t('分鐘', 'min'))}
        </div>
      )}
    </section>
  );
}

/** Check before sending: providers, models, folders, tools, GPUs and recovery. A dry run does the same without running agents. */
function PreflightSection({ draft, onDryRun }: { draft: RoleDraft; onDryRun?: () => void }) {
  const t = useT();
  const [items, setItems] = useState<PreflightItem[]>();
  const [busy, setBusy] = useState(false);
  const run = () => {
    setBusy(true);
    hub
      .call<PreflightItem[]>('workflows.preflight', { config: { ...draft, goal: 'preflight' } })
      .then(setItems)
      .catch((e) => setItems([{ level: 'error', area: 'recovery', message: (e as Error).message }]))
      .finally(() => setBusy(false));
  };
  return (
    <section className="sect">
      <div className="sect-head">
        <div>
          <div className="sect-title">{t('預檢與試跑', 'Preflight and dry run')}</div>
          <div className="muted small">{t('送出前檢查：供應商是否登入、模型與思考程度是否存在、資料夾能否寫入、git、GPU、磁碟與中斷恢復。送出時也會自動檢查，有錯誤會先告訴你。', 'Checks before sending: providers signed in, models and efforts that exist, writable folders, git, GPUs, disk and recovery. Sending runs it too and tells you about errors first.')}</div>
        </div>
      </div>
      <div className="row gap">
        <button className="btn" disabled={busy || !draft.cwd} onClick={run}>
          {busy ? t('檢查中…', 'Checking…') : t('立即預檢', 'Check now')}
        </button>
        {onDryRun && (
          <button className="btn" disabled={!draft.cwd} onClick={onDryRun} title={t('建立一次試跑：只做檢查與流程模擬，不執行任何 agent', 'Start a dry run: checks and a simulation of the flow, no agent runs')}>
            {t('試跑一次', 'Dry run')}
          </button>
        )}
      </div>
      {items && <PreflightList items={items} showOk />}
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
function AdvisorOptions({ value, onChange, providers, disabled, mains }: { value: AdvisorConfig; onChange: (v: AdvisorConfig) => void; providers: ProviderInfo[]; disabled?: boolean; mains?: ClaudeMain[] }) {
  const t = useT();
  if (value.mode === 'claude')
    return (
      <>
        <ClaudeAdvisorModel value={value} onChange={onChange} disabled={disabled} />
        <AdvisorPairingNote advisor={value.claudeModel || 'opus'} mains={mains ?? []} />
      </>
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
          <OptionalLimit disabled={disabled} value={value.maxCalls ?? 5} min={1} onChange={(maxCalls) => onChange({ ...value, maxCalls })} />
        </div>
        <div className="muted tiny">{t('每段對話的請教次數上限。', 'Consultations allowed per conversation.')}</div>
        <FactRounds value={value} onChange={onChange} disabled={disabled} />
      </>
    );
  return null;
}

const CUSTOM_ADVISOR = '__custom__';
const ADVISOR_ALIASES = ['opus', 'fable', 'sonnet'];

/**
 * Claude's advisor model: an alias (follows Claude Code's newest version of that family), a full version from Claude
 * Code's model list, or one typed in. Models that can never advise (Haiku 4.5) are left out.
 */
function ClaudeAdvisorModel({ value, onChange, disabled }: { value: AdvisorConfig; onChange: (v: AdvisorConfig) => void; disabled?: boolean }) {
  const t = useT();
  const { models } = useModels('claude');
  const versions = models
    .map((m) => m.id)
    .filter((id) => /^claude-/i.test(id) && advisorPairing('claude-haiku-4-5', id) !== 'not-advisor' && advisorPairing('claude-haiku-4-5', id) !== 'unknown');
  const current = value.claudeModel || 'opus';
  const [custom, setCustom] = useState(!ADVISOR_ALIASES.includes(current) && !versions.includes(current));
  const showCustom = custom || (!ADVISOR_ALIASES.includes(current) && !versions.includes(current) && versions.length > 0);
  const ctx = (id: string) => {
    const c = models.find((m) => m.id === id)?.context;
    return c ? ` · ${fmtContext(c)}` : '';
  };
  const alias = (a: string) => t(`${a[0].toUpperCase()}${a.slice(1)}（最新版）`, `${a[0].toUpperCase()}${a.slice(1)} (latest)`) + ctx(a);
  return (
    <div className="kv">
      <label>{t('顧問模型', 'Advisor model')}</label>
      {showCustom ? (
        <div className="row gap">
          <input disabled={disabled} placeholder="claude-opus-5-5" value={value.claudeModel ?? ''} onChange={(e) => onChange({ ...value, claudeModel: e.target.value.trim() || undefined })} />
          <button className="link tiny" disabled={disabled} onClick={() => (setCustom(false), onChange({ ...value, claudeModel: 'opus' }))}>
            {t('改用清單', 'Pick from list')}
          </button>
        </div>
      ) : (
        <select
          disabled={disabled}
          value={current}
          onChange={(e) => (e.target.value === CUSTOM_ADVISOR ? setCustom(true) : onChange({ ...value, claudeModel: e.target.value }))}
        >
          <optgroup label={t('別名（跟著 Claude Code 更新）', 'Aliases (follow Claude Code updates)')}>
            {ADVISOR_ALIASES.map((a) => (
              <option key={a} value={a}>
                {alias(a)}
              </option>
            ))}
          </optgroup>
          {versions.length > 0 && (
            <optgroup label={t('固定版本', 'Fixed versions')}>
              {versions.map((id) => (
                <option key={id} value={id}>
                  {id}
                  {ctx(id)}
                </option>
              ))}
            </optgroup>
          )}
          <option value={CUSTOM_ADVISOR}>{t('自行輸入…', 'Other…')}</option>
        </select>
      )}
    </div>
  );
}

/** A Claude Code model that will run in this workflow, and who runs it. */
export interface ClaudeMain {
  who: string;
  model?: string;
}

/** The Claude Code models a workflow will run (roles, Claude sub-agents), for checking the native advisor against them. */
export function claudeMains(t: ReturnType<typeof useT>, draft: RoleDraft, providers: ProviderInfo[], preview?: AssignmentResult): ClaudeMain[] {
  const info = (id?: string) => providers.find((p) => p.spec.id === id);
  const isClaude = (id?: string) => !!id && (id === 'claude' || info(id)?.spec.accountOf === 'claude');
  const out: ClaudeMain[] = [];
  const add = (who: string, role?: { provider: string; model?: string }, picked?: string) => {
    const provider = picked ?? role?.provider;
    if (!isClaude(provider)) return;
    // In auto assignment the provider default model is used.
    out.push({ who, model: (picked ? undefined : role?.model) || info(provider)?.defaultModel });
  };
  const auto = isAuto(draft);
  if (draft.plan.enabled) {
    add(t('撰寫計畫', 'Planner'), draft.plan.author, auto ? preview?.plan.author : undefined);
    add(t('審查計畫', 'Plan reviewer'), draft.plan.reviewer ?? undefined, auto ? preview?.plan.reviewer : undefined);
  }
  if (draft.implement.enabled) {
    add(t('實作', 'Implementer'), draft.implement.author, auto ? preview?.implement.author : undefined);
    add(t('審查程式碼', 'Code reviewer'), draft.implement.reviewer ?? undefined, auto ? preview?.implement.reviewer : undefined);
  }
  if (draft.subagents.enabled)
    for (const id of auto ? preview?.subagents ?? draft.subagents.allowed : draft.subagents.allowed)
      if (isClaude(id)) out.push({ who: 'Sub agent', model: draft.subagents.models?.[id]?.model || info(id)?.defaultModel });
  return out;
}

/** Warns when Claude Code would ignore the advisor (weaker than an agent's model) or refuse it. */
function AdvisorPairingNote({ advisor, mains }: { advisor: string; mains: ClaudeMain[] }) {
  const t = useT();
  const bad = new Map<string, { pairing: ReturnType<typeof advisorPairing>; who: string[] }>();
  for (const m of mains) {
    const pairing = advisorPairing(m.model, advisor);
    if (pairing === 'ok' || pairing === 'unknown') continue;
    const e = bad.get(m.model!) ?? { pairing, who: [] };
    if (!e.who.includes(m.who)) e.who.push(m.who);
    bad.set(m.model!, e);
  }
  if (!bad.size) return null;
  return (
    <div className="note warn small">
      {[...bad].map(([model, e]) => (
        <div key={model}>
          {e.pairing === 'weaker'
            ? t(
                `顧問 ${advisor} 比 ${e.who.join('、')} 使用的 ${model} 弱，Claude Code 會忽略它（這些 agent 不會有顧問）。請改選同級或更強的模型。`,
                `The advisor ${advisor} is weaker than ${model} used by ${e.who.join(', ')}, so Claude Code ignores it (those agents get no advisor). Pick an equal or stronger model.`,
              )
            : e.pairing === 'not-advisor'
              ? t(`${advisor} 不能當顧問，請改選其他模型。`, `${advisor} cannot act as an advisor; pick another model.`)
              : t(`${e.who.join('、')} 使用的 ${model} 不支援 Claude 顧問。`, `${model} used by ${e.who.join(', ')} does not support the Claude advisor.`)}
        </div>
      ))}
    </div>
  );
}

const CAPACITIES = [256_000, 512_000, 1_000_000, 2_000_000];

/** The preset choices plus the current value when it is not one of them (so the select shows what is set). */
const withCurrent = (choices: number[], current: number) => (choices.includes(current) ? choices : [...choices, current].sort((a, b) => a - b));

/** Shared-context size, when it compacts by itself, who compacts it, and when to ask about an agent's own conversation. */
function ContextSizeSection({ value, onChange, providers, disabled, summaryOnly }: { value: ContextConfig; onChange: (v: ContextConfig) => void; providers: ProviderInfo[]; disabled?: boolean; summaryOnly: boolean }) {
  const t = useT();
  const cap = value.capacity ?? CAPACITIES[0];
  const custom = !CAPACITIES.includes(cap);
  const label = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${n / 1000}K`);
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return (
    <section className="sect">
      <div className="sect-title">{t('共用上下文的容量與壓縮', 'Shared context size & compaction')}</div>
      <div className="muted small">
        {t(
          'Aivenue 共用上下文（筆記、各 agent 的結果與交接）最多累積多少，以及何時壓縮。輸入框旁的圓餅圖顯示目前用量。容量越大越少壓縮，但 agent 讀完整內容時花的 token 也越多。',
          "How much Aivenue's shared context (notes, agents' results and hand-offs) may hold, and when it is compacted. The pie next to the message box shows how full it is. A bigger size compacts less often, but agents reading all of it spend more tokens.",
        )}
      </div>
      {summaryOnly && <div className="note small">{t('目前設為「只交摘要」，沒有共用上下文，這些設定暫時不會用到。', 'Sharing is set to summaries only, so these settings are not used right now.')}</div>}
      <div className="kv">
        <label>{t('容量', 'Size')}</label>
        <div className="row gap">
          <select disabled={disabled} value={custom ? 'custom' : String(cap)} onChange={(e) => onChange({ ...value, capacity: e.target.value === 'custom' ? 300_000 : Number(e.target.value) })}>
            {CAPACITIES.map((c) => (
              <option key={c} value={c}>
                {label(c)}
                {c === CAPACITIES[0] ? t('（預設）', ' (default)') : ''}
              </option>
            ))}
            <option value="custom">{t('自訂…', 'Custom…')}</option>
          </select>
          {custom && (
            <input disabled={disabled} type="number" min={8} max={10000} value={Math.round(cap / 1000)} onChange={(e) => onChange({ ...value, capacity: Math.min(10_000, Math.max(8, Number(e.target.value) || 8)) * 1000 })} />
          )}
          {custom && <span className="muted small">K tokens</span>}
        </div>
      </div>
      <div className="kv">
        <label>{t('自動壓縮', 'Auto-compact at')}</label>
        <select disabled={disabled} value={value.compactAt ?? 0.8} onChange={(e) => onChange({ ...value, compactAt: Number(e.target.value) })}>
          {withCurrent([0.7, 0.8, 0.9], value.compactAt ?? 0.8).map((n) => (
            <option key={n} value={n}>
              {t(`用到 ${pct(n)} 時`, `${pct(n)} full`)}
            </option>
          ))}
        </select>
      </div>
      <div className="kv">
        <label>{t('壓縮者', 'Compactor')}</label>
        <div className="stack">
          <select disabled={disabled} value={value.compactor ? 'pick' : 'auto'} onChange={(e) => onChange({ ...value, compactor: e.target.value === 'pick' ? { provider: providers.find((p) => p.auth.state === 'logged_in')?.spec.id ?? providers[0]?.spec.id ?? 'claude' } : undefined })}>
            <option value="auto">{t('自動（已登入中的中價位模型，例如 Claude Haiku）', 'Automatic (a mid-priced signed-in model, e.g. Claude Haiku)')}</option>
            <option value="pick">{t('指定…', 'Choose…')}</option>
          </select>
          {value.compactor && <ProviderSelect disabled={disabled} value={value.compactor} providers={providers} onChange={(v) => v && onChange({ ...value, compactor: v })} />}
        </div>
      </div>
      <div className="muted tiny">
        {t(
          '較弱的模型可能漏掉細節：目標、計畫、未解決的審查問題與你的指示一律逐字保留，壓縮後也會檢查檔案路徑與問題編號是否都還在，原文仍可讀取。',
          'Weaker models may drop details: the goal, plan, open review issues and your instructions are always kept word for word, the summary is checked for every file path and issue id, and the originals stay readable.',
        )}
      </div>
      <div className="kv">
        <label>{t('agent 對話詢問', 'Ask about agents')}</label>
        <select disabled={disabled} value={value.agentAskAt ?? 0.8} onChange={(e) => onChange({ ...value, agentAskAt: Number(e.target.value) })}>
          {withCurrent([0.7, 0.8, 0.9], value.agentAskAt ?? 0.8).filter((n) => n > 0).map((n) => (
            <option key={n} value={n}>
              {t(`對話用到 ${pct(n)} 時詢問是否壓縮`, `Ask to compact at ${pct(n)}`)}
            </option>
          ))}
          <option value={0}>{t('不詢問（交給各家 CLI 自己壓縮）', "Never ask (the CLIs compact on their own)")}</option>
        </select>
      </div>
      <div className="kv">
        <label>{t('整理共用知識', 'Organize knowledge')}</label>
        <select disabled={disabled} value={value.organizeEvery ?? 30} onChange={(e) => onChange({ ...value, organizeEvery: Number(e.target.value) })}>
          {withCurrent([10, 20, 30, 50, 100], value.organizeEvery ?? 30)
            .filter((n) => n > 0)
            .map((n) => (
              <option key={n} value={n}>
                {t(`每 ${n} 則新筆記整理一次`, `Every ${n} new notes`)}
                {n === 30 ? t('（預設）', ' (default)') : ''}
              </option>
            ))}
          <option value={0}>{t('不自動整理', 'Never automatically')}</option>
        </select>
      </div>
      <div className="kv">
        <label>{t('每個 agent 讀入', 'Each agent reads')}</label>
        <select disabled={disabled} value={value.shareOfWindow ?? 0.5} onChange={(e) => onChange({ ...value, shareOfWindow: Number(e.target.value) })}>
          {withCurrent([0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8], value.shareOfWindow ?? 0.5).map((n) => (
            <option key={n} value={n}>
              {t(`最多佔它上下文的 ${pct(n)}`, `Up to ${pct(n)} of its context`)}
              {n === 0.5 ? t('（預設）', ' (default)') : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="muted tiny">
        {t(
          '每個 agent 依自己模型能容納的大小讀入共用上下文：目標、狀態與交接一律放最前面，其餘由新到舊放到這個比例為止，放不下的仍可查到。如果某個 CLI 曾在比模型上限更低的大小自己壓縮對話，就以那個大小計算。',
          'Each agent reads the shared context in proportion to what its model holds: the goal, status and hand-offs always come first, the rest goes in newest first up to this share, and what does not fit can still be looked up. When a CLI has compacted its conversation below its model limit, that size counts instead.',
        )}{' '}
        {t(
          '整理共用知識：壓縮者模型把新的筆記與 findings 依主題（環境、資料、程式結構、已知問題、決策、不可行的做法、進度）整理成一份文件，每一條附出處，原本的筆記不變。',
          'Organizing: the compactor model sorts new notes and findings by subject (environment, data, code structure, known problems, decisions, approaches that did not work, progress) into one document, each line with its source; the notes stay as they are.',
        )}
      </div>
    </section>
  );
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
export function AdvisorButton({ value, providers, onChange, onOpen, mains }: { value: AdvisorConfig; providers: ProviderInfo[]; onChange?: (v: AdvisorConfig) => void; onOpen: () => void; mains?: ClaudeMain[] }) {
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
              <AdvisorOptions value={value} onChange={onChange} providers={providers} mains={mains} />
            </div>
          )}
        </div>
      )}
    </span>
  );
}

/** Advisor mode: off, Claude Code's own advisor, or Aivenue's cross-vendor ask_advisor. */
function AdvisorSection({ value, onChange, providers, disabled, mains }: { value: AdvisorConfig; onChange: (v: AdvisorConfig) => void; providers: ProviderInfo[]; disabled?: boolean; mains?: ClaudeMain[] }) {
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
      <AdvisorOptions value={value} onChange={onChange} providers={providers} disabled={disabled} mains={mains} />
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
  onApplyNow,
  onDryRun,
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
  /** A running conversation: stop the agents whose role changed and start them again with the new settings. */
  onApplyNow?: () => void;
  /** Start a dry run with these settings. */
  onDryRun?: () => void;
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

        <GoalSection disabled={readOnly} value={draft.verify ?? { enabled: false, by: 'planner' }} providers={providers} auto={auto} implementer={draft.implement.author.provider} onChange={(verify) => set({ verify })} />
        <LimitsSection disabled={readOnly} value={draft.limits ?? { enabled: false }} onChange={(limits) => set({ limits })} />

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

        <ContextSizeSection disabled={readOnly} providers={providers} value={draft.context ?? {}} onChange={(context) => set({ context })} summaryOnly={(draft.contextSharing ?? 'on_demand') === 'summary'} />

        <AdvisorSection disabled={readOnly} providers={providers} value={draft.advisor ?? { mode: 'off' }} onChange={(advisor) => set({ advisor })} mains={claudeMains(t, draft, providers, preview.result)} />

        {!readOnly && <PreflightSection draft={draft} onDryRun={onDryRun} />}

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
          {onApplyNow && (
            <button className="btn" onClick={onApplyNow} title={t('正在工作、且設定被你改過的角色會停下，用新設定在同一輪重新派發', 'Working agents whose role you changed stop and are re-dispatched in the same round with the new settings')}>
              {t('立即套用（重新派發）', 'Apply now (re-dispatch)')}
            </button>
          )}
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
