import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { CircleX, Hand, LoaderCircle, Menu, MessageCircleQuestionMark, PanelLeftClose, Pause, Pencil, Plus, Settings as SettingsIcon, Signpost, Trash2, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useConnection, useHostInfo, useSettings, useThreads, type ThreadSummary } from './api';
import logo from './assets/logo.svg';
import { AskHost } from './components/Ask';
import { RenameInput } from './components/Rename';
import { deleteConversation, MoreMenu } from './components/RunTools';
import { saveSettings, SettingsProvider, useT } from './i18n';
import { Chat } from './pages/Chat';
import { Settings } from './pages/Settings';
import { attention, attentionLabel, cx, relativeDay, summaryWait, waitWord, wfStatus, type WaitKind } from './util';
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

/**
 * Wide layouts show the chat list beside the chat; narrower ones keep it in a drawer. The same query as styles.css
 * (max-width: 1100px), negated: a width between 1100 and 1101 (a scaled display) is not "neither".
 */
const NARROW = '(max-width: 1100px)';
const wide = () => !window.matchMedia(NARROW).matches;
const onWidth = (fn: () => void) => {
  const mq = window.matchMedia(NARROW);
  mq.addEventListener('change', fn);
  return () => mq.removeEventListener('change', fn);
};
const useWide = (): boolean => useSyncExternalStore(onWidth, wide);

/**
 * Narrow layouts (e.g. the VS Code side bar): history and settings move behind this bar. ☰ carries how many
 * conversations wait for you or failed lately (a number, in its name too); + is an action, never drawn as pressed; ⚙
 * shows where you are only inside Settings. In VS Code the logo and name are left out: the view's own title names
 * Aivenue. In Settings (which has no chat list) ☰ goes back to the last conversation with the list open.
 */
function CompactBar({ route, open, onMenu, menuRef, threads }: { route: Route; open: boolean; onMenu: () => void; menuRef: RefObject<HTMLButtonElement | null>; threads: ThreadSummary[] }) {
  const t = useT();
  const need = attention(threads);
  const count = need.waiting + need.failed;
  const label = attentionLabel(t, need);
  return (
    <div className="compact-bar">
      <button ref={menuRef} className="icon-btn menu-btn" title={label} aria-label={label} aria-expanded={open} aria-controls={route.page === 'settings' ? undefined : 'side-drawer'} onClick={onMenu}>
        <Ico i={Menu} size={16} />
        {count > 0 && (
          <span className={cx('menu-badge', need.waiting ? 'warn' : 'err')} aria-hidden="true">
            {count}
          </span>
        )}
      </button>
      <img className="logo" src={logo} alt="" />
      <span className="wordmark">Aivenue</span>
      <span className="grow" />
      <a className="icon-btn" href="#/new" title={t('新對話', 'New chat')} aria-label={t('新對話', 'New chat')}>
        <Ico i={Plus} size={16} />
      </a>
      <a className={cx('icon-btn', route.page === 'settings' && 'active')} href="#/settings/general" title={t('設定', 'Settings')} aria-label={t('設定', 'Settings')} aria-current={route.page === 'settings' ? 'page' : undefined}>
        <Ico i={SettingsIcon} size={16} />
      </a>
    </div>
  );
}

/**
 * The hub connection: nothing while it is open; otherwise, after a moment (a start or a quick reconnect shows nothing),
 * a thin strip under the top bar on every page. The element is always there, with the state as its class ("conn open"
 * while connected), so its words are read out when they appear.
 */
function Connection() {
  const t = useT();
  const conn = useConnection();
  const [late, setLate] = useState(false);
  // Timed from when it stopped being open: the tries in between (connecting, closed, connecting…) do not restart it,
  // so the strip neither waits for ever nor flickers while it keeps trying.
  const open = conn === 'open';
  useEffect(() => {
    setLate(false);
    if (open) return;
    const timer = setTimeout(() => setLate(true), 1500);
    return () => clearTimeout(timer);
  }, [open]);
  const shown = late && conn !== 'open';
  return (
    <div className={cx('conn', conn, shown && 'shown')} role="status">
      {shown && (
        <>
          <Ico i={LoaderCircle} size={14} className="spin" /> {t('重新連線中…', 'Reconnecting…')}
        </>
      )}
    </div>
  );
}

const WAIT_ICON: Record<WaitKind, LucideIcon> = { question: MessageCircleQuestionMark, approval: Hand, decision: Signpost };

/**
 * A conversation's state in its row, each its own shape: waiting for you (an answer, an approval, a decision: the same
 * word as its header) and failed with a word, running and paused by icon.
 */
function RowState({ w }: { w: ThreadSummary }) {
  const t = useT();
  const st = wfStatus(t, w.status);
  const wait = summaryWait(w);
  if (wait)
    return (
      <span className="side-state warn">
        <Ico i={WAIT_ICON[wait]} size={14} /> {waitWord(t, wait)}
      </span>
    );
  if (w.status === 'failed')
    return (
      <span className="side-state err">
        <Ico i={CircleX} size={14} /> {st.label}
      </span>
    );
  const icon = w.status === 'running' ? LoaderCircle : w.status === 'paused' ? Pause : w.status === 'incomplete' ? TriangleAlert : undefined;
  if (!icon) return null;
  return (
    <span className={cx('side-state', st.cls)} title={st.label}>
      <Ico i={icon} size={14} className={w.status === 'running' ? 'spin' : undefined} />
      <span className="sr-only">{st.label}</span>
    </span>
  );
}

/**
 * One conversation in the chat list: its link (title and state), and one ⋯ menu (rename; delete while it does not run).
 * The ⋯ shows on the open row, on pointing and on keyboard focus, and always on touch screens; a right-click on the row
 * opens the same menu and F2 renames.
 */
function SideRow({ w, active, onRename }: { w: ThreadSummary; active: boolean; onRename: () => void }) {
  const t = useT();
  const st = wfStatus(t, w.status);
  const wait = summaryWait(w);
  const [menu, setMenu] = useState(0);
  const live = w.status === 'running' || w.status === 'paused' || w.status === 'waiting_human';
  const remove = async () => {
    if (!(await deleteConversation(t, w.ids))) return;
    if (active) navigate('new');
  };
  return (
    <div
      className="side-row"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu((n) => n + 1);
      }}
      onKeyDown={(e) => {
        if (e.key === 'F2') {
          e.preventDefault();
          onRename();
        }
      }}
    >
      <a href={`#/run/${w.id}`} className={cx('side-item', active && 'active')} aria-current={active ? 'page' : undefined} title={`${w.title}\n${wait ? waitWord(t, wait) : st.label}${w.messages > 1 ? `\n${t(`${w.messages} 則訊息`, `${w.messages} messages`)}` : ''}`}>
        <span className="side-item-title">{w.title}</span>
        <RowState w={w} />
      </a>
      <MoreMenu
        className="side-more"
        label={t(`「${w.title}」的更多動作`, `More for "${w.title}"`)}
        openSignal={menu}
        items={[{ label: t('重新命名', 'Rename'), icon: Pencil, onSelect: onRename }, !live && 'sep', !live && { label: t('刪除對話…', 'Delete chat…'), icon: Trash2, danger: true, onSelect: () => void remove() }]}
      />
    </div>
  );
}

function Sidebar({ route, open, drawer, onHide, workflows }: { route: Route; open: boolean; drawer: boolean; onHide: () => void; workflows: ThreadSummary[] }) {
  const t = useT();
  // The conversation being renamed (its newest message's id, as listed). Done, the focus goes back to its row (when it
  // was left nowhere: the field is gone).
  const [renaming, setRenaming] = useState<string | null>(null);
  const renamed = useRef<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (renaming) {
      renamed.current = renaming;
      return;
    }
    const id = renamed.current;
    renamed.current = null;
    if (!id || (document.activeElement && document.activeElement !== document.body)) return;
    ref.current?.querySelector<HTMLElement>(`.side-item[href="#/run/${id}"]`)?.focus();
  }, [renaming]);
  // Opened as a drawer: the focus goes into it, to the open conversation (else its first link).
  useEffect(() => {
    if (!drawer || !open) return;
    const el = ref.current;
    (el?.querySelector<HTMLElement>('.side-item.active') ?? el?.querySelector<HTMLElement>('a[href], button'))?.focus();
  }, [drawer, open]);
  let lastGroup = '';
  return (
    <aside id="side-drawer" ref={ref} className={cx('sidebar', open && 'open')} aria-label={t('對話紀錄', 'Chat history')} inert={drawer && !open ? true : undefined}>
      <div className="side-top">
        <img className="logo" src={logo} alt="" />
        <span className="wordmark">Aivenue</span>
        <span className="grow" />
        <button className="icon-btn side-hide" title={t('收合側欄', 'Hide the sidebar')} aria-label={t('收合側欄', 'Hide the sidebar')} onClick={onHide}>
          <Ico i={PanelLeftClose} size={16} />
        </button>
      </div>
      <a className={cx('side-link', route.page === 'new' && 'active')} href="#/new" aria-current={route.page === 'new' ? 'page' : undefined}>
        <Ico i={Plus} className="side-icon" /> {t('新對話', 'New chat')}
      </a>
      <div className="side-list">
        {workflows.map((w) => {
          const group = relativeDay(t, w.createdAt);
          const header = group !== lastGroup ? ((lastGroup = group), <div className="side-group">{group}</div>) : null;
          const active = route.page === 'run' && w.ids.includes(route.id);
          return (
            <div key={w.id}>
              {header}
              {renaming === w.id ? (
                <div className={cx('side-item', 'renaming', active && 'active')}>
                  <RenameInput id={w.id} title={w.title} onDone={() => setRenaming(null)} />
                </div>
              ) : (
                <SideRow w={w} active={active} onRename={() => setRenaming(w.id)} />
              )}
            </div>
          );
        })}
      </div>
      <div className="side-bottom">
        <a className={cx('side-link', route.page === 'settings' && 'active')} href="#/settings/general">
          <Ico i={SettingsIcon} className="side-icon" /> {t('設定', 'Settings')}
        </a>
      </div>
    </aside>
  );
}

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

export function App() {
  const t = useT();
  const [route, setRoute] = useState<Route>(parseHash);
  const [menu, setMenu] = useState(false);
  // ☰ pressed in Settings: back to the last conversation, with the chat list open once there.
  const openAfterNav = useRef(false);
  const threads = useThreads();
  const isWide = useWide();
  // A narrow window: the chat list is a drawer (☰ opens it, Esc or the scrim closes it; closed, it is out of reach).
  const drawer = !isWide;
  const menuBtn = useRef<HTMLButtonElement>(null);
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
  // A change that could not be saved (e.g. another Aivenue was saving the settings) is undone and said, so the screen
  // never shows what is not on disk.
  const [sideNote, setSideNote] = useState<string>();
  const hideSide = (v: boolean) => {
    const before = sideHidden;
    setSideHidden(v);
    writeHidden(v);
    if (side)
      saveSettings({ sidebarHidden: { [side]: v } }).catch((e: Error) => {
        setSideHidden(before);
        writeHidden(before);
        setSideNote(t(`側欄的收合沒有存下來，已恢復原狀：${e.message}`, `The sidebar change was not saved and was undone: ${e.message}`));
        setTimeout(() => setSideNote(undefined), 6000);
      });
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
      setMenu(openAfterNav.current && !wide());
      openAfterNav.current = false;
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
  // The drawer open: Esc closes it. Closed, the focus goes back to ☰ when it was in the drawer (or nowhere).
  const wasOpen = useRef(false);
  useEffect(() => {
    const open = drawer && menu;
    if (open) {
      // Not while a dialog over it (deleting a conversation) takes the Esc.
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.modal-back')) return;
        e.preventDefault();
        setMenu(false);
      };
      window.addEventListener('keydown', onKey);
      wasOpen.current = true;
      return () => window.removeEventListener('keydown', onKey);
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      const a = document.activeElement;
      if (!a || a === document.body || document.getElementById('side-drawer')?.contains(a)) menuBtn.current?.focus();
    }
  }, [drawer, menu]);
  return (
    <SettingsProvider>
      <div className={cx('app', route.page === 'settings' && 'in-settings', sideHidden && 'side-hidden')}>
        {/* Settings has its own column (with a way back), so the chat list steps aside. */}
        {route.page !== 'settings' && <Sidebar route={route} open={menu} drawer={drawer} workflows={threads} onHide={() => (wide() ? hideSide(true) : setMenu(false))} />}
        {menu && route.page !== 'settings' && <div className="side-scrim" onClick={() => setMenu(false)} />}
        <main className="main">
          {/* Narrow: ☰ opens the drawer. Wide with the list put away: ☰ brings it back. */}
          {sideNote && (
            <div className="side-note" role="status">
              {sideNote}
            </div>
          )}
          <CompactBar
            route={route}
            threads={threads}
            open={route.page === 'settings' ? false : drawer ? menu : !sideHidden}
            menuRef={menuBtn}
            onMenu={() => {
              if (route.page === 'settings') {
                if (wide()) {
                  if (sideHidden) hideSide(false);
                } else openAfterNav.current = true;
                location.hash = lastChat;
                return;
              }
              if (wide() && sideHidden) hideSide(false);
              else setMenu(!menu);
            }}
          />
          <Connection />
          {route.page === 'new' && <Chat key="new" />}
          {route.page === 'run' && <Chat key={route.id} id={route.id} />}
          {route.page === 'settings' && <Settings tab={route.tab} backHref={lastChat} />}
        </main>
      </div>
      <AskHost />
    </SettingsProvider>
  );
}
