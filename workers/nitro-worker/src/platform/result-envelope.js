import { RESULT_ENVELOPE_VERSION } from '@r3e-network/neo-os-services-shared';
import { trimString } from './core.js';

function normalizeStatus(result) {
  const explicit = trimString(result?.status || '');
  if (explicit) return explicit;
  return result?.ok === false ? 'failed' : 'succeeded';
}

export function buildResultEnvelope(plan, result = {}, output = null) {
  return {
    version: RESULT_ENVELOPE_VERSION,
    workflow_id: plan.workflow_id,
    workflow_version: Number(plan.workflow_version || 1),
    execution_id: plan.execution_id,
    network: plan.network,
    status: normalizeStatus(result),
    ok: result?.ok !== false,
    output,
    error: trimString(result?.error || '') || null,
  };
}
