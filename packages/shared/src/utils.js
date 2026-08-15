/**
 * HTTP JSON response helper
 */
export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * Safely trims string values, returns empty string for non-strings
 */
export function trimString(value) {
  return String(value || '').trim();
}

/**
 * Canonical boolean-env parser (three-way): explicit truthy tokens
 * (`1`/`true`/`yes`/`on`) return true, explicit falsy tokens
 * (`0`/`false`/`no`/`off`) return false, and anything unrecognized — including
 * undefined/empty — returns the fallback. Falling back on an unrecognized token
 * (rather than silently returning false) means a typo'd env keeps the intended
 * default. Matching case-insensitively.
 *
 * This is the single source for permissive boolean toggles so a value accepted
 * by one subsystem is accepted by every other. Security controls that
 * intentionally use a narrower token set (e.g. the script sandbox worker/child
 * gates, MORPHEUS_ALLOW_UNPINNED_SIGNERS) keep their own conservative parser and
 * must NOT be pointed here without a deliberate widening decision.
 */
export function parseBooleanEnv(value, fallback = false) {
  const raw = trimString(value).toLowerCase();
  if (!raw) return fallback;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return fallback;
}

/**
 * Parse an ISO timestamp string to milliseconds since epoch
 * Returns 0 if parsing fails
 */
export function parseTimestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Get client IP address from request headers.
 *
 * SECURITY (S2): only platform-injected IP headers are trusted. Cloudflare
 * Workers always set `cf-connecting-ip`; Vercel sets `x-vercel-forwarded-for`.
 * `x-real-ip`, `x-client-ip` and a bare `x-forwarded-for` are client-controllable
 * whenever the request does not pass through a trusted proxy, and using them as
 * rate-limit keys would let an attacker mint a fresh bucket per request. When no
 * platform header is present we return 'unknown' so callers fail toward a shared
 * (over-limiting) bucket rather than a bypassable per-IP one.
 */
export function getClientIp(request) {
  const headers = request.headers;
  const platform =
    trimString(headers.get('cf-connecting-ip')) ||
    trimString(headers.get('x-vercel-forwarded-for'));
  if (platform) return trimString(platform.split(',')[0]);

  return 'unknown';
}

/**
 * Constant-time string comparison safe against timing attacks.
 * Works in all JS runtimes (Node, Cloudflare Workers, Deno).
 */
export function timingSafeCompare(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

/**
 * Bounded-concurrency map preserving input order, with fail-fast abort.
 *
 * Runs `worker(item, index)` over `items` with at most `limit` concurrent
 * invocations (clamped to `[1, items.length]`). Results are written back at
 * their original index so the resolved array matches the sequential
 * `items.map(worker)` ordering exactly.
 *
 * Fail-fast semantics: once any worker throws, the shared cursor is frozen so
 * idle workers stop pulling new items (in-flight workers still settle), and the
 * first thrown error rejects the returned promise. This is the abort-the-tick
 * default the relayer's engine scans rely on — a faulted scan must not keep
 * issuing RPC calls for the rest of the range, and the rejection must propagate
 * so a partially-scanned cursor is never advanced. Callers that need every item
 * attempted regardless of individual failures must NOT use this helper.
 */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  let failed = false;

  async function runWorker() {
    while (!failed) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }

  const width = Math.max(Math.min(limit, items.length), 1);
  await Promise.all(Array.from({ length: width }, () => runWorker()));
  return results;
}

// Bounded scan concurrency for mapWithConcurrency: a positive numeric
// config.concurrency is clamped to [1, 8]; anything else falls back to 4.
export function resolveScanConcurrency(config) {
  const limit = Number(config?.concurrency);
  return Number.isFinite(limit) && limit > 0 ? Math.min(limit, 8) : 4;
}

/**
 * Deterministic JSON stringification shared across worker, relayer, and web
 * verification flows so digest calculations stay byte-for-byte aligned.
 *
 * This is the canonical implementation behind the nitro-worker's signed
 * `output_hash` digests, pinned by the golden vectors in
 * stable-stringify-vectors.mjs. Semantics (do NOT change without rotating the
 * verification scheme — live signatures were produced from these bytes):
 * - `null`/`undefined` serialize as `null` at the top level and inside
 *   arrays; object entries whose value is `undefined` are dropped.
 * - `bigint` serializes as its decimal string in quotes.
 * - Object keys sort via a locale-pinned collator (NOT code-unit order); this
 *   matches every digest the worker has ever signed. The collation is pinned
 *   to `Intl.Collator('en', { sensitivity: 'variant', caseFirst: 'false' })`
 *   so the sort no longer depends on the host's default locale: a bare
 *   `String.prototype.localeCompare()` resolves against the runtime's default
 *   locale, which can differ per box/region and would silently reorder mixed
 *   alphabet/case keys, producing a different digest for the same payload.
 *   Pinning the locale removes that environment axis (verified byte-identical
 *   to the prior `localeCompare` output across all golden vectors); it does
 *   NOT remove the residual ICU-version dependency, which is consistent across
 *   the deployed Node runtimes.
 * - Typed arrays get no special casing (plain-object numeric keys).
 */
const STABLE_KEY_COLLATOR = new Intl.Collator('en', {
  sensitivity: 'variant',
  caseFirst: 'false',
});

export function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => STABLE_KEY_COLLATOR.compare(a, b));
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(',')}}`;
}
