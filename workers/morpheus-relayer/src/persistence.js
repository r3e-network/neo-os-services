import { randomUUID } from 'node:crypto';
import { env, sha256Hex, signManualAction } from '@r3e-network/neo-os-services-shared/node-runtime';
import { resolveKernelIntent } from './router.js';
import { trimString } from './lib/strings.js';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveSupabaseNetwork() {
  return trimString(
    process.env.MORPHEUS_NETWORK || process.env.NEXT_PUBLIC_MORPHEUS_NETWORK || 'testnet'
  ) === 'mainnet'
    ? 'mainnet'
    : 'testnet';
}

export const AUTOMATION_PROCESSING_CLAIM_MARKER = '__morpheus_automation_processing_claim__';

let supabasePersistenceBackoffUntilMs = 0;
let supabasePersistenceBackoffReason = '';

export function sanitizeForPostgres(value) {
  if (typeof value === 'string') {
    return value.replace(/\u0000/g, '');
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForPostgres(entry));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, current]) => [key, sanitizeForPostgres(current)])
    );
  }
  return value;
}

function getSupabaseRestConfig() {
  const baseUrl = trimString(
    process.env.SUPABASE_URL ||
      process.env.NEXT_PUBLIC_SUPABASE_URL ||
      process.env.morpheus_SUPABASE_URL ||
      ''
  );
  const apiKey = trimString(
    process.env.SUPABASE_SECRET_KEY ||
      process.env.morpheus_SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.morpheus_SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_KEY ||
      ''
  );
  if (!baseUrl || !apiKey) return null;
  return {
    restUrl: `${baseUrl.replace(/\/$/, '')}/rest/v1`,
    apiKey,
  };
}

export function hasSupabasePersistence() {
  return Boolean(getSupabaseRestConfig());
}

function resolveSupabaseBackoffMs() {
  const parsed = Number(
    process.env.MORPHEUS_SUPABASE_BACKOFF_MS || process.env.SUPABASE_BACKOFF_MS || 300000
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300000;
}

// Shorter backoff window for NON-quota connectivity/5xx/timeout Supabase outages
// (B11). A quota (402) outage is sustained, so it warrants the long 5min window;
// a connectivity blip recovers quickly, so a ~30s window keeps idempotency
// protection coming back fast while still sparing every op the 15s request
// timeout each tick during the outage.
function resolveSupabaseTransientBackoffMs() {
  const parsed = Number(
    process.env.MORPHEUS_SUPABASE_TRANSIENT_BACKOFF_MS ||
      process.env.SUPABASE_TRANSIENT_BACKOFF_MS ||
      30000
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
}

export function isSupabaseQuotaRestrictedError(error) {
  const normalized = String(error?.message || error || '').toLowerCase();
  return (
    normalized.includes('exceed_db_size_quota') ||
    normalized.includes('database size quota') ||
    normalized.includes('quota exceeded') ||
    normalized.includes('402 payment required') ||
    normalized.includes('failed: 402')
  );
}

// Connectivity / 5xx / timeout Supabase errors that are NOT quota restrictions.
// These warrant a short backoff (B11) so the relayer does not pay the 15s request
// timeout on every operation during a transient Supabase outage.
export function isSupabaseConnectivityError(error) {
  if (isSupabaseQuotaRestrictedError(error)) return false;
  const normalized = String(error?.message || error || '').toLowerCase();
  return (
    normalized.includes('pgrst002') ||
    normalized.includes('schema cache') ||
    normalized.includes('failed: 503') ||
    normalized.includes('failed: 502') ||
    normalized.includes('failed: 504') ||
    normalized.includes(' 503 ') ||
    normalized.includes(' 502 ') ||
    normalized.includes(' 504 ') ||
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('econnreset') ||
    normalized.includes('econnrefused') ||
    normalized.includes('eauthquery') ||
    normalized.includes('connection to database not available') ||
    normalized.includes('fetch failed') ||
    normalized.includes('network') ||
    normalized.includes('unavailable')
  );
}

export function markSupabasePersistenceUnavailable(error, nowMs = Date.now()) {
  if (isSupabaseQuotaRestrictedError(error)) {
    supabasePersistenceBackoffUntilMs = Math.max(
      supabasePersistenceBackoffUntilMs,
      nowMs + resolveSupabaseBackoffMs()
    );
    supabasePersistenceBackoffReason = 'quota_restricted';
    return true;
  }
  // B11: arm a shorter backoff for non-quota connectivity/5xx/timeout outages so
  // the relayer stops paying the full request timeout on every op this window.
  if (isSupabaseConnectivityError(error)) {
    const nextUntil = nowMs + resolveSupabaseTransientBackoffMs();
    // Never shorten an already-armed (possibly longer, quota) window.
    if (nextUntil > supabasePersistenceBackoffUntilMs) {
      supabasePersistenceBackoffUntilMs = nextUntil;
      // Keep a quota reason sticky if it is still the active reason.
      if (supabasePersistenceBackoffReason !== 'quota_restricted') {
        supabasePersistenceBackoffReason = 'connectivity';
      }
    }
    return true;
  }
  return false;
}

export function getSupabasePersistenceBackoff(nowMs = Date.now()) {
  if (supabasePersistenceBackoffUntilMs <= nowMs) {
    return { active: false, reason: null, until: null, remaining_ms: 0 };
  }
  return {
    active: true,
    reason: supabasePersistenceBackoffReason || 'temporarily_unavailable',
    until: new Date(supabasePersistenceBackoffUntilMs).toISOString(),
    remaining_ms: supabasePersistenceBackoffUntilMs - nowMs,
  };
}

export function shouldSkipSupabasePersistence(nowMs = Date.now()) {
  return getSupabasePersistenceBackoff(nowMs).active;
}

export function resetSupabasePersistenceBackoffForTests() {
  supabasePersistenceBackoffUntilMs = 0;
  supabasePersistenceBackoffReason = '';
}

async function supabaseRequest(table, method, payload, options = {}) {
  const config = getSupabaseRestConfig();
  if (!config) return null;

  const url = new URL(`${config.restUrl}/${table}`);
  if (options.query && typeof options.query === 'object') {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers = {
    apikey: config.apiKey,
    authorization: `Bearer ${config.apiKey}`,
    accept: 'application/json',
  };

  let body;
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(sanitizeForPostgres(payload));
  }
  const prefer = [];
  if (options.onConflict) {
    const resolution = options.ignoreDuplicates ? 'ignore-duplicates' : 'merge-duplicates';
    prefer.push(`resolution=${resolution}`);
    url.searchParams.set('on_conflict', options.onConflict);
  }
  if (options.returnRepresentation) {
    prefer.push('return=representation');
  }
  if (prefer.length > 0) {
    headers.Prefer = prefer.join(',');
  }

  const response = await fetch(url.toString(), {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const error = new Error(
      `supabase ${table} ${method} failed: ${response.status} ${text}`.trim()
    );
    markSupabasePersistenceUnavailable(error);
    throw error;
  }
  return response;
}

async function supabaseSelect(table, query = {}) {
  const response = await supabaseRequest(table, 'GET', undefined, { query });
  if (!response) return [];
  const text = await response.text();
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}

export async function persistRelayerRun(config, result) {
  const payload = {
    network: config.network,
    status: 'completed',
    started_at: result.state.metrics.last_tick_started_at,
    completed_at: result.state.metrics.last_tick_completed_at,
    duration_ms: result.state.metrics.last_tick_duration_ms,
    metrics: result.metrics,
    checkpoints: result.metrics.checkpoints,
    runtime: {
      poll_interval_ms: config.pollIntervalMs,
      concurrency: config.concurrency,
      max_blocks_per_tick: config.maxBlocksPerTick,
      max_retries: config.maxRetries,
    },
  };
  return supabaseRequest('morpheus_relayer_runs', 'POST', payload);
}

export async function upsertRelayerJob(record) {
  return supabaseRequest(
    'morpheus_relayer_jobs',
    'POST',
    {
      ...record,
      network: record.network || resolveSupabaseNetwork(),
    },
    { onConflict: 'network,event_key' }
  );
}

export async function insertRelayerJobIfAbsent(record) {
  return supabaseRequest(
    'morpheus_relayer_jobs',
    'POST',
    {
      ...record,
      network: record.network || resolveSupabaseNetwork(),
    },
    {
      onConflict: 'network,event_key',
      ignoreDuplicates: true,
    }
  );
}

export async function patchRelayerJob(eventKey, fields) {
  const network = resolveSupabaseNetwork();
  return supabaseRequest(
    'morpheus_relayer_jobs',
    'PATCH',
    {
      ...fields,
      network,
      updated_at: new Date().toISOString(),
    },
    {
      query: {
        event_key: `eq.${eventKey}`,
        network: `eq.${network}`,
      },
    }
  );
}

export async function claimRelayerJob(eventKey, fields, options = {}) {
  const network = resolveSupabaseNetwork();
  const readyStatuses = Array.isArray(options.readyStatuses)
    ? options.readyStatuses.filter(Boolean)
    : [];
  const staleStatuses = Array.isArray(options.staleStatuses)
    ? options.staleStatuses.filter(Boolean)
    : [];
  const staleBeforeIso = trimString(options.staleBeforeIso || '');
  const orParts = [];
  if (readyStatuses.length > 0) {
    orParts.push(`status.in.(${readyStatuses.join(',')})`);
  }
  if (staleStatuses.length > 0 && staleBeforeIso) {
    for (const status of staleStatuses) {
      orParts.push(`and(status.eq.${status},updated_at.lt.${staleBeforeIso})`);
    }
  }
  const response = await supabaseRequest(
    'morpheus_relayer_jobs',
    'PATCH',
    {
      ...fields,
      updated_at: new Date().toISOString(),
    },
    {
      returnRepresentation: true,
      query: {
        event_key: `eq.${eventKey}`,
        network: `eq.${network}`,
        ...(orParts.length > 0 ? { or: `(${orParts.join(',')})` } : {}),
      },
    }
  );
  if (!response) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    const rows = JSON.parse(text);
    return Array.isArray(rows) ? rows[0] || null : null;
  } catch {
    return null;
  }
}

// PostgREST `in.(...)` value quoting: event keys contain `:` (and other PostgREST
// reserved characters could appear in principle), so each value is double-quoted
// with embedded quotes/backslashes escaped.
function quotePostgrestInValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Bound URL length: PATCH targets are addressed by event_key=in.(...), chunked.
const QUARANTINE_PATCH_CHUNK_SIZE = 40;

export async function quarantineRelayerJobsBelowRequestId({
  network = resolveSupabaseNetwork(),
  chain = 'neo_n3',
  ltRequestId,
  statuses = [],
  note = '',
}) {
  if (!Number.isFinite(Number(ltRequestId))) return 0;
  // Status/chain/network filtering happens server-side in the PostgREST query;
  // the request-id floor comparison stays client-side because request_id is a
  // text column, so a PostgREST `lt.` filter would compare lexicographically
  // ('9' > '10') instead of numerically. Only the columns the quarantine needs
  // are selected.
  const rows = await fetchRelayerJobsByStatuses(statuses, chain, 5000, {
    select: 'event_key,request_id,last_error',
  });
  const threshold = Number(ltRequestId);
  const targetRows = rows.filter((row) => Number(row.request_id || 0) < threshold);
  if (targetRows.length === 0) return 0;
  const nowIso = new Date().toISOString();

  // Bulk PATCH: rows are grouped by the per-row last_error they will receive
  // (the note prefixes the row's previous error, so rows sharing a previous
  // error collapse into one PATCH), then each group is patched in chunks via
  // event_key=in.(...) instead of one PATCH per row.
  const groups = new Map();
  for (const row of targetRows) {
    const lastError = `${note || `quarantined below request cursor floor ${threshold}`} :: ${trimString(row.last_error || 'legacy open relayer job')}`;
    const group = groups.get(lastError);
    if (group) group.push(row.event_key);
    else groups.set(lastError, [row.event_key]);
  }

  let patched = 0;
  for (const [lastError, eventKeys] of groups) {
    for (let offset = 0; offset < eventKeys.length; offset += QUARANTINE_PATCH_CHUNK_SIZE) {
      const chunk = eventKeys.slice(offset, offset + QUARANTINE_PATCH_CHUNK_SIZE);
      const response = await supabaseRequest(
        'morpheus_relayer_jobs',
        'PATCH',
        {
          status: 'stale_quarantined',
          next_retry_at: null,
          completed_at: nowIso,
          updated_at: nowIso,
          last_error: lastError,
        },
        {
          query: {
            event_key: `in.(${chunk.map(quotePostgrestInValue).join(',')})`,
            network: `eq.${network}`,
          },
        }
      );
      if (response?.ok !== false) patched += chunk.length;
    }
  }
  return patched;
}

const RELAYER_JOB_FULL_SELECT =
  'id,network,event_key,chain,request_id,request_type,tx_hash,block_number,route,status,attempts,last_error,next_retry_at,worker_status,worker_response,fulfill_tx,event,updated_at,completed_at,created_at';

export async function fetchRelayerJobsByStatuses(
  statuses,
  chain = null,
  limit = 100,
  options = {}
) {
  if (!Array.isArray(statuses) || statuses.length === 0) return [];
  const network = resolveSupabaseNetwork();
  const query = {
    select: trimString(options.select || '') || RELAYER_JOB_FULL_SELECT,
    network: `eq.${network}`,
    status: `in.(${statuses.join(',')})`,
    order: 'updated_at.asc',
    limit,
  };
  if (chain) query.chain = `eq.${chain}`;
  return supabaseSelect('morpheus_relayer_jobs', query);
}

export function buildRelayerJobRecord(event, details = {}) {
  const kernelIntent = resolveKernelIntent(event.requestType);
  const network = details.network || event.network || resolveSupabaseNetwork();
  const eventKey = details.event_key || '';
  const workerResponse =
    details.worker_response && typeof details.worker_response === 'object'
      ? {
          ...details.worker_response,
          kernel_intent: {
            module_id: kernelIntent.moduleId,
            operation: kernelIntent.operation,
            legacy_request_type: kernelIntent.legacyRequestType,
          },
        }
      : (details.worker_response ?? null);
  // SECURITY (S4): every row this relayer persists carries an HMAC over the
  // exact event, so a DB write alone cannot forge an event that the durable
  // hydration / manual lanes will later sign+broadcast. The signature is only
  // attached when the shared secret is configured; consumers fail closed
  // without it.
  const hmacSecret = env('MORPHEUS_MANUAL_ACTION_HMAC_SECRET');
  const signedWorkerResponse =
    hmacSecret && eventKey && event && typeof event === 'object'
      ? {
          ...(workerResponse && typeof workerResponse === 'object' ? workerResponse : {}),
          manual_action_sig: signManualAction(
            hmacSecret,
            'relayer_upsert',
            network,
            eventKey,
            event
          ),
        }
      : workerResponse;
  return {
    network,
    event_key: eventKey,
    chain: event.chain,
    request_id: String(event.requestId || '0'),
    request_type: String(event.requestType || ''),
    tx_hash: event.txHash || null,
    block_number: event.blockNumber ?? null,
    route: details.route || null,
    status: details.status || 'queued',
    attempts: Number(details.attempts || 0),
    last_error: details.last_error || null,
    next_retry_at: details.next_retry_at || null,
    worker_status: details.worker_status ?? null,
    worker_response: signedWorkerResponse,
    fulfill_tx: details.fulfill_tx ?? null,
    event,
    updated_at: new Date().toISOString(),
    completed_at: details.completed_at || null,
  };
}

function collectEncryptedFields(value, path = [], results = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectEncryptedFields(entry, [...path, String(index)], results)
    );
    return results;
  }
  if (!isPlainObject(value)) return results;

  for (const [key, current] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (key.startsWith('encrypted_') && typeof current === 'string' && trimString(current)) {
      results.push({ field_path: nextPath.join('.'), ciphertext: trimString(current) });
      continue;
    }
    if (key === 'encrypted_inputs' && isPlainObject(current)) {
      for (const [nestedKey, nestedValue] of Object.entries(current)) {
        if (typeof nestedValue === 'string' && trimString(nestedValue)) {
          results.push({
            field_path: [...nextPath, nestedKey].join('.'),
            ciphertext: trimString(nestedValue),
          });
        }
      }
      continue;
    }
    collectEncryptedFields(current, nextPath, results);
  }
  return results;
}

export async function upsertAutomationJob(record) {
  return supabaseRequest(
    'morpheus_automation_jobs',
    'POST',
    {
      ...record,
      network: record.network || resolveSupabaseNetwork(),
    },
    { onConflict: 'network,automation_id' }
  );
}

export async function patchAutomationJob(automationId, fields) {
  const network = resolveSupabaseNetwork();
  return supabaseRequest(
    'morpheus_automation_jobs',
    'PATCH',
    {
      ...fields,
      network,
      updated_at: new Date().toISOString(),
    },
    {
      query: {
        automation_id: `eq.${automationId}`,
        network: `eq.${network}`,
      },
    }
  );
}

export async function claimAutomationJob(automationId, fields, options = {}) {
  const normalizedAutomationId = trimString(automationId);
  if (!normalizedAutomationId) return null;

  const dueAtIso = trimString(options.dueAtIso || '');
  const staleBeforeIso = trimString(options.staleBeforeIso || '');
  const buildOrParts = () => {
    const parts = [];
    if (dueAtIso) {
      parts.push('and(status.eq.active,next_run_at.is.null)');
      parts.push(`and(status.eq.active,next_run_at.lte.${dueAtIso})`);
    } else {
      parts.push('status.eq.active');
    }
    if (staleBeforeIso) {
      parts.push(`and(status.eq.processing,updated_at.lt.${staleBeforeIso})`);
      parts.push(
        `and(status.eq.paused,last_error.eq.${AUTOMATION_PROCESSING_CLAIM_MARKER},updated_at.lt.${staleBeforeIso})`
      );
    }
    return parts;
  };
  const parseRepresentation = async (response) => {
    if (!response) return null;
    const text = await response.text();
    if (!text) return null;
    try {
      const rows = JSON.parse(text);
      return Array.isArray(rows) ? rows[0] || null : null;
    } catch {
      return null;
    }
  };

  const orParts = buildOrParts();
  const query = {
    automation_id: `eq.${normalizedAutomationId}`,
    network: `eq.${resolveSupabaseNetwork()}`,
    ...(orParts.length > 0 ? { or: `(${orParts.join(',')})` } : {}),
  };

  try {
    const response = await supabaseRequest(
      'morpheus_automation_jobs',
      'PATCH',
      {
        ...fields,
        updated_at: new Date().toISOString(),
      },
      {
        returnRepresentation: true,
        query,
      }
    );
    return parseRepresentation(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/morpheus_automation_jobs_status_check|violates check constraint/i.test(message)) {
      throw error;
    }
  }

  const response = await supabaseRequest(
    'morpheus_automation_jobs',
    'PATCH',
    {
      ...fields,
      status: 'paused',
      last_error: AUTOMATION_PROCESSING_CLAIM_MARKER,
      updated_at: new Date().toISOString(),
    },
    {
      returnRepresentation: true,
      query,
    }
  );
  return parseRepresentation(response);
}

function buildSchedulableAutomationJobFilter(dueAtIso) {
  const normalizedDueAtIso = trimString(dueAtIso);
  if (!normalizedDueAtIso) return null;
  const staleBeforeIso = new Date(Date.parse(normalizedDueAtIso) - 120000).toISOString();
  return `(and(status.eq.active,next_run_at.is.null),and(status.eq.active,next_run_at.lte.${normalizedDueAtIso}),and(status.eq.processing,updated_at.lt.${staleBeforeIso}),and(status.eq.paused,last_error.eq.${AUTOMATION_PROCESSING_CLAIM_MARKER},updated_at.lt.${staleBeforeIso}))`;
}

export async function fetchAutomationJobById(automationId) {
  const rows = await supabaseSelect('morpheus_automation_jobs', {
    select: '*',
    network: `eq.${resolveSupabaseNetwork()}`,
    automation_id: `eq.${automationId}`,
    limit: 1,
  });
  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function fetchActiveAutomationJobs(limit = 50, dueAtIso = null) {
  const query = {
    select: '*',
    network: `eq.${resolveSupabaseNetwork()}`,
    order: 'next_run_at.asc.nullslast,updated_at.asc',
    limit,
  };
  const schedulableFilter = buildSchedulableAutomationJobFilter(dueAtIso);
  if (schedulableFilter) {
    query.or = schedulableFilter;
  } else {
    query.status = 'eq.active';
  }
  return supabaseSelect('morpheus_automation_jobs', query);
}

/**
 * SECURITY (S3): count active automation jobs registered by one on-chain
 * requester, so registration can enforce a per-requester quota and stop a
 * single account from draining the operator's GAS with unbounded schedules.
 * Returns 0 when Supabase is not configured (fail toward allowing the count to
 * be enforced elsewhere / tests).
 */
export async function countActiveAutomationsByRequester(requester, maxCount = 500) {
  const normalized = trimString(requester);
  if (!normalized) return 0;
  const rows = await supabaseSelect('morpheus_automation_jobs', {
    select: 'automation_id',
    network: `eq.${resolveSupabaseNetwork()}`,
    requester: `eq.${normalized}`,
    status: 'eq.active',
    limit: maxCount,
  });
  return Array.isArray(rows) ? rows.length : 0;
}

export async function fetchAutomationRunByQueueTxHash(txHash) {
  const normalizedTxHash = trimString(txHash);
  if (!normalizedTxHash) return null;
  const rows = await supabaseSelect('morpheus_automation_runs', {
    select: '*',
    network: `eq.${resolveSupabaseNetwork()}`,
    'queue_tx->>tx_hash': `eq.${normalizedTxHash}`,
    order: 'created_at.desc',
    limit: 1,
  });
  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function insertAutomationRun(record) {
  return supabaseRequest('morpheus_automation_runs', 'POST', {
    network: record.network || resolveSupabaseNetwork(),
    ...record,
  });
}

export async function patchAutomationRunByQueueTxHash(txHash, fields) {
  const normalizedTxHash = trimString(txHash);
  if (!normalizedTxHash) return null;
  return supabaseRequest(
    'morpheus_automation_runs',
    'PATCH',
    {
      ...fields,
    },
    {
      query: {
        network: `eq.${resolveSupabaseNetwork()}`,
        'queue_tx->>tx_hash': `eq.${normalizedTxHash}`,
      },
    }
  );
}

export async function persistAutomationEncryptedFields(job) {
  const payload = isPlainObject(job?.execution_payload) ? job.execution_payload : {};
  const encryptedFields = collectEncryptedFields(payload);
  if (encryptedFields.length === 0) return;
  const rows = encryptedFields.map((entry) => ({
    project_id: job.project_id || null,
    network: job.network || resolveSupabaseNetwork(),
    name: `automation:${job.automation_id}:${entry.field_path}:${randomUUID()}`,
    target_chain: job.chain,
    encryption_algorithm: 'client-supplied-ciphertext',
    key_version: 1,
    ciphertext: entry.ciphertext,
    metadata: {
      automation_id: job.automation_id,
      network: job.network || resolveSupabaseNetwork(),
      registration_request_id: job.registration_request_id,
      field_path: entry.field_path,
      ciphertext_sha256: sha256Hex(entry.ciphertext),
    },
  }));
  await supabaseRequest('morpheus_encrypted_secrets', 'POST', rows);
}
