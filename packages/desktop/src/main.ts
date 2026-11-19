import { app, BrowserWindow, dialog, Menu, nativeTheme, safeStorage, shell } from 'electron';
import * as path from 'node:path';
import { defaultDataDir, FileSecretStore, HubBusyError, startHub, type Hub } from '@aivenue/core';

let hub: Hub | undefined;
let win: BrowserWindow | undefined;

/**
 * The window and taskbar icon follows the theme the page shows: the blue logo on a light page, the orange one on a dark
 * page (the files the UI build ships). Before the page says, the system's light or dark setting decides.
 */
const iconFor = (dark: boolean) => path.join(__dirname, 'ui', dark ? 'icon-dark.png' : 'icon.png');
let iconDark: boolean | undefined;

// Files that external processes (agent CLIs) must execute cannot live inside app.asar.
const unpacked = (p: string) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    try {
      // API keys are encrypted with the OS user's credentials (DPAPI on Windows, Keychain on macOS).
      const secrets = safeStorage.isEncryptionAvailable()
        ? new FileSecretStore(defaultDataDir(), {
            encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
            decrypt: (c) => safeStorage.decryptString(Buffer.from(c, 'base64')),
          })
        : undefined;
      hub = await startHub({
        secrets,
        uiDir: path.join(__dirname, 'ui'),
        bridgePath: unpacked(path.join(__dirname, 'bridge.cjs')),
        version: app.getVersion(),
        hooks: {
          host: 'desktop',
          pickFolder: async () => {
            const r = win ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] }) : await dialog.showOpenDialog({ properties: ['openDirectory'] });
            return r.canceled ? undefined : r.filePaths[0];
          },
          pickFiles: async () => {
            const opts = { properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[] };
            const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
            return r.canceled ? undefined : r.filePaths;
          },
          openPath: async (p) => {
            await shell.openPath(p);
          },
          openExternal: (url) => shell.openExternal(url),
          setAppearance: ({ dark }) => {
            if (dark === iconDark) return;
            iconDark = dark;
            win?.setIcon(iconFor(dark));
          },
        },
      });
    } catch (e) {
      // Another Aivenue app (another install, or a portable copy) already runs these chats: say so, without a stack.
      if (e instanceof HubBusyError) dialog.showErrorBox('Aivenue 無法啟動', `${e.message}。請先關閉另一個 Aivenue，再開啟這一個。`);
      else dialog.showErrorBox('Aivenue 無法啟動', String((e as Error)?.stack ?? e));
      app.quit();
      return;
    }

    // Linux: the window's X11 class (WM_CLASS) is the app's name, which is the package name "@aivenue/desktop"
    // (productName is only electron-builder's), so the desktop never tied the window to the menu entry
    // (StartupWMClass=Aivenue). The class is taken when the window is created: the app is named "Aivenue" for that
    // moment only (creating the window is synchronous: nothing else runs in between) and gets its own name back right
    // after. Everything else that goes by the app's name (the OS keyring entry the API keys are encrypted with, the
    // data folder) sees the name it always had.
    const appName = app.getName();
    const renameForWindow = process.platform === 'linux' && appName !== 'Aivenue';
    if (renameForWindow) {
      app.setPath('userData', app.getPath('userData'));
      app.setName('Aivenue');
    }
    try {
      win = new BrowserWindow({
        width: 1440,
        height: 920,
        minWidth: 960,
        minHeight: 600,
        title: 'Aivenue',
        icon: iconFor(iconDark ?? nativeTheme.shouldUseDarkColors),
        backgroundColor: '#0f1117',
        autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
    } finally {
      if (renameForWindow) app.setName(appName);
    }
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith(hub!.url)) e.preventDefault();
    });
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win?.webContents.toggleDevTools();
    });
    await win.loadURL(hub.uiUrl);
  });

  app.on('window-all-closed', async () => {
    await hub?.close();
    app.quit();
  });
}
