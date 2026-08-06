'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const translate = require('../src/main/translate');

const V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('buildTriggerCreateBody produces the exact POST shape', () => {
  const uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const body = translate.buildTriggerCreateBody({
    name: 'Weekly Update',
    cronExpression: '0 12 * * 1-5',
    enabled: false,
    environmentId: 'env_011CUMCVPbPNxpy29ChD48AN',
    repoUrl: 'https://github.com/org/repo',
    model: 'claude-sonnet-5',
    allowedTools: ['Bash', 'Read'],
    prompt: 'Do the thing.',
    eventUuid: uuid,
  });
  assert.deepEqual(body, {
    name: 'Weekly Update',
    enabled: false,
    cron_expression: '0 12 * * 1-5',
    job_config: {
      ccr: {
        environment_id: 'env_011CUMCVPbPNxpy29ChD48AN',
        session_context: {
          model: 'claude-sonnet-5',
          sources: [{ git_repository: { url: 'https://github.com/org/repo' } }],
          allowed_tools: ['Bash', 'Read'],
        },
        events: [
          {
            data: {
              uuid,
              session_id: '',
              type: 'user',
              parent_tool_use_id: null,
              message: { content: 'Do the thing.', role: 'user' },
            },
          },
        ],
      },
    },
  });
  assert.match(uuid, V4_RE);
});

test('buildTriggerCreateBody uses run_once_at for one-shots', () => {
  const body = translate.buildTriggerCreateBody({
    name: 'once',
    runOnceAt: '2026-08-01T12:00:00.000Z',
    enabled: true,
    environmentId: 'env_x',
    repoUrl: 'https://github.com/org/repo',
    model: 'claude-sonnet-5',
    allowedTools: [],
    prompt: 'p',
    eventUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  });
  assert.equal(body.run_once_at, '2026-08-01T12:00:00.000Z');
  assert.equal('cron_expression' in body, false);
});

test('triggerToVM maps a realistic trigger', () => {
  const trigger = {
    id: 'trig_01x',
    name: 'DMS Work Loop',
    cron_expression: '0 13-21 * * 1-5',
    run_once_at: '',
    enabled: true,
    ended_reason: '',
    next_run_at: '0001-01-01T00:00:00Z', // API sentinel for "none"
    last_fired_at: '2026-07-29T14:03:43.296846Z',
    mcp_connections: [{ connector_uuid: 'u', name: 'HubSpot', url: 'https://mcp.hubspot.com/anthropic' }],
    job_config: {
      ccr: {
        environment_id: 'env_01C',
        session_context: {
          model: 'claude-opus-5',
          allowed_tools: ['Bash', 'Read'],
          sources: [{ git_repository: { url: 'https://github.com/Org/Repo' } }],
        },
        events: [{ data: { message: { content: 'Examine the board.', role: 'user' } } }],
      },
    },
  };
  const vm = translate.triggerToVM(trigger, new Map([['env_01C', 'Fintegrate Cloud']]));
  assert.deepEqual(vm, {
    id: 'trig_01x',
    name: 'DMS Work Loop',
    cronExpression: '0 13-21 * * 1-5',
    runOnceAt: undefined,
    enabled: true,
    endedReason: undefined,
    model: 'claude-opus-5',
    environmentId: 'env_01C',
    environmentName: 'Fintegrate Cloud',
    repoUrl: 'https://github.com/Org/Repo',
    prompt: 'Examine the board.',
    allowedTools: ['Bash', 'Read'],
    mcpConnections: [{ name: 'HubSpot', url: 'https://mcp.hubspot.com/anthropic' }],
    nextRunAt: undefined,
    lastFiredAt: '2026-07-29T14:03:43.296Z',
  });
});

test('localTaskToVM derives nextRunAt with jitter, and none when disabled or fired', () => {
  const base = { id: 'demo-task', cronExpression: '0 7 * * 1-5', enabled: true, createdAt: 1785272373487 };
  const now = new Date(2026, 6, 29, 6, 0); // Wednesday 06:00 local
  const vm = translate.localTaskToVM(base, { now });
  const expectedBase = new Date(2026, 6, 29, 7, 0).getTime();
  assert.equal(new Date(vm.nextRunAt).getTime(), expectedBase + vm.jitterSeconds * 1000);
  assert.equal(translate.localTaskToVM({ ...base, enabled: false }, { now }).nextRunAt, undefined);
  const fired = { id: 'x', fireAt: '2026-07-01T10:00:00Z', lastRunAt: '2026-07-01T10:00:10Z', enabled: true, createdAt: 1 };
  assert.equal(translate.localTaskToVM(fired, { now }).nextRunAt, undefined);
  const pending = { id: 'x', fireAt: '2026-08-01T10:00:00Z', enabled: true, createdAt: 1 };
  assert.equal(translate.localTaskToVM(pending, { now }).nextRunAt, '2026-08-01T10:00:00.000Z');
});

test('jitterSeconds: deterministic, bounded, clamps, honors disableJitter', () => {
  const now = new Date(2026, 6, 29, 6, 0);
  const daily = { id: 'lrs-bughunt', cronExpression: '0 17 * * 1-5' };
  const a = translate.jitterSeconds(daily, now);
  const b = translate.jitterSeconds(daily, now);
  assert.equal(a, b);
  assert.ok(a >= 0 && a < 600, `daily jitter in [0, 600): ${a}`);
  assert.ok(translate.jitterSeconds({ id: 'x', cronExpression: '*/5 * * * *' }, now) < 4 * 60);
  assert.equal(translate.jitterSeconds({ id: 'x', cronExpression: '* * * * *' }, now), 0);
  assert.equal(translate.jitterSeconds({ ...daily, disableJitter: true }, now), 0);
  assert.equal(translate.jitterSeconds({ id: 'x' }, now), 0);
});

test('slugify + dedupeId', () => {
  assert.equal(translate.slugify('DMS Work Loop'), 'dms-work-loop');
  assert.equal(translate.slugify('LRS - Daily rebase features/net11 to dev'), 'lrs-daily-rebase-features-net11-to-dev');
  assert.equal(translate.slugify('***'), 'routine');
  assert.equal(translate.dedupeId('weekly-update', []), 'weekly-update');
  assert.equal(translate.dedupeId('weekly-update', ['weekly-update']), 'weekly-update-2');
  assert.equal(translate.dedupeId('weekly-update', ['weekly-update', 'weekly-update-2']), 'weekly-update-3');
});

test('validateCloudCron enforces the 1-hour minimum interval', () => {
  assert.equal(translate.validateCloudCron('0 * * * *'), null);
  assert.equal(translate.validateCloudCron('0 12 * * 1-5'), null);
  assert.match(translate.validateCloudCron('*/5 * * * *'), /minimum interval/);
  assert.match(translate.validateCloudCron('0,30 * * * *'), /minimum interval/);
  assert.match(translate.validateCloudCron('bogus'), /5 cron fields/);
});

test('normalizeRepoUrl', () => {
  assert.equal(translate.normalizeRepoUrl('git@github.com:Org/Repo.git'), 'https://github.com/Org/Repo');
  assert.equal(translate.normalizeRepoUrl('https://github.com/org/repo.git'), 'https://github.com/org/repo');
  assert.equal(translate.normalizeRepoUrl('https://github.com/org/repo/'), 'https://github.com/org/repo');
  assert.equal(translate.normalizeRepoUrl('not a url'), undefined);
  assert.equal(translate.normalizeRepoUrl(''), undefined);
});

test('parseSkillMd extracts frontmatter and preserves the body', () => {
  const content = '---\nname: weekly-update\ndescription: Post the weekly update\n---\n\nLook at the commits.\n\n- item\n';
  const { frontmatter, body } = translate.parseSkillMd(content);
  assert.deepEqual(frontmatter, { name: 'weekly-update', description: 'Post the weekly update' });
  assert.equal(body, 'Look at the commits.\n\n- item\n');
});

test('parseSkillMd tolerates CRLF and missing frontmatter', () => {
  const crlf = '---\r\nname: a\r\ndescription: b\r\n---\r\nBody here.';
  assert.equal(translate.parseSkillMd(crlf).frontmatter.name, 'a');
  assert.equal(translate.parseSkillMd(crlf).body, 'Body here.');
  const bare = 'no frontmatter at all';
  assert.equal(translate.parseSkillMd(bare).body, bare);
  assert.equal(translate.parseSkillMd(bare).frontmatter.name, undefined);
});

test('buildSkillMd -> parseSkillMd round-trips the body', () => {
  const built = translate.buildSkillMd({ name: 'demo', description: 'multi\nline desc', body: 'Prompt body.\n\nMore.' });
  const { frontmatter, body } = translate.parseSkillMd(built);
  assert.deepEqual(frontmatter, { name: 'demo', description: 'multi line desc' });
  assert.equal(body, 'Prompt body.\n\nMore.\n');
});

test('replaceSkillBody preserves a complex frontmatter block byte-for-byte', () => {
  const frontmatter = [
    '---\r\n',
    '# keep this comment\r\n',
    'name: "alpha"\r\n',
    "description: 'quoted: value'\r\n",
    'instructions: |\r\n',
    '  first line\r\n',
    '  second line\r\n',
    'unknown-key: [one, two]\r\n',
    '---',
  ].join('');
  const original = `${frontmatter}\r\n\r\nOld body.\r\n`;
  assert.equal(translate.replaceSkillBody(original, 'New body.'), `${frontmatter}\r\n\r\nNew body.\r\n`);
});

test('replaceSkillBody ignores an indented delimiter inside a YAML block scalar', () => {
  const frontmatter = [
    '---\n',
    'name: alpha\n',
    'description: block scalar delimiter\n',
    'instructions: |\n',
    '  first line\n',
    '  ---\n',
    '  still part of the scalar\n',
    'unknown-key: keep-me\n',
    '---',
  ].join('');
  const original = `${frontmatter}\n\nOld body.\n`;

  assert.equal(translate.replaceSkillBody(original, 'New body.'), `${frontmatter}\n\nNew body.\n`);
});

test('replaceSkillBody declines files without a complete frontmatter block', () => {
  assert.equal(translate.replaceSkillBody('Bare body.', 'New body.'), null);
  assert.equal(translate.replaceSkillBody('---\nname: alpha\nNo closing delimiter', 'New body.'), null);
});

test('buildTriggerDuplicateBody reuses job_config with fresh event identity', () => {
  const trigger = {
    id: 'trg_1',
    name: 'Original',
    cron_expression: '0 13 * * 1',
    enabled: true,
    mcp_connections: [{ name: 'linear', url: 'https://mcp.linear.app' }],
    job_config: {
      ccr: {
        environment_id: 'env_1',
        session_context: { model: 'claude-opus-5', sources: [{ git_repository: { url: 'https://github.com/o/r' } }] },
        events: [{ data: { uuid: 'old-uuid', session_id: 'sess_1', message: { content: 'Do the thing', role: 'user' } } }],
      },
      unknownBlock: { keepMe: true },
    },
  };
  const body = translate.buildTriggerDuplicateBody(trigger, {
    name: 'Original (copy)',
    cronExpression: '0 15 * * 1',
    enabled: false,
    newUuid: () => 'new-uuid',
  });
  assert.equal(body.name, 'Original (copy)');
  assert.equal(body.enabled, false);
  assert.equal(body.cron_expression, '0 15 * * 1');
  assert.equal(body.run_once_at, undefined);
  assert.equal(body.job_config.ccr.environment_id, 'env_1');
  assert.equal(body.job_config.ccr.events[0].data.message.content, 'Do the thing');
  assert.equal(body.job_config.ccr.events[0].data.uuid, 'new-uuid');
  assert.equal(body.job_config.ccr.events[0].data.session_id, '');
  assert.deepEqual(body.job_config.unknownBlock, { keepMe: true });
  assert.equal(body.mcp_connections, undefined);
  // the source object must not be mutated
  assert.equal(trigger.job_config.ccr.events[0].data.uuid, 'old-uuid');
});

test('buildTriggerDuplicateBody carries a one-shot schedule', () => {
  const body = translate.buildTriggerDuplicateBody(
    { job_config: { ccr: { events: [] } } },
    { name: 'copy', runOnceAt: '2026-08-01T10:00:00.000Z', enabled: true },
  );
  assert.equal(body.run_once_at, '2026-08-01T10:00:00.000Z');
  assert.equal(body.cron_expression, undefined);
  assert.equal(body.enabled, true);
});

test('renameSkillName rewrites only the name: line, preserving everything else', () => {
  const content = '---\nname: alpha\ndescription: b\nextra: keep-me\n---\n\n  Indented body.\n';
  const renamed = translate.renameSkillName(content, 'beta');
  assert.equal(renamed, content.replace('name: alpha', 'name: beta'));
});

test('renameSkillName preserves CRLF line endings', () => {
  const content = '---\r\nname: alpha\r\ndescription: b\r\n---\r\nBody.';
  const renamed = translate.renameSkillName(content, 'beta');
  assert.equal(renamed, content.replace('name: alpha', 'name: beta'));
});

test('renameSkillName preserves mixed line endings within a single file', () => {
  const content = '---\r\nname: alpha\ndescription: b\r\nextra: keep-me\n---\r\nBody.\n';
  const renamed = translate.renameSkillName(content, 'beta');
  assert.equal(renamed, content.replace('name: alpha', 'name: beta'));
  assert.match(renamed, /^---\r\nname: beta\ndescription: b\r\nextra: keep-me\n---\r\nBody\.\n$/);
});

test('renameSkillName is a no-op without frontmatter or a name: line', () => {
  const noFrontmatter = 'no frontmatter here';
  assert.equal(translate.renameSkillName(noFrontmatter, 'beta'), noFrontmatter);
  const noNameField = '---\ndescription: b\n---\nBody.';
  assert.equal(translate.renameSkillName(noNameField, 'beta'), noNameField);
});
