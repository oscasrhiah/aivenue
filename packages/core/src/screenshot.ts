import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { L } from './i18n';
import { childEnv } from './proc';

/** Chromium-based browsers that can take headless screenshots, most likely first. */
function browserCandidates(): string[] {
  const env = process.env;
  const fromEnv = env.AIVENUE_BROWSER ? [env.AIVENUE_BROWSER] : [];
  if (process.platform === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter((x): x is string => !!x);
    return [
      ...fromEnv,
      ...roots.map((r) => path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
      ...roots.map((r) => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')),
      ...roots.map((r) => path.join(r, 'Chromium', 'Application', 'chrome.exe')),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      ...fromEnv,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  const dirs = (env.PATH ?? '').split(path.delimiter);
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable'];
  return [...fromEnv, ...names.flatMap((n) => dirs.map((d) => path.join(d, n)))];
}

export function findBrowser(): string | undefined {
  return browserCandidates().find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

export interface ScreenshotRequest {
  /** http(s) / file URL, or a file path (relative to `cwd`). */
  target: string;
  cwd: string;
  /** Extra folders the user added; local files may come from them too. */
  extraRoots?: string[];
  /** Where the PNG goes (folder is created). */
  out: string;
  width?: number;
  height?: number;
  /** Capture the whole scrollable page instead of just the viewport. */
  fullPage?: boolean;
  /** Extra time for scripts / animations after the page loaded. */
  waitMs?: number;
  signal?: AbortSignal;
}

/**
 * The URL to load. Local files must be inside the working folder (after resolving links) and not folders:
 * otherwise a screenshot could show the user's credentials or other private files to the agent.
 */
export function resolveTarget(target: string, cwd: string, extraRoots: string[] = []): string {
  const t = target.trim();
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) && !/^file:\/\//i.test(t)) throw new Error(L(`不支援的網址：${t}`, `Unsupported URL: ${t}`));
  if (/^localhost(:\d+)?(\/|$)|^127\.0\.0\.1(:\d+)?(\/|$)/i.test(t)) return `http://${t}`;
  let abs: string;
  try {
    abs = /^file:\/\//i.test(t) ? fileURLToPath(t.replace(/[?#].*$/, '')) : path.resolve(cwd, t);
  } catch {
    throw new Error(L(`無效的檔案網址：${t}`, `Invalid file URL: ${t}`));
  }
  if (!fs.existsSync(abs)) throw new Error(L(`找不到檔案：${abs}`, `File not found: ${abs}`));
  const real = fs.realpathSync(abs);
  const inside = (root: string) => {
    try {
      const rel = path.relative(fs.realpathSync(root), real);
      return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    } catch {
      return false;
    }
  };
  if (![cwd, ...extraRoots].some(inside)) throw new Error(L('只能截取工作資料夾（或你加入的額外資料夾）內的檔案', 'Only files inside the working folder (or the extra folders you added) can be captured'));
  if (fs.statSync(real).isDirectory()) throw new Error(L('請指定 HTML 或圖片檔，不能是資料夾', 'Give an HTML or image file, not a folder'));
  return pathToFileURL(real).href;
}

/** localhost, 127.x.x.x or [::1]. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return true;
    const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '::1';
  } catch {
    return false;
  }
}

const clamp = (v: number | undefined, def: number, min: number, max: number) => Math.min(Math.max(Math.round(Number(v) || def), min), max);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal Chrome DevTools Protocol client over one page target. */
class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private waiters = new Map<string, (() => void)[]>();
  private constructor(private ws: WebSocket) {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      } else if (msg.method) {
        for (const w of this.waiters.get(msg.method) ?? []) w();
        this.waiters.delete(msg.method);
      }
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return new Cdp(ws);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Resolves on the next `method` event, or after `timeoutMs`. */
  once(method: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      this.waiters.set(method, [...(this.waiters.get(method) ?? []), () => (clearTimeout(t), resolve())]);
    });
  }

  close() {
    this.ws.close();
  }
}

/**
 * Render a page in a headless Chromium (fresh temporary profile) and save a PNG.
 * Uses DevTools device emulation, so narrow (phone) widths render at their real size.
 */
export async function captureScreenshot(r: ScreenshotRequest): Promise<{ path: string; url: string; width: number; height: number }> {
  const browser = findBrowser();
  if (!browser) throw new Error(L('找不到可用的瀏覽器（Edge / Chrome / Chromium）。可設定環境變數 AIVENUE_BROWSER 指定路徑。', 'No Chromium-based browser found (Edge / Chrome / Chromium). Set AIVENUE_BROWSER to its path.'));
  const url = resolveTarget(r.target, r.cwd, r.extraRoots);
  const width = clamp(r.width, 1280, 240, 3840);
  const height = clamp(r.height, 800, 240, 8000);
  const waitMs = clamp(r.waitMs, 1000, 0, 20000);
  fs.mkdirSync(path.dirname(r.out), { recursive: true });
  // A throwaway profile: never touches the user's browser data and never collides with a running browser.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-shot-'));
  const child = spawn(
    browser,
    ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--mute-audio', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
    { env: childEnv(), stdio: 'ignore', windowsHide: true },
  );
  const kill = () => child.kill();
  r.signal?.addEventListener('abort', kill);
  let cdp: Cdp | undefined;
  try {
    // The browser writes its debugging port into the profile once it is ready.
    const portFile = path.join(profile, 'DevToolsActivePort');
    let port = 0;
    for (let i = 0; i < 150 && !port; i++) {
      if (child.exitCode !== null) throw new Error(L('瀏覽器啟動失敗', 'The browser failed to start'));
      try {
        port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
      } catch {
        await sleep(100);
      }
    }
    if (!port) throw new Error(L('瀏覽器啟動逾時', 'Timed out starting the browser'));
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error(L('瀏覽器沒有可用的分頁', 'No page target in the browser'));
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    const mobile = width <= 600;
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    if (mobile) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const loaded = cdp.once('Page.loadEventFired', 30000);
    const nav = await cdp.send<{ errorText?: string }>('Page.navigate', { url });
    if (nav.errorText) throw new Error(L(`無法開啟 ${url}：${nav.errorText}`, `Could not open ${url}: ${nav.errorText}`));
    await loaded;
    await sleep(waitMs);
    let shotHeight = height;
    const params: Record<string, unknown> = { format: 'png' };
    if (r.fullPage) {
      const m = await cdp.send<{ cssContentSize?: { height: number }; contentSize: { height: number } }>('Page.getLayoutMetrics');
      shotHeight = clamp((m.cssContentSize ?? m.contentSize).height, height, 240, 16000);
      Object.assign(params, { captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: shotHeight, scale: 1 } });
    }
    const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', params);
    fs.writeFileSync(r.out, Buffer.from(data, 'base64'));
    return { path: r.out, url, width, height: shotHeight };
  } finally {
    cdp?.close();
    r.signal?.removeEventListener('abort', kill);
    child.kill();
    // Give the browser a moment to release the profile before removing it.
    setTimeout(() => fs.rm(profile, { recursive: true, force: true }, () => undefined), 1500);
  }
}
