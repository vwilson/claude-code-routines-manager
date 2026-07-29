'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { AppError } = require('../src/main/errors');
const { createCloudApi } = require('../src/main/cloud-api');

function response(status, body, statusText = '') {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText,
    async text() {
      return body === undefined ? '' : JSON.stringify(body);
    },
  };
}

function oauthStub(getAccessToken = async () => 'access-token') {
  return {
    getAccessToken,
    getOrgUuid: () => 'org-uuid',
  };
}

test('401 forces token rotation and retries the request once with the rotated token', async () => {
  const tokenCalls = [];
  const oauth = oauthStub(async (options = {}) => {
    tokenCalls.push(options);
    return options.force ? 'rotated-token' : 'rejected-token';
  });
  const requests = [];
  const api = createCloudApi({
    oauth,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return requests.length === 1
        ? response(401, { error: { message: 'expired' } })
        : response(200, { trigger: { id: 'trigger-1' } });
    },
  });

  assert.deepEqual(await api.getTrigger('trigger-1'), { id: 'trigger-1' });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer rejected-token');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer rotated-token');
  assert.deepEqual(tokenCalls, [{}, { force: true }]);
});

test('refresh failure after a 401 prevents a retry', async () => {
  const oauth = oauthStub(async (options = {}) => {
    if (options.force) {
      throw new AppError('AUTH_REFRESH_FAILED', 'refresh failed');
    }
    return 'rejected-token';
  });
  let requests = 0;
  const api = createCloudApi({
    oauth,
    fetchImpl: async () => {
      requests++;
      return response(401, { error: { message: 'expired' } });
    },
  });

  await assert.rejects(
    api.getTrigger('trigger-1'),
    (err) => err.code === 'AUTH_REFRESH_FAILED' && err.message === 'refresh failed',
  );
  assert.equal(requests, 1);
});

test('a repeated 401 is returned after exactly one retry', async () => {
  const tokenCalls = [];
  const oauth = oauthStub(async (options = {}) => {
    tokenCalls.push(options);
    return options.force ? 'rotated-token' : 'rejected-token';
  });
  let requests = 0;
  const api = createCloudApi({
    oauth,
    fetchImpl: async () => {
      requests++;
      return response(401, { error: { message: 'still unauthorized' } }, 'Unauthorized');
    },
  });

  await assert.rejects(
    api.getTrigger('trigger-1'),
    (err) => err.code === 'HTTP_401' && err.message.includes('still unauthorized'),
  );
  assert.equal(requests, 2);
  assert.deepEqual(tokenCalls, [{}, { force: true }]);
});

test('listTriggers follows every cursor and reports a complete result', async () => {
  const urls = [];
  const pages = [
    { data: [{ id: 'trigger-1' }], has_more: true, last_id: 'cursor one' },
    { data: [{ id: 'trigger-2' }], has_more: false },
  ];
  const api = createCloudApi({
    oauth: oauthStub(),
    fetchImpl: async (url) => {
      urls.push(url);
      return response(200, pages.shift());
    },
  });

  assert.deepEqual(await api.listTriggers(), {
    triggers: [{ id: 'trigger-1' }, { id: 'trigger-2' }],
    status: {
      complete: true,
      reason: null,
      warning: null,
      pagesFetched: 2,
    },
  });
  assert.deepEqual(urls, [
    'https://api.anthropic.com/v1/code/triggers',
    'https://api.anthropic.com/v1/code/triggers?after_id=cursor%20one',
  ]);
});

test('listTriggers reports malformed pagination instead of silently truncating', async (t) => {
  const cases = [
    {
      name: 'missing cursor',
      pages: [{ data: [{ id: 'trigger-1' }], has_more: true }],
      expectedTriggers: [{ id: 'trigger-1' }],
      expectedRequests: 1,
    },
    {
      name: 'empty page with more pages claimed',
      pages: [{ data: [], has_more: true, last_id: 'cursor-1' }],
      expectedTriggers: [],
      expectedRequests: 1,
    },
    {
      name: 'repeated cursor',
      pages: [
        { data: [{ id: 'trigger-1' }], has_more: true, last_id: 'cursor-1' },
        { data: [{ id: 'trigger-2' }], has_more: true, last_id: 'cursor-1' },
      ],
      expectedTriggers: [{ id: 'trigger-1' }, { id: 'trigger-2' }],
      expectedRequests: 2,
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      let requests = 0;
      const pages = structuredClone(testCase.pages);
      const api = createCloudApi({
        oauth: oauthStub(),
        fetchImpl: async () => {
          requests++;
          return response(200, pages.shift());
        },
      });

      const result = await api.listTriggers();
      assert.deepEqual(result.triggers, testCase.expectedTriggers);
      assert.deepEqual(result.status, {
        complete: false,
        reason: 'malformed-pagination',
        warning: 'Cloud routines list is incomplete because the API returned malformed pagination data.',
        pagesFetched: testCase.expectedRequests,
      });
      assert.equal(requests, testCase.expectedRequests);
    });
  }
});

test('listTriggers reports when the defensive page bound is reached', async () => {
  let requests = 0;
  const api = createCloudApi({
    oauth: oauthStub(),
    fetchImpl: async () => {
      requests++;
      return response(200, {
        data: [{ id: `trigger-${requests}` }],
        has_more: true,
        last_id: `cursor-${requests}`,
      });
    },
  });

  const result = await api.listTriggers();
  assert.equal(result.triggers.length, 25);
  assert.deepEqual(result.status, {
    complete: false,
    reason: 'page-limit',
    warning: 'Cloud routines list is incomplete because the safety limit of 25 pages was reached.',
    pagesFetched: 25,
  });
  assert.equal(requests, 25);
});
