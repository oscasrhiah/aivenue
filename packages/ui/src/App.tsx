import { useEffect, useState } from 'react';
import { useConnection, useWorkflows } from './api';
import logo from './assets/logo.svg';
import { SettingsProvider, useT } from './i18n';
import { Chat } from './pages/Chat';
import { Settings } from './pages/Settings';
import { cx, relativeDay, wfStatus } from './util';

type SettingsTab = 'general' | 'providers' | 'capabilities' | 'usage';
type Route = { page: 'new' } | { page: 'run'; id: string } | { page: 'settings'; tab: SettingsTab };

function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  if (h.startsWith('run/')) return { page: 'run', id: h.slice(4) };
  if (h.startsWith('settings')) {
    const tab = h.split('/')[1] as SettingsTab;
    return { page: 'settings', tab: ['providers', 'capabilities', 'usage'].includes(tab) ? tab : 'general' };
  }
  if (h === 'providers') return { page: 'settings', tab: 'providers' };
  return { page: 'new' };
}

export function navigate(path: string) {
  location.hash = '#/' + path;
}

/** Narrow layouts (e.g. the VS Code side bar): history and settings move behind this bar. */
function CompactBar({ route, onMenu }: { route: Route; onMenu: () => void }) {
  const t = useT();
  return (
    <div className="compact-bar">
      <button className="icon-btn" title={t('對話紀錄', 'Chat history')} onClick={onMenu}>
        ☰
      </button>
      <img className="logo" src={logo} alt="" />
      <span className="wordmark">Aivenue</span>
      <span className="grow" />
      <a className={cx('icon-btn', route.page === 'new' && 'active')} href="#/new" title={t('新對話', 'New chat')}>
        ＋
      </a>
      <a className={cx('icon-btn', route.page === 'settings' && 'active')} href="#/settings/general" title={t('設定', 'Settings')}>
        ⚙
      </a>
    </div>
  );
}

function Sidebar({ route, open }: { route: Route; open: boolean }) {
  const t = useT();
  const conn = useConnection();
  const workflows = useWorkflows();
  let lastGroup = '';
  return (
    <aside className={cx('sidebar', open && 'open')}>
      <div className="side-top">
        <img className="logo" src={logo} alt="" />
        <span className="wordmark">Aivenue</span>
      </div>
      <a className={cx('side-link', route.page === 'new' && 'active')} href="#/new">
        <span className="side-icon">＋</span> {t('新對話', 'New chat')}
      </a>
      <div className="side-list">
        {workflows.map((w) => {
          const group = relativeDay(t, w.createdAt);
          const header = group !== lastGroup ? ((lastGroup = group), <div className="side-group">{group}</div>) : null;
          const st = wfStatus(t, w.status);
          return (
            <div key={w.id}>
              {header}
              <a href={`#/run/${w.id}`} className={cx('side-item', route.page === 'run' && route.id === w.id && 'active')} title={`${w.title}\n${st.label}`}>
                <span className="side-item-title">{w.title}</span>
                {(w.status === 'running' || w.status === 'paused' || w.status === 'waiting_human' || w.status === 'failed') && <span className={cx('dot', st.cls)} />}
              </a>
            </div>
          );
        })}
      </div>
      <div className="side-bottom">
        <a className={cx('side-link', route.page === 'settings' && 'active')} href="#/settings/general">
          <span className="side-icon">⚙</span> {t('設定', 'Settings')}
        </a>
        <span className={cx('conn', conn)} title={conn === 'open' ? t('已連線', 'Connected') : t('重新連線中…', 'Reconnecting…')} />
      </div>
    </aside>
  );
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    const on = () => {
      setRoute(parseHash());
      setMenu(false);
    };
    // VS Code webviews swallow clicks on "#..." links (they only scroll), so in-app links navigate here.
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href^="#/"]');
      if (!a) return;
      e.preventDefault();
      location.hash = a.getAttribute('href')!;
    };
    window.addEventListener('hashchange', on);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('hashchange', on);
      document.removeEventListener('click', onClick, true);
    };
  }, []);
  return (
    <SettingsProvider>
      <div className="app">
        <Sidebar route={route} open={menu} />
        {menu && <div className="side-scrim" onClick={() => setMenu(false)} />}
        <main className="main">
          <CompactBar route={route} onMenu={() => setMenu(!menu)} />
          {route.page === 'new' && <Chat key="new" />}
          {route.page === 'run' && <Chat key={route.id} id={route.id} />}
          {route.page === 'settings' && <Settings tab={route.tab} />}
        </main>
      </div>
    </SettingsProvider>
  );
}
