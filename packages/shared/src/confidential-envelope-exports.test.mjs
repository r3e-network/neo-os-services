import test from 'node:test';
import assert from 'node:assert/strict';

// Export-surface guard for the confidential envelope: it is the single
// reference implementation vendored (hash-pinned) into neo-os-devpack
// and neo-abstract-account, so it must be importable as a package subpath
// instead of forcing file-level vendoring where a workspace import is possible.

import {
  CONFIDENTIAL_ENVELOPE_VERSION,
  CONFIDENTIAL_ENVELOPE_ALGORITHM,
  CONFIDENTIAL_ENVELOPE_INFO,
} from '@r3e-network/neo-os-services-shared/confidential-envelope';

test('confidential-envelope subpath export resolves with the v2 wire constants', () => {
  assert.equal(CONFIDENTIAL_ENVELOPE_VERSION, 2);
  assert.equal(CONFIDENTIAL_ENVELOPE_ALGORITHM, 'X25519-HKDF-SHA256-AES-256-GCM');
  assert.equal(CONFIDENTIAL_ENVELOPE_INFO, 'morpheus-confidential-payload-v2');
});
