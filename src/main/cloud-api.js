'use strict';

// Thin authenticated client for the claude.ai routines ("triggers") API on
// api.anthropic.com. There is deliberately no delete — the API does not offer one;
// deletion happens at https://claude.ai/code/routines.

const { AppError } = require('./errors');

const BASE_URL = 'https://api.anthropic.com';
const TRIGGERS_BETA = 'ccr-triggers-2026-01-30';
const ENVIRONMENTS_BETA = 'environments-2025-11-01';
const USER_AGENT = 'claude-cli/2.1.215 (external, cc-routines-manager)';
const TIMEOUT_MS = 30_000;
const MAX_ENV_PAGES = 5;

function createCloudApi({ oauth, fetchImpl = fetch } = {}) {
  async function send(method, apiPath, { body, beta } = {}) {
    const headers = {
      Authorization: `Bearer ${await oauth.getAccessToken()}`,
      'anthropic-version': '2023-06-01',
      'x-organization-uuid': oauth.getOrgUuid(),
      'User-Agent': USER_AGENT,
    };
    if (beta) headers['anthropic-beta'] = beta;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetchImpl(`${BASE_URL}${apiPath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new AppError('NETWORK', `cannot reach ${BASE_URL}: ${err.message}`);
    }
    return response;
  }

  async function request(method, apiPath, options = {}) {
    let response = await send(method, apiPath, options);
    if (response.status === 401) {
      // The token may have just expired (or been rotated by the CLI); refresh once and retry.
      await oauth.getAccessToken({ force: true });
      response = await send(method, apiPath, options);
    }
    const text = await response.text();
    let parsed;
    try {
      parsed = text === '' ? {} : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const message = parsed?.error?.message ?? response.statusText ?? 'request failed';
      throw new AppError(`HTTP_${response.status}`, `${method} ${apiPath}: ${message}`);
    }
    if (parsed === undefined) {
      throw new AppError('PARSE', `${method} ${apiPath}: response is not JSON`);
    }
    return parsed;
  }

  const triggers = (subPath = '') => `/v1/code/triggers${subPath}`;

  // Single-trigger endpoints wrap the object: { trigger: {...} }.
  const unwrapTrigger = (data) => data.trigger ?? data;

  async function listTriggers() {
    const data = await request('GET', triggers(), { beta: TRIGGERS_BETA });
    return { triggers: data.data ?? [], hasMore: Boolean(data.has_more) };
  }

  async function getTrigger(id) {
    return unwrapTrigger(await request('GET', triggers(`/${id}`), { beta: TRIGGERS_BETA }));
  }

  async function createTrigger(body) {
    return unwrapTrigger(await request('POST', triggers(), { body, beta: TRIGGERS_BETA }));
  }

  async function updateTrigger(id, body) {
    return unwrapTrigger(await request('POST', triggers(`/${id}`), { body, beta: TRIGGERS_BETA }));
  }

  function runTrigger(id) {
    return request('POST', triggers(`/${id}/run`), { body: {}, beta: TRIGGERS_BETA });
  }

  /** All cloud environments (cursor pagination, defensively bounded). */
  async function listEnvironments() {
    const environments = [];
    let afterId;
    for (let page = 0; page < MAX_ENV_PAGES; page++) {
      const query = afterId ? `&after_id=${encodeURIComponent(afterId)}` : '';
      const data = await request('GET', `/v1/environments?beta=true${query}`, { beta: ENVIRONMENTS_BETA });
      const batch = data.data ?? [];
      environments.push(...batch);
      if (!data.has_more || !data.last_id || batch.length === 0) break;
      afterId = data.last_id;
    }
    return environments;
  }

  return { listTriggers, getTrigger, createTrigger, updateTrigger, runTrigger, listEnvironments };
}

module.exports = { createCloudApi };
