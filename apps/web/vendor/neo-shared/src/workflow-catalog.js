export const RESULT_ENVELOPE_VERSION = '2026-04-tee-v1';

export const PUBLIC_RUNTIME_TOPOLOGY = Object.freeze({
  ingressPlane: 'edge_gateway',
  orchestrationPlane: 'control_plane',
  schedulerPlane: 'control_plane',
  executionPlane: 'tee_runtime',
  riskPlane: 'independent_observer',
});

export const PUBLIC_RISK_ACTIONS = Object.freeze(['observe', 'review', 'pause_scope']);

const WORKFLOW_DEFINITIONS = [
  {
    id: 'oracle.query',
    version: 1,
    trigger: { kind: 'request' },
    allowedNetworks: ['mainnet', 'testnet'],
    route: '/oracle/query',
    capabilityId: 'oracle_query',
    confidentialSteps: ['provider_fetch', 'sign_result'],
    policies: ['tenant', 'provider', 'risk'],
    delivery: { mode: 'api_response' },
  },
  {
    id: 'oracle.smart_fetch',
    version: 1,
    trigger: { kind: 'request' },
    allowedNetworks: ['mainnet', 'testnet'],
    route: '/oracle/smart-fetch',
    capabilityId: 'oracle_smart_fetch',
    confidentialSteps: ['provider_fetch', 'compute_transform', 'sign_result'],
    policies: ['tenant', 'provider', 'risk'],
    delivery: { mode: 'api_response' },
  },
  {
    id: 'feed.sync',
    version: 1,
    trigger: { kind: 'event', supported: ['feed_tick'] },
    allowedNetworks: ['mainnet', 'testnet'],
    route: '/feeds/tick',
    capabilityId: 'oracle_feed',
    confidentialSteps: ['provider_fetch', 'quantize_price', 'sign_result'],
    policies: ['provider', 'risk'],
    delivery: { mode: 'shared_resource_sync' },
  },
  {
    id: 'automation.upkeep',
    version: 1,
    trigger: { kind: 'scheduler', supported: ['interval', 'threshold'] },
    allowedNetworks: ['mainnet', 'testnet'],
    route: '/automation/execute',
    confidentialSteps: ['payload_decrypt', 'provider_fetch', 'sign_result'],
    policies: ['tenant', 'provider', 'paymaster', 'risk'],
    delivery: { mode: 'onchain_callback' },
  },
  {
    id: 'compute.execute',
    version: 1,
    trigger: { kind: 'request' },
    allowedNetworks: ['mainnet', 'testnet'],
    route: '/compute/execute',
    capabilityId: 'compute_execute',
    confidentialSteps: ['payload_decrypt', 'compute_execute', 'sign_result'],
    policies: ['tenant', 'risk'],
    delivery: { mode: 'api_response' },
  },
  {
    id: 'neodid.bind',
    version: 1,
    trigger: { kind: 'request' },
    allowedNetworks: ['mainnet', 'testnet'],
    route: '/neodid/bind',
    capabilityId: 'neodid_bind',
    confidentialSteps: ['payload_decrypt', 'identity_bind', 'sign_result'],
    policies: ['tenant', 'risk'],
    delivery: { mode: 'kernel_inbox' },
  },
  {
    id: 'neodid.action_ticket',
    version: 1,
    trigger: { kind: 'request' },
    allowedNetworks: ['mainnet', 'testnet'],
    route: '/neodid/action-ticket',
    capabilityId: 'neodid_action_ticket',
    confidentialSteps: ['payload_decrypt', 'issue_ticket', 'sign_result'],
    policies: ['tenant', 'risk'],
    delivery: { mode: 'kernel_inbox' },
  },
  {
    id: 'neodid.recovery_ticket',
    version: 1,
    trigger: { kind: 'request' },
    allowedNetworks: ['mainnet', 'testnet'],
    route: '/neodid/recovery-ticket',
    capabilityId: 'neodid_recovery_ticket',
    confidentialSteps: ['payload_decrypt', 'issue_ticket', 'sign_result'],
    policies: ['tenant', 'risk'],
    delivery: { mode: 'kernel_inbox' },
  },
  {
    id: 'paymaster.authorize',
    version: 1,
    trigger: { kind: 'request' },
    allowedNetworks: ['mainnet', 'testnet'],
    route: '/paymaster/authorize',
    capabilityId: 'paymaster_authorize',
    confidentialSteps: ['payload_decrypt', 'policy_evaluate', 'sign_result'],
    policies: ['tenant', 'paymaster', 'risk'],
    delivery: { mode: 'api_response' },
  },
];

function cloneWorkflowDefinition(definition) {
  if (definition == null) return null;
  return {
    ...definition,
    allowedNetworks: [...definition.allowedNetworks],
    confidentialSteps: [...definition.confidentialSteps],
    policies: [...definition.policies],
    trigger: {
      ...definition.trigger,
      ...(definition.trigger.supported ? { supported: [...definition.trigger.supported] } : {}),
    },
    delivery: { ...definition.delivery },
  };
}

export function listWorkflowDefinitions() {
  return WORKFLOW_DEFINITIONS.map((definition) => cloneWorkflowDefinition(definition));
}

export function getWorkflowDefinition(id) {
  return cloneWorkflowDefinition(
    WORKFLOW_DEFINITIONS.find((definition) => definition.id === id) ?? null
  );
}
