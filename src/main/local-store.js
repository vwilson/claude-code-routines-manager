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

  /** The actual SKILL.md content write, shared by setPromptBody and applyUpdate (which
   * writes to a task mid-rename, before the registry can be looked up by its new id). */
  async function writePromptContent(filePath, id, promptBody) {
    const existing = readSkill(filePath);
    const content = translate.buildSkillMd({
      name: existing?.frontmatter.name ?? id,
      description: existing?.frontmatter.description ?? '',
      body: promptBody,
    });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await atomicWriteFile(filePath, content);
  }

  /** Replace the prompt body, preserving existing frontmatter. Ungated: the desktop reads SKILL.md at fire time. */
  async function setPromptBody(id, promptBody) {
    const tasks = await readTasksRaw();
    const task = tasks.find((t) => t.id === id);
    if (!task) throw new AppError('NOT_FOUND', `no local task "${id}"`);
    await writePromptContent(task.filePath, id, promptBody);
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
   * Copy an existing task to a new id: the whole registry entry (so unknown fields
   * like useWorktree or disableJitter carry over) minus run state, plus a byte-for-byte
   * copy of its SKILL.md with only the name: line repointed at the new id.
   * Schedule/cwd/model/name come from `spec` — the caller always decides those, since a
   * copy that fires at the same moment is rarely what's wanted.
   */
  async function duplicateTask(sourceId, spec) {
    if (await gate.isDesktopRunning({ fresh: true })) {
      throw new AppError('CLAUDE_RUNNING', 'Claude Desktop is running — close it before duplicating local tasks.');
    }
    const tasks = await readTasksRaw();
    const source = tasks.find((t) => t.id === sourceId);
    if (!source) throw new AppError('NOT_FOUND', `no local task "${sourceId}"`);
    assertNewTaskId(spec.id, tasks);
    // Copy the raw file and rewrite only its name: line, the same way renameTask does,
    // so extra frontmatter keys and the exact body bytes survive into the copy.
    let sourceContent;
    try {
      sourceContent = fs.readFileSync(source.filePath, 'utf8');
    } catch {
      // An empty prompt would look like a working copy and do nothing when it fires.
      throw new AppError('NOT_FOUND', `cannot read the prompt for "${sourceId}" at ${source.filePath} — nothing to copy`);
    }
    const skillDir = path.join(skillsDir, spec.id);
    const filePath = path.join(skillDir, 'SKILL.md');
    const dirExisted = fs.existsSync(skillDir);
    fs.mkdirSync(skillDir, { recursive: true });
    // Claim the destination exclusively rather than testing-then-writing: this both
    // rejects an existing prompt dir and proves the rollback below owns what it deletes,
    // even against another instance of this app duplicating to the same id.
    try {
      fs.closeSync(fs.openSync(filePath, 'wx'));
    } catch (err) {
      if (!dirExisted) fs.rmSync(skillDir, { recursive: true, force: true });
      if (err.code === 'EEXIST') {
        throw new AppError('VALIDATION', `a prompt for "${spec.id}" already exists at ${filePath}`);
      }
      throw new AppError('IO', `cannot create ${filePath}: ${err.message}`);
    }
    // Inherit everything, then let the spec win. Fields the spec leaves blank fall back
    // to the source's; run state and the schedule the copy does not use are dropped.
    const entry = { ...source, ...registryEntry(spec, filePath) };
    delete entry.lastRunAt;
    delete entry.lastScheduledFor;
    delete entry[spec.cronExpression ? 'fireAt' : 'cronExpression'];
    if (!spec.displayName) delete entry.displayName;

    try {
      await atomicWriteFile(filePath, translate.renameSkillName(sourceContent, spec.id));
      await mutateRegistry((envelope) => {
        assertNewTaskId(spec.id, envelope.scheduledTasks);
        envelope.scheduledTasks.push(entry);
      });
    } catch (err) {
      // The write lost a race (desktop relaunched, id taken externally): take the prompt
      // we claimed above back out so it does not linger as a phantom orphan. Safe to
      // delete precisely because the exclusive create proved no one else owns it.
      fs.rmSync(dirExisted ? filePath : skillDir, { recursive: true, force: true });
      throw err;
    }
    return entry;
  }

  /**
   * Filesystem-only half of a rename: validates the new id, moves the prompt dir, and
   * rewrites SKILL.md's name: line — no registry access at all. Returns the new file
   * path and a restore() that undoes exactly this (content + location). Kept separate
   * from the registry write so callers can stage the move, then commit (or not) to the
   * registry as a single gated step, without ever needing a *second* gated write to
   * undo a first one — see the module-level rationale on why that matters.
   */
  async function moveTaskDir(task, newId, existingIds) {
    assertNewTaskId(newId, existingIds);
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
    const originalContent = fs.readFileSync(newFilePath, 'utf8');
    const renamed = translate.renameSkillName(originalContent, newId);
    let contentRewritten = false;
    if (renamed !== originalContent) {
      await atomicWriteFile(newFilePath, renamed);
      contentRewritten = true;
    }

    return {
      newFilePath,
      async restore() {
        if (contentRewritten) {
          try {
            await atomicWriteFile(newFilePath, originalContent);
          } catch {
            // best effort — the directory move-back below still leaves things addressable under oldId
          }
        }
        fs.renameSync(newDir, oldDir);
      },
    };
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

    const move = await moveTaskDir(task, newId, tasks);
    try {
      await mutateRegistry((envelope) => {
        const entry = envelope.scheduledTasks.find((t) => t.id === oldId);
        if (!entry) throw new AppError('NOT_FOUND', `no local task "${oldId}" in the registry (it may have changed externally)`);
        // Re-check against the freshly-read envelope: the earlier snapshot could be stale.
        assertNewTaskId(newId, envelope.scheduledTasks);
        entry.id = newId;
        entry.filePath = move.newFilePath;
        if (envelope.recordedSkips && Object.prototype.hasOwnProperty.call(envelope.recordedSkips, oldId)) {
          envelope.recordedSkips[newId] = envelope.recordedSkips[oldId];
          delete envelope.recordedSkips[oldId];
        }
      });
    } catch (err) {
      await move.restore();
      throw err;
    }
    return { id: newId, filePath: move.newFilePath };
  }

  /**
   * Combined drawer save: stage the filesystem changes first — the directory move,
   * the rewritten SKILL.md name, and/or the new prompt body — then commit the id
   * rename and the patch fields to the registry together in a single gated write.
   * If that write fails (or never runs, e.g. Desktop starts partway through), only
   * the staged filesystem changes need undoing, and that undo touches only the
   * prompt directory, never the registry — so it can't be defeated by Desktop's
   * "loads the registry once at startup, rewrites it wholesale" behavior the way a
   * *second* gated registry write (attempting to reverse a first one it already
   * committed) could be: Desktop might silently clobber that second write with its
   * own already-loaded, stale copy, leaving the registry and the directory disagreeing.
   */
  async function applyUpdate(id, { newId, patch, promptBody } = {}) {
    const tasks = await readTasksRaw();
    const task = tasks.find((t) => t.id === id);
    if (!task) throw new AppError('NOT_FOUND', `no local task "${id}"`);

    const willRename = newId !== undefined && newId !== id;
    const move = willRename ? await moveTaskDir(task, newId, tasks) : null;
    const currentId = willRename ? newId : id;
    const filePath = willRename ? move.newFilePath : task.filePath;

    let originalPromptRaw;
    let promptRewritten = false;
    try {
      if (promptBody !== undefined) {
        try {
          originalPromptRaw = fs.readFileSync(filePath, 'utf8');
        } catch {
          originalPromptRaw = undefined; // no existing file to restore
        }
        await writePromptContent(filePath, currentId, promptBody);
        promptRewritten = true;
      }

      if (willRename || (patch && Object.keys(patch).length > 0)) {
        await mutateRegistry((envelope) => {
          const entry = envelope.scheduledTasks.find((t) => t.id === id);
          if (!entry) throw new AppError('NOT_FOUND', `no local task "${id}" in the registry (it may have changed externally)`);
          if (willRename) {
            assertNewTaskId(newId, envelope.scheduledTasks);
            entry.id = newId;
            entry.filePath = move.newFilePath;
            if (envelope.recordedSkips && Object.prototype.hasOwnProperty.call(envelope.recordedSkips, id)) {
              envelope.recordedSkips[newId] = envelope.recordedSkips[id];
              delete envelope.recordedSkips[id];
            }
          }
          if (patch) {
            for (const key of PATCHABLE_FIELDS) {
              if (patch[key] !== undefined) entry[key] = patch[key];
            }
          }
        });
      }
    } catch (err) {
      if (promptRewritten && originalPromptRaw !== undefined) {
        await atomicWriteFile(filePath, originalPromptRaw).catch(() => {});
      }
      if (move) await move.restore();
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
    duplicateTask,
    renameTask,
    applyUpdate,
    importOrphan,
  };
}

module.exports = { createLocalStore };
