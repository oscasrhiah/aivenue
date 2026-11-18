import * as fs from 'node:fs';
import { L } from './i18n';

/**
 * Each client operation runs once. A client tags every call with an id of its own (`op`); a call sent again (after a
 * reconnect, or a second click that reused the id) gets the first call's answer instead of running again. Kept for ten
 * minutes, in memory and in a small file, so a hub restarted meanwhile (the shared VS Code hub) still knows them.
 */
const KEEP_MS = 10 * 60_000;
const MAX = 2000;
/**
 * "Started" marks (operations with an outside effect, see replay.ts) are kept apart from answers: a mark stays until its
 * operation finishes (then its answer replaces it), with no time limit, so a resend of an operation whose end was never
 * seen (the hub stopped) is never run again, however long ago it started. The one limit: at most this many unfinished
 * marks of operations no longer running are kept; past it the oldest goes. While a mark is kept, a resend of its
 * operation is refused; once it has gone, a resend may run again. It goes only once the file without it is written (a
 * failed write puts it back), so memory never drops one the disk still has. (Marks are left only by a hub that stopped
 * while such an operation ran, a few each time.)
 */
const MAX_MARKS = 1000;
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
  /** Unfinished operations with an outside effect: when each started (see MAX_MARKS). */
  private marks = new Map<string, number>();

  constructor(private file?: string) {
    if (!file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Done>;
      for (const [op, d] of Object.entries(saved)) {
        if (d.started) this.marks.set(op, d.at);
        else if (Date.now() - d.at < KEEP_MS) this.done.set(op, d);
      }
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
    // Started and never seen to finish (the hub stopped meanwhile): it may have happened. Not run again.
    if (this.marks.has(op)) return Promise.reject(new Error(UNKNOWN()));
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
      return Promise.reject(new Error(r.done ? L('這個操作已經執行過了', 'This operation was already done') : UNKNOWN()));
    }
    // An effect outside Aivenue's records (an upload, an install, a sign-in): that it started is on disk before it runs.
    // The mark must be on disk before it runs: if it cannot be written, the operation does not run (and is not marked),
    // so a hub that stops can never leave it done and unrecorded. The user sees the error and may try again.
    if (outside && this.file) {
      this.marks.set(op, Date.now());
      const dropped = this.trimMarks(op);
      try {
        this.save(true);
      } catch (e) {
        // Not written: as if it never came. Its mark goes, and the ones it would have pushed out stay (still on disk).
        this.marks.delete(op);
        for (const [k, at] of dropped) this.marks.set(k, at);
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
    // Finished: its answer replaces its mark.
    this.marks.delete(op);
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
    // Old answers go, oldest first when there are too many. Marks are apart (MAX_MARKS): one of a running operation
    // always stays.
    for (const [k, v] of this.done) if (now - v.at >= KEEP_MS) this.done.delete(k);
    while (this.done.size > MAX) this.done.delete(this.done.keys().next().value as string);
    const dropped = this.trimMarks();
    // A mark is dropped only once the file without it is written: until then it is still on disk, and here too.
    if (!this.save()) for (const [k, at] of dropped) this.marks.set(k, at);
  }

  /**
   * At most MAX_MARKS marks of operations not running (`starting`: about to run), the oldest going first. Returns the
   * ones taken out, for the caller to put back if the file without them cannot be written.
   */
  private trimMarks(starting?: string): [string, number][] {
    const idle = [...this.marks].filter(([k]) => k !== starting && !this.running.has(k)).sort((a, b) => a[1] - b[1]);
    const dropped = idle.slice(0, Math.max(0, idle.length - MAX_MARKS));
    for (const [k] of dropped) this.marks.delete(k);
    return dropped;
  }

  /**
   * Whether the file was written. `strict`: a failed write throws (the mark before an outside effect); otherwise it is
   * not kept, as before.
   */
  private save(strict = false): boolean {
    if (!this.file) return true;
    const out: Record<string, Done> = {};
    // In memory a large answer is kept whole (a repeat now gets it); in the file only that it was done.
    for (const [k, v] of this.done) out[k] = v.big ? { at: v.at, big: true } : v;
    for (const [k, at] of this.marks) out[k] = { at, started: true };
    try {
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(out));
      fs.renameSync(`${this.file}.tmp`, this.file);
      return true;
    } catch (e) {
      // Not kept. A result not written leaves the "started" mark on disk: a resend after a restart is then answered
      // "result unknown". Only the mark before an outside effect must be written.
      if (strict) throw e;
      return false;
    }
  }
}
