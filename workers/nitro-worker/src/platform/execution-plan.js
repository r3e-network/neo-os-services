import { normalizeMorpheusNetwork, trimString } from './core.js';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeWorkflowVersion(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 1;
  return Math.trunc(numeric);
}

export function normalizeExecutionPlan(input = {}) {
  const workflowId = trimString(input.workflow_id || input.workflowId || '');
  const executionId = trimString(input.execution_id || input.executionId || '');
  if (!workflowId) throw new Error('workflow_id is required');
  if (!executionId) throw new Error('execution_id is required');

  return {
    workflow_id: workflowId,
    workflow_version: normalizeWorkflowVersion(input.workflow_version || input.workflowVersion),
    execution_id: executionId,
    network: normalizeMorpheusNetwork(input.network, 'testnet'),
    provider_refs: Array.isArray(input.provider_refs || input.providerRefs)
      ? [...(input.provider_refs || input.providerRefs)]
      : [],
    sealed_inputs: isPlainObject(input.sealed_inputs || input.sealedInputs)
      ? { ...(input.sealed_inputs || input.sealedInputs) }
      : {},
    step_list: Array.isArray(input.step_list || input.stepList)
      ? [...(input.step_list || input.stepList)]
      : [],
    payload: isPlainObject(input.payload) ? { ...input.payload } : {},
  };
}
