// Canonical secret-name detection shared by every redaction sink.
//
// Two sinks decide whether an identifier names a secret:
//   - config-schema.js / config-introspect.js: env-var NAMES, to redact values
//     in `config:dump` (only set/unset + winning alias is shown for a secret).
//   - logger.js: object KEYS in structured logs, to redact secret-shaped values
//     before they egress to the external log sink.
//
// They previously kept independent lists, so a fragment present in one but not
// the other was a latent leak: e.g. config-schema lacked `api_key`, so an env
// var like FOO_API_KEY had its value printed verbatim in a dump; logger lacked
// `service_role_key`/`password`, so those keys leaked through structured logs.
// This module is the single source of truth — the UNION of both former lists —
// so neither sink can lose coverage relative to the other.
//
// Fragments are regex sources matched case-insensitively as substrings (no word
// boundaries — broad on purpose; over-redaction is the safe direction). The
// optional-underscore `_?` variants match both snake_case env names
// (PRIVATE_KEY) and camelCase/compact object keys (privateKey / privatekey).

export const SECRET_NAME_FRAGMENTS = [
  'wif',
  'private_?key',
  'api_?key',
  'secret',
  'token',
  'service_?role_?key',
  'service_?key',
  'password',
  'passphrase',
  'seed',
  'mnemonic',
  'authorization',
  'envelope',
  'plaintext',
];

export const SECRET_NAME_PATTERN = new RegExp(`(${SECRET_NAME_FRAGMENTS.join('|')})`, 'i');

/**
 * True when an identifier (env-var name or object key) names a secret-shaped
 * value that must be redacted. Non-strings are never secret.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSecretName(value) {
  return typeof value === 'string' && SECRET_NAME_PATTERN.test(value);
}

// SECURITY (S16): value-shape redaction for free-text strings (error messages,
// response bodies) that are not structured key/value logs. Key-name redaction
// cannot catch a secret that appears in prose or an opaque blob, so these
// patterns scrub the most common secret encodings:
//   - Bearer/Basic credentials
//   - Neo N3 WIF (52-char base58check, starts with K or L)
//   - a 64-hex value immediately following a secret-ish key name
// Over-redaction is the safe direction; a bare 64-hex string (e.g. a tx hash or
// a public digest) is deliberately NOT scrubbed to preserve log usability.
export const SECRET_VALUE_PATTERNS = [
  {
    source: 'bearer',
    // Case-insensitive on purpose (bearer/Bearer/BEARER), but the credential
    // itself must be at least 20 chars so prose like "invalid bearer" or a
    // short header name is not scrubbed.
    pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/gi,
    replacement: '$1 [REDACTED]',
  },
  {
    source: 'wif',
    pattern: /\b[KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/g,
    replacement: '[REDACTED-WIF]',
  },
  {
    source: 'key-context-hex',
    pattern:
      /(private[_-]?key|wif|signing[_-]?key|mnemonic|seed|passphrase|secret|token)(\s*[:=]\s*)((?:0x)?[0-9a-fA-F]{64})/gi,
    replacement: '$1$2[REDACTED]',
  },
];

/**
 * Apply every value-shape redaction pattern to free text. Non-strings pass
 * through unchanged.
 * @param {unknown} text
 * @returns {unknown}
 */
export function redactSecretValues(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const { pattern, replacement } of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
