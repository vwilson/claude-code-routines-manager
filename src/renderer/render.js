// Pure DOM builders. No state, no IPC — app.js wires behavior via data-action
// attributes and event delegation. All dynamic text goes through textContent.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') {
      for (const [dataKey, dataValue] of Object.entries(value)) {
        if (dataValue !== undefined && dataValue !== null) node.dataset[dataKey] = dataValue;
      }
    }
    else if (key === 'value') node.value = value;
    else if (key === 'checked') node.checked = true;
    else if (key === 'disabled') node.disabled = true;
    else if (key === 'open') node.open = true;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function formatTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso) : timeFormat.format(date);
}

function badge(text, warn = false) {
  return el('span', { class: warn ? 'badge warn' : 'badge' }, text);
}

function scheduleText(item) {
  if (item.cronExpression) {
    const zone = item.zone === 'utc' ? 'UTC' : 'local';
    const next = item.nextRunAt ? ` · next ${formatTime(item.nextRunAt)}` : '';
    return `${item.cronExpression} (${zone})${next}`;
  }
  const at = item.fireAt ?? item.runOnceAt;
  return at ? `once at ${formatTime(at)}` : 'no schedule';
}

export function localTaskRow(task) {
  const badges = [];
  if (task.model) badges.push(badge(task.model));
  if (task.fireAt) badges.push(badge('one-shot'));
  if (task.fireAt && task.lastRunAt) badges.push(badge('fired'));
  if (task.skillMissing) badges.push(badge('skill missing', true));
  if (task.skips > 0) badges.push(badge(`${task.skips} skips`, true));
  return el(
    'div',
    { class: task.enabled ? 'row' : 'row disabled-row', dataset: { action: 'open-local', id: task.id } },
    el('input', {
      type: 'checkbox',
      class: 'switch',
      checked: task.enabled,
      title: task.enabled ? 'Disable' : 'Enable',
      dataset: { action: 'toggle-local', id: task.id },
    }),
    el(
      'div',
      { class: 'row-main' },
      el('div', { class: 'row-title' }, task.displayName || task.id),
      el('div', { class: 'row-sub' }, scheduleText({ ...task, zone: 'local' })),
    ),
    el('div', { class: 'badges' }, badges),
  );
}

export function cloudTriggerRow(trigger) {
  const badges = [];
  if (trigger.model) badges.push(badge(trigger.model));
  if (trigger.environmentName) badges.push(badge(trigger.environmentName));
  if (trigger.runOnceAt || (!trigger.cronExpression && trigger.endedReason)) badges.push(badge('one-shot'));
  if (trigger.endedReason === 'run_once_fired') badges.push(badge('fired'));
  if (trigger.mcpConnections.length > 0) badges.push(badge('MCP'));
  return el(
    'div',
    { class: trigger.enabled ? 'row' : 'row disabled-row', dataset: { action: 'open-cloud', id: trigger.id } },
    el('input', {
      type: 'checkbox',
      class: 'switch',
      checked: trigger.enabled,
      title: trigger.enabled ? 'Disable' : 'Enable',
      dataset: { action: 'toggle-cloud', id: trigger.id },
    }),
    el(
      'div',
      { class: 'row-main' },
      el('div', { class: 'row-title' }, trigger.name || trigger.id),
      el('div', { class: 'row-sub' }, scheduleText({ ...trigger, zone: 'utc' })),
    ),
    el('div', { class: 'badges' }, badges),
    el(
      'button',
      {
        type: 'button',
        class: 'icon-btn',
        title: 'Open at claude.ai',
        dataset: { action: 'open-url', url: `https://claude.ai/code/routines/${trigger.id}` },
      },
      '↗',
    ),
  );
}

export function orphanRow(orphan) {
  return el(
    'div',
    { class: 'row' },
    el(
      'div',
      { class: 'row-main' },
      el('div', { class: 'row-title' }, orphan.id),
      el('div', { class: 'row-sub' }, orphan.description || 'no description'),
    ),
    el('button', { type: 'button', dataset: { action: 'orphan-open', id: orphan.id } }, 'Register…'),
  );
}

export function bannerEl(kind, text, actions = []) {
  return el(
    'div',
    { class: `banner ${kind}` },
    el('span', { class: 'banner-text' }, text),
    actions.map(({ label, action }) => el('button', { type: 'button', dataset: { action } }, label)),
  );
}

function kvList(pairs) {
  return el(
    'dl',
    { class: 'kv' },
    pairs
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => [el('dt', {}, key), el('dd', {}, String(value))]),
  );
}

function field(labelText, control, extra) {
  return el('div', { class: 'field' }, el('label', {}, labelText), control, extra);
}

function cronField(name, value, { utc, disabled = false } = {}) {
  return field(
    `Cron (${utc ? 'UTC' : 'local time'})`,
    el('input', {
      name,
      value: value ?? '',
      disabled,
      spellcheck: 'false',
      dataset: { cronPreview: utc ? 'utc' : 'local' },
    }),
    el('div', { class: 'cron-next', dataset: { cronNextFor: name } }),
  );
}

/** Drawer for a local task. `data` = { task, promptBody, frontmatter }. */
export function localDrawer({ task, promptBody }) {
  return el(
    'div',
    {},
    el(
      'div',
      { class: 'drawer-head' },
      el('h2', {}, task.displayName || task.id),
      el('button', { type: 'button', dataset: { action: 'drawer-close' } }, 'Close'),
    ),
    kvList([
      ['id', task.id],
      ['created', formatTime(task.createdAt)],
      ['last run', formatTime(task.lastRunAt)],
      ['next run', task.nextRunAt ? `${formatTime(task.nextRunAt)} (incl. ${task.jitterSeconds}s jitter)` : '—'],
      ['one-shot', task.fireAt ? formatTime(task.fireAt) : undefined],
      ['worktree', task.useWorktree ? `yes (${task.sourceBranch ?? 'default branch'})` : undefined],
    ]),
    el('form', { id: 'drawer-form' },
      field('Display name', el('input', { name: 'displayName', value: task.displayName ?? '' })),
      task.cronExpression !== undefined || !task.fireAt
        ? cronField('cronExpression', task.cronExpression, { utc: false })
        : null,
      field('Model', el('input', { name: 'model', value: task.model ?? '', list: 'models' })),
      field(
        'Working directory',
        el(
          'div',
          { class: 'field-row' },
          el('input', { name: 'cwd', value: task.cwd ?? '', spellcheck: 'false' }),
          el('button', { type: 'button', dataset: { action: 'pick-cwd', target: 'cwd' } }, 'Browse…'),
        ),
      ),
      field('Prompt (SKILL.md body)', el('textarea', { name: 'promptBody' }, promptBody)),
      el('div', { class: 'form-error' }),
      el(
        'div',
        { class: 'drawer-actions' },
        el('button', { type: 'submit', class: 'primary' }, 'Save'),
        el('button', { type: 'button', dataset: { action: 'move-start', direction: 'l2c', id: task.id } }, 'Move to Cloud…'),
      ),
    ),
  );
}

function environmentSelect(name, environments, currentId) {
  const options = environments.map((e) => e.id).includes(currentId)
    ? environments
    : [...environments, { id: currentId, name: currentId }]; // stale/unknown env still selectable
  return el(
    'select',
    { name },
    options.map((e) => el('option', { value: e.id, selected: e.id === currentId }, e.name)),
  );
}

/** Drawer for a cloud trigger. `data` = TriggerVM. */
export function cloudDrawer(trigger, environments) {
  return el(
    'div',
    {},
    el(
      'div',
      { class: 'drawer-head' },
      el('h2', {}, trigger.name || trigger.id),
      el('button', { type: 'button', dataset: { action: 'drawer-close' } }, 'Close'),
    ),
    kvList([
      ['id', trigger.id],
      ['repo', trigger.repoUrl],
      ['allowed tools', trigger.allowedTools.join(', ')],
      ['MCP', trigger.mcpConnections.map((c) => c.name).join(', ')],
      ['last fired', formatTime(trigger.lastFiredAt)],
      ['next run', formatTime(trigger.nextRunAt)],
      ['one-shot', trigger.runOnceAt ? formatTime(trigger.runOnceAt) : undefined],
      ['status', trigger.endedReason === 'run_once_fired' ? 'already fired' : undefined],
    ]),
    el('form', { id: 'drawer-form' },
      field('Name', el('input', { name: 'name', value: trigger.name ?? '' })),
      trigger.cronExpression ? cronField('cronExpression', trigger.cronExpression, { utc: true }) : null,
      field('Environment', environmentSelect('environmentId', environments, trigger.environmentId)),
      field('Model', el('input', { name: 'model', value: trigger.model ?? '', list: 'models' })),
      field('Prompt', el('textarea', { name: 'prompt' }, trigger.prompt)),
      el('div', { class: 'form-error' }),
      el(
        'div',
        { class: 'drawer-actions' },
        el('button', { type: 'submit', class: 'primary' }, 'Save'),
        el('button', { type: 'button', dataset: { action: 'run-cloud', id: trigger.id } }, 'Run now'),
        el('button', { type: 'button', dataset: { action: 'move-start', direction: 'c2l', id: trigger.id } }, 'Move to Local…'),
        el(
          'button',
          {
            type: 'button',
            class: 'link',
            dataset: { action: 'open-url', url: `https://claude.ai/code/routines/${trigger.id}` },
          },
          'Open at claude.ai ↗',
        ),
      ),
    ),
  );
}

function schedulePreviewCols(nextRuns, sourceLabel, targetLabel) {
  const list = (items) =>
    items.length > 0
      ? el('ul', {}, items.map((iso) => el('li', {}, formatTime(iso))))
      : el('div', { class: 'muted' }, '—');
  return el(
    'div',
    { class: 'preview-cols', dataset: { schedulePreview: '' } },
    el('div', {}, el('h4', {}, sourceLabel), list(nextRuns.source)),
    el('div', {}, el('h4', {}, targetLabel), list(nextRuns.target)),
  );
}

/** Move dialog, cloud -> local. */
export function moveCloudToLocalDialog(preview, { triggerId }) {
  const cwdListId = 'cwd-suggestions';
  return el('form', { id: 'modal-form', dataset: { kind: 'move-c2l', triggerId, fireAt: preview.fireAt } },
    el('h2', {}, `Move "${preview.displayName}" to local`),
    field('New local task id', el('input', { name: 'id', value: preview.suggestedId, spellcheck: 'false' })),
    preview.fireAt
      ? field('Runs once at', el('input', { name: 'fireAt', value: preview.fireAt, disabled: true }))
      : cronField('cronExpression', preview.cron.target ?? '', { utc: false }),
    preview.cron.unsupportedReason
      ? el('div', { class: 'form-error' }, `Could not shift the schedule automatically: ${preview.cron.unsupportedReason}`)
      : null,
    field(
      'Working directory',
      el(
        'div',
        { class: 'field-row' },
        el('input', { name: 'cwd', value: preview.cwdSuggestions[0] ?? '', list: cwdListId, spellcheck: 'false' }),
        el('button', { type: 'button', dataset: { action: 'pick-cwd', target: 'cwd' } }, 'Browse…'),
      ),
    ),
    el('datalist', { id: cwdListId }, preview.cwdSuggestions.map((p) => el('option', { value: p }))),
    field('Model', el('input', { name: 'model', value: preview.model ?? '', list: 'models' })),
    el('label', { class: 'field-row' }, el('input', { type: 'checkbox', name: 'enabled' }), 'Enable the local task immediately'),
    preview.fireAt ? null : schedulePreviewCols(preview.nextRuns, 'Cloud schedule (now)', 'Local schedule (after move)'),
    el('ul', { class: 'warnings' }, preview.warnings.map((w) => el('li', {}, w))),
    el('div', { class: 'form-error', dataset: { formError: '' } }),
    el(
      'div',
      { class: 'dialog-actions' },
      el('button', { type: 'button', dataset: { action: 'modal-close' } }, 'Cancel'),
      el('button', { type: 'submit', class: 'primary' }, 'Move'),
    ),
  );
}

/** Move dialog, local -> cloud. */
export function moveLocalToCloudDialog(preview, { taskId, desktopRunning }) {
  return el('form', { id: 'modal-form', dataset: { kind: 'move-l2c', taskId, runOnceAt: preview.runOnceAt } },
    el('h2', {}, `Move "${preview.name}" to cloud`),
    field('Routine name', el('input', { name: 'name', value: preview.name })),
    preview.runOnceAt
      ? field('Runs once at (UTC)', el('input', { name: 'runOnceAt', value: preview.runOnceAt, disabled: true }))
      : cronField('cronExpression', preview.cron.target ?? '', { utc: true }),
    preview.cron.unsupportedReason
      ? el('div', { class: 'form-error' }, `Could not shift the schedule automatically: ${preview.cron.unsupportedReason}`)
      : null,
    field(
      'Environment',
      el(
        'select',
        { name: 'environmentId' },
        preview.environments.map((e) => el('option', { value: e.id }, e.name)),
      ),
    ),
    field('Git repository URL', el('input', { name: 'repoUrl', value: preview.repoUrlSuggestion ?? '', spellcheck: 'false' })),
    field('Model', el('input', { name: 'model', value: preview.model, list: 'models' })),
    field('Allowed tools (comma-separated)', el('input', { name: 'allowedTools', value: preview.allowedToolsDefault.join(', ') })),
    el('label', { class: 'field-row' }, el('input', { type: 'checkbox', name: 'enabled', checked: true }), 'Enable the cloud routine immediately'),
    desktopRunning
      ? el(
          'label',
          { class: 'field-row' },
          el('input', { type: 'checkbox', name: 'skipDisableLocal', checked: true }),
          'Copy only — Claude Desktop is running, so I’ll disable the local task later',
        )
      : null,
    preview.runOnceAt ? null : schedulePreviewCols(preview.nextRuns, 'Local schedule (now)', 'Cloud schedule (after move)'),
    el('ul', { class: 'warnings' }, preview.warnings.map((w) => el('li', {}, w))),
    el('div', { class: 'form-error', dataset: { formError: '' } }),
    el(
      'div',
      { class: 'dialog-actions' },
      el('button', { type: 'button', dataset: { action: 'modal-close' } }, 'Cancel'),
      el('button', { type: 'submit', class: 'primary' }, 'Move'),
    ),
  );
}

/** Per-step result panel shown after a move attempt. */
export function moveResultPanel({ createdLabel, disableLabel, sourceDisabled, disableError, retryAction, retryId, link }) {
  return el(
    'div',
    { class: 'dialog-body' },
    el('h2', {}, 'Move result'),
    el('div', { class: 'step-result ok' }, `1. ${createdLabel} — OK`),
    sourceDisabled
      ? el('div', { class: 'step-result ok' }, `2. ${disableLabel} — OK`)
      : el('div', { class: 'step-result fail' }, `2. ${disableLabel} — FAILED: ${disableError?.message ?? 'skipped'}`),
    link
      ? el('button', { type: 'button', class: 'link', dataset: { action: 'open-url', url: link } }, link)
      : null,
    el(
      'div',
      { class: 'dialog-actions' },
      !sourceDisabled && retryAction
        ? el('button', { type: 'button', dataset: { action: retryAction, id: retryId } }, 'Retry disable')
        : null,
      el('button', { type: 'button', class: 'primary', dataset: { action: 'modal-close-refresh' } }, 'Done'),
    ),
  );
}

/** Register-orphan dialog. */
export function orphanDialog(orphan) {
  return el('form', { id: 'modal-form', dataset: { kind: 'orphan-import', id: orphan.id } },
    el('h2', {}, `Register "${orphan.id}" as a scheduled task`),
    orphan.description ? el('p', { class: 'muted' }, orphan.description) : null,
    cronField('cronExpression', '0 9 * * 1-5', { utc: false }),
    el('p', { class: 'muted' }, 'Leave the cron empty and set a one-shot time instead, if preferred:'),
    field('One-shot (local time)', el('input', { name: 'fireAt', type: 'datetime-local' })),
    field('Display name', el('input', { name: 'displayName', value: orphan.name ?? '' })),
    field(
      'Working directory',
      el(
        'div',
        { class: 'field-row' },
        el('input', { name: 'cwd', value: '', spellcheck: 'false' }),
        el('button', { type: 'button', dataset: { action: 'pick-cwd', target: 'cwd' } }, 'Browse…'),
      ),
    ),
    field('Model', el('input', { name: 'model', value: '', list: 'models' })),
    el('label', { class: 'field-row' }, el('input', { type: 'checkbox', name: 'enabled' }), 'Enable immediately'),
    el('div', { class: 'form-error', dataset: { formError: '' } }),
    el(
      'div',
      { class: 'dialog-actions' },
      el('button', { type: 'button', dataset: { action: 'modal-close' } }, 'Cancel'),
      el('button', { type: 'submit', class: 'primary' }, 'Register'),
    ),
  );
}
