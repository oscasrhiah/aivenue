import { useEffect, useState } from 'react';
import { Menu, PanelLeftClose, Pencil, Plus, Settings as SettingsIcon } from 'lucide-react';
import { useConnection, useHostInfo, useSettings, useThreads } from './api';
import logo from './assets/logo.svg';
import { AskHost } from './components/Ask';
import { RenameInput } from './components/Rename';
import { saveSettingsQuietly, SettingsProvider, useT } from './i18n';
import { Chat } from './pages/Chat';
import { Settings } from './pages/Settings';
import { cx, relativeDay, wfStatus } from './util';
import { Ico } from './icons';

type SettingsTab = 'general' | 'providers' | 'capabilities' | 'usage' | 'memory';
type Route = { page: 'new' } | { page: 'run'; id: string } | { page: 'settings'; tab: SettingsTab };

function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  if (h.startsWith('run/')) return { page: 'run', id: h.slice(4) };
  if (h.startsWith('settings')) {
    const tab = h.split('/')[1] as SettingsTab;
    return { page: 'settings', tab: ['providers', 'capabilities', 'usage', 'memory'].includes(tab) ? tab : 'general' };
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
      <button className="icon-btn" title={t('對話紀錄', 'Chat history')} aria-label={t('對話紀錄', 'Chat history')} onClick={onMenu}>
        <Ico i={Menu} size={18} />
      </button>
      <img className="logo" src={logo} alt="" />
      <span className="wordmark">Aivenue</span>
      <span className="grow" />
      <a className={cx('icon-btn', route.page === 'new' && 'active')} href="#/new" title={t('新對話', 'New chat')} aria-label={t('新對話', 'New chat')}>
        <Ico i={Plus} size={18} />
      </a>
      <a className={cx('icon-btn', route.page === 'settings' && 'active')} href="#/settings/general" title={t('設定', 'Settings')} aria-label={t('設定', 'Settings')}>
        <Ico i={SettingsIcon} size={18} />
      </a>
    </div>
  );
}

/** Wide layouts show the chat list beside the chat; narrower ones (see styles.css) keep it in a drawer. */
const wide = () => window.matchMedia('(min-width: 1101px)').matches;
const HIDE_KEY = 'aivenue.sidebarHidden';
/**
 * Whether the user put the chat list away, as this page's storage last saw it: only the first guess, for the first
 * frame. The choice is kept in the settings (sidebarHidden, for the app and VS Code apart), which win once loaded.
 */
function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDE_KEY) === '1';
  } catch {
    return false;
  }
}
function writeHidden(v: boolean) {
  try {
    if (v) localStorage.setItem(HIDE_KEY, '1');
    else localStorage.removeItem(HIDE_KEY);
  } catch {
    // not kept: it is only a convenience
  }
}

function Sidebar({ route, open, onHide }: { route: Route; open: boolean; onHide: () => void }) {
  const t = useT();
  const conn = useConnection();
  const workflows = useThreads();
  // The conversation being renamed (its newest message's id, as listed).
  const [renaming, setRenaming] = useState<string | null>(null);
  let lastGroup = '';
  return (
    <aside className={cx('sidebar', open && 'open')}>
      <div className="side-top">
        <img className="logo" src={logo} alt="" />
        <span className="wordmark">Aivenue</span>
        <span className="grow" />
        <button className="icon-btn side-hide" title={t('收合側欄', 'Hide the sidebar')} aria-label={t('收合側欄', 'Hide the sidebar')} onClick={onHide}>
          <Ico i={PanelLeftClose} size={18} />
        </button>
      </div>
      <a className={cx('side-link', route.page === 'new' && 'active')} href="#/new">
        <Ico i={Plus} className="side-icon" /> {t('新對話', 'New chat')}
      </a>
      <div className="side-list">
        {workflows.map((w) => {
          const group = relativeDay(t, w.createdAt);
          const header = group !== lastGroup ? ((lastGroup = group), <div className="side-group">{group}</div>) : null;
          const st = wfStatus(t, w.status);
          const active = route.page === 'run' && w.ids.includes(route.id);
          return (
            <div key={w.id}>
              {header}
              {renaming === w.id ? (
                <div className={cx('side-item', 'renaming', active && 'active')}>
                  <RenameInput id={w.id} title={w.title} onDone={() => setRenaming(null)} />
                </div>
              ) : (
                // The rename button sits beside the link: a click inside the link would open the chat first.
                <div className="side-row">
                  <a href={`#/run/${w.id}`} className={cx('side-item', active && 'active')} title={`${w.title}\n${st.label}${w.messages > 1 ? `\n${t(`${w.messages} 則訊息`, `${w.messages} messages`)}` : ''}`}>
                    <span className="side-item-title">{w.title}</span>
                    {(w.status === 'running' || w.status === 'paused' || w.status === 'waiting_human' || w.status === 'failed') && <span className={cx('dot', st.cls)} />}
                  </a>
                  <button className="side-edit" title={t('重新命名', 'Rename')} aria-label={t(`重新命名「${w.title}」`, `Rename "${w.title}"`)} onClick={() => setRenaming(w.id)}>
                    <Ico i={Pencil} size={14} />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="side-bottom">
        <a className={cx('side-link', route.page === 'settings' && 'active')} href="#/settings/general">
          <Ico i={SettingsIcon} className="side-icon" /> {t('設定', 'Settings')}
        </a>
        <span className={cx('conn', conn)} title={conn === 'open' ? t('已連線', 'Connected') : t('重新連線中…', 'Reconnecting…')} />
      </div>
    </aside>
  );
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [menu, setMenu] = useState(false);
  // Wide layouts: the user can put the chat list away; ☰ brings it back. Kept in the settings, for the app and VS Code
  // apart: the app's page is served from a new port each start (another origin, its storage empty).
  const settings = useSettings();
  const host = useHostInfo();
  const side = host ? (host.host === 'vscode' ? 'vscode' : 'app') : undefined;
  const saved = side ? settings.sidebarHidden?.[side] : undefined;
  const [sideHidden, setSideHidden] = useState(readHidden);
  useEffect(() => {
    if (saved !== undefined) setSideHidden(saved);
  }, [saved]);
  const hideSide = (v: boolean) => {
    setSideHidden(v);
    writeHidden(v);
    if (side) saveSettingsQuietly({ sidebarHidden: { [side]: v } });
  };
  // Where "back to the conversation" in Settings goes: the last chat page shown.
  const [lastChat, setLastChat] = useState('#/new');
  useEffect(() => {
    if (route.page === 'run') setLastChat(`#/run/${route.id}`);
    if (route.page === 'new') setLastChat('#/new');
  }, [route]);
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
      <div className={cx('app', route.page === 'settings' && 'in-settings', sideHidden && 'side-hidden')}>
        {/* Settings has its own column (with a way back), so the chat list steps aside. */}
        {route.page !== 'settings' && <Sidebar route={route} open={menu} onHide={() => (wide() ? hideSide(true) : setMenu(false))} />}
        {menu && route.page !== 'settings' && <div className="side-scrim" onClick={() => setMenu(false)} />}
        <main className="main">
          {/* Narrow: ☰ opens the drawer. Wide with the list put away: ☰ brings it back. */}
          <CompactBar route={route} onMenu={() => (wide() && sideHidden ? hideSide(false) : setMenu(!menu))} />
          {route.page === 'new' && <Chat key="new" />}
          {route.page === 'run' && <Chat key={route.id} id={route.id} />}
          {route.page === 'settings' && <Settings tab={route.tab} backHref={lastChat} />}
        </main>
      </div>
      <AskHost />
    </SettingsProvider>
  );
}
