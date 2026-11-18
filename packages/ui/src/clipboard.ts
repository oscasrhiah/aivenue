/**
 * Copying text, resolved once it is on the clipboard and rejected with why not, so the page says "copied" only then.
 *
 * In VS Code the page asks the extension (`aivenue.copy`), which writes with `vscode.env.clipboard.writeText` and
 * answers (`aivenue.copied`): a webview's own clipboard is not dependable there (a user's Ctrl+C and context-menu copy
 * pasted nothing). Elsewhere (the desktop app, a browser) the browser's clipboard, then the older copy command.
 */
import { vscodeApi } from './api';

/** How long the extension has to answer. */
const ANSWER_MS = 5000;

type Waiting = { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
const waiting = new Map<number, Waiting>();
let seq = 0;

if (vscodeApi)
  window.addEventListener('message', (e: MessageEvent) => {
    const m = e.data as { type?: string; id?: number; ok?: boolean; error?: string } | undefined;
    if (m?.type !== 'aivenue.copied' || typeof m.id !== 'number') return;
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    clearTimeout(w.timer);
    if (m.ok) w.resolve();
    else w.reject(new Error(m.error || 'VS Code could not write the clipboard'));
  });

export function copyText(text: string): Promise<void> {
  if (vscodeApi) {
    const api = vscodeApi;
    return new Promise<void>((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error('VS Code did not answer'));
      }, ANSWER_MS);
      waiting.set(id, { resolve, reject, timer });
      api.postMessage({ type: 'aivenue.copy', id, text });
    });
  }
  return browserCopy(text);
}

async function browserCopy(text: string): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('the clipboard is not available here');
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // Not allowed (no focus, no permission): the copy command still works on a selection the page makes.
    if (!commandCopy(text)) throw e instanceof Error ? e : new Error(String(e));
  }
}

function commandCopy(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  const before = document.activeElement as HTMLElement | null;
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  before?.focus?.();
  return ok;
}
