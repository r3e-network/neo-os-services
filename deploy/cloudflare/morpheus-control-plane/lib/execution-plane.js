import { trimString } from '@r3e-network/neo-os-services-shared/utils';

const EXECUTION_PLANE_ROUTES = new Set([
  '/oracle/query',
  '/oracle/smart-fetch',
  '/compute/execute',
  '/neodid/bind',
  '/neodid/action-ticket',
  '/neodid/recovery-ticket',
]);

function stableExecutionPoolIndex(seed, size) {
  if (!size || size <= 1) return 0;
  const text = trimString(seed || '');
  if (!text) return 0;
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash % size;
}

function orderExecutionBaseUrls(baseUrls, seed) {
  const urls = Array.isArray(baseUrls) ? baseUrls.filter(Boolean) : [];
  if (urls.length <= 1) return urls;
  const start = stableExecutionPoolIndex(seed, urls.length);
  return [...urls.slice(start), ...urls.slice(0, start)];
}

function isProductionExecution(env) {
  const marker = trimString(
    env.MORPHEUS_ENVIRONMENT || env.NODE_ENV || env.ENVIRONMENT || 'production'
  ).toLowerCase();
  return !['development', 'test', 'local'].includes(marker);
}

function getExecutionPlaneConfig(env, network, options = {}) {
  assertEdgeSigningKeysAbsent(env, network);
  const normalized = network === 'mainnet' ? 'MAINNET' : 'TESTNET';
  const baseUrlCandidates = options.feed
    ? [
        env[`MORPHEUS_${normalized}_FEED_EXECUTION_BASE_URL`],
        env[`MORPHEUS_${normalized}_DATAFEED_EXECUTION_BASE_URL`],
        env.MORPHEUS_FEED_EXECUTION_BASE_URL,
        env.MORPHEUS_DATAFEED_EXECUTION_BASE_URL,
        env[`MORPHEUS_${normalized}_EXECUTION_BASE_URL`],
        env.MORPHEUS_EXECUTION_BASE_URL,
      ]
    : [env[`MORPHEUS_${normalized}_EXECUTION_BASE_URL`], env.MORPHEUS_EXECUTION_BASE_URL];
  const baseUrl = trimString(baseUrlCandidates.find((candidate) => trimString(candidate)) || '');
  // No legacy token fallbacks are accepted here: a stale or leaked secret must
  // not silently become the execution-plane Bearer on a config slip.
  const tokenCandidates = options.feed
    ? [
        env[`MORPHEUS_${normalized}_FEED_EXECUTION_TOKEN`],
        env[`MORPHEUS_${normalized}_DATAFEED_EXECUTION_TOKEN`],
        env.MORPHEUS_FEED_EXECUTION_TOKEN,
        env.MORPHEUS_DATAFEED_EXECUTION_TOKEN,
        env[`MORPHEUS_${normalized}_EXECUTION_TOKEN`],
        env.MORPHEUS_EXECUTION_TOKEN,
      ]
    : [env[`MORPHEUS_${normalized}_EXECUTION_TOKEN`], env.MORPHEUS_EXECUTION_TOKEN];
  const token = trimString(tokenCandidates.find((candidate) => trimString(candidate)) || '');
  if (!baseUrl) {
    throw new Error(
      `${options.feed ? 'feed execution' : 'execution'} base URL is not configured for network ${network}`
    );
  }
  const baseUrls = baseUrl
    .split(',')
    .map((entry) => trimString(entry).replace(/\/$/, ''))
    .filter(Boolean);
  if (isProductionExecution(env) && baseUrls.length !== 1) {
    throw new Error(
      `${options.feed ? 'feed execution' : 'execution'} must use exactly one confidential origin in production`
    );
  }
  return {
    baseUrls,
    token,
  };
}

// SECURITY (S5): the control plane must NEVER hold or forward blockchain signing
// keys (WIF / private key). Key material lives exclusively inside the TEE
// execution plane (KMS-attested materialization). These env names are the
// legacy edge-held signer configuration; any one of them being set is a
// misconfiguration that fail-closes the feed lane rather than letting a
// private key leave the edge inside an HTTP request body.
const EDGE_HELD_SIGNER_ENV_NAMES = [
  'MORPHEUS_FEED_NEO_N3_WIF',
  'MORPHEUS_UPDATER_NEO_N3_WIF',
  'MORPHEUS_RELAYER_NEO_N3_WIF',
  'MORPHEUS_FEED_NEO_N3_PRIVATE_KEY',
  'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY',
  'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY',
  'MORPHEUS_RELAYER_NEOX_UPDATER_PK',
  'MORPHEUS_RELAYER_NEOX_VERIFIER_PK',
  'NEOX_UPDATER_PK',
  'NEOX_VERIFIER_PK',
  'NEOX_FEED_PK',
];

function networkScopedSignerEnvNames(upper) {
  return [
    `MORPHEUS_${upper}_FEED_NEO_N3_WIF`,
    `MORPHEUS_FEED_NEO_N3_WIF_${upper}`,
    `MORPHEUS_${upper}_UPDATER_NEO_N3_WIF`,
    `MORPHEUS_UPDATER_NEO_N3_WIF_${upper}`,
    `MORPHEUS_${upper}_RELAYER_NEO_N3_WIF`,
    `MORPHEUS_RELAYER_NEO_N3_WIF_${upper}`,
    `MORPHEUS_${upper}_FEED_NEO_N3_PRIVATE_KEY`,
    `MORPHEUS_FEED_NEO_N3_PRIVATE_KEY_${upper}`,
    `MORPHEUS_${upper}_UPDATER_NEO_N3_PRIVATE_KEY`,
    `MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_${upper}`,
    `MORPHEUS_${upper}_RELAYER_NEO_N3_PRIVATE_KEY`,
    `MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_${upper}`,
  ];
}

/**
 * Fail-closed guard: throw when any edge-held blockchain signing key is
 * configured. The control plane signs nothing itself; signing happens inside
 * the TEE execution plane, which derives keys from its own (attested) secrets.
 * Keeping a WIF here would let it leak over the wire when the feed lane calls
 * the execution plane.
 */
function assertEdgeSigningKeysAbsent(env, network) {
  const upper = network === 'mainnet' ? 'MAINNET' : 'TESTNET';
  const discovered = Object.keys(env || {}).filter((name) => {
    const normalized = name.toUpperCase();
    return (
      /(?:^|_)WIF(?:_|$)/.test(normalized) ||
      (/(?:^|_)(?:PRIVATE_KEY|PK)(?:_|$)/.test(normalized) &&
        /(NEO|NEOX|EVM|MORPHEUS|SIGNER)/.test(normalized))
    );
  });
  const candidates = [
    ...new Set([
      ...networkScopedSignerEnvNames(upper),
      ...EDGE_HELD_SIGNER_ENV_NAMES,
      ...discovered,
    ]),
  ];
  const configured = candidates.filter((name) => trimString(env[name] || ''));
  if (configured.length > 0) {
    throw new Error(
      `host signing keys must not be configured on the control plane; ` +
        `move signing into the TEE execution plane. Configured edge-held key env: ${configured.join(', ')}`
    );
  }
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function isRetryableExecutionBody(body) {
  const text = JSON.stringify(body || {}).toLowerCase();
  return (
    text.includes('runtime_unavailable') ||
    text.includes('fetch failed') ||
    text.includes('timed out') ||
    text.includes('upstream returned http 5') ||
    text.includes('provider response exceeds max size')
  );
}

async function fetchJsonWithTimeout(url, init = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)),
    timeoutMs
  );
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    const text = await response.text();
    let body = text;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

async function callExecutionPlane(env, job) {
  if (!EXECUTION_PLANE_ROUTES.has(job.route)) {
    throw new Error(`route ${job.route} is not mapped to the confidential execution plane`);
  }
  const execution = getExecutionPlaneConfig(env, job.network);
  const headers = new Headers({ 'content-type': 'application/json' });
  if (execution.token) {
    headers.set('authorization', `Bearer ${execution.token}`);
    headers.set('x-nitro-token', execution.token);
  }
  const timeoutMs = Math.max(Number(env.MORPHEUS_EXECUTION_TIMEOUT_MS || 30000), 1000);
  let lastError = null;
  let lastResponse = null;
  const orderedBaseUrls = orderExecutionBaseUrls(
    execution.baseUrls,
    job.request_id || job.id || job.dedupe_key || ''
  );
  for (const baseUrl of orderedBaseUrls) {
    try {
      const { response, body } = await fetchJsonWithTimeout(
        `${baseUrl}${job.route}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(job.payload || {}),
        },
        timeoutMs
      );
      lastResponse = {
        ok: response.ok,
        status: response.status,
        body,
        execution_base_url: baseUrl,
      };
      if (response.ok || (!isRetryableStatus(response.status) && !isRetryableExecutionBody(body))) {
        return lastResponse;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  if (lastResponse) return lastResponse;
  throw new Error(lastError || 'execution plane unavailable');
}

async function callExecutionFeedPlane(env, job) {
  const execution = getExecutionPlaneConfig(env, job.network, { feed: true });
  const headers = new Headers({ 'content-type': 'application/json' });
  if (execution.token) {
    headers.set('authorization', `Bearer ${execution.token}`);
    headers.set('x-nitro-token', execution.token);
  }
  const timeoutMs = Math.max(Number(env.MORPHEUS_EXECUTION_TIMEOUT_MS || 30000), 1000);
  let lastError = null;
  let lastResponse = null;
  const orderedBaseUrls = orderExecutionBaseUrls(
    execution.baseUrls,
    job.request_id || job.id || job.symbol || job.payload?.symbol || ''
  );
  for (const baseUrl of orderedBaseUrls) {
    try {
      const { response, body } = await fetchJsonWithTimeout(
        `${baseUrl}/oracle/feed`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            ...(job.payload || {}),
            fast_ack: true,
            wait: false,
          }),
        },
        timeoutMs
      );
      lastResponse = {
        ok: response.ok,
        status: response.status,
        body,
        execution_base_url: baseUrl,
      };
      if (response.ok || (!isRetryableStatus(response.status) && !isRetryableExecutionBody(body))) {
        return lastResponse;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  if (lastResponse) return lastResponse;
  throw new Error(lastError || 'feed execution plane unavailable');
}

function getAppBackendConfig(env) {
  const baseUrl = trimString(env.MORPHEUS_APP_BACKEND_URL || '');
  const token = trimString(env.MORPHEUS_WORKFLOW_API_KEY || env.MORPHEUS_APP_BACKEND_TOKEN || '');
  const runtimeTokens = [env.MORPHEUS_RUNTIME_TOKEN, env.NITRO_API_TOKEN, env.NITRO_SHARED_SECRET]
    .map((value) => trimString(value))
    .filter(Boolean);
  if (!baseUrl) {
    throw new Error('MORPHEUS_APP_BACKEND_URL is not configured');
  }
  if (!token) {
    throw new Error(
      'workflow backend credential is not configured (MORPHEUS_WORKFLOW_API_KEY or MORPHEUS_APP_BACKEND_TOKEN)'
    );
  }
  if (runtimeTokens.includes(token)) {
    throw new Error(
      'workflow backend credential must be independent from runtime data-plane credentials'
    );
  }
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    token,
  };
}

async function callAppBackend(env, path, payload) {
  const backend = getAppBackendConfig(env);
  const headers = new Headers({ 'content-type': 'application/json' });
  if (backend.token) {
    headers.set('authorization', `Bearer ${backend.token}`);
    headers.set('x-admin-api-key', backend.token);
  }
  const timeoutMs = Math.max(Number(env.MORPHEUS_APP_BACKEND_TIMEOUT_MS || 30000), 1000);
  const { response, body } = await fetchJsonWithTimeout(
    `${backend.baseUrl}${path}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(payload || {}),
    },
    timeoutMs
  );
  return {
    ok: response.ok,
    status: response.status,
    body,
    backend_url: backend.baseUrl,
  };
}

export {
  EXECUTION_PLANE_ROUTES,
  stableExecutionPoolIndex,
  orderExecutionBaseUrls,
  isProductionExecution,
  getExecutionPlaneConfig,
  assertEdgeSigningKeysAbsent,
  isRetryableStatus,
  isRetryableExecutionBody,
  fetchJsonWithTimeout,
  callExecutionPlane,
  callExecutionFeedPlane,
  callAppBackend,
  getAppBackendConfig,
};
