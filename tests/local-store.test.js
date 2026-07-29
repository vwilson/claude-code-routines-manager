'use strict';

const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLocalStore } = require('../src/main/local-store');

/** A real pid guaranteed to no longer be running: spawnSync blocks until it has exited. */
function deadPid() {
  return spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
}

function writeClaimMarker(dir, pid) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.claim.json'), JSON.stringify({ pid, at: FIXED_NOW.toISOString() }));
}

const FIXED_NOW = new Date('2026-07-29T12:00:00Z');

let root;
let appDataDir;
let claudeDir;
let registryPath;
let gateState;

function makeStore() {
  return createLocalStore({
    appDataDir,
    claudeDir,
    gate: { isDesktopRunning: async () => gateState },
    now: () => FIXED_NOW,
  });
}

function writeRegistry(envelope, { account = 'acc-1', org = 'org-1' } = {}) {
  const dir = path.join(appDataDir, 'Claude', 'claude-code-sessions', account, org);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'scheduled-tasks.json');
  fs.writeFileSync(file, JSON.stringify(envelope, null, 2));
  return file;
}

function writeSkill(id, body = 'Prompt body.', description = 'A test task') {
  const dir = path.join(claudeDir, 'scheduled-tasks', id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, `---\nname: ${id}\ndescription: ${description}\n---\n\n${body}\n`);
  return file;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrm-test-'));
  appDataDir = path.join(root, 'appdata');
  claudeDir = path.join(root, '.claude');
  gateState = false;
  const skillPath = writeSkill('alpha');
  registryPath = writeRegistry({
    formatVersion: 99, // unknown envelope-level field that must survive
    scheduledTasks: [
      {
        id: 'alpha',
        cronExpression: '0 7 * * 1-5',
        enabled: true,
        filePath: skillPath,
        createdAt: 1785272373487,
        cwd: path.join(root, 'repo'),
        mysteryField: { nested: true }, // unknown task-level field that must survive
      },
    ],
    recordedSkips: { alpha: [{ at: '2026-07-01T12:00:00Z', reason: 'asleep' }] },
  });
});

test('listTasks reads the registry and joins SKILL.md metadata', async () => {
  const { registryPath: found, tasks, orphans } = await makeStore().listTasks();
  assert.equal(found, registryPath);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 'alpha');
  assert.equal(tasks[0].description, 'A test task');
  assert.equal(tasks[0].skillMissing, false);
  assert.equal(tasks[0].skips, 1);
  assert.equal(orphans.length, 0);
});

test('discovery picks the newest registry by mtime', async () => {
  const newer = writeRegistry({ scheduledTasks: [] }, { account: 'acc-2', org: 'org-2' });
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(registryPath, past, past);
  const { registryPath: found } = await makeStore().listTasks();
  assert.equal(found, newer);
});

test('unknown fields at every level survive a mutation', async () => {
  const before = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  await makeStore().updateTask('alpha', { enabled: false });
  const after = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const expected = structuredClone(before);
  expected.scheduledTasks[0].enabled = false;
  assert.deepEqual(after, expected);
});

test('backup is created exactly once across mutations', async () => {
  const store = makeStore();
  await store.updateTask('alpha', { enabled: false });
  await store.updateTask('alpha', { enabled: true });
  const backups = fs.readdirSync(path.dirname(registryPath)).filter((f) => f.includes('.bak-'));
  assert.equal(backups.length, 1);
});

test('writes are blocked while Claude Desktop runs, leaving the file untouched', async () => {
  gateState = true;
  const before = fs.readFileSync(registryPath, 'utf8');
  await assert.rejects(makeStore().updateTask('alpha', { enabled: false }), (err) => err.code === 'CLAUDE_RUNNING');
  assert.equal(fs.readFileSync(registryPath, 'utf8'), before);
});

test('detection failure also blocks writes (fail closed)', async () => {
  const store = createLocalStore({
    appDataDir,
    claudeDir,
    gate: {
      isDesktopRunning: async () => {
        const err = new Error('powershell timed out');
        err.code = 'GATE_UNKNOWN';
        throw err;
      },
    },
    now: () => FIXED_NOW,
  });
  await assert.rejects(store.updateTask('alpha', { enabled: false }), (err) => err.code === 'GATE_UNKNOWN');
});

test('invalid JSON surfaces as PARSE after retries', async () => {
  fs.writeFileSync(registryPath, '{ not json');
  await assert.rejects(makeStore().listTasks(), (err) => err.code === 'PARSE');
});

test('orphan scan lists unregistered prompt dirs only', async () => {
  writeSkill('orphan-one', 'Orphan prompt.', 'left behind');
  fs.mkdirSync(path.join(claudeDir, 'scheduled-tasks', 'not-a-prompt')); // no SKILL.md -> ignored
  const { orphans } = await makeStore().listTasks();
  assert.deepEqual(orphans.map((o) => o.id), ['orphan-one']);
  assert.equal(orphans[0].description, 'left behind');
});

test('updateTask rejects unknown ids with NOT_FOUND', async () => {
  await assert.rejects(makeStore().updateTask('nope', { enabled: false }), (err) => err.code === 'NOT_FOUND');
});

test('createTask writes SKILL.md and a registry entry', async () => {
  const store = makeStore();
  const entry = await store.createTask(
    { id: 'from-cloud', cronExpression: '0 9 * * 1-5', cwd: root, model: 'claude-opus-5', displayName: 'From Cloud', enabled: false },
    { description: 'Moved from cloud', body: 'Cloud prompt body.' },
  );
  assert.equal(entry.createdAt, FIXED_NOW.getTime());
  const envelope = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const task = envelope.scheduledTasks.find((t) => t.id === 'from-cloud');
  assert.equal(task.enabled, false);
  assert.equal(task.model, 'claude-opus-5');
  const skill = fs.readFileSync(task.filePath, 'utf8');
  assert.match(skill, /description: Moved from cloud/);
  assert.match(skill, /Cloud prompt body\./);
});

test('createTask leaves no marker temp file behind after a normal claim', async () => {
  // writeMarkerFile() publishes via write-to-temp-then-link rather than a direct
  // {flag:'wx'} write, specifically so the final marker name never becomes visible
  // before its content is complete. The temp file must not survive either way.
  const store = makeStore();
  await store.createTask({ id: 'temp-cleanup', cronExpression: '0 9 * * *', enabled: false }, { description: '', body: 'x' });
  const dir = path.join(claudeDir, 'scheduled-tasks', 'temp-cleanup');
  assert.deepEqual(fs.readdirSync(dir), ['SKILL.md']);
});

test('createTask rejects invalid and duplicate ids', async () => {
  const store = makeStore();
  await assert.rejects(
    store.createTask({ id: 'Bad Id!', cronExpression: '0 9 * * *', enabled: false }, { description: '', body: 'x' }),
    (err) => err.code === 'VALIDATION',
  );
  await assert.rejects(
    store.createTask({ id: 'alpha', cronExpression: '0 9 * * *', enabled: false }, { description: '', body: 'x' }),
    (err) => err.code === 'VALIDATION',
  );
});

test('createTask refuses to overwrite an existing orphaned SKILL.md', async () => {
  const orphanPath = writeSkill('collision', 'Orphan prompt — do not touch.', 'left behind');
  const before = fs.readFileSync(orphanPath, 'utf8');
  const store = makeStore();
  await assert.rejects(
    store.createTask(
      { id: 'collision', cronExpression: '0 9 * * 1-5', enabled: false },
      { description: 'Moved from cloud', body: 'Cloud prompt body.' },
    ),
    (err) => err.code === 'VALIDATION',
  );
  assert.equal(fs.readFileSync(orphanPath, 'utf8'), before);
  const envelope = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.ok(!envelope.scheduledTasks.some((t) => t.id === 'collision'));
});

test('createTask reclaims a dir whose claim marker names a confirmed-dead process', async () => {
  const dir = path.join(claudeDir, 'scheduled-tasks', 'crashed-claim');
  writeClaimMarker(dir, deadPid());
  // A leftover temp file from an atomicWriteFile() that never got to rename — the
  // process could have been killed mid-write, right after writing its claim marker.
  fs.writeFileSync(path.join(dir, `.SKILL.md.tmp-${deadPid()}-0`), 'partial');
  const store = makeStore();
  const entry = await store.createTask(
    { id: 'crashed-claim', cronExpression: '0 9 * * *', enabled: false },
    { description: 'recovered', body: 'recovered body' },
  );
  const skill = fs.readFileSync(entry.filePath, 'utf8');
  assert.match(skill, /description: recovered/);
  assert.match(skill, /recovered body/);
  // Every leftover from the dead claim — marker and temp file alike — must be gone.
  assert.deepEqual(fs.readdirSync(dir), ['SKILL.md']);
});

test('createTask refuses a dir whose claim marker names a still-running process', async () => {
  const dir = path.join(claudeDir, 'scheduled-tasks', 'live-claim');
  // process.pid (this test process) is guaranteed alive for the duration of the test.
  writeClaimMarker(dir, process.pid);
  const store = makeStore();
  await assert.rejects(
    store.createTask({ id: 'live-claim', cronExpression: '0 9 * * *', enabled: false }, { description: '', body: 'x' }),
    (err) => err.code === 'VALIDATION',
  );
  // The other (still-running, as far as we can tell) claim must not be touched.
  assert.ok(fs.existsSync(path.join(dir, '.claim.json')));
});

test('createTask refuses a dir with unrelated content and no claim marker', async () => {
  const dir = path.join(claudeDir, 'scheduled-tasks', 'unrelated');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a routine at all');
  const store = makeStore();
  await assert.rejects(
    store.createTask({ id: 'unrelated', cronExpression: '0 9 * * *', enabled: false }, { description: '', body: 'x' }),
    (err) => err.code === 'VALIDATION',
  );
  // No verifiable claim marker means it's never ours to reclaim, no matter what's in it.
  assert.deepEqual(fs.readdirSync(dir), ['notes.txt']);
});

test('createTask reclaims a dir interrupted before the marker was ever published', async () => {
  // The process was killed after writeFileSync'ing the marker's private temp file but
  // before link() published .claim.json itself — so no marker, orphan, or registered
  // task exists here at all, just this one recognizable leftover.
  const dir = path.join(claudeDir, 'scheduled-tasks', 'pre-publish-crash');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `.claim.json.tmp-${deadPid()}-0`), JSON.stringify({ pid: 111 }));
  const store = makeStore();
  const entry = await store.createTask(
    { id: 'pre-publish-crash', cronExpression: '0 9 * * *', enabled: false },
    { description: 'recovered', body: 'recovered body' },
  );
  assert.match(fs.readFileSync(entry.filePath, 'utf8'), /description: recovered/);
  assert.deepEqual(fs.readdirSync(dir), ['SKILL.md']);
});

test('createTask refuses to reclaim a marker left corrupt by an interrupted write', async () => {
  // With atomic publish (write-to-temp-then-link), a fully linked marker can only ever
  // contain complete, valid JSON — an unparseable .claim.json can't be proven dead, so
  // it must fail closed rather than being treated as free to steal.
  const dir = path.join(claudeDir, 'scheduled-tasks', 'corrupt-marker');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.claim.json'), '{"pid": 123, "at": "20'); // truncated
  const store = makeStore();
  await assert.rejects(
    store.createTask({ id: 'corrupt-marker', cronExpression: '0 9 * * *', enabled: false }, { description: '', body: 'x' }),
    (err) => err.code === 'VALIDATION',
  );
  assert.ok(fs.existsSync(path.join(dir, '.claim.json')));
});

test('createTask retries a transiently unreadable marker before deciding', async () => {
  const dir = path.join(claudeDir, 'scheduled-tasks', 'transient-read-failure');
  writeClaimMarker(dir, deadPid());
  const markerPath = path.join(dir, '.claim.json');
  const originalReadFileSync = fs.readFileSync;
  let calls = 0;
  fs.readFileSync = (p, ...rest) => {
    if (p === markerPath) {
      calls++;
      if (calls <= 2) {
        const err = new Error('EBUSY: resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      }
    }
    return originalReadFileSync(p, ...rest);
  };
  try {
    const store = makeStore();
    const entry = await store.createTask(
      { id: 'transient-read-failure', cronExpression: '0 9 * * *', enabled: false },
      { description: 'recovered', body: 'recovered body' },
    );
    assert.match(fs.readFileSync(entry.filePath, 'utf8'), /description: recovered/);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.ok(calls >= 3);
});

test('createTask fails closed when a marker stays unreadable after retries', async () => {
  const dir = path.join(claudeDir, 'scheduled-tasks', 'persistent-read-failure');
  writeClaimMarker(dir, deadPid());
  const markerPath = path.join(dir, '.claim.json');
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => {
    if (p === markerPath) {
      const err = new Error('EBUSY: resource busy or locked');
      err.code = 'EBUSY';
      throw err;
    }
    return originalReadFileSync(p, ...rest);
  };
  try {
    const store = makeStore();
    await assert.rejects(
      store.createTask({ id: 'persistent-read-failure', cronExpression: '0 9 * * *', enabled: false }, { description: '', body: 'x' }),
      (err) => err.code === 'VALIDATION',
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.ok(fs.existsSync(markerPath));
});

test("createTask preserves another process's in-flight marker temp file discovered during cleanup", async () => {
  // Simulates a second process that wrote its own private temp file (about to link()
  // it as .claim.json) in the instant between our own claim succeeding and our
  // cleanup scan — its temp file embeds its own (very much alive) pid.
  const dir = path.join(claudeDir, 'scheduled-tasks', 'concurrent-temp-file');
  const foreignTemp = `.claim.json.tmp-${process.pid}-999`;
  const store = makeStore();
  const originalReaddirSync = fs.readdirSync;
  let injected = false;
  fs.readdirSync = (...args) => {
    const result = originalReaddirSync(...args);
    if (!injected && args[0] === dir && result.includes('.claim.json')) {
      injected = true;
      fs.writeFileSync(path.join(dir, foreignTemp), JSON.stringify({ pid: process.pid }));
    }
    return originalReaddirSync(...args);
  };
  try {
    await store.createTask(
      { id: 'concurrent-temp-file', cronExpression: '0 9 * * *', enabled: false },
      { description: 'ok', body: 'ok body' },
    );
  } finally {
    fs.readdirSync = originalReaddirSync;
  }
  assert.ok(fs.existsSync(path.join(dir, foreignTemp)));
});

test('createTask preserves a SKILL.md published moments after a dead-marker takeover', async () => {
  // Simulates the original (dead) process finishing its publish in the instant between
  // our own takeover succeeding and our re-check just before the cleanup loop.
  const dir = path.join(claudeDir, 'scheduled-tasks', 'late-publish');
  const filePath = path.join(dir, 'SKILL.md');
  writeClaimMarker(dir, deadPid());
  const store = makeStore();
  const originalExistsSync = fs.existsSync;
  let calls = 0;
  fs.existsSync = (p) => {
    if (p === filePath) {
      calls++;
      if (calls === 2) {
        fs.writeFileSync(filePath, '---\nname: late-publish\ndescription: from the other process\n---\n\noriginal content\n');
      }
    }
    return originalExistsSync(p);
  };
  try {
    await assert.rejects(
      store.createTask({ id: 'late-publish', cronExpression: '0 9 * * *', enabled: false }, { description: '', body: 'x' }),
      (err) => err.code === 'VALIDATION',
    );
  } finally {
    fs.existsSync = originalExistsSync;
  }
  assert.match(fs.readFileSync(filePath, 'utf8'), /from the other process/);
  // No stray marker should be left pointing at content that's now legitimately published.
  assert.equal(fs.existsSync(path.join(dir, '.claim.json')), false);
});

test('createTask removes the claimed dir if the SKILL.md write itself never lands', async () => {
  const store = makeStore();
  const originalOpenSync = fs.openSync;
  fs.openSync = () => {
    throw new Error('simulated disk failure');
  };
  try {
    await assert.rejects(
      store.createTask({ id: 'write-fails', cronExpression: '0 9 * * *', enabled: false }, { description: '', body: 'x' }),
      /simulated disk failure/,
    );
  } finally {
    fs.openSync = originalOpenSync;
  }
  // Nothing was ever published, so the claim is safely undone: the id is retryable
  // and there's no stray empty dir left over.
  assert.equal(fs.existsSync(path.join(claudeDir, 'scheduled-tasks', 'write-fails')), false);
});

test('createTask leaves a published SKILL.md as a recoverable orphan when the registry write fails afterward', async () => {
  let gateCalls = 0;
  const store = createLocalStore({
    appDataDir,
    claudeDir,
    // false for createTask's own upfront check, true for mutateRegistry's — simulates
    // Claude Desktop starting up in the gap between the two gate checks, i.e. after
    // SKILL.md has already been durably written.
    gate: { isDesktopRunning: async () => (gateCalls += 1) > 1 },
    now: () => FIXED_NOW,
  });
  await assert.rejects(
    store.createTask(
      { id: 'orphaned-by-failure', cronExpression: '0 9 * * *', enabled: false },
      { description: 'desc', body: 'body text' },
    ),
    (err) => err.code === 'CLAUDE_RUNNING',
  );
  // The prompt itself must survive — deleting it here would race against another
  // process that might import this exact orphan in the same window. It's not
  // registered, but it IS visible and recoverable through the orphan-import flow.
  const filePath = path.join(claudeDir, 'scheduled-tasks', 'orphaned-by-failure', 'SKILL.md');
  assert.ok(fs.existsSync(filePath));
  const envelope = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.ok(!envelope.scheduledTasks.some((t) => t.id === 'orphaned-by-failure'));
  const { orphans } = await store.listTasks();
  assert.ok(orphans.some((o) => o.id === 'orphaned-by-failure'));
});

test('createTask does not delete a dir another process registered in the same race window', async () => {
  let gateCalls = 0;
  const store = createLocalStore({
    appDataDir,
    claudeDir,
    gate: {
      isDesktopRunning: async () => {
        gateCalls += 1;
        if (gateCalls === 2) {
          // Simulate a second process importing this exact orphan (same id, same
          // filePath) between our SKILL.md write and our own registry mutation.
          const envelope = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
          envelope.scheduledTasks.push({
            id: 'raced',
            enabled: true,
            filePath: path.join(claudeDir, 'scheduled-tasks', 'raced', 'SKILL.md'),
            createdAt: FIXED_NOW.getTime(),
          });
          fs.writeFileSync(registryPath, JSON.stringify(envelope, null, 2));
        }
        return false;
      },
    },
    now: () => FIXED_NOW,
  });
  await assert.rejects(
    store.createTask({ id: 'raced', cronExpression: '0 9 * * *', enabled: false }, { description: '', body: 'x' }),
    (err) => err.code === 'VALIDATION',
  );
  // The competing process's registration must survive — its SKILL.md must not be deleted.
  assert.ok(fs.existsSync(path.join(claudeDir, 'scheduled-tasks', 'raced', 'SKILL.md')));
});

test('listPromptDirIds includes both registered and orphaned prompt dirs', async () => {
  writeSkill('orphan-one');
  const store = makeStore();
  assert.deepEqual(new Set(store.listPromptDirIds()), new Set(['alpha', 'orphan-one']));
});

test('importOrphan registers an existing prompt dir', async () => {
  writeSkill('orphan-one');
  await makeStore().importOrphan({ id: 'orphan-one', cronExpression: '0 8 * * *', cwd: root, enabled: true });
  const envelope = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const task = envelope.scheduledTasks.find((t) => t.id === 'orphan-one');
  assert.equal(task.enabled, true);
  assert.equal(task.filePath, path.join(claudeDir, 'scheduled-tasks', 'orphan-one', 'SKILL.md'));
});

test('importOrphan requires an existing SKILL.md', async () => {
  await assert.rejects(
    makeStore().importOrphan({ id: 'ghost', cronExpression: '0 8 * * *', enabled: false }),
    (err) => err.code === 'NOT_FOUND',
  );
});

test('setPromptBody replaces the body but keeps frontmatter', async () => {
  const store = makeStore();
  await store.setPromptBody('alpha', 'New body.');
  const { promptBody, frontmatter } = await store.getTask('alpha');
  assert.equal(promptBody, 'New body.\n');
  assert.equal(frontmatter.description, 'A test task');
});
