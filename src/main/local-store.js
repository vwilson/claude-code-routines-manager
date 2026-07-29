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

// Name of the exclusive claim marker written into a prompt dir mid-createTask() — see
// claimPromptDir(). Dot-prefixed and distinctive so nothing else in this app, and no
// plausible manual user action, would ever create a file with this exact name.
const CLAIM_MARKER = '.claim.json';

/** True if `pid` names a currently-running process (best-effort; assumes alive when unsure). */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

/**
 * True only if `dir` holds a readable claim marker whose owning process is confirmed
 * gone. The marker's mere presence proves claimPromptDir() created this directory (its
 * name isn't something anything else would write); a dead owner proves that specific
 * claim attempt can never resume. Anything short of that — no marker, an unreadable
 * one, or a marker whose owner is still alive — is left untouched.
 */
function ownedAbandonedClaim(dir) {
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(path.join(dir, CLAIM_MARKER), 'utf8'));
  } catch {
    return false;
  }
  return typeof marker.pid === 'number' && !isProcessAlive(marker.pid);
}

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

  /**
   * Atomically claim a brand-new prompt dir. A pre-existing SKILL.md always means a
   * real orphan or registered task and is refused untouched, full stop.
   *
   * The directory itself is created with {recursive: true} — that's idempotent, not the
   * exclusivity primitive. The claim marker is: it's written with the exclusive-create
   * flag ('wx'), so only one process can ever succeed in writing it for a given id.
   *
   * Any other pre-existing content (the marker itself, a live claim's in-progress
   * files, or something wholly unrelated) is only ever cleared when
   * ownedAbandonedClaim() can prove it's our own marker AND its owning process is
   * confirmed dead (e.g. killed between this claim and atomicWriteFile() finishing) —
   * never for a still-running claim, and never for unrelated content that happens to
   * share this id, both of which are refused the same as a real orphan.
   */
  function claimPromptDir(id) {
    fs.mkdirSync(skillsDir, { recursive: true });
    const skillDir = path.join(skillsDir, id);
    const refuse = () => {
      throw new AppError(
        'VALIDATION',
        `"${skillDir}" already exists — pick a different id, or register the existing prompt from the orphan list instead of creating a new task`,
      );
    };
    if (fs.existsSync(path.join(skillDir, 'SKILL.md'))) refuse();
    fs.mkdirSync(skillDir, { recursive: true });
    const markerPath = path.join(skillDir, CLAIM_MARKER);
    const writeMarker = () =>
      fs.writeFileSync(markerPath, JSON.stringify({ pid: process.pid, at: now().toISOString() }), { flag: 'wx' });

    // At most 2 passes: the second only runs if another process's marker lands in the
    // gap between our own emptiness check and our own marker write.
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (fs.readdirSync(skillDir).length > 0) {
        if (!ownedAbandonedClaim(skillDir)) refuse();
        fs.rmSync(skillDir, { recursive: true, force: true });
        fs.mkdirSync(skillDir, { recursive: true });
      }
      try {
        writeMarker();
        return skillDir;
      } catch (err) {
        if (err.code !== 'EEXIST') {
          // Unexpected failure on a dir we just confirmed empty and own — nothing
          // valuable left to protect, so clear it before propagating.
          fs.rmSync(skillDir, { recursive: true, force: true });
          throw err;
        }
      }
    }
    refuse();
  }

  /** Basenames of every prompt dir under scheduled-tasks, registered or orphaned — for id-collision checks. */
  function listPromptDirIds() {
    return listSubdirs(skillsDir).map((dir) => path.basename(dir));
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
    const skillDir = claimPromptDir(spec.id);
    const filePath = path.join(skillDir, 'SKILL.md');
    try {
      await atomicWriteFile(filePath, translate.buildSkillMd({ name: spec.id, description, body }));
    } catch (err) {
      // Nothing durable was published yet, so the claim is still safely ours to undo —
      // this keeps the id retryable instead of leaving a stray empty dir behind.
      fs.rmSync(skillDir, { recursive: true, force: true });
      throw err;
    }
    // SKILL.md now exists on disk and is visible to scanOrphans; the claim marker has
    // done its job (nothing else could have won this id while it was live) and is no
    // longer needed. From here on we never delete SKILL.md on failure: another process
    // could concurrently import this exact orphan, and re-checking the registry
    // immediately before a delete would still race against that process's commit. If
    // our own registry write below fails for any reason — including losing that race —
    // the file is left as a recoverable orphan rather than destroyed, importable again
    // via importOrphan()/the "Register…" UI flow.
    fs.rmSync(path.join(skillDir, CLAIM_MARKER), { force: true });
    const entry = registryEntry(spec, filePath);
    await mutateRegistry((envelope) => {
      assertNewTaskId(spec.id, envelope.scheduledTasks);
      envelope.scheduledTasks.push(entry);
    });
    return entry;
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
    listPromptDirIds,
    updateTask,
    setPromptBody,
    createTask,
    importOrphan,
  };
}

module.exports = { createLocalStore };
