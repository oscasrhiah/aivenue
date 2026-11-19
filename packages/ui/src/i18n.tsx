import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AppSettings, Locale } from '../../core/src/types';
import { hub, useSettings } from './api';

export type T = (zh: string, en: string) => string;

const Ctx = createContext<{ settings: AppSettings; t: T; dark: boolean }>({
  settings: { locale: 'zh-TW', theme: 'system', accent: '#3156c6' },
  t: (zh) => zh,
  dark: false,
});

const darkQuery = () => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined);

/** Whether the page is dark as shown: the theme setting, or for "system" the system's light or dark setting (live). */
function useResolvedDark(theme: AppSettings['theme']): boolean {
  const [systemDark, setSystemDark] = useState(() => !!darkQuery()?.matches);
  useEffect(() => {
    const q = darkQuery();
    if (!q) return;
    // Read again whenever the setting changes too (not only on the system's change event).
    setSystemDark(q.matches);
    const on = () => setSystemDark(q.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, [theme]);
  return theme === 'dark' || (theme === 'system' && systemDark);
}

/**
 * The logo follows the theme: blue on a light page, the orange one on a dark page. The tab icon changes with it, and
 * the desktop app is told so its window and taskbar icon match (VS Code draws its own icons: nothing to tell there).
 */
function applyLogo(dark: boolean) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link) link.href = dark ? './icon-dark.svg' : './icon.svg';
  if (document.documentElement.dataset.host !== 'vscode') void hub.call('host.appearance', { dark }).catch(() => undefined);
}

/**
 * The accent colours offered in Settings → 一般 (any other one through the colour picker). Blue is the default and takes
 * the place of the former Ocean (#2f6feb, the same hue); Teal and Slate replace Forest and Rose, which read as the ok
 * and error colours. Clay, the default before, stays selectable.
 */
export const ACCENTS = [
  { id: '#3156c6', zh: '藍', en: 'Blue' },
  { id: '#3d3d3a', zh: '墨黑', en: 'Ink' },
  { id: '#6e56cf', zh: '紫羅蘭', en: 'Violet' },
  { id: '#c96442', zh: '陶土', en: 'Clay' },
  { id: '#0f766e', zh: '青', en: 'Teal' },
  { id: '#475569', zh: '石板', en: 'Slate' },
];

function applyAppearance(s: AppSettings) {
  const root = document.documentElement;
  if (s.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = s.theme;
  // Inside VS Code the editor theme gives the accent (styles.css maps it to the theme's link and focus colours); the
  // user's own accent is for the desktop app and the browser.
  if (root.dataset.host === 'vscode') root.style.removeProperty('--accent');
  else root.style.setProperty('--accent', s.accent);
  root.lang = s.locale === 'en' ? 'en' : 'zh-Hant';
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const settings = useSettings();
  useEffect(() => applyAppearance(settings), [settings]);
  const dark = useResolvedDark(settings.theme);
  useEffect(() => applyLogo(dark), [dark]);
  const t: T = (zh, en) => (settings.locale === 'en' ? en : zh);
  return <Ctx.Provider value={{ settings, t, dark }}>{children}</Ctx.Provider>;
}

export function useT(): T {
  return useContext(Ctx).t;
}

/** Whether the page is dark as shown (the theme setting, or the system's when it follows the system). */
export function useDarkTheme(): boolean {
  return useContext(Ctx).dark;
}

export function useAppSettings(): AppSettings {
  return useContext(Ctx).settings;
}

export function saveSettings(patch: Partial<AppSettings>) {
  return hub.call<AppSettings>('settings.set', { patch });
}

export function localeName(l: Locale) {
  return l === 'en' ? 'English' : '繁體中文';
}
