import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { startHub, type Hub, type SecretStore } from '@aivenue/core';

let hubPromise: Promise<Hub> | undefined;
let panel: vscode.WebviewPanel | undefined;

/** VS Code SecretStorage has no key listing, so an index of key names is kept in globalState. */
function vscodeSecrets(ctx: vscode.ExtensionContext): SecretStore {
  const INDEX = 'aivenue.secretKeys';
  const index = () => ctx.globalState.get<string[]>(INDEX, []);
  return {
    secure: true,
    get: async (k) => (await ctx.secrets.get(`aivenue:${k}`)) ?? undefined,
    set: async (k, v) => {
      await ctx.secrets.store(`aivenue:${k}`, v);
      await ctx.globalState.update(INDEX, [...new Set([...index(), k])]);
    },
    delete: async (k) => {
      await ctx.secrets.delete(`aivenue:${k}`);
      await ctx.globalState.update(INDEX, index().filter((x) => x !== k));
    },
    keys: async () => index(),
  };
}

function getHub(ctx: vscode.ExtensionContext): Promise<Hub> {
  hubPromise ??= startHub({
    secrets: vscodeSecrets(ctx),
    uiDir: path.join(ctx.extensionPath, 'dist', 'ui'),
    bridgePath: path.join(ctx.extensionPath, 'dist', 'bridge.cjs'),
    version: String(ctx.extension.packageJSON.version ?? '0.1.0'),
    hooks: {
      host: 'vscode',
      defaultCwd: () => vscode.window.activeTextEditor ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      pickFolder: async () => {
        const r = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri });
        return r?.[0]?.fsPath;
      },
      pickFiles: async () => {
        const r = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: true, defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri });
        return r?.map((u) => u.fsPath);
      },
      openPath: async (p) => {
        const uri = vscode.Uri.file(p);
        try {
          if (fs.statSync(p).isDirectory()) await vscode.commands.executeCommand('revealFileInOS', uri);
          else await vscode.window.showTextDocument(uri, { preview: true });
        } catch {
          void vscode.window.showWarningMessage(`找不到 ${p}`);
        }
      },
      openExternal: async (url) => {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      },
      // Install / sign-in run in VS Code's own terminal: no separate window, and it works over Remote SSH / WSL.
      openTerminal: ({ title, cwd, line, env }) => {
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
    },
  });
  hubPromise.catch(() => (hubPromise = undefined));
  return hubPromise;
}

async function webviewHtml(webview: vscode.Webview, ctx: vscode.ExtensionContext, hub: Hub): Promise<string> {
  const uiDir = vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'ui');
  let html = fs.readFileSync(path.join(uiDir.fsPath, 'index.html'), 'utf8');
  const nonce = randomBytes(16).toString('base64');
  // Remote workspaces: the webview runs locally, so the hub port must be forwarded.
  const external = await vscode.env.asExternalUri(vscode.Uri.parse(hub.url));
  const httpBase = external.toString(true).replace(/\/$/, '');
  const wsUrl = httpBase.replace(/^http/, 'ws') + `/ws?token=${hub.token}`;
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

async function hubOrError(ctx: vscode.ExtensionContext): Promise<Hub | undefined> {
  try {
    return await getHub(ctx);
  } catch (e) {
    void vscode.window.showErrorMessage(`Aivenue 無法啟動：${(e as Error).message}`);
    return undefined;
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
    const hub = await hubOrError(this.ctx);
    if (hub) view.webview.html = await webviewHtml(view.webview, this.ctx, hub);
  }
}

/** The same chat as an editor tab, for a wide layout. */
async function openPanel(ctx: vscode.ExtensionContext) {
  if (panel) {
    panel.reveal();
    return;
  }
  const hub = await hubOrError(ctx);
  if (!hub) return;
  panel = vscode.window.createWebviewPanel('aivenue', 'Aivenue', vscode.ViewColumn.Active, { ...webviewOptions(ctx), retainContextWhenHidden: true });
  panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'ui', 'icon.svg');
  panel.webview.html = await webviewHtml(panel.webview, ctx, hub);
  panel.onDidDispose(() => (panel = undefined), null, ctx.subscriptions);
}

const focusChat = () => vscode.commands.executeCommand('aivenue.chat.focus');

export function activate(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider('aivenue.chat', new ChatViewProvider(ctx), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('aivenue.open', focusChat),
    vscode.commands.registerCommand('aivenue.openInEditor', () => openPanel(ctx)),
    vscode.commands.registerCommand('aivenue.openInBrowser', async () => {
      const hub = await getHub(ctx);
      const external = await vscode.env.asExternalUri(vscode.Uri.parse(hub.uiUrl));
      await vscode.env.openExternal(external);
    }),
  );
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  item.text = '$(hubot) Aivenue';
  item.tooltip = '開啟 Aivenue 多 agent 工作流';
  item.command = 'aivenue.open';
  item.show();
  ctx.subscriptions.push(item);
  if (vscode.workspace.getConfiguration('aivenue').get<boolean>('openOnStartup')) void focusChat();
}

export async function deactivate() {
  if (hubPromise) await (await hubPromise).close();
}
