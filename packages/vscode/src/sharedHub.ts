import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

/**
 * Every VS Code window uses one hub (dist/hub.cjs, packages/vscode/src/daemon.ts): it alone runs the extension's
 * workflows, so a second window neither marks the first one's work interrupted nor runs it again. A window finds the
 * hub through its endpoint file, starts it when there is none (the hub's own OS lock keeps a second one from
 * starting), and keeps a control channel open: the hub asks the window, through it, to do what only that window can.
 * Nothing here uses the VS Code API, so the tests drive it in plain Node.
 */

export interface Endpoint {
  pid: number;
  port: number;
  token: string;
  build: string;
  version: string;
  startedAt: number;
}

export const endpointFile = (dataDir: string) => path.join(dataDir, 'vscode-hub.json');

export function readEndpoint(dataDir: string): Endpoint | undefined {
  try {
    const ep = JSON.parse(fs.readFileSync(endpointFile(dataDir), 'utf8')) as Endpoint;
    return ep && typeof ep.port === 'number' && typeof ep.token === 'string' ? ep : undefined;
  } catch {
    return undefined;
  }
}

/** What a window does for the hub (folder dialog, terminal, secret storage…), by hook name. */
export type WindowHandlers = Record<string, (...args: any[]) => unknown>;

export interface Channel {
  endpoint: Endpoint;
  /** Ask the hub something only a window may (status, shutdown). */
  control<T = unknown>(method: string): Promise<T>;
  /** Tell the hub this window's project folder, or that it has the focus. */
  state(s: { cwd?: string; focused?: boolean }): void;
  onClose(fn: () => void): void;
  close(): void;
}

/** Open this window's control channel to the hub at `ep`. */
export function openChannel(ep: Endpoint, windowId: string, handlers: WindowHandlers, timeoutMs = 3000): Promise<Channel> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${ep.port}/ws?token=${ep.token}&role=window&window=${encodeURIComponent(windowId)}`);
    const closers: (() => void)[] = [];
    const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    let seq = 0;
    let opened = false;
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('the hub did not answer'));
    }, timeoutMs);
    ws.on('open', () => {
      opened = true;
      clearTimeout(timer);
      resolve({
        endpoint: ep,
        control: <T>(method: string) =>
          new Promise<T>((res, rej) => {
            const id = ++seq;
            waiting.set(id, { resolve: res as (v: unknown) => void, reject: rej });
            ws.send(JSON.stringify({ control: { id, method } }));
          }),
        state: (s) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ state: s })),
        onClose: (fn) => closers.push(fn),
        close: () => ws.close(),
      });
    });
    ws.on('message', (raw) => {
      let m: { hook?: { id: string; name: string; args?: unknown[] }; controlResult?: { id: number; result?: unknown; error?: string } };
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m.hook) {
        const { id, name, args } = m.hook;
        const reply = (r: { result?: unknown; error?: string }) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ hookResult: { id, ...r } }));
        const fn = handlers[name];
        if (!fn) reply({ error: `this window cannot ${name}` });
        else
          Promise.resolve()
            .then(() => fn(...(args ?? [])))
            .then((result) => reply({ result: result ?? null }), (e) => reply({ error: (e as Error).message }));
      }
      if (m.controlResult) {
        const w = waiting.get(m.controlResult.id);
        if (!w) return;
        waiting.delete(m.controlResult.id);
        if (m.controlResult.error) w.reject(new Error(m.controlResult.error));
        else w.resolve(m.controlResult.result);
      }
    });
    ws.on('close', () => {
      for (const w of waiting.values()) w.reject(new Error('the hub closed'));
      waiting.clear();
      if (opened) for (const fn of closers) fn();
    });
    ws.on('error', (e) => {
      if (!opened) {
        clearTimeout(timer);
        reject(e);
      }
    });
  });
}

/** While no hub answers, how often a window starts one again. */
const RESPAWN_MS = 2500;

/**
 * Connect this window to the hub, starting it when it is not running (or its endpoint file is stale). `spawn` starts
 * a hub process; when two windows start one at the same time, the second exits on the first one's lock and both
 * connect to the first.
 * While no hub answers, a hub is started again every RESPAWN_MS: one started a moment after a hub crashed can still
 * find the dead hub's lock (the system has not released it yet) and exit, and nothing would serve. Extra starts are
 * harmless: the lock lets one serve and the others exit.
 */
export async function ensureHub(o: { dataDir: string; windowId: string; handlers: WindowHandlers; spawn: () => Promise<void> | void; timeoutMs?: number }): Promise<Channel> {
  const deadline = Date.now() + (o.timeoutMs ?? 20_000);
  let spawnedAt = 0;
  let lastError: unknown;
  for (;;) {
    const ep = readEndpoint(o.dataDir);
    if (ep) {
      try {
        return await openChannel(ep, o.windowId, o.handlers);
      } catch (e) {
        lastError = e;
      }
    }
    if (!spawnedAt || Date.now() - spawnedAt >= RESPAWN_MS) {
      spawnedAt = Date.now();
      await o.spawn();
    }
    if (Date.now() > deadline) throw new Error(`Aivenue hub did not start${lastError ? `: ${(lastError as Error).message}` : ''}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** A new id for this window's extension host (one per window). */
export const newWindowId = () => randomUUID();
