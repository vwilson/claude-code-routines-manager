'use strict';

// Owns every read of ~/.claude/.credentials.json and the OAuth refresh flow.
// Tokens never leave this module except as the Authorization header value handed
// to cloud-api. The refresh endpoint ROTATES both tokens, so a successful refresh
// must be written back atomically (preserving mcpOAuth and any unknown keys) or
// the Claude Code CLI's own session breaks.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppError } = require('./errors');
const { atomicWriteFile, readJsonWithRetry } = require('./fsx');

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // public, hardcoded in the Claude Code CLI
const EXPIRY_MARGIN_MS = 60_000;
const FAILURE_BACKOFF_MS = 30_000;

const RELOGIN_MESSAGE =
  'Cloud authorization could not be refreshed — run any `claude` command in a terminal to log in again, then refresh here.';

function createOauth({
  credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json'),
  claudeJsonPath = path.join(os.homedir(), '.claude.json'),
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  let refreshInFlight = null;
  let failedUntil = 0;
  let cachedOrgUuid;

  async function readCredentialsFile() {
    const parsed = await readJsonWithRetry(credentialsPath, { attempts: 2, delayMs: 100 });
    if (!parsed || typeof parsed.claudeAiOauth !== 'object' || parsed.claudeAiOauth === null) {
      throw new AppError('AUTH_REFRESH_FAILED', `no claudeAiOauth entry in ${credentialsPath} — log in with the claude CLI first.`);
    }
    return parsed;
  }

  async function refresh() {
    // Re-read right before refreshing: the CLI may have rotated the tokens already,
    // in which case refreshing with our stale refresh_token would fail.
    const file = await readCredentialsFile();
    const oauth = file.claudeAiOauth;
    if (oauth.expiresAt - now() > EXPIRY_MARGIN_MS) return oauth.accessToken;

    let response;
    try {
      response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-beta': 'oauth-2025-04-20',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: CLIENT_ID,
          refresh_token: oauth.refreshToken,
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new AppError('NETWORK', `token refresh failed: ${err.message}`);
    }
    if (!response.ok) {
      failedUntil = now() + FAILURE_BACKOFF_MS;
      throw new AppError('AUTH_REFRESH_FAILED', RELOGIN_MESSAGE, `token endpoint returned ${response.status}`);
    }
    const tokens = await response.json();
    if (!tokens.access_token || !tokens.refresh_token || !Number.isFinite(tokens.expires_in)) {
      failedUntil = now() + FAILURE_BACKOFF_MS;
      throw new AppError('AUTH_REFRESH_FAILED', RELOGIN_MESSAGE, 'token endpoint returned an unexpected shape');
    }

    file.claudeAiOauth = {
      ...oauth,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: now() + tokens.expires_in * 1000,
    };
    await atomicWriteFile(credentialsPath, JSON.stringify(file, null, 2));
    return tokens.access_token;
  }

  /**
   * A currently-valid access token, refreshing (single-flight) when it is within
   * a minute of expiry. `force` skips the validity shortcut after a 401.
   */
  async function getAccessToken({ force = false } = {}) {
    if (!force) {
      const { claudeAiOauth } = await readCredentialsFile();
      if (claudeAiOauth.expiresAt - now() > EXPIRY_MARGIN_MS) return claudeAiOauth.accessToken;
    }
    if (now() < failedUntil) {
      throw new AppError('AUTH_REFRESH_FAILED', RELOGIN_MESSAGE, 'previous refresh attempt failed; backing off');
    }
    if (!refreshInFlight) {
      refreshInFlight = refresh().finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  }

  /** Org UUID from ~/.claude.json (read-only; required for the x-organization-uuid header). */
  function getOrgUuid() {
    if (cachedOrgUuid !== undefined) return cachedOrgUuid;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    } catch (err) {
      throw new AppError('IO', `cannot read ${claudeJsonPath}: ${err.message}`);
    }
    const uuid = parsed?.oauthAccount?.organizationUuid;
    if (typeof uuid !== 'string' || uuid === '') {
      throw new AppError('AUTH_REFRESH_FAILED', `no oauthAccount.organizationUuid in ${claudeJsonPath} — log in with the claude CLI first.`);
    }
    cachedOrgUuid = uuid;
    return cachedOrgUuid;
  }

  return { getAccessToken, getOrgUuid };
}

module.exports = { createOauth };
