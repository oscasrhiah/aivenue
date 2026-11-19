/**
 * Pure helpers for how Settings, the workflow settings window and the detail windows present things (no React, no hub):
 * a long hint split into the sentence shown and the rest behind 說明, the first rows of a long list, a provider's state
 * as one word with its tone and next action, the overview of Capabilities, a menu's entries without stray separators,
 * an example folder for the platform.
 */

/**
 * A hint as its first sentence (shown) and the rest (behind a 說明 button). Splits after the first 。！？ (Chinese) or
 * ". " / "! " / "? " (English) that is not inside brackets or quotes; a text of one sentence comes back whole.
 */
export function splitHint(text: string): [string, string] {
  const s = text.trim();
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ('（(「『“[【'.includes(c)) depth++;
    else if ('）)」』”]】'.includes(c)) depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      const zh = '。！？'.includes(c);
      const en = '.!?'.includes(c) && s[i + 1] === ' ' && /[A-Z0-9"“(]/.test(s[i + 2] ?? '');
      if (zh || en) {
        const rest = s.slice(i + 1).trim();
        if (rest) return [s.slice(0, i + 1), rest];
      }
    }
  }
  return [s, ''];
}

/** The rows of a long list shown before 「顯示全部 N 個」: the first `limit`, or all of them once opened (or when few). */
export function visibleItems<T>(list: T[], limit: number, open: boolean): { shown: T[]; hidden: number } {
  if (open || list.length <= limit + 1) return { shown: list, hidden: 0 };
  return { shown: list.slice(0, limit), hidden: list.length - limit };
}

export type ProviderStateKey = 'ready' | 'api' | 'usable' | 'signedOut' | 'notInstalled' | 'checking' | 'unknown' | 'notReady';

export interface ProviderStateInput {
  installed: boolean;
  managed: boolean;
  authState: 'logged_in' | 'logged_out' | 'checking' | 'unknown' | string;
  authMode?: 'subscription' | 'api' | string;
  signedIn?: boolean;
  canInstall: boolean;
}

/**
 * A provider's state in one word (its key), the tone of that word (only what works is coloured: an unused provider is
 * not a problem) and the one action its row offers on the first layer.
 */
export function providerState(p: ProviderStateInput): { key: ProviderStateKey; tone: 'ok' | 'warn' | 'muted' | 'run'; action: 'install' | 'login' | null } {
  if (!p.installed) return { key: 'notInstalled', tone: 'muted', action: p.canInstall && !p.managed ? 'install' : null };
  if (p.managed) return p.authState === 'logged_in' ? { key: 'ready', tone: 'ok', action: null } : { key: 'notReady', tone: 'muted', action: null };
  if (p.authState === 'logged_in') {
    if (p.authMode === 'api') return { key: 'api', tone: 'ok', action: null };
    if (p.signedIn === false) return { key: 'usable', tone: 'ok', action: null };
    return { key: 'ready', tone: 'ok', action: null };
  }
  if (p.authState === 'checking') return { key: 'checking', tone: 'run', action: null };
  if (p.authState === 'unknown') return { key: 'unknown', tone: 'muted', action: null };
  return { key: 'signedOut', tone: 'muted', action: p.authMode === 'api' ? null : 'login' };
}

/** What Capabilities has turned on, as the parts of its overview line (only the kinds there are). */
export function capabilityCounts(c: { extensions: { enabled: boolean }[]; packSkills: { enabled: boolean }[]; skills: { enabled: boolean; approved: boolean }[]; projectSkills: { approved: boolean }[]; mcp: { enabled: boolean }[]; github: { installed: boolean; signedIn: boolean } }) {
  return {
    extensions: c.extensions.filter((x) => x.enabled).length,
    builtinSkills: c.packSkills.filter((x) => x.enabled).length,
    skills: c.skills.filter((x) => x.enabled && x.approved).length + c.projectSkills.filter((x) => x.approved).length,
    mcp: c.mcp.filter((x) => x.enabled).length,
    github: c.github.signedIn ? 'signedIn' : c.github.installed ? 'signedOut' : 'notInstalled',
  } as const;
}

export type OverviewKind = 'extensions' | 'builtinSkills' | 'skills' | 'mcp';

/** The overview's two lines: the kinds with something on (in the page's order, with how many), then the kinds with none. */
export function overviewParts(c: Record<OverviewKind, number>): { on: { kind: OverviewKind; n: number }[]; off: OverviewKind[] } {
  const kinds: OverviewKind[] = ['extensions', 'builtinSkills', 'skills', 'mcp'];
  return { on: kinds.filter((k) => c[k] > 0).map((k) => ({ kind: k, n: c[k] })), off: kinds.filter((k) => !(c[k] > 0)) };
}

/** A menu's entries without a separator at its start or end or two in a row (entries left out leave none behind). */
export function menuEntries<E>(items: (E | 'sep' | false | null | undefined)[]): (E | 'sep')[] {
  const out: (E | 'sep')[] = [];
  for (const e of items) {
    if (!e) continue;
    if (e === 'sep' && (!out.length || out[out.length - 1] === 'sep')) continue;
    out.push(e);
  }
  while (out[out.length - 1] === 'sep') out.pop();
  return out;
}

/** An example working folder for the field's placeholder, written the way this platform writes paths. */
export function folderExample(platform: string): string {
  const p = platform.toLowerCase();
  // Mac first: "darwin" holds "win".
  if (p.includes('mac') || p.includes('darwin')) return '/Users/me/code/my-app';
  if (/^win|windows/.test(p)) return 'D:\\code\\my-app';
  return '/home/me/code/my-app';
}
