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
const MAX_TRIGGER_PAGES = 25;

function createCloudApi({ oauth, fetchImpl = fetch } = {}) {
  async function send(method, apiPath, accessToken, { body, beta } = {}) {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
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
    let accessToken = await oauth.getAccessToken();
    let response = await send(method, apiPath, accessToken, options);
    if (response.status === 401) {
      // The token may have just expired (or been rotated by the CLI); refresh once and retry.
      accessToken = await oauth.getAccessToken({ force: true });
      response = await send(method, apiPath, accessToken, options);
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

  const completeTriggerList = (pagesFetched) => ({
    complete: true,
    reason: null,
    warning: null,
    pagesFetched,
  });

  const incompleteTriggerList = (reason, warning, pagesFetched) => ({
    complete: false,
    reason,
    warning,
    pagesFetched,
  });

  /**
   * Returns every fetched trigger plus status metadata. `status.warning` is
   * ready for display when malformed pagination or the safety bound makes the
   * result incomplete.
   */
  async function listTriggers() {
    const allTriggers = [];
    const seenCursors = new Set();
    let cursor;

    for (let page = 0; page < MAX_TRIGGER_PAGES; page++) {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const data = await request('GET', triggers(query), { beta: TRIGGERS_BETA });
      const pagesFetched = page + 1;
      const batch = data.data;

      if (!Array.isArray(batch)) {
        return {
          triggers: allTriggers,
          status: incompleteTriggerList(
            'malformed-pagination',
            'Cloud routines list is incomplete because the API returned malformed pagination data.',
            pagesFetched,
          ),
        };
      }
      allTriggers.push(...batch);

      if (data.has_more === false) {
        return { triggers: allTriggers, status: completeTriggerList(pagesFetched) };
      }
      if (
        data.has_more !== true ||
        typeof data.next_cursor !== 'string' ||
        data.next_cursor === '' ||
        batch.length === 0 ||
        seenCursors.has(data.next_cursor)
      ) {
        return {
          triggers: allTriggers,
          status: incompleteTriggerList(
            'malformed-pagination',
            'Cloud routines list is incomplete because the API returned malformed pagination data.',
            pagesFetched,
          ),
        };
      }

      seenCursors.add(data.next_cursor);
      cursor = data.next_cursor;
    }

    return {
      triggers: allTriggers,
      status: incompleteTriggerList(
        'page-limit',
        `Cloud routines list is incomplete because the safety limit of ${MAX_TRIGGER_PAGES} pages was reached.`,
        MAX_TRIGGER_PAGES,
      ),
    };
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
