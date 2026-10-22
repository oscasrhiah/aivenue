import { useEffect, useState } from 'react';
import type { ProviderUsage } from '../../../core/src/types';
import { hub, useHostInfo, useProviders, useUsage } from '../api';
import { ACCENTS, saveSettings, useAppSettings, useT } from '../i18n';
import { cx, fmtTokens, providerColor, providerName } from '../util';
import { ProvidersPane } from './Providers';
import { CapabilitiesPane } from './Capabilities';

type Tab = 'general' | 'providers' | 'capabilities' | 'usage';

function GeneralPane() {
  const t = useT();
  const s = useAppSettings();
  const host = useHostInfo();
  return (
    <div className="pane">
      <div className="pane-head">
        <h2>{t('一般', 'General')}</h2>
      </div>
      <section className="setting">
        <div>
          <div className="setting-title">{t('外觀', 'Appearance')}</div>
          <div className="muted small">{t('跟隨系統，或固定淺色／深色', 'Follow the system, or force light / dark')}</div>
        </div>
        <div className="seg">
          {(['system', 'light', 'dark'] as const).map((v) => (
            <button key={v} className={cx(s.theme === v && 'on')} onClick={() => saveSettings({ theme: v })}>
              {v === 'system' ? t('系統', 'System') : v === 'light' ? t('淺色', 'Light') : t('深色', 'Dark')}
            </button>
          ))}
        </div>
      </section>
      {host?.host === 'vscode' && <div className="muted small">{t('在 VS Code 中會沿用編輯器的佈景主題色彩。', 'Inside VS Code the editor theme colors are used.')}</div>}
      <section className="setting">
        <div>
          <div className="setting-title">{t('強調色', 'Accent color')}</div>
          <div className="muted small">{t('按鈕焦點、連結與進度指示的顏色', 'Used for focus, links and progress indicators')}</div>
        </div>
        <div className="swatches">
          {ACCENTS.map((a) => (
            <button key={a.id} className={cx('swatch', s.accent === a.id && 'on')} style={{ background: a.id }} title={t(a.zh, a.en)} onClick={() => saveSettings({ accent: a.id })} />
          ))}
          <label className="swatch custom" title={t('自訂', 'Custom')}>
            <input type="color" value={s.accent} onChange={(e) => saveSettings({ accent: e.target.value })} />
          </label>
        </div>
      </section>
      <section className="setting">
        <div>
          <div className="setting-title">{t('語言', 'Language')}</div>
          <div className="muted small">{t('介面與 Aivenue 訊息的語言（agent 會用你任務描述的語言回覆）', 'Language of the interface and Aivenue messages (agents reply in the language of your task)')}</div>
        </div>
        <select value={s.locale} onChange={(e) => saveSettings({ locale: e.target.value as 'zh-TW' | 'en' })}>
          <option value="zh-TW">繁體中文</option>
          <option value="en">English</option>
        </select>
      </section>
      <section className="setting">
        <div>
          <div className="setting-title">{t('資料位置', 'Data folder')}</div>
          <div className="muted small">{t('設定、對話紀錄與用量統計存放處', 'Where settings, chat logs and usage stats are stored')}</div>
        </div>
        <code className="muted">{host?.dataDir}</code>
      </section>
    </div>
  );
}

function Meter({ value, label, sub }: { value: number; label: string; sub?: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="meter">
      <div className="row between small">
        <span>{label}</span>
        <span className={cx(v >= 90 ? 'err-text' : v >= 70 ? 'warn-text' : 'muted')}>{v.toFixed(0)}%</span>
      </div>
      <div className="meter-track">
        <div className={cx('meter-fill', v >= 90 ? 'err' : v >= 70 ? 'warn' : '')} style={{ width: `${v}%` }} />
      </div>
      {sub && <div className="muted tiny">{sub}</div>}
    </div>
  );
}

function UsageCard({ u, name }: { u: ProviderUsage; name: string }) {
  const t = useT();
  const max = Math.max(1, ...u.daily.map((d) => d.input + d.output + d.cached));
  const windowLabel = (m: number) => (m >= 10080 ? t('每週', 'Weekly') : m >= 1440 ? t(`${Math.round(m / 1440)} 天`, `${Math.round(m / 1440)}-day`) : t(`${Math.round(m / 60)} 小時`, `${Math.round(m / 60)}-hour`));
  const resets = (ts?: number) => (ts ? t(`重置於 ${new Date(ts).toLocaleString()}`, `Resets ${new Date(ts).toLocaleString()}`) : undefined);
  return (
    <div className="ucard">
      <div className="row gap">
        <span className="mark lg" style={{ background: providerColor(u.providerId) }} />
        <strong className="grow">{name}</strong>
        {u.official?.plan && <span className="tag">{u.official.plan}</span>}
      </div>

      {u.official ? (
        <div className="stack">
          {u.official.windows.map((w) => (
            <Meter key={w.minutes} value={w.usedPercent} label={t(`${windowLabel(w.minutes)}額度`, `${windowLabel(w.minutes)} limit`)} sub={resets(w.resetsAt)} />
          ))}
          {u.official.limitReached && <div className="note warn small">{t('目前已達用量上限，要等上面的重置時間。', 'The plan limit is reached right now; wait for the reset time above.')}</div>}
          {!!u.official.resetCredits && <div className="muted tiny">{t(`帳號還有 ${u.official.resetCredits} 次免費「額度重置」可用（在 Codex 裡使用）。`, `The account has ${u.official.resetCredits} free limit reset(s) left (use them in Codex).`)}</div>}
          <div className="muted tiny">
            {u.official.source === 'codex-live'
              ? t(`來源：Codex 即時查詢（${new Date(u.official.updatedAt).toLocaleTimeString()}）`, `Source: live from Codex (${new Date(u.official.updatedAt).toLocaleTimeString()})`)
              : t(`來源：Codex 本機紀錄，最後一次執行時的狀態（${new Date(u.official.updatedAt).toLocaleString()}）`, `Source: Codex local log, as of its last run (${new Date(u.official.updatedAt).toLocaleString()})`)}
          </div>
        </div>
      ) : (
        <div className="muted tiny">{t('此 CLI 沒有在本機提供官方剩餘額度，以下為 Aivenue 統計的用量。', 'This CLI does not expose its plan quota locally; below is usage tracked by Aivenue.')}</div>
      )}

      {u.limitHit && (
        <div className="note warn">
          {t('最近一次達到用量上限：', 'Last limit hit: ')}
          {new Date(u.limitHit.at).toLocaleString()} — {u.limitHit.message}
        </div>
      )}

      <div className="ustats">
        <div>
          <div className="big">{u.today.runs}</div>
          <div className="muted tiny">{t('今日執行', 'Runs today')}</div>
        </div>
        <div>
          <div className="big">{fmtTokens(u.today.input + u.today.output)}</div>
          <div className="muted tiny">{t('今日 tokens', 'Tokens today')}</div>
        </div>
        <div>
          <div className="big">{fmtTokens(u.last7.input + u.last7.output)}</div>
          <div className="muted tiny">{t('7 天 tokens', '7-day tokens')}</div>
        </div>
        <div>
          <div className="big">{u.last7.costUsd > 0 ? `$${u.last7.costUsd.toFixed(2)}` : '—'}</div>
          <div className="muted tiny">{t('7 天估計費用', '7-day est. cost')}</div>
        </div>
      </div>

      <div className="spark-bars" title={t('近 14 天 tokens', 'Tokens, last 14 days')}>
        {u.daily.map((d) => {
          const total = d.input + d.output + d.cached;
          return <div key={d.date} className="bar" style={{ height: `${Math.max(2, (total / max) * 100)}%` }} title={`${d.date}: ${fmtTokens(total)} tokens · ${d.runs} runs`} />;
        })}
      </div>
    </div>
  );
}

function UsagePane() {
  const t = useT();
  const pushed = useUsage();
  const providers = useProviders();
  const [fresh, setFresh] = useState<ProviderUsage[] | null>(null);
  const [loading, setLoading] = useState(false);
  // Opening the page (and every minute while it stays open) re-reads everything, including live quotas.
  const refresh = () => {
    setLoading(true);
    hub
      .call<ProviderUsage[]>('usage.get', { refresh: true })
      .then(setFresh)
      .catch(() => undefined)
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 60000);
    return () => clearInterval(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Pushed updates (a run just finished) are newer than our last fetch.
  const usage = fresh && (pushed[0]?.checkedAt ?? 0) <= (fresh[0]?.checkedAt ?? 0) ? fresh : pushed;
  const checkedAt = usage[0]?.checkedAt;
  return (
    <div className="pane">
      <div className="pane-head">
        <div>
          <h2>{t('用量', 'Usage')}</h2>
          <p className="muted">
            {t(
              'Codex 的方案額度是直接向 Codex 即時查詢；其他家沒有公開的剩餘額度查詢方式，顯示的是 Aivenue 統計的每次執行 tokens 與費用。開啟這頁時會立即更新，之後每分鐘自動更新。',
              'Codex plan limits are read live from Codex; other vendors have no public quota lookup, so their numbers are the tokens and cost Aivenue tracked per run. Refreshed when you open this page and every minute after.',
            )}
          </p>
        </div>
        <div className="row gap">
          {checkedAt && <span className="muted tiny">{t(`更新於 ${new Date(checkedAt).toLocaleTimeString()}`, `Updated ${new Date(checkedAt).toLocaleTimeString()}`)}</span>}
          <button className="btn" disabled={loading} onClick={refresh}>
            {loading ? t('更新中…', 'Refreshing…') : t('重新整理', 'Refresh')}
          </button>
        </div>
      </div>
      <div className="ugrid">
        {usage.map((u) => (
          <UsageCard key={u.providerId} u={u} name={providerName(providers, u.providerId)} />
        ))}
      </div>
    </div>
  );
}

export function Settings({ tab }: { tab: Tab }) {
  const t = useT();
  const tabs: { id: Tab; label: string }[] = [
    { id: 'general', label: t('一般', 'General') },
    { id: 'providers', label: t('供應商與帳號', 'Providers') },
    { id: 'capabilities', label: t('能力', 'Capabilities') },
    { id: 'usage', label: t('用量', 'Usage') },
  ];
  return (
    <div className="settings">
      <nav className="settings-nav">
        <div className="settings-title">{t('設定', 'Settings')}</div>
        {tabs.map((x) => (
          <a key={x.id} href={`#/settings/${x.id}`} className={cx(tab === x.id && 'active')}>
            {x.label}
          </a>
        ))}
      </nav>
      <div className="settings-body">
        {tab === 'general' && <GeneralPane />}
        {tab === 'providers' && <ProvidersPane />}
        {tab === 'capabilities' && <CapabilitiesPane />}
        {tab === 'usage' && <UsagePane />}
      </div>
    </div>
  );
}
