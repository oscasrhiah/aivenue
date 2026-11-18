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

const NOT_MARKED = (why: string) =>
  L(`無法在操作紀錄記下這個操作（${why}），為了避免重複執行，沒有執行它。請確認 Aivenue 的資料資料夾可以寫入後再試`, `This operation could not be recorded in the operation log (${why}), so it was not run, to never run it twice. Make sure Aivenue's data folder can be written to, then try again.`);

const UNKNOWN = () =>
  L('這個操作在 Aivenue 中斷時已經開始執行，不知道有沒有完成；為了不重複，不會再執行一次。請確認目前的狀態後再試', 'This operation had started when Aivenue stopped, and whether it finished is unknown; it is not run again, so nothing happens twice. Check the current state, then try again.');

interface Done {
  at: number;
  result?: unknown;
  error?: string;
  /** The answer was too large to keep in the file. */
  big?: boolean;
  /** Started and not finished (written before an operation with an outside effect runs, see replay.ts). */
  started?: boolean;
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
  once<T>(op: string, fn: () => T | Promise<T>, recorded?: () => { done?: boolean; result?: unknown; error?: string } | undefined, outside = false): Promise<T> {
    const running = this.running.get(op);
    if (running) return running as Promise<T>;
    const d = this.done.get(op);
    if (d && Date.now() - d.at < KEEP_MS) {
      // Started before the hub stopped, its result never written: it may have happened. Not run again.
      if (d.started) return Promise.reject(new Error(UNKNOWN()));
      if (d.error) return Promise.reject(new Error(d.error));
      if (d.big && !('result' in d)) return Promise.reject(new Error(L('這個操作已經執行過了', 'This operation was already done')));
      return Promise.resolve(d.result as T);
    }
    const r = recorded?.();
    if (r) {
      if (r.error !== undefined) return Promise.reject(new Error(r.error));
      if (r.done && 'result' in r) return Promise.resolve(r.result as T);
      return Promise.reject(new Error(r.done ? L('這個操作已經執行過了', 'This operation was already done') : UNKNOWN()));
    }
    // An effect outside Aivenue's records (an upload, an install, a sign-in): that it started is on disk before it runs.
    // The mark must be on disk before it runs: if it cannot be written, the operation does not run (and is not marked),
    // so a hub that stops can never leave it done and unrecorded. The user sees the error and may try again.
    if (outside && this.file) {
      const before = this.done.get(op);
      this.done.set(op, { at: Date.now(), started: true });
      try {
        this.save(true);
      } catch (e) {
        if (before) this.done.set(op, before);
        else this.done.delete(op);
        return Promise.reject(new Error(NOT_MARKED((e as Error).message)));
      }
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
      let size = Infinity;
      try {
        size = JSON.stringify(d.result ?? null)?.length ?? 0;
      } catch {
        // not serializable: kept in memory only
      }
      if (size > MAX_STORED) d = { at: d.at, big: true, result: d.result };
    }
    this.done.set(op, d);
    const now = Date.now();
    for (const [k, v] of this.done) if (now - v.at >= KEEP_MS) this.done.delete(k);
    while (this.done.size > MAX) this.done.delete(this.done.keys().next().value as string);
    this.save();
  }

  /** `strict`: a failed write throws (the mark before an outside effect); otherwise it is not kept, as before. */
  private save(strict = false) {
    if (!this.file) return;
    const out: Record<string, Done> = {};
    // In memory a large answer is kept whole (a repeat now gets it); in the file only that it was done.
    for (const [k, v] of this.done) out[k] = v.big ? { at: v.at, big: true } : v;
    try {
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(out));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch (e) {
      // Not kept. A result not written leaves the "started" mark on disk: a resend after a restart is then answered
      // "result unknown". Only the mark before an outside effect must be written.
      if (strict) throw e;
    }
  }
}
