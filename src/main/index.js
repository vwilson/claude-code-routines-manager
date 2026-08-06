'use strict';

// The package.json "main" entry — kept separate from main.js so that requiring
// main.js (as the test suite does, for its exported pure functions) never has
// side effects. Electron's app loader does not reliably set require.main to this
// module when it launches an app's main script directly (require.main === module
// can come back false), so gating auto-start on that check is not safe here.

const { app, BrowserWindow } = require('electron');
const { startApplication } = require('./main');

startApplication({
  app,
  BrowserWindow,
  loadServices: () => ({
    createDesktopGate: require('./claude-desktop').createDesktopGate,
    createOauth: require('./oauth').createOauth,
    createCloudApi: require('./cloud-api').createCloudApi,
    createLocalStore: require('./local-store').createLocalStore,
    registerIpc: require('./ipc').registerIpc,
  }),
});
