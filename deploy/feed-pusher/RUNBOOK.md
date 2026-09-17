# NeoOS Node DataFeed pusher — compatibility rollback runbook

> **Compatibility only — not a production authority.** Production Neo N3 and
> NeoX feeds are delivered by the Rust `neo-os-relayer` in `feed_only` or
> `combined` mode. The Node writers in this directory are frozen rollback/parity
> assets. Their services require
> `/opt/morpheus/nitro/ENABLE_NODE_FEED_PUSHER_COMPAT`, have no installable timer
> target, and conflict with both Rust relayer units. Never run either writer at
> the same time as a Rust feed lane: doing so creates a duplicate on-chain writer.

This standalone writer historically replaced the dead Phala compute worker for
the **price feed only**. The details below document the compatibility path and
live-box recovery history; they are not the current production installation path.

It does NOT need the compute worker. Runs on the Nitro oracle host
(`i-0c52851f134db20ee`) as a systemd timer. The Hetzner Fura/MCP box
(`95.216.148.60`) is a different host and has no feed units, timers, or
`/opt/neoos/services/deploy/feed-pusher` install.

## Architecture

- On-chain contract: **MorpheusDataFeed** mainnet `0x03013f49c42a14546c8bbe58f9d434c3517fccab`
  (default). `FEED_NETWORK=testnet` selects `0x9bea75cf702f6afc09125aa6d22f082bfd2ee064`.
  That testnet deployment exposes `updateFeed` (singular) and **not** `updateFeeds`.
  After magic-pinned `FEED_NETWORK=testnet` and a proven ABI, the host serializes
  individual `updateFeed` calls through the same enclave `/feed/sign` interface.
  Mainnet keeps batch `updateFeeds` and will not silently downgrade. After
  broadcast the host persists the signed identity and requires application-log
  `HALT` before `ok` / `confirmed` — mempool `sendrawtransaction` accept is
  `submitted` only. Deploy the
  TestNet writer on a **distinct** Nitro-capable instance with a
  testnet-pinned EIF (`morpheus-nitro-signer-testnet`, host `:8789`) — do
  not add a second enclave to `i-0c52851f134db20ee`, rebuild the live
  mainnet EIF, or enable both paths in one enclave. Local
  implementation does not make TestNet healthy until that isolated writer is
  deployed onto a funded signer/writer host. See
  [`../../docs/TESTNET-FEED-WRITER.md`](../../docs/TESTNET-FEED-WRITER.md)
  and [`../../docs/FEED-HEALTH-AUDIT.md`](../../docs/FEED-HEALTH-AUDIT.md).
  `UpdateFeeds(...)` only requires the tx be witnessed by the contract **updater** —
  there is NO on-chain attestation/signature check beyond the witness.
- On-chain updater = **NN8tbpgAx8zm5BNJZEqvi71Rj2Z8LX2RHh** (`0x9fb28bdacfaa7fcc0a4d660d0dc990b0e7d46118`),
  which is the Nitro enclave's `updater` role key. Admin = deployer (can `SetUpdater`).
- `feed-pusher.mjs` sends symbols, current state and bounded fee estimates to
  **enclave** `POST 127.0.0.1:8787/feed/sign`. The enclave independently fetches
  prices, applies the feed policy, constructs the canonical `UpdateFeeds` tx and
  signs it. The host rebuilds the returned plan byte-for-byte before broadcast.
- 18 symbols (TwelveData "grow" plan; stocks/most commodities/GLD 404 on that plan).
  Threshold-gated (0.1%) + 30-min heartbeat so stable assets still refresh their `roundId`.
- Multi-RPC failover (n3index / nspcc / coz). `roundId` and `timestamp` are set to `now`
  and must be strictly > / ≥ the on-chain values.

## Files

Units ship with `WorkingDirectory=/opt/neoos/services/deploy/feed-pusher`.
That directory is the install target. Copy the writer, monitor, topup, prune
scripts, `lib-feed-network.mjs`, and `lib-feed-writer-metrics.mjs` into it in one step (atomic install).
Do not copy a single script.

If a host still has a checkout only at `/opt/morpheus/neo-morpheus-oracle`
(the 2026-08 live-box layout), do **not** edit `WorkingDirectory=` in the
unit file. Either migrate the checkout to `/opt/neoos/services` (`npm run
install:code-path-compat`) or install a drop-in that points at the directory
where the scripts **and** library were atomically installed:

```
# /etc/systemd/system/morpheus-feed-pusher.service.d/10-workingdirectory.conf
[Service]
WorkingDirectory=/opt/morpheus/neo-morpheus-oracle/deploy/feed-pusher
```

Repeat the drop-in for each feed unit you enable. See
[`FEED-OUTAGE-RUNBOOK.md`](./FEED-OUTAGE-RUNBOOK.md) §0.

| repo file                                          | box path                                                                                                                                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `feed-pusher.mjs`                                  | `/opt/neoos/services/deploy/feed-pusher/feed-pusher.mjs`                                                                                                                                                                                                     |
| `feed-monitor.mjs`                                 | `/opt/neoos/services/deploy/feed-pusher/feed-monitor.mjs`                                                                                                                                                                                                    |
| `feed-topup.mjs`                                   | `/opt/neoos/services/deploy/feed-pusher/feed-topup.mjs`                                                                                                                                                                                                      |
| `lib-feed-network.mjs`                             | `/opt/neoos/services/deploy/feed-pusher/lib-feed-network.mjs` (required sibling)                                                                                                                                                                             |
| `lib-feed-writer-metrics.mjs`                      | `/opt/neoos/services/deploy/feed-pusher/lib-feed-writer-metrics.mjs` (required sibling)                                                                                                                                                                      |
| `db-prune.mjs`                                     | `/opt/neoos/services/deploy/feed-pusher/db-prune.mjs`                                                                                                                                                                                                        |
| `morpheus-feed-pusher.service` + `.timer`          | `/etc/systemd/system/` (every 5 min; exec-time pin `FEED_NETWORK=mainnet`)                                                                                                                                                                                   |
| `morpheus-feed-monitor.service` + `.timer`         | `/etc/systemd/system/` (every 15 min; exec-time pin `FEED_NETWORK=mainnet`)                                                                                                                                                                                  |
| `morpheus-feed-pusher-neox.service` + `.timer`     | `/etc/systemd/system/` (distinct `PUSH_*` / `MISSING_STATE` from N3)                                                                                                                                                                                         |
| `morpheus-feed-pusher-testnet.service` + `.timer`  | `/etc/systemd/system/` (compatibility artifact: no `[Install]`; requires `ENABLE_NODE_FEED_PUSHER_COMPAT`; `Conflicts=` / `Before=` both Rust relayers; distinct `PUSH_*` / `MISSING_STATE` / `SIGNER_URL=:8789`; `Requires=` TestNet signer). Never enable. |
| `morpheus-feed-monitor-testnet.service` + `.timer` | `/etc/systemd/system/` (distinct `MONITOR_*` paths/labels)                                                                                                                                                                                                   |
| `morpheus-db-prune.service` + `.timer`             | `/etc/systemd/system/` (daily 03:30 UTC; retain 30d)                                                                                                                                                                                                         |
| `feed-pusher.env.example`                          | template for `/opt/morpheus/nitro/feed-pusher.env` (chmod 600)                                                                                                                                                                                               |

## Emergency compatibility rollback

Use this only when an operator has deliberately stopped both Rust relayer units
and accepted the temporary Node compatibility boundary. Normal host recovery
must follow `deploy/nitro/README.md` and restore the Rust relayer instead.

1. Provision the host; install Node 20+ and the `neo-os-services` repo at `/opt/neoos/services` (provides `node_modules/@cityofzion/neon-js`).
2. Restore the Nitro enclave signer (serves `127.0.0.1:8787`) — see `deploy/nitro/`.
3. Atomically install `feed-pusher.mjs`, `feed-monitor.mjs`, `feed-topup.mjs`,
   `db-prune.mjs`, `lib-feed-network.mjs`, and `lib-feed-writer-metrics.mjs` into
   `/opt/neoos/services/deploy/feed-pusher/` (the unit `WorkingDirectory`).
   Install named unit files only — do not glob-copy `*.service`. A copy of a
   single script without the library will fail to start. If the host checkout
   is still only at `/opt/morpheus/neo-morpheus-oracle`, install a
   `WorkingDirectory=` drop-in (see Files) and place the same six files in
   that drop-in directory in one step. Units pin network and state/log/prom
   paths at exec time (`ExecStart=/usr/bin/env KEY=value … /usr/bin/node …`)
   because systemd `EnvironmentFile=` overrides `Environment=` regardless of
   unit-file order. Mainnet N3 pins `FEED_NETWORK=mainnet` plus
   `feed-pusher.log` / `feed-pusher-status.json` / `feed-pusher-missing.json`.
   Neo X pins the same network but distinct `feed-pusher-neox.*` state files
   so concurrent timers cannot overwrite N3. Testnet pins `FEED_NETWORK=testnet`
   and distinct `PUSH_LOG`, `PUSH_STATUS`, `MISSING_STATE`, `PUSH_PROM_TEXTFILE`,
   `MONITOR_STATUS`,
   `MONITOR_LOG`, `MONITOR_PROM_TEXTFILE`, and `MONITOR_NETWORK`. Do not put
   those reserved keys in `feed-pusher.env`. `N3_FEED` / `FEED_MAGIC` in the
   env file must match the selected `FEED_NETWORK` defaults or the process
   fails closed; `FEED_RPCS` may rotate URLs and is isolated by `getversion`.
4. Create `/opt/morpheus/nitro/feed-pusher.env` from `feed-pusher.env.example` (chmod 600):
   `TD_KEY` (TwelveData), `RUNTIME_TOKEN` = `MORPHEUS_RUNTIME_TOKEN` from `morpheus-relayer.env`.
5. Stop the Rust authority, create the explicit compatibility marker, reload
   systemd, and start (do not enable) only the required compatibility timer:

   ```bash
   systemctl stop morpheus-relayer.service morpheus-relayer-nitro.service
   install -m 0600 /dev/null /opt/morpheus/nitro/ENABLE_NODE_FEED_PUSHER_COMPAT
   systemctl daemon-reload
   systemctl start morpheus-feed-pusher.timer morpheus-feed-pusher-neox.timer
   ```

   Monitoring and DB-prune units do not write chain state and may be managed
   separately. `morpheus-feed-topup` does submit a GAS transfer, so it is also a
   compatibility-only chain writer: create
   `/opt/morpheus/nitro/ENABLE_NODE_FEE_TOPUP_COMPAT` and start (never enable)
   its timer only while the Rust relayer is stopped. Delete both markers before
   restoring the Rust authority.
   Also install the alert target so unit failures reach a human:
   `cp ../systemd/morpheus-alert@.service /etc/systemd/system/` and create
   `/opt/morpheus/nitro/alert-notify.env` from `../systemd/alert-notify.env.example`.

6. Verify: `node feed-pusher.mjs` once; check `getLatest("TWELVEDATA:NEO-USD")` roundId is fresh.

## Operations

- **GAS:** updater burns ~4 GAS/day. Refund `0x9fb28bdacfaa7fcc0a4d660d0dc990b0e7d46118` when the
  monitor warns (`<12 GAS`). **The auto-topup cannot do this today:** its funding key
  `NZFMvLj6mxTHEn8gRGrjZDeFCDMTm96p6R` holds 20 GAS against a `TOPUP_AMOUNT` of 40, so
  `morpheus-feed-topup.service` has been in the failed state since long before the
  2026-07-29 outage. Refill that key or the updater has no automatic refill at all. Top up from the deployer (it is the contract admin). Recommended
  production Rust topology must use an operator-governed funding path until a
  Rust-native top-up lane is implemented. The Node timer is permitted only in
  an explicit compatibility rollback; do NOT put the pool-controlling deployer
  WIF on the box.
- **Feed is stale / dead:** see [`FEED-OUTAGE-RUNBOOK.md`](./FEED-OUTAGE-RUNBOOK.md) — reproduction
  commands, the exact wallet and GAS amount to restore, and the three checks that prove recovery.
- **Monitor:** the monitor now routes its non-zero exit to `morpheus-alert@%n.service`
  (`OnFailure=`), which posts to `ALERT_WEBHOOK_URL`. Polling by hand is the fallback, not the
  detection mechanism: `systemctl is-failed morpheus-feed-monitor` / `cat /opt/morpheus/nitro/feed-status.json`.
  The monitor checks the **full on-chain pair registry** (via `getAllFeedRecords`), not just NEO-USD;
  `feed-status.json` carries a `pairs[]` array (per-pair `age_min`) alongside the back-compat `feed_age_min`.
  TradFi pairs (forex/commodities in `TRADFI_PAIRS`) get a widened staleness window
  (`TRADFI_WEEKEND_AGE_SEC`) over weekends/holidays so a closed market doesn't false-alarm.
  Mainnet `MONITOR_PROM_TEXTFILE` is pinned empty at exec time so a leftover
  testnet path cannot collide; enable it with a systemd drop-in that changes
  the `ExecStart` pin, not with `feed-pusher.env`. Testnet units pin
  `/opt/morpheus/nitro/feed-monitor-testnet.prom`.
- **Health checks:** `AWS_PROFILE=morpheus npm run audit:feeds:health` (read-only,
  6-hour SLO; the audit retries documented profile `morpheus` when the default
  chain has no credentials). A funded writable contract with every active pair
  stale is `live_writer_not_advancing` — confirm whether the box is down or
  still cycling with an expired TwelveData key before restarting anything.
  `tail /opt/morpheus/nitro/feed-pusher.log`,
  `cat /opt/morpheus/nitro/feed-pusher-status.json`, `journalctl -u morpheus-feed-pusher`.
  Neo X writes `/opt/morpheus/nitro/feed-pusher-neox-status.json` and
  `feed-pusher-neox.log` so it cannot overwrite the N3 cycle.
  A cycle that cannot fetch TwelveData, cannot push, sees only mempool accept
  without application-log `HALT`, stays pending/timeout/FAULT/rejected, or
  hits a contract without `updateFeeds` now exits `1` so `OnFailure=` fires —
  including Neo X. Status JSON distinguishes `submitted`, `pending`,
  `confirmed`, `skipped`, and `failed` in both batch and per-pair modes
  (`confirmation_status`, `pairs_*`, `submitted_identity`); `write_attempts`
  and `pairs_faulted` retain timeout / FAULT / rejection detail. Mainnet batch
  also writes the complete signed replay material, mode `0600`, to
  `feed-pusher-status.json.pending-batch.json` before broadcast. Do not delete
  that sidecar while its identity is unexpired: a later oneshot must reconcile
  or replay that exact raw transaction instead of signing a duplicate. This
  checkout's HALT-closed batch path is local until deployed; live mainnet
  recovery still needs a valid TwelveData subscription/key.
  Monitor Prometheus remains on-chain pair age and updater GAS
  (`MONITOR_PROM_TEXTFILE`). Writer confirmation states are a **separate**
  scrape surface (`PUSH_PROM_TEXTFILE`, documented in
  [`../../docs/FEED-WRITER-METRICS.md`](../../docs/FEED-WRITER-METRICS.md)):
  last attempt / submitted / confirmed timestamps and `validUntilBlock`
  heights, one-hot `confirmation_state` (`skipped` = no planned writes,
  `submitted`/`pending` = unconfirmed, `fault` = application-log FAULT,
  `failed` = other write failure), pair **counts** (never pair ids), source
  missing/skip counts, confirmation latency, `failed_cycles_total`, and
  outstanding replay-sidecar presence. Mainnet and Neo X pin
  `PUSH_PROM_TEXTFILE` empty; TestNet pins
  `/opt/morpheus/nitro/feed-pusher-testnet.prom`. Enable mainnet with a
  drop-in that changes the exec pin — do not put that key in
  `feed-pusher.env`. These series are scrape/guidance only; this checkout
  does not configure Prometheus or alert delivery. The independent monitor
  still does not consume `feed-pusher-status.json`, so the pusher unit's
  own `OnFailure=` is the immediate failure signal.
- **DB:** `morpheus-db-prune` keeps the relayer's Supabase tables bounded (the original 402 outage cause).

## Known limitations

- Single enclave signer on one box remains a SPOF; deploy health monitoring and a measured standby.
- Worker-dependent oracle lanes (VRF/HTTP/compute/privacy/DID/paymaster) remain 404 until `workers/nitro-worker` is redeployed on Nitro. VRF alone is restorable relayer-locally (32 random bytes + oracle_verifier signature).

---

# Morpheus relayer (request fulfillment) — operations

The `morpheus-relayer-nitro` systemd service fulfills MiniApp oracle requests on the
**deployer-owned kernel** `0xf54d8584ef82315c1800373272ab08ae0db2d5ef` (mainnet). It signs
fulfillments via the Nitro enclave (`oracle_verifier` role, 8787) and witnesses the
`fulfillRequest` tx with the enclave `updater` (`0x9fb28bda…`). Both keys are already pinned
in the kernel (`runtimeVerificationPublicKey` / `updater`).

## Critical operational settings (env: /opt/morpheus/nitro/morpheus-relayer.env)

- **`MORPHEUS_DURABLE_QUEUE_ENABLED=false`** — REQUIRED. The durable queue used the morpheus
  Supabase project, which is over its size quota (402 `exceed_db_size_quota`). With it enabled,
  claims flap between "unavailable" and stale "processing" and requests never fulfill. Disabled,
  the single-box relayer coordinates on local state (the state file) — correct + robust for one
  instance. (Re-enable only after the morpheus Supabase project is cleaned below quota.)
- `MORPHEUS_SUPABASE_BACKOFF_MS=600000` — fail-fast on the residual (non-fatal, caught) Supabase
  automation/manual-action calls.

## Block checkpoint

- The relayer block cursor (`neo_n3.last_block` in the state file) MUST be near chain head.
  If it falls millions of blocks behind, each tick scans only `MORPHEUS_RELAYER_MAX_BLOCKS_PER_TICK`
  (default 250) blocks at ~0.45 s/block → ~113 s ticks and current requests are never reached via
  the block path (only the slower request-id path finds them). Symptom: tick_ms ~110000.
  Fix: stop service → set `state.neo_n3.last_block = <head-3>` (+ `last_request_id=0` to re-scan) →
  start. Healthy ticks are ~1.5–7 s. The request-id path finds requests regardless of block cursor.

## Relayer code requirement (digest binding)

- `fulfillRequest` verifies an ECDSA sig over `ComputeFulfillmentDigest` which appends the
  **executing script hash (LE) + network magic (LE)** to bind the sig to this deployment+network.
  The relayer must run router.js/fulfillment.js that include the deployment-suffix binding
  (`buildFulfillmentDigestBytes` deploymentSuffix; `signFulfillmentPayload` sets
  `digestContext.contractScriptHash`/`networkMagic`). Older code signs the unbound digest →
  `ABORTMSG: invalid verification signature`. Committed in repo (`feat(relayer): local VRF handler`).
- The kernel attempts the app's callback (`onOracleResult`) inside FulfillRequest; a callback to a
  non-existent/zero contract FAULTS the whole tx (the try/catch does not swallow
  "Called Contract Does Not Exist"). Every registered miniapp must use a real callback contract.

## VRF (random.generate) — no compute worker needed

- The relayer fulfills `operation` containing `random`/`vrf`/`rng` locally: 32 CSPRNG bytes signed
  by `oracle_verifier`. The kernel needs the `random.generate` system module registered + granted
  to the app. Validated e2e on mainnet 2026-06-06 (request #2, app `vrf-e2e`, callback
  OracleCallbackConsumer 0xe1226268).

---

# Historical compatibility implementation: Neo N3 + Neo X

The compatibility pusher (`feed-pusher.mjs`) reads TwelveData once per cycle and
pushes to every configured chain. Production uses the Rust relayer and custody
roles described in `deploy/nitro/neo-os-relayer.env.example`; the raw-key details
below apply only to the frozen compatibility implementation.

| Chain                         | Kind  | Contract                                                       | Signer                          |
| ----------------------------- | ----- | -------------------------------------------------------------- | ------------------------------- |
| Neo N3 mainnet                | NeoVM | MorpheusDataFeed `0x03013f49…`                                 | enclave `updater` via 8787      |
| Neo X mainnet (chainId 47763) | EVM   | MorpheusPriceFeed `0x38DD6BCEBDD47f4234AE11760CEFB58f9ae6a3bB` | raw key `NEOX_FEED_PK` (ethers) |

- **MorpheusPriceFeed.sol** (`contracts-evm/`, solc 0.8.35): `updateFeeds(symbols,prices,timestamps,roundIds)` (updater-gated, strictly-increasing roundId), `getLatest(symbol)`, `DECIMALS=6` (same 1e6 scaling as Neo N3 so the same integer is written to both chains). owner+updater = the deployer.
- **NeoX env** (`/opt/morpheus/nitro/feed-pusher.env`): `NEOX_FEED_PK` (updater key, address `0x622ae03BDB6d7E2A29BE853c75d625bB25c0139C`), `NEOX_RPC=https://mainnet-1.rpc.banelabs.org`, `NEOX_CHAIN_ID=47763`, `NEOX_FEED=0x38DD…`. NeoX disabled automatically if `NEOX_FEED_PK` is unset.
- **Gas**: the NeoX updater pays its own gas (self-funded; ~100 GAS at deploy). The pusher logs `[neox] ⚠️ LOW GAS` when balance `< NEOX_GAS_WARN` (default 5). For reserve-based auto-topup, fund `0x622ae03B…` from an external source (a single key is self-funding; the enclave cannot sign EVM/secp256k1, so NeoX uses a raw key rather than the 8787 enclave).
- **Add a chain**: append to the `CHAINS` array in feed-pusher.mjs with a `push(prices, now)` impl (EVM chains can reuse `pushNeoX`'s pattern with a different RPC/chainId/contract/key).
- Compile EVM contract: `node` a solc compile of `contracts-evm/MorpheusPriceFeed.sol` → `contracts-evm/build/`. Deploy via ethers with the deployer key.
