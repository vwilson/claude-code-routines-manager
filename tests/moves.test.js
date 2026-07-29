'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { previewCloudToLocal } = require('../src/main/moves');

function fakeLocalStore({ tasks = [], promptDirIds = [] } = {}) {
  return {
    readTasksRaw: async () => tasks,
    listPromptDirIds: () => promptDirIds,
  };
}

function fakeTriggerVM(overrides = {}) {
  return {
    name: 'My Routine',
    cronExpression: undefined,
    model: 'claude-sonnet-5',
    prompt: 'do the thing',
    runOnceAt: undefined,
    repoUrl: undefined,
    mcpConnections: [],
    endedReason: undefined,
    ...overrides,
  };
}

test('previewCloudToLocal suggests the plain slug when nothing collides', async () => {
  const preview = await previewCloudToLocal('trigger-1', {
    localStore: fakeLocalStore(),
    freshTriggerVM: async () => fakeTriggerVM({ name: 'Fresh Routine' }),
  });
  assert.equal(preview.suggestedId, 'fresh-routine');
});

test('previewCloudToLocal dodges ids already used by orphaned prompt dirs, not just registered tasks', async () => {
  // "my-routine" has no registry entry (it's an orphan) but its dir exists on disk;
  // the suggestion must still skip it, or moving here would overwrite the orphan.
  const preview = await previewCloudToLocal('trigger-1', {
    localStore: fakeLocalStore({ tasks: [], promptDirIds: ['my-routine'] }),
    freshTriggerVM: async () => fakeTriggerVM({ name: 'My Routine' }),
  });
  assert.equal(preview.suggestedId, 'my-routine-2');
});

test('previewCloudToLocal considers registered tasks and orphan dirs together', async () => {
  const preview = await previewCloudToLocal('trigger-1', {
    localStore: fakeLocalStore({ tasks: [{ id: 'my-routine' }], promptDirIds: ['my-routine', 'my-routine-2'] }),
    freshTriggerVM: async () => fakeTriggerVM({ name: 'My Routine' }),
  });
  assert.equal(preview.suggestedId, 'my-routine-3');
});

test('previewCloudToLocal dodges an orphan dir whose on-disk casing differs from the lowercase slug', async () => {
  // On Windows' default case-insensitive filesystem, "My-Routine" and "my-routine" name
  // the same directory — claimPromptDir('my-routine') would hit that dir's EEXIST even
  // though a case-sensitive comparison wouldn't have flagged it as taken.
  const preview = await previewCloudToLocal('trigger-1', {
    localStore: fakeLocalStore({ tasks: [], promptDirIds: ['My-Routine'] }),
    freshTriggerVM: async () => fakeTriggerVM({ name: 'My Routine' }),
  });
  assert.equal(preview.suggestedId, 'my-routine-2');
});

test('previewCloudToLocal rejects moving an already-fired one-shot routine', async () => {
  await assert.rejects(
    previewCloudToLocal('trigger-1', {
      localStore: fakeLocalStore(),
      freshTriggerVM: async () => fakeTriggerVM({ endedReason: 'run_once_fired' }),
    }),
    (err) => err.code === 'VALIDATION',
  );
});
