import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyRiskSignal } from './risk-observer.js';

test('risk observer pauses failing scopes', () => {
  const risk = classifyRiskSignal({
    failure_rate: 1,
    scope: 'provider',
    scope_id: 'coinbase-spot',
  });

  assert.equal(risk.action, 'pause_scope');
  assert.equal(risk.scope, 'provider');
  assert.equal(risk.scope_id, 'coinbase-spot');
});

test('risk observer keeps healthy scopes in observe mode', () => {
  const risk = classifyRiskSignal({
    failure_rate: 0.2,
    scope: 'workflow',
    scope_id: 'oracle.query',
  });

  assert.equal(risk.action, 'observe');
  assert.equal(risk.scope, 'workflow');
  assert.equal(risk.scope_id, 'oracle.query');
});
