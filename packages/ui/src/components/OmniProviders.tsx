import { useState } from 'react';
import type { ExtensionStatus } from '../../../core/src/types';
import { hub } from '../api';
import { useT } from '../i18n';
import { cx } from '../util';
import { ask } from './Ask';
import { CircleCheck, CircleDashed, CircleX, ExternalLink, LoaderCircle, TriangleAlert } from 'lucide-react';
import { Ico } from '../icons';
import { Fold, StateWord } from './Kit';

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
    name: 'Google Gemini AI Studio',
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
    free: ['30 多個免費端點模型，每分鐘約 40 次；不是每個都能呼叫工具（跑 agent），要實際測試才知道，例如 Kimi、GLM-5.3-flash 實測可以', '30+ free-endpoint models, about 40 requests a minute; not every one calls tools (runs agents), only a check tells: Kimi and GLM-5.3-flash do'],
    note: ['官方定位是開發與試用，不是正式上線用。免費端點要排隊，一次回答常要等一兩分鐘。NVIDIA 沒有提供能查出哪些是免費端點的 API，Aivenue 只能自動確認 OmniRoute 免費目錄收錄的幾個；其他模型（例如 Kimi）請在「測試模型」選好，再按「用付費模型測試」確認後測試。', 'Meant for development and evaluation, not production. Free endpoints queue: an answer often takes a minute or two. NVIDIA offers no API that tells which models are free endpoints, so Aivenue can confirm only the few in OmniRoute’s free list; for others (Kimi, say) pick it under the check model, then press "Check with a paid model" and confirm.'],
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
  const checks = s.omniroute?.checks ?? {};
  // Models a check passed on a connection still here.
  const working = new Set(connected.filter((c) => c.active).flatMap((c) => Object.entries(checks[c.id] ?? {}).filter(([, r]) => r.state === 'ok').map(([m]) => m)));
  const shown = PROVIDERS.filter((p) => p.recommended || more);
  return (
    <div className="omni-providers">
      <div className="muted tiny">
        {t(
          '按「取得金鑰」到該家的官方網站自己註冊、登入並建立 API 金鑰，貼回這裡按「連接」。Aivenue 會交給 OmniRoute（加密保存在它的資料庫），再實際測試一次能不能跑 agent。',
          'Press "Get a key" to sign up on the provider’s own site and create an API key, then paste it here and press Connect. Aivenue hands it to OmniRoute (stored encrypted in its database) and checks it can run an agent.',
        )}
      </div>
      <label className="row gap tiny">
        <input type="checkbox" checked={s.omniroute?.onlyChecked !== false} onChange={(e) => hub.call('extensions.omniOnlyChecked', { on: e.target.checked })} />
        {t(
          `模型選單只列測試過可用的：免費的，或你確認過才測試的（目前 ${working.size} 個，另有免費模型池）`,
          `Model menus list only models that passed a check: free ones, or ones you okayed before checking (${working.size} now, plus the free pools)`,
        )}
      </label>
      {shown.map((p) => (
        <ProviderRow key={p.id} p={p} checks={checks} conns={connected.filter((c) => c.provider === p.id)} oauth={p.id === 'openrouter' ? s.omniroute?.openrouter : undefined} />
      ))}
      <Fold open={more} onToggle={() => setMore(!more)}>
        {more ? t('收起', 'Show less') : t(`另外 ${PROVIDERS.length - PROVIDERS.filter((p) => p.recommended).length} 家，不推薦`, `${PROVIDERS.length - PROVIDERS.filter((p) => p.recommended).length} more, not recommended`)}
      </Fold>
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

function ProviderRow({ p, conns, oauth, checks }: { p: FreeProvider; conns: NonNullable<NonNullable<ExtensionStatus['omniroute']>['connected']>; oauth?: NonNullable<ExtensionStatus['omniroute']>['openrouter']; checks: NonNullable<NonNullable<ExtensionStatus['omniroute']>['checks']> }) {
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
      {p.warn && (
        <div className="warn-text tiny">
          <Ico i={TriangleAlert} size={14} /> {tl(p.warn)}
        </div>
      )}
      {conns.map((c) => {
        const mine = checks[c.id] ?? {};
        return (
        <div key={c.id} className="omni-conn">
          <StateWord
            className="tiny"
            icon={c.test?.state === 'ok' ? CircleCheck : c.test?.state === 'fail' ? CircleX : c.test?.state === 'testing' ? LoaderCircle : CircleDashed}
            spin={c.test?.state === 'testing'}
            tone={c.test?.state === 'ok' ? 'ok' : c.test?.state === 'fail' ? 'err' : c.test?.state === 'testing' ? 'run' : undefined}
          >
            {c.test?.state === 'ok'
              ? t('已連接，可以跑 agent', 'Connected, can run agents')
              : c.test?.state === 'fail'
                ? t('已連接，但測試沒通過', 'Connected, but the check failed')
                : c.test?.state === 'testing'
                  ? t('測試中…', 'Checking…')
                  : t('已連接，尚未測試', 'Connected, not checked yet')}
            {c.test?.model ? ` · ${c.test.model}` : ''}
          </StateWord>
          <span className="grow" />
          {!!c.models?.length && (
            // Some keys serve only the models they were made for (NVIDIA): the user says which one to check with.
            <select
              className="small"
              aria-label={t(`${p.name} 測試用的模型`, `Model to check ${p.name} with`)}
              disabled={busy || c.test?.state === 'testing'}
              value={c.testModel ?? ''}
              onChange={(e) => run(() => hub.call('extensions.omniSetTestModel', { id: c.id, model: e.target.value || null }))}
            >
              <option value="">{t('測試模型：自動（免費的）', 'Check with: automatic (free)')}</option>
              {(c.testModel && !c.models.includes(c.testModel) ? [c.testModel, ...c.models] : c.models).map((m) => (
                <option key={m} value={m}>
                  {t('測試模型：', 'Check with: ')}
                  {m}
                </option>
              ))}
            </select>
          )}
          <button className="btn small ghost" disabled={busy || c.test?.state === 'testing'} onClick={() => run(() => hub.call('extensions.omniTest', { id: c.id }))}>
            {t('重新測試', 'Check again')}
          </button>
          <button className="btn small ghost danger" disabled={busy} onClick={async () => (await ask(t(`移除 ${p.name} 的連線？`, `Remove the ${p.name} connection?`), { danger: true })) && run(() => hub.call('extensions.omniDisconnect', { id: c.id }))}>
            {t('移除', 'Remove')}
          </button>
          {c.test?.state === 'fail' && c.test.message && <div className="err-text tiny omni-conn-msg">{c.test.message}</div>}
          {c.test?.state === 'fail' && c.test.noFree && (
            <button
              className="btn small ghost omni-conn-msg"
              disabled={busy}
              onClick={async () =>
                (await ask(
                  c.testModel
                    ? t(`用 ${c.testModel} 測試一次？Aivenue 無法確認它是免費的，這一次可能會被收費。`, `Check with ${c.testModel} once? Aivenue cannot tell it is free; this one request may be charged.`)
                    : t(`用 ${p.name} 的付費模型測試一次？會產生一次少量的費用。`, `Check ${p.name} with a paid model? It costs one small request.`),
                )) && run(() => hub.call('extensions.omniTest', { id: c.id, paid: true, confirmed: c.testModel ?? null }))
              }
            >
              {t('用付費模型測試', 'Check with a paid model')}
            </button>
          )}
          <label className="omni-conn-msg row gap tiny">
            <input
              type="checkbox"
              checked={!!c.vouched}
              disabled={busy}
              onChange={async (e) => {
                const on = e.target.checked;
                if (
                  on &&
                  !(await ask(
                    t(
                      `確認 ${p.name} 這把金鑰的模型都是免費的？Aivenue 無法自己查證（例如 NVIDIA 沒有提供查詢免費端點的 API）。勾選後，「測試這家的模型」的範圍會包含價格不明的模型（之後同步進來的也算），每次開始前會再請你確認數量；有標價格的仍然不測。如果其中有要收費的模型，測試可能會被收費。`,
                      `Confirm every model of this ${p.name} key is free? Aivenue cannot check (NVIDIA, for one, has no API for its free endpoints). Once on, checking this provider includes models with no stated price; priced ones are still left out. If one of them does charge, a check may be charged.`,
                    ),
                  ))
                )
                  return;
                run(() => hub.call('extensions.omniVouch', { id: c.id, on }));
              }}
            />
            {t('我確認這把金鑰的模型都是免費的（例如 NVIDIA 的免費端點），批次測試時價格不明的也列入（每次開始前會再確認）', 'I confirm this key’s models are free (NVIDIA’s free endpoints, say): include unpriced ones in a check run (each run asks first)')}
          </label>
          {!!c.freeModels?.length && (
            <div className="omni-conn-msg tiny">
              <button
                className="btn small ghost"
                disabled={busy || !!c.checking}
                onClick={async () => {
                  // Unpriced models (a vouched connection) need this run's okay, with how many: the list is sent along.
                  const unpriced = c.unpricedModels ?? [];
                  // The run is the list shown now: models synced in while the dialog is open wait for the next run.
                  const models = [...c.freeModels!];
                  const ok = unpriced.length
                    ? await ask(
                        t(
                          `本次會測 ${unpriced.length} 個價格不明的模型（另有 ${c.freeModels!.length - unpriced.length} 個能確認免費的），共 ${c.freeModels!.length} 筆請求。價格不明的模型如果其實要收費，可能會產生費用。要開始嗎？`,
                          `This run checks ${unpriced.length} models with no stated price (and ${c.freeModels!.length - unpriced.length} known to be free), ${c.freeModels!.length} requests in all. An unpriced model that does charge may be charged. Start?`,
                        ),
                      )
                    : p.id !== 'openrouter' || (await ask(t(`逐一測試 ${c.freeModels!.length} 個免費模型？每個模型算一次請求，OpenRouter 沒儲值的帳號每天只有 50 次。`, `Check ${c.freeModels!.length} free models one by one? Each is one request; OpenRouter allows 50 a day without credit.`)));
                  if (ok) run(() => hub.call('extensions.omniCheckModels', { id: c.id, confirmed: unpriced, models }));
                }}
              >
                {c.checking ? t(`測試中 ${c.checking.done}/${c.checking.total}…`, `Checking ${c.checking.done}/${c.checking.total}…`) : c.vouched ? t(`測試這家的模型（${c.freeModels.length} 個）`, `Check this provider's models (${c.freeModels.length})`) : t(`測試這家的免費模型（${c.freeModels.length} 個）`, `Check this provider's free models (${c.freeModels.length})`)}
              </button>{' '}
              <span className="muted">
                {t(
                  `可用 ${c.freeModels.filter((m) => mine[m]?.state === 'ok').length} 個，沒通過 ${c.freeModels.filter((m) => mine[m]?.state === 'fail').length} 個，還沒有結果 ${c.freeModels.filter((m) => !mine[m] || mine[m].state === 'testing').length} 個`,
                  `${c.freeModels.filter((m) => mine[m]?.state === 'ok').length} work, ${c.freeModels.filter((m) => mine[m]?.state === 'fail').length} failed, ${c.freeModels.filter((m) => !mine[m] || mine[m].state === 'testing').length} without a result`,
                )}
              </span>
              {c.freeModels.some((m) => mine[m]) && (
                <details>
                  <summary className="muted">{t('每個模型的結果', 'Each model')}</summary>
                  <ul className="omni-checks">
                    {c.freeModels
                      .filter((m) => mine[m])
                      .map((m) => (
                        <li key={m} className={mine[m].state === 'ok' ? 'ok-text' : mine[m].state === 'fail' ? 'err-text' : 'muted'}>
                          {mine[m].state === 'ok' ? '✓' : mine[m].state === 'fail' ? '✗' : '…'} {m}
                          {mine[m].state === 'fail' && mine[m].message ? `：${mine[m].message}` : ''}
                        </li>
                      ))}
                  </ul>
                </details>
              )}
            </div>
          )}
          {c.sync && !c.sync.ok && (
            <div className="muted tiny omni-conn-msg">
              {t('這次沒有更新模型清單，沿用原本的清單：', 'The model list was not updated this time; the previous one stays: ')}
              {c.sync.message}
            </div>
          )}
        </div>
        );
      })}
      {p.id === 'openrouter' && (
        <>
          <div className="row gap wrap">
            <button className="btn small primary" disabled={busy || oauth?.state === 'connecting'} onClick={() => run(() => hub.call('extensions.omniOpenRouter'))}>
              {conns.length ? t('用另一個 OpenRouter 帳號連接', 'Connect another OpenRouter account') : t('用 OpenRouter 帳號連接', 'Connect with OpenRouter')}
            </button>
            {oauth?.state === 'waiting' && oauth.url && (
              <button className="btn small ghost" onClick={() => hub.call('host.openExternal', { url: oauth.url })}>
                {t('重新開啟授權頁', 'Open the sign-in page again')}
              </button>
            )}
          </div>
          <OpenRouterAuth oauth={oauth} />
          <div className="muted tiny">{t('或自己建立金鑰貼上：', 'Or create a key yourself and paste it:')}</div>
        </>
      )}
      <div className="row gap omni-prov-key">
        <button className="btn small link-icon" onClick={() => hub.call('host.openExternal', { url: p.keyUrl })}>
          <Ico i={ExternalLink} size={14} /> {t('取得金鑰', 'Get a key')}
        </button>
        <input type="password" className="grow" autoComplete="off" aria-label={t(`${p.name} 的 API 金鑰`, `${p.name} API key`)} placeholder={conns.length ? t('貼上另一把金鑰（多一個帳號）', 'Paste another key (one more account)') : t('貼上 API 金鑰', 'Paste the API key')} value={key} onChange={(e) => setKey(e.target.value)} />
        <button className="btn small primary" disabled={busy || !key.trim()} onClick={() => run(() => hub.call('extensions.omniConnect', { provider: p.id, apiKey: key })).then((ok) => ok && setKey(''))}>
          {busy ? t('連接並測試中…', 'Connecting and checking…') : t('連接', 'Connect')}
        </button>
      </div>
      {error && <div className="err-text tiny">{error}</div>}
    </div>
  );
}

/** Where OpenRouter's sign-in stands (also shown on the Capabilities page, where turning OmniRoute on starts it). */
export function OpenRouterAuth({ oauth }: { oauth?: NonNullable<ExtensionStatus['omniroute']>['openrouter'] }) {
  const t = useT();
  if (!oauth) return null;
  if (oauth.state === 'error') return <div className="err-text tiny">{oauth.message}</div>;
  return (
    <StateWord className="tiny" icon={LoaderCircle} spin tone="run">
      {oauth.state === 'waiting'
        ? t('已在瀏覽器開啟 OpenRouter：登入（或註冊）後按 Authorize，Aivenue 會自動接上並測試。', 'OpenRouter is open in your browser: sign in (or sign up) and press Authorize; Aivenue connects and checks it.')
        : t('OpenRouter 已授權，正在接上 OmniRoute 並測試…', 'OpenRouter authorized; connecting it to OmniRoute and checking…')}
    </StateWord>
  );
}
