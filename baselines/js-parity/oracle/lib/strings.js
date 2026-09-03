// Shared relayer string helpers.
//
// `trimString` here intentionally keeps the relayer's strict, type-preserving
// semantics: non-string inputs collapse to '' rather than being coerced via
// String(). This is load-bearing — several call sites rely on a non-string
// value becoming '' (e.g. router.js length-prefixed UTF-8 / hash encoders and
// neo-n3.js settlement detection treat '' as "absent"), where String()-coercion
// of a number/object/boolean would silently produce a different encoding or a
// false "already settled" decision. Do NOT swap this for the
// `@r3e-network/neo-os-services-shared/utils` trimString (which uses String(value || '')
// coercion) without auditing every call site.
export function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Canonical request-type normalization (single source of truth shared by
// router.js, automation.js and fulfillment.js). This token is consensus-adjacent:
// it selects the worker route, derives moduleId/operation feeding the fulfillment
// digest, and gates the operator-only lane — divergent copies could route a
// request to a different worker than it signs a digest for. It deliberately uses
// the strict trimString above (non-strings -> ''), so a non-string requestType
// normalizes to '' rather than a String()-coerced token.
export function normalizeRequestType(value) {
  return trimString(value)
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

// Coerce a value to a non-negative integer count; non-finite or negative -> 0.
export function parseNonNegativeInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.trunc(numeric);
}

// Remove a leading 0x/0X prefix, preserving the remaining characters VERBATIM
// (no case-folding). This is the single source for prefix stripping across the
// relayer. Call sites that need case-insensitive comparison (e.g. neo-n3.js
// script-hash / public-key matching) lower-case the result themselves, so the
// primitive stays safe for digest paths that must not alter the byte string.
export function strip0x(value) {
  return trimString(value).replace(/^0x/i, '');
}
