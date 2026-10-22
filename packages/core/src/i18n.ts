import type { Locale } from './types';

let current: Locale = 'zh-TW';

export function setLocale(l: Locale) {
  current = l;
}

/** Pick the message for the current UI language. */
export function L(zh: string, en: string): string {
  return current === 'en' ? en : zh;
}
