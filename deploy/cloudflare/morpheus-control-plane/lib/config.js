import { trimString, parseTimestampMs } from '@r3e-network/neo-os-services-shared/utils';
import { JOB_ROUTE_CONFIG } from './health.js';

const DEFAULT_REQUEUE_LIMIT = 50;
const DEFAULT_STALE_PROCESSING_MS = 10 * 60_000;
// 128 KiB is comfortably above any legitimate job payload (oracle/feed/workflow
// requests are well under this) while still capping an attacker from forcing the
// worker to buffer + JSON.parse an arbitrarily large body. Tunable down to 64 KiB
// and up to 256 KiB per the roadmap envelope.
const DEFAULT_MAX_BODY_BYTES = 128 * 1024;
const MIN_MAX_BODY_BYTES = 64 * 1024;
const MAX_MAX_BODY_BYTES = 256 * 1024;

function resolveMaxBodyBytes(env) {
  const configured = Number(env?.MORPHEUS_CONTROL_PLANE_MAX_BODY_BYTES || DEFAULT_MAX_BODY_BYTES);
  if (!Number.isFinite(configured)) return DEFAULT_MAX_BODY_BYTES;
  return Math.min(Math.max(Math.floor(configured), MIN_MAX_BODY_BYTES), MAX_MAX_BODY_BYTES);
}

// Maximum number of times the recovery path (POST /jobs/recover + scheduled
// cron) will re-requeue the same job before declaring it a poison job and
// marking it dead_lettered. This is the recovery-side complement to the DLQ
// consumer: even if a job never reaches Cloudflare's queue DLQ (e.g. it keeps
// failing on dispatch before a queue retry, or the workflow keeps re-failing),
// the cron must not re-requeue it forever.
const DEFAULT_MAX_REQUEUE_ATTEMPTS = 3;
const MAX_REQUEUE_ATTEMPTS_CEILING = 20;

function resolveMaxRequeueAttempts(env) {
  const configured = Number(
    env?.MORPHEUS_CONTROL_PLANE_MAX_REQUEUE_ATTEMPTS || DEFAULT_MAX_REQUEUE_ATTEMPTS
  );
  if (!Number.isFinite(configured)) return DEFAULT_MAX_REQUEUE_ATTEMPTS;
  return Math.min(Math.max(Math.floor(configured), 1), MAX_REQUEUE_ATTEMPTS_CEILING);
}

function resolveRequeueLimit(env) {
  const configured = Number(env.MORPHEUS_CONTROL_PLANE_REQUEUE_LIMIT || DEFAULT_REQUEUE_LIMIT);
  if (!Number.isFinite(configured)) return DEFAULT_REQUEUE_LIMIT;
  return Math.min(Math.max(Math.floor(configured), 1), 200);
}

function resolveStaleProcessingMs(env) {
  const configured = Number(
    env.MORPHEUS_CONTROL_PLANE_STALE_PROCESSING_MS || DEFAULT_STALE_PROCESSING_MS
  );
  if (!Number.isFinite(configured)) return DEFAULT_STALE_PROCESSING_MS;
  return Math.max(Math.floor(configured), 30_000);
}

/**
 * Resolve a network carried by a queue/workflow payload. An absent, null or
 * blank value retains the documented TestNet default; any other value that is
 * not a served network label, `false` and `0` included, is a poison message
 * and must never be routed to a different Supabase/network scope.
 */
function resolveControlPlaneNetwork(value) {
  if (value === undefined || value === null) return 'testnet';
  if (typeof value !== 'string') throw new Error(`unsupported Neo network: ${String(value)}`);
  const normalized = value.trim().toLowerCase();
  if (!normalized) return 'testnet';
  if (normalized === 'mainnet' || normalized === 'testnet') return normalized;
  throw new Error(`unsupported Neo network: ${normalized}`);
}

function isStaleProcessing(job, nowMs, staleProcessingMs) {
  const startedMs = parseTimestampMs(job?.started_at);
  if (!startedMs) return false;
  return nowMs - startedMs >= staleProcessingMs;
}

function computeRetryDelaySeconds(attempt, env) {
  const baseSeconds = Math.max(Number(env.MORPHEUS_CONTROL_PLANE_RETRY_BASE_SECONDS || 5), 1);
  const maxSeconds = Math.max(
    Number(env.MORPHEUS_CONTROL_PLANE_RETRY_MAX_SECONDS || 300),
    baseSeconds
  );
  const exp = Math.min(Math.max(Number(attempt || 1) - 1, 0), 10);
  const delay = Math.min(maxSeconds, baseSeconds * 2 ** exp);
  const jittered = delay * (0.8 + Math.random() * 0.4);
  return Math.max(1, Math.round(jittered));
}

const SERVED_NETWORKS = new Set(['mainnet', 'testnet']);

// The first path segments this Worker serves without a network label: every job
// route of JOB_ROUTE_CONFIG plus the health and job status/recovery routes.
const UNPREFIXED_ROUTE_SEGMENTS = new Set([
  'health',
  'jobs',
  ...Object.keys(JOB_ROUTE_CONFIG).map((route) => route.split('/')[1]),
]);

/**
 * Split a request path into its network and route. `/<network>/<route>` names
 * the network, and a route without one (`/oracle/query`, `/health`) keeps the
 * documented TestNet default. A first segment that is neither is never mapped
 * to a network: in front of a served route it is an unsupported network label
 * (`{ ok: false, status: 400 }`), and anything else is an unknown path
 * (`{ ok: false, status: 404 }`).
 */
function resolveNetworkRoute(url) {
  const path = trimString(url.pathname || '/');
  const rawSegments = path.replace(/^\/+/, '').split('/');
  const segments =
    trimString(rawSegments[0]).toLowerCase() === 'control' ? rawSegments.slice(1) : rawSegments;
  const first = trimString(segments[0]).toLowerCase();
  if (SERVED_NETWORKS.has(first)) {
    return {
      ok: true,
      network: first,
      routePath: `/${segments.slice(1).join('/')}`.replace(/\/+$/, '') || '/',
    };
  }
  const routePath = path.replace(/\/+$/, '') || '/';
  if (!first || UNPREFIXED_ROUTE_SEGMENTS.has(first)) {
    return { ok: true, network: 'testnet', routePath };
  }
  if (UNPREFIXED_ROUTE_SEGMENTS.has(trimString(segments[1]).toLowerCase())) {
    return { ok: false, status: 400, network: first, routePath };
  }
  return { ok: false, status: 404, routePath };
}

function normalizeWorkflowVersion(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.trunc(numeric);
}

function resolveJobMetadata(routePath, payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  return {
    target_chain: trimString(body.target_chain || '') || null,
    project_slug: trimString(body.project_slug || '') || null,
    request_id: trimString(body.request_id || body.oracle_request_id || '') || null,
    dedupe_key:
      trimString(body.dedupe_key || body.idempotency_key || body.request_id || '') || null,
    workflow_id: trimString(body.workflow_id || body.workflowId || '') || null,
    workflow_version: normalizeWorkflowVersion(body.workflow_version || body.workflowVersion),
    execution_id:
      trimString(
        body.execution_id ||
          body.executionId ||
          body.workflow_execution_id ||
          body.workflowExecutionId ||
          ''
      ) || null,
  };
}

export {
  resolveRequeueLimit,
  resolveStaleProcessingMs,
  resolveMaxBodyBytes,
  resolveMaxRequeueAttempts,
  isStaleProcessing,
  computeRetryDelaySeconds,
  resolveControlPlaneNetwork,
  resolveNetworkRoute,
  resolveJobMetadata,
};
