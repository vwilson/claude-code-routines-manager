'use strict';

// Owns every byte read or written for local scheduled tasks:
//  - the registry: %APPDATA%\Claude\claude-code-sessions\<account>\<org>\scheduled-tasks.json
//  - the prompts:  ~\.claude\scheduled-tasks\<id>\SKILL.md
//
// The Claude desktop app loads the registry only at startup and rewrites it wholesale,
// so every registry mutation goes through mutateRegistry(): fresh desktop-not-running
// gate check, fresh read (unknown fields survive untouched), one-time backup, atomic
// write. Changes still only take effect after the desktop app restarts.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppError } = require('./errors');
const { atomicWriteFile, readJsonWithRetry } = require('./fsx');
const translate = require('./translate');

const PATCHABLE_FIELDS = ['displayName', 'cronExpression', 'model', 'cwd', 'enabled'];

function createLocalStore({
  appDataDir = process.env.APPDATA,
  claudeDir = path.join(os.homedir(), '.claude'),
  gate,
  now = () => new Date(),
} = {}) {
  const sessionsDir = path.join(appDataDir, 'Claude', 'claude-code-sessions');
  const skillsDir = path.join(claudeDir, 'scheduled-tasks');
  const backedUp = new Set();

  /** Newest scheduled-tasks.json under claude-code-sessions\*\*, or null. */
  function discoverRegistry() {
    let newest = null;
    for (const accountDir of listSubdirs(sessionsDir)) {
      for (const orgDir of listSubdirs(accountDir)) {
        const file = path.join(orgDir, 'scheduled-tasks.json');
        let stat;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { file, mtimeMs: stat.mtimeMs };
      }
    }
    return newest?.file ?? null;
  }

  function listSubdirs(dir) {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(dir, entry.name));
    } catch {
      return [];
    }
  }

  function requireRegistry() {
    const registryPath = discoverRegistry();
    if (!registryPath) {
      throw new AppError('NOT_FOUND', `no scheduled-tasks.json found under ${sessionsDir} — has Claude Desktop ever run here?`);
    }
    return registryPath;
  }

  async function readEnvelope(registryPath) {
    const envelope = await readJsonWithRetry(registryPath);
    if (!Array.isArray(envelope.scheduledTasks)) envelope.scheduledTasks = [];
    return envelope;
  }

  /** Raw registry tasks (for suggestions and move flows), never mutated. */
  async function readTasksRaw() {
    const registryPath = discoverRegistry();
    if (!registryPath) return [];
    return (await readEnvelope(registryPath)).scheduledTasks;
  }

  function readSkill(filePath) {
    try {
      return translate.parseSkillMd(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  function readSkillMeta(filePath) {
    const skill = readSkill(filePath);
    return { description: skill?.frontmatter.description, skillMissing: skill === null };
  }

  async function listTasks() {
    const registryPath = discoverRegistry();
    const envelope = registryPath ? await readEnvelope(registryPath) : { scheduledTasks: [] };
    const tasks = envelope.scheduledTasks;
    const at = now();
    const vms = tasks.map((task) => {
      const { description, skillMissing } = readSkillMeta(task.filePath);
      const skips = envelope.recordedSkips?.[task.id]?.length ?? 0;
      return translate.localTaskToVM(task, { description, skillMissing, skips, now: at });
    });
    return { registryPath, tasks: vms, orphans: scanOrphans(tasks) };
  }

  /** Prompt dirs under ~\.claude\scheduled-tasks that no registry task references. */
  function scanOrphans(tasks) {
    const claimedIds = new Set(tasks.map((t) => t.id));
    const claimedDirs = new Set(tasks.map((t) => path.resolve(path.dirname(String(t.filePath ?? '')))));
    const orphans = [];
    for (const dir of listSubdirs(skillsDir)) {
      const id = path.basename(dir);
      if (claimedIds.has(id) || claimedDirs.has(path.resolve(dir))) continue;
      const skillPath = path.join(dir, 'SKILL.md');
      let stat;
      try {
        stat = fs.statSync(skillPath);
      } catch {
        continue; // not a prompt dir
      }
      const { frontmatter } = readSkill(skillPath) ?? { frontmatter: {} };
      orphans.push({
        id,
        name: frontmatter.name,
        description: frontmatter.description,
        mtime: stat.mtime.toISOString(),
      });
    }
    return orphans.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  }

  async function getTask(id) {
    const tasks = await readTasksRaw();
    const task = tasks.find((t) => t.id === id);
    if (!task) throw new AppError('NOT_FOUND', `no local task "${id}"`);
    const skill = readSkill(task.filePath);
    return {
      task: translate.localTaskToVM(task, {
        description: skill?.frontmatter.description,
        skillMissing: skill === null,
        skips: 0,
        now: now(),
      }),
      promptBody: skill?.body ?? '',
      frontmatter: skill?.frontmatter ?? { name: undefined, description: undefined },
    };
  }

  /**
   * The single registry write path. `mutator` receives the freshly-parsed envelope
   * and mutates it in place; everything it does not touch round-trips byte-for-byte
   * (modulo JSON formatting).
   */
  async function mutateRegistry(mutator) {
    if (await gate.isDesktopRunning({ fresh: true })) {
      throw new AppError('CLAUDE_RUNNING', 'Claude Desktop is running — local registry changes would be lost. Close it (including the tray icon) first.');
    }
    const registryPath = requireRegistry();
    const envelope = await readEnvelope(registryPath);
    mutator(envelope);
    if (!backedUp.has(registryPath)) {
      const stamp = now().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
      fs.copyFileSync(registryPath, `${registryPath}.bak-${stamp}`);
      backedUp.add(registryPath);
    }
    await atomicWriteFile(registryPath, JSON.stringify(envelope, null, 2));
  }

  async function updateTask(id, patch) {
    let updated;
    await mutateRegistry((envelope) => {
      const task = envelope.scheduledTasks.find((t) => t.id === id);
      if (!task) throw new AppError('NOT_FOUND', `no local task "${id}" in the registry (it may have changed externally)`);
      for (const key of PATCHABLE_FIELDS) {
        if (patch[key] !== undefined) task[key] = patch[key];
      }
      updated = task;
    });
    return updated;
  }

  /** Replace the prompt body, preserving existing frontmatter. Ungated: the desktop reads SKILL.md at fire time. */
  async function setPromptBody(id, promptBody) {
    const tasks = await readTasksRaw();
    const task = tasks.find((t) => t.id === id);
    if (!task) throw new AppError('NOT_FOUND', `no local task "${id}"`);
    const existing = readSkill(task.filePath);
    const content = translate.buildSkillMd({
      name: existing?.frontmatter.name ?? id,
      description: existing?.frontmatter.description ?? '',
      body: promptBody,
    });
    fs.mkdirSync(path.dirname(task.filePath), { recursive: true });
    await atomicWriteFile(task.filePath, content);
  }

  function assertNewTaskId(id, tasks) {
    if (!translate.LOCAL_ID_RE.test(id)) {
      throw new AppError('VALIDATION', `task id "${id}" must match ${translate.LOCAL_ID_RE} or Claude Desktop will drop it`);
    }
    if (tasks.some((t) => t.id === id)) {
      throw new AppError('VALIDATION', `a local task with id "${id}" already exists`);
    }
  }

  function registryEntry({ id, cronExpression, fireAt, cwd, model, displayName, enabled }, filePath) {
    const entry = { id, enabled: Boolean(enabled), filePath, createdAt: now().getTime() };
    if (cronExpression) entry.cronExpression = cronExpression;
    if (fireAt) entry.fireAt = translate.toIso(fireAt);
    if (cwd) entry.cwd = cwd;
    if (model) entry.model = model;
    if (displayName) entry.displayName = displayName;
    return entry;
  }

  /** Create a brand-new local task: SKILL.md + registry entry (both gated up front). */
  async function createTask(spec, { description, body }) {
    if (await gate.isDesktopRunning({ fresh: true })) {
      throw new AppError('CLAUDE_RUNNING', 'Claude Desktop is running — close it before creating local tasks.');
    }
    assertNewTaskId(spec.id, await readTasksRaw());
    const skillDir = path.join(skillsDir, spec.id);
    const filePath = path.join(skillDir, 'SKILL.md');
    fs.mkdirSync(skillDir, { recursive: true });
    await atomicWriteFile(filePath, translate.buildSkillMd({ name: spec.id, description, body }));
    const entry = registryEntry(spec, filePath);
    await mutateRegistry((envelope) => {
      assertNewTaskId(spec.id, envelope.scheduledTasks);
      envelope.scheduledTasks.push(entry);
    });
    return entry;
  }

  /**
   * Rename a task's id: moves ~\.claude\scheduled-tasks\<id> to the new id (carrying
   * SKILL.md and anything else in the dir along with it), then updates the registry
   * entry's id and filePath. Rolls the directory move back if the registry write fails.
   */
  async function renameTask(oldId, newId) {
    if (await gate.isDesktopRunning({ fresh: true })) {
      throw new AppError('CLAUDE_RUNNING', 'Claude Desktop is running — close it before renaming local tasks.');
    }
    const tasks = await readTasksRaw();
    const task = tasks.find((t) => t.id === oldId);
    if (!task) throw new AppError('NOT_FOUND', `no local task "${oldId}"`);
    if (newId === oldId) return { id: task.id, filePath: task.filePath };
    assertNewTaskId(newId, tasks);

    const oldDir = path.dirname(task.filePath);
    if (!fs.existsSync(task.filePath)) {
      throw new AppError('NOT_FOUND', `no SKILL.md at ${task.filePath}`);
    }
    const newDir = path.join(skillsDir, newId);
    if (fs.existsSync(newDir)) {
      throw new AppError('VALIDATION', `"${newDir}" already exists`);
    }
    const newFilePath = path.join(newDir, path.basename(task.filePath));

    fs.renameSync(oldDir, newDir);
    let originalContent;
    let contentRewritten = false;
    try {
      originalContent = fs.readFileSync(newFilePath, 'utf8');
      const renamed = translate.renameSkillName(originalContent, newId);
      if (renamed !== originalContent) {
        await atomicWriteFile(newFilePath, renamed);
        contentRewritten = true;
      }

      await mutateRegistry((envelope) => {
        const entry = envelope.scheduledTasks.find((t) => t.id === oldId);
        if (!entry) throw new AppError('NOT_FOUND', `no local task "${oldId}" in the registry (it may have changed externally)`);
        // Re-check against the freshly-read envelope: the earlier snapshot could be stale.
        assertNewTaskId(newId, envelope.scheduledTasks);
        entry.id = newId;
        entry.filePath = newFilePath;
        if (envelope.recordedSkips && Object.prototype.hasOwnProperty.call(envelope.recordedSkips, oldId)) {
          envelope.recordedSkips[newId] = envelope.recordedSkips[oldId];
          delete envelope.recordedSkips[oldId];
        }
      });
    } catch (err) {
      if (contentRewritten) {
        try {
          await atomicWriteFile(newFilePath, originalContent);
        } catch {
          // best effort — the directory rollback below still leaves a consistent (if renamed) prompt
        }
      }
      fs.renameSync(newDir, oldDir);
      throw err;
    }
    return { id: newId, filePath: newFilePath };
  }

  /**
   * Combined drawer save: rename (if `newId` differs), then write the prompt body
   * and/or patch fields. If a later step fails after the rename already landed, the
   * rename is rolled back (renameTask is symmetric) so the caller keeps addressing a
   * task that still exists under its original id, instead of one now-missing on both sides.
   */
  async function applyUpdate(id, { newId, patch, promptBody } = {}) {
    const willRename = newId !== undefined && newId !== id;
    if (willRename) await renameTask(id, newId);
    const currentId = willRename ? newId : id;
    try {
      if (promptBody !== undefined) await setPromptBody(currentId, promptBody);
      if (patch && Object.keys(patch).length > 0) await updateTask(currentId, patch);
    } catch (err) {
      if (willRename) await renameTask(currentId, id).catch(() => {});
      throw err;
    }
    return getTask(currentId);
  }

  /** Re-register an orphaned prompt dir as a scheduled task (SKILL.md must already exist). */
  async function importOrphan(spec) {
    const filePath = path.join(skillsDir, spec.id, 'SKILL.md');
    if (!fs.existsSync(filePath)) {
      throw new AppError('NOT_FOUND', `no SKILL.md at ${filePath}`);
    }
    const entry = registryEntry(spec, filePath);
    await mutateRegistry((envelope) => {
      assertNewTaskId(spec.id, envelope.scheduledTasks);
      envelope.scheduledTasks.push(entry);
    });
    return entry;
  }

  return {
    listTasks,
    getTask,
    readTasksRaw,
    updateTask,
    setPromptBody,
    createTask,
    renameTask,
    applyUpdate,
    importOrphan,
  };
}

module.exports = { createLocalStore };
