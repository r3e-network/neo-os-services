import { RESULT_ENVELOPE_VERSION } from '../../../packages/shared/src/workflow-catalog.js';
import { trimString } from './lib/strings.js';

function normalizeNetwork(value) {
  return trimString(value) === 'mainnet' ? 'mainnet' : 'testnet';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function buildWorkflowExecutionRecord(input = {}) {
  const workflowId = trimString(input.workflowId || input.workflow_id);
  const executionId = trimString(input.executionId || input.execution_id);
  if (!workflowId) throw new Error('workflowId is required');
  if (!executionId) throw new Error('executionId is required');

  return {
    workflow_id: workflowId,
    execution_id: executionId,
    network: normalizeNetwork(input.network),
    ingress_route: trimString(input.route || input.ingress_route) || null,
    status: trimString(input.status) || 'queued',
    result_envelope_version: RESULT_ENVELOPE_VERSION,
    metadata: isPlainObject(input.metadata) ? input.metadata : {},
  };
}

export function buildRiskEventRecord(input = {}) {
  const scope = trimString(input.scope);
  const scopeId = trimString(input.scope_id || input.scopeId);
  if (!scope) throw new Error('scope is required');
  if (!scopeId) throw new Error('scope_id is required');

  return {
    network: normalizeNetwork(input.network),
    scope,
    scope_id: scopeId,
    status: trimString(input.status) || 'open',
    action: trimString(input.action) || null,
    metadata: isPlainObject(input.metadata) ? input.metadata : {},
  };
}
