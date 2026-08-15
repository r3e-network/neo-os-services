import { trimString } from './core.js';

/**
 * Parses SCRIPT_CHILD_ALLOW_NET and validates each entry. Rejects wildcard or
 * CIDR patterns that would allow arbitrary outbound access.
 *
 * @param {string} raw
 * @returns {{ entries: string[]; invalid: string[] }}
 */
export function parseAllowNet(raw) {
  const entries = trimString(raw)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const invalid = [];
  for (const entry of entries) {
    if (
      entry === '*' ||
      entry === '0.0.0.0/0' ||
      entry === '::/0' ||
      entry.startsWith('*.') ||
      !isValidAllowNetEntry(entry)
    ) {
      invalid.push(entry);
    }
  }

  return { entries, invalid };
}

/**
 * @param {string} entry
 * @returns {boolean}
 */
function isValidAllowNetEntry(entry) {
  // Allow a hostname (with optional port) or an IPv4/IPv6 address (with optional port).
  // Reject bare CIDRs, partial wildcards, and empty segments.
  if (!entry || entry.includes(' ')) return false;

  // Strip optional port
  const host = entry.replace(/:\d+$/, '');
  if (!host) return false;

  // Reject CIDR notation (we only allow specific hosts/addresses)
  if (host.includes('/')) return false;

  // Reject wildcard patterns in the hostname itself
  if (host.includes('*')) return false;

  // IPv4 literal
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    return ipv4.slice(1).every((octet) => Number(octet) <= 255);
  }

  // IPv6 literal (basic bracket check already stripped by port logic above)
  if (host.startsWith('[') && host.endsWith(']')) {
    return true; // Accept bracketed IPv6; deeper validation is overkill here.
  }
  if (host.includes(':') && !host.startsWith('[')) {
    // Could be an unbracketed IPv6; Node --allow-net accepts it, but we prefer brackets.
    return false;
  }

  // Hostname labels: alphanumeric, hyphens, underscores; labels cannot start/end with hyphen
  const labels = host.split('.');
  if (labels.length < 1) return false;
  return labels.every((label) => /^[a-zA-Z0-9]([a-zA-Z0-9\-_]*[a-zA-Z0-9])?$/.test(label));
}

// Dev-only escape hatch that disables the Node.js permission model for user
// script/WASM child processes. Deliberately long and distinctly named so it is
// never flipped by accident or mistaken for a general feature flag. The old
// SCRIPT_CHILD_ENABLE_PERMISSION_MODEL toggle is retired: it no longer has any
// effect, so a host operator cannot silently weaken the sandbox with it.
const UNSANDBOXED_CHILDREN_OVERRIDE_VAR = 'MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN';

function defaultReadEnv(name) {
  const value = process.env[name];
  return value === undefined ? undefined : String(value);
}

function isTruthyEnv(value) {
  return ['1', 'true', 'yes'].includes(trimString(value || '').toLowerCase());
}

/**
 * The child-process permission model is ENABLED BY DEFAULT and can only be
 * disabled through the explicit dev override MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN
 * (=1/true/yes). When NODE_ENV=production the override is IGNORED — the
 * permission model stays on no matter what the host operator sets (fail
 * closed).
 *
 * @returns {boolean}
 */
export function isChildProcessPermissionModelEnabled() {
  if (process.env.NODE_ENV === 'production') return true;
  return !isTruthyEnv(defaultReadEnv(UNSANDBOXED_CHILDREN_OVERRIDE_VAR));
}

/**
 * Validates that the network allowlist for script/WASM child processes is not
 * overly permissive. Throws on misconfiguration.
 *
 * The permission-model toggle itself needs no validation:
 * isChildProcessPermissionModelEnabled() is enabled by default, honors only the
 * MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN dev override, and ignores that override
 * under NODE_ENV=production (fail closed) — so no environment configuration can
 * accidentally run production children unsandboxed.
 *
 * @param {object} options
 * @param {string} [options.allowNetVar] - env var for the network allowlist
 * @param {() => string | undefined} [options.readEnv] - reader for the env vars
 */
export function validateChildProcessPermissions(options = {}) {
  const readEnv = options.readEnv || defaultReadEnv;

  const allowNetRaw = readEnv(options.allowNetVar || 'SCRIPT_CHILD_ALLOW_NET');
  if (allowNetRaw) {
    const { invalid } = parseAllowNet(allowNetRaw);
    if (invalid.length > 0) {
      throw new Error(
        `SCRIPT_CHILD_ALLOW_NET contains disallowed entries: ${invalid.join(', ')}. ` +
          'Wildcard or 0.0.0.0/0 allowlists are not permitted.'
      );
    }
  }
}
