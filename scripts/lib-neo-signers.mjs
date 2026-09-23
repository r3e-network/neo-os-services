// Thin shim over packages/shared/src/neo-signers-core.js. The shared core holds
// all the role-pinning logic; this file only loads config/signer-identities.json
// from the repo root (resolved relative to THIS file's location, unchanged) and
// injects it. The import is a relative path (not the @r3e-network/neo-os-services-shared
// package specifier) so it resolves in the legacy Nitro signer image, which copies
// scripts/lib-neo-signers.mjs + packages/shared/src/neo-signers-core.js without
// installing the workspace symlink. See deploy/nitro/Dockerfile.signer-legacy —
// the custody image (deploy/nitro/Dockerfile.signer) is Rust-only and ships no
// JavaScript, so it needs neither file; the host-side importers that still read
// the registry (scripts/check-neo-signers.mjs, scripts/check-nitro-prereqs.mjs,
// deploy/nitro/enclave-server.mjs, deploy/nitro/nitro-signer-server.mjs) resolve
// it from the checkout instead. workers/morpheus-relayer/src/lib/neo-signers.js
// is a second, equivalent shim for the same reason.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NEO_N3_SIGNER_ENV_KEYS,
  NEO_N3_SIGNER_PUBLIC_ENV_KEYS,
  normalizeMorpheusNetwork,
  normalizeHash160,
  materializeNeoN3Secret,
  NEO_N3_RETIRED_PLAINTEXT_KEY_ENV_NAMES,
  NEO_N3_PLAINTEXT_KEY_RETIRED_CODE,
  assertNoRetiredPlaintextSigner,
  createPinnedRoleResolvers,
} from '../packages/shared/src/neo-signers-core.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '..');
const registryPath = path.resolve(repoRoot, 'config', 'signer-identities.json');
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

export {
  NEO_N3_SIGNER_ENV_KEYS,
  NEO_N3_SIGNER_PUBLIC_ENV_KEYS,
  normalizeMorpheusNetwork,
  normalizeHash160,
  materializeNeoN3Secret,
  NEO_N3_RETIRED_PLAINTEXT_KEY_ENV_NAMES,
  NEO_N3_PLAINTEXT_KEY_RETIRED_CODE,
  assertNoRetiredPlaintextSigner,
};

export const {
  getPinnedNeoN3Role,
  resolvePinnedNeoN3Role,
  resolvePinnedNeoN3RolePreferMatch,
  reportPinnedNeoN3Role,
  reportPinnedNeoN3Roles,
  resolvePinnedNeoN3UpdaterHash,
  resolvePinnedNeoN3VerifierPublicKey,
} = createPinnedRoleResolvers(registry);
