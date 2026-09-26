import {
  env,
  json,
  parseBodyMaybe,
  requestLog,
  sanitizeErrorMessage,
  trimString,
} from './platform/core.js';
import { requireAuth } from './platform/auth.js';
import {
  buildDstackAttestation,
  getDstackInfo,
  getDerivedKeySummary,
} from './platform/nitro-signer.js';
import { acquireOverloadSlot, snapshotOverloadState } from './platform/overload-guard.js';
import {
  applyRequestGuards,
  persistGuardResult,
  releaseGuardLock,
} from './platform/request-guards.js';
import { normalizeExecutionPlan } from './platform/execution-plan.js';
import { buildResultEnvelope } from './platform/result-envelope.js';
import { resolveCapability, listCapabilityFeatures } from './capabilities.js';
import { getFeedStalenessSummary, getFeedStateWriteFailureCount } from './oracle/index.js';

const WORKER_SUPPORTED_CHAINS = ['neo_n3', 'neox'];

// F4 — cache the readiness probe so /health stays cheap+unauth even under load.
// The probe touches the enclave (key derivation + dstack health), so we never
// run it more than once per cache window.
const HEALTH_READINESS_CACHE_MS = 10_000;
let cachedReadiness = null;

function resolveFeedStaleAfterMs() {
  const raw = Number(env('MORPHEUS_HEALTH_FEED_STALE_AFTER_MS'));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 600_000; // 10 min default
}

function workerHealthStrict() {
  const raw = trimString(env('MORPHEUS_WORKER_HEALTH_STRICT')).toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

async function probeSigningAndDstack() {
  // getDerivedKeySummary derives the worker Neo N3 key (proving the signing
  // material is reachable) AND pings the Nitro signer /health endpoint, covering
  // both signing-key and dstack reachability in one call.
  try {
    const summary = await getDerivedKeySummary('worker');
    return {
      signing_key: Boolean(summary?.neo_n3?.public_key),
      dstack: Boolean(summary?.runtime),
      runtime: summary?.runtime || null,
    };
  } catch (error) {
    return {
      signing_key: false,
      dstack: false,
      runtime: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function __resetHealthReadinessCacheForTests() {
  cachedReadiness = null;
}

async function buildReadiness() {
  const now = Date.now();
  if (cachedReadiness && now - cachedReadiness.checkedAtMs < HEALTH_READINESS_CACHE_MS) {
    return cachedReadiness.value;
  }

  const signer = await probeSigningAndDstack();
  const feedStaleness = getFeedStalenessSummary(now);
  const staleAfterMs = resolveFeedStaleAfterMs();
  const feedStale =
    feedStaleness && Number.isFinite(feedStaleness.age_ms)
      ? feedStaleness.age_ms > staleAfterMs
      : false;
  const writeFailures = getFeedStateWriteFailureCount();

  const checks = {
    signing_key: signer.signing_key,
    dstack: signer.dstack,
    // null = no feed state loaded (not a feed pusher) → not a readiness fault.
    feed_fresh: feedStaleness === null ? null : !feedStale,
  };

  const value = {
    ready: checks.signing_key && checks.dstack && checks.feed_fresh !== false,
    checks,
    runtime: signer.runtime,
    feed:
      feedStaleness === null
        ? null
        : {
            ...feedStaleness,
            stale_after_ms: staleAfterMs,
            stale: feedStale,
          },
    feed_state_write_failures: writeFailures,
    ...(signer.error ? { signer_error: signer.error } : {}),
  };
  cachedReadiness = { checkedAtMs: now, value };
  return value;
}

function resolveActiveTargetChains() {
  const raw = String(process.env.MORPHEUS_ACTIVE_CHAINS || '').trim();
  if (!raw) return ['neo_n3'];
  const chains = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => WORKER_SUPPORTED_CHAINS.includes(entry));
  return chains.length > 0 ? chains : ['neo_n3'];
}

async function handleHealth() {
  const targetChains = resolveActiveTargetChains();
  const readiness = await buildReadiness();
  // Backward-compatible by default: status stays 'ok'/200 (the existing health
  // contract) and the new readiness object is purely additive. Operators can opt
  // into hard readiness gating (503 when not ready) via MORPHEUS_WORKER_HEALTH_STRICT.
  const strict = workerHealthStrict();
  const httpStatus = strict && !readiness.ready ? 503 : 200;
  return json(httpStatus, {
    status: strict && !readiness.ready ? 'degraded' : 'ok',
    ready: readiness.ready,
    runtime: 'nitro-worker',
    readiness,
    oracle: {
      privacy_oracle: true,
      target_chains: targetChains,
      pricefeed_chain: 'neo_n3',
      compute_merged_into_oracle: true,
    },
    features: listCapabilityFeatures(),
  });
}

function normalizeRequestNetwork(value) {
  const normalized = trimString(value).toLowerCase();
  if (!normalized) return '';
  if (normalized !== 'mainnet' && normalized !== 'testnet') {
    throw new Error(`unsupported Neo network: ${normalized}`);
  }
  return normalized === 'mainnet' || normalized === 'testnet' ? normalized : '';
}

function inferRequestNetwork(path, request) {
  const firstSegment = trimString(path.split('/').filter(Boolean)[0] || '').toLowerCase();
  // Only the documented /mainnet/... and /testnet/... prefixes carry network
  // identity. Ordinary routes such as /sign/payload must continue to use the
  // request header (or the downstream default) rather than treating "sign" as
  // an invalid network label.
  if (firstSegment === 'mainnet' || firstSegment === 'testnet') {
    return normalizeRequestNetwork(firstSegment);
  }
  return normalizeRequestNetwork(request.headers.get('x-morpheus-network'));
}

function injectRequestNetwork(payload, request, path) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  if (
    trimString(
      payload.network || payload.morpheus_network || payload.runtime_network || payload.environment
    )
  ) {
    return payload;
  }
  const network = inferRequestNetwork(path, request);
  return network ? { ...payload, network } : payload;
}

function resolveExecutionPlan(resolved, path, payload) {
  const workflowId = trimString(
    payload.workflow_id || payload.workflowId || resolved?.capability?.workflow?.id || ''
  );
  const executionId = trimString(payload.execution_id || payload.executionId || '');
  if (!workflowId || !executionId) return null;

  return normalizeExecutionPlan({
    workflow_id: workflowId,
    workflow_version:
      payload.workflow_version ||
      payload.workflowVersion ||
      resolved?.capability?.workflow?.version,
    execution_id: executionId,
    network: payload.network,
    provider_refs: payload.provider_refs || payload.providerRefs,
    sealed_inputs: payload.sealed_inputs || payload.sealedInputs,
    step_list: payload.step_list || payload.stepList,
    payload,
    route: path,
  });
}

async function parseResponseOutput(response) {
  try {
    const cloned = response.clone();
    const text = await cloned.text();
    if (!text) return null;
    return parseBodyMaybe(text, cloned.headers.get('content-type')) ?? { raw: text };
  } catch {
    return null;
  }
}

async function wrapWorkflowResponse(response, executionPlan) {
  if (!executionPlan) return response;
  const output = await parseResponseOutput(response);
  return json(
    response.status,
    buildResultEnvelope(
      executionPlan,
      {
        ok: response.ok,
        error:
          !response.ok && output && typeof output === 'object'
            ? trimString(output.error || '')
            : '',
      },
      output
    )
  );
}

export default async function handler(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '');
  const requestPayload =
    request.method === 'GET'
      ? Object.fromEntries(url.searchParams.entries())
      : await request.json().catch(() => ({}));
  let payload;
  try {
    payload = injectRequestNetwork(requestPayload, request, path);
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : String(error) });
  }

  let executionPlan = null;

  // SECURITY (S19): these unauthenticated probes are matched as exact paths (or
  // with a single known network prefix). A bare endsWith would let
  // `/evil/health` hit the unauthenticated health branch.
  const probePath = (() => {
    const segments = path.split('/').filter(Boolean);
    const first = (segments[0] || '').toLowerCase();
    const body =
      first === 'mainnet' || first === 'testnet' ? `/${segments.slice(1).join('/')}` : path;
    return body;
  })();

  try {
    if (probePath === '/health') return await handleHealth();
    if (probePath === '/info') {
      return json(200, {
        dstack: await getDstackInfo({ required: false }),
        overload: snapshotOverloadState(),
      });
    }
    if (probePath === '/attestation') {
      const reportData =
        payload.report_data ||
        payload.reportData ||
        payload.output_hash ||
        payload.message ||
        'morpheus-attestation';
      return json(200, {
        attestation: await buildDstackAttestation(reportData, { required: false }),
      });
    }

    const auth = await requireAuth(request);
    if (!auth.ok) return auth.response;

    const guards = await applyRequestGuards({ request, path, payload });
    if (!guards.ok) return guards.response;
    const overload = acquireOverloadSlot(path, payload);
    if (!overload.ok) return overload.response;

    try {
      const resolved = resolveCapability(path, payload);
      let response;
      if (resolved) {
        executionPlan = resolveExecutionPlan(resolved, path, payload);
        const start = Date.now();
        requestLog('info', 'request', {
          capability: resolved.capability.id,
          method: request.method,
          path,
          workflow_id: executionPlan?.workflow_id || null,
          execution_id: executionPlan?.execution_id || null,
        });
        response = await resolved.capability.handler({
          path,
          url,
          payload,
          request,
          executionPlan,
        });
        response = await wrapWorkflowResponse(response, executionPlan);
        requestLog('info', 'response', {
          capability: resolved.capability.id,
          status: response.status,
          latency_ms: Date.now() - start,
          workflow_id: executionPlan?.workflow_id || null,
          execution_id: executionPlan?.execution_id || null,
        });
      } else {
        response = json(404, { error: 'not found', path });
      }
      await persistGuardResult(guards, response);
      return response;
    } finally {
      overload.release();
      await releaseGuardLock(guards);
    }
  } catch (error) {
    const message = sanitizeErrorMessage(error);
    if (executionPlan) {
      return json(
        400,
        buildResultEnvelope(
          executionPlan,
          {
            ok: false,
            error: message,
          },
          { error: message }
        )
      );
    }
    return json(400, { error: message });
  }
}
