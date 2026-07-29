'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { APP_PAGE_URL, isExpectedApplicationFrame, registerIpc } = require('../src/main/ipc');

function frameEvent(url = APP_PAGE_URL, { topLevel = true } = {}) {
  const frame = { url };
  frame.top = topLevel ? frame : { url: APP_PAGE_URL };
  return { senderFrame: frame };
}

function registeredHandlers({ listTasks, cloudApi } = {}) {
  const handlers = new Map();
  registerIpc({
    ipc: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    expectedAppUrl: APP_PAGE_URL,
    gate: { isDesktopRunning: async () => false },
    localStore: {
      listTasks:
        listTasks ??
        (async () => ({ registryPath: 'registry.json', tasks: [], orphans: [] })),
    },
    cloudApi:
      cloudApi ??
      {
        listTriggers: async () => ({ triggers: [], status: { complete: true } }),
        listEnvironments: async () => [],
      },
  });
  return handlers;
}

test('isExpectedApplicationFrame accepts only the top-level packaged application document', () => {
  assert.equal(isExpectedApplicationFrame(frameEvent()), true);
  assert.equal(isExpectedApplicationFrame(frameEvent(`${APP_PAGE_URL}#drawer`)), true);
  assert.equal(isExpectedApplicationFrame(frameEvent(`${APP_PAGE_URL}?view=cloud#drawer`)), true);
  assert.equal(isExpectedApplicationFrame(frameEvent('https://attacker.example/')), false);
  assert.equal(isExpectedApplicationFrame(frameEvent(APP_PAGE_URL, { topLevel: false })), false);
  assert.equal(isExpectedApplicationFrame({ senderFrame: null }), false);
});

test('every registered IPC handler rejects a non-application sender before invoking services', async () => {
  let calls = 0;
  const handlers = registeredHandlers({
    listTasks: async () => {
      calls++;
      return { registryPath: 'registry.json', tasks: [], orphans: [] };
    },
  });

  assert.ok(handlers.size > 0);
  for (const [channel, handler] of handlers) {
    const result = await handler(frameEvent('https://attacker.example/'), {});
    assert.deepEqual(result, {
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: 'IPC calls are only accepted from the packaged application page',
      },
    }, channel);
  }
  assert.equal(calls, 0);
});

test('a trusted application-frame IPC call reaches its handler', async () => {
  let calls = 0;
  const handler = registeredHandlers({
    listTasks: async () => {
      calls++;
      return { registryPath: 'registry.json', tasks: [], orphans: [] };
    },
  }).get('local:list');

  const result = await handler(frameEvent(), {});
  assert.equal(result.ok, true);
  assert.equal(result.data.registryPath, 'registry.json');
  assert.equal(calls, 1);
});

test('cloud:list preserves incomplete pagination status for a visible renderer warning', async () => {
  const status = {
    complete: false,
    reason: 'page-limit',
    warning: 'Cloud routines list is incomplete.',
    pagesFetched: 25,
  };
  const handler = registeredHandlers({
    cloudApi: {
      listTriggers: async () => ({ triggers: [], status }),
      listEnvironments: async () => [],
    },
  }).get('cloud:list');

  const result = await handler(frameEvent(), {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.status, status);
});
