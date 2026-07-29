'use strict';

// Pure mapping layer between the three shapes: local registry task, cloud trigger,
// and the sanitized view models the renderer sees. No IO.

const crypto = require('node:crypto');
const cron = require('./cron');

const LOCAL_ID_RE = /^[a-z0-9_-]+$/; // the desktop app silently drops ids that don't match
const DEFAULT_ALLOWED_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];
const FALLBACK_CLOUD_MODEL = 'claude-sonnet-5';

/** Local->UTC hour offset (Chicago in summer: +5). UTC->local is its negation. */
function localToUtcOffsetHours(now = new Date()) {
  const minutes = now.getTimezoneOffset();
  return minutes % 60 === 0 ? minutes / 60 : null;
}

function toIso(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const d = new Date(value); // tolerates epoch ms and ISO strings
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Mirrors the desktop app: sha256(id) % (min(10, interval-1) minutes), 0 when disabled. */
function jitterSeconds(task, now = new Date()) {
  if (task.disableJitter || !task.cronExpression) return 0;
  let interval;
  try {
    interval = cron.minIntervalMinutes(task.cronExpression, { from: now });
  } catch {
    return 0;
  }
  const maxMinutes = Math.min(10, interval - 1);
  if (!(maxMinutes > 0)) return 0;
  const hash = crypto.createHash('sha256').update(task.id).digest();
  return hash.readUInt32BE(0) % (maxMinutes * 60);
}

/** Mirrors the desktop app: an un-run fireAt wins, else next cron occurrence + jitter. */
function nextRunAt(task, now = new Date()) {
  if (!task.enabled) return undefined;
  if (task.fireAt) return task.lastRunAt ? undefined : toIso(task.fireAt);
  if (!task.cronExpression) return undefined;
  let next;
  try {
    [next] = cron.nextOccurrences(task.cronExpression, { from: now, count: 1 });
  } catch {
    return undefined;
  }
  if (!next) return undefined;
  return new Date(next.getTime() + jitterSeconds(task, now) * 1000).toISOString();
}

function localTaskToVM(task, { description, skillMissing = false, skips = 0, now = new Date() } = {}) {
  return {
    id: task.id,
    displayName: task.displayName,
    cronExpression: task.cronExpression,
    fireAt: toIso(task.fireAt),
    enabled: Boolean(task.enabled),
    model: task.model,
    cwd: task.cwd,
    useWorktree: task.useWorktree,
    sourceBranch: task.sourceBranch,
    createdAt: toIso(task.createdAt),
    lastRunAt: toIso(task.lastRunAt),
    lastScheduledFor: toIso(task.lastScheduledFor),
    description,
    skillMissing,
    skips,
    jitterSeconds: jitterSeconds(task, now),
    nextRunAt: nextRunAt(task, now),
  };
}

/** The API uses "0001-01-01..." as a null timestamp; treat anything pre-2000 as none. */
function apiTimestamp(value) {
  const iso = toIso(value);
  return iso && iso >= '2000' ? iso : undefined;
}

function triggerToVM(trigger, environmentNamesById = new Map()) {
  const ccr = trigger.job_config?.ccr ?? {};
  const sessionContext = ccr.session_context ?? {};
  return {
    id: trigger.id,
    name: trigger.name,
    cronExpression: trigger.cron_expression || undefined,
    runOnceAt: apiTimestamp(trigger.run_once_at),
    enabled: Boolean(trigger.enabled),
    endedReason: trigger.ended_reason || undefined,
    model: sessionContext.model,
    environmentId: ccr.environment_id,
    environmentName: environmentNamesById.get(ccr.environment_id),
    repoUrl: sessionContext.sources?.[0]?.git_repository?.url,
    prompt: ccr.events?.[0]?.data?.message?.content ?? '',
    allowedTools: sessionContext.allowed_tools ?? [],
    mcpConnections: (trigger.mcp_connections ?? []).map((c) => ({ name: c.name, url: c.url })),
    nextRunAt: apiTimestamp(trigger.next_run_at),
    lastFiredAt: apiTimestamp(trigger.last_fired_at),
  };
}

/** The exact POST /v1/code/triggers body for a create. */
function buildTriggerCreateBody({
  name,
  cronExpression,
  runOnceAt,
  enabled,
  environmentId,
  repoUrl,
  model,
  allowedTools,
  prompt,
  eventUuid,
}) {
  const schedule = cronExpression ? { cron_expression: cronExpression } : { run_once_at: runOnceAt };
  return {
    name,
    enabled,
    ...schedule,
    job_config: {
      ccr: {
        environment_id: environmentId,
        session_context: {
          model,
          sources: [{ git_repository: { url: repoUrl } }],
          allowed_tools: allowedTools,
        },
        events: [
          {
            data: {
              uuid: eventUuid,
              session_id: '',
              type: 'user',
              parent_tool_use_id: null,
              message: { content: prompt, role: 'user' },
            },
          },
        ],
      },
    },
  };
}

function slugify(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'routine';
}

function dedupeId(base, existingIds) {
  const existing = new Set(existingIds);
  if (!existing.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!existing.has(candidate)) return candidate;
  }
}

/** Git remote in any common form -> full HTTPS URL without .git, or undefined. */
function normalizeRepoUrl(raw) {
  const value = String(raw ?? '').trim();
  if (value === '') return undefined;
  const ssh = /^git@([^:]+):(.+)$/.exec(value);
  const url = ssh ? `https://${ssh[1]}/${ssh[2]}` : value;
  if (!/^https:\/\/.+\/.+/.test(url)) return undefined;
  return url.replace(/\.git$/, '').replace(/\/+$/, '');
}

/** Cloud crons must fire at most hourly: the minute field must expand to one value. */
function validateCloudCron(expr) {
  let parsed;
  try {
    parsed = cron.parseCron(expr);
  } catch (err) {
    if (err instanceof cron.CronError) return err.reason;
    throw err;
  }
  if (parsed.minute.values.length !== 1) {
    return 'cloud routines require a minimum interval of 1 hour (the minute field must be a single value)';
  }
  return null;
}

/** SKILL.md = simple `---\nname: ...\ndescription: ...\n---` frontmatter + markdown body. */
function parseSkillMd(content) {
  const frontmatter = { name: undefined, description: undefined };
  const lines = String(content).split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { frontmatter, body: String(content) };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { frontmatter, body: String(content) };
  for (const line of lines.slice(1, end)) {
    const m = /^(name|description):\s*(.*)$/.exec(line);
    if (m) frontmatter[m[1]] = m[2].trim();
  }
  const body = lines
    .slice(end + 1)
    .join('\n')
    .replace(/^\n+/, '');
  return { frontmatter, body };
}

function buildSkillMd({ name, description, body }) {
  const oneLineDescription = String(description ?? '')
    .replace(/\s*\r?\n\s*/g, ' ')
    .trim();
  return `---\nname: ${name}\ndescription: ${oneLineDescription}\n---\n\n${String(body).trim()}\n`;
}

module.exports = {
  LOCAL_ID_RE,
  DEFAULT_ALLOWED_TOOLS,
  FALLBACK_CLOUD_MODEL,
  localToUtcOffsetHours,
  toIso,
  jitterSeconds,
  nextRunAt,
  localTaskToVM,
  triggerToVM,
  buildTriggerCreateBody,
  slugify,
  dedupeId,
  normalizeRepoUrl,
  validateCloudCron,
  parseSkillMd,
  buildSkillMd,
};
