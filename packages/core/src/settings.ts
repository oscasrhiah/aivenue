import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppSettings } from './types';

const DEFAULTS: AppSettings = { locale: 'zh-TW', theme: 'system', accent: '#c96442' };

/** How long a change waits for another hub's change to finish; then it is refused, never forced. */
const LOCK_WAIT_MS = 3_000;
/** An empty lock (its owner stopped between making it and writing its name) older than this is left over. */
const EMPTY_LOCK_MS = 10_000;

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** When this process started (with the PID, it names the lock's owner: a PID can be reused, a start time not). */
const STARTED = Math.round(Date.now() - process.uptime() * 1000);

interface Owner {
  pid: number;
  started: number;
  host: string;
  token: string;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** When a running process started (undefined when it cannot be read). Synchronous: only asked about an old lock's owner. */
function startedAt(pid: number): number | undefined {
  try {
    const out =
      process.platform === 'win32'
        ? execFileSync('powershell', ['-NoProfile', '-Command', `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Math.round(pid)}"; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }`], { encoding: 'utf8', timeout: 15000, windowsHide: true })
        : execFileSync('ps', ['-o', 'lstart=', '-p', String(Math.round(pid))], { encoding: 'utf8', timeout: 15000 });
    return Date.parse(out.trim()) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * UI/app preferences persisted by the hub, shared by the desktop app, the VS Code extension and the browser.
 *
 * The app's hub and the shared VS Code hub each keep a SettingsStore on the same settings.json. A change is made to the
 * file as it is now, read and written while holding settings.json.lock (written to a temporary file and renamed over
 * it), so one hub never writes back an older copy over what the other just saved (e.g. each side's sidebarHidden).
 * Reading picks up the other hub's changes too.
 *
 * The lock names its owner (PID, when that process started, host, a token of its own). It is taken over only when the
 * owner is provably gone: its process ended, or the PID now belongs to a process started at another time. A live owner,
 * however long it takes, is waited for and then the change is refused with an error: a settings change is never forced.
 * Each holder removes the lock only while it is still its own.
 */
export class SettingsStore {
  private file: string;
  private value: AppSettings;
  private stamp = '';

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'settings.json');
    this.value = this.read();
  }

  get(): AppSettings {
    if (this.fileStamp() !== this.stamp) this.value = this.read();
    return this.value;
  }

  set(patch: Partial<AppSettings>): AppSettings {
    if (patch.locale && !['zh-TW', 'en'].includes(patch.locale)) throw new Error('unsupported locale');
    if (patch.theme && !['system', 'light', 'dark'].includes(patch.theme)) throw new Error('unsupported theme');
    if (patch.accent && !/^#[0-9a-f]{6}$/i.test(patch.accent)) throw new Error('accent must be #rrggbb');
    // The app and VS Code each keep their own side of sidebarHidden: a change of one leaves the other as it was.
    const side = patch.sidebarHidden;
    if (side !== undefined && (typeof side !== 'object' || side === null || Object.entries(side).some(([k, v]) => !['app', 'vscode'].includes(k) || typeof v !== 'boolean'))) throw new Error('sidebarHidden must be { app?: boolean, vscode?: boolean }');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.locked(() => {
      const latest = this.read();
      this.value = { ...latest, ...patch, ...(side ? { sidebarHidden: { ...latest.sidebarHidden, ...side } } : {}) };
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2));
      fs.renameSync(tmp, this.file);
      this.stamp = this.fileStamp();
    });
    return this.value;
  }

  private read(): AppSettings {
    let stored: Partial<AppSettings> = {};
    const stamp = this.fileStamp();
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // first run
    }
    this.stamp = stamp;
    return { ...DEFAULTS, ...stored };
  }

  private fileStamp(): string {
    try {
      const st = fs.statSync(this.file);
      return `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      return '';
    }
  }

  /** Runs `fn` holding settings.json.lock (see the class comment). */
  private locked(fn: () => void) {
    const lock = `${this.file}.lock`;
    const mine = JSON.stringify({ pid: process.pid, started: STARTED, host: os.hostname(), token: randomUUID() } satisfies Owner);
    const until = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const fd = fs.openSync(lock, 'wx');
        try {
          fs.writeSync(fd, mine);
        } finally {
          fs.closeSync(fd);
        }
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const seen = readLock(lock);
        if (seen === undefined) continue; // released meanwhile
        if (ownerGone(seen.text, seen.age)) {
          // Removed only if it is still the lock that was judged (another waiter may have taken it over meanwhile).
          if (readLock(lock)?.text === seen.text) fs.rmSync(lock, { force: true });
          continue;
        }
        if (Date.now() > until) throw new Error('settings are being saved by another Aivenue: try again');
        pause(20);
      }
    }
    try {
      fn();
    } finally {
      if (readLock(lock)?.text === mine) fs.rmSync(lock, { force: true });
    }
  }
}

function readLock(lock: string): { text: string; age: number } | undefined {
  try {
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    return { text: fs.readFileSync(lock, 'utf8'), age };
  } catch {
    return undefined;
  }
}

/** Whether a lock's owner is provably gone. Anything that cannot be checked counts as alive. */
function ownerGone(text: string, age: number): boolean {
  let owner: Owner | undefined;
  try {
    owner = JSON.parse(text) as Owner;
  } catch {
    // empty or cut short: its owner stopped right after making it, unless it is still writing
    return age > EMPTY_LOCK_MS;
  }
  if (!owner || typeof owner.pid !== 'number' || owner.host !== os.hostname()) return false;
  if (!alive(owner.pid)) return true;
  // The PID runs: the owner itself, or another process that got the same PID after the owner ended.
  if (owner.pid === process.pid) return owner.started !== STARTED;
  const started = startedAt(owner.pid);
  return started !== undefined && Math.abs(started - owner.started) > 5_000;
}
