import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
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
  /** Any local file (the conversation has whole-computer access: its agents may read every file anyway). */
  anywhere?: boolean;
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
 * The URL to load. Local files must be inside the working folder or an extra folder (after resolving links) and not
 * folders: otherwise a screenshot could show the agent the user's credentials or other private files it may not read.
 * `anywhere` (whole-computer access, where agents may read every file anyway): any local file.
 */
export function resolveTarget(target: string, cwd: string, extraRoots: string[] = [], anywhere = false): string {
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
  if (!anywhere && ![cwd, ...extraRoots].some(inside))
    throw new Error(
      L(
        `只能截取工作資料夾（或你加入的額外資料夾）內的檔案：${real} 不在其中。把它的資料夾加入額外資料夾，或讓這段對話使用完整電腦存取，就可以截取。`,
        `Only files inside the working folder (or the extra folders you added) can be captured: ${real} is not. Add its folder as an extra folder, or give this conversation whole-computer access, to capture it.`,
      ),
    );
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
export class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private waiters = new Map<string, (() => void)[]>();
  private closed = false;
  private constructor(private ws: WebSocket) {
    // The browser gone (crashed, closed): every call still waiting fails now instead of never, and so does every
    // call made after (see send).
    ws.on('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(L('瀏覽器連線中斷', 'The browser connection closed')));
      this.pending.clear();
    });
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

  /** Connected within `timeoutMs`, or an error (a browser that hangs does not hold the screenshot up). */
  static async connect(url: string, timeoutMs = 10_000): Promise<Cdp> {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        ws.terminate();
        reject(new Error(L('連不上瀏覽器', 'Could not connect to the browser')));
      }, timeoutMs);
      ws.once('open', () => (clearTimeout(t), resolve()));
      ws.once('error', (e) => (clearTimeout(t), reject(e)));
    });
    return new Cdp(ws);
  }

  /** The answer to one command, or an error after `timeoutMs`. */
  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    const id = ++this.id;
    // Already disconnected: no answer will come, so no 60 s wait for it.
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(L('瀏覽器連線中斷', 'The browser connection closed')));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(L(`瀏覽器沒有回應（${method}）`, `The browser did not answer (${method})`)));
      }, timeoutMs);
      this.pending.set(id, { resolve: (v) => (clearTimeout(t), resolve(v)), reject: (e) => (clearTimeout(t), reject(e)) });
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
  const url = resolveTarget(r.target, r.cwd, r.extraRoots, r.anywhere);
  const width = clamp(r.width, 1280, 240, 3840);
  const height = clamp(r.height, 800, 240, 8000);
  const waitMs = clamp(r.waitMs, 1000, 0, 20000);
  fs.mkdirSync(path.dirname(r.out), { recursive: true });
  // A throwaway profile: never touches the user's browser data and never collides with a running browser.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aivenue-shot-'));
  // Edge on Windows starts again as a new process ("compat layer relaunch") unless told not to; Chrome ignores the flag.
  const child = spawn(
    browser,
    ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--mute-audio', '--edge-skip-compat-layer-relaunch', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
    { env: childEnv(), stdio: 'ignore', windowsHide: true },
  );
  const kill = () => child.kill();
  r.signal?.addEventListener('abort', kill);
  let cdp: Cdp | undefined;
  let port = 0;
  try {
    // The browser writes its debugging port into the profile once it is ready. The process started here may end
    // first, when the browser relaunched itself: the relaunched one writes the same file, so only no port in time (or
    // no browser at all, 3 s after the one started here ended) is a failure.
    // A file not written yet, or still empty or half written, is waited on like a missing one (about 15 s in all).
    const portFile = path.join(profile, 'DevToolsActivePort');
    let endedAt = 0;
    for (let i = 0; i < 150 && !port; i++) {
      if (r.signal?.aborted) throw new Error(L('已取消', 'Cancelled'));
      port = readPort(portFile) ?? 0;
      if (port) break;
      if (child.exitCode !== null) {
        endedAt ||= Date.now();
        if (Date.now() - endedAt > 3000) throw new Error(L(`瀏覽器啟動失敗（結束代碼 ${child.exitCode}）`, `The browser failed to start (exit code ${child.exitCode})`));
      }
      await sleep(100);
    }
    if (!port) throw new Error(L('瀏覽器啟動逾時', 'Timed out starting the browser'));
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json()) as { type: string; webSocketDebuggerUrl: string }[];
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
    await closeBrowser(port, profile, child);
  }
}

/**
 * The debugging port a Chromium browser wrote into its profile ("53743\n/devtools/browser/<id>"): undefined while the
 * file is missing, empty or partial. The port counts only once its line is complete (the browser path follows it):
 * "5374" read before the last digit was written would be another port.
 */
export function readPort(file: string): number | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const m = /^(\d{1,5})\r?\n\/devtools\/browser\//.exec(text);
  const port = m ? Number(m[1]) : 0;
  return port > 0 && port < 65536 ? port : undefined;
}

/**
 * End the screenshot browser and remove its throwaway profile, leaving no browser process behind: ask the browser to
 * close (whichever process it is, a relaunched one too), then wait until the profile can be removed (its files are
 * held while the browser runs, on Windows). Still held after 5 s: whatever process still uses this profile is ended.
 */
async function closeBrowser(port: number, profile: string, child: ChildProcess): Promise<void> {
  if (port) {
    try {
      // Every step with a time limit: a browser that hangs is ended below instead of holding the agent up.
      const v = (await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).json()) as { webSocketDebuggerUrl: string };
      const b = await Cdp.connect(v.webSocketDebuggerUrl, 2000);
      await Promise.race([b.send('Browser.close').catch(() => undefined), sleep(2000)]);
      b.close();
    } catch {
      // already gone, or not answering: the steps below still end it
    }
  }
  child.kill();
  const removed = () => {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      // held by a browser process still running
    }
    return !fs.existsSync(profile);
  };
  for (let i = 0; i < 25; i++) {
    if (removed()) return;
    await sleep(200);
  }
  endProcessesUsing(path.basename(profile));
  await sleep(500);
  removed();
}

/** End every process whose command line names `mark` (a throwaway profile's own folder name, so only ours). */
function endProcessesUsing(mark: string): void {
  if (!/^aivenue-shot-[\w-]+$/.test(mark)) return;
  if (process.platform === 'win32')
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${mark}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
  else spawnSync('pkill', ['-f', mark], { stdio: 'ignore', timeout: 5000 });
}
