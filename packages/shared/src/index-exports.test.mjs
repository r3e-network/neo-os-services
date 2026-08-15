import test from 'node:test';
import assert from 'node:assert/strict';

// Regression guard for the duplicate-export bug (TS2323/TS2484) that previously
// lived in index.ts: RESULT_ENVELOPE_VERSION and PUBLIC_RUNTIME_DISCOVERY_LINKS
// were both declared locally AND re-exported. The single source of truth is now
// the re-export from ./workflow-catalog.js and ./public-runtime.js respectively.
// This test imports through the BARE-ROOT package entry (@r3e-network/neo-os-services-shared)
// to prove the public surface resolves to exactly one binding with the expected value.
import {
  RESULT_ENVELOPE_VERSION,
  PUBLIC_RUNTIME_DISCOVERY_LINKS,
} from '@r3e-network/neo-os-services-shared';

import { RESULT_ENVELOPE_VERSION as RESULT_ENVELOPE_VERSION_SOURCE } from './workflow-catalog.js';
import { PUBLIC_RUNTIME_DISCOVERY_LINKS as PUBLIC_RUNTIME_DISCOVERY_LINKS_SOURCE } from './public-runtime.js';

test('bare-root entry re-exports RESULT_ENVELOPE_VERSION as the single source value', () => {
  assert.equal(RESULT_ENVELOPE_VERSION, '2026-04-tee-v1');
  // The bare-root binding must be the exact same value the canonical source exports.
  assert.equal(RESULT_ENVELOPE_VERSION, RESULT_ENVELOPE_VERSION_SOURCE);
});

test('bare-root entry re-exports PUBLIC_RUNTIME_DISCOVERY_LINKS from the single source', () => {
  assert.deepEqual(PUBLIC_RUNTIME_DISCOVERY_LINKS, {
    catalog: '/api/runtime/catalog',
    workflows: '/api/workflows',
    policies: '/api/policies',
  });
  // The bare-root binding must be the identical reference from public-runtime.js,
  // proving there is no shadowing local re-declaration in index.ts.
  assert.strictEqual(PUBLIC_RUNTIME_DISCOVERY_LINKS, PUBLIC_RUNTIME_DISCOVERY_LINKS_SOURCE);
});
