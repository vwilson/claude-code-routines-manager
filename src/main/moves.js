'use strict';

// Move orchestration: preview + execute for both directions, independent of
// Electron so it can be exercised headlessly. "Move" always means: create on the
// target side, then disable (never delete) the source, reporting the two steps
// separately so a failed second step leaves an accurate account of the state.

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('./errors');
const cron = require('./cron');
const translate = require('./translate');

const MAX_CWD_SUGGESTIONS = 8;

function gitRemoteUrl(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { timeout: 3000, windowsHide: true }, (err, stdout) => {
      resolve(err ? undefined : translate.normalizeRepoUrl(stdout.trim()));
    });
  });
}

/** Distinct existing cwds, plus sibling-of-existing-cwd\<repoName> when that dir exists. */
function cwdSuggestions(tasks, repoUrl) {
  const suggestions = [];
  const seen = new Set();
  const push = (dir) => {
    const key = path.resolve(dir).toLowerCase();
    if (!seen.has(key) && suggestions.length < MAX_CWD_SUGGESTIONS) {
      seen.add(key);
      suggestions.push(dir);
    }
  };
  const cwds = tasks.map((t) => t.cwd).filter(Boolean);
  for (const cwd of cwds) push(cwd);
  const repoName = repoUrl?.split('/').filter(Boolean).pop()?.replace(/\.git$/, '');
  if (repoName) {
    for (const parent of new Set(cwds.map((c) => path.dirname(c)))) {
      const candidate = path.join(parent, repoName);
      try {
        if (fs.statSync(candidate).isDirectory()) push(candidate);
      } catch {
        // candidate does not exist — skip
      }
    }
  }
  return suggestions;
}

function isoList(dates) {
  return dates.map((d) => d.toISOString());
}

/** Next-occurrence previews for a source/target cron pair (either may be absent). */
function schedulePreview(sourceExpr, sourceUtc, targetExpr, targetUtc) {
  const safeNext = (expr, utc) => {
    if (!expr) return [];
    try {
      return isoList(cron.nextOccurrences(expr, { utc, from: new Date(), count: 3 }));
    } catch {
      return [];
    }
  };
  return { source: safeNext(sourceExpr, sourceUtc), target: safeNext(targetExpr, targetUtc) };
}

function shiftedCron(sourceExpr, offsetHours) {
  if (!sourceExpr) return { source: undefined };
  const result = cron.shiftCron(sourceExpr, offsetHours);
  return result.expr !== undefined
    ? { source: sourceExpr, target: result.expr }
    : { source: sourceExpr, unsupportedReason: result.unsupported };
}

function utcOffsetOrThrow() {
  const offset = translate.localToUtcOffsetHours();
  if (offset === null) {
    throw new AppError('CRON_UNSUPPORTED', "this machine's timezone offset is not a whole number of hours");
  }
  return offset;
}

async function previewCloudToLocal(sourceId, { localStore, freshTriggerVM }) {
  const offset = utcOffsetOrThrow();
  const vm = await freshTriggerVM(sourceId);
  if (vm.endedReason === 'run_once_fired') {
    throw new AppError('VALIDATION', 'this one-shot routine has already fired — nothing to move');
  }
  const tasks = await localStore.readTasksRaw();
  // Suggestions are always lowercase (slugify), but a prompt dir's on-disk name may not
  // be — and Windows' default case-insensitive filesystem would still reject the
  // suggested id at claimPromptDir() time. Compare case-insensitively so the suggestion
  // dodges it up front.
  const takenIds = new Set(
    [...tasks.map((t) => t.id), ...localStore.listPromptDirIds()].map((id) => id.toLowerCase()),
  );
  const cronInfo = shiftedCron(vm.cronExpression, -offset);
  return {
    suggestedId: translate.dedupeId(translate.slugify(vm.name), takenIds),
    displayName: vm.name,
    prompt: vm.prompt,
    model: vm.model,
    cron: cronInfo,
    fireAt: vm.runOnceAt,
    cwdSuggestions: cwdSuggestions(tasks, vm.repoUrl),
    warnings: [
      ...(vm.mcpConnections.length > 0
        ? [`${vm.mcpConnections.length} MCP connection(s) are not carried over to local tasks`]
        : []),
      'cloud notification settings are not carried over',
      'Claude Desktop must be restarted before it schedules the new local task',
    ],
    nextRuns: schedulePreview(cronInfo.source, true, cronInfo.target, false),
  };
}

async function previewLocalToCloud(sourceId, { localStore, cloudApi }) {
  const offset = utcOffsetOrThrow();
  const { task, promptBody } = await localStore.getTask(sourceId);
  if (task.fireAt && task.lastRunAt) {
    throw new AppError('VALIDATION', 'this one-shot task has already fired — nothing to move');
  }
  const cronInfo = shiftedCron(task.cronExpression, offset);
  if (cronInfo.target) {
    const problem = translate.validateCloudCron(cronInfo.target);
    if (problem) {
      cronInfo.unsupportedReason = problem;
      delete cronInfo.target;
    }
  }
  const environments = await cloudApi.listEnvironments().catch(() => []);
  return {
    name: task.displayName ?? task.id,
    prompt: promptBody,
    model: task.model ?? translate.FALLBACK_CLOUD_MODEL,
    cron: cronInfo,
    runOnceAt: task.fireAt,
    environments: environments.map((e) => ({ id: e.id, name: e.name ?? e.id })),
    repoUrlSuggestion: task.cwd ? await gitRemoteUrl(task.cwd) : undefined,
    allowedToolsDefault: translate.DEFAULT_ALLOWED_TOOLS,
    warnings: [
      "the cloud agent runs in an isolated environment — it cannot see this machine's files or env vars",
      ...(task.useWorktree ? ['local worktree/branch settings do not apply in the cloud'] : []),
    ],
    nextRuns: schedulePreview(cronInfo.source, false, cronInfo.target, true),
  };
}

/**
 * Step 1: create the local task (gated). Step 2: disable the cloud trigger.
 * `toErrorEnvelope` converts a step-2 failure for the renderer without rethrowing.
 */
async function moveCloudToLocal(args, { localStore, cloudApi, freshTriggerVM, toErrorEnvelope }) {
  const { triggerId, id, cronExpression, fireAt, cwd, model, enabled } = args;
  const vm = await freshTriggerVM(triggerId);
  await localStore.createTask(
    { id, cronExpression, fireAt, cwd, model, displayName: vm.name, enabled: enabled === true },
    { description: vm.name, body: vm.prompt },
  );
  let sourceDisabled = true;
  let disableError;
  try {
    await cloudApi.updateTrigger(triggerId, { enabled: false });
  } catch (err) {
    sourceDisabled = false;
    disableError = toErrorEnvelope(err);
  }
  return { created: true, taskId: id, sourceDisabled, ...(disableError && { disableError }) };
}

/** Step 1: create the cloud trigger. Step 2: disable the local task (unless skipped). */
async function moveLocalToCloud(args, { localStore, cloudApi, toErrorEnvelope }) {
  const { taskId, name, cronExpression, runOnceAt, environmentId, repoUrl, model, allowedTools, enabled, skipDisableLocal } = args;
  const { promptBody } = await localStore.getTask(taskId);
  const created = await cloudApi.createTrigger(
    translate.buildTriggerCreateBody({
      name,
      cronExpression,
      runOnceAt,
      enabled: enabled === true,
      environmentId,
      repoUrl,
      model,
      allowedTools,
      prompt: promptBody,
      eventUuid: crypto.randomUUID(),
    }),
  );
  let sourceDisabled = false;
  let disableError;
  if (!skipDisableLocal) {
    try {
      await localStore.updateTask(taskId, { enabled: false });
      sourceDisabled = true;
    } catch (err) {
      disableError = toErrorEnvelope(err);
    }
  }
  return { created: true, triggerId: created.id, sourceDisabled, ...(disableError && { disableError }) };
}

module.exports = { previewCloudToLocal, previewLocalToCloud, moveCloudToLocal, moveLocalToCloud };
