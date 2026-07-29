import * as ui from './render.js';

const $ = (selector) => document.querySelector(selector);

const state = {
  local: null, // { registryPath, desktopRunning, tasks, orphans }
  cloud: null, // { triggers, environments }
  localError: null,
  cloudError: null,
  drawer: null, // { kind: 'local'|'cloud', id, data, dirty }
  modalCtx: null, // last move-result panel args, for retry re-render
  localWriteNotice: false,
  lastRefreshed: null,
};

// ---------- IPC + error routing ----------

async function call(method, args) {
  const res = await window.routines[method](args);
  if (!res.ok) throw res.error;
  return res.data;
}

function toast(message, ok = false) {
  const node = ui.el('div', { class: ok ? 'toast ok' : 'toast' }, message);
  $('#toasts').append(node);
  setTimeout(() => node.remove(), 6000);
}

/** Route an IPC error: inline for form-level codes, banners for gate/auth, toast otherwise. */
function routeError(err, formErrorEl) {
  const code = err?.code ?? 'INTERNAL';
  const message = err?.message ?? String(err);
  if (formErrorEl && (code === 'VALIDATION' || code === 'CRON_UNSUPPORTED')) {
    formErrorEl.textContent = message;
    return;
  }
  if ((code === 'CLAUDE_RUNNING' || code === 'GATE_UNKNOWN') && state.local) {
    state.local.desktopRunning = code === 'CLAUDE_RUNNING' ? true : null;
    renderAll();
  }
  if (code === 'AUTH_REFRESH_FAILED') {
    state.cloudError = err;
    renderAll();
  }
  toast(`${code}: ${message}`);
}

// ---------- load + render ----------

async function load() {
  $('#last-refreshed').textContent = 'refreshing…';
  const [localRes, cloudRes] = await Promise.allSettled([call('localList'), call('cloudList')]);
  if (localRes.status === 'fulfilled') {
    state.local = localRes.value;
    state.localError = null;
  } else {
    state.localError = localRes.reason;
  }
  if (cloudRes.status === 'fulfilled') {
    state.cloud = cloudRes.value;
    state.cloudError = null;
  } else {
    state.cloudError = cloudRes.reason;
  }
  state.lastRefreshed = new Date();
  renderAll();
}

function renderAll() {
  renderChips();
  renderBanners();
  renderPanes();
  $('#last-refreshed').textContent = state.lastRefreshed
    ? `updated ${state.lastRefreshed.toLocaleTimeString()}`
    : '';
}

function renderChips() {
  const desktop = $('#chip-desktop');
  const running = state.local?.desktopRunning;
  if (running === true) {
    desktop.className = 'chip warn';
    desktop.textContent = 'Desktop: running — local writes locked';
  } else if (running === false) {
    desktop.className = 'chip ok';
    desktop.textContent = 'Desktop: closed';
  } else {
    desktop.className = 'chip err';
    desktop.textContent = 'Desktop: unknown';
  }
  const cloud = $('#chip-cloud');
  if (state.cloudError) {
    cloud.className = 'chip err';
    cloud.textContent = 'Cloud: error';
  } else if (state.cloud) {
    cloud.className = 'chip ok';
    cloud.textContent = `Cloud: ${state.cloud.triggers.length} routines`;
  } else {
    cloud.className = 'chip';
    cloud.textContent = 'Cloud: loading…';
  }
}

function renderBanners() {
  const banners = [];
  if (state.local?.desktopRunning === true) {
    banners.push(
      ui.bannerEl(
        'warn',
        'Local registry writes are disabled while Claude Desktop is running. Close it (including the tray icon), then re-check.',
        [{ label: 'Re-check', action: 'refresh' }],
      ),
    );
  }
  if (state.local && state.local.desktopRunning === null) {
    banners.push(
      ui.bannerEl(
        'err',
        'Could not determine whether Claude Desktop is running — local writes stay locked (fail closed).',
        [{ label: 'Re-check', action: 'refresh' }],
      ),
    );
  }
  if (state.cloudError) {
    banners.push(
      ui.bannerEl('err', `Cloud: ${state.cloudError.message ?? state.cloudError}`, [
        { label: 'Retry', action: 'refresh' },
      ]),
    );
  }
  if (state.localError) {
    banners.push(ui.bannerEl('err', `Local: ${state.localError.message ?? state.localError}`));
  }
  if (state.localWriteNotice) {
    banners.push(
      ui.bannerEl('info', 'Local changes take effect after Claude Desktop restarts (it loads the registry only at startup).'),
    );
  }
  $('#banners').replaceChildren(...banners);
}

function renderPanes() {
  const localList = $('#local-list');
  if (state.local) {
    localList.replaceChildren(...state.local.tasks.map(ui.localTaskRow));
    const subtitle = $('#local-subtitle');
    subtitle.textContent = state.local.registryPath ?? 'no registry found';
    subtitle.title = state.local.registryPath ?? '';
    $('#orphan-count').textContent = String(state.local.orphans.length);
    $('#orphan-list').replaceChildren(...state.local.orphans.map(ui.orphanRow));
  } else {
    localList.replaceChildren(ui.el('div', { class: 'muted' }, state.localError ? 'failed to load' : 'loading…'));
  }
  const cloudList = $('#cloud-list');
  if (state.cloud) {
    cloudList.replaceChildren(...state.cloud.triggers.map(ui.cloudTriggerRow));
    $('#cloud-subtitle').textContent = `${state.cloud.environments.length} environment(s)`;
  } else {
    cloudList.replaceChildren(ui.el('div', { class: 'muted' }, state.cloudError ? 'failed to load' : 'loading…'));
  }
}

// ---------- drawer ----------

async function openDrawer(kind, id) {
  const data = await call(kind === 'local' ? 'localGet' : 'cloudGet', { id });
  state.drawer = { kind, id, data, dirty: false };
  renderDrawer();
}

function renderDrawer() {
  const drawer = $('#drawer');
  if (!state.drawer) {
    drawer.hidden = true;
    drawer.replaceChildren();
    return;
  }
  drawer.hidden = false;
  drawer.replaceChildren(
    state.drawer.kind === 'local'
      ? ui.localDrawer(state.drawer.data)
      : ui.cloudDrawer(state.drawer.data, state.cloud?.environments ?? []),
  );
  drawer.querySelectorAll('[data-cron-preview]').forEach((input) => updateCronPreview(input));
}

function closeDrawer() {
  if (state.drawer?.dirty && !window.confirm('Discard unsaved changes?')) return;
  state.drawer = null;
  renderDrawer();
}

function changedValue(form, name, original) {
  const input = form.elements[name];
  if (!input) return undefined;
  const value = input.value.trim();
  return value === (original ?? '') ? undefined : value;
}

async function drawerSave(form) {
  const errorEl = form.querySelector('.form-error');
  errorEl.textContent = '';
  const { kind, data } = state.drawer;
  try {
    if (kind === 'local') {
      const original = data.task;
      const patch = {};
      const displayName = changedValue(form, 'displayName', original.displayName);
      if (displayName !== undefined) patch.displayName = displayName;
      const cronExpression = changedValue(form, 'cronExpression', original.cronExpression);
      if (cronExpression !== undefined) {
        if (cronExpression === '') throw { code: 'VALIDATION', message: 'the cron expression cannot be empty' };
        patch.cronExpression = cronExpression;
      }
      for (const name of ['model', 'cwd']) {
        const value = changedValue(form, name, original[name]);
        if (value) patch[name] = value; // clearing these fields is not supported
      }
      const promptInput = form.elements.promptBody;
      const promptBody = promptInput.value !== data.promptBody ? promptInput.value : undefined;
      if (Object.keys(patch).length === 0 && promptBody === undefined) {
        toast('No changes to save', true);
        return;
      }
      state.drawer.data = await call('localUpdate', {
        id: original.id,
        ...(Object.keys(patch).length > 0 && { patch }),
        ...(promptBody !== undefined && { promptBody }),
      });
      if (Object.keys(patch).length > 0) state.localWriteNotice = true;
    } else {
      const original = data;
      const patch = {};
      for (const name of ['name', 'cronExpression', 'model', 'environmentId']) {
        const value = changedValue(form, name, original[name]);
        if (value) patch[name] = value;
      }
      const promptInput = form.elements.prompt;
      if (promptInput.value !== original.prompt) patch.prompt = promptInput.value;
      if (Object.keys(patch).length === 0) {
        toast('No changes to save', true);
        return;
      }
      state.drawer.data = await call('cloudUpdate', { id: original.id, patch });
    }
    state.drawer.dirty = false;
    toast('Saved', true);
    renderDrawer();
    load();
  } catch (err) {
    routeError(err, errorEl);
  }
}

// ---------- toggles ----------

async function toggleEnabled(input, kind) {
  const id = input.dataset.id;
  const enabled = input.checked;
  input.disabled = true;
  try {
    if (kind === 'local') {
      await call('localUpdate', { id, patch: { enabled } });
      const task = state.local.tasks.find((t) => t.id === id);
      if (task) task.enabled = enabled;
      state.localWriteNotice = true;
    } else {
      const updated = await call('cloudUpdate', { id, patch: { enabled } });
      const index = state.cloud.triggers.findIndex((t) => t.id === id);
      if (index >= 0) state.cloud.triggers[index] = updated;
    }
    renderAll();
  } catch (err) {
    input.checked = !enabled;
    routeError(err);
  } finally {
    input.disabled = false;
  }
}

// ---------- dialogs ----------

async function openMoveDialog(direction, sourceId) {
  const preview = await call('movePreview', { direction, sourceId });
  const form =
    direction === 'c2l'
      ? ui.moveCloudToLocalDialog(preview, { triggerId: sourceId })
      : ui.moveLocalToCloudDialog(preview, {
          taskId: sourceId,
          desktopRunning: state.local?.desktopRunning !== false,
        });
  const modal = $('#modal');
  modal.replaceChildren(form);
  modal.showModal();
  form.querySelectorAll('[data-cron-preview]').forEach((input) => updateCronPreview(input));
}

/**
 * "alpha" -> "alpha-copy", then "alpha-copy-2", … Orphans count as taken too: their
 * prompt dir already occupies the id, so the store would reject it on submit.
 */
function suggestCopyId(sourceId, existingIds) {
  const taken = new Set(existingIds);
  const base = `${sourceId}-copy`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

async function openDuplicateDialog(kind, id) {
  const modal = $('#modal');
  if (kind === 'local') {
    const { task } = await call('localGet', { id });
    const taken = [
      ...(state.local?.tasks ?? []).map((t) => t.id),
      ...(state.local?.orphans ?? []).map((o) => o.id),
    ];
    modal.replaceChildren(ui.duplicateLocalDialog(task, suggestCopyId(task.id, taken)));
  } else {
    modal.replaceChildren(ui.duplicateCloudDialog(await call('cloudGet', { id })));
  }
  modal.showModal();
  modal.querySelectorAll('[data-cron-preview]').forEach((input) => updateCronPreview(input));
}

function openOrphanDialog(id) {
  const orphan = state.local?.orphans.find((o) => o.id === id);
  if (!orphan) return;
  const modal = $('#modal');
  modal.replaceChildren(ui.orphanDialog(orphan));
  modal.showModal();
  modal.querySelectorAll('[data-cron-preview]').forEach((input) => updateCronPreview(input));
}

function showMoveResult(panelArgs) {
  state.modalCtx = panelArgs;
  $('#modal').replaceChildren(ui.moveResultPanel(panelArgs));
}

async function modalSubmit(form) {
  const errorEl = form.querySelector('[data-form-error]');
  errorEl.textContent = '';
  const fd = new FormData(form);
  const value = (name) => (fd.get(name) ?? '').toString().trim();
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    if (form.dataset.kind === 'move-c2l') {
      const result = await call('moveCloudToLocal', {
        triggerId: form.dataset.triggerId,
        id: value('id'),
        ...(form.dataset.fireAt ? { fireAt: form.dataset.fireAt } : { cronExpression: value('cronExpression') }),
        cwd: value('cwd'),
        model: value('model') || undefined,
        enabled: fd.get('enabled') !== null,
      });
      state.localWriteNotice = true;
      showMoveResult({
        createdLabel: `Created local task "${result.taskId}"`,
        disableLabel: 'Disable cloud routine',
        sourceDisabled: result.sourceDisabled,
        disableError: result.disableError,
        retryAction: 'retry-disable-cloud',
        retryId: form.dataset.triggerId,
      });
    } else if (form.dataset.kind === 'move-l2c') {
      const skipDisableLocal = fd.get('skipDisableLocal') !== null;
      const result = await call('moveLocalToCloud', {
        taskId: form.dataset.taskId,
        name: value('name'),
        ...(form.dataset.runOnceAt ? { runOnceAt: form.dataset.runOnceAt } : { cronExpression: value('cronExpression') }),
        environmentId: value('environmentId'),
        repoUrl: value('repoUrl'),
        model: value('model'),
        allowedTools: value('allowedTools').split(',').map((t) => t.trim()).filter(Boolean),
        enabled: fd.get('enabled') !== null,
        skipDisableLocal,
      });
      showMoveResult({
        createdLabel: `Created cloud routine ${result.triggerId}`,
        disableLabel: 'Disable local task',
        sourceDisabled: result.sourceDisabled,
        disableError: skipDisableLocal ? { message: 'skipped (copy only)' } : result.disableError,
        retryAction: 'retry-disable-local',
        retryId: form.dataset.taskId,
        link: `https://claude.ai/code/routines/${result.triggerId}`,
      });
    } else if (form.dataset.kind === 'duplicate-local') {
      const fireAtLocal = value('fireAt');
      await call('localDuplicate', {
        sourceId: form.dataset.sourceId,
        id: value('id'),
        displayName: value('displayName') || undefined,
        ...(fireAtLocal ? { fireAt: new Date(fireAtLocal).toISOString() } : { cronExpression: value('cronExpression') }),
        cwd: value('cwd') || undefined,
        model: value('model') || undefined,
        enabled: fd.get('enabled') !== null,
      });
      state.localWriteNotice = true;
      $('#modal').close();
      toast('Duplicated', true);
      load();
    } else if (form.dataset.kind === 'duplicate-cloud') {
      const runOnceLocal = value('runOnceAt');
      const created = await call('cloudDuplicate', {
        id: form.dataset.sourceId,
        name: value('name'),
        ...(runOnceLocal ? { runOnceAt: new Date(runOnceLocal).toISOString() } : { cronExpression: value('cronExpression') }),
        enabled: fd.get('enabled') !== null,
      });
      $('#modal').close();
      toast(`Duplicated as ${created.id}`, true);
      load();
    } else if (form.dataset.kind === 'orphan-import') {
      const cronExpression = value('cronExpression');
      const fireAtLocal = value('fireAt');
      if (Boolean(cronExpression) === Boolean(fireAtLocal)) {
        throw { code: 'VALIDATION', message: 'set either a cron expression or a one-shot time (not both)' };
      }
      await call('localImportOrphan', {
        id: form.dataset.id,
        ...(cronExpression ? { cronExpression } : { fireAt: new Date(fireAtLocal).toISOString() }),
        cwd: value('cwd'),
        model: value('model') || undefined,
        displayName: value('displayName') || undefined,
        enabled: fd.get('enabled') !== null,
      });
      state.localWriteNotice = true;
      $('#modal').close();
      toast('Registered', true);
      load();
    }
  } catch (err) {
    routeError(err, errorEl);
  } finally {
    submitButton.disabled = false;
  }
}

async function retryDisable(kind, id, button) {
  button.disabled = true;
  try {
    if (kind === 'local') {
      await call('localUpdate', { id, patch: { enabled: false } });
      state.localWriteNotice = true;
    } else {
      await call('cloudUpdate', { id, patch: { enabled: false } });
    }
    showMoveResult({ ...state.modalCtx, sourceDisabled: true, disableError: undefined });
  } catch (err) {
    button.disabled = false;
    routeError(err);
  }
}

// ---------- cron preview ----------

async function updateCronPreview(input) {
  const scope = input.closest('form') ?? document;
  const target = scope.querySelector(`[data-cron-next-for="${input.name}"]`);
  if (!target) return;
  const expr = input.value.trim();
  if (!expr) {
    target.textContent = '';
    return;
  }
  try {
    const { next } = await call('cronPreview', { expr, utc: input.dataset.cronPreview === 'utc' });
    target.classList.remove('err');
    target.textContent = next.length > 0 ? `next: ${next.map(ui.formatTime).join('  ·  ')}` : 'never matches';
  } catch (err) {
    target.classList.add('err');
    target.textContent = err.message ?? 'invalid cron';
  }
}

// ---------- events ----------

async function pickCwd(button) {
  const input = button.closest('form')?.elements[button.dataset.target];
  if (!input) return;
  const { path } = await call('pickFolder', { defaultPath: input.value || undefined });
  if (path) {
    input.value = path;
    if (state.drawer && button.closest('#drawer')) state.drawer.dirty = true;
  }
}

const actions = {
  refresh: () => load(),
  'open-url': (target) => call('openExternal', { url: target.dataset.url }),
  'open-local': (target) => openDrawer('local', target.dataset.id),
  'open-cloud': (target) => openDrawer('cloud', target.dataset.id),
  'toggle-local': (target) => toggleEnabled(target, 'local'),
  'toggle-cloud': (target) => toggleEnabled(target, 'cloud'),
  'drawer-close': () => closeDrawer(),
  'run-cloud': async (target) => {
    target.disabled = true;
    try {
      await call('cloudRun', { id: target.dataset.id });
      toast('Run requested', true);
    } finally {
      target.disabled = false;
    }
  },
  'move-start': (target) => openMoveDialog(target.dataset.direction, target.dataset.id),
  'duplicate-local': (target) => openDuplicateDialog('local', target.dataset.id),
  'duplicate-cloud': (target) => openDuplicateDialog('cloud', target.dataset.id),
  'orphan-open': (target) => openOrphanDialog(target.dataset.id),
  'pick-cwd': (target) => pickCwd(target),
  'modal-close': () => $('#modal').close(),
  'modal-close-refresh': () => {
    $('#modal').close();
    load();
  },
  'retry-disable-cloud': (target) => retryDisable('cloud', target.dataset.id, target),
  'retry-disable-local': (target) => retryDisable('local', target.dataset.id, target),
};

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const handler = actions[target.dataset.action];
  if (!handler) return;
  Promise.resolve(handler(target)).catch((err) =>
    routeError(err, target.closest('form')?.querySelector('[data-form-error]')),
  );
});

document.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.id === 'drawer-form') drawerSave(form);
  else if (form.id === 'modal-form') modalSubmit(form);
});

let cronDebounce;
document.addEventListener('input', (event) => {
  if (state.drawer && event.target.closest('#drawer')) state.drawer.dirty = true;
  if (event.target.dataset?.cronPreview !== undefined) {
    clearTimeout(cronDebounce);
    cronDebounce = setTimeout(() => updateCronPreview(event.target), 300);
  }
});

load();
