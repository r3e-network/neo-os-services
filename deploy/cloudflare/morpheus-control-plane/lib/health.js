import { json } from '@r3e-network/neo-os-services-shared/utils';

const JOB_ROUTE_CONFIG = {
  '/oracle/query': {
    delivery: 'queue',
    queue: 'oracle_request',
    binding: 'MORPHEUS_ORACLE_REQUEST_QUEUE',
    kernelLane: 'request_dispatch',
  },
  '/oracle/smart-fetch': {
    delivery: 'queue',
    queue: 'oracle_request',
    binding: 'MORPHEUS_ORACLE_REQUEST_QUEUE',
    kernelLane: 'request_dispatch',
  },
  '/compute/execute': {
    delivery: 'queue',
    queue: 'oracle_request',
    binding: 'MORPHEUS_ORACLE_REQUEST_QUEUE',
    kernelLane: 'request_dispatch',
  },
  '/neodid/bind': {
    delivery: 'queue',
    queue: 'oracle_request',
    binding: 'MORPHEUS_ORACLE_REQUEST_QUEUE',
    kernelLane: 'request_dispatch',
  },
  '/neodid/action-ticket': {
    delivery: 'queue',
    queue: 'oracle_request',
    binding: 'MORPHEUS_ORACLE_REQUEST_QUEUE',
    kernelLane: 'request_dispatch',
  },
  '/neodid/recovery-ticket': {
    delivery: 'queue',
    queue: 'oracle_request',
    binding: 'MORPHEUS_ORACLE_REQUEST_QUEUE',
    kernelLane: 'request_dispatch',
  },
  '/feeds/tick': {
    delivery: 'queue',
    queue: 'feed_tick',
    binding: 'MORPHEUS_FEED_TICK_QUEUE',
    kernelLane: 'shared_resource_sync',
  },
  '/callbacks/broadcast': {
    delivery: 'workflow',
    queue: 'callback_broadcast',
    workflowBinding: 'CALLBACK_BROADCAST_WORKFLOW',
    workflowName: 'callback_broadcast',
    kernelLane: 'callback_adapter_broadcast',
  },
  '/automation/execute': {
    delivery: 'workflow',
    queue: 'automation_execute',
    workflowBinding: 'AUTOMATION_EXECUTE_WORKFLOW',
    workflowName: 'automation_execute',
    kernelLane: 'automation_orchestration',
  },
};

const CONTROL_PLANE_KERNEL_LANES = {
  oracle_request: 'request_dispatch',
  feed_tick: 'shared_resource_sync',
  callback_broadcast: 'callback_adapter_broadcast',
  automation_execute: 'automation_orchestration',
};

function isWorkflowBindingAvailable(env, bindingName) {
  const binding = env?.[bindingName];
  return Boolean(
    binding && typeof binding.create === 'function' && typeof binding.get === 'function'
  );
}

function handleRootRoute(_network) {
  return json(200, {
    service: 'morpheus-control-plane',
    network_default: 'testnet',
    supported_routes: Object.keys(JOB_ROUTE_CONFIG),
    supported_kernel_lanes: CONTROL_PLANE_KERNEL_LANES,
  });
}

function handleHealthRoute(network, env) {
  return json(200, {
    status: 'ok',
    network,
    queues: {
      oracle_request: Boolean(env.MORPHEUS_ORACLE_REQUEST_QUEUE),
      feed_tick: Boolean(env.MORPHEUS_FEED_TICK_QUEUE),
    },
    workflows: {
      callback_broadcast: isWorkflowBindingAvailable(env, 'CALLBACK_BROADCAST_WORKFLOW'),
      automation_execute: isWorkflowBindingAvailable(env, 'AUTOMATION_EXECUTE_WORKFLOW'),
    },
    delivery: {
      oracle_request: 'queue',
      feed_tick: 'queue',
      callback_broadcast: 'workflow',
      automation_execute: 'workflow',
    },
    kernel_lanes: CONTROL_PLANE_KERNEL_LANES,
  });
}

export {
  JOB_ROUTE_CONFIG,
  CONTROL_PLANE_KERNEL_LANES,
  isWorkflowBindingAvailable,
  handleRootRoute,
  handleHealthRoute,
};
