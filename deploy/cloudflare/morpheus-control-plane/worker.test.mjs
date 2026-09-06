import test from 'node:test';
import assert from 'node:assert/strict';

import worker, { AutomationExecuteWorkflow, CallbackBroadcastWorkflow } from './worker.mjs';
import {
  assertEdgeSigningKeysAbsent,
  getAppBackendConfig,
  getExecutionPlaneConfig,
} from './lib/execution-plane.js';

function createEnv(overrides = {}) {
  const oracleMessages = [];
  const feedMessages = [];
  return {
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_SECRET_KEY: 'service-role-key',
    MORPHEUS_CONTROL_PLANE_API_KEY: 'control-plane-key',
    MORPHEUS_TESTNET_EXECUTION_BASE_URL: 'https://exec.test',
    MORPHEUS_APP_BACKEND_URL: 'https://app.test',
    MORPHEUS_EXECUTION_TOKEN: 'exec-token',
    MORPHEUS_APP_BACKEND_TOKEN: 'backend-token',
    MORPHEUS_TESTNET_RELAYER_NEO_N3_WIF: '',
    MORPHEUS_MAINNET_RELAYER_NEO_N3_WIF: '',
    MORPHEUS_ORACLE_REQUEST_QUEUE: {
      sent: oracleMessages,
      async send(message) {
        oracleMessages.push(message);
      },
    },
    MORPHEUS_FEED_TICK_QUEUE: {
      sent: feedMessages,
      async send(message) {
        feedMessages.push(message);
      },
    },
    ...overrides,
  };
}

function createState() {
  return {
    jobs: new Map(),
    executionCalls: [],
    backendCalls: [],
    executionResponses: [],
    backendResponses: [],
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('control-plane configuration rejects host WIF/private-key variables', () => {
  assert.throws(
    () =>
      assertEdgeSigningKeysAbsent(
        {
          MORPHEUS_CUSTOM_SIGNER_PRIVATE_KEY: 'host-secret',
        },
        'testnet'
      ),
    /host signing keys must not be configured.*MORPHEUS_CUSTOM_SIGNER_PRIVATE_KEY/i
  );
  assert.doesNotThrow(() =>
    assertEdgeSigningKeysAbsent(
      {
        SIGNER_ROLE_UPDATER_KEY_ID: 'custody/updater',
        MORPHEUS_UPDATER_PUBLIC_KEY: '02public',
      },
      'testnet'
    )
  );
});

test('workflow backend authentication never falls back to the runtime token', () => {
  assert.throws(
    () =>
      getAppBackendConfig({
        MORPHEUS_APP_BACKEND_URL: 'https://app.test',
        MORPHEUS_RUNTIME_TOKEN: 'runtime-only',
      }),
    /workflow backend credential is not configured/i
  );
  assert.throws(
    () =>
      getAppBackendConfig({
        MORPHEUS_APP_BACKEND_URL: 'https://app.test',
        MORPHEUS_WORKFLOW_API_KEY: 'shared-token',
        MORPHEUS_RUNTIME_TOKEN: 'shared-token',
      }),
    /must be independent from runtime data-plane credentials/i
  );
  assert.equal(
    getAppBackendConfig({
      MORPHEUS_APP_BACKEND_URL: 'https://app.test',
      MORPHEUS_WORKFLOW_API_KEY: 'workflow-only',
      MORPHEUS_RUNTIME_TOKEN: 'runtime-only',
    }).token,
    'workflow-only'
  );
});

function parseRequestBody(init = {}) {
  if (!init.body) return null;
  return JSON.parse(String(init.body));
}

function createFetchMock(state) {
  return async (url, init = {}) => {
    const target = new URL(String(url));

    if (
      target.origin === 'https://supabase.test' &&
      target.pathname === '/rest/v1/morpheus_control_plane_jobs'
    ) {
      if (init.method === 'POST') {
        const record = parseRequestBody(init);
        state.jobs.set(record.id, { ...record });
        return jsonResponse(201, [record]);
      }

      const id = target.searchParams.get('id')?.replace(/^eq\./, '') || '';
      const network = target.searchParams.get('network')?.replace(/^eq\./, '') || '';
      if (init.method === 'PATCH') {
        const existing = state.jobs.get(id);
        if (!existing || (network && existing.network !== network)) {
          return jsonResponse(200, []);
        }
        const expectedStatus = target.searchParams.get('status');
        if (
          expectedStatus?.startsWith('eq.') &&
          String(existing.status || '') !== expectedStatus.slice(3)
        ) {
          return jsonResponse(200, []);
        }
        const expectedUpdatedAt = target.searchParams.get('updated_at');
        if (expectedUpdatedAt === 'is.null' && existing.updated_at != null) {
          return jsonResponse(200, []);
        }
        if (
          expectedUpdatedAt?.startsWith('eq.') &&
          String(existing.updated_at || '') !== expectedUpdatedAt.slice(3)
        ) {
          return jsonResponse(200, []);
        }
        const patch = parseRequestBody(init);
        const updated = { ...existing, ...patch };
        state.jobs.set(id, updated);
        return jsonResponse(200, [updated]);
      }

      if (!id) {
        let rows = [...state.jobs.values()];
        if (network) {
          rows = rows.filter((row) => row.network === network);
        }
        const statusIn = target.searchParams.get('status');
        if (statusIn?.startsWith('in.(') && statusIn.endsWith(')')) {
          const statuses = statusIn
            .slice(4, -1)
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);
          rows = rows.filter((row) => statuses.includes(String(row.status || '')));
        }
        rows.sort((left, right) =>
          String(left.created_at || '').localeCompare(String(right.created_at || ''))
        );
        const limit = Number(target.searchParams.get('limit') || rows.length);
        return jsonResponse(200, rows.slice(0, limit));
      }

      const existing = state.jobs.get(id);
      if (!existing || (network && existing.network !== network)) {
        return jsonResponse(200, []);
      }

      return jsonResponse(200, [existing]);
    }

    if (target.origin.startsWith('https://exec')) {
      state.executionCalls.push({
        origin: target.origin,
        path: target.pathname,
        body: parseRequestBody(init),
        headers: Object.fromEntries(new Headers(init.headers || {}).entries()),
      });
      return (
        state.executionResponses.shift() ||
        jsonResponse(200, {
          ok: true,
          route: target.pathname,
          result: 'execution-ok',
        })
      );
    }

    if (target.origin === 'https://app.test') {
      state.backendCalls.push({
        path: target.pathname,
        body: parseRequestBody(init),
        headers: Object.fromEntries(new Headers(init.headers || {}).entries()),
      });
      return (
        state.backendResponses.shift() ||
        jsonResponse(200, {
          ok: true,
          route: target.pathname,
        })
      );
    }

    throw new Error(`unexpected fetch ${target}`);
  };
}

function createQueueMessage(body, attempts = 1) {
  return {
    id: 'msg-1',
    attempts,
    body,
    acked: false,
    retried: false,
    retryDelaySeconds: null,
    ack() {
      this.acked = true;
    },
    retry(options = {}) {
      this.retried = true;
      this.retryDelaySeconds = options.delaySeconds || null;
    },
  };
}

function createWorkflowBinding(initialStatus = { status: 'queued' }) {
  const created = [];
  const instances = new Map();
  return {
    created,
    async create({ id, params }) {
      const details = { ...initialStatus };
      instances.set(id, details);
      created.push({ id, params, details });
      return {
        id,
        async status() {
          return instances.get(id);
        },
      };
    },
    async get(id) {
      if (!instances.has(id)) {
        throw new Error(`workflow instance not found: ${id}`);
      }
      return {
        id,
        async status() {
          return instances.get(id);
        },
      };
    },
    setStatus(id, details) {
      instances.set(id, { ...(instances.get(id) || {}), ...details });
    },
  };
}

function createWorkflowStep() {
  return {
    async do(_label, optionsOrCallback, maybeCallback) {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      return callback();
    },
  };
}

const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
});

test('control plane fails closed when no API keys are configured', async () => {
  const env = createEnv({
    MORPHEUS_CONTROL_PLANE_API_KEY: '',
    MORPHEUS_OPERATOR_API_KEY: '',
    MORPHEUS_PROVIDER_CONFIG_API_KEY: '',
  });

  const response = await worker.fetch(
    new Request('https://control-plane.test/testnet/health', { method: 'GET' }),
    env
  );

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, 'auth_not_configured');
});

test('control plane rejects a configured key that reuses the runtime token value', async () => {
  const env = createEnv({
    MORPHEUS_CONTROL_PLANE_API_KEY: 'shared-token',
    MORPHEUS_OPERATOR_API_KEY: '',
    MORPHEUS_RUNTIME_TOKEN: 'shared-token',
  });

  const response = await worker.fetch(
    new Request('https://control-plane.test/testnet/health', {
      method: 'GET',
      headers: { authorization: 'Bearer shared-token' },
    }),
    env
  );

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, 'auth_credential_collision');
});

test('control plane allows an empty key set only with the explicit anonymous opt-in', async () => {
  const env = createEnv({
    MORPHEUS_CONTROL_PLANE_API_KEY: '',
    MORPHEUS_OPERATOR_API_KEY: '',
    MORPHEUS_PROVIDER_CONFIG_API_KEY: '',
    MORPHEUS_CONTROL_PLANE_ALLOW_ANONYMOUS: '1',
  });

  const response = await worker.fetch(
    new Request('https://control-plane.test/testnet/health', { method: 'GET' }),
    env
  );

  assert.equal(response.status, 200);
});

test('control plane rejects requests with an invalid bearer token', async () => {
  const env = createEnv();

  const response = await worker.fetch(
    new Request('https://control-plane.test/testnet/health', {
      method: 'GET',
      headers: { authorization: 'Bearer not-the-configured-key' },
    }),
    env
  );

  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error, 'unauthorized');
});

test('control plane enqueues oracle request jobs and persists dispatched status', async () => {
  const env = createEnv();
  const state = createState();
  global.fetch = createFetchMock(state);

  const response = await worker.fetch(
    new Request('https://control-plane.test/testnet/oracle/query', {
      method: 'POST',
      headers: {
        authorization: 'Bearer control-plane-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        symbol: 'TWELVEDATA:NEO-USD',
        target_chain: 'neo_n3',
        dedupe_key: 'job-1',
      }),
    }),
    env
  );

  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.status, 'dispatched');
  assert.equal(body.queue, 'oracle_request');
  assert.equal(env.MORPHEUS_ORACLE_REQUEST_QUEUE.sent.length, 1);
  const enqueued = env.MORPHEUS_ORACLE_REQUEST_QUEUE.sent[0];
  assert.equal(enqueued.route, '/oracle/query');
  assert.equal(enqueued.network, 'testnet');
  assert.equal(state.jobs.get(body.id)?.status, 'dispatched');
});

test('feeds/tick reports retirement and never enqueues nor leaks the signer (CP-01)', async () => {
  const env = createEnv();
  const state = createState();
  global.fetch = createFetchMock(state);

  const response = await worker.fetch(
    new Request('https://control-plane.test/testnet/feeds/tick', {
      method: 'POST',
      headers: {
        authorization: 'Bearer control-plane-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ symbol: 'TWELVEDATA:NEO-USD', target_chain: 'neo_n3' }),
    }),
    env
  );

  assert.equal(response.status, 410);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.status, 'retired');
  assert.equal(body.reason, 'feed_publication_owned_by_rust_relayer');
  // The whole point: nothing is enqueued, so the consumer never POSTs the signer
  // WIF + execution token to the retired feed runtime.
  assert.equal(env.MORPHEUS_FEED_TICK_QUEUE.sent.length, 0);
  assert.equal(state.executionCalls.length, 0);
});

test('legacy route dispatches through typed workflow metadata', async () => {
  const env = createEnv();
  const state = createState();
  global.fetch = createFetchMock(state);

  const response = await worker.fetch(
    new Request('https://control-plane.test/testnet/oracle/query', {
      method: 'POST',
      headers: {
        authorization: 'Bearer control-plane-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        provider: 'coinbase-spot',
        symbol: 'NEO-USD',
      }),
    }),
    env
  );

  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.metadata.workflow_id, 'oracle.query');
  assert.equal(body.metadata.workflow_version, 1);
  assert.match(String(body.metadata.execution_id || ''), /^[0-9a-f-]{36}$/i);
  assert.equal(env.MORPHEUS_ORACLE_REQUEST_QUEUE.sent[0].workflow_id, 'oracle.query');
  assert.equal(env.MORPHEUS_ORACLE_REQUEST_QUEUE.sent[0].execution_id, body.metadata.execution_id);
});

test('health route exposes compatibility queues and kernel lanes', async () => {
  const env = createEnv();
  const response = await worker.fetch(
    new Request('https://control-plane.test/testnet/health', {
      method: 'GET',
      headers: {
        authorization: 'Bearer control-plane-key',
      },
    }),
    env
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.queues.oracle_request, true);
  assert.equal(body.workflows.callback_broadcast, false);
  assert.equal(body.kernel_lanes.oracle_request, 'request_dispatch');
  assert.equal(body.kernel_lanes.feed_tick, 'shared_resource_sync');
  assert.equal(body.kernel_lanes.callback_broadcast, 'callback_adapter_broadcast');
  assert.equal(body.kernel_lanes.automation_execute, 'automation_orchestration');
});

test('oracle_request consumer forwards jobs to confidential execution plane', async () => {
  const env = createEnv();
  const state = createState();
  global.fetch = createFetchMock(state);

  state.jobs.set('job-oracle', {
    id: 'job-oracle',
    network: 'testnet',
    queue: 'oracle_request',
    route: '/oracle/query',
    status: 'dispatched',
    payload: {
      symbol: 'TWELVEDATA:NEO-USD',
      target_chain: 'neo_n3',
    },
    metadata: {},
  });

  const message = createQueueMessage({
    job_id: 'job-oracle',
    network: 'testnet',
    queue: 'oracle_request',
  });
  await worker.queue({ queue: 'morpheus-oracle-request', messages: [message] }, env);

  assert.equal(message.acked, true);
  assert.equal(state.executionCalls.length, 1);
  assert.equal(state.executionCalls[0].path, '/oracle/query');
  assert.equal(state.jobs.get('job-oracle')?.status, 'succeeded');
});

test('queue consumer atomically claims a job when duplicate messages race', async () => {
  const env = createEnv();
  const state = createState();
  const baseFetch = createFetchMock(state);
  let jobReads = 0;
  let releaseReads;
  const bothRead = new Promise((resolve) => {
    releaseReads = resolve;
  });
  global.fetch = async (url, init = {}) => {
    const target = new URL(String(url));
    const isJobLoad =
      target.origin === 'https://supabase.test' &&
      target.pathname === '/rest/v1/morpheus_control_plane_jobs' &&
      (init.method || 'GET') === 'GET' &&
      target.searchParams.has('id');
    if (!isJobLoad) return baseFetch(url, init);
    const response = await baseFetch(url, init);
    jobReads += 1;
    if (jobReads === 2) releaseReads();
    if (jobReads < 2) await bothRead;
    return response;
  };

  state.jobs.set('job-duplicate-race', {
    id: 'job-duplicate-race',
    network: 'testnet',
    queue: 'oracle_request',
    route: '/oracle/query',
    status: 'dispatched',
    payload: { symbol: 'TWELVEDATA:NEO-USD', target_chain: 'neo_n3' },
    metadata: {},
    created_at: '2026-08-06T00:00:00.000Z',
    updated_at: '2026-08-06T00:00:00.000Z',
  });

  const body = {
    job_id: 'job-duplicate-race',
    network: 'testnet',
    queue: 'oracle_request',
  };
  const first = createQueueMessage(body);
  const second = createQueueMessage(body);
  second.id = 'msg-2';
  await Promise.all([
    worker.queue({ queue: 'morpheus-oracle-request', messages: [first] }, env),
    worker.queue({ queue: 'morpheus-oracle-request', messages: [second] }, env),
  ]);

  assert.equal(first.acked, true);
  assert.equal(second.acked, true);
  assert.equal(first.retried, false);
  assert.equal(second.retried, false);
  assert.equal(state.executionCalls.length, 1);
  assert.equal(state.jobs.get('job-duplicate-race')?.status, 'succeeded');
});

test('queue consumer retries without executing when the atomic claim store is unavailable', async () => {
  const env = createEnv();
  const state = createState();
  const baseFetch = createFetchMock(state);
  global.fetch = async (url, init = {}) => {
    const target = new URL(String(url));
    const isClaim =
      target.origin === 'https://supabase.test' &&
      target.pathname === '/rest/v1/morpheus_control_plane_jobs' &&
      init.method === 'PATCH' &&
      target.searchParams.has('status') &&
      target.searchParams.has('updated_at');
    if (isClaim) return new Response('temporarily unavailable', { status: 503 });
    return baseFetch(url, init);
  };

  state.jobs.set('job-claim-store-down', {
    id: 'job-claim-store-down',
    network: 'testnet',
    queue: 'oracle_request',
    route: '/oracle/query',
    status: 'dispatched',
    payload: { symbol: 'TWELVEDATA:NEO-USD', target_chain: 'neo_n3' },
    metadata: {},
    created_at: '2026-08-06T00:00:00.000Z',
    updated_at: '2026-08-06T00:00:00.000Z',
  });

  const message = createQueueMessage({
    job_id: 'job-claim-store-down',
    network: 'testnet',
    queue: 'oracle_request',
  });
  await worker.queue({ queue: 'morpheus-oracle-request', messages: [message] }, env);

  assert.equal(message.acked, false);
  assert.equal(message.retried, true);
  assert.equal(state.executionCalls.length, 0);
  assert.equal(state.jobs.get('job-claim-store-down')?.status, 'dispatched');
});

test('feed_tick consumer forwards jobs to confidential execution plane feed route', async () => {
  const env = createEnv();
  const state = createState();
  global.fetch = createFetchMock(state);

  state.jobs.set('job-feed', {
    id: 'job-feed',
    network: 'testnet',
    queue: 'feed_tick',
    route: '/feeds/tick',
    status: 'dispatched',
    payload: {
      target_chain: 'neo_n3',
      symbols: ['TWELVEDATA:NEO-USD'],
    },
    metadata: {},
  });

  const message = createQueueMessage({
    job_id: 'job-feed',
    network: 'testnet',
    queue: 'feed_tick',
  });
  await worker.queue({ queue: 'morpheus-feed-tick', messages: [message] }, env);

  assert.equal(message.acked, true);
  assert.equal(state.executionCalls.length, 1);
  assert.equal(state.executionCalls[0].path, '/oracle/feed');
  // SECURITY (S5): the control plane must never forward signing key material.
  assert.equal(state.executionCalls[0].body.wif, undefined);
  assert.equal(state.executionCalls[0].body.private_key, undefined);
  assert.equal(state.executionCalls[0].body.fast_ack, true);
  assert.equal(state.executionCalls[0].body.wait, false);
  assert.equal(state.jobs.get('job-feed')?.status, 'succeeded');
});

test('feed_tick consumer fails closed when an edge-held Neo N3 signer is configured', async () => {
  const env = createEnv({
    MORPHEUS_MAINNET_EXECUTION_BASE_URL: 'https://exec.test',
    MORPHEUS_MAINNET_RELAYER_NEO_N3_WIF: '',
    MORPHEUS_MAINNET_UPDATER_NEO_N3_WIF: '',
    MORPHEUS_RELAYER_NEO_N3_WIF_MAINNET: '',
    MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET: 'mainnet-rendered-updater-wif',
  });
  const state = createState();
  global.fetch = createFetchMock(state);

  state.jobs.set('job-feed-mainnet', {
    id: 'job-feed-mainnet',
    network: 'mainnet',
    queue: 'feed_tick',
    route: '/feeds/tick',
    status: 'dispatched',
    payload: {
      target_chain: 'neo_n3',
      symbols: ['TWELVEDATA:NEO-USD'],
    },
    metadata: {},
  });

  const message = createQueueMessage({
    job_id: 'job-feed-mainnet',
    network: 'mainnet',
    queue: 'feed_tick',
  });
  await worker.queue({ queue: 'morpheus-feed-tick', messages: [message] }, env);

  // SECURITY (S5): a configured edge WIF is a misconfiguration; the feed lane
  // must fail closed rather than forward key material over the wire.
  assert.equal(message.acked, false);
  assert.equal(state.executionCalls.length, 0);
  assert.notEqual(state.jobs.get('job-feed-mainnet')?.status, 'succeeded');
});

test('feed_tick consumer prefers a dedicated DataFeed execution plane when configured', async () => {
  const env = createEnv({
    MORPHEUS_TESTNET_EXECUTION_BASE_URL: 'https://exec-request.test',
    MORPHEUS_TESTNET_FEED_EXECUTION_BASE_URL: 'https://exec-feed.test',
  });
  const state = createState();
  global.fetch = createFetchMock(state);

  state.jobs.set('job-feed-dedicated', {
    id: 'job-feed-dedicated',
    network: 'testnet',
    queue: 'feed_tick',
    route: '/feeds/tick',
    status: 'dispatched',
    payload: {
      target_chain: 'neo_n3',
      symbols: ['TWELVEDATA:NEO-USD'],
    },
    metadata: {},
  });

  const message = createQueueMessage({
    job_id: 'job-feed-dedicated',
    network: 'testnet',
    queue: 'feed_tick',
  });
  await worker.queue({ queue: 'morpheus-feed-tick', messages: [message] }, env);

  assert.equal(message.acked, true);
  assert.equal(state.executionCalls.length, 1);
  assert.equal(state.executionCalls[0].origin, 'https://exec-feed.test');
  assert.equal(
    state.jobs.get('job-feed-dedicated')?.metadata?.execution_base_url,
    'https://exec-feed.test'
  );
  assert.equal(state.jobs.get('job-feed-dedicated')?.status, 'succeeded');
});

test('oracle_request consumer falls back to the next execution runtime when the first returns retryable status', async () => {
  const env = createEnv({
    MORPHEUS_TESTNET_EXECUTION_BASE_URL: 'https://exec-a.test,https://exec-b.test',
    MORPHEUS_ENVIRONMENT: 'test',
  });
  const state = createState();
  global.fetch = createFetchMock(state);

  state.executionResponses.push(
    jsonResponse(503, { error: 'runtime_unavailable' }),
    jsonResponse(200, { ok: true, route: '/oracle/query', result: 'execution-ok' })
  );

  state.jobs.set('job-oracle-fallback', {
    id: 'job-oracle-fallback',
    network: 'testnet',
    queue: 'oracle_request',
    route: '/oracle/query',
    status: 'dispatched',
    payload: {
      request_id: 'pool-test-1',
      symbol: 'TWELVEDATA:NEO-USD',
      target_chain: 'neo_n3',
    },
    metadata: {},
  });

  const message = createQueueMessage({
    job_id: 'job-oracle-fallback',
    network: 'testnet',
    queue: 'oracle_request',
  });
  await worker.queue({ queue: 'morpheus-oracle-request', messages: [message] }, env);

  assert.equal(message.acked, true);
  assert.equal(state.executionCalls.length, 2);
  assert.notEqual(state.executionCalls[0].origin, state.executionCalls[1].origin);
  assert.equal(state.jobs.get('job-oracle-fallback')?.status, 'succeeded');
});

test('oracle_request consumer falls back when the first runtime wraps a retryable upstream failure in a 400', async () => {
  const env = createEnv({
    MORPHEUS_TESTNET_EXECUTION_BASE_URL: 'https://exec-a.test,https://exec-b.test',
    MORPHEUS_ENVIRONMENT: 'test',
  });
  const state = createState();
  global.fetch = createFetchMock(state);

  state.executionResponses.push(
    jsonResponse(400, { error: 'provider response exceeds max size of 4096 bytes' }),
    jsonResponse(200, { ok: true, route: '/oracle/query', result: 'execution-ok' })
  );

  state.jobs.set('job-oracle-fallback-wrapped', {
    id: 'job-oracle-fallback-wrapped',
    network: 'testnet',
    queue: 'oracle_request',
    route: '/oracle/query',
    status: 'dispatched',
    payload: {
      request_id: 'pool-test-2',
      symbol: 'TWELVEDATA:NEO-USD',
      target_chain: 'neo_n3',
    },
    metadata: {},
  });

  const message = createQueueMessage({
    job_id: 'job-oracle-fallback-wrapped',
    network: 'testnet',
    queue: 'oracle_request',
  });
  await worker.queue({ queue: 'morpheus-oracle-request', messages: [message] }, env);

  assert.equal(message.acked, true);
  assert.equal(state.executionCalls.length, 2);
  assert.notEqual(state.executionCalls[0].origin, state.executionCalls[1].origin);
  assert.equal(state.jobs.get('job-oracle-fallback-wrapped')?.status, 'succeeded');
});

test('production confidential execution rejects multi-origin pools', () => {
  assert.throws(
    () =>
      getExecutionPlaneConfig(
        createEnv({
          MORPHEUS_ENVIRONMENT: 'production',
          MORPHEUS_TESTNET_EXECUTION_BASE_URL: 'https://exec-a.test,https://exec-b.test',
        }),
        'testnet'
      ),
    /exactly one confidential origin in production/
  );
});

test('callbacks/broadcast is a redundant no-op: returns 200 and never enqueues a duplicate host-signed broadcast', async () => {
  const callbackWorkflow = createWorkflowBinding({ status: 'queued' });
  const env = createEnv({
    CALLBACK_BROADCAST_WORKFLOW: callbackWorkflow,
  });
  const state = createState();
  global.fetch = createFetchMock(state);

  const response = await worker.fetch(
    new Request('https://control-plane.test/testnet/callbacks/broadcast', {
      method: 'POST',
      headers: {
        authorization: 'Bearer control-plane-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        target_chain: 'neo_n3',
        request_id: '42',
        success: true,
        result: '{"ok":true}',
        verification_signature: 'abcd',
      }),
    }),
    env
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'noop');
  assert.equal(body.reason, 'callback_lane_redundant_relayer_authoritative');
  // The box relayer's own fulfillment delivers the callback in-TEE; the edge lane
  // must not dispatch a duplicate host-signed broadcast.
  assert.equal(callbackWorkflow.created.length, 0);
});

test('automation/execute fails closed and never invokes the legacy host-side signer', async () => {
  const automationWorkflow = createWorkflowBinding({ status: 'queued' });
  const env = createEnv({
    AUTOMATION_EXECUTE_WORKFLOW: automationWorkflow,
  });
  const state = createState();
  global.fetch = createFetchMock(state);

  const response = await worker.fetch(
    new Request('https://control-plane.test/testnet/automation/execute', {
      method: 'POST',
      headers: {
        authorization: 'Bearer control-plane-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ automation_id: 'automation:neo_n3:test' }),
    }),
    env
  );

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.status, 'unavailable');
  assert.equal(body.reason, 'rust_automation_delivery_unavailable');
  // Until Rust owns the durable execution protocol, the edge lane must neither
  // claim success nor enqueue a host-signed queueAutomationRequest.
  assert.equal(automationWorkflow.created.length, 0);
});

test('callback_broadcast workflow executes app backend callback route', async () => {
  const env = createEnv();
  const state = createState();
  global.fetch = createFetchMock(state);

  state.jobs.set('job-callback', {
    id: 'job-callback',
    network: 'testnet',
    queue: 'callback_broadcast',
    route: '/callbacks/broadcast',
    status: 'dispatched',
    payload: {
      target_chain: 'neo_n3',
      request_id: '42',
      success: true,
      result: '{"ok":true}',
      verification_signature: 'abcd',
    },
    metadata: {},
  });

  const workflow = new CallbackBroadcastWorkflow({}, env);
  const result = await workflow.run(
    {
      payload: {
        job_id: 'job-callback',
        network: 'testnet',
      },
    },
    createWorkflowStep()
  );

  assert.equal(result.ok, true);
  assert.equal(state.backendCalls.length, 1);
  assert.equal(state.backendCalls[0].path, '/api/internal/control-plane/callback-broadcast');
  // CP-01: the control plane must NOT resolve or forward a signing WIF from the edge;
  // the app backend resolves the updater signer from its own env.
  assert.equal(state.backendCalls[0].body.wif, undefined);
  assert.equal(state.backendCalls[0].body.private_key, undefined);
  assert.equal(state.jobs.get('job-callback')?.status, 'succeeded');
});

test('automation_execute workflow executes app backend automation route', async () => {
  const env = createEnv();
  const state = createState();
  global.fetch = createFetchMock(state);

  state.jobs.set('job-automation', {
    id: 'job-automation',
    network: 'testnet',
    queue: 'automation_execute',
    route: '/automation/execute',
    status: 'dispatched',
    payload: {
      automation_id: 'automation:neo_n3:test',
    },
    metadata: {},
  });

  const workflow = new AutomationExecuteWorkflow({}, env);
  const result = await workflow.run(
    {
      payload: {
        job_id: 'job-automation',
        network: 'testnet',
      },
    },
    createWorkflowStep()
  );

  assert.equal(result.ok, true);
  assert.equal(state.backendCalls.length, 1);
  assert.equal(state.backendCalls[0].path, '/api/internal/control-plane/automation-execute');
  // CP-01: the control plane must NOT resolve or forward a signing WIF from the edge;
  // the app backend resolves the updater signer from its own env.
  assert.equal(state.backendCalls[0].body.wif, undefined);
  assert.equal(state.backendCalls[0].body.private_key, undefined);
  assert.equal(state.jobs.get('job-automation')?.status, 'succeeded');
});

test('jobs/recover requeues stale queued and processing jobs', async () => {
  const env = createEnv();
  const state = createState();
  global.fetch = createFetchMock(state);

  state.jobs.set('job-old-queued', {
    id: 'job-old-queued',
    network: 'testnet',
    queue: 'oracle_request',
    route: '/oracle/query',
    status: 'queued',
    payload: { symbol: 'TWELVEDATA:NEO-USD', target_chain: 'neo_n3' },
    metadata: {},
    created_at: '2026-03-22T11:00:00.000Z',
    updated_at: '2026-03-22T11:00:00.000Z',
    run_after: '2026-03-22T11:00:05.000Z',
  });
  state.jobs.set('job-stale-processing', {
    id: 'job-stale-processing',
    network: 'testnet',
    queue: 'feed_tick',
    route: '/feeds/tick',
    status: 'processing',
    payload: { target_chain: 'neo_n3', symbols: ['TWELVEDATA:NEO-USD'] },
    metadata: {},
    created_at: '2026-03-22T11:01:00.000Z',
    updated_at: '2026-03-22T11:01:00.000Z',
    started_at: '2026-03-22T11:01:00.000Z',
  });
  state.jobs.set('job-future', {
    id: 'job-future',
    network: 'testnet',
    queue: 'oracle_request',
    route: '/oracle/query',
    status: 'queued',
    payload: { symbol: 'TWELVEDATA:GAS-USD', target_chain: 'neo_n3' },
    metadata: {},
    created_at: '2099-03-22T11:02:00.000Z',
    updated_at: '2099-03-22T11:02:00.000Z',
    run_after: '2099-03-22T11:12:00.000Z',
  });

  const response = await worker.fetch(
    new Request('https://control-plane.test/testnet/jobs/recover', {
      method: 'POST',
      headers: { authorization: 'Bearer control-plane-key' },
    }),
    env
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.scanned, 2);
  assert.equal(body.requeued_count, 2);
  assert.equal(body.failed_count, 0);
  assert.equal(env.MORPHEUS_ORACLE_REQUEST_QUEUE.sent.length, 1);
  assert.equal(env.MORPHEUS_FEED_TICK_QUEUE.sent.length, 1);
  assert.equal(state.jobs.get('job-old-queued')?.status, 'dispatched');
  assert.equal(state.jobs.get('job-stale-processing')?.status, 'dispatched');
  assert.match(
    String(state.jobs.get('job-old-queued')?.metadata?.last_requeued_at || ''),
    /\d{4}-\d{2}-\d{2}T/
  );
  assert.equal(state.jobs.get('job-future')?.status, 'queued');
});

test('scheduled cron runs the recovery path across both networks', async () => {
  const env = createEnv();
  const state = createState();
  global.fetch = createFetchMock(state);

  state.jobs.set('job-testnet-stale', {
    id: 'job-testnet-stale',
    network: 'testnet',
    queue: 'oracle_request',
    route: '/oracle/query',
    status: 'queued',
    payload: { symbol: 'TWELVEDATA:NEO-USD', target_chain: 'neo_n3' },
    metadata: {},
    created_at: '2026-03-22T11:00:00.000Z',
    updated_at: '2026-03-22T11:00:00.000Z',
    run_after: '2026-03-22T11:00:05.000Z',
  });
  state.jobs.set('job-mainnet-stale', {
    id: 'job-mainnet-stale',
    network: 'mainnet',
    queue: 'feed_tick',
    route: '/feeds/tick',
    status: 'processing',
    payload: { target_chain: 'neo_n3', symbols: ['TWELVEDATA:NEO-USD'] },
    metadata: {},
    created_at: '2026-03-22T11:01:00.000Z',
    updated_at: '2026-03-22T11:01:00.000Z',
    started_at: '2026-03-22T11:01:00.000Z',
  });
  state.jobs.set('job-future-queued', {
    id: 'job-future-queued',
    network: 'testnet',
    queue: 'oracle_request',
    route: '/oracle/query',
    status: 'queued',
    payload: { symbol: 'TWELVEDATA:GAS-USD', target_chain: 'neo_n3' },
    metadata: {},
    created_at: '2099-03-22T11:02:00.000Z',
    updated_at: '2099-03-22T11:02:00.000Z',
    run_after: '2099-03-22T11:12:00.000Z',
  });

  const summaries = await worker.scheduled({}, env);

  assert.equal(summaries.length, 2);
  const byNetwork = Object.fromEntries(summaries.map((summary) => [summary.network, summary]));
  assert.equal(byNetwork.mainnet.requeued_count, 1);
  assert.equal(byNetwork.testnet.requeued_count, 1);
  assert.equal(byNetwork.mainnet.failed_count, 0);
  assert.equal(byNetwork.testnet.failed_count, 0);
  assert.equal(env.MORPHEUS_ORACLE_REQUEST_QUEUE.sent.length, 1);
  assert.equal(env.MORPHEUS_FEED_TICK_QUEUE.sent.length, 1);
  assert.equal(state.jobs.get('job-testnet-stale')?.status, 'dispatched');
  assert.equal(state.jobs.get('job-mainnet-stale')?.status, 'dispatched');
  assert.equal(state.jobs.get('job-future-queued')?.status, 'queued');
  assert.equal(
    state.jobs.get('job-testnet-stale')?.metadata?.requeue_source,
    'control-plane-recover'
  );
});

test('scheduled cron isolates per-network recovery failures', async () => {
  const env = createEnv();
  const state = createState();
  const baseMock = createFetchMock(state);
  global.fetch = async (url, init = {}) => {
    const target = new URL(String(url));
    if (
      target.pathname === '/rest/v1/morpheus_control_plane_jobs' &&
      (target.searchParams.get('network') || '').includes('mainnet') &&
      (init.method || 'GET') === 'GET'
    ) {
      return new Response('mainnet supabase outage', { status: 500 });
    }
    return baseMock(url, init);
  };

  state.jobs.set('job-testnet-recoverable', {
    id: 'job-testnet-recoverable',
    network: 'testnet',
    queue: 'oracle_request',
    route: '/oracle/query',
    status: 'queued',
    payload: { symbol: 'TWELVEDATA:NEO-USD', target_chain: 'neo_n3' },
    metadata: {},
    created_at: '2026-03-22T11:00:00.000Z',
    updated_at: '2026-03-22T11:00:00.000Z',
  });

  const summaries = await worker.scheduled({}, env);

  const byNetwork = Object.fromEntries(summaries.map((summary) => [summary.network, summary]));
  assert.match(String(byNetwork.mainnet.error || ''), /recoverable job list failed/);
  assert.equal(byNetwork.testnet.requeued_count, 1);
  assert.equal(state.jobs.get('job-testnet-recoverable')?.status, 'dispatched');
});

test('jobs/recover preserves active workflow instances instead of redispatching them', async () => {
  const callbackWorkflow = createWorkflowBinding({ status: 'running' });
  const env = createEnv({
    CALLBACK_BROADCAST_WORKFLOW: callbackWorkflow,
  });
  const state = createState();
  global.fetch = createFetchMock(state);

  const workflowInstanceId = 'callback_broadcast:testnet:job-callback-active:1';
  callbackWorkflow.setStatus(workflowInstanceId, { status: 'running' });
  state.jobs.set('job-callback-active', {
    id: 'job-callback-active',
    network: 'testnet',
    queue: 'callback_broadcast',
    route: '/callbacks/broadcast',
    status: 'dispatched',
    payload: {
      target_chain: 'neo_n3',
      request_id: '42',
      success: true,
    },
    metadata: {
      workflow_name: 'callback_broadcast',
      workflow_binding: 'CALLBACK_BROADCAST_WORKFLOW',
      workflow_instance_id: workflowInstanceId,
      workflow_dispatch_count: 1,
    },
    created_at: '2026-03-22T11:00:00.000Z',
    updated_at: '2026-03-22T11:00:00.000Z',
  });

  const response = await worker.fetch(
    new Request('https://control-plane.test/testnet/jobs/recover', {
      method: 'POST',
      headers: { authorization: 'Bearer control-plane-key' },
    }),
    env
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.requeued_count, 0);
  assert.equal(body.skipped_count, 1);
  assert.equal(body.skipped[0].action, 'workflow_active');
  assert.equal(callbackWorkflow.created.length, 0);
  assert.equal(state.jobs.get('job-callback-active')?.status, 'processing');
});

// --- A4: rate-limit backend failure fails closed with 503 ---

test('control plane fails closed with 503 when the Upstash rate-limit backend 5xxs (A4)', async () => {
  const state = createState();
  const baseMock = createFetchMock(state);
  let pipelineCalls = 0;
  global.fetch = async (url, init = {}) => {
    const target = new URL(String(url));
    if (target.pathname.endsWith('/pipeline')) {
      pipelineCalls += 1;
      return new Response(JSON.stringify({ error: 'upstash down' }), { status: 503 });
    }
    return baseMock(url, init);
  };

  const env = createEnv({
    UPSTASH_REDIS_REST_URL: 'https://upstash.test',
    UPSTASH_REDIS_REST_TOKEN: 'upstash-token',
  });

  const response = await worker.fetch(
    new Request('https://control-plane.test/testnet/oracle/query', {
      method: 'POST',
      headers: {
        authorization: 'Bearer control-plane-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ symbol: 'TWELVEDATA:NEO-USD', target_chain: 'neo_n3' }),
    }),
    env
  );

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, 'rate_limit_backend_unavailable');
  assert.equal(body.queue, 'oracle_request');
  assert.equal(pipelineCalls, 1);
  // No job was inserted because we failed closed before the parse/insert path.
  assert.equal(state.jobs.size, 0);
});

// --- B13: oversized request body is rejected with 413 before JSON.parse ---

test('control plane rejects an oversized request body with 413 before parsing (B13)', async () => {
  const state = createState();
  global.fetch = createFetchMock(state);

  // Build a body larger than the configured cap (set a small cap so the test
  // body stays tiny while still exceeding it).
  const env = createEnv({ MORPHEUS_CONTROL_PLANE_MAX_BODY_BYTES: '65536' });
  const oversized = JSON.stringify({ blob: 'x'.repeat(70_000) });

  const response = await worker.fetch(
    new Request('https://control-plane.test/testnet/oracle/query', {
      method: 'POST',
      headers: {
        authorization: 'Bearer control-plane-key',
        'content-type': 'application/json',
      },
      body: oversized,
    }),
    env
  );

  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.error, 'request_body_too_large');
  assert.equal(body.max_bytes, 65536);
  // Rejected before any Supabase insert.
  assert.equal(state.jobs.size, 0);
});

test('control plane rejects an oversized declared content-length with 413 (B13)', async () => {
  const state = createState();
  global.fetch = createFetchMock(state);
  const env = createEnv({ MORPHEUS_CONTROL_PLANE_MAX_BODY_BYTES: '65536' });

  const response = await worker.fetch(
    new Request('https://control-plane.test/testnet/oracle/query', {
      method: 'POST',
      headers: {
        authorization: 'Bearer control-plane-key',
        'content-type': 'application/json',
        'content-length': '200000',
      },
      body: JSON.stringify({ symbol: 'TWELVEDATA:NEO-USD' }),
    }),
    env
  );

  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.error, 'request_body_too_large');
  assert.equal(state.jobs.size, 0);
});

test('control plane still accepts a normal-sized body under the cap (B13)', async () => {
  const state = createState();
  global.fetch = createFetchMock(state);
  const env = createEnv();

  const response = await worker.fetch(
    new Request('https://control-plane.test/testnet/oracle/query', {
      method: 'POST',
      headers: {
        authorization: 'Bearer control-plane-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ symbol: 'TWELVEDATA:NEO-USD', target_chain: 'neo_n3' }),
    }),
    env
  );

  assert.equal(response.status, 202);
});

// --- B5(a): DLQ consumer marks the poison job's row terminal so cron stops re-listing ---

test('dlq consumer marks the poison job dead_lettered and the cron stops re-listing it (B5)', async () => {
  const env = createEnv();
  const state = createState();
  global.fetch = createFetchMock(state);

  state.jobs.set('job-poison', {
    id: 'job-poison',
    network: 'testnet',
    queue: 'oracle_request',
    route: '/oracle/query',
    status: 'queued',
    payload: { symbol: 'TWELVEDATA:NEO-USD', target_chain: 'neo_n3' },
    metadata: {},
    created_at: '2026-03-22T11:00:00.000Z',
    updated_at: '2026-03-22T11:00:00.000Z',
  });

  const message = createQueueMessage({
    job_id: 'job-poison',
    network: 'testnet',
    queue: 'oracle_request',
  });
  await worker.queue({ queue: 'morpheus-oracle-request-dlq', messages: [message] }, env);

  assert.equal(message.acked, true);
  assert.equal(state.jobs.get('job-poison')?.status, 'dead_lettered');
  assert.equal(state.jobs.get('job-poison')?.metadata?.dead_letter_source, 'queue-dlq-consumer');

  // The cron recovery path must no longer list (and thus re-requeue) the row.
  const summaries = await worker.scheduled({}, env);
  const byNetwork = Object.fromEntries(summaries.map((summary) => [summary.network, summary]));
  assert.equal(byNetwork.testnet.scanned, 0);
  assert.equal(byNetwork.testnet.requeued_count, 0);
  assert.equal(env.MORPHEUS_ORACLE_REQUEST_QUEUE.sent.length, 0);
});

test('dlq consumer leaves an already-terminal job untouched (B5)', async () => {
  const env = createEnv();
  const state = createState();
  global.fetch = createFetchMock(state);

  state.jobs.set('job-done', {
    id: 'job-done',
    network: 'testnet',
    queue: 'oracle_request',
    route: '/oracle/query',
    status: 'succeeded',
    payload: {},
    metadata: { existing: true },
    created_at: '2026-03-22T11:00:00.000Z',
    updated_at: '2026-03-22T11:00:00.000Z',
  });

  const message = createQueueMessage({
    job_id: 'job-done',
    network: 'testnet',
    queue: 'oracle_request',
  });
  await worker.queue({ queue: 'morpheus-oracle-request-dlq', messages: [message] }, env);

  assert.equal(message.acked, true);
  // Unchanged: a succeeded job must not be flipped to dead_lettered.
  assert.equal(state.jobs.get('job-done')?.status, 'succeeded');
});

// --- B5(b): recovery requeue ceiling dead-letters poison jobs ---

test('jobs/recover dead-letters a queue job after the requeue ceiling (B5)', async () => {
  const env = createEnv({ MORPHEUS_CONTROL_PLANE_MAX_REQUEUE_ATTEMPTS: '3' });
  const state = createState();
  global.fetch = createFetchMock(state);

  state.jobs.set('job-ceiling', {
    id: 'job-ceiling',
    network: 'testnet',
    queue: 'oracle_request',
    route: '/oracle/query',
    status: 'queued',
    payload: { symbol: 'TWELVEDATA:NEO-USD', target_chain: 'neo_n3' },
    metadata: { requeue_attempts: 3 },
    created_at: '2026-03-22T11:00:00.000Z',
    updated_at: '2026-03-22T11:00:00.000Z',
  });

  const response = await worker.fetch(
    new Request('https://control-plane.test/testnet/jobs/recover', {
      method: 'POST',
      headers: { authorization: 'Bearer control-plane-key' },
    }),
    env
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.requeued_count, 0);
  assert.equal(body.dead_lettered_count, 1);
  assert.equal(state.jobs.get('job-ceiling')?.status, 'dead_lettered');
  // It was NOT re-enqueued.
  assert.equal(env.MORPHEUS_ORACLE_REQUEST_QUEUE.sent.length, 0);
});

test('jobs/recover still requeues a queue job below the ceiling and bumps the attempt counter (B5)', async () => {
  const env = createEnv({ MORPHEUS_CONTROL_PLANE_MAX_REQUEUE_ATTEMPTS: '3' });
  const state = createState();
  global.fetch = createFetchMock(state);

  state.jobs.set('job-under-ceiling', {
    id: 'job-under-ceiling',
    network: 'testnet',
    queue: 'oracle_request',
    route: '/oracle/query',
    status: 'queued',
    payload: { symbol: 'TWELVEDATA:NEO-USD', target_chain: 'neo_n3' },
    metadata: { requeue_attempts: 1 },
    created_at: '2026-03-22T11:00:00.000Z',
    updated_at: '2026-03-22T11:00:00.000Z',
  });

  const response = await worker.fetch(
    new Request('https://control-plane.test/testnet/jobs/recover', {
      method: 'POST',
      headers: { authorization: 'Bearer control-plane-key' },
    }),
    env
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.requeued_count, 1);
  assert.equal(body.dead_lettered_count, 0);
  assert.equal(state.jobs.get('job-under-ceiling')?.status, 'dispatched');
  assert.equal(state.jobs.get('job-under-ceiling')?.metadata?.requeue_attempts, 2);
  assert.equal(env.MORPHEUS_ORACLE_REQUEST_QUEUE.sent.length, 1);
});

test('jobs/recover dead-letters a workflow job at the ceiling instead of redispatching (B5)', async () => {
  // No workflow binding configured for this env, so a recover on a failed
  // workflow job that has no live instance would normally re-dispatch. With the
  // dispatch count already at the ceiling it must be dead-lettered instead.
  const callbackWorkflow = createWorkflowBinding({ status: 'errored' });
  const env = createEnv({
    CALLBACK_BROADCAST_WORKFLOW: callbackWorkflow,
    MORPHEUS_CONTROL_PLANE_MAX_REQUEUE_ATTEMPTS: '3',
  });
  const state = createState();
  global.fetch = createFetchMock(state);

  const instanceId = 'callback_broadcast:testnet:job-wf-ceiling:4';
  callbackWorkflow.setStatus(instanceId, { status: 'errored' });
  state.jobs.set('job-wf-ceiling', {
    id: 'job-wf-ceiling',
    network: 'testnet',
    queue: 'callback_broadcast',
    route: '/callbacks/broadcast',
    status: 'failed',
    payload: { target_chain: 'neo_n3', request_id: '42', success: true },
    metadata: {
      workflow_name: 'callback_broadcast',
      workflow_binding: 'CALLBACK_BROADCAST_WORKFLOW',
      workflow_instance_id: instanceId,
      // dispatch_count 4 => 3 prior recovery retries == the ceiling.
      workflow_dispatch_count: 4,
    },
    created_at: '2026-03-22T11:00:00.000Z',
    updated_at: '2026-03-22T11:00:00.000Z',
  });

  const response = await worker.fetch(
    new Request('https://control-plane.test/testnet/jobs/recover', {
      method: 'POST',
      headers: { authorization: 'Bearer control-plane-key' },
    }),
    env
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.dead_lettered_count, 1);
  assert.equal(body.requeued_count, 0);
  assert.equal(state.jobs.get('job-wf-ceiling')?.status, 'dead_lettered');
  // No fresh workflow instance was created.
  assert.equal(callbackWorkflow.created.length, 0);
});

test('oracle_request consumer defers queued jobs until run_after', async () => {
  const env = createEnv();
  const state = createState();
  global.fetch = createFetchMock(state);

  state.jobs.set('job-deferred', {
    id: 'job-deferred',
    network: 'testnet',
    queue: 'oracle_request',
    route: '/oracle/query',
    status: 'queued',
    payload: {
      symbol: 'TWELVEDATA:NEO-USD',
      target_chain: 'neo_n3',
    },
    metadata: {},
    run_after: '2099-03-22T12:00:00.000Z',
  });

  const message = createQueueMessage({
    job_id: 'job-deferred',
    network: 'testnet',
    queue: 'oracle_request',
  });
  await worker.queue({ queue: 'morpheus-oracle-request', messages: [message] }, env);

  assert.equal(message.acked, false);
  assert.equal(message.retried, true);
  assert.ok((message.retryDelaySeconds || 0) >= 1);
  assert.equal(state.executionCalls.length, 0);
  assert.equal(state.jobs.get('job-deferred')?.status, 'queued');
});
