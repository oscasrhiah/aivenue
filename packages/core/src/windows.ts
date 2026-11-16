import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { HostHooks } from './hub';
import type { SecretStore } from './secrets';
import { L } from './i18n';

/**
 * One hub shared by every VS Code window (packages/vscode/src/daemon.ts). The windows are the hub's hands: each keeps a
 * control channel open (a WebSocket with role=window), through which the hub asks it to do what only that window can:
 * pick a folder or files, open a path, a link or a terminal, and read or write VS Code's secret storage. Everything a
 * window's webview calls runs with that window as its context, so a folder dialog opens in the window that asked and a
 * new chat starts in that window's project.
 */

/** The window behind the RPC call being handled (set by the hub for every call of a webview). */
export const requestContext = new AsyncLocalStorage<{ window?: string }>();

interface Win {
  id: string;
  ws: WebSocket;
  /** That window's project folder: where a new chat started from it works. */
  cwd?: string;
  focusedAt: number;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/** Hooks a window answers. */
export type WindowHook = 'pickFolder' | 'pickFiles' | 'openPath' | 'openExternal' | 'openTerminal' | 'secrets.set' | 'secrets.delete';

export class WindowRegistry {
  private wins = new Map<string, Win>();
  private pending = new Map<string, Pending>();
  private listeners = new Set<(count: number) => void>();
  /** Answers to window-only requests (status, shutdown): set by the shared hub. */
  control?: (method: string) => unknown;

  get count(): number {
    return this.wins.size;
  }

  ids(): string[] {
    return [...this.wins.keys()];
  }

  onCount(fn: (count: number) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** A window's control channel connected (a reconnect of the same window replaces its old channel). */
  attach(id: string, ws: WebSocket): void {
    const old = this.wins.get(id);
    if (old && old.ws !== ws) old.ws.close();
    const win: Win = { id, ws, cwd: old?.cwd, focusedAt: Date.now() };
    this.wins.set(id, win);
    ws.on('message', (raw) => this.message(win, raw.toString()));
    ws.on('close', () => {
      if (this.wins.get(id)?.ws !== ws) return;
      this.wins.delete(id);
      for (const [key, p] of this.pending) {
        if (!key.startsWith(`${id}:`)) continue;
        this.pending.delete(key);
        clearTimeout(p.timer);
        p.reject(new Error(L('發出這個操作的 VS Code 視窗已經關閉', 'The VS Code window that asked has closed')));
      }
      this.changed();
    });
    this.changed();
  }

  private changed() {
    for (const fn of this.listeners) fn(this.wins.size);
  }

  private message(win: Win, raw: string) {
    let m: { hookResult?: { id: string; result?: unknown; error?: string }; state?: { cwd?: string; focused?: boolean }; control?: { id: number; method: string } };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.state) {
      if ('cwd' in m.state) win.cwd = m.state.cwd || undefined;
      if (m.state.focused) win.focusedAt = Date.now();
    }
    if (m.hookResult) {
      const key = `${win.id}:${m.hookResult.id}`;
      const p = this.pending.get(key);
      if (!p) return;
      this.pending.delete(key);
      clearTimeout(p.timer);
      if (m.hookResult.error) p.reject(new Error(m.hookResult.error));
      else p.resolve(m.hookResult.result);
    }
    if (m.control) {
      const { id, method } = m.control;
      const reply = (r: { result?: unknown; error?: string }) => win.ws.readyState === win.ws.OPEN && win.ws.send(JSON.stringify({ controlResult: { id, ...r } }));
      Promise.resolve()
        .then(() => {
          if (!this.control) throw new Error('no control');
          return this.control(method);
        })
        .then((result) => reply({ result: result ?? null }), (e) => reply({ error: (e as Error).message }));
    }
  }

  /**
   * The window an action belongs to: the one whose webview made the call, else the one used last (an action not
   * started from a webview, or whose window has closed meanwhile).
   */
  target(): Win | undefined {
    const id = requestContext.getStore()?.window;
    const own = id ? this.wins.get(id) : undefined;
    if (own) return own;
    return [...this.wins.values()].sort((a, b) => b.focusedAt - a.focusedAt)[0];
  }

  /** Ask a window to do `hook`; waits for its answer (a dialog may wait on the user). */
  call<T>(hook: WindowHook, args: unknown[] = [], o: { win?: Win; timeoutMs?: number } = {}): Promise<T> {
    const win = o.win ?? this.target();
    if (!win) return Promise.reject(new Error(L('沒有開啟的 VS Code 視窗可以處理這個操作', 'No open VS Code window can do this')));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(`${win.id}:${id}`);
        reject(new Error(L('VS Code 視窗沒有回應', 'The VS Code window did not answer')));
      }, o.timeoutMs ?? 10 * 60_000);
      this.pending.set(`${win.id}:${id}`, { resolve: resolve as (v: unknown) => void, reject, timer });
      win.ws.send(JSON.stringify({ hook: { id, name: hook, args } }));
    });
  }

  /** Host hooks that run in the window that asked. */
  hooks(): HostHooks {
    return {
      host: 'vscode',
      defaultCwd: () => this.target()?.cwd,
      pickFolder: () => this.call<string | undefined>('pickFolder'),
      pickFiles: () => this.call<string[] | undefined>('pickFiles'),
      openPath: (p) => this.call<void>('openPath', [p]),
      openExternal: (url) => this.call<void>('openExternal', [url]),
      openTerminal: (req) => void this.call<void>('openTerminal', [req]).catch(() => undefined),
    };
  }

  /**
   * VS Code's secret storage, read through the windows. The hub needs its keys before any window has connected (at
   * startup), so the window that starts the hub hands over what is stored; afterwards every change goes through a
   * window to the storage and into this copy, which is the hub's own view.
   */
  secretStore(initial: Record<string, string>): SecretStore {
    const values = new Map(Object.entries(initial));
    return {
      secure: true,
      get: async (k) => values.get(k),
      keys: async () => [...values.keys()],
      set: async (k, v) => {
        await this.call<void>('secrets.set', [k, v], { timeoutMs: 30_000 });
        values.set(k, v);
      },
      delete: async (k) => {
        await this.call<void>('secrets.delete', [k], { timeoutMs: 30_000 });
        values.delete(k);
      },
    };
  }
}
