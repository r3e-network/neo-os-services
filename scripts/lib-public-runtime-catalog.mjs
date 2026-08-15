import { loadPublicNetworkRegistry } from './lib-public-network-registry.mjs';
import {
  PUBLIC_RISK_ACTIONS,
  PUBLIC_RUNTIME_TOPOLOGY,
  RESULT_ENVELOPE_VERSION,
  getWorkflowDefinition,
  listWorkflowDefinitions,
} from '../packages/shared/src/workflow-catalog.js';

function cloneExecutionMetadata(definition) {
  const teeRequired =
    Array.isArray(definition.confidentialSteps) && definition.confidentialSteps.length > 0;
  const carriesRiskPolicy =
    Array.isArray(definition.policies) && definition.policies.includes('risk');
  return {
    orchestrationPlane: PUBLIC_RUNTIME_TOPOLOGY.orchestrationPlane,
    executionPlane: teeRequired
      ? PUBLIC_RUNTIME_TOPOLOGY.executionPlane
      : PUBLIC_RUNTIME_TOPOLOGY.orchestrationPlane,
    riskPlane: carriesRiskPolicy ? PUBLIC_RUNTIME_TOPOLOGY.riskPlane : 'none',
    teeRequired,
  };
}

function buildPublicWorkflowEntry(definition) {
  return {
    id: definition.id,
    version: definition.version,
    trigger: {
      ...definition.trigger,
      ...(definition.trigger.supported ? { supported: [...definition.trigger.supported] } : {}),
    },
    allowedNetworks: [...definition.allowedNetworks],
    route: definition.route,
    ...(definition.capabilityId ? { capabilityId: definition.capabilityId } : {}),
    policies: [...definition.policies],
    execution: cloneExecutionMetadata(definition),
    delivery: { ...definition.delivery },
  };
}

export function loadPublicRuntimeCatalog(options = {}) {
  const automationWorkflow = getWorkflowDefinition('automation.upkeep');
  return {
    envelope: { version: RESULT_ENVELOPE_VERSION },
    topology: { ...PUBLIC_RUNTIME_TOPOLOGY },
    risk: {
      observer: PUBLIC_RUNTIME_TOPOLOGY.riskPlane,
      actions: [...PUBLIC_RISK_ACTIONS],
    },
    automation: {
      workflowId: automationWorkflow?.id || 'automation.upkeep',
      triggerKinds: [...(automationWorkflow?.trigger?.supported || [])],
      route: automationWorkflow?.route || '/automation/execute',
      deliveryMode: automationWorkflow?.delivery?.mode || 'onchain_callback',
    },
    networks: loadPublicNetworkRegistry(options),
    workflows: listWorkflowDefinitions().map((definition) => buildPublicWorkflowEntry(definition)),
  };
}
