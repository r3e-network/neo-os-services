import { classifyRiskSignal } from './risk-observer.js';

/**
 * Generic circuit breaker for provider health tracking.
 *
 * States: CLOSED (healthy) → OPEN (failing) → HALF_OPEN (probing) → CLOSED
 */
export class CircuitBreaker {
  constructor(name, { failureThreshold = 3, resetTimeoutMs = 60_000, halfOpenMax = 1 } = {}) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.halfOpenMax = halfOpenMax;

    this.failures = 0;
    this.successes = 0;
    this.state = 'closed';
    this.lastFailureAt = 0;
    this.halfOpenQuota = 0;
  }

  recordSuccess() {
    this.successes += 1;
    this.failures = 0;
    if (this.state === 'half_open') {
      this.state = 'closed';
      this.halfOpenQuota = 0;
    }
  }

  recordFailure() {
    this.failures += 1;
    this.successes = 0;
    this.lastFailureAt = Date.now();
    if (this.state === 'half_open') {
      this.state = 'open';
      this.halfOpenQuota = 0;
    } else if (this.failures >= this.failureThreshold) {
      this.state = 'open';
    }
  }

  isOpen() {
    if (this.state === 'closed') return false;
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureAt >= this.resetTimeoutMs) {
        this.state = 'half_open';
        this.halfOpenQuota = this.halfOpenMax;
        return false;
      }
      return true;
    }
    // half_open
    return this.halfOpenQuota <= 0;
  }

  allow() {
    if (!this.isOpen()) {
      if (this.state === 'half_open' && this.halfOpenQuota > 0) {
        this.halfOpenQuota -= 1;
      }
      return true;
    }
    return false;
  }

  getState() {
    const failureRate =
      this.state === 'open'
        ? 1
        : this.failures > 0
          ? this.failures / Math.max(this.failures + this.successes, 1)
          : 0;
    const risk = classifyRiskSignal({
      scope: 'provider',
      scope_id: this.name,
      failure_rate: failureRate,
    });
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      last_failure_at: this.lastFailureAt || null,
      recommended_action: risk.action,
      risk_scope: risk.scope,
      risk_scope_id: risk.scope_id,
    };
  }
}
