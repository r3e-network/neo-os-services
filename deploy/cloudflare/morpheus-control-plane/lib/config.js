import { trimString, parseTimestampMs } from '@r3e-network/neo-os-services-shared/utils';

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
 * Resolve a network carried by a queue/workflow payload. Empty values retain
 * the documented TestNet default; an explicit unknown label is a poison
 * message and must never be routed to a different Supabase/network scope.
 */
function resolveControlPlaneNetwork(value) {
  const normalized = trimString(value).toLowerCase();
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

function resolveNetworkRoute(url) {
  const path = trimString(url.pathname || '/');
  const rawSegments = path.replace(/^\/+/, '').split('/');
  const segments =
    trimString(rawSegments[0]).toLowerCase() === 'control' ? rawSegments.slice(1) : rawSegments;
  const maybeNetwork = trimString(segments[0]).toLowerCase();
  const knownRoutePrefixes = new Set(['health', 'jobs', 'feeds', 'callbacks', 'automation']);
  const hasNetworkPrefix = maybeNetwork === 'mainnet' || maybeNetwork === 'testnet';
  if (!hasNetworkPrefix && maybeNetwork && !knownRoutePrefixes.has(maybeNetwork)) {
    throw new Error(`unsupported Neo network: ${maybeNetwork}`);
  }
  const network = maybeNetwork === 'mainnet' ? 'mainnet' : 'testnet';
  const routePath =
    maybeNetwork === 'mainnet' || maybeNetwork === 'testnet'
      ? `/${segments.slice(1).join('/')}`.replace(/\/+$/, '') || '/'
      : path.replace(/\/+$/, '') || '/';
  return {
    network,
    routePath,
  };
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
