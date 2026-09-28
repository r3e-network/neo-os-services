/**
 * Automation upkeep dispatch / execution-payload builders shared by the relayer
 * and the apps/web control-plane route. See automation-supervisor.js for the
 * request_id / dedup derivation contract.
 */

export type UpkeepDispatch = {
  workflow_id: string;
  workflow_version: number;
  automation_id: string;
  execution_count: number;
  next_execution_count: number;
  execution_id: string;
  request_id: string;
  idempotency_key: string;
  replay_window: string;
  delivery_mode: string;
};

export function buildUpkeepDispatch(job?: Record<string, unknown>): UpkeepDispatch;

export function buildUpkeepExecutionPayload(
  payload?: Record<string, unknown>,
  job?: Record<string, unknown>
): Record<string, unknown>;

export const AUTOMATION_EXECUTION_QUEUE_METHOD: 'queueAutomationExecution';
export const LEGACY_AUTOMATION_QUEUE_METHOD: 'queueAutomationRequest';

export function normalizeAutomationRegistrationRequestId(value: unknown): string;

export function kernelManifestSupportsAutomationExecution(manifest: unknown): boolean;

export type AutomationQueueLane =
  | { method: 'queueAutomationExecution'; registrationRequestId: string }
  | { method: 'queueAutomationRequest'; registrationRequestId: '' };

export function selectAutomationQueueLane(input?: {
  supportsExecutionLane?: boolean;
  registrationRequestId?: unknown;
}): AutomationQueueLane;

export const TERMINAL_AUTOMATION_QUEUE_REVERTS: readonly string[];

export function isTerminalAutomationQueueFailure(message: unknown): boolean;
