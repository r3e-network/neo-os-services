import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluatePolicyDecision } from './policy-engine.js';

test('policy engine denies disabled providers before TEE execution', () => {
  const decision = evaluatePolicyDecision({
    workflow_id: 'paymaster.authorize',
    provider_enabled: false,
    require_attestation: true,
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, 'provider_disabled');
});

test('policy engine returns review when attestation is required but unavailable', () => {
  const decision = evaluatePolicyDecision({
    workflow_id: 'oracle.query',
    provider_enabled: true,
    require_attestation: true,
    attestation_available: false,
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.decision, 'review');
  assert.equal(decision.reason, 'attestation_required');
});
