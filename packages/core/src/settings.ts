import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppSettings } from './types';

const DEFAULTS: AppSettings = { locale: 'zh-TW', theme: 'system', accent: '#c96442' };

/** A lock older than this is left over from a hub that stopped while holding it. */
const STALE_LOCK_MS = 10_000;
/** How long a change waits for the other hub's change to finish. */
const LOCK_WAIT_MS = 3_000;

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * UI/app preferences persisted by the hub, shared by the desktop app, the VS Code extension and the browser.
 *
 * The app's hub and the shared VS Code hub each keep a SettingsStore on the same settings.json. A change is made to the
 * file as it is now (read under a lock file, written to a temporary file and renamed over it), not to this store's
 * copy, so one hub never writes back an older copy over what the other just saved (e.g. each side's sidebarHidden).
 * Reading picks up the other hub's changes too.
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

  /** Runs `fn` holding settings.json.lock (made with exclusive create); a lock left by a stopped hub is taken over. */
  private locked(fn: () => void) {
    const lock = `${this.file}.lock`;
    const until = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        fs.closeSync(fs.openSync(lock, 'wx'));
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        let age = 0;
        try {
          age = Date.now() - fs.statSync(lock).mtimeMs;
        } catch {
          continue; // released meanwhile
        }
        if (age > STALE_LOCK_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
        if (Date.now() > until) throw new Error('settings are being saved by another Aivenue: try again');
        pause(20);
      }
    }
    try {
      fn();
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }
}
