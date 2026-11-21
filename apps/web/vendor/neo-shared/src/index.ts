export type SupportedChain = 'neo_n3';
export type MorpheusNetwork = 'mainnet' | 'testnet';
export type ControlPlaneQueue =
  | 'oracle_request'
  | 'feed_tick'
  | 'callback_broadcast'
  | 'automation_execute';
export type ControlPlaneKernelLane =
  | 'request_dispatch'
  | 'shared_resource_sync'
  | 'callback_adapter_broadcast'
  | 'automation_orchestration';
export type ControlPlaneJobStatus =
  | 'queued'
  | 'dispatching'
  | 'dispatched'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'dead_lettered'
  | 'cancelled';
export type ControlPlaneExecutionRoute =
  | '/oracle/query'
  | '/oracle/smart-fetch'
  | '/compute/execute'
  | '/neodid/bind'
  | '/neodid/action-ticket'
  | '/neodid/recovery-ticket';
export type ControlPlaneAuxRoute = '/feeds/tick' | '/callbacks/broadcast' | '/automation/execute';
export type ControlPlaneRoute = ControlPlaneExecutionRoute | ControlPlaneAuxRoute;

export type ControlPlaneJobRecord = {
  id: string;
  network: MorpheusNetwork;
  queue: ControlPlaneQueue;
  route: ControlPlaneRoute;
  target_chain?: SupportedChain | null;
  project_slug?: string | null;
  request_id?: string | null;
  status: ControlPlaneJobStatus;
  dedupe_key?: string | null;
  payload: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  error?: string | null;
  retry_count: number;
  run_after?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  metadata: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

export type OraclePayload = {
  project_slug?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  json_path?: string;
  encrypted_token?: string;
  encrypted_payload?: string;
  encrypted_params?: string;
  encrypted_input?: string;
  encrypted_inputs?: Record<string, string>;
  token_header?: string;
  script?: string;
  script_base64?: string;
  provider?: BuiltinProviderId | string;
  provider_params?: Record<string, unknown>;
  symbol?: string;
  target_chain?: SupportedChain;
  target_chain_id?: string;
};

export type ComputeBuiltinFunction =
  | 'hash.sha256'
  | 'hash.keccak256'
  | 'crypto.rsa_verify'
  | 'math.modexp'
  | 'math.polynomial'
  | 'matrix.multiply'
  | 'vector.cosine_similarity'
  | 'merkle.root'
  | 'zkp.public_signal_hash'
  | 'zkp.proof_digest'
  | 'zkp.witness_digest'
  | 'zkp.groth16.verify'
  | 'zkp.groth16.prove.plan'
  | 'zkp.plonk.prove.plan'
  | 'zkp.zerc20.single_withdraw.verify'
  | 'fhe.batch_plan'
  | 'fhe.noise_budget_estimate'
  | 'fhe.rotation_plan'
  | 'privacy.mask'
  | 'privacy.add_noise';

export type BuiltinProviderId = 'twelvedata' | 'binance-spot' | 'coinbase-spot';

export type WorkflowId =
  | 'oracle.query'
  | 'oracle.smart_fetch'
  | 'feed.sync'
  | 'automation.upkeep'
  | 'compute.execute'
  | 'neodid.bind'
  | 'neodid.action_ticket'
  | 'neodid.recovery_ticket'
  | 'paymaster.authorize';

export type WorkflowTriggerKind = 'request' | 'event' | 'scheduler';
export type WorkflowDeliveryMode =
  | 'api_response'
  | 'shared_resource_sync'
  | 'onchain_callback'
  | 'kernel_inbox';

export type WorkflowDefinition = {
  id: WorkflowId;
  version: number;
  trigger: {
    kind: WorkflowTriggerKind;
    supported?: string[];
  };
  allowedNetworks: MorpheusNetwork[];
  route: ControlPlaneRoute | '/paymaster/authorize';
  capabilityId?: string;
  confidentialSteps: string[];
  policies: string[];
  delivery: {
    mode: WorkflowDeliveryMode;
  };
};

export type ProviderConfig = {
  provider_id: BuiltinProviderId | string;
  enabled: boolean;
  config: Record<string, unknown>;
};

// Re-export utilities for TypeScript consumers
export {
  json,
  timingSafeCompare,
  trimString,
  parseTimestampMs,
  getClientIp,
  stableStringify,
} from './utils.js';
export { applyUpstashRateLimit } from './rate-limit.js';
export type { UpstashRateLimitConfig, UpstashRateLimitResult } from './rate-limit.js';
export {
  RESULT_ENVELOPE_VERSION,
  getWorkflowDefinition,
  listWorkflowDefinitions,
} from './workflow-catalog.js';

// Re-export the public-runtime types from their single source of truth
// (public-runtime.d.ts) instead of redeclaring them here, so the public
// surface cannot drift from the runtime module's contract.
export type {
  RuntimeProbeSnapshotInput,
  PublicRuntimeCatalogSummary,
  PublicRuntimeStatusSnapshot,
} from './public-runtime.js';

export {
  PUBLIC_RUNTIME_DISCOVERY_LINKS,
  buildPublicRuntimeCatalogSummary,
  buildPublicRuntimeStatusSnapshot,
  getPublicRuntimeStatusNotes,
} from './public-runtime.js';

export { createLogger, createConsoleTransport, LEVELS } from './logger/index.js';
export type {
  Logger,
  LogRecord,
  LoggerOptions,
  LogTransport,
  RedactKey,
  LogLevel,
} from './logger/index.js';
