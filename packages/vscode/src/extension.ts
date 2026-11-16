import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { defaultDataDir } from '@aivenue/core';
import { ensureHub, newWindowId, type Channel, type Endpoint } from './sharedHub';

/**
 * Every VS Code window shares one hub process (dist/hub.cjs): one record of the extension's chats, live in every
 * window, and one runner per workflow. This window keeps a control channel to it; the hub asks it, through that
 * channel, to open its dialogs, terminals and links, and to write VS Code's secret storage.
 */

/** Set by scripts/build.mjs (esbuild define). */
declare const __AIVENUE_BUILD__: string | undefined;
const BUILD = typeof __AIVENUE_BUILD__ === 'string' ? __AIVENUE_BUILD__ : 'dev';

const windowId = newWindowId();
let channel: Promise<Channel> | undefined;
/** The channel in use (one closed on purpose, when this window closes or the hub is replaced, is not reconnected). */
let current: Channel | undefined;
let closing = false;
let panel: vscode.WebviewPanel | undefined;
/** This window's webviews: shown again when the hub is replaced (its port and token change). */
const views = new Set<vscode.Webview>();
const INDEX = 'aivenue.secretKeys';

/** This window's project: where a chat started here works. */
function windowCwd(): string | undefined {
  const ed = vscode.window.activeTextEditor;
  return (ed ? vscode.workspace.getWorkspaceFolder(ed.document.uri)?.uri.fsPath : undefined) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** What the hub asks this window to do. */
function handlers(ctx: vscode.ExtensionContext) {
  const index = () => ctx.globalState.get<string[]>(INDEX, []);
  return {
    pickFolder: async () => {
      const r = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri });
      return r?.[0]?.fsPath;
    },
    pickFiles: async () => {
      const r = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: true, defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri });
      return r?.map((u) => u.fsPath);
    },
    openPath: async (p: string) => {
      const uri = vscode.Uri.file(p);
      try {
        if (fs.statSync(p).isDirectory()) await vscode.commands.executeCommand('revealFileInOS', uri);
        else await vscode.window.showTextDocument(uri, { preview: true });
      } catch {
        void vscode.window.showWarningMessage(`找不到 ${p}`);
      }
    },
    openExternal: async (url: string) => {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    },
    // Install / sign-in run in VS Code's own terminal: no separate window, and it works over Remote SSH / WSL.
    openTerminal: ({ title, cwd, line, env }: { title: string; cwd: string; line: string; env: Record<string, string> }) => {
      const win = process.platform === 'win32';
      const shell = win ? process.env.ComSpec || 'cmd.exe' : fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
      const term = vscode.window.createTerminal({
        name: `Aivenue · ${title}`,
        cwd,
        env,
        shellPath: shell,
        // cmd.exe: /s /k "line" runs the line as written and keeps the terminal open afterwards.
        shellArgs: win ? `/d /s /k "${line}"` : ['-lc', `${line}; exec ${shell} -l`],
      });
      term.show();
    },
    // VS Code's secret storage (shared by every window); the hub keeps its own copy of what it holds.
    'secrets.set': async (k: string, v: string) => {
      await ctx.secrets.store(`aivenue:${k}`, v);
      await ctx.globalState.update(INDEX, [...new Set([...index(), k])]);
    },
    'secrets.delete': async (k: string) => {
      await ctx.secrets.delete(`aivenue:${k}`);
      await ctx.globalState.update(INDEX, index().filter((x) => x !== k));
    },
  };
}

/** Start the shared hub: VS Code's own runtime as Node (or the remote server's Node), given the secrets on stdin. */
async function startHubProcess(ctx: vscode.ExtensionContext) {
  const secrets: Record<string, string> = {};
  for (const k of ctx.globalState.get<string[]>(INDEX, [])) {
    const v = await ctx.secrets.get(`aivenue:${k}`);
    if (v !== undefined) secrets[k] = v;
  }
  const child = spawn(process.execPath, [path.join(ctx.extensionPath, 'dist', 'hub.cjs')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  });
  child.stdin?.end(JSON.stringify({ version: String(ctx.extension.packageJSON.version ?? '0.1.0'), secrets }));
  child.unref();
}

function connect(ctx: vscode.ExtensionContext): Promise<Channel> {
  channel ??= (async () => {
    const dataDir = defaultDataDir();
    let ch = await ensureHub({ dataDir, windowId, handlers: handlers(ctx), spawn: () => startHubProcess(ctx) });
    // A hub of another build: replaced when nothing runs on it; otherwise it serves on until its work is done.
    if (ch.endpoint.build !== BUILD) {
      const st = await ch.control<{ active: number }>('status').catch(() => ({ active: 1 }));
      if (!st.active) {
        await ch.control('shutdown').catch(() => undefined);
        ch.close();
        const old = ch.endpoint.pid;
        for (let i = 0; i < 50 && isAlive(old); i++) await new Promise((r) => setTimeout(r, 100));
        ch = await ensureHub({ dataDir, windowId, handlers: handlers(ctx), spawn: () => startHubProcess(ctx) });
      } else void vscode.window.showInformationMessage(`Aivenue：背景服務是另一個版本（${ch.endpoint.build}），目前有工作在執行；全部結束、重新載入視窗後會換成這一版。`);
    }
    ch.state({ cwd: windowCwd(), focused: vscode.window.state.focused });
    current = ch;
    const mine = ch;
    // The hub stopped (crashed, or replaced): connect again and show this window's webviews on the new one.
    ch.onClose(() => {
      if (closing || current !== mine) return;
      current = undefined;
      channel = undefined;
      setTimeout(() => {
        void connect(ctx)
          .then((next) => {
            for (const v of views) void render(v, ctx, next.endpoint);
          })
          .catch(() => undefined);
      }, 500);
    });
    return ch;
  })();
  channel.catch(() => (channel = undefined));
  return channel;
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function render(webview: vscode.Webview, ctx: vscode.ExtensionContext, ep: Endpoint) {
  webview.html = await webviewHtml(webview, ctx, ep);
}

async function webviewHtml(webview: vscode.Webview, ctx: vscode.ExtensionContext, ep: Endpoint): Promise<string> {
  const uiDir = vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'ui');
  let html = fs.readFileSync(path.join(uiDir.fsPath, 'index.html'), 'utf8');
  const nonce = randomBytes(16).toString('base64');
  // Remote workspaces: the webview runs locally, so the hub port must be forwarded.
  const external = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${ep.port}`));
  const httpBase = external.toString(true).replace(/\/$/, '');
  // `window`: the hub runs this webview's calls as this window (its dialogs, its project).
  const wsUrl = httpBase.replace(/^http/, 'ws') + `/ws?token=${ep.token}&window=${encodeURIComponent(windowId)}`;
  const assetBase = webview.asWebviewUri(uiDir).toString();
  html = html.replace(/(src|href)="\.?\/(assets\/[^"]+)"/g, (_m, attr: string, rel: string) => `${attr}="${assetBase}/${rel}"`);
  html = html.replace(/<script /g, `<script nonce="${nonce}" `);
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data: blob: ${httpBase}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `connect-src ${wsUrl.replace(/\/ws\?.*$/, '')} ${httpBase}`,
  ].join('; ');
  const boot = `<meta http-equiv="Content-Security-Policy" content="${csp}"><script nonce="${nonce}">window.__AIVENUE__=${JSON.stringify({ wsUrl, host: 'vscode' })};</script>`;
  return html.replace('<head>', `<head>${boot}`);
}

async function show(webview: vscode.Webview, ctx: vscode.ExtensionContext): Promise<boolean> {
  try {
    const ch = await connect(ctx);
    views.add(webview);
    await render(webview, ctx, ch.endpoint);
    return true;
  } catch (e) {
    void vscode.window.showErrorMessage(`Aivenue 無法啟動：${(e as Error).message}`);
    return false;
  }
}

const webviewOptions = (ctx: vscode.ExtensionContext): vscode.WebviewOptions => ({
  enableScripts: true,
  localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'ui')],
});

/** The chat in the Secondary Side Bar (right), next to the editor — like Copilot Chat. */
class ChatViewProvider implements vscode.WebviewViewProvider {
  constructor(private ctx: vscode.ExtensionContext) {}

  async resolveWebviewView(view: vscode.WebviewView) {
    view.webview.options = webviewOptions(this.ctx);
    view.webview.html = '<body style="font-family:sans-serif;opacity:.6;padding:12px">Aivenue 啟動中…</body>';
    view.onDidDispose(() => views.delete(view.webview));
    await show(view.webview, this.ctx);
  }
}

/** The same chat as an editor tab, for a wide layout. */
async function openPanel(ctx: vscode.ExtensionContext) {
  if (panel) {
    panel.reveal();
    return;
  }
  panel = vscode.window.createWebviewPanel('aivenue', 'Aivenue', vscode.ViewColumn.Active, { ...webviewOptions(ctx), retainContextWhenHidden: true });
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'ui', 'icon.svg');
  const webview = panel.webview;
  panel.onDidDispose(() => ((panel = undefined), views.delete(webview)), null, ctx.subscriptions);
  if (!(await show(webview, ctx))) panel?.dispose();
}

const focusChat = () => vscode.commands.executeCommand('aivenue.chat.focus');

export function activate(ctx: vscode.ExtensionContext) {
  const tell = () => void channel?.then((ch) => ch.state({ cwd: windowCwd(), focused: vscode.window.state.focused })).catch(() => undefined);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider('aivenue.chat', new ChatViewProvider(ctx), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('aivenue.open', focusChat),
    vscode.commands.registerCommand('aivenue.openInEditor', () => openPanel(ctx)),
    vscode.commands.registerCommand('aivenue.openInBrowser', async () => {
      const ch = await connect(ctx);
      const external = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${ch.endpoint.port}/?token=${ch.endpoint.token}`));
      await vscode.env.openExternal(external);
    }),
    // The hub follows this window's project and focus (a new chat started here works in this window's folder).
    vscode.window.onDidChangeActiveTextEditor(tell),
    vscode.workspace.onDidChangeWorkspaceFolders(tell),
    vscode.window.onDidChangeWindowState(tell),
  );
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  item.text = '$(hubot) Aivenue';
  item.tooltip = '開啟 Aivenue 多 agent 工作流';
  item.command = 'aivenue.open';
  item.show();
  ctx.subscriptions.push(item);
  if (vscode.workspace.getConfiguration('aivenue').get<boolean>('openOnStartup')) void focusChat();
}

/** This window closes: only its channel goes; the hub serves the other windows (and stops when none is left). */
export async function deactivate() {
  closing = true;
  const ch = await channel?.catch(() => undefined);
  ch?.close();
}
