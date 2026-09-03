// Exports `evaluatePolicyDecision` oracle vectors from the JS implementation
// into policy-decisions.json, the merge gate for the Rust port in
// crates/morpheus-compute/src/policy.rs (JS is the oracle; a failing vector is
// a port bug, not a spec change).
//
// Run: node crates/morpheus-compute/tests/vectors/export-policy-vectors.mjs
// (from the repository root)

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluatePolicyDecision } from '../../../../workers/nitro-worker/src/platform/policy-engine.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// Every decision branch plus the coercion corners the `||` / `??` / trim
// semantics distinguish.
const inputs = [
  {},
  // The two cases the JS test suite pins.
  { workflow_id: 'paymaster.authorize', provider_enabled: false, require_attestation: true },
  {
    workflow_id: 'oracle.query',
    provider_enabled: true,
    require_attestation: true,
    attestation_available: false,
  },
  // Explicit decisions.
  { decision: 'deny' },
  { decision: 'review' },
  { decision: 'review', reason: 'needs a human' },
  { allow: false },
  { allow: true, decision: 'deny' },
  { allow: false, decision: 'review' },
  { decision: 'DENY' },
  { decision: 'bogus' },
  { decision: '  review  ' },
  // Paused scopes.
  { scope_paused: true },
  { scopePaused: '1' },
  { paused_action: 'pause_scope' },
  { action: 'deny' },
  { action: 'pause_scope' },
  // Attestation + human approval.
  { require_attestation: 'true', attestation_available: '0' },
  { requireAttestation: true, attestationAvailable: false },
  { require_attestation: true },
  { require_human_approval: 'yes' },
  { requireHumanApproval: true },
  // Provider identity / metadata corners.
  { provider: 'acme', workflowId: 'w-1', scope: 'tenant' },
  { scopeId: 's-9', workflow_id: 'w-2' },
  { provider_enabled: '1' },
  { provider_enabled: 'bogus' },
  { provider_enabled: true, require_attestation: true, attestation_available: true },
  // trimString collapses falsy raw values before the trim.
  { workflow_id: '   ' },
  { workflow_id: 0, workflowId: 'from-camel' },
  { scope: 0, workflow_id: 'w-3' },
  { provider: '   ', scope_id: 'fallback-id' },
  { provider: '  ', scopeId: 'fallback-id' },
  { failure_probe: true, attestation_available: 'maybe', require_attestation: 'true' },
  { workflow_id: 'w-4', provider_enabled: 0 },
  { workflow_id: 'w-5', provider_enabled: 1 },
];

const vectors = inputs.map((input, index) => ({
  name: `case-${String(index).padStart(2, '0')}`,
  input,
  expected: evaluatePolicyDecision(input),
}));

writeFileSync(join(HERE, 'policy-decisions.json'), `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`wrote ${vectors.length} policy vectors`);
