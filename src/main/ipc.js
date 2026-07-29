'use strict';

// Every ipcMain.handle channel. All responses use the envelope
// { ok: true, data } | { ok: false, error: { code, message, detail? } } — handlers
// never reject, so nothing is lost to Electron's Error serialization. Tokens and
// stacks never appear in envelopes; INTERNAL logs to the main-process console only.

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ipcMain, dialog, shell, BrowserWindow } = require('electron');
const { AppError } = require('./errors');
const cron = require('./cron');
const translate = require('./translate');

const EXTERNAL_URL_PREFIXES = ['https://claude.ai/', 'https://platform.claude.com/'];
const MAX_CWD_SUGGESTIONS = 8;

function toErrorEnvelope(err) {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message, ...(err.detail !== undefined && { detail: err.detail }) };
  }
  if (err instanceof cron.CronError) {
    return { code: 'CRON_UNSUPPORTED', message: err.reason };
  }
  console.error('[ipc]', err);
  return { code: 'INTERNAL', message: 'internal error — see the main process console' };
}

function requireString(value, name, { re } = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError('VALIDATION', `${name} is required`);
  }
  if (re && !re.test(value)) {
    throw new AppError('VALIDATION', `${name} has an invalid format`);
  }
  return value;
}

function optionalBool(value, name) {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new AppError('VALIDATION', `${name} must be a boolean`);
  }
  return value;
}

/** Exactly one of cronExpression / one-shot time; validates the cron parses. */
function requireSchedule({ cronExpression, oneShotAt }, oneShotName) {
  if (Boolean(cronExpression) === Boolean(oneShotAt)) {
    throw new AppError('VALIDATION', `provide exactly one of cronExpression and ${oneShotName}`);
  }
  if (cronExpression) {
    cron.parseCron(cronExpression); // throws CronError -> CRON_UNSUPPORTED
    return { cronExpression };
  }
  const iso = translate.toIso(oneShotAt);
  if (!iso) throw new AppError('VALIDATION', `${oneShotName} is not a valid timestamp`);
  return { oneShotAt: iso };
}

function requireExistingDir(value, name) {
  requireString(value, name);
  let stat;
  try {
    stat = fs.statSync(value);
  } catch {
    stat = null;
  }
  if (!stat?.isDirectory()) {
    throw new AppError('VALIDATION', `${name} "${value}" is not an existing directory`);
  }
  return value;
}

function gitRemoteUrl(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { timeout: 3000, windowsHide: true }, (err, stdout) => {
      resolve(err ? undefined : translate.normalizeRepoUrl(stdout.trim()));
    });
  });
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
    throw new AppError('CRON_UNSUPPORTED', 'this machine\'s timezone offset is not a whole number of hours');
  }
  return offset;
}

function registerIpc({ gate, cloudApi, localStore }) {
  // Environment names shown on trigger rows; refreshed by cloud:list.
  let environmentNamesById = new Map();

  function handle(channel, handler) {
    ipcMain.handle(channel, async (_event, args) => {
      try {
        return { ok: true, data: await handler(args ?? {}) };
      } catch (err) {
        return { ok: false, error: toErrorEnvelope(err) };
      }
    });
  }

  async function desktopRunningOrNull() {
    try {
      return await gate.isDesktopRunning();
    } catch {
      return null;
    }
  }

  async function freshTriggerVM(id) {
    return translate.triggerToVM(await cloudApi.getTrigger(id), environmentNamesById);
  }

  handle('local:list', async () => {
    const { registryPath, tasks, orphans } = await localStore.listTasks();
    return { registryPath, desktopRunning: await desktopRunningOrNull(), tasks, orphans };
  });

  handle('local:get', ({ id }) => localStore.getTask(requireString(id, 'id')));

  handle('local:update', async ({ id, patch, promptBody }) => {
    requireString(id, 'id');
    if (patch?.cronExpression !== undefined) cron.parseCron(patch.cronExpression);
    optionalBool(patch?.enabled, 'patch.enabled');
    if (patch?.cwd !== undefined) requireExistingDir(patch.cwd, 'patch.cwd');
    if (promptBody !== undefined && typeof promptBody !== 'string') {
      throw new AppError('VALIDATION', 'promptBody must be a string');
    }
    if (promptBody !== undefined) await localStore.setPromptBody(id, promptBody);
    if (patch && Object.keys(patch).length > 0) await localStore.updateTask(id, patch);
    return localStore.getTask(id);
  });

  handle('local:importOrphan', async ({ id, cronExpression, fireAt, cwd, model, displayName, enabled }) => {
    requireString(id, 'id', { re: translate.LOCAL_ID_RE });
    const schedule = requireSchedule({ cronExpression, oneShotAt: fireAt }, 'fireAt');
    requireExistingDir(cwd, 'cwd');
    await localStore.importOrphan({
      id,
      cronExpression: schedule.cronExpression,
      fireAt: schedule.oneShotAt,
      cwd,
      model,
      displayName,
      enabled: enabled === true,
    });
    return localStore.getTask(id);
  });

  handle('cloud:list', async () => {
    const [{ triggers }, environments] = await Promise.all([
      cloudApi.listTriggers(),
      cloudApi.listEnvironments().catch(() => []),
    ]);
    const envVMs = environments.map((e) => ({ id: e.id, name: e.name ?? e.id }));
    environmentNamesById = new Map(envVMs.map((e) => [e.id, e.name]));
    return {
      triggers: triggers.map((t) => translate.triggerToVM(t, environmentNamesById)),
      environments: envVMs,
    };
  });

  handle('cloud:get', ({ id }) => freshTriggerVM(requireString(id, 'id')));

  handle('cloud:update', async ({ id, patch = {} }) => {
    requireString(id, 'id');
    optionalBool(patch.enabled, 'patch.enabled');
    const body = {};
    if (patch.name !== undefined) body.name = requireString(patch.name, 'patch.name');
    if (patch.enabled !== undefined) body.enabled = patch.enabled;
    if (patch.cronExpression !== undefined) {
      const problem = translate.validateCloudCron(patch.cronExpression);
      if (problem) throw new AppError('VALIDATION', problem);
      body.cron_expression = patch.cronExpression;
    }
    if (patch.prompt !== undefined || patch.model !== undefined) {
      // Nested partial updates are not trusted: splice into the full, fresh job_config.
      const fresh = await cloudApi.getTrigger(id);
      const jobConfig = fresh.job_config;
      const message = jobConfig?.ccr?.events?.[0]?.data?.message;
      if (patch.prompt !== undefined) {
        if (!message) throw new AppError('VALIDATION', 'this trigger has no editable prompt event');
        message.content = requireString(patch.prompt, 'patch.prompt');
      }
      if (patch.model !== undefined) {
        if (!jobConfig?.ccr?.session_context) {
          throw new AppError('VALIDATION', 'this trigger has no session_context to set a model on');
        }
        jobConfig.ccr.session_context.model = requireString(patch.model, 'patch.model');
      }
      body.job_config = jobConfig;
    }
    if (Object.keys(body).length === 0) throw new AppError('VALIDATION', 'nothing to update');
    await cloudApi.updateTrigger(id, body);
    return freshTriggerVM(id);
  });

  handle('cloud:run', async ({ id }) => {
    await cloudApi.runTrigger(requireString(id, 'id'));
    return {};
  });

  handle('move:preview', async ({ direction, sourceId }) => {
    requireString(sourceId, 'sourceId');
    const offset = utcOffsetOrThrow();
    if (direction === 'c2l') {
      const vm = await freshTriggerVM(sourceId);
      if (vm.endedReason === 'run_once_fired') {
        throw new AppError('VALIDATION', 'this one-shot routine has already fired — nothing to move');
      }
      const tasks = await localStore.readTasksRaw();
      const cronInfo = shiftedCron(vm.cronExpression, -offset);
      return {
        suggestedId: translate.dedupeId(translate.slugify(vm.name), tasks.map((t) => t.id)),
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
    if (direction === 'l2c') {
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
          'the cloud agent runs in an isolated environment — it cannot see this machine\'s files or env vars',
          ...(task.useWorktree ? ['local worktree/branch settings do not apply in the cloud'] : []),
        ],
        nextRuns: schedulePreview(cronInfo.source, false, cronInfo.target, true),
      };
    }
    throw new AppError('VALIDATION', 'direction must be "c2l" or "l2c"');
  });

  handle('move:cloudToLocal', async ({ triggerId, id, cronExpression, fireAt, cwd, model, enabled }) => {
    requireString(triggerId, 'triggerId');
    requireString(id, 'id', { re: translate.LOCAL_ID_RE });
    const schedule = requireSchedule({ cronExpression, oneShotAt: fireAt }, 'fireAt');
    requireExistingDir(cwd, 'cwd');
    const vm = await freshTriggerVM(triggerId);
    await localStore.createTask(
      {
        id,
        cronExpression: schedule.cronExpression,
        fireAt: schedule.oneShotAt,
        cwd,
        model,
        displayName: vm.name,
        enabled: enabled === true,
      },
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
  });

  handle('move:localToCloud', async (args) => {
    const { taskId, name, environmentId, repoUrl, model, allowedTools, enabled, skipDisableLocal } = args;
    requireString(taskId, 'taskId');
    requireString(name, 'name');
    requireString(environmentId, 'environmentId');
    requireString(repoUrl, 'repoUrl', { re: /^https:\/\/.+\/.+/ });
    requireString(model, 'model');
    if (!Array.isArray(allowedTools) || allowedTools.some((t) => typeof t !== 'string')) {
      throw new AppError('VALIDATION', 'allowedTools must be an array of strings');
    }
    const schedule = requireSchedule({ cronExpression: args.cronExpression, oneShotAt: args.runOnceAt }, 'runOnceAt');
    if (schedule.cronExpression) {
      const problem = translate.validateCloudCron(schedule.cronExpression);
      if (problem) throw new AppError('VALIDATION', problem);
    } else if (new Date(schedule.oneShotAt).getTime() <= Date.now()) {
      throw new AppError('VALIDATION', 'runOnceAt must be in the future');
    }
    const { promptBody } = await localStore.getTask(taskId);
    const created = await cloudApi.createTrigger(
      translate.buildTriggerCreateBody({
        name,
        cronExpression: schedule.cronExpression,
        runOnceAt: schedule.oneShotAt,
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
  });

  handle('cron:preview', ({ expr, utc }) => ({
    next: isoList(cron.nextOccurrences(requireString(expr, 'expr'), { utc: utc === true, from: new Date(), count: 3 })),
  }));

  handle('dialog:pickFolder', async ({ defaultPath }) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      ...(defaultPath ? { defaultPath } : {}),
    });
    return { path: result.canceled ? null : (result.filePaths[0] ?? null) };
  });

  handle('app:openExternal', async ({ url }) => {
    requireString(url, 'url');
    if (!EXTERNAL_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) {
      throw new AppError('VALIDATION', 'only claude.ai and platform.claude.com links can be opened');
    }
    await shell.openExternal(url);
    return {};
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

module.exports = { registerIpc };
