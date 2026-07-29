'use strict';

const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { createDesktopGate } = require('./claude-desktop');
const { createOauth } = require('./oauth');
const { createCloudApi } = require('./cloud-api');
const { createLocalStore } = require('./local-store');
const { registerIpc } = require('./ipc');

function createWindow() {
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
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  const gate = createDesktopGate();
  const oauth = createOauth();
  registerIpc({
    gate,
    cloudApi: createCloudApi({ oauth }),
    localStore: createLocalStore({ gate }),
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
