'use strict';

// Every ipcMain.handle channel. All responses use the envelope
// { ok: true, data } | { ok: false, error: { code, message, detail? } } — handlers
// never reject, so nothing is lost to Electron's Error serialization. Tokens and
// stacks never appear in envelopes; INTERNAL logs to the main-process console only.

const fs = require('node:fs');
const { ipcMain, dialog, shell, BrowserWindow } = require('electron');
const { AppError } = require('./errors');
const cron = require('./cron');
const moves = require('./moves');
const translate = require('./translate');

const EXTERNAL_URL_PREFIXES = ['https://claude.ai/', 'https://platform.claude.com/'];

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

function registerIpc({ gate, cloudApi, localStore }) {
  // Environment names shown on trigger rows; refreshed by cloud:list.
  let environmentNamesById = new Map();

  const freshTriggerVM = async (id) => translate.triggerToVM(await cloudApi.getTrigger(id), environmentNamesById);
  const services = { gate, cloudApi, localStore, freshTriggerVM, toErrorEnvelope };

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

  handle('local:list', async () => {
    const { registryPath, tasks, orphans } = await localStore.listTasks();
    return { registryPath, desktopRunning: await desktopRunningOrNull(), tasks, orphans };
  });

  handle('local:get', ({ id }) => localStore.getTask(requireString(id, 'id')));

  // Validates everything up front — including the rename target — before any mutation
  // runs, so a bad cron/cwd/promptBody can't leave an id rename committed with the
  // rest of the edit rejected.
  handle('local:update', async ({ id, newId, patch, promptBody }) => {
    requireString(id, 'id');
    if (newId !== undefined) requireString(newId, 'newId', { re: translate.LOCAL_ID_RE });
    if (patch?.cronExpression !== undefined) cron.parseCron(patch.cronExpression);
    optionalBool(patch?.enabled, 'patch.enabled');
    if (patch?.cwd !== undefined) requireExistingDir(patch.cwd, 'patch.cwd');
    if (promptBody !== undefined && typeof promptBody !== 'string') {
      throw new AppError('VALIDATION', 'promptBody must be a string');
    }
    let currentId = id;
    if (newId !== undefined && newId !== id) {
      await localStore.renameTask(id, newId);
      currentId = newId;
    }
    if (promptBody !== undefined) await localStore.setPromptBody(currentId, promptBody);
    if (patch && Object.keys(patch).length > 0) await localStore.updateTask(currentId, patch);
    return localStore.getTask(currentId);
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
    if (patch.prompt !== undefined || patch.model !== undefined || patch.environmentId !== undefined) {
      // Nested partial updates are not trusted: splice into the full, fresh job_config.
      const fresh = await cloudApi.getTrigger(id);
      const jobConfig = fresh.job_config;
      if (!jobConfig?.ccr) throw new AppError('VALIDATION', 'this trigger has no editable job config');
      const message = jobConfig.ccr.events?.[0]?.data?.message;
      if (patch.prompt !== undefined) {
        if (!message) throw new AppError('VALIDATION', 'this trigger has no editable prompt event');
        message.content = requireString(patch.prompt, 'patch.prompt');
      }
      if (patch.model !== undefined) {
        if (!jobConfig.ccr.session_context) {
          throw new AppError('VALIDATION', 'this trigger has no session_context to set a model on');
        }
        jobConfig.ccr.session_context.model = requireString(patch.model, 'patch.model');
      }
      if (patch.environmentId !== undefined) {
        jobConfig.ccr.environment_id = requireString(patch.environmentId, 'patch.environmentId');
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

  handle('move:preview', ({ direction, sourceId }) => {
    requireString(sourceId, 'sourceId');
    if (direction === 'c2l') return moves.previewCloudToLocal(sourceId, services);
    if (direction === 'l2c') return moves.previewLocalToCloud(sourceId, services);
    throw new AppError('VALIDATION', 'direction must be "c2l" or "l2c"');
  });

  handle('move:cloudToLocal', (args) => {
    requireString(args.triggerId, 'triggerId');
    requireString(args.id, 'id', { re: translate.LOCAL_ID_RE });
    const schedule = requireSchedule({ cronExpression: args.cronExpression, oneShotAt: args.fireAt }, 'fireAt');
    requireExistingDir(args.cwd, 'cwd');
    return moves.moveCloudToLocal(
      { ...args, cronExpression: schedule.cronExpression, fireAt: schedule.oneShotAt },
      services,
    );
  });

  handle('move:localToCloud', (args) => {
    requireString(args.taskId, 'taskId');
    requireString(args.name, 'name');
    requireString(args.environmentId, 'environmentId');
    requireString(args.repoUrl, 'repoUrl', { re: /^https:\/\/.+\/.+/ });
    requireString(args.model, 'model');
    if (!Array.isArray(args.allowedTools) || args.allowedTools.some((t) => typeof t !== 'string')) {
      throw new AppError('VALIDATION', 'allowedTools must be an array of strings');
    }
    const schedule = requireSchedule({ cronExpression: args.cronExpression, oneShotAt: args.runOnceAt }, 'runOnceAt');
    if (schedule.cronExpression) {
      const problem = translate.validateCloudCron(schedule.cronExpression);
      if (problem) throw new AppError('VALIDATION', problem);
    } else if (new Date(schedule.oneShotAt).getTime() <= Date.now()) {
      throw new AppError('VALIDATION', 'runOnceAt must be in the future');
    }
    return moves.moveLocalToCloud(
      { ...args, cronExpression: schedule.cronExpression, runOnceAt: schedule.oneShotAt },
      services,
    );
  });

  handle('cron:preview', ({ expr, utc }) => ({
    next: cron
      .nextOccurrences(requireString(expr, 'expr'), { utc: utc === true, from: new Date(), count: 3 })
      .map((d) => d.toISOString()),
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

module.exports = { registerIpc };
