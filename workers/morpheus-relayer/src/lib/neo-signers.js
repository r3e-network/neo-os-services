// Thin shim over packages/shared/src/neo-signers-core.js. The shared core holds
// all the role-pinning logic; this file only loads config/signer-identities.json
// from the repo root (resolved relative to THIS file's location, unchanged) and
// injects it. Imported via the @r3e-network/neo-os-services-shared package specifier,
// matching the relayer's other shared imports.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NEO_N3_SIGNER_ENV_KEYS,
  normalizeMorpheusNetwork,
  normalizeHash160,
  materializeNeoN3Secret,
  NEO_N3_RETIRED_PLAINTEXT_KEY_ENV_NAMES,
  NEO_N3_PLAINTEXT_KEY_RETIRED_CODE,
  assertNoRetiredPlaintextSigner,
  createPinnedRoleResolvers,
} from '@r3e-network/neo-os-services-shared/neo-signers-core';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '../../../../');
const registryPath = path.resolve(repoRoot, 'config', 'signer-identities.json');
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

export {
  NEO_N3_SIGNER_ENV_KEYS,
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
