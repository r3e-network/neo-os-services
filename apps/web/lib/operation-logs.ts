import { createHash, randomUUID } from 'node:crypto';
import { after } from 'next/server';

import { emitBetterStackOperationLog } from './betterstack-log-sink';
import {
  getServerSupabaseClient,
  resolveProjectIdBySlug,
  resolveSupabaseNetwork,
  type MorpheusNetwork,
} from './server-supabase';
import { trimString } from './strings';

type OperationCategory =
  | 'oracle'
  | 'compute'
  | 'feed'
  | 'provider_config'
  | 'relayer'
  | 'signing'
  | 'relay'
  | 'runtime'
  | 'attestation'
  | 'network'
  | 'system';

type OperationLogInput = {
  route: string;
  method: string;
  category: OperationCategory;
  requestPayload?: unknown;
  responsePayload?: unknown;
  httpStatus?: number;
  error?: string | null;
  metadata?: Record<string, unknown>;
};

// Redact secret-bearing field names. `signing_key` is the active hole: it is
// consumed by /sign/payload + /relay/transaction (workers/.../signing.js) and
// without this match would be written cleartext to Supabase + BetterStack. The
// pattern deliberately matches the seed/mnemonic family too. It must NOT match
// public material (`public_key`, `oracle_public_key`) or `key_role`: the
// `(?<!public_)(?<!oracle_public_)signing?[_-]?key` style is avoided in favor
// of anchoring on `signing_key` explicitly so `public_key` never matches.
const SENSITIVE_KEY_PATTERN =
  /(authorization|token|secret|password|private[_-]?key|signing[_-]?key|mnemonic|seed|passphrase|credential|wif|api[_-]?key)/i;
// Raw/opaque payload fields are not structured JSON we can field-redact, so any
// string carried under them may smuggle secrets (a WIF, a bearer token, a
// serialized signed tx). Treat the whole value as opaque and hash it rather
// than persisting cleartext to Supabase + BetterStack.
const RAW_PAYLOAD_KEY_PATTERN = /^(raw_?string|raw_?body|raw_?payload|raw_?input)$/i;
const ERROR_TEXT_KEY_PATTERN = /^(error|detail|message|reason|stack)$/i;
// Credentials embedded in a URL userinfo segment (scheme://user:pass@host).
const URL_CREDENTIAL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]+)?@/gi;
const MAX_JSON_CHARS = 24000;
const MAX_ERROR_CHARS = 2048;

// Monitoring read probes (status-page polling plus external uptime monitors)
// hit these GET routes continuously; logging every probe grows
// morpheus_operation_logs without bound — the same failure mode as the prior
// Supabase quota outage. Successful monitoring GETs are sampled 1-in-N per
// route; errors and all non-GET traffic are always logged.
const MONITORING_READ_CATEGORIES = new Set<OperationCategory>([
  'system',
  'runtime',
  'network',
  'feed',
  'attestation',
]);
const DEFAULT_MONITORING_SAMPLE_RATE = 20;
const monitoringSampleCounters = new Map<string, number>();

function resolveMonitoringSampleRate() {
  const raw = Number(process.env.MORPHEUS_OPERATION_LOG_SAMPLE_RATE || '');
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return DEFAULT_MONITORING_SAMPLE_RATE;
}

function shouldSampleOutMonitoringRead(input: OperationLogInput) {
  if (input.method.toUpperCase() !== 'GET') return false;
  if (!MONITORING_READ_CATEGORIES.has(input.category)) return false;
  const failed =
    Boolean(trimString(input.error || '')) ||
    (typeof input.httpStatus === 'number' && input.httpStatus >= 400);
  if (failed) return false;
  const rate = resolveMonitoringSampleRate();
  if (rate <= 1) return false;
  const count = monitoringSampleCounters.get(input.route) || 0;
  monitoringSampleCounters.set(input.route, count + 1);
  // Log the first probe per process instance, then every Nth.
  return count % rate !== 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sha256Hex(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function shouldPreserveCiphertext(path: string[]) {
  return path.some((segment) => segment === 'encrypted_inputs' || segment.startsWith('encrypted_'));
}

function shouldRedactField(path: string[]) {
  const currentKey = path[path.length - 1] || '';
  if (!SENSITIVE_KEY_PATTERN.test(currentKey)) return false;

  // A field explicitly named `encrypted_*` contains ciphertext and remains
  // useful for correlation/storage. Sensitive child keys inside that envelope
  // are still attacker-controlled cleartext until proven otherwise and must be
  // redacted before the surrounding encrypted path can preserve them.
  return !currentKey.startsWith('encrypted_');
}

function redactOpaque(value: string) {
  // Persist a stable fingerprint instead of cleartext so forensics can still
  // correlate identical payloads without leaking the contents.
  return `[REDACTED-RAW sha256:${sha256Hex(value).slice(0, 16)}]`;
}

function scrubUrlCredentials(value: string) {
  return value.replace(URL_CREDENTIAL_PATTERN, '$1[REDACTED]@');
}

function scrubInlineCredentials(value: string) {
  return scrubUrlCredentials(value)
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi,
      '[REDACTED-PRIVATE-KEY]'
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(
      /\b(authorization|token|secret|password|private[_-]?key|signing[_-]?key|mnemonic|seed|passphrase|credential|wif|api[_-]?key)\b(\s*[:=]\s*)(["'])(.*?)\3/gi,
      '$1$2$3[REDACTED]$3'
    )
    .replace(
      /\b(authorization|token|secret|password|private[_-]?key|signing[_-]?key|mnemonic|seed|passphrase|credential|wif|api[_-]?key)\b(\s*[:=]\s*)(?!["']|\[REDACTED\])([^\s,;}&]+)/gi,
      '$1$2[REDACTED]'
    );
}

function sanitizeErrorText(value: string) {
  const raw = trimString(value);
  if (!raw) return '';

  const parsed = safeJsonParse(raw);
  const sanitized =
    parsed && (isPlainObject(parsed) || Array.isArray(parsed))
      ? JSON.stringify(sanitizeValue(parsed))
      : scrubInlineCredentials(raw);
  if (sanitized.length <= MAX_ERROR_CHARS) return sanitized;

  const suffix = `... [TRUNCATED sha256:${sha256Hex(raw).slice(0, 16)}]`;
  return `${sanitized.slice(0, MAX_ERROR_CHARS - suffix.length)}${suffix}`;
}

function sanitizeValue(value: unknown, path: string[] = []): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value))
    return value.map((item, index) => sanitizeValue(item, [...path, String(index)]));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, current]) => {
        const nextPath = [...path, key];
        return [key, shouldRedactField(nextPath) ? '[REDACTED]' : sanitizeValue(current, nextPath)];
      })
    );
  }
  if (typeof value === 'string') {
    const currentKey = path[path.length - 1] || '';
    if (shouldRedactField(path)) return '[REDACTED]';
    if (shouldPreserveCiphertext(path)) return value;
    // Value-shape redaction: raw/opaque payload strings can smuggle secrets the
    // key-name pass cannot see, so treat the whole value as opaque.
    if (RAW_PAYLOAD_KEY_PATTERN.test(currentKey)) return redactOpaque(value);
    if (ERROR_TEXT_KEY_PATTERN.test(currentKey)) return sanitizeErrorText(value);
    return scrubInlineCredentials(value);
  }
  return value;
}

function normalizeJsonStringPayload(value: unknown): unknown {
  // Several routes log the raw request body as a JSON *string*
  // (e.g. requestPayload: await request.text() in the NeoDID/oracle proxies).
  // A root-level JSON string has no keys, so the key-name redactor in
  // sanitizeValue would pass it through verbatim and leak secrets embedded in
  // it (id_token, private_key, wif, neodid_secret_salt). Parse a JSON
  // object/array string so its fields are sanitized like a normal payload;
  // non-JSON strings fall through to sanitizeValue's value-shape pass.
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  if (trimmed.length > MAX_JSON_CHARS) {
    return {
      truncated: true,
      omitted: 'large JSON string payload',
      size: value.length,
      sha256: sha256Hex(value),
    };
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function compactJsonValue(value: unknown) {
  const sanitized = sanitizeValue(normalizeJsonStringPayload(value));
  try {
    const serialized = JSON.stringify(sanitized);
    if (serialized.length <= MAX_JSON_CHARS) return sanitized;
    return {
      truncated: true,
      size: serialized.length,
      sha256: sha256Hex(serialized),
      preview: serialized.slice(0, 1024),
    };
  } catch {
    return { serialization_error: true };
  }
}

function collectEncryptedFields(
  value: unknown,
  path: string[] = [],
  results: Array<{ field_path: string; ciphertext: string; algorithm: string }> = []
) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectEncryptedFields(entry, [...path, String(index)], results)
    );
    return results;
  }
  if (!isPlainObject(value)) return results;

  for (const [key, current] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (shouldRedactField(nextPath)) continue;
    const preserve = key.startsWith('encrypted_') || path.includes('encrypted_inputs');
    if (preserve && typeof current === 'string' && trimString(current)) {
      const raw = trimString(current);
      let algorithm = 'client-supplied-ciphertext';
      try {
        const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
          'utf8'
        );
        const parsed = safeJsonParse(decoded);
        if (isPlainObject(parsed) && trimString(parsed.algorithm)) {
          algorithm = trimString(parsed.algorithm);
        }
      } catch {
        // keep default
      }
      results.push({
        field_path: nextPath.join('.'),
        ciphertext: raw,
        algorithm,
      });
      continue;
    }
    collectEncryptedFields(current, nextPath, results);
  }
  return results;
}

function resolveTargetChain(requestPayload: unknown, metadata: Record<string, unknown>) {
  const fromRequest = isPlainObject(requestPayload) ? trimString(requestPayload.target_chain) : '';
  const fromMetadata = trimString(metadata.target_chain);
  const candidate = fromRequest || fromMetadata;
  return candidate === 'neo_n3' ? candidate : null;
}

function resolveOperationNetwork(
  requestPayload: unknown,
  metadata: Record<string, unknown>
): MorpheusNetwork {
  const requestObject = isPlainObject(requestPayload) ? requestPayload : {};
  const fromRequest = trimString(requestObject.network || requestObject.morpheus_network);
  const fromMetadata = trimString(metadata.network || metadata.morpheus_network);
  return resolveSupabaseNetwork(fromRequest || fromMetadata);
}

// Defers log persistence until after the response is sent, so the per-request
// Supabase INSERTs (up to two: the operation row + encrypted-secret rows) and the
// BetterStack post never block the response. Mirrors the established pattern in
// betterstack-log-sink.ts: after() defers work to the post-response tail of the
// request context (kept alive by the Next.js runtime); if after() is unavailable
// (e.g. invoked outside a request context, or under the Vitest runtime without
// Next's request lifecycle), fall back to fire-and-forget rather than dropping
// the log.
//
// The row is fully built BEFORE deferral, so no request-scoped data is referenced
// in the tail — only the prepared insert args.
//
// Each scheduled persist promise is tracked in `pendingPersists` so tests can
// deterministically await it via `flushPendingOperationLogs()` (after() is
// non-awaitable by design, so this is the only way to observe completion in a
// test). Production code never awaits this array.
const pendingPersists: Array<Promise<unknown>> = [];

function schedulePersist(persist: () => Promise<void>) {
  const run = () => persist().catch(() => {});
  try {
    after(async () => {
      await persist();
    });
  } catch {
    // after() throws when not in a request context (or on a runtime without it);
    // never let logging errors propagate to the caller. Fire-and-forget instead,
    // tracking the promise so tests can flush deterministically.
    pendingPersists.push(run());
  }
}

/** Test-only: await all deferred operation-log persists. No-op in production. */
export async function flushPendingOperationLogs() {
  while (pendingPersists.length > 0) {
    const pending = pendingPersists.splice(0);
    await Promise.allSettled(pending);
  }
}

export async function recordOperationLog(input: OperationLogInput) {
  try {
    if (shouldSampleOutMonitoringRead(input)) return;

    const supabase = getServerSupabaseClient();
    if (!supabase) return;

    // ── Build the row synchronously (only awaits what's needed to construct it) ──
    const metadata = isPlainObject(input.metadata) ? { ...input.metadata } : {};
    if (input.method.toUpperCase() === 'GET') {
      // The upstream candidate list is identical for every GET probe and only
      // inflates row size; keep it on mutating operations where the chosen
      // upstream matters for forensics.
      delete metadata.upstream_candidates;
    }
    const requestObject = isPlainObject(input.requestPayload) ? input.requestPayload : {};
    const projectSlug = trimString(requestObject.project_slug || metadata.project_slug || '');
    const network = resolveOperationNetwork(input.requestPayload, metadata);
    const targetChain = resolveTargetChain(input.requestPayload, metadata);
    const requestId = trimString(requestObject.request_id || metadata.request_id || '');
    const operationId = trimString(metadata.operation_id || '') || randomUUID();

    let projectId: string | null = null;
    if (projectSlug) {
      try {
        projectId = await resolveProjectIdBySlug(supabase, projectSlug, network);
      } catch {
        projectId = null;
      }
    }

    // Capture the prepared insert payload as plain values so nothing references
    // request-scoped objects after the response is sent.
    const sanitizedError = sanitizeErrorText(input.error || '') || null;
    const isErrorResponse = Boolean(sanitizedError) || (input.httpStatus || 0) >= 400;
    const responsePayload =
      input.responsePayload === undefined
        ? null
        : typeof input.responsePayload === 'string' && isErrorResponse
          ? sanitizeErrorText(input.responsePayload)
          : compactJsonValue(input.responsePayload);
    const operationRow = {
      operation_id: operationId,
      network,
      route: input.route,
      method: input.method.toUpperCase(),
      category: input.category,
      project_id: projectId,
      project_slug: projectSlug || null,
      request_id: requestId || null,
      target_chain: targetChain,
      status:
        input.httpStatus && input.httpStatus >= 200 && input.httpStatus < 400 ? 'ok' : 'error',
      http_status: input.httpStatus || null,
      request_payload: compactJsonValue(input.requestPayload),
      response_payload: responsePayload,
      error: sanitizedError,
      metadata: compactJsonValue(metadata),
    };

    // BetterStack post is already post-response (it uses after() internally); build
    // its compacted payload here so no request objects leak into the deferred tail.
    const betterStackRecord = {
      route: input.route,
      method: input.method.toUpperCase(),
      category: input.category,
      network,
      target_chain: targetChain,
      project_slug: projectSlug || null,
      request_id: requestId || null,
      operation_id: operationId,
      status:
        input.httpStatus && input.httpStatus >= 200 && input.httpStatus < 400 ? 'ok' : 'error',
      http_status: input.httpStatus || null,
      error: sanitizedError,
      request_payload: operationRow.request_payload,
      response_payload: operationRow.response_payload,
      metadata: operationRow.metadata,
    };

    // Encrypted-field rows are derived once, here, from the (still in-scope) request
    // payload rather than inside the deferred tail.
    const encryptedFields = targetChain ? collectEncryptedFields(input.requestPayload) : [];

    // ── Defer all I/O to the post-response tail ──
    schedulePersist(async () => {
      const operationLogs = supabase.from('morpheus_operation_logs') as any;
      await operationLogs.insert(operationRow);

      emitBetterStackOperationLog(betterStackRecord);

      if (encryptedFields.length === 0) return;

      const rows = encryptedFields.map((entry) => ({
        project_id: projectId,
        network,
        name: `${input.route}:${operationId}:${entry.field_path}`,
        target_chain: targetChain,
        encryption_algorithm: entry.algorithm,
        key_version: 1,
        ciphertext: entry.ciphertext,
        metadata: {
          operation_id: operationId,
          route: input.route,
          method: input.method.toUpperCase(),
          network,
          request_id: requestId || null,
          field_path: entry.field_path,
          ciphertext_sha256: sha256Hex(entry.ciphertext),
        },
      }));

      const encryptedSecrets = supabase.from('morpheus_encrypted_secrets') as any;
      await encryptedSecrets.insert(rows);
    });
  } catch (error) {
    console.warn('[morpheus] failed to record operation log', error);
  }
}
