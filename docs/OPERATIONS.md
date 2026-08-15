# Operations

## Goals

- no silent loss for accepted requests
- explicit backlog instead of overload collapse
- feed publication remains highest priority
- network selection stays config-driven, not topology-driven

## Priority Model

### DataFeed lane

The DataFeed CVM is isolated from interactive request/response work.

Use this lane for:

- scheduled price synchronization
- feed publication
- feed-specific relayer processing

This lane must stay available even if Oracle request traffic spikes.

### Oracle lane

The Oracle CVM handles:

- confidential oracle requests
- confidential compute
- NeoDID private flows
- callback result generation

This lane can absorb queueing and retries. DataFeed should not share its capacity envelope.

## Durability Model

### Chain-originated requests

- relayer events are persisted before checkpoints advance
- retries and dead-letter state are written to Supabase
- recovery happens from durable state, not worker memory

### Control-plane requests

- control-plane jobs are persisted in `morpheus_control_plane_jobs`
- `oracle_request` and `feed_tick` are queue-backed
- `callback_broadcast` and `automation_execute` are workflow-backed
- stale or overdue jobs can be recovered with `POST /<network>/jobs/recover`

## Backpressure Rules

- backlog is preferred over dropping work
- stale `processing` jobs are recoverable
- retryable errors move jobs back to `queued`
- `run_after` is used for exponential backoff and jitter
- relayer freshness and retry budgets should be tuned from measured load, not guesses

## Key Runtime Controls

### Worker inflight caps

- `MORPHEUS_MAX_INFLIGHT_ORACLE_QUERY`
- `MORPHEUS_MAX_INFLIGHT_ORACLE_SMART_FETCH`
- `MORPHEUS_MAX_INFLIGHT_COMPUTE_EXECUTE`
- `MORPHEUS_MAX_INFLIGHT_VRF_RANDOM`
- `MORPHEUS_MAX_INFLIGHT_PAYMASTER_AUTHORIZE`
- `MORPHEUS_MAX_INFLIGHT_RELAY_TRANSACTION`
- `MORPHEUS_MAX_INFLIGHT_NEODID_BIND`
- `MORPHEUS_MAX_INFLIGHT_NEODID_ACTION_TICKET`
- `MORPHEUS_MAX_INFLIGHT_NEODID_RECOVERY_TICKET`

### Relayer backpressure

- `MORPHEUS_RELAYER_MAX_FRESH_EVENTS_PER_TICK`
- `MORPHEUS_RELAYER_MAX_RETRY_EVENTS_PER_TICK`
- `MORPHEUS_RELAYER_DEFER_DELAY_MS`
- `MORPHEUS_DURABLE_QUEUE_ENABLED`
- `MORPHEUS_DURABLE_QUEUE_FAIL_CLOSED`

### Control-plane recovery

- `MORPHEUS_CONTROL_PLANE_REQUEUE_LIMIT`
- `MORPHEUS_CONTROL_PLANE_STALE_PROCESSING_MS`
- `MORPHEUS_CONTROL_PLANE_RETRY_BASE_SECONDS`
- `MORPHEUS_CONTROL_PLANE_RETRY_MAX_SECONDS`

## Observability

Default production stack:

- Sentry for exceptions
- Checkly for browser and API synthetics
- Better Stack for uptime, heartbeats, and telemetry

Optional:

- Grafana Cloud for deeper relayer metrics

## Capacity Testing

Use the stress harness before changing queue budgets:

```bash
npm run stress:runtime -- --preset oracle_query --levels 1,2,4,8 --duration-ms 6000 --network testnet
npm run stress:runtime -- --preset compute_builtin --levels 1,2,4 --duration-ms 6000 --network testnet
```

Interpretation:

- testnet results define a conservative lower bound
- Oracle and DataFeed capacities must be measured separately
- production tuning should be based on p95, p99, timeout, and recovery behavior

## Recovery Checklist

1. confirm the affected lane: Oracle or DataFeed
2. inspect control-plane job state or relayer job state
3. recover stale jobs instead of replaying blindly
4. verify signer identity and updater identity before resuming broadcasts
5. confirm feed publication is healthy before draining lower-priority queues
