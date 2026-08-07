'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const {
  createWindow,
  focusExistingWindow,
  isAppPageUrl,
  startApplication,
} = require('../src/main/main');

function makeBrowserWindow() {
  class FakeBrowserWindow {
    static instances = [];

    static getAllWindows() {
      return FakeBrowserWindow.instances.filter((win) => !win.destroyed);
    }

    constructor(options) {
      this.options = options;
      this.handlers = new Map();
      this.webContentsHandlers = new Map();
      this.webContents = {
        on: (name, handler) => this.webContentsHandlers.set(name, handler),
        setWindowOpenHandler: (handler) => {
          this.windowOpenHandler = handler;
        },
      };
      this.minimized = false;
      this.visible = true;
      this.destroyed = false;
      this.restoreCalls = 0;
      this.showCalls = 0;
      this.focusCalls = 0;
      FakeBrowserWindow.instances.push(this);
    }

    loadFile(filePath) {
      this.loadedFile = filePath;
    }

    on(name, handler) {
      this.handlers.set(name, handler);
    }

    isDestroyed() {
      return this.destroyed;
    }

    isMinimized() {
      return this.minimized;
    }

    restore() {
      this.minimized = false;
      this.restoreCalls += 1;
    }

    isVisible() {
      return this.visible;
    }

    show() {
      this.visible = true;
      this.showCalls += 1;
    }

    focus() {
      this.focusCalls += 1;
    }
  }

  return FakeBrowserWindow;
}

function makeApp({ hasLock = true } = {}) {
  const handlers = new Map();
  const calls = [];
  return {
    calls,
    handlers,
    requestSingleInstanceLock() {
      calls.push('request-lock');
      return hasLock;
    },
    quit() {
      calls.push('quit');
    },
    whenReady() {
      calls.push('when-ready');
      return Promise.resolve();
    },
    on(name, handler) {
      calls.push(`on:${name}`);
      handlers.set(name, handler);
    },
  };
}

function makeServices(calls) {
  return {
    createDesktopGate() {
      calls.push('create-gate');
      return { kind: 'gate' };
    },
    createOauth() {
      calls.push('create-oauth');
      return { kind: 'oauth' };
    },
    createCloudApi({ oauth }) {
      calls.push('create-cloud-api');
      assert.equal(oauth.kind, 'oauth');
      return { kind: 'cloud-api' };
    },
    createLocalStore({ gate }) {
      calls.push('create-local-store');
      assert.equal(gate.kind, 'gate');
      return { kind: 'local-store' };
    },
    registerIpc(dependencies) {
      calls.push('register-ipc');
      assert.equal(dependencies.cloudApi.kind, 'cloud-api');
      assert.equal(dependencies.localStore.kind, 'local-store');
    },
  };
}

test('a rejected second process quits before readiness, IPC, or credential initialization', async () => {
  const app = makeApp({ hasLock: false });
  const BrowserWindow = makeBrowserWindow();
  let loadServicesCalls = 0;

  const isPrimary = startApplication({
    app,
    BrowserWindow,
    loadServices() {
      loadServicesCalls += 1;
      return makeServices(app.calls);
    },
  });
  await Promise.resolve();

  assert.equal(isPrimary, false);
  assert.deepEqual(app.calls, ['request-lock', 'quit']);
  assert.equal(loadServicesCalls, 0);
  assert.equal(BrowserWindow.instances.length, 0);
});

test('the primary process acquires the lock before loading services and registering IPC', async () => {
  const app = makeApp();
  const BrowserWindow = makeBrowserWindow();
  const isPrimary = startApplication({
    app,
    BrowserWindow,
    loadServices() {
      app.calls.push('load-services');
      return makeServices(app.calls);
    },
  });
  await Promise.resolve();

  assert.equal(isPrimary, true);
  assert.equal(app.calls[0], 'request-lock');
  assert.ok(app.calls.indexOf('request-lock') < app.calls.indexOf('load-services'));
  assert.ok(app.calls.indexOf('load-services') < app.calls.indexOf('create-oauth'));
  assert.ok(app.calls.indexOf('create-oauth') < app.calls.indexOf('register-ipc'));
  assert.equal(BrowserWindow.instances.length, 1);
});

test('a second-instance event restores, reveals, and focuses the existing window', async () => {
  const app = makeApp();
  const BrowserWindow = makeBrowserWindow();
  startApplication({
    app,
    BrowserWindow,
    loadServices: () => makeServices(app.calls),
  });
  await Promise.resolve();

  const win = BrowserWindow.instances[0];
  win.minimized = true;
  win.visible = false;
  app.handlers.get('second-instance')();

  assert.equal(win.restoreCalls, 1);
  assert.equal(win.showCalls, 1);
  assert.equal(win.focusCalls, 1);
});

test('focusExistingWindow falls back to a live BrowserWindow', () => {
  const BrowserWindow = makeBrowserWindow();
  const live = new BrowserWindow({});
  const destroyed = new BrowserWindow({});
  destroyed.destroyed = true;

  assert.equal(focusExistingWindow(BrowserWindow, destroyed), true);
  assert.equal(live.focusCalls, 1);
});

test('createWindow permits only the packaged page as top-level navigation', () => {
  const BrowserWindow = makeBrowserWindow();
  const appPagePath = path.join('F:\\', 'Program Files', 'Routines Manager', 'index.html');
  const appPageUrl = pathToFileURL(appPagePath).href;
  const win = createWindow({ BrowserWindow, appPagePath });
  const navigate = win.webContentsHandlers.get('will-navigate');

  const samePageEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  navigate(samePageEvent, `${appPageUrl}?view=local#task-one`);
  assert.equal(samePageEvent.prevented, false);

  for (const target of ['https://example.com/', 'file:///C:/Windows/System32/drivers/etc/hosts', 'not a url']) {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    navigate(event, target);
    assert.equal(event.prevented, true, target);
  }
});

test('createWindow denies renderer-created windows', () => {
  const BrowserWindow = makeBrowserWindow();
  const win = createWindow({ BrowserWindow, appPagePath: path.join('F:\\', 'app', 'index.html') });

  assert.deepEqual(win.windowOpenHandler({ url: 'https://example.com/' }), { action: 'deny' });
  assert.deepEqual(win.windowOpenHandler({ url: pathToFileURL(win.loadedFile).href }), { action: 'deny' });
});

test('isAppPageUrl treats query and fragment changes as the same packaged page', () => {
  const appPageUrl = 'file:///F:/app/index.html';
  assert.equal(isAppPageUrl(`${appPageUrl}?mode=cloud#routine`, appPageUrl), true);
  assert.equal(isAppPageUrl('file:///F:/app/other.html', appPageUrl), false);
});
