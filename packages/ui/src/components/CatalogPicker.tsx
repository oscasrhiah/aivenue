import { useEffect, useMemo, useState } from 'react';
import type { CatalogProvider } from '../../../core/src/types';
import { hub, useProviders } from '../api';
import { useT } from '../i18n';
import { cx } from '../util';

type Kind = CatalogProvider['kind'] | 'custom';

/** Pick a subscription plan / API / local provider from the models.dev catalog and add it with a key. */
export function CatalogPicker({ onDone }: { onDone: () => void }) {
  const t = useT();
  const providers = useProviders();
  const [catalog, setCatalog] = useState<CatalogProvider[] | null>(null);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<Kind>('plan');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<CatalogProvider | null>(null);
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState({ name: '', baseURL: 'http://localhost:11434/v1', model: '' });
  const [busy, setBusy] = useState(false);
  const opencodeReady = providers.find((p) => p.spec.id === 'opencode')?.installed;

  useEffect(() => {
    hub.call<CatalogProvider[]>('catalog.list', {}).then(setCatalog).catch((e) => setError(e.message));
  }, []);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (catalog ?? []).filter((p) => (s ? `${p.id} ${p.name}`.toLowerCase().includes(s) : p.kind === tab));
  }, [catalog, q, tab]);

  const added = new Set(providers.map((p) => p.spec.id));
  const add = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (tab === 'custom') await hub.call('catalog.add', { custom, key });
      else await hub.call('catalog.add', { providerId: sel!.id, key, model: model || undefined, extraEnv: extra });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const tabs: { id: Kind; label: string; hint: string }[] = [
    { id: 'plan', label: t('訂閱方案', 'Subscription plans'), hint: t('Coding Plan / Token Plan 等月費方案（如 Kimi、阿里 Qwen、GLM、MiniMax、火山方舟）', 'Monthly coding / token plans (Kimi, Alibaba Qwen, GLM, MiniMax, Volcengine…)') },
    { id: 'api', label: t('按量 API', 'Pay-as-you-go API'), hint: t('一般 API 金鑰，依用量計費', 'Regular API keys billed by usage') },
    { id: 'local', label: t('本機', 'Local'), hint: t('在這台電腦執行的模型伺服器', 'Model servers running on this machine') },
    { id: 'custom', label: t('自訂端點', 'Custom endpoint'), hint: t('任何 OpenAI 相容的 API（例如 Ollama、vLLM、公司內部閘道）', 'Any OpenAI-compatible API (Ollama, vLLM, company gateway…)') },
  ];

  return (
    <div className="catalog">
      {!opencodeReady && (
        <div className="note warn">
          {t('這些供應商透過 OpenCode 執行，請先在供應商列表安裝 OpenCode。', 'These providers run through OpenCode; install OpenCode from the provider list first.')}
        </div>
      )}
      <div className="row gap wrap">
        <div className="seg">
          {tabs.map((x) => (
            <button key={x.id} className={cx(tab === x.id && !q && 'on')} onClick={() => (setTab(x.id), setQ(''), setSel(null))}>
              {x.label}
            </button>
          ))}
        </div>
        {tab !== 'custom' && <input className="grow" placeholder={t(`搜尋全部 ${catalog?.length ?? ''} 家…`, `Search all ${catalog?.length ?? ''}…`)} value={q} onChange={(e) => setQ(e.target.value)} />}
      </div>
      <div className="muted small">{tabs.find((x) => x.id === tab)?.hint}</div>
      {error && <div className="note err">{error}</div>}

      {tab === 'custom' ? (
        <div className="stack">
          <div className="kv">
            <label>{t('名稱', 'Name')}</label>
            <input value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} placeholder="Ollama" />
          </div>
          <div className="kv">
            <label>Base URL</label>
            <input className="mono" value={custom.baseURL} onChange={(e) => setCustom({ ...custom, baseURL: e.target.value })} />
          </div>
          <div className="kv">
            <label>{t('模型', 'Model')}</label>
            <input className="mono" value={custom.model} onChange={(e) => setCustom({ ...custom, model: e.target.value })} placeholder="qwen3-coder:30b" />
          </div>
          <div className="kv">
            <label>{t('金鑰', 'Key')}</label>
            <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={t('本機伺服器可留空', 'Optional for local servers')} />
          </div>
          <div className="row end">
            <button className="btn primary" disabled={busy || !custom.name.trim() || !custom.model.trim()} onClick={add}>
              {t('新增', 'Add')}
            </button>
          </div>
        </div>
      ) : (
        <div className="catalog-body">
          <div className="catalog-list">
            {!catalog && !error && <div className="muted small">{t('正在讀取供應商目錄…', 'Loading the provider catalog…')}</div>}
            {list.map((p) => (
              <button key={p.id} className={cx('cat-item', sel?.id === p.id && 'on')} onClick={() => (setSel(p), setKey(''), setModel(''), setExtra({}))}>
                <span className="cat-name">{p.name}</span>
                <span className="muted tiny">
                  {p.id} · {p.models.length} {t('個模型', 'models')}
                  {added.has(`api-${p.id}`) && ` · ${t('已加入', 'added')}`}
                </span>
              </button>
            ))}
          </div>
          <div className="catalog-detail">
            {!sel ? (
              <div className="muted small">{t('從左側選擇一家供應商。', 'Pick a provider on the left.')}</div>
            ) : (
              <div className="stack">
                <div className="row between">
                  <strong>{sel.name}</strong>
                  <span className="tag">{sel.kind === 'plan' ? t('訂閱方案', 'Plan') : sel.kind === 'local' ? t('本機', 'Local') : 'API'}</span>
                </div>
                {sel.api && <div className="muted tiny mono">{sel.api}</div>}
                {sel.doc && (
                  <button className="link" onClick={() => hub.call('host.openExternal', { url: sel.doc })}>
                    {t('取得金鑰／說明文件 ↗', 'Get a key / docs ↗')}
                  </button>
                )}
                <div className="field">
                  <label>{sel.env[0] ?? t('API 金鑰', 'API key')}</label>
                  <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={sel.kind === 'local' ? t('可留空', 'optional') : ''} />
                </div>
                {sel.env.slice(1).map((name) => (
                  <div key={name} className="field">
                    <label>{name}</label>
                    <input value={extra[name] ?? ''} onChange={(e) => setExtra({ ...extra, [name]: e.target.value })} />
                  </div>
                ))}
                <div className="field">
                  <label>{t('預設模型', 'Default model')}</label>
                  <select value={model} onChange={(e) => setModel(e.target.value)}>
                    <option value="">{sel.models[0]?.name ?? '—'}</option>
                    {sel.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                        {m.free ? ' · free' : ''}
                        {m.vision ? ' · vision' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="muted tiny">{t('金鑰會加密保存，只在執行時交給 OpenCode。', 'The key is stored encrypted and only handed to OpenCode at run time.')}</div>
                <div className="row end">
                  <button className="btn primary" disabled={busy || (!key.trim() && sel.kind !== 'local')} onClick={add}>
                    {added.has(`api-${sel.id}`) ? t('更新', 'Update') : t('加入', 'Add')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
