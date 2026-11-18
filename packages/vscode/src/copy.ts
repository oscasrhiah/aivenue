import * as vscode from 'vscode';

/** The largest text the page may ask to copy (a long reply or review report fits many times over). */
export const COPY_MAX = 5_000_000;

/**
 * Copies for the page: what it asks (`aivenue.copy`) goes to VS Code's own clipboard, and the page is told when it is
 * written or why not (`aivenue.copied`), so it says "copied" only then. A webview's own clipboard is not dependable in
 * VS Code: a user's Ctrl+C and context-menu copy pasted nothing.
 */
export function listenCopy(webview: vscode.Webview): vscode.Disposable {
  return webview.onDidReceiveMessage(async (m: { type?: string; id?: unknown; text?: unknown }) => {
    if (m?.type !== 'aivenue.copy') return;
    const id = typeof m.id === 'number' ? m.id : undefined;
    try {
      if (typeof m.text !== 'string') throw new Error('nothing to copy');
      if (m.text.length > COPY_MAX) throw new Error(`too long to copy (${m.text.length} characters)`);
      await vscode.env.clipboard.writeText(m.text);
      void webview.postMessage({ type: 'aivenue.copied', id, ok: true });
    } catch (e) {
      void webview.postMessage({ type: 'aivenue.copied', id, ok: false, error: (e as Error).message });
    }
  });
}
