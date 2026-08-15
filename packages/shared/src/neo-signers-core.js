// Single source of truth for Neo N3 signer-key resolution + role pinning, shared
// by the relayer (workers/morpheus-relayer/src/lib/neo-signers.js) and the ops
// scripts/enclave (scripts/lib-neo-signers.mjs). Those two files are thin shims
// that load config/signer-identities.json from their own location and inject it
// into createPinnedRoleResolvers() — keeping registry-path resolution exactly
// where each runtime context already resolves it (unchanged), while this module
// holds the logic once. This file is self-contained (only neon-js) so the minimal
// signer enclave image can ship it as a single file with no extra deps.
import { wallet } from '@cityofzion/neon-js';

// Strict trim: '' for any non-string (no coercion). Matches the relayer's
// lib/strings.js and the scripts copy this module replaces.
function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export const NEO_N3_SIGNER_ENV_KEYS = [
  'NEO_TESTNET_WIF',
  'NEO_N3_WIF',
  'MORPHEUS_WORKER_NEO_N3_WIF',
  'MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY',
  'MORPHEUS_WORKER_NEO_N3_WIF_TESTNET',
  'MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY_TESTNET',
  'MORPHEUS_WORKER_NEO_N3_WIF_MAINNET',
  'MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY_MAINNET',
  'MORPHEUS_RELAYER_NEO_N3_WIF',
  'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY',
  'MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET',
  'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_TESTNET',
  'MORPHEUS_RELAYER_NEO_N3_WIF_MAINNET',
  'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_MAINNET',
  'MORPHEUS_UPDATER_NEO_N3_WIF',
  'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY',
  'MORPHEUS_UPDATER_NEO_N3_WIF_TESTNET',
  'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_TESTNET',
  'MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET',
  'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_MAINNET',
  'MORPHEUS_ORACLE_VERIFIER_WIF',
  'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY',
  'MORPHEUS_ORACLE_VERIFIER_WIF_TESTNET',
  'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY_TESTNET',
  'MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET',
  'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY_MAINNET',
  'MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY',
  'MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY_TESTNET',
  'MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY_MAINNET',
];

const ROLE_KEY_GROUPS = {
  testnet: {
    worker: {
      primary: [
        'MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY_TESTNET',
        'MORPHEUS_WORKER_NEO_N3_WIF_TESTNET',
        'MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY',
        'MORPHEUS_WORKER_NEO_N3_WIF',
      ],
      fallback: [
        'NEO_TESTNET_WIF',
        'NEO_N3_WIF',
        'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_TESTNET',
        'MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET',
        'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY',
        'MORPHEUS_RELAYER_NEO_N3_WIF',
      ],
    },
    relayer: {
      primary: [
        'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_TESTNET',
        'MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET',
        'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_TESTNET',
        'MORPHEUS_UPDATER_NEO_N3_WIF_TESTNET',
      ],
      fallback: [
        'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY',
        'MORPHEUS_RELAYER_NEO_N3_WIF',
        'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY',
        'MORPHEUS_UPDATER_NEO_N3_WIF',
      ],
    },
    updater: {
      primary: [
        'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_TESTNET',
        'MORPHEUS_UPDATER_NEO_N3_WIF_TESTNET',
        'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_TESTNET',
        'MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET',
      ],
      fallback: [
        'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY',
        'MORPHEUS_UPDATER_NEO_N3_WIF',
        'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY',
        'MORPHEUS_RELAYER_NEO_N3_WIF',
      ],
    },
    oracle_verifier: {
      primary: [
        'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY_TESTNET',
        'MORPHEUS_ORACLE_VERIFIER_WIF_TESTNET',
        'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY',
        'MORPHEUS_ORACLE_VERIFIER_WIF',
      ],
      fallback: [
        'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_TESTNET',
        'MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET',
        'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY',
        'MORPHEUS_RELAYER_NEO_N3_WIF',
      ],
      public: ['MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY_TESTNET'],
      allowPublicKeyOnly: true,
    },
  },
  mainnet: {
    worker: {
      primary: ['MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY_MAINNET', 'MORPHEUS_WORKER_NEO_N3_WIF_MAINNET'],
      fallback: ['NEO_N3_WIF', 'NEO_TESTNET_WIF'],
    },
    relayer: {
      primary: [
        'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_MAINNET',
        'MORPHEUS_RELAYER_NEO_N3_WIF_MAINNET',
      ],
      fallback: [
        'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY',
        'MORPHEUS_RELAYER_NEO_N3_WIF',
        'NEO_N3_WIF',
        'NEO_TESTNET_WIF',
      ],
    },
    updater: {
      primary: [
        'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_MAINNET',
        'MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET',
      ],
      fallback: [
        'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY',
        'MORPHEUS_UPDATER_NEO_N3_WIF',
        'NEO_N3_WIF',
        'NEO_TESTNET_WIF',
      ],
    },
    oracle_verifier: {
      primary: [
        'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY_MAINNET',
        'MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET',
      ],
      fallback: ['MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY', 'MORPHEUS_ORACLE_VERIFIER_WIF'],
      public: [
        'MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY_MAINNET',
        'MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY',
      ],
      allowPublicKeyOnly: true,
    },
  },
};

export function normalizeMorpheusNetwork(value) {
  return trimString(value || 'testnet').toLowerCase() === 'mainnet' ? 'mainnet' : 'testnet';
}

export function normalizeHash160(value) {
  const raw = trimString(value);
  if (!raw) return '';
  if (wallet.isAddress(raw)) {
    return `0x${wallet.getScriptHashFromAddress(raw).toLowerCase()}`;
  }
  const hex = raw.replace(/^0x/i, '').toLowerCase();
  return /^[0-9a-f]{40}$/.test(hex) ? `0x${hex}` : '';
}

function normalizePublicKey(value) {
  const hex = trimString(value).replace(/^0x/i, '').toLowerCase();
  return /^[0-9a-f]{66}$/.test(hex) || /^[0-9a-f]{130}$/.test(hex) ? hex : '';
}

function toEnvSnapshot(env = process.env) {
  if (typeof env === 'function') {
    const snapshot = {};
    for (const key of NEO_N3_SIGNER_ENV_KEYS) {
      const value = trimString(env(key));
      if (value) snapshot[key] = value;
    }
    return snapshot;
  }
  return env || {};
}

function uniqueOrdered(values) {
  return [...new Set(values)];
}

function isTrueLike(value) {
  const normalized = trimString(value).toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function describeIdentity(identity) {
  if (!identity) return null;
  return {
    address: identity.address || null,
    script_hash: identity.script_hash || null,
    public_key: identity.public_key || null,
  };
}

export function materializeNeoN3Secret(secret) {
  const normalized = trimString(secret);
  if (!normalized) return null;
  const account = new wallet.Account(normalized);
  return {
    raw: normalized,
    wif: account.WIF || '',
    private_key: account.privateKey || '',
    identity: {
      address: account.address,
      script_hash: `0x${account.scriptHash}`,
      public_key: normalizePublicKey(account.publicKey),
    },
  };
}

function identityMatchesPinned(identity, pinned) {
  if (!identity || !pinned) return false;
  if (
    pinned.script_hash &&
    normalizeHash160(identity.script_hash) !== normalizeHash160(pinned.script_hash)
  ) {
    return false;
  }
  if (pinned.address && normalizeHash160(identity.address) !== normalizeHash160(pinned.address)) {
    return false;
  }
  if (
    pinned.public_key &&
    normalizePublicKey(identity.public_key) !== normalizePublicKey(pinned.public_key)
  ) {
    return false;
  }
  return true;
}

function identityFingerprint(identity) {
  if (!identity) return '';
  return [normalizeHash160(identity.script_hash), normalizePublicKey(identity.public_key)].join(
    '|'
  );
}

function collectSecrets(snapshot, keys) {
  const out = [];
  for (const key of uniqueOrdered(keys)) {
    const value = trimString(snapshot[key]);
    if (!value) continue;
    try {
      const materialized = materializeNeoN3Secret(value);
      out.push({
        key,
        value_present: true,
        materialized,
        identity: materialized.identity,
      });
    } catch (error) {
      out.push({
        key,
        value_present: true,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}

function collectPublicKeys(snapshot, keys) {
  const out = [];
  for (const key of uniqueOrdered(keys)) {
    const value = normalizePublicKey(snapshot[key]);
    if (!value) continue;
    out.push({ key, public_key: value });
  }
  return out;
}

function formatIssues(role, issues) {
  if (!issues.length) return '';
  return `${role} signer drift: ${issues.join('; ')}`;
}

// Bind the role-pinning resolvers to a loaded signer-identities registry. The
// registry is the ONLY input that differs between runtime contexts, and it is the
// sole consumer of the filesystem — each caller loads it from its own known path
// and injects it here, so this module never touches the filesystem.
//
// `strict` (in buildRoleReport) replaces a former three-value `mode`
// ('strict' | 'prefer-match' | 'report'). Only 'strict' was ever load-bearing —
// it is the sole value that turns pinning issues into a throw. 'prefer-match' and
// 'report' behaved identically (non-throwing) and `mode` was never returned or
// read by any caller, so the tri-state collapses to a boolean.
export function createPinnedRoleResolvers(registry) {
  function getPinnedNeoN3Role(network, role) {
    const normalizedNetwork = normalizeMorpheusNetwork(network);
    return registry.neo_n3?.[normalizedNetwork]?.roles?.[role] || null;
  }

  function buildRoleReport({
    network,
    role,
    env = process.env,
    strict = true,
    allowMissing = false,
  }) {
    const normalizedNetwork = normalizeMorpheusNetwork(network);
    const snapshot = toEnvSnapshot(env);
    const allowUnpinned =
      isTrueLike(process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS) ||
      (typeof env === 'object' && env !== null && isTrueLike(env.MORPHEUS_ALLOW_UNPINNED_SIGNERS));
    const pinned = allowUnpinned ? null : getPinnedNeoN3Role(normalizedNetwork, role);
    const config = ROLE_KEY_GROUPS[normalizedNetwork]?.[role];
    if (!config) {
      throw new Error(`unsupported Neo N3 signer role: ${role}`);
    }

    const primaryCandidates = collectSecrets(snapshot, config.primary || []);
    const fallbackCandidates = collectSecrets(snapshot, config.fallback || []);
    const publicCandidates = collectPublicKeys(snapshot, config.public || []);
    const issues = [];

    const primaryValid = primaryCandidates.filter((entry) => entry.identity);
    const fallbackValid = fallbackCandidates.filter((entry) => entry.identity);
    const primaryFingerprints = uniqueOrdered(
      primaryValid.map((entry) => identityFingerprint(entry.identity))
    );
    const fallbackFingerprints = uniqueOrdered(
      fallbackValid.map((entry) => identityFingerprint(entry.identity))
    );

    for (const entry of [...primaryCandidates, ...fallbackCandidates]) {
      if (entry.error) {
        issues.push(`${entry.key} is not a valid Neo N3 signer secret`);
      }
    }

    if (primaryFingerprints.length > 1) {
      issues.push(`primary keys disagree (${primaryValid.map((entry) => entry.key).join(', ')})`);
    }
    if (!primaryValid.length && fallbackFingerprints.length > 1) {
      issues.push(`fallback keys disagree (${fallbackValid.map((entry) => entry.key).join(', ')})`);
    }

    const primaryMatch = primaryValid.find((entry) =>
      identityMatchesPinned(entry.identity, pinned)
    );
    const fallbackMatch = fallbackValid.find((entry) =>
      identityMatchesPinned(entry.identity, pinned)
    );
    const publicKeyMatch = publicCandidates.find(
      (entry) =>
        !pinned?.public_key ||
        normalizePublicKey(entry.public_key) === normalizePublicKey(pinned.public_key)
    );
    const requireFallbackMatch = !(allowMissing && primaryCandidates.length === 0);

    if (primaryValid.length && pinned && !primaryMatch) {
      issues.push(
        `primary keys do not match pinned ${role} identity ${pinned.script_hash || pinned.public_key || ''}`.trim()
      );
    }
    if (
      !primaryValid.length &&
      fallbackValid.length &&
      pinned &&
      !fallbackMatch &&
      requireFallbackMatch
    ) {
      issues.push(
        `fallback keys do not match pinned ${role} identity ${pinned.script_hash || pinned.public_key || ''}`.trim()
      );
    }
    if (publicCandidates.length && pinned?.public_key && !publicKeyMatch) {
      issues.push(`public key override does not match pinned ${role} verifier key`);
    }

    let selected = primaryMatch || fallbackMatch || null;
    if (!selected && !pinned) {
      selected = primaryValid[0] || fallbackValid[0] || null;
    }

    const public_key =
      selected?.identity?.public_key ||
      publicKeyMatch?.public_key ||
      normalizePublicKey(pinned?.public_key || '') ||
      '';

    const publicKeyOnlyAllowed = Boolean(config.allowPublicKeyOnly && public_key);
    const ok = issues.length === 0 && (Boolean(selected) || publicKeyOnlyAllowed || allowMissing);

    if (!ok && !allowMissing && !selected) {
      issues.push(`no usable ${role} signer configured`);
    }

    const report = {
      network: normalizedNetwork,
      role,
      pinned: pinned ? { ...pinned } : null,
      selected_source: selected?.key || null,
      selected_identity: describeIdentity(selected?.identity || null),
      public_key: public_key || null,
      primary_sources_present: primaryCandidates.map((entry) => entry.key),
      fallback_sources_present: fallbackCandidates.map((entry) => entry.key),
      public_sources_present: publicCandidates.map((entry) => entry.key),
      issues,
      ok,
      materialized: selected?.materialized || null,
    };

    if (strict && issues.length) {
      throw new Error(formatIssues(role, issues));
    }

    return report;
  }

  function resolvePinnedNeoN3Role(network, role, options = {}) {
    return buildRoleReport({ network, role, strict: true, ...options });
  }

  function resolvePinnedNeoN3RolePreferMatch(network, role, options = {}) {
    return buildRoleReport({ network, role, strict: false, ...options });
  }

  function reportPinnedNeoN3Role(network, role, options = {}) {
    return buildRoleReport({ network, role, strict: false, ...options });
  }

  function reportPinnedNeoN3Roles(network, roles, options = {}) {
    return roles.map((role) => reportPinnedNeoN3Role(network, role, options));
  }

  function resolvePinnedNeoN3UpdaterHash(network, env = process.env) {
    const report = reportPinnedNeoN3Role(normalizeMorpheusNetwork(network), 'updater', {
      env,
      allowMissing: true,
    });
    if (report.issues.length > 0) {
      throw new Error(formatIssues('updater', report.issues));
    }
    return normalizeHash160(
      report.selected_identity?.script_hash || report.pinned?.script_hash || ''
    );
  }

  function resolvePinnedNeoN3VerifierPublicKey(network, env = process.env) {
    const report = reportPinnedNeoN3Role(normalizeMorpheusNetwork(network), 'oracle_verifier', {
      env,
      allowMissing: false,
    });
    const publicKey = normalizePublicKey(report.public_key || report.pinned?.public_key || '');
    if (!publicKey) {
      throw new Error(`oracle_verifier signer drift: no pinned verifier public key for ${network}`);
    }
    if (report.issues.length > 0) {
      throw new Error(formatIssues('oracle_verifier', report.issues));
    }
    return publicKey;
  }

  return {
    getPinnedNeoN3Role,
    resolvePinnedNeoN3Role,
    resolvePinnedNeoN3RolePreferMatch,
    reportPinnedNeoN3Role,
    reportPinnedNeoN3Roles,
    resolvePinnedNeoN3UpdaterHash,
    resolvePinnedNeoN3VerifierPublicKey,
  };
}
