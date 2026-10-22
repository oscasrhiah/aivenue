import { createContext, useContext, useEffect, type ReactNode } from 'react';
import type { AppSettings, Locale } from '../../core/src/types';
import { hub, useSettings } from './api';

export type T = (zh: string, en: string) => string;

const Ctx = createContext<{ settings: AppSettings; t: T }>({
  settings: { locale: 'zh-TW', theme: 'system', accent: '#c96442' },
  t: (zh) => zh,
});

export const ACCENTS = [
  { id: '#c96442', zh: '陶土', en: 'Clay' },
  { id: '#3d3d3a', zh: '墨黑', en: 'Ink' },
  { id: '#2f6feb', zh: '海藍', en: 'Ocean' },
  { id: '#2f855a', zh: '森綠', en: 'Forest' },
  { id: '#6e56cf', zh: '紫羅蘭', en: 'Violet' },
  { id: '#d6336c', zh: '玫瑰', en: 'Rose' },
];

function applyAppearance(s: AppSettings) {
  const root = document.documentElement;
  if (s.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = s.theme;
  root.style.setProperty('--accent', s.accent);
  root.lang = s.locale === 'en' ? 'en' : 'zh-Hant';
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const settings = useSettings();
  useEffect(() => applyAppearance(settings), [settings]);
  const t: T = (zh, en) => (settings.locale === 'en' ? en : zh);
  return <Ctx.Provider value={{ settings, t }}>{children}</Ctx.Provider>;
}

export function useT(): T {
  return useContext(Ctx).t;
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
