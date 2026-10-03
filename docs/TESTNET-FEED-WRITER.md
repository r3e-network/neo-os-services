# TestNet per-pair MorpheusDataFeed writer

> **Current topology decision (2026-10-03):** The deleted TestNet Nitro host
> is not being restored. Use the approved single-host dual-network topology in
> [`runbooks/NITRO-SINGLE-HOST-DUAL-NETWORK-20261003.md`](runbooks/NITRO-SINGLE-HOST-DUAL-NETWORK-20261003.md).
> Older separate-host references in this document are historical deployment
> evidence. The current policy is one approved Nitro host with separate
> profiles; do not create a second host.

## Overview

The deployed Neo N3 TestNet `MorpheusDataFeed`
`0x9bea75cf702f6afc09125aa6d22f082bfd2ee064` exposes `updateFeed` (6 arguments)
and **not** `updateFeeds`. The host batch pusher and enclave `/feed/sign`
default remain `updateFeeds` for mainnet `0x03013f49…`.

This checkout adds a **testnet-only** write mode that serializes a bounded
sequence of individual `updateFeed` calls through the **existing** enclave
signer / host rebuild / `sendrawtransaction` interface. The **mainnet** path
stays batch `updateFeeds`. Neither mode treats a mempool hash as success:
after broadcast the host persists the signed identity/hash, then a bounded
`getapplicationlog` poll must observe `HALT` before `confirmed` / `ok`.
`submitted`, `pending`, confirmation `timeout`, `FAULT`, rejection, and
intentional `skipped` stay distinct; overall status is fail-closed.

Mainnet and any unknown network refuse a silent downgrade from batch to
per-pair.

**Status of the enclave half (2026-09-23).** The enclave `/feed/sign` lane
this mode was written against is the Node `deploy/nitro/enclave-server.mjs`,
whose Neo N3 lanes now answer HTTP 410 (`neo_n3_signer_retired`): since S5 no
process holds a Neo N3 key. The Rust frontier (`workers/nitro-enclave-host`)
signs only the batch `updateFeeds` transaction through custody; the per-pair
`updateFeed` mode has no other implementation. That gap is an owner decision
(round-9 audit 3a), not a port in progress.

**Rust `neo-os-relayer` is the production writer on every network**, including
TestNet. The Node `morpheus-feed-pusher-testnet` units in this checkout are a
disabled compatibility artifact: they have no `[Install]` target, require
`/opt/morpheus/nitro/ENABLE_NODE_FEED_PUSHER_COMPAT`, and `Conflicts=` /
`Before=` both Rust relayer units. They are not a live heal and must not be
enabled.

**Local implementation is not a live heal.** Prices on TestNet `0x9bea75cf…`
and mainnet `0x03013f49…` stay stale until the Rust relayer (or, only during
an explicit rollback, a manually started Node compatibility oneshot) writes
them. Mainnet recovery still also requires a valid TwelveData subscription/key
— an expired key makes every pair look missing and no confirmation path can
invent prices. This checkout does not deploy, does not submit a chain
transaction, and does not fund a wallet.

## Design decisions

1. **One in-TEE network identity.** `bindEnclaveNetworkIdentity` freezes
   `{ network, magic, feed, updaterSh, updaterPub, updaterRole }` from
   `FEED_NETWORK` plus matching `FEED_MAGIC` / `MORPHEUS_NETWORK` / intended
   updater. Any split (`FEED_NETWORK=testnet` with leftover mainnet magic, or
   `MORPHEUS_NETWORK` naming a different network) fails closed at provision
   and before `/feed/sign`. The identity is immutable for the process: a later
   retarget is refused. Host `MORPHEUS_NETWORK` still cannot silently retarget
   `feed-pusher.mjs`; the TEE pin is a separate, aligned binding.
2. **Network first, ABI second.** Write mode is chosen only after that pin
   and a proven public ABI. Capability is exact `updateFeed` /
   `updateFeeds` parameter count and types, not method-name presence.
   Captured fixtures live in
   `deploy/feed-pusher/fixtures/morpheus-datafeed-{testnet,mainnet}.getcontractstate.json`.
3. **Broadcast acceptance ≠ confirmed execution (both write modes).**
   `sendrawtransaction` records `submitted` / `pending` and persists the
   signed identity (`hash`, `nonce`, `validUntilBlock`). Cycle `ok` requires
   every planned pair to reach application-log `HALT` or be an intentional
   skip. The confirmation poll is bounded
   (`FEED_CONFIRMATION_POLL_ATTEMPTS` × `FEED_CONFIRMATION_POLL_INTERVAL_MS`);
   it never waits forever. Mainnet batch `updateFeeds` uses the same
   confirm/reconcile helpers as TestNet per-pair — one identity for the
   whole batch, not a silent mempool-accept success.
4. **Timeout retry is the same signed tx.** Ambiguous broadcast (transport
   timeout / reset) retains `{ nonce, validUntilBlock, message, hash, raw }`.
   The host reconciles `getapplicationlog` / `getrawtransaction` for that
   hash before any replace. A second same-round write is allowed only when
   the previous identity is proven unused (explicit rejection or
   `validUntilBlock` expired, and not on chain). Batch mode must not mint a
   fresh nonce and a second `updateFeeds` while the first identity is still
   ambiguous. Transport retries use structured codes (`TimeoutError` /
   `AbortError` / `ECONNRESET` / …), not a substring match on `network`.
   Mainnet batch writes persist the complete replay identity atomically, mode
   `0600`, at `<PUSH_STATUS>.pending-batch.json` **before** the first broadcast.
   A later systemd oneshot validates its network/feed/updater and recomputes the
   raw transaction hash, nonce, valid-until block, and signing message before
   reusing it. The sidecar is cleared only after `HALT` / `FAULT`, or after the
   identity is both unknown and expired. TestNet per-pair mode still preserves
   exact raw identity across its two in-process attempts; it does not yet ship a
   durable multi-identity queue across separate oneshots.
5. **No host-key N3 signing.** Each per-pair transaction is still computed
   and signed inside the enclave (`POST /feed/sign` with `write_mode` **and**
   `operation` both `updateFeed`). There is no `pinOverride` on the
   production builder.
6. **Signer health matches the live `/health` body.** `ready` +
   `checks.signer` + materialized `key_source.updater`
   (`kms_attested` | `host_plaintext`). Compact `{ ready, signer: true }`
   is not accepted: it does not prove an updater key.
7. **Separate TestNet signer pin, not an in-place mainnet cutover.** One
   running enclave cannot serve both pins. Operators must not rebuild or
   replace the live mainnet EIF, and must not run both write paths in one
   enclave. The Node TestNet pusher is still not a production authority.
8. **Single approved Nitro host with separate profiles.** The recorded
   allocator snapshot was `cpu_count: 2` / `memory_mib: 2048`, fully consumed
   by the mainnet frontier on CID 16. Do not create a second server; the owner
   must first confirm or provision enough capacity on this same approved host
   for a TestNet profile. Once that gate passes, TestNet uses
   `Requires=morpheus-nitro-signer-testnet.service`,
   `SIGNER_URL=http://127.0.0.1:8791`, CID 18, a testnet-named EIF, and
   separately supervised state. CID 17 / host port 8789 remain reserved for
   custody. The profiles must never share write paths or private state.

## API Reference

### `resolveFeedWriteMode(network, abi)`

`deploy/feed-pusher/lib-feed-network.mjs`

| Input                                                       | Rule                                  |
| ----------------------------------------------------------- | ------------------------------------- |
| `abi.probed !== true`                                       | throw (`ABI not proven`)              |
| writer method present with wrong arity / types / duplicates | throw (`ambiguous` / `wrong_arity`)   |
| `network` not `mainnet` or `testnet`                        | throw (unknown network; no downgrade) |
| `has_update_feeds === true` (exact 6× Array)                | `batch_update_feeds`                  |
| `network === 'testnet'` and exact 6-arg `updateFeed`        | `per_pair_update_feed`                |
| anything else                                               | throw                                 |

### `encodeUpdateFeedInvocation(fields)`

Shared production builder. Parameter types/order are `UPDATE_FEED_PARAMETERS`
(the same list ABI verification uses). Returns:

```
updateFeed(pair, roundId, price, timestamp, attestationHash, sourceSetId)
```

Same `{ type, value }` shape the worker `buildFeedUpdateInvocation` unsigned
path uses. `pair` must be `TWELVEDATA:<SYMBOL>`. Tests import this helper
instead of duplicating the constant list.

### Write-report progression and confirmation

`createFeedWriteReport` / `advanceFeedWrite` / `finalizeFeedWrite` are the
shared status machine for **both** `per_pair_update_feed` and
`batch_update_feeds`. Per-pair aliases (`createPerPairWriteReport`, …)
call the same helpers.

`boundPerPairUpdates(pairs)` refuses a list longer than
`MAX_PER_PAIR_FEED_UPDATES` (64). Order is the caller’s deterministic
`SYMBOLS` order; the helper does not sort. Batch mode applies one
confirmation outcome to every planned pair in that batch.

`advanceFeedWrite(report, event)` records distinct
`confirmed` / `pending` / `failed` / `skipped` rows with attempt index,
txid, and error. `submitted` is broadcast-accept evidence and is not
final success. After a batch `sendrawtransaction` accept the host writes
status JSON with `confirmation_status=submitted` and the identity hash
**before** the HALT poll.

Status JSON also includes `write_attempts` and `pairs_faulted`, so an operator
can distinguish confirmation timeout, application-log `FAULT`, and explicit
broadcast rejection while `confirmation_status` remains the stable five-state
field (`submitted`, `pending`, `confirmed`, `skipped`, `failed`).

`finalizeFeedWrite(report)` sets `ok` only when every planned pair is
`confirmed` (`HALT`) or `skipped`. Pending, confirmation timeout, `FAULT`,
and any unresolved planned pair fail closed. That fail-closed `ok=false`
exits the pusher oneshot `1` so `OnFailure=morpheus-alert@%n.service` can
alert immediately. The independent freshness monitor does not read pusher
status: it fails only after on-chain age crosses its threshold. Monitor
Prometheus still exports age and updater GAS only. Writer confirmation
states are a separate `PUSH_PROM_TEXTFILE` surface
([`FEED-WRITER-METRICS.md`](./FEED-WRITER-METRICS.md)): `skipped` means no
planned writes; `submitted`/`pending` mean unconfirmed; `fault` is
application-log FAULT. Scraping those series is not alert delivery.

Retry policy: `PER_PAIR_ATTEMPTS` (2) with `PER_PAIR_TIMEOUT_MS` (20s) per
attempt, shared by both write modes. Safe retries:

| Outcome                                                       | Action                                                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Transport timeout / reset **before** a signed identity exists | sign a new tx                                                                                        |
| Transport timeout **after** broadcast of a known hash         | reconcile that hash; resend the **same** raw tx if still unknown                                     |
| `AlreadyExists` / found in mempool                            | confirm that hash; do not replace                                                                    |
| Explicit rejection and hash unknown                           | fail closed; batch keeps the signed sidecar and will not replace before safe reconciliation / expiry |
| `invokescript` FAULT, ABI, identity, message mismatch         | no retry                                                                                             |
| Confirmation pending / timeout / application-log `FAULT`      | no second write                                                                                      |

### `ENCLAVE_FEED_SIGN`

`deploy/feed-pusher/feed-pusher.mjs` exports this boolean from
`MORPHEUS_FEED_PUSHER_ENCLAVE_SIGN`. Neo X enablement and
`resolveNeoXFeedSignerMode` read the same value. It is a compatibility
flag only: Rust `neo-os-relayer` remains the production writer. The
unit test imports the export so an undefined identifier cannot reach
the Neo X lane as a `ReferenceError`.

### Enclave `/feed/sign`

| Field                            | Meaning                                           |
| -------------------------------- | ------------------------------------------------- |
| `write_mode` **and** `operation` | both must be `updateFeed` on the host accept path |
| `symbols`                        | one bare symbol per `updateFeed` call             |
| `tx_params`                      | pinned `nonce`, `block_count`, fees               |

`write_mode=updateFeed` is accepted only when the bound in-TEE identity
network is `testnet`. Contract hash and magic come from that identity, not
a host-supplied override. Mismatched `FEED_NETWORK` / `FEED_MAGIC` /
`MORPHEUS_NETWORK` refuse **before** signing.

## Usage examples

```bash
# Local unit surface (no chain write)
FEED_PUSHER_SKIP_MAIN=1 node --test deploy/feed-pusher/lib-feed-network.test.mjs \
  deploy/feed-pusher/lib-feed-writer-metrics.test.mjs \
  deploy/feed-pusher/feed-write-mode.test.mjs deploy/feed-pusher/feed-pusher.test.mjs \
  deploy/feed-pusher/feed-unit-isolation.test.mjs deploy/nitro/nitro-unit-isolation.test.mjs

# Operator preflight — same approved Nitro host (this checkout performs no
# host mutation). First confirm capacity, free CID 18 / port 8791, separate
# profile state, and matching TestNet PCR/KMS/RPC identity alongside mainnet.
# Do not create a second host, rebuild the live mainnet EIF, enable both write
# paths in one enclave, or enable the frozen Node writer. After the owner has
# approved the host evidence, use the current single-host runbook:
# docs/runbooks/NITRO-SINGLE-HOST-DUAL-NETWORK-20261003.md
# and the named systemd units for the separately supervised TestNet profile.
```

Expected status after a live oneshot (illustrative). `ok` is true only when
every planned pair has application-log `HALT` (or was skipped). Submitted
hashes without confirmation stay in `pairs_pending` and force `ok=false`.
Batch mainnet uses the same field names plus `confirmation_status`:

```json
{
  "ok": true,
  "network": "testnet",
  "write_mode": "per_pair_update_feed",
  "confirmation_status": "confirmed",
  "feed": "0x9bea75cf702f6afc09125aa6d22f082bfd2ee064",
  "pairs_confirmed": ["TWELVEDATA:NEO-USD"],
  "pairs_pending": [],
  "pairs_submitted": ["TWELVEDATA:NEO-USD"],
  "pairs_failed": [],
  "pairs_skipped": [],
  "pairs_faulted": [],
  "txids": ["0x…"],
  "submitted_identity": { "hash": "0x…", "nonce": 1, "validUntilBlock": 4000500 },
  "write_attempts": [
    {
      "pair": "TWELVEDATA:NEO-USD",
      "status": "confirmed",
      "attempt": 1,
      "txid": "0x…",
      "error": null
    }
  ],
  "errors": [],
  "missing_alerts": []
}
```

`confirmation_status` is one of `submitted`, `pending`, `confirmed`,
`skipped`, `failed`. A batch `updateFeeds` cycle that only saw mempool
accept stays `submitted`/`pending` with `ok=false`.

`npm run audit:feeds:health -- --network testnet` still exits `1` until
on-chain timestamps are inside the 6-hour SLO. Passing tests here do not
change that.

## Deployment prerequisites

All of these are operator actions. This checkout must not perform them.

**Prohibit:** modifying the live mainnet EIF, `/provision` of TestNet pins
into the running mainnet enclave, running both write paths in one enclave,
or `systemctl enable` of any Node feed writer. That is a destructive
in-place cutover or a dual-write. Rollback of an EIF mistake is not
“toggle an env var”; it is restore the previous mainnet EIF.

1. **Single approved host + TestNet-named EIF.** Do not create a second
   server or add an unreviewed enclave. The recorded allocator snapshot is
   exhausted by the mainnet profile, so an owner must first confirm sufficient
   capacity on the same approved host. Build `morpheus-oracle-testnet.eif`
   with CID 18 / host port 8791 and leave the live mainnet EIF and
   `morpheus-feed-pusher.timer` untouched. `start-nitro-signer.sh` must not
   terminate an occupant of CID 16 or overwrite mainnet state.
2. **Atomic file install** into the TestNet unit `WorkingDirectory`
   `/opt/neoos/services/deploy/feed-pusher`: `feed-pusher.mjs`,
   `feed-monitor.mjs`, `feed-topup.mjs`, `db-prune.mjs`,
   `lib-feed-network.mjs`, `lib-feed-writer-metrics.mjs`. The live writer still uses
   `/opt/morpheus/neo-morpheus-oracle` and **does not** have
   `lib-feed-network.mjs`. Copy named unit files; never `*.service`.
3. **Isolated signer unit.** Install
   `morpheus-nitro-signer-testnet.service` and
   `morpheus-nitro-provision-testnet.service` with
   `morpheus-nitro-testnet.env` (CID 18, host port 8791, testnet signer
   env, testnet feed env). The TestNet pusher `Requires=` that signer
   and pins `SIGNER_URL=http://127.0.0.1:8791`. It must not
   `After=` the live `morpheus-nitro-signer.service`. The signer unit also
   pins `MORPHEUS_NITRO_ENV` at `ExecStart`; do not replace that with a bare
   launcher invocation, which would fall back to the default mainnet env path.
4. **Aligned identity.** Bake `FEED_NETWORK=testnet`,
   `FEED_MAGIC=894710606` and `MORPHEUS_NETWORK=testnet` into the TestNet
   image and provision the TestNet custody caller envelope
   (`SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64`); no Neo N3 signer
   ciphertext exists since S5. Leftover mainnet magic fails closed before
   signing. A TestNet KMS alias is not present today; do not reuse the live
   mainnet signer env file.
5. **Signer health.** `GET 127.0.0.1:8791/health` must return the live
   enclave body: `ready: true`, `checks.signer: true`, and
   `key_source.updater` of `custody` (`host_plaintext` is an S5 violation,
   never an accepted state). On-chain `updater()` must still equal
   `0xe421999c…` (`NiUs458jFbTH1DA3b9QyeDhMaD282h3iJg`).
6. **Funded TestNet writer host.** The TestNet updater must hold GAS
   (audit last read ~9026 GAS; re-check). The documented **mainnet**
   writer remains AWS `i-0c52851f134db20ee`. Hetzner `95.216.148.60`
   has no feed units.
7. **Secrets on the host, never from this checkout.** TestNet
   `TD_KEY` and `RUNTIME_TOKEN` in
   `/opt/morpheus/nitro/feed-pusher-testnet.env` (chmod 600). Do not put
   reserved `FEED_NETWORK` / `PUSH_*` / `SIGNER_URL` keys in that file;
   the unit pins them at exec time. Do not copy live `feed-pusher.env`
   (that file's TwelveData subscription is expired and would be shared).
8. **TwelveData must return usable quotes.** An expired key makes every
   pair look missing; the writer will fail closed, not invent prices.
   Do not automate a TestNet deploy while the known subscription is
   expired.

## Rollback

Rollback is safe **because** the mainnet EIF and mainnet units are left
untouched.

1. On the approved Nitro host, stop only the TestNet profile:
   `systemctl stop morpheus-feed-pusher-testnet.timer morpheus-feed-pusher-testnet.service`
   `systemctl disable --now morpheus-feed-pusher-testnet.timer` (cleans a leftover enable symlink from an older checkout)
   `rm -f /opt/morpheus/nitro/ENABLE_NODE_FEED_PUSHER_COMPAT`
   `systemctl stop morpheus-nitro-signer-testnet.service`
2. Do not stop, replace, or reallocate the mainnet EIF /
   `morpheus-nitro-signer` / `morpheus-feed-pusher.timer` /
   `nitro-enclaves-allocator` on `i-0c52851f134db20ee`.
   If an operator violated the isolate-EIF rule and rebuilt the live
   mainnet image, restore the previous mainnet EIF **before** starting
   mainnet feed units. That restore is the only recovery; there is no
   in-enclave dual-path toggle.
3. Do not delete TestNet status/log files; they are isolated
   (`feed-pusher-testnet.*`).
4. Confirm mainnet still writes `updateFeeds` only:
   `cat /opt/morpheus/nitro/feed-pusher-status.json` → `write_mode` is
   `batch_update_feeds` or absent on older hosts.

## Test coverage

| Case                         | Expected                                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ABI mode dispatch            | captured TestNet fixture → `per_pair_update_feed`; captured mainnet fixture → batch                                                                                                                          |
| Wrong arity / ambiguous ABI  | refuse before broadcast                                                                                                                                                                                      |
| Testnet-only guard           | mainnet / unknown / unprobed ABI refuse per-pair                                                                                                                                                             |
| Invocation encoding          | production `encodeUpdateFeedInvocation` matches fixture parameter types                                                                                                                                      |
| Confirmation                 | `sendrawtransaction` hash is pending until bounded `getapplicationlog` `HALT` (batch and per-pair)                                                                                                           |
| FAULT / pending / timeout    | explicit; cycle `ok=false`; pusher unit failure alerts immediately; freshness monitor turns red only after its age threshold                                                                                 |
| Idempotent retry             | accepted-then-timeout, rejection, pending, and same-raw replay; no second same-round write or fresh nonce                                                                                                    |
| Partial results              | confirmed / pending / skipped / failed distinct; any unconfirmed planned pair fails the cycle                                                                                                                |
| Mainnet batch HALT           | mempool accept is `submitted` only; HALT required before `confirmed`/`ok`                                                                                                                                    |
| Mainnet batch replay         | accepted-then-timeout and a later oneshot resend the persisted exact raw tx; no new nonce unless identity is unknown and expired                                                                             |
| TEE accept                   | `FEED_NETWORK=testnet` + matching magic / `MORPHEUS_NETWORK` / updater materializes and signs                                                                                                                |
| TEE refuse                   | mismatched pins refuse before signing; no `pinOverride`                                                                                                                                                      |
| Compact `/health`            | `{ ready, signer }` without materialized updater is rejected                                                                                                                                                 |
| Mainnet regression           | default `FEED_NETWORK` still batch `updateFeeds`; `updateFeed`-only ABI still fails closed                                                                                                                   |
| Topology isolation           | TestNet pusher `Requires=` `morpheus-nitro-signer-testnet`, pins `SIGNER_URL` `:8791`; TestNet env CID 18 / testnet-named EIF; start script refuses to terminate a non-testnet occupant of the requested CID |
| Writer compatibility posture | TestNet Node pusher/timer have no `[Install]`, require `ENABLE_NODE_FEED_PUSHER_COMPAT`, and `Conflicts=` / `Before=` both Rust relayers; topology discovery fails if a TestNet writer is omitted            |
| Neo X `ENCLAVE_FEED_SIGN`    | exported boolean; import is defined so Neo X cannot throw `ReferenceError`; production writer remains Rust                                                                                                   |
| Writer metrics               | Prometheus textfile one-hot states + pair counts; skipped ≠ pending ≠ FAULT; restart rebuilds from status/sidecar; no pair/txid/raw labels                                                                   |

## Implementation notes

- Shared helpers live in `deploy/feed-pusher/lib-feed-network.mjs` so the
  pusher, audit, and unit files cannot drift on write-mode policy,
  confirmation, or retry identity. Batch and per-pair both call
  `confirmFeedApplicationLog` / `reconcileSignedFeedTx` /
  `createFeedWriteReport`.
- `feed-pusher.mjs` `pushNeoN3` proves identity then dispatches. The batch
  mainnet path now persists the signed identity plus raw replay sidecar and
  requires application-log `HALT` before `ok`. That is local until deployed;
  live mainnet still also needs a valid TwelveData key.
- Enclave contract/magic for `/feed/sign` come from
  `bindEnclaveNetworkIdentity`, not a hardcoded mainnet hash and not a
  caller pin override.
- Install `lib-feed-network.mjs` and `lib-feed-writer-metrics.mjs` with the
  scripts. A host that only copies `feed-pusher.mjs` will fail to start.
