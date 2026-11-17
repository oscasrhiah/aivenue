import * as fs from 'node:fs';
import { L } from './i18n';

/**
 * Each client operation runs once. A client tags every call with an id of its own (`op`); a call sent again (after a
 * reconnect, or a second click that reused the id) gets the first call's answer instead of running again. Kept for ten
 * minutes, in memory and in a small file, so a hub restarted meanwhile (the shared VS Code hub) still knows them.
 */
const KEEP_MS = 10 * 60_000;
const MAX = 2000;
/** Answers larger than this are not written to the file; a repeat after a restart is then refused, not run. */
const MAX_STORED = 32 * 1024;

interface Done {
  at: number;
  result?: unknown;
  error?: string;
  /** The answer was too large to keep in the file. */
  big?: boolean;
}

export class OpLog {
  private running = new Map<string, Promise<unknown>>();
  private done = new Map<string, Done>();

  constructor(private file?: string) {
    if (!file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Done>;
      for (const [op, d] of Object.entries(saved)) if (Date.now() - d.at < KEEP_MS) this.done.set(op, d);
    } catch {
      // none yet
    }
  }

  /**
   * Run `fn` for `op` unless it already ran (or is running): then its answer. `recorded`: what the changed data itself
   * records of the operation (store.ts), for one this log lost (the hub stopped before saving it): done with an answer,
   * done with an error, or cut off midway (then refused, never run twice).
   */
  once<T>(op: string, fn: () => T | Promise<T>, recorded?: () => { done?: boolean; result?: unknown; error?: string } | undefined): Promise<T> {
    const running = this.running.get(op);
    if (running) return running as Promise<T>;
    const d = this.done.get(op);
    if (d && Date.now() - d.at < KEEP_MS) {
      if (d.error) return Promise.reject(new Error(d.error));
      if (d.big && !('result' in d)) return Promise.reject(new Error(L('這個操作已經執行過了', 'This operation was already done')));
      return Promise.resolve(d.result as T);
    }
    const r = recorded?.();
    if (r) {
      if (r.error !== undefined) return Promise.reject(new Error(r.error));
      if (r.done && 'result' in r) return Promise.resolve(r.result as T);
      return Promise.reject(new Error(r.done ? L('這個操作已經執行過了', 'This operation was already done') : L('這個操作在 Aivenue 中斷時已經開始執行，為了不重複，不會再執行一次；請確認目前的狀態', 'This operation had started when Aivenue stopped; it is not run again, so nothing happens twice. Check the current state.')));
    }
    const p = Promise.resolve()
      .then(fn)
      .then(
        (result) => (this.finish(op, { at: Date.now(), result }), result),
        (e) => {
          this.finish(op, { at: Date.now(), error: (e as Error).message });
          throw e;
        },
      );
    this.running.set(op, p);
    return p;
  }

  private finish(op: string, d: Done) {
    this.running.delete(op);
    if (d.result !== undefined) {
      const size = JSON.stringify(d.result ?? null)?.length ?? 0;
      if (size > MAX_STORED) d = { at: d.at, big: true, result: d.result };
    }
    this.done.set(op, d);
    const now = Date.now();
    for (const [k, v] of this.done) if (now - v.at >= KEEP_MS) this.done.delete(k);
    while (this.done.size > MAX) this.done.delete(this.done.keys().next().value as string);
    this.save();
  }

  private save() {
    if (!this.file) return;
    const out: Record<string, Done> = {};
    // In memory a large answer is kept whole (a repeat now gets it); in the file only that it was done.
    for (const [k, v] of this.done) out[k] = v.big ? { at: v.at, big: true } : v;
    try {
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(out));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch {
      // not kept: a repeat after a restart would run again, as before this existed
    }
  }
}
