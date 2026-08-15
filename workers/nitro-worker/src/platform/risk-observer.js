import { trimString } from './core.js';

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeScope(value) {
  const normalized = trimString(value).toLowerCase();
  return normalized || 'workflow';
}

function normalizeScopeId(value, fallback = '') {
  const normalized = trimString(value);
  return normalized || fallback;
}

function resolveFailureRate(signal = {}) {
  if (signal.failure_rate !== undefined) {
    return Math.max(toNumber(signal.failure_rate, 0), 0);
  }
  const failures = Math.max(toNumber(signal.failures, 0), 0);
  const successes = Math.max(toNumber(signal.successes, 0), 0);
  const total = failures + successes;
  if (total <= 0) return 0;
  return failures / total;
}

export function classifyRiskSignal(signal = {}) {
  const scope = normalizeScope(signal.scope);
  const scopeId = normalizeScopeId(signal.scope_id || signal.scopeId, scope);
  const failureRate = resolveFailureRate(signal);
  const staleSeconds = Math.max(toNumber(signal.stale_seconds ?? signal.staleSeconds, 0), 0);

  if (failureRate >= 1 || staleSeconds >= 600) {
    return {
      action: 'pause_scope',
      scope,
      scope_id: scopeId,
      reason: failureRate >= 1 ? 'failure_rate_exceeded' : 'stale_signal',
      severity: 'high',
      failure_rate: failureRate,
      stale_seconds: staleSeconds,
    };
  }

  if (failureRate >= 0.5) {
    return {
      action: 'observe',
      scope,
      scope_id: scopeId,
      reason: 'elevated_failure_rate',
      severity: 'medium',
      failure_rate: failureRate,
      stale_seconds: staleSeconds,
    };
  }

  return {
    action: 'observe',
    scope,
    scope_id: scopeId,
    reason: 'healthy',
    severity: 'low',
    failure_rate: failureRate,
    stale_seconds: staleSeconds,
  };
}
