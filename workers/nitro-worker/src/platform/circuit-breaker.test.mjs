import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from './circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('starts closed with zero failures', () => {
    const cb = new CircuitBreaker('test');
    assert.equal(cb.getState().state, 'closed');
    assert.equal(cb.getState().failures, 0);
    assert.ok(cb.allow());
  });

  it('opens after reaching failure threshold', () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    assert.ok(cb.allow());
    cb.recordFailure();
    assert.equal(cb.getState().state, 'open');
    assert.ok(!cb.allow());
  });

  it('resets to closed on success from half_open', () => {
    const cb = new CircuitBreaker('test', {
      failureThreshold: 1,
      resetTimeoutMs: 0,
    });
    cb.recordFailure();
    assert.equal(cb.getState().state, 'open');

    // expire the open timeout so it transitions to half_open on next check
    cb.lastFailureAt = 0;
    assert.ok(cb.allow()); // transitions to half_open, grants quota
    assert.equal(cb.getState().state, 'half_open');

    cb.recordSuccess();
    assert.equal(cb.getState().state, 'closed');
    assert.equal(cb.getState().failures, 0);
  });

  it('returns to open on failure during half_open', () => {
    const cb = new CircuitBreaker('test', {
      failureThreshold: 1,
      resetTimeoutMs: 0,
    });
    cb.recordFailure();
    cb.lastFailureAt = 0;
    cb.allow(); // half_open
    cb.recordFailure();
    assert.equal(cb.getState().state, 'open');
  });

  it('respects halfOpenMax quota', () => {
    const cb = new CircuitBreaker('test', {
      failureThreshold: 1,
      resetTimeoutMs: 0,
      halfOpenMax: 2,
    });
    cb.recordFailure();
    cb.lastFailureAt = 0;

    assert.ok(cb.allow()); // quota 2→1
    assert.ok(cb.allow()); // quota 1→0
    assert.ok(!cb.allow()); // quota exhausted
  });

  it('isOpen returns false for closed state', () => {
    const cb = new CircuitBreaker('test');
    assert.ok(!cb.isOpen());
  });

  it('isOpen returns true for open state before timeout', () => {
    const cb = new CircuitBreaker('test', {
      failureThreshold: 1,
      resetTimeoutMs: 999_999,
    });
    cb.recordFailure();
    assert.ok(cb.isOpen());
  });

  it('isOpen transitions open→half_open after resetTimeoutMs', () => {
    const cb = new CircuitBreaker('test', {
      failureThreshold: 1,
      resetTimeoutMs: 0,
    });
    cb.recordFailure();
    cb.lastFailureAt = Date.now() - 1;
    assert.ok(!cb.isOpen());
    assert.equal(cb.getState().state, 'half_open');
  });

  it('getState includes all fields', () => {
    const cb = new CircuitBreaker('my-provider', { failureThreshold: 5 });
    const state = cb.getState();
    assert.equal(state.name, 'my-provider');
    assert.equal(state.state, 'closed');
    assert.equal(state.failures, 0);
    assert.equal(state.successes, 0);
    assert.equal(state.last_failure_at, null);
  });

  it('getState includes the recommended risk action', () => {
    const cb = new CircuitBreaker('coinbase-spot', { failureThreshold: 1 });
    cb.recordFailure();
    const state = cb.getState();
    assert.equal(state.recommended_action, 'pause_scope');
    assert.equal(state.risk_scope, 'provider');
    assert.equal(state.risk_scope_id, 'coinbase-spot');
  });

  it('records successes', () => {
    const cb = new CircuitBreaker('test');
    cb.recordSuccess();
    cb.recordSuccess();
    assert.equal(cb.getState().successes, 2);
  });

  it('resetSuccesses on recordFailure', () => {
    const cb = new CircuitBreaker('test');
    cb.recordSuccess();
    cb.recordSuccess();
    cb.recordFailure();
    assert.equal(cb.getState().successes, 0);
  });

  it('resetFailures on recordSuccess', () => {
    const cb = new CircuitBreaker('test');
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    assert.equal(cb.getState().failures, 0);
  });
});
