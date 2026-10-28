import { useEffect, useState } from 'react';
import type { ModelInfo, OmniCandidate, ProviderInfo } from '../../../core/src/types';
import { hub, useModels } from '../api';
import { cx } from '../util';
import { useT, type T } from '../i18n';
import { fmtContext } from '../../../core/src/modelContext';

const CUSTOM = '__custom__';

/** "Claude Opus (claude-opus-5-5) · 1M · 免費" */
export function modelOptionLabel(t: T, m: ModelInfo): string {
  const name = m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id;
  return [name, m.context && fmtContext(m.context), inputsLabel(t, m), m.reasoning === false && t('不思考', 'no thinking'), m.tools === false && t('⚠ 不能呼叫工具', '⚠ no tool calling'), m.free && t('免費', 'free')].filter(Boolean).join(' · ');
}

/** What a model reads besides text ("圖片、影片"), or "只有文字"; empty when unknown. */
export function inputsLabel(t: T, m: ModelInfo): string {
  if (!m.inputs) return '';
  const names: Record<string, string> = { image: t('圖片', 'images'), pdf: 'PDF', audio: t('音訊', 'audio'), video: t('影片', 'video') };
  const extra = m.inputs.filter((x) => names[x]).map((x) => names[x]);
  return extra.length ? extra.join(t('、', ', ')) : t('只有文字', 'text only');
}

/** Where a model's context size comes from, for the tooltip. */
export function contextHint(t: T, m: ModelInfo): string {
  if (!m.context) return '';
  const from = m.contextSource === 'measured' ? t('CLI 執行時回報', 'reported by the CLI while running') : m.contextSource === 'cli' ? t('CLI 的模型清單', "the CLI's model list") : t('models.dev 模型目錄', 'the models.dev catalog');
  return t(`最大上下文 ${m.context.toLocaleString()} tokens（來源：${from}）`, `Max context ${m.context.toLocaleString()} tokens (from ${from})`);
}

/** A small "1M" badge with the source on hover. */
export function ContextBadge({ model }: { model?: ModelInfo }) {
  const t = useT();
  if (!model?.context) return null;
  return (
    <span className="ctx-badge" title={contextHint(t, model)}>
      {fmtContext(model.context)}
    </span>
  );
}

/**
 * Model + reasoning-effort selectors for one provider. Empty values mean "use the default"
 * (the provider default for roles, the CLI's own default for provider settings).
 */
export function ModelPicker({
  provider,
  model,
  effort,
  onChange,
  disabled,
  inheritLabel,
  inheritEffort,
}: {
  provider: ProviderInfo | undefined;
  model?: string;
  effort?: string;
  onChange: (v: { model?: string; effort?: string }) => void;
  disabled?: boolean;
  /** Text for the empty option, e.g. "Provider default (opus)". */
  inheritLabel?: string;
  /** Effort used when none is chosen here (the provider default for roles). */
  inheritEffort?: string;
}) {
  const t = useT();
  const { models, refresh } = useModels(provider?.spec.id);
  const known = models.some((m) => m.id === model);
  const [custom, setCustom] = useState(!!model && !known && models.length > 0);
  const current = models.find((m) => m.id === (model || provider?.defaultModel));
  // A listed model's own levels win, even none (e.g. Claude through Antigravity takes no effort); a typed-in model gets the CLI's.
  // A model that does not think takes no effort, whatever the provider offers in general.
  const effortsOf = (m?: ModelInfo) => (m ? m.efforts ?? (m.reasoning === false ? [] : provider?.spec.efforts ?? []) : provider?.spec.efforts ?? []);
  const efforts = effortsOf(current);
  // Picking a model that takes no effort drops the one chosen before.
  const pick = (next?: string) => onChange({ model: next, effort: effortsOf(models.find((m) => m.id === (next || provider?.defaultModel))).length ? effort : undefined });
  const showCustom = custom || (!!model && !known && models.length > 0) || models.length === 0;
  // An OmniRoute pool (auto/best-free…): show what it can route to, and let the user pick one of those instead.
  const effective = model || provider?.defaultModel || provider?.spec.defaultModel;
  const poolId = provider?.spec.id === 'omniroute' && effective?.startsWith('omniroute/auto/') ? effective : undefined;
  return (
    <div className="model-picker-wrap">
    <div className="model-picker">
      {showCustom ? (
        <input
          className="model"
          disabled={disabled}
          placeholder={inheritLabel ?? t('模型（預設）', 'Model (default)')}
          value={model ?? ''}
          onChange={(e) => onChange({ model: e.target.value || undefined, effort })}
        />
      ) : (
        <select
          disabled={disabled}
          value={model ?? ''}
          onChange={(e) => {
            if (e.target.value === CUSTOM) return setCustom(true);
            pick(e.target.value || undefined);
          }}
        >
          <option value="">{inheritLabel ?? t('預設模型', 'Default model')}</option>
          {models.map((m) => (
            <option key={m.id} value={m.id} title={[m.description, contextHint(t, m)].filter(Boolean).join('\n')}>
              {modelOptionLabel(t, m)}
            </option>
          ))}
          <option value={CUSTOM}>{t('自行輸入…', 'Other…')}</option>
        </select>
      )}
      {!showCustom && <ContextBadge model={current} />}
      {efforts.length > 0 && (
        <select disabled={disabled} value={effort ?? ''} onChange={(e) => onChange({ model, effort: e.target.value || undefined })} title={t('推理強度', 'Reasoning effort')}>
          <option value="">
            {t('預設推理', 'Default effort')}
            {inheritEffort ?? current?.defaultEffort ? ` (${inheritEffort ?? current?.defaultEffort})` : ''}
          </option>
          {efforts.map((x) => (
            <option key={x} value={x}>
              {t('推理', 'Effort')}: {x}
            </option>
          ))}
        </select>
      )}
      <button className="icon-btn" disabled={disabled} title={t('重新讀取模型清單', 'Reload model list')} onClick={refresh}>
        ↻
      </button>
    </div>
    {poolId && !showCustom && (
      <OmniPool
        pool={poolId}
        disabled={disabled}
        onPick={async (id) => {
          await hub.call('extensions.omniPin', { model: id });
          refresh();
          pick(id);
        }}
      />
    )}
    </div>
  );
}

/** The models an OmniRoute pool may route to right now; picking one uses only that model. */
function OmniPool({ pool, disabled, onPick }: { pool: string; disabled?: boolean; onPick: (id: string) => void }) {
  const t = useT();
  const [list, setList] = useState<OmniCandidate[]>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    setList(undefined);
    hub.call<OmniCandidate[]>('extensions.omniCandidates', { model: pool }).then((l) => live && setList(l)).catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, [pool]);
  if (!list) return <div className="muted tiny">{t('讀取這個組合的模型…', 'Reading the models of this pool…')}</div>;
  if (!list.length) return <div className="muted tiny">{t('這個組合目前沒有可用的模型：到 OmniRoute 管理頁連接免費供應商。', 'No model in this pool right now: connect free providers in the OmniRoute dashboard.')}</div>;
  const ok = list.filter((c) => c.state === 'ok').length;
  const label = (s: OmniCandidate['state']) => (s === 'ok' ? t('可用', 'ready') : s === 'cooldown' ? t('冷卻中', 'cooling down') : s === 'limited' ? t('免登入，長度太短不能跑 agent', 'no sign-in, too short for agents') : t('無法使用', 'unavailable'));
  return (
    <div className="omni-pool">
      <button className="link tiny" onClick={() => setOpen(!open)}>
        {t(`這個組合會依序從 ${list.length} 個模型挑（${ok} 個可用）`, `This pool picks from ${list.length} models in order (${ok} ready)`)} {open ? '▴' : '▾'}
      </button>
      {open && (
        <div className="omni-pool-list">
          <div className="muted tiny">{t('點一個模型就只用它，不再自動切換。', 'Click a model to use only that one, without automatic switching.')}</div>
          {list.map((c, i) => (
            <button key={c.id} className={cx('omni-cand', c.state)} disabled={disabled || c.state === 'excluded' || c.state === 'limited'} onClick={() => onPick(c.id)} title={c.provider}>
              <span className="muted tiny">{i + 1}</span>
              <span className="mono small">{c.id.replace(/^omniroute\//, '')}</span>
              <span className={cx('tiny', c.state === 'ok' ? 'ok-text' : 'muted')}>{label(c.state)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
