# NeoOS DataFeed price pusher — deployment & recovery runbook

Standalone price-feed writer that replaced the dead Phala compute worker for the
**price feed only**. It does NOT need the compute worker. Runs on the Nitro oracle
host (`i-0c52851f134db20ee`) as a systemd timer.

## Architecture

- On-chain contract: **MorpheusDataFeed** mainnet `0x03013f49c42a14546c8bbe58f9d434c3517fccab`.
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

> **Path warning (verified on the live box 2026-08-20).** The table below is the
> _intended_ layout. `i-0c52851f134db20ee` actually uses
> `/opt/morpheus/neo-morpheus-oracle` as its repo root — every installed unit has
> `WorkingDirectory=/opt/morpheus/neo-morpheus-oracle`, with `feed-pusher.mjs`
> symlinked to `deploy/feed-pusher/feed-pusher.mjs` and `feed-monitor.mjs` /
> `feed-topup.mjs` / `db-prune.mjs` at that root. Copying this repo's
> `*.service` files onto that box verbatim points them at a directory that does
> not exist and takes the feed down. Reconcile the path, or add behaviour with
> `/etc/systemd/system/<unit>.service.d/` drop-ins — see
> [`FEED-OUTAGE-RUNBOOK.md`](./FEED-OUTAGE-RUNBOOK.md) §0.

| repo file                               | box path                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `feed-pusher.mjs`                       | `/opt/neoos/services/deploy/feed-pusher/feed-pusher.mjs`                      |
| `feed-monitor.mjs`                      | `/opt/neoos/services/deploy/feed-pusher/feed-monitor.mjs`                     |
| `db-prune.mjs`                          | `/opt/neoos/services/deploy/feed-pusher/db-prune.mjs`                         |
| `morpheus-feed-pusher.{service,timer}`  | `/etc/systemd/system/` (every 5 min)                                          |
| `morpheus-feed-monitor.{service,timer}` | `/etc/systemd/system/` (every 15 min; fails visibly if feed stale or GAS low) |
| `morpheus-db-prune.{service,timer}`     | `/etc/systemd/system/` (daily 03:30 UTC; retain 30d)                          |
| `feed-pusher.env.example`               | template for `/opt/morpheus/nitro/feed-pusher.env` (chmod 600)                |

## Recover from a host loss

1. Provision the host; install Node 20+ and the `neo-os-services` repo at `/opt/neoos/services` (provides `node_modules/@cityofzion/neon-js`).
2. Restore the Nitro enclave signer (serves `127.0.0.1:8787`) — see `deploy/nitro/`.
3. Keep the scripts in `/opt/neoos/services/deploy/feed-pusher/`; copy the `*.service/*.timer` files to `/etc/systemd/system/`.
4. Create `/opt/morpheus/nitro/feed-pusher.env` from `feed-pusher.env.example` (chmod 600):
   `TD_KEY` (TwelveData), `RUNTIME_TOKEN` = `MORPHEUS_RUNTIME_TOKEN` from `morpheus-relayer.env`.
5. `systemctl daemon-reload && systemctl enable --now morpheus-feed-pusher.timer morpheus-feed-monitor.timer morpheus-feed-topup.timer morpheus-db-prune.timer`.
   (`morpheus-feed-topup.timer` was missing from this list until 2026-08, so the
   auto-topup may never have been installed on the live box — check
   `systemctl list-timers --all | grep feed-topup` before assuming it runs.)
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
  next step: a dedicated low-value funding key + a 6-hourly auto-topup timer (do NOT put the
  pool-controlling deployer WIF on the box).
- **Feed is stale / dead:** see [`FEED-OUTAGE-RUNBOOK.md`](./FEED-OUTAGE-RUNBOOK.md) — reproduction
  commands, the exact wallet and GAS amount to restore, and the three checks that prove recovery.
- **Monitor:** the monitor now routes its non-zero exit to `morpheus-alert@%n.service`
  (`OnFailure=`), which posts to `ALERT_WEBHOOK_URL`. Polling by hand is the fallback, not the
  detection mechanism: `systemctl is-failed morpheus-feed-monitor` / `cat /opt/morpheus/nitro/feed-status.json`.
  The monitor checks the **full on-chain pair registry** (via `getAllFeedRecords`), not just NEO-USD;
  `feed-status.json` carries a `pairs[]` array (per-pair `age_min`) alongside the back-compat `feed_age_min`.
  TradFi pairs (forex/commodities in `TRADFI_PAIRS`) get a widened staleness window
  (`TRADFI_WEEKEND_AGE_SEC`) over weekends/holidays so a closed market doesn't false-alarm.
  Set `MONITOR_PROM_TEXTFILE` to a node_exporter textfile-collector path to export
  `feed_age_seconds{pair,network}` + `feed_updater_gas{network}` (off by default).
- **Health checks:** `tail /opt/morpheus/nitro/feed-pusher.log`, `journalctl -u morpheus-feed-pusher`.
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

# Multi-chain price feed (Neo N3 + Neo X)

The feed pusher (`feed-pusher.mjs`) reads TwelveData once per cycle and pushes to
every configured chain. Currently two chains:

| Chain                         | Kind  | Contract                                                       | Signer                          |
| ----------------------------- | ----- | -------------------------------------------------------------- | ------------------------------- |
| Neo N3 mainnet                | NeoVM | MorpheusDataFeed `0x03013f49…`                                 | enclave `updater` via 8787      |
| Neo X mainnet (chainId 47763) | EVM   | MorpheusPriceFeed `0x38DD6BCEBDD47f4234AE11760CEFB58f9ae6a3bB` | raw key `NEOX_FEED_PK` (ethers) |

- **MorpheusPriceFeed.sol** (`contracts-evm/`, solc 0.8.35): `updateFeeds(symbols,prices,timestamps,roundIds)` (updater-gated, strictly-increasing roundId), `getLatest(symbol)`, `DECIMALS=6` (same 1e6 scaling as Neo N3 so the same integer is written to both chains). owner+updater = the deployer.
- **NeoX env** (`/opt/morpheus/nitro/feed-pusher.env`): `NEOX_FEED_PK` (updater key, address `0x622ae03BDB6d7E2A29BE853c75d625bB25c0139C`), `NEOX_RPC=https://mainnet-1.rpc.banelabs.org`, `NEOX_CHAIN_ID=47763`, `NEOX_FEED=0x38DD…`. NeoX disabled automatically if `NEOX_FEED_PK` is unset.
- **Gas**: the NeoX updater pays its own gas (self-funded; ~100 GAS at deploy). The pusher logs `[neox] ⚠️ LOW GAS` when balance `< NEOX_GAS_WARN` (default 5). For reserve-based auto-topup, fund `0x622ae03B…` from an external source (a single key is self-funding; the enclave cannot sign EVM/secp256k1, so NeoX uses a raw key rather than the 8787 enclave).
- **Add a chain**: append to the `CHAINS` array in feed-pusher.mjs with a `push(prices, now)` impl (EVM chains can reuse `pushNeoX`'s pattern with a different RPC/chainId/contract/key).
- Compile EVM contract: `node` a solc compile of `contracts-evm/MorpheusPriceFeed.sol` → `contracts-evm/build/`. Deploy via ethers with the deployer key.
