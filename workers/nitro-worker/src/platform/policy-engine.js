import { trimString } from './core.js';

function hasValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

function readBoolean(value, fallback = null) {
  if (!hasValue(value)) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return fallback;
}

function normalizeDecision(value, fallback = 'allow') {
  const normalized = trimString(value).toLowerCase();
  if (normalized === 'deny' || normalized === 'review' || normalized === 'allow') {
    return normalized;
  }
  return fallback;
}

function buildPolicyDecision(base, overrides = {}) {
  const decision = normalizeDecision(overrides.decision, base.decision);
  const allow = decision === 'allow';
  return {
    workflow_id: base.workflow_id,
    allow,
    decision,
    reason: trimString(overrides.reason) || base.reason,
    httpStatus:
      overrides.httpStatus || (decision === 'allow' ? 200 : decision === 'review' ? 409 : 403),
    scope: trimString(overrides.scope) || base.scope || null,
    scope_id: trimString(overrides.scope_id || overrides.scopeId) || base.scope_id || null,
    require_attestation:
      overrides.require_attestation !== undefined
        ? Boolean(overrides.require_attestation)
        : base.require_attestation,
    metadata: {
      ...base.metadata,
      ...(overrides.metadata && typeof overrides.metadata === 'object' ? overrides.metadata : {}),
    },
  };
}

export function evaluatePolicyDecision(input = {}) {
  const workflowId = trimString(input.workflow_id || input.workflowId || '');
  const providerId = trimString(
    input.provider || input.provider_id || input.providerId || input.scope_id || input.scopeId || ''
  );
  const requireAttestation =
    readBoolean(input.require_attestation ?? input.requireAttestation, false) === true;
  const attestationAvailable = readBoolean(
    input.attestation_available ?? input.attestationAvailable,
    true
  );
  const riskAction = trimString(
    input.risk_action || input.paused_action || input.action || ''
  ).toLowerCase();
  const scopePaused =
    readBoolean(input.scope_paused ?? input.scopePaused, false) === true ||
    riskAction === 'pause_scope' ||
    riskAction === 'deny';

  const base = {
    workflow_id: workflowId || null,
    decision: 'allow',
    reason: 'allowed',
    scope: providerId ? 'provider' : trimString(input.scope) || 'workflow',
    scope_id: providerId || trimString(input.scope_id || input.scopeId || workflowId) || null,
    require_attestation: requireAttestation,
    metadata: {
      provider_enabled: readBoolean(input.provider_enabled ?? input.providerEnabled, null),
      attestation_available: attestationAvailable,
    },
  };

  const explicitAllow = readBoolean(input.allow, null);
  const explicitDecision = normalizeDecision(
    input.decision,
    explicitAllow === false ? 'deny' : 'allow'
  );
  const explicitReason = trimString(input.reason);
  if (explicitAllow === false || explicitDecision === 'deny' || explicitDecision === 'review') {
    return buildPolicyDecision(base, {
      decision: explicitDecision === 'allow' ? 'deny' : explicitDecision,
      reason:
        explicitReason || (explicitDecision === 'review' ? 'review_required' : 'policy_denied'),
    });
  }

  const providerEnabled = readBoolean(input.provider_enabled ?? input.providerEnabled, null);
  if (providerEnabled === false) {
    return buildPolicyDecision(base, {
      decision: 'deny',
      reason: 'provider_disabled',
      scope: 'provider',
      scope_id: providerId,
    });
  }

  if (scopePaused) {
    return buildPolicyDecision(base, {
      decision: 'deny',
      reason: 'scope_paused',
    });
  }

  if (requireAttestation && attestationAvailable === false) {
    return buildPolicyDecision(base, {
      decision: 'review',
      reason: 'attestation_required',
    });
  }

  if (readBoolean(input.require_human_approval ?? input.requireHumanApproval, false) === true) {
    return buildPolicyDecision(base, {
      decision: 'review',
      reason: 'human_approval_required',
    });
  }

  return buildPolicyDecision(base, { decision: 'allow', reason: 'allowed' });
}
