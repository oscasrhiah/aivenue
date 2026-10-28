import { useEffect, useState } from 'react';
import type { ProviderUsage } from '../../../core/src/types';
import { hub, useHostInfo, useProviders, useUsage } from '../api';
import { ACCENTS, saveSettings, useAppSettings, useT } from '../i18n';
import { cx, fmtTokens, modelLabel, providerColor, providerName } from '../util';
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

/** A quota window shown the way the vendors' own apps do: the share that is LEFT, with the used share as detail. */
function Meter({ used, label, sub, detail }: { used: number; label: string; sub?: string; detail?: string }) {
  const t = useT();
  const left = Math.max(0, Math.min(100, 100 - used));
  const level = left <= 10 ? 'err' : left <= 30 ? 'warn' : '';
  return (
    <div className="meter">
      <div className="row between small gap">
        <span>{label}</span>
        <span className={cx('nowrap', level === 'err' ? 'err-text' : level === 'warn' ? 'warn-text' : 'muted')}>{t(`剩餘 ${left.toFixed(0)}%`, `${left.toFixed(0)}% left`)}</span>
      </div>
      <div className="meter-track">
        <div className={cx('meter-fill', level)} style={{ width: `${left}%` }} />
      </div>
      <div className="muted tiny">
        {t(`已用 ${Math.max(0, Math.min(100, used)).toFixed(0)}%`, `${Math.max(0, Math.min(100, used)).toFixed(0)}% used`)}
        {sub ? ` · ${sub}` : ''}
      </div>
      {detail && <div className="muted tiny">{detail}</div>}
    </div>
  );
}

/** Antigravity's quota needs a Google sign-in of its own; this connects or disconnects it. */
function AntigravityConnect({ connected, error }: { connected: boolean; error?: string }) {
  const t = useT();
  const [waiting, setWaiting] = useState(false);
  const [authUrl, setAuthUrl] = useState<string>();
  const [fail, setFail] = useState<string>();
  const connect = () => {
    setFail(undefined);
    hub
      .call<{ authUrl: string; opened: boolean }>('quota.antigravity.connect')
      .then((r) => {
        // Browsers may block the pop-up; the link below always works.
        if (!r.opened) window.open(r.authUrl, '_blank', 'noopener');
        setAuthUrl(r.authUrl);
        setWaiting(true);
      })
      .catch((e) => setFail((e as Error).message));
  };
  if (connected)
    return (
      <button className="link tiny" onClick={() => hub.call('quota.antigravity.disconnect')}>
        {t('中斷 Google 連線', 'Disconnect Google')}
      </button>
    );
  return (
    <div className="stack">
      <div className="muted tiny">
        {t('Antigravity 的額度要向 Google 查詢。連接一次 Google 帳號（官方登入頁，Aivenue 不經手密碼）後，這裡會顯示每個模型的剩餘額度與重置時間。', "Antigravity's quota comes from Google. Connect your Google account once (Google's own sign-in page; Aivenue never sees your password) to see each model's remaining share and reset time here.")}
      </div>
      {(error || fail) && <div className="note warn small">{fail ?? error}</div>}
      <div className="row gap">
        <button className="btn small" onClick={connect}>
          {t('連接 Google 帳號', 'Connect Google account')}
        </button>
        {waiting && <span className="muted tiny">{t('請在瀏覽器完成登入，完成後這裡會自動更新。', 'Finish signing in in the browser; this updates by itself.')}</span>}
        {authUrl && (
          <a className="link tiny" href={authUrl} target="_blank" rel="noopener noreferrer">
            {t('沒有跳出登入頁？點這裡開啟 Google 登入頁', 'No sign-in page? Open Google sign-in')}
          </a>
        )}
      </div>
    </div>
  );
}

function UsageCard({ u, name }: { u: ProviderUsage; name: string }) {
  const t = useT();
  const max = Math.max(1, ...u.daily.map((d) => d.input + d.output + d.cached));
  const windowLabel = (m: number) => (m >= 43200 ? t('每月', 'Monthly') : m >= 10080 ? t('每週', 'Weekly') : m >= 1440 ? t(`${Math.round(m / 1440)} 天`, `${Math.round(m / 1440)}-day`) : t(`${Math.round(m / 60)} 小時`, `${Math.round(m / 60)}-hour`));
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
            <Meter key={`${w.minutes}-${w.label ?? ''}`} used={w.usedPercent} label={w.label ?? t(`${windowLabel(w.minutes)}額度`, `${windowLabel(w.minutes)} limit`)} sub={resets(w.resetsAt)} detail={w.detail} />
          ))}
          {u.official.limitReached && <div className="note warn small">{t('目前已達用量上限，要等上面的重置時間。', 'The plan limit is reached right now; wait for the reset time above.')}</div>}
          {!!u.official.resetCredits && <div className="muted tiny">{t(`帳號還有 ${u.official.resetCredits} 次免費「額度重置」可用（在 Codex 裡使用）。`, `The account has ${u.official.resetCredits} free limit reset(s) left (use them in Codex).`)}</div>}
          <div className="muted tiny">
            {u.official.source === 'antigravity-live'
              ? t(`來源：Google 即時查詢${u.official.account ? `（${u.official.account}）` : ''}，${new Date(u.official.updatedAt).toLocaleTimeString()}`, `Source: live from Google${u.official.account ? ` (${u.official.account})` : ''}, ${new Date(u.official.updatedAt).toLocaleTimeString()}`)
              : u.official.source === 'claude-live'
              ? t(`來源：Claude 即時查詢（與 Claude Code 的 /usage 相同），${new Date(u.official.updatedAt).toLocaleTimeString()}`, `Source: live from Claude (same as /usage in Claude Code), ${new Date(u.official.updatedAt).toLocaleTimeString()}`)
              : u.official.source === 'copilot-live'
              ? t(`來源：GitHub 即時查詢${u.official.account ? `（${u.official.account}）` : ''}，${new Date(u.official.updatedAt).toLocaleTimeString()}`, `Source: live from GitHub${u.official.account ? ` (${u.official.account})` : ''}, ${new Date(u.official.updatedAt).toLocaleTimeString()}`)
              : u.official.source === 'codex-live'
              ? t(`來源：Codex 即時查詢（${new Date(u.official.updatedAt).toLocaleTimeString()}）`, `Source: live from Codex (${new Date(u.official.updatedAt).toLocaleTimeString()})`)
              : t(`來源：Codex 本機紀錄，最後一次執行時的狀態（${new Date(u.official.updatedAt).toLocaleString()}）`, `Source: Codex local log, as of its last run (${new Date(u.official.updatedAt).toLocaleString()})`)}
          </div>
          {u.providerId === 'antigravity' && <AntigravityConnect connected />}
        </div>
      ) : u.providerId === 'antigravity' ? (
        <AntigravityConnect connected={false} error={u.officialError} />
      ) : u.officialError ? (
        <div className="note warn small">{u.officialError}</div>
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

      {!!u.models?.length && (
        <table className="umodels">
          <thead>
            <tr>
              <th>{t('依模型（近 7 天）', 'By model (7 days)')}</th>
              <th>{t('今日', 'Today')}</th>
              <th>{t('7 天', '7 days')}</th>
              <th>{t('執行', 'Runs')}</th>
            </tr>
          </thead>
          <tbody>
            {u.models.map((m) => {
              const week = m.last7.input + m.last7.output;
              const all = u.last7.input + u.last7.output;
              return (
                <tr key={m.model}>
                  <td title={m.model || undefined}>
                    <div className="umodel-name">{m.model ? modelLabel(m.model) : t('CLI 預設模型', 'CLI default model')}</div>
                    <div className="umodel-bar">
                      <span style={{ width: `${all ? Math.max(2, (week / all) * 100) : 0}%` }} />
                    </div>
                  </td>
                  <td>{fmtTokens(m.today.input + m.today.output)}</td>
                  <td>{fmtTokens(week)}</td>
                  <td>{m.last7.runs}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
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
  const refresh = (all = false) => {
    setLoading(true);
    // The button re-checks everything (sign-in and model lists too); the timer only the usage.
    Promise.all([hub.call<ProviderUsage[]>('usage.get', { refresh: true }).then(setFresh), all ? hub.call('providers.refresh', {}) : undefined])
      .catch(() => undefined)
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    refresh();
    const timer = setInterval(() => refresh(), 60000);
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
              '額度和官方 App 一樣顯示「剩餘」百分比。Claude Code 用它自己的登入查詢 5 小時與每週額度；Codex 直接向 Codex 即時查詢；Antigravity 連接 Google 帳號後向 Google 查詢各組模型的額度；GitHub Copilot 用已登入的 GitHub 帳號查詢每月進階請求；其他家沒有公開的查詢方式，顯示的是 Aivenue 統計的每次執行 tokens 與費用。開啟這頁時會立即更新，之後每分鐘自動更新。',
              "Quotas show the share LEFT, like the vendors' own apps. Claude Code's 5-hour and weekly limits are read with its own sign-in; Codex is read live from Codex; Antigravity per model group from Google once you connect a Google account; GitHub Copilot's monthly premium requests with your GitHub sign-in; other vendors have no public lookup, so their numbers are the tokens and cost Aivenue tracked per run. Refreshed when you open this page and every minute after.",
            )}
          </p>
        </div>
        <div className="row gap">
          {checkedAt && <span className="muted tiny">{t(`更新於 ${new Date(checkedAt).toLocaleTimeString()}`, `Updated ${new Date(checkedAt).toLocaleTimeString()}`)}</span>}
          <button className="btn" disabled={loading} onClick={() => refresh(true)}>
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

/** Version and build of the window and of its background service; a mismatch means a reload is due. */
function BuildInfo() {
  const t = useT();
  const host = useHostInfo();
  const ui = typeof __AIVENUE_BUILD__ === 'string' ? __AIVENUE_BUILD__ : 'dev';
  if (!host) return null;
  const same = !host.build || host.build === ui;
  return (
    <div className="build-info" title={t(`畫面：${ui}\n背景程式：${host.build ?? '?'}`, `Window: ${ui}\nBackground service: ${host.build ?? '?'}`)}>
      Aivenue {host.version}
      <br />
      {t('建置', 'Build')} {host.build ?? ui}
      {!same && (
        <div className="warn-text">
          {t('畫面和背景程式不是同一個建置：請重新載入視窗（VS Code：Developer: Reload Window）。', 'The window and the background service are different builds: reload the window (VS Code: Developer: Reload Window).')}
        </div>
      )}
    </div>
  );
}

export function Settings({ tab, backHref = '#/new' }: { tab: Tab; backHref?: string }) {
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
        <a className="settings-back" href={backHref}>
          ← {t('返回對話', 'Back to chat')}
        </a>
        <BuildInfo />
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
