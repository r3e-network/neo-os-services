# Relayer

`workers/morpheus-relayer` is the async request/response bridge for the Morpheus MiniApp OS kernel.

In the current production architecture, the relayer sits between the on-chain request surface and
the confidential execution plane. It persists chain-originated work before checkpoint advancement
and routes execution to the correct runtime lane.

It closes the loop:

1. MiniApp OS kernel request is emitted on-chain
2. Relayer detects the event
3. Relayer forwards the payload to the appropriate built-in module lane
4. Relayer calls `fulfillRequest(...)` back on the kernel contract
5. The kernel persists the canonical inbox item
6. Optional external callback adapters receive the result when configured

## Supported chains

- Neo N3

## Request routing

The relayer is still migrating from legacy `requestType` routing to the kernel's
`miniapp + module + operation` model.

Today it effectively maps legacy request taxonomy onto built-in module lanes:

The relayer maps `requestType` plus payload shape to worker routes:

- `compute` → built-in compute module → `/compute/execute`
- `datafeed` / `pricefeed` / `feed` → built-in shared resource module → `/oracle/feed`
- `vrf` / `random` → `/vrf/random`
- `privacy_oracle` and other legacy Oracle request types → built-in fetch/query module → `/oracle/smart-fetch`
- `datafeed` / `pricefeed` / `feed` → `/oracle/feed` internally for operator sync only
- The relayer prefers the compact smart-fetch response over raw query output

Long-term target:

- requests should be interpreted as kernel requests
- built-in modules should remain reusable across many registered miniapps
- miniapps should not need their own generic relayer plumbing

## Commands

```bash
npm --prefix workers/morpheus-relayer test
npm --prefix workers/morpheus-relayer run once
npm --prefix workers/morpheus-relayer run start
npm --prefix workers/morpheus-relayer run metrics
```

## Required env

- `MORPHEUS_RUNTIME_URL`
- `MORPHEUS_RUNTIME_TOKEN` or `NITRO_API_TOKEN` / `NITRO_SHARED_SECRET`
- `MORPHEUS_NETWORK` (`testnet` or `mainnet`)
- `NEO_RPC_URL`
- `CONTRACT_MORPHEUS_ORACLE_HASH`
- `MORPHEUS_RELAYER_NEO_N3_WIF` or `MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY`

If direct worker-side provider default resolution is needed during relayer processing, also set:

- `SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SECRET_KEY`

## Reliability Model

The relayer persists:

- per-chain last scanned block checkpoints
- processed-event records for dedupe
- retry queue entries with exponential backoff
- dead-letter history for exhausted requests
- aggregate metrics for the latest runs

Config knobs:

- `MORPHEUS_RELAYER_CONCURRENCY`
- `MORPHEUS_RELAYER_MAX_BLOCKS_PER_TICK`
- `MORPHEUS_RELAYER_MAX_RETRIES`
- `MORPHEUS_RELAYER_RETRY_BASE_DELAY_MS`
- `MORPHEUS_RELAYER_RETRY_MAX_DELAY_MS`
- `MORPHEUS_RELAYER_PROCESSED_CACHE_SIZE`
- `MORPHEUS_RELAYER_DEAD_LETTER_LIMIT`
- `MORPHEUS_RELAYER_LOG_FORMAT`
- `MORPHEUS_RELAYER_LOG_LEVEL`
- `MORPHEUS_RELAYER_NEO_N3_START_BLOCK`

Checkpoint note:

- if a saved checkpoint is ahead of the current confirmed chain tip, the relayer now resets that chain checkpoint to the configured start block instead of stalling forever

检查点说明：

- 如果已保存的 checkpoint 高于当前已确认链高度，relayer 现在会自动回退到配置的起始区块，而不是永久卡住

Neo N3 txproxy note:

- the Neo N3 txproxy allowlist now permits both `fulfillRequest` and `queueAutomationRequest` on the Morpheus kernel contract so automation executions can be queued on-chain through the compatibility path

## Supabase Persistence

If `SUPABASE_URL` plus a service key are configured, the relayer also persists:

- run snapshots to `morpheus_relayer_runs`
- job lifecycle records to `morpheus_relayer_jobs`

The dashboard can read these through:

- `/api/relayer/metrics`
- `/api/relayer/jobs`
- `/api/relayer/dead-letters`

Manual operator actions:

- `POST /api/relayer/jobs/retry`
- `POST /api/relayer/jobs/replay`

These enqueue the stored event back into the relayer for manual retry / dead-letter replay.

## State file

The relayer stores its durable runtime state in:

- `.morpheus-relayer-state.json`

Override with:

- `MORPHEUS_RELAYER_STATE_FILE`

## Docker

Build and run:

```bash
docker build -f workers/morpheus-relayer/Dockerfile -t morpheus-relayer .
docker run --env-file .env morpheus-relayer
```

## systemd

Example unit file:

- `deploy/systemd/morpheus-relayer.service`

Typical install:

```bash
sudo cp deploy/systemd/morpheus-relayer.service /etc/systemd/system/morpheus-relayer.service
sudo systemctl daemon-reload
sudo systemctl enable morpheus-relayer
sudo systemctl start morpheus-relayer
```

## Nitro Sidecar Pattern

A simple production pattern is:

- deploy `workers/nitro-worker` to the AWS Nitro enclave
- run `workers/morpheus-relayer` as a sidecar process on a small VM or container
- point `MORPHEUS_RUNTIME_URL` at the public Morpheus runtime endpoint
- keep chain updater keys and Supabase service credentials only in the sidecar env
