import { app, BrowserWindow, dialog, Menu, safeStorage, shell } from 'electron';
import * as path from 'node:path';
import { defaultDataDir, FileSecretStore, startHub, type Hub } from '@aivenue/core';

let hub: Hub | undefined;
let win: BrowserWindow | undefined;

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
        },
      });
    } catch (e) {
      dialog.showErrorBox('Aivenue 無法啟動', String((e as Error)?.stack ?? e));
      app.quit();
      return;
    }

    win = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 960,
      minHeight: 600,
      title: 'Aivenue',
      icon: path.join(__dirname, 'ui', 'icon.png'),
      backgroundColor: '#0f1117',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
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
