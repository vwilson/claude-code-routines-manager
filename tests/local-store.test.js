'use strict';

const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLocalStore } = require('../src/main/local-store');

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

test('duplicateTask copies the prompt and inherits unknown fields', async () => {
  const store = makeStore();
  const entry = await store.duplicateTask('alpha', {
    id: 'alpha-copy',
    cronExpression: '0 9 * * 1',
    displayName: 'Alpha (copy)',
    enabled: false,
  });
  assert.equal(entry.cronExpression, '0 9 * * 1');
  assert.equal(entry.enabled, false);
  assert.equal(entry.createdAt, FIXED_NOW.getTime());
  assert.deepEqual(entry.mysteryField, { nested: true }); // inherited from the source
  assert.equal(entry.cwd, path.join(root, 'repo')); // inherited when the spec omits it

  const envelope = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.deepEqual(envelope.scheduledTasks.map((t) => t.id), ['alpha', 'alpha-copy']);
  const copy = envelope.scheduledTasks[1];
  assert.equal(copy.filePath, path.join(claudeDir, 'scheduled-tasks', 'alpha-copy', 'SKILL.md'));
  const skill = fs.readFileSync(copy.filePath, 'utf8');
  assert.match(skill, /name: alpha-copy/);
  assert.match(skill, /description: A test task/);
  assert.match(skill, /Prompt body\./);
  // the source is untouched
  assert.deepEqual(envelope.scheduledTasks[0], JSON.parse(fs.readFileSync(`${registryPath}.bak-20260729-120000`, 'utf8')).scheduledTasks[0]);
});

test('duplicateTask drops run state and the schedule the copy does not use', async () => {
  const envelope = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  envelope.scheduledTasks[0].lastRunAt = 1785272373487;
  envelope.scheduledTasks[0].lastScheduledFor = 1785272373487;
  fs.writeFileSync(registryPath, JSON.stringify(envelope, null, 2));
  const entry = await makeStore().duplicateTask('alpha', {
    id: 'alpha-once',
    fireAt: '2026-08-01T10:00:00.000Z',
    enabled: true,
  });
  assert.equal(entry.lastRunAt, undefined);
  assert.equal(entry.lastScheduledFor, undefined);
  assert.equal(entry.cronExpression, undefined);
  assert.equal(entry.fireAt, '2026-08-01T10:00:00.000Z');
  assert.equal(entry.displayName, undefined);
});

test('duplicateTask overrides cwd, model and display name when given', async () => {
  const entry = await makeStore().duplicateTask('alpha', {
    id: 'alpha-copy',
    cronExpression: '0 9 * * 1',
    cwd: root,
    model: 'claude-opus-5',
    displayName: 'Renamed',
    enabled: false,
  });
  assert.equal(entry.cwd, root);
  assert.equal(entry.model, 'claude-opus-5');
  assert.equal(entry.displayName, 'Renamed');
});

test('duplicateTask refuses unknown sources, taken ids and existing prompt dirs', async () => {
  const store = makeStore();
  const spec = { id: 'alpha-copy', cronExpression: '0 9 * * 1', enabled: false };
  await assert.rejects(store.duplicateTask('nope', spec), (err) => err.code === 'NOT_FOUND');
  await assert.rejects(store.duplicateTask('alpha', { ...spec, id: 'alpha' }), (err) => err.code === 'VALIDATION');
  await assert.rejects(store.duplicateTask('alpha', { ...spec, id: 'Bad Id!' }), (err) => err.code === 'VALIDATION');
  writeSkill('alpha-copy');
  await assert.rejects(store.duplicateTask('alpha', spec), (err) => err.code === 'VALIDATION');
});

test('duplicateTask refuses a source whose prompt cannot be read', async () => {
  fs.rmSync(path.join(claudeDir, 'scheduled-tasks', 'alpha'), { recursive: true, force: true });
  const before = fs.readFileSync(registryPath, 'utf8');
  await assert.rejects(
    makeStore().duplicateTask('alpha', { id: 'alpha-copy', cronExpression: '0 9 * * 1', enabled: false }),
    (err) => err.code === 'NOT_FOUND' && /nothing to copy/.test(err.message),
  );
  assert.equal(fs.readFileSync(registryPath, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(claudeDir, 'scheduled-tasks', 'alpha-copy')), false);
});

test('duplicateTask never deletes a prompt another writer owns', async () => {
  // Stand in for a second app instance winning the race: the id is taken in the registry
  // by the time we try to write, but the prompt on disk belongs to that winner.
  const store = createLocalStore({
    appDataDir,
    claudeDir,
    gate: { isDesktopRunning: async () => false },
    now: () => FIXED_NOW,
  });
  const winnerSkill = writeSkill('alpha-copy', 'Winner body.');
  await assert.rejects(
    store.duplicateTask('alpha', { id: 'alpha-copy', cronExpression: '0 9 * * 1', enabled: false }),
    (err) => err.code === 'VALIDATION',
  );
  assert.match(fs.readFileSync(winnerSkill, 'utf8'), /Winner body\./);
});

test('duplicateTask is blocked while Claude Desktop runs, writing nothing', async () => {
  gateState = true;
  const before = fs.readFileSync(registryPath, 'utf8');
  await assert.rejects(
    makeStore().duplicateTask('alpha', { id: 'alpha-copy', cronExpression: '0 9 * * 1', enabled: false }),
    (err) => err.code === 'CLAUDE_RUNNING',
  );
  assert.equal(fs.readFileSync(registryPath, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(claudeDir, 'scheduled-tasks', 'alpha-copy')), false);
});

test('duplicateTask removes the new prompt dir if the registry write fails', async () => {
  let calls = 0;
  const store = createLocalStore({
    appDataDir,
    claudeDir,
    gate: { isDesktopRunning: async () => calls++ > 0 }, // desktop launches mid-duplicate
    now: () => FIXED_NOW,
  });
  await assert.rejects(
    store.duplicateTask('alpha', { id: 'alpha-copy', cronExpression: '0 9 * * 1', enabled: false }),
    (err) => err.code === 'CLAUDE_RUNNING',
  );
  assert.equal(fs.existsSync(path.join(claudeDir, 'scheduled-tasks', 'alpha-copy')), false);
});
