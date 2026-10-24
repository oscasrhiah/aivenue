import { useState } from 'react';
import type { ModelInfo, ProviderInfo } from '../../../core/src/types';
import { useModels } from '../api';
import { useT } from '../i18n';

const CUSTOM = '__custom__';

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
  const effortsOf = (m?: ModelInfo) => (m ? m.efforts ?? provider?.spec.efforts ?? [] : provider?.spec.efforts ?? []);
  const efforts = effortsOf(current);
  // Picking a model that takes no effort drops the one chosen before.
  const pick = (next?: string) => onChange({ model: next, effort: effortsOf(models.find((m) => m.id === (next || provider?.defaultModel))).length ? effort : undefined });
  const showCustom = custom || (!!model && !known && models.length > 0) || models.length === 0;
  return (
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
            <option key={m.id} value={m.id} title={m.description}>
              {m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id}
            </option>
          ))}
          <option value={CUSTOM}>{t('自行輸入…', 'Other…')}</option>
        </select>
      )}
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
  );
}
