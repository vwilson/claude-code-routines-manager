'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_PAGE_PATH = path.join(__dirname, '..', 'renderer', 'index.html');

function isAppPageUrl(candidate, appPageUrl) {
  try {
    const candidateUrl = new URL(candidate);
    const expectedUrl = new URL(appPageUrl);
    candidateUrl.hash = '';
    candidateUrl.search = '';
    expectedUrl.hash = '';
    expectedUrl.search = '';
    return candidateUrl.href === expectedUrl.href;
  } catch {
    return false;
  }
}

function secureWebContents(webContents, appPageUrl) {
  webContents.on('will-navigate', (event, navigationUrl) => {
    if (!isAppPageUrl(navigationUrl, appPageUrl)) event.preventDefault();
  });

  // The application has no renderer-created window use case. Keep this policy
  // default-deny; any future exception must be deliberately added here.
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function createWindow({ BrowserWindow, appPagePath = APP_PAGE_PATH }) {
  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  secureWebContents(win.webContents, pathToFileURL(appPagePath).href);
  win.loadFile(appPagePath);
  return win;
}

function focusExistingWindow(BrowserWindow, preferredWindow) {
  const preferredIsUsable = preferredWindow && !(preferredWindow.isDestroyed?.() ?? false);
  const win = preferredIsUsable ? preferredWindow : BrowserWindow.getAllWindows()[0];
  if (!win) return false;

  if (win.isMinimized()) win.restore();
  if (win.isVisible && !win.isVisible()) win.show();
  win.focus();
  return true;
}

/**
 * Acquire the process-wide lock synchronously, before service modules are loaded.
 * `loadServices` is deliberately lazy so a rejected second process cannot initialize
 * IPC, the local store, or credential-backed cloud services.
 */
function startApplication({ app, BrowserWindow, loadServices }) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }

  let mainWindow;
  const openWindow = () => {
    const win = createWindow({ BrowserWindow });
    mainWindow = win;
    win.on?.('closed', () => {
      if (mainWindow === win) mainWindow = undefined;
    });
    return win;
  };

  app.on('second-instance', () => {
    focusExistingWindow(BrowserWindow, mainWindow);
  });

  app.whenReady().then(() => {
    const { createDesktopGate, createOauth, createCloudApi, createLocalStore, registerIpc } = loadServices();
    const gate = createDesktopGate();
    const oauth = createOauth();
    registerIpc({
      gate,
      cloudApi: createCloudApi({ oauth }),
      localStore: createLocalStore({ gate }),
    });
    openWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
  return true;
}

module.exports = {
  APP_PAGE_PATH,
  createWindow,
  focusExistingWindow,
  isAppPageUrl,
  secureWebContents,
  startApplication,
};
