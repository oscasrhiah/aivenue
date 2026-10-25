import { useState } from 'react';
import type { ExtensionStatus } from '../../../core/src/types';
import { hub } from '../api';
import { useT } from '../i18n';
import { cx } from '../util';

type Line = [zh: string, en: string];

interface FreeProvider {
  /** OmniRoute's provider id. */
  id: string;
  name: string;
  /** Where the user signs up and creates a key. */
  keyUrl: string;
  free: Line;
  note?: Line;
  /** A warning shown in amber (privacy, card required…). */
  warn?: Line;
  recommended?: boolean;
}

/** Free tiers that can run an agent (tool calling, long context, no card), then the rest. */
const PROVIDERS: FreeProvider[] = [
  {
    id: 'gemini',
    name: 'Google Gemini（AI Studio）',
    keyUrl: 'https://aistudio.google.com/apikey',
    free: ['Gemini Flash 系列，上下文 1M', 'Gemini Flash models, 1M context'],
    note: ['用 Google 帳號登入即可建立金鑰；每個模型有每日次數上限。', 'Sign in with a Google account to create a key; each model has daily limits.'],
    warn: ['免費版送出的內容可能被用來改進 Google 的產品。', 'On the free tier Google may use what you send to improve its products.'],
    recommended: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    keyUrl: 'https://openrouter.ai/settings/keys',
    free: ['名稱帶 :free 的模型（DeepSeek、Qwen、GLM 等）', 'Models ending in :free (DeepSeek, Qwen, GLM…)'],
    note: ['每分鐘、每天有請求次數上限；儲值 10 美元可提高上限（選用）。', 'Per-minute and per-day request limits; an optional $10 top-up raises them.'],
    recommended: true,
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    keyUrl: 'https://build.nvidia.com/settings/api-keys',
    free: ['70 多個模型（Kimi、GLM、DeepSeek…），每分鐘約 40 次', '70+ models (Kimi, GLM, DeepSeek…), about 40 requests a minute'],
    note: ['官方定位是開發與試用，不是正式上線用。', 'Meant for development and evaluation, not production.'],
    recommended: true,
  },
  {
    id: 'mistral',
    name: 'Mistral',
    keyUrl: 'https://console.mistral.ai/api-keys',
    free: ['Experiment 方案：全部模型（含 Devstral／Codestral）', 'Experiment plan: every model, Devstral and Codestral included'],
    note: ['需要手機驗證；條款限個人使用。', 'Needs phone verification; personal use only.'],
    recommended: true,
  },
  {
    id: 'groq',
    name: 'Groq',
    keyUrl: 'https://console.groq.com/keys',
    free: ['Llama、GPT-OSS、Qwen，速度很快；每個模型每天約 20 萬 token', 'Llama, GPT-OSS, Qwen, very fast; about 200K tokens a day per model'],
    note: ['每分鐘的 token 上限偏低，agent 的大提示可能被擋，接上後的測試會告訴你。', 'Low per-minute token caps may block an agent’s large prompts; the check after connecting tells you.'],
    recommended: true,
  },
  {
    id: 'ollama-cloud',
    name: 'Ollama Cloud',
    keyUrl: 'https://ollama.com/settings/keys',
    free: ['免費方案，限制較多', 'Free plan with tighter limits'],
    note: ['適合當備用。', 'Good as a fallback.'],
  },
  {
    id: 'logfare',
    name: 'Logfare',
    keyUrl: 'https://logfare.ai/register',
    free: ['免費、沒有次數限制，不用綁卡', 'Free, no rate limits, no card'],
    warn: ['每一次請求（內容與回覆）都會被記錄拿去研究，私人程式碼不適合使用。', 'Every request and reply is logged for research: not for private code.'],
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    keyUrl: 'https://cloud.cerebras.ai',
    free: ['一次性 5 美元額度，30 天內有效', 'One-time $5 credit, valid 30 days'],
    warn: ['需要綁信用卡，不是長期免費。', 'Needs a payment method; not a lasting free tier.'],
  },
];

/** "Connect free providers": sign up on the provider's own page, paste the key, and Aivenue checks it can run an agent. */
export function OmniProviders({ s }: { s: ExtensionStatus }) {
  const t = useT();
  const [more, setMore] = useState(false);
  const connected = s.omniroute?.connected ?? [];
  const shown = PROVIDERS.filter((p) => p.recommended || more);
  return (
    <div className="omni-providers">
      <div className="block-label">{t('連接免費供應商', 'Connect free providers')}</div>
      <div className="muted tiny">
        {t(
          '按「取得金鑰」到該家的官方網站自己註冊、登入並建立 API 金鑰，貼回這裡按「連接」。Aivenue 會交給 OmniRoute（加密保存在它的資料庫），再實際測試一次能不能跑 agent。',
          'Press "Get a key" to sign up on the provider’s own site and create an API key, then paste it here and press Connect. Aivenue hands it to OmniRoute (stored encrypted in its database) and checks it can run an agent.',
        )}
      </div>
      {shown.map((p) => (
        <ProviderRow key={p.id} p={p} conns={connected.filter((c) => c.provider === p.id)} />
      ))}
      <button className="link tiny" onClick={() => setMore(!more)}>
        {more ? t('收起', 'Show less') : t(`更多（${PROVIDERS.length - PROVIDERS.filter((p) => p.recommended).length} 家，不推薦）`, `More (${PROVIDERS.length - PROVIDERS.filter((p) => p.recommended).length}, not recommended)`)} {more ? '▴' : '▾'}
      </button>
      {connected.some((c) => !PROVIDERS.some((p) => p.id === c.provider)) && (
        <div className="muted tiny">
          {t('在 OmniRoute 管理頁接上的其他供應商：', 'Other providers connected in the OmniRoute dashboard: ')}
          {connected
            .filter((c) => !PROVIDERS.some((p) => p.id === c.provider))
            .map((c) => c.name || c.provider)
            .join('、')}
        </div>
      )}
    </div>
  );
}

function ProviderRow({ p, conns }: { p: FreeProvider; conns: NonNullable<NonNullable<ExtensionStatus['omniroute']>['connected']> }) {
  const t = useT();
  const tl = (l: Line) => t(l[0], l[1]);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cx('omni-prov', conns.some((c) => c.test?.state === 'ok') && 'on')}>
      <div className="omni-prov-head">
        <b>{p.name}</b>
        {p.recommended && <span className="tag">{t('推薦', 'Recommended')}</span>}
        <span className="muted small">{tl(p.free)}</span>
      </div>
      {p.note && <div className="muted tiny">{tl(p.note)}</div>}
      {p.warn && <div className="warn-text tiny">⚠ {tl(p.warn)}</div>}
      {conns.map((c) => (
        <div key={c.id} className="omni-conn">
          <span className={cx('tiny', c.test?.state === 'ok' ? 'ok-text' : c.test?.state === 'fail' ? 'err-text' : 'muted')}>
            {c.test?.state === 'ok'
              ? `✓ ${t('已連接，可以跑 agent', 'Connected, can run agents')}`
              : c.test?.state === 'fail'
                ? `✕ ${t('已連接，但測試沒通過', 'Connected, but the check failed')}`
                : c.test?.state === 'testing'
                  ? t('測試中…', 'Checking…')
                  : t('已連接（尚未測試）', 'Connected (not checked yet)')}
            {c.test?.model ? ` · ${c.test.model}` : ''}
          </span>
          <span className="grow" />
          <button className="btn small ghost" disabled={busy || c.test?.state === 'testing'} onClick={() => run(() => hub.call('extensions.omniTest', { id: c.id }))}>
            {t('重新測試', 'Check again')}
          </button>
          <button className="btn small ghost danger" disabled={busy} onClick={() => confirm(t(`移除 ${p.name} 的連線？`, `Remove the ${p.name} connection?`)) && run(() => hub.call('extensions.omniDisconnect', { id: c.id }))}>
            {t('移除', 'Remove')}
          </button>
          {c.test?.state === 'fail' && c.test.message && <div className="err-text tiny omni-conn-msg">{c.test.message}</div>}
        </div>
      ))}
      <div className="row gap omni-prov-key">
        <button className="btn small" onClick={() => hub.call('host.openExternal', { url: p.keyUrl })}>
          {t('取得金鑰', 'Get a key')} ↗
        </button>
        <input type="password" className="grow" autoComplete="off" placeholder={conns.length ? t('貼上另一把金鑰（多一個帳號）', 'Paste another key (one more account)') : t('貼上 API 金鑰', 'Paste the API key')} value={key} onChange={(e) => setKey(e.target.value)} />
        <button className="btn small primary" disabled={busy || !key.trim()} onClick={() => run(() => hub.call('extensions.omniConnect', { provider: p.id, apiKey: key })).then((ok) => ok && setKey(''))}>
          {busy ? t('連接並測試中…', 'Connecting and checking…') : t('連接', 'Connect')}
        </button>
      </div>
      {error && <div className="err-text tiny">{error}</div>}
    </div>
  );
}
