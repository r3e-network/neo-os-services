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
