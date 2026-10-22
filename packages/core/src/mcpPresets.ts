import * as os from 'node:os';
import * as path from 'node:path';
import type { McpServerConfig } from './types';
import { findBrowser } from './screenshot';

/**
 * Ready-made shared MCP servers the user can enable with one click.
 * Every preset uses a throwaway browser profile: never the user's own browser with their logins.
 */
export interface McpPreset {
  id: string;
  name: string;
  zh: string;
  en: string;
  docsUrl: string;
  build(o: { headed: boolean }): McpServerConfig;
}

/** npx through cmd on Windows: several CLIs cannot start `npx` (a .cmd shim) directly. */
function npx(pkg: string, args: string[]): Pick<McpServerConfig, 'command' | 'args'> {
  // Full path to cmd.exe: a bare `cmd` could be picked up from the project folder by some CLIs.
  const cmd = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  return process.platform === 'win32' ? { command: cmd, args: ['/d', '/c', 'npx', '-y', pkg, ...args] } : { command: 'npx', args: ['-y', pkg, ...args] };
}

/** Chrome DevTools MCP looks for Google Chrome; fall back to whatever Chromium browser is installed (Edge on Windows). */
function chromeExecutable(): string[] {
  const b = findBrowser();
  return b && !/chrome(\.exe)?$/i.test(path.basename(b)) ? ['--executablePath', b] : [];
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'playwright',
    name: 'Playwright',
    zh: '讓 agent 操作瀏覽器：開網址、點擊、輸入、填表單、換頁、讀取頁面內容與截圖。適合實際操作測試你正在開發的網站。',
    en: 'Lets agents drive a browser: open URLs, click, type, fill forms, navigate, read the page and take screenshots. Good for hands-on testing of the site you are building.',
    docsUrl: 'https://github.com/microsoft/playwright-mcp',
    build: ({ headed }) => ({
      id: 'playwright',
      name: 'Playwright',
      enabled: true,
      transport: 'stdio',
      ...npx('@playwright/mcp@latest', [
        '--isolated',
        '--browser',
        process.platform === 'win32' ? 'msedge' : 'chrome',
        // Lets agents open local HTML files (file://) they build in the working folder.
        '--allow-unrestricted-file-access',
        // Page snapshots and console logs go to temp, not into the user's project.
        '--output-dir',
        // Inside Aivenue's own data folder: a shared /tmp folder could be read by other users on Linux.
        path.join(process.env.AIVENUE_HOME || path.join(os.homedir(), '.aivenue'), 'tmp', 'playwright'),
        ...(headed ? [] : ['--headless']),
      ]),
      env: {},
      description: 'Browser automation (Playwright MCP), throwaway profile',
    }),
  },
  {
    id: 'chrome-devtools',
    name: 'Chrome DevTools',
    zh: '讓 agent 用開發者工具除錯網頁：看 console 錯誤、網路請求、效能分析、執行 JavaScript，也能點擊與截圖。適合找出畫面壞掉或跑很慢的原因。',
    en: 'Lets agents debug pages with DevTools: console errors, network requests, performance traces, running JavaScript, plus clicks and screenshots. Good for finding why a page breaks or is slow.',
    docsUrl: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    build: ({ headed }) => ({
      id: 'chrome-devtools',
      name: 'Chrome DevTools',
      enabled: true,
      transport: 'stdio',
      ...npx('chrome-devtools-mcp@latest', [
        '--isolated',
        // Keep the URLs being tested on this computer.
        '--no-usage-statistics',
        '--no-performance-crux',
        ...chromeExecutable(),
        ...(headed ? [] : ['--headless']),
      ]),
      env: {},
      description: 'Browser debugging (Chrome DevTools MCP), throwaway profile',
    }),
  },
];
