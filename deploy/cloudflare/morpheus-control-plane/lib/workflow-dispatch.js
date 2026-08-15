import { listWorkflowDefinitions } from '@r3e-network/neo-os-services-shared';
import { trimString } from '@r3e-network/neo-os-services-shared/utils';

const WORKFLOW_DEFINITIONS_BY_ROUTE = new Map(
  listWorkflowDefinitions().map((definition) => [definition.route, definition])
);

function normalizeNetwork(value) {
  return trimString(value) === 'mainnet' ? 'mainnet' : 'testnet';
}

function createExecutionId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `exec-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeExecutionId(payload = {}, fallbackExecutionId) {
  return (
    trimString(
      payload.execution_id ||
        payload.executionId ||
        payload.workflow_execution_id ||
        payload.workflowExecutionId ||
        fallbackExecutionId ||
        ''
    ) || createExecutionId()
  );
}

function normalizeWorkflowVersion(value, fallbackVersion) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.trunc(numeric);
  }
  return Math.max(Number(fallbackVersion || 1), 1);
}

export function resolveWorkflowDispatch(
  routePath,
  payload = {},
  network = 'testnet',
  options = {}
) {
  const definition = WORKFLOW_DEFINITIONS_BY_ROUTE.get(trimString(routePath));
  if (!definition) return null;

  const normalizedNetwork = normalizeNetwork(network);
  if (
    Array.isArray(definition.allowedNetworks) &&
    definition.allowedNetworks.length > 0 &&
    !definition.allowedNetworks.includes(normalizedNetwork)
  ) {
    throw new Error(`workflow ${definition.id} is not enabled for network ${normalizedNetwork}`);
  }

  return {
    workflowId: definition.id,
    workflowVersion: normalizeWorkflowVersion(
      payload.workflow_version || payload.workflowVersion,
      definition.version
    ),
    executionId: normalizeExecutionId(payload, options.executionId),
    legacyRoute: definition.route,
    network: normalizedNetwork,
  };
}

export function buildWorkflowDispatchMetadata(
  routePath,
  payload = {},
  network = 'testnet',
  options = {}
) {
  const dispatch = resolveWorkflowDispatch(routePath, payload, network, options);
  if (!dispatch) return null;
  return {
    workflow_id: dispatch.workflowId,
    workflow_version: dispatch.workflowVersion,
    execution_id: dispatch.executionId,
    legacy_route: dispatch.legacyRoute,
  };
}

export function buildWorkflowExecutionPayload(
  routePath,
  payload = {},
  metadata = {},
  network = 'testnet',
  options = {}
) {
  const basePayload = payload && typeof payload === 'object' ? { ...payload } : {};
  const dispatch = resolveWorkflowDispatch(
    routePath,
    {
      ...metadata,
      ...basePayload,
    },
    network,
    options
  );
  if (!dispatch) return basePayload;
  return {
    ...basePayload,
    workflow_id: dispatch.workflowId,
    workflow_version: dispatch.workflowVersion,
    execution_id: dispatch.executionId,
    network: dispatch.network,
  };
}
