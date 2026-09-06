# Morpheus Control Plane

Cloudflare Worker that owns the public control layer and durable orchestration layer for Morpheus. Confidential execution stays on the AWS Nitro Enclaves.

The public route names remain compatibility-oriented, but internally this worker should be read as
the dispatch/orchestration layer for shared MiniApp OS module lanes.

## Responsibilities

- expose `/mainnet/*` and `/testnet/*` ingress routes
- validate/authenticate requests before dispatch
- persist job envelopes into `morpheus_control_plane_jobs`
- send execution-bound jobs to Cloudflare Queues
- send orchestration-heavy jobs to Cloudflare Workflows
- expose `GET /<network>/jobs/<job_id>` for status polling
- expose `POST /<network>/jobs/recover` for operator-driven recovery of stale jobs

## Current Delivery Model

Implemented ingress routes (authority status is explicit):

- `POST /<network>/oracle/query`
- `POST /<network>/oracle/smart-fetch`
- `POST /<network>/compute/execute`
- `POST /<network>/neodid/bind`
- `POST /<network>/neodid/action-ticket`
- `POST /<network>/neodid/recovery-ticket`
- `POST /<network>/feeds/tick` — retired `410 Gone`; Rust relayer owns feeds
- `POST /<network>/callbacks/broadcast` — retired `200` no-op; Rust relayer owns delivery
- `POST /<network>/automation/execute` — fail-closed `503`; no job/workflow is created
- `GET /<network>/jobs/<job_id>`
- `POST /<network>/jobs/recover`
- `GET /<network>/health`

This worker does **not** replace the AWS Nitro enclave. It only owns ingress,
durability, orchestration, and dispatch.

Current authoritative runtime split:

- queue-backed:
  - `oracle_request`: forwards supported execution routes to the
    existing confidential execution plane
    - kernel lane: `request_dispatch`

Feed, callback-broadcast, and automation bindings/classes remain as migration and
recovery artifacts, but ingress never dispatches them: feed returns `410`,
callback is a no-op, and automation returns `503`. They are not a fallback
authority for the Rust custody topology. Production automation therefore remains
unavailable, not silently delegated to a Cloudflare Workflow.

## Recovery Model

The control plane treats delivery as recoverable instead of assuming a single
successful pass:

- retryable execution/backend failures move jobs back to `queued`
- `run_after` is persisted with exponential backoff plus jitter
- queue consumers skip non-stale `processing` jobs to avoid duplicate execution
- workflow-backed jobs use Cloudflare Workflow state as the first recovery
  signal before a new instance is dispatched
- stale `processing` jobs and overdue `queued` jobs can be recovered with
  `POST /<network>/jobs/recover`
- queue messages that exhaust `max_retries` are routed by Cloudflare to
  per-queue dead-letter queues (`morpheus-oracle-request-dlq`,
  `morpheus-feed-tick-dlq`) so the loss is inspectable instead of silent;
  create both queues (`wrangler queues create <name>`) before deploying
- the worker now **consumes** those dead-letter queues and finalizes the
  poison job's Supabase row to `dead_lettered` (terminal). Without this, the
  row stayed in `queued`/`processing` and the cron recovery path re-requeued it
  forever. The DLQ consumer bindings are in the wrangler toml; they activate on
  the next `wrangler deploy` (no separate queue needs to be created — the DLQs
  already exist). **Deploy step for the lead:** redeploy the worker so the new
  `[[queues.consumers]]` entries for `morpheus-oracle-request-dlq` /
  `morpheus-feed-tick-dlq` take effect.
- the recovery/cron path also enforces a requeue ceiling
  (`MORPHEUS_CONTROL_PLANE_MAX_REQUEUE_ATTEMPTS`, default 3): a job re-driven
  past the ceiling is marked `dead_lettered` instead of being re-requeued, so a
  job that never reaches the queue DLQ (e.g. it keeps failing on dispatch or its
  workflow keeps re-failing) still terminates.
- a `*/5 * * * *` cron trigger runs the same recovery path as
  `POST /<network>/jobs/recover` automatically across both networks, so stuck
  Supabase rows are requeued without operator intervention

The `POST /<network>/jobs/recover` endpoint remains available for immediate
post-outage recovery. A typical operator flow is:

```bash
curl -X POST \
  -H "authorization: Bearer $MORPHEUS_CONTROL_PLANE_API_KEY" \
  https://control.meshmini.app/testnet/jobs/recover
```

The response includes `scanned`, `requeued_count`, `skipped_count`,
`failed_count`, and `dead_lettered_count` (jobs finalized by the requeue
ceiling).

## Required Bindings

- `MORPHEUS_ORACLE_REQUEST_QUEUE`

Legacy deployments may still carry `MORPHEUS_FEED_TICK_QUEUE`,
`CALLBACK_BROADCAST_WORKFLOW`, and `AUTOMATION_EXECUTE_WORKFLOW` for recovery
metadata. They are not required for an authoritative request-only ingress and
must not be treated as production feed/automation delivery.

## Required Secrets

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`
- `MORPHEUS_CONTROL_PLANE_API_KEY` or `MORPHEUS_OPERATOR_API_KEY`
- `MORPHEUS_WORKFLOW_API_KEY` when callback/automation workflows call the app backend

These credentials must not reuse `MORPHEUS_RUNTIME_TOKEN`,
`NITRO_API_TOKEN`, or `NITRO_SHARED_SECRET` values.

Production confidential execution accepts exactly one base URL per selected
lane and network. Comma-separated pools are rejected before dispatch, so an
execution bearer is never retried against a different origin.

Optional:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `MORPHEUS_MAINNET_EXECUTION_BASE_URL` or shared `MORPHEUS_EXECUTION_BASE_URL`
- `MORPHEUS_TESTNET_EXECUTION_BASE_URL` or shared `MORPHEUS_EXECUTION_BASE_URL`
- `MORPHEUS_MAINNET_FEED_EXECUTION_BASE_URL` / `MORPHEUS_TESTNET_FEED_EXECUTION_BASE_URL`
  when `feed_tick` should execute on the dedicated DataFeed CVM instead of the request CVM
- `MORPHEUS_EXECUTION_TOKEN`
- No signer material is configured at the edge. The execution plane (Nitro) signs
  every Neo N3 lane through the custody signer service; the edge only forwards
  base URLs and the execution token.
- `MORPHEUS_APP_BACKEND_URL`
- `MORPHEUS_APP_BACKEND_TOKEN` (workflow-credential migration alias; prefer
  `MORPHEUS_WORKFLOW_API_KEY`)
- `MORPHEUS_CONTROL_PLANE_REQUEUE_LIMIT`
- `MORPHEUS_CONTROL_PLANE_STALE_PROCESSING_MS`
- `MORPHEUS_CONTROL_PLANE_RETRY_BASE_SECONDS`
- `MORPHEUS_CONTROL_PLANE_RETRY_MAX_SECONDS`

Example env template:

- [vars.example.env](./vars.example.env)
- [wrangler.meshmini.toml](./wrangler.meshmini.toml)

Current production target:

- `https://control.meshmini.app`

Validation helper:

- `npm run check:control-plane` (required bindings only)
- `npm run check:control-plane:strict` (full production configuration)
- `npm run test:control-plane`
