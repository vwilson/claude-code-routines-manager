'use strict';

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOauth } = require('../src/main/oauth');

const FIXED_NOW = Date.parse('2026-07-29T12:00:00.000Z');
const tempRoots = [];

function credentialsFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrm-oauth-test-'));
  tempRoots.push(root);
  const credentialsPath = path.join(root, '.credentials.json');
  fs.writeFileSync(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'rejected-access-token',
        refreshToken: 'old-refresh-token',
        expiresAt: FIXED_NOW + 60 * 60 * 1000,
        scopes: ['user:inference'],
      },
      mcpOAuth: { preserved: true },
      unknownTopLevel: 'keep-me',
    }),
  );
  return { credentialsPath };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('forced refresh rotates an unexpired but rejected access token', async () => {
  const { credentialsPath } = credentialsFixture();
  const requests = [];
  const oauth = createOauth({
    credentialsPath,
    now: () => FIXED_NOW,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        async json() {
          return {
            access_token: 'rotated-access-token',
            refresh_token: 'rotated-refresh-token',
            expires_in: 7200,
          };
        },
      };
    },
  });

  assert.equal(await oauth.getAccessToken(), 'rejected-access-token');
  assert.equal(requests.length, 0);

  assert.equal(await oauth.getAccessToken({ force: true }), 'rotated-access-token');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://platform.claude.com/v1/oauth/token');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    grant_type: 'refresh_token',
    client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    refresh_token: 'old-refresh-token',
  });

  const saved = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  assert.equal(saved.claudeAiOauth.accessToken, 'rotated-access-token');
  assert.equal(saved.claudeAiOauth.refreshToken, 'rotated-refresh-token');
  assert.equal(saved.claudeAiOauth.expiresAt, FIXED_NOW + 7200 * 1000);
  assert.deepEqual(saved.claudeAiOauth.scopes, ['user:inference']);
  assert.deepEqual(saved.mcpOAuth, { preserved: true });
  assert.equal(saved.unknownTopLevel, 'keep-me');
});

test('forced refresh reuses a different valid token already rotated on disk', async () => {
  const { credentialsPath } = credentialsFixture();
  const file = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  file.claudeAiOauth.accessToken = 'cli-rotated-access-token';
  file.claudeAiOauth.refreshToken = 'cli-rotated-refresh-token';
  fs.writeFileSync(credentialsPath, JSON.stringify(file));

  let refreshRequests = 0;
  const oauth = createOauth({
    credentialsPath,
    now: () => FIXED_NOW,
    fetchImpl: async () => {
      refreshRequests++;
      throw new Error('the token endpoint should not be called');
    },
  });

  assert.equal(
    await oauth.getAccessToken({ force: true, rejectedAccessToken: 'rejected-access-token' }),
    'cli-rotated-access-token',
  );
  assert.equal(refreshRequests, 0);
});

test('forced refresh failure is reported and leaves credentials unchanged', async () => {
  const { credentialsPath } = credentialsFixture();
  const before = fs.readFileSync(credentialsPath, 'utf8');
  let refreshRequests = 0;
  const oauth = createOauth({
    credentialsPath,
    now: () => FIXED_NOW,
    fetchImpl: async () => {
      refreshRequests++;
      return { ok: false, status: 400 };
    },
  });

  await assert.rejects(
    oauth.getAccessToken({ force: true }),
    (err) =>
      err.code === 'AUTH_REFRESH_FAILED' &&
      err.detail === 'token endpoint returned 400' &&
      err.message.includes('log in again'),
  );
  assert.equal(refreshRequests, 1);
  assert.equal(fs.readFileSync(credentialsPath, 'utf8'), before);

  await assert.rejects(
    oauth.getAccessToken({ force: true }),
    (err) => err.code === 'AUTH_REFRESH_FAILED' && err.detail.includes('backing off'),
  );
  assert.equal(refreshRequests, 1);
});
