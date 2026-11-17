import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppSettings } from './types';

const DEFAULTS: AppSettings = { locale: 'zh-TW', theme: 'system', accent: '#c96442' };

/** UI/app preferences persisted by the hub, shared by the desktop app, the VS Code extension and the browser. */
export class SettingsStore {
  private file: string;
  private value: AppSettings;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'settings.json');
    let stored: Partial<AppSettings> = {};
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // first run
    }
    this.value = { ...DEFAULTS, ...stored };
  }

  get(): AppSettings {
    return this.value;
  }

  set(patch: Partial<AppSettings>): AppSettings {
    if (patch.locale && !['zh-TW', 'en'].includes(patch.locale)) throw new Error('unsupported locale');
    if (patch.theme && !['system', 'light', 'dark'].includes(patch.theme)) throw new Error('unsupported theme');
    if (patch.accent && !/^#[0-9a-f]{6}$/i.test(patch.accent)) throw new Error('accent must be #rrggbb');
    // The app and VS Code each keep their own side of sidebarHidden: a change of one leaves the other as it was.
    const side = patch.sidebarHidden;
    if (side !== undefined && (typeof side !== 'object' || side === null || Object.entries(side).some(([k, v]) => !['app', 'vscode'].includes(k) || typeof v !== 'boolean'))) throw new Error('sidebarHidden must be { app?: boolean, vscode?: boolean }');
    this.value = { ...this.value, ...patch, ...(side ? { sidebarHidden: { ...this.value.sidebarHidden, ...side } } : {}) };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.value, null, 2));
    return this.value;
  }
}
