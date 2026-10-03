# Feed health audit

> **Current topology decision (2026-10-03):** The deleted TestNet Nitro host
> is not being restored. Mainnet and TestNet are separate supervised profiles
> on one approved Nitro host, with separate identities, state, listeners,
> metrics, and fail-closed network checks. Follow
> [`runbooks/NITRO-SINGLE-HOST-DUAL-NETWORK-20261003.md`](runbooks/NITRO-SINGLE-HOST-DUAL-NETWORK-20261003.md).
> Any distinct-instance wording below is historical evidence only.

## Overview

Read-only operator command that answers, from this checkout and public Neo N3
RPC, whether MorpheusDataFeed prices are inside the **6-hour SLO** and _why_
they are not.

It never broadcasts a transaction, never reads wallet files, never calls AWS
mutating APIs, and never prints secrets. A passing report is not a repair: the
price feed is fresh only when current on-chain timestamps prove it.

```bash
npm run audit:feeds:health
npm run audit:feeds:health -- --network testnet
npm run audit:feeds:health -- --network mainnet --stale-hours 6 --json
```

Exit codes:

| Code | Meaning                                                                                                                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Every selected network was readable and every **active** (non-retired) pair is inside the SLO                                                                                                                                |
| `1`  | Readable, but at least one active pair is older than the SLO                                                                                                                                                                 |
| `2`  | The audit itself cannot classify health: configuration error, RPC/magic isolation failure, or `getAllFeedRecords` FAULT / empty / malformed / undecodable, or an active pair timestamp is in the future of chain/header time |

A FAULT, empty HALT array, malformed stack, or undecodable record set is **not**
healthy. It is an unreadable feed (`readable: false`) and must not be treated as
`active_stale=0/0`.

## Why this exists

Testnet `MorpheusDataFeed` `0x9bea75cf702f6afc09125aa6d22f082bfd2ee064` exposes
`updateFeed` and not `updateFeeds`. This checkout now has a fail-closed
testnet-only per-pair writer and a fail-closed mainnet batch writer that
requires application-log `HALT` before treating `updateFeeds` as successful
(see `docs/TESTNET-FEED-WRITER.md`). **Local implementation is not a live
heal.** Rust `neo-os-relayer` is the production writer on TestNet and mainnet.
The Node TestNet units are a disabled compatibility artifact and must not be
enabled. On-chain prices stay stale until the Rust relayer writes them from a
funded signer/writer host with a matching EIF. Actual mainnet recovery still
depends on a valid TwelveData subscription/key; confirmation semantics cannot
invent quotes.

| Fact                                               | Evidence                                                                                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Default pusher target is still mainnet             | `FEED_NETWORK` default `mainnet` → `03013f49…`, magic `860833102`                                                                         |
| Testnet ABI has no batch writer                    | `getcontractstate` methods include `updateFeed` (singular) and **not** `updateFeeds`                                                      |
| Live EIF still signs `updateFeeds` only            | running host EIF; this checkout adds `write_mode=updateFeed` but is not deployed                                                          |
| Canonical testnet updater is funded                | `updater()` = `0xe421999c…` (NiUs…); GAS ≫ warn threshold                                                                                 |
| Box `i-0c52851f134db20ee` cannot be inspected here | `--skip-aws`, or STS fails on both the default chain **and** documented profile `morpheus`                                                |
| Hetzner Fura/MCP `95.216.148.60` is not the writer | SSH read-only: every `morpheus-feed-*` unit is `not-found`; `/opt/neoos/services/deploy/feed-pusher` and `/opt/morpheus/nitro` are absent |

A 6-hour SLO that only looked at “a record exists” would stay red forever on
retired pairs (`COPPER-USD`, `FLM-USD`, `1000FLM-USD`, `1000JPY-USD`) and hide
a new outage. This audit counts retired pairs separately. Retired-pair policy
is exported once from `deploy/feed-pusher/lib-feed-network.mjs`
(`DEFAULT_RETIRED_FEED_PAIRS`) and drift-checked by
`scripts/check-feed-pair-registries.mjs`.

Deploy the TestNet writer as a **separate supervised profile** on the approved
single Nitro-capable host with a testnet-pinned EIF. The host must pass the
shared capacity gate before either profile starts. Do not rebuild
the live mainnet EIF or enable both write paths in one enclave. See
[`TESTNET-FEED-WRITER.md`](./TESTNET-FEED-WRITER.md).

Do not quote historical pair counts from older notes. Re-run this command and
report the numbers it prints.

## API Reference

### `npm run audit:feeds:health`

| Flag            | Default | Meaning                                        |
| --------------- | ------- | ---------------------------------------------- |
| `--network`     | `all`   | `testnet`, `mainnet`, or `all`                 |
| `--stale-hours` | `6`     | SLO applied to active pairs                    |
| `--json`        | off     | JSON on stdout only (no human lines on stderr) |
| `--skip-aws`    | off     | Do not probe the AWS CLI                       |

Stdout is always a JSON report. Without `--json`, stderr also prints a short
headline plus every root cause.

### `buildFeedHealthReport({ repoRoot, network, staleHours, nowMs, invoke, getContractState, inspectAws, getVersion, getBlockHeaderTime })`

Pure enough to unit-test. Inject RPC and AWS seams; production uses public
`invokefunction` / `getcontractstate` / `getversion` / `getblock` via curl.

Returned object (per network):

- `readable` — `false` when `getAllFeedRecords` cannot be decoded
- `unreadable_reason` — `fault` / `empty` / `malformed` / `undecodable` / `rpc_magic_unvalidated`
- `decode_counts` — `{ record_count, decoded_count, undecodable_count }` when a
  nonempty registry was only partially decodable (partial decode is not healthy)
- `contract`, `onchain_updater`, `expected_updater`, `updater_gas`
- `abi.has_update_feeds` / `abi.has_update_feed`
- `pairs[]` with `age_seconds`, `stale`, `retired`, `clock_skew`, `timestamp_iso`
- `fresh`, `stale`, `retired_stale`, `active_stale`, `clock_skew`
- `age_clusters` (UTC date of last write)
- `root_causes[]` `{ code, severity, summary, evidence }`
- `ruled_out[]` same shape
- `live_blockers[]` (credentials, box access, `--skip-aws`, deploy)
- `chain_time_unix` — header time used for age, when available

Severity:

- `confirmed` — proven from this checkout or a successful RPC read
- `hypothesis` — consistent with evidence, not proven
- `live_blocker` — next step needs credentials or a write/deploy this shell must not do

### `runFeedHealthAudit(argv, deps)` (`scripts/audit-feed-health.mjs`)

CLI boundary used by `npm run audit:feeds:health`. Tests call it directly with
injected `buildReport` / stdio so exit `1` vs `2` is asserted without a live
chain write.

### `resolveFeedNetwork(env)` (`deploy/feed-pusher/lib-feed-network.mjs`)

Selects magic, contract hash, updater, and RPC list.

- Default `FEED_NETWORK=mainnet` keeps the live box behaviour.
- `FEED_NETWORK=testnet` selects `0x9bea75cf…`, magic `894710606`, updater
  `0xe421999c…`, and testnet RPC URLs.
- `MORPHEUS_NETWORK` is ignored. It must not silently retarget a feed writer.
- `N3_FEED` / `FEED_MAGIC` may confirm the selected `FEED_NETWORK` defaults.
  A leftover or mismatched hash/magic fails closed (no silent retarget).
  They are **not** pinned at exec time: the pin is `FEED_NETWORK`, and
  validation is the contract. `FEED_RPCS` stays configurable for RPC
  rotation; every URL must pass `getversion` magic. `N3_UPDATER_SH` is
  still an explicit override.
- Mainnet systemd units pin `FEED_NETWORK=mainnet` at **exec time**
  (`ExecStart=/usr/bin/env FEED_NETWORK=…`) so a leftover or copy-pasted
  `EnvironmentFile` value cannot retarget them. systemd `EnvironmentFile=`
  overrides `Environment=` regardless of unit-file order; `Environment=`
  alone is not a pin.

### Writer-host inspection

`--skip-aws` still records `aws_inspection_skipped`. It does not inspect
Hetzner and must not be read as “the writer host was checked.” The
documented writer remains AWS `i-0c52851f134db20ee`. The Hetzner Fura/MCP
box (`95.216.148.60`) has no feed units and is not a substitute.

When a network exposes `updateFeeds`, the updater is above `GAS_WARN`, and
every active pair is past the SLO, the audit adds
`live_writer_not_advancing`. That class is "the funded writer is not
advancing the contract": the host may be down, **or** the host may be
cycling while upstream TwelveData returns no usable quotes. It is not an
ABI mismatch and not a local checkout defect. Testnet without `updateFeeds`
must not receive this code. Use `AWS_PROFILE=morpheus` (or rely on the
documented-profile fallback) before concluding the box cannot be inspected.

### RPC isolation

Every candidate RPC is probed with `getversion` and kept only when
`protocol.network` equals the expected magic. URL substrings are not an
isolation mechanism. Dirty `config/networks/*.json` RPC lists are never mixed
into a writer/audit call until each URL has passed the magic check. Zero
matching RPCs is a configuration error (exit `2`), not a stale feed.

### Pusher fail-closed exits

`feed-pusher.mjs` now exits `1` (so `OnFailure=morpheus-alert@%n.service` fires)
when:

- TwelveData fetch fails
- a chain push throws (including Neo X `INSUFFICIENT_FUNDS`)
- `invokescript` FAULTs
- missing-symbol alerts are raised
- the target contract has been probed and lacks `updateFeeds` on mainnet / unknown
  networks (testnet `updateFeed`-only uses per-pair mode; see
  [`TESTNET-FEED-WRITER.md`](./TESTNET-FEED-WRITER.md))
- a testnet per-pair cycle has any failed, pending, timed-out, or FAULT pair
- a mainnet batch `updateFeeds` cycle is only mempool-accepted, still
  pending, timed out, FAULT, or rejected (broadcast accept is not success)
- no candidate RPC matches the pinned magic
- chain magic, contract identity, updater identity, ABI, prices, signer
  `/health`, or invocation result is not proven

`FEED_CHAINS` filtering that disables every chain still exits `0`.

The pusher status JSON/log retains write-mode and confirmation details.
Monitor Prometheus (`MONITOR_PROM_TEXTFILE`) still contains only on-chain
pair age and updater GAS. Writer confirmation metrics are a separate
`PUSH_PROM_TEXTFILE` surface (see [`FEED-WRITER-METRICS.md`](./FEED-WRITER-METRICS.md)).
`feed-monitor.mjs` also does not ingest pusher status, so it can remain green
until a failed write ages past the freshness threshold; the pusher unit's
`OnFailure=` is the immediate alert path. Those writer series do not by
themselves deliver alerts.

### Testnet systemd isolation

Testnet pusher/monitor units pin distinct `PUSH_LOG`, `PUSH_STATUS`,
`MISSING_STATE`, `PUSH_PROM_TEXTFILE`, `MONITOR_STATUS`, `MONITOR_LOG`,
`MONITOR_PROM_TEXTFILE`, and
`MONITOR_NETWORK` so they cannot collide with mainnet state, metrics, or logs.
Mainnet N3 keeps `feed-pusher.log` / `feed-pusher-status.json` /
`feed-pusher-missing.json`. Neo X pins `feed-pusher-neox.*` so concurrent
N3 and Neo X timers cannot overwrite one another.
`WorkingDirectory` is `/opt/neoos/services/deploy/feed-pusher` and must contain
`feed-pusher.mjs`, `feed-monitor.mjs`, `feed-topup.mjs`,
`lib-feed-network.mjs`, **and** `lib-feed-writer-metrics.mjs`. Install those
files together in one step. A host that
still uses `/opt/morpheus/neo-morpheus-oracle` must add a `WorkingDirectory=`
drop-in or migrate the checkout; do not copy a single script.

Reserved keys (`FEED_NETWORK`, `FEED_CHAINS`, `PUSH_LOG`, `PUSH_STATUS`,
`MISSING_STATE`, `PUSH_PROM_TEXTFILE`, `MONITOR_NETWORK`, `MONITOR_LOG`,
`MONITOR_STATUS`,
`MONITOR_PROM_TEXTFILE`, `FEED_TOPUP_ENV_FILE`, `TOPUP_LOG`) are applied by
`/usr/bin/env` on `ExecStart=` after systemd has merged `Environment=` and
`EnvironmentFile=`. A leftover `FEED_NETWORK=testnet` or a copy-pasted
testnet `PUSH_*` / `MONITOR_*` path in `feed-pusher.env` cannot retarget a
mainnet unit or collide with testnet state. `feed-pusher.env.example` must
not set those keys. Enabling mainnet Prometheus textfile output requires a
drop-in that changes the `ExecStart` pin, not an env-file assignment.

If `FEED_NETWORK=testnet` is used with topup (no dedicated testnet topup
unit ships here), default `TOPUP_LOG` and `FEED_TOPUP_ENV_FILE` resolve to
`feed-topup-testnet.log` / `feed-topup-testnet.env` so they cannot collide
with the mainnet topup files.

## Design decisions

1. **SLO is 6 hours for active pairs**, not the pusher’s 30-minute heartbeat.
   The heartbeat is how often a _working_ writer should refresh a flat price.
   The acceptance SLO is the operator budget for “this feed is dead.”
2. **ABI is probed before a testnet write is attempted.** Write mode is chosen
   only after magic-pinned `FEED_NETWORK` and a proven public ABI. Testnet with
   `updateFeed` and no `updateFeeds` selects `per_pair_update_feed`. Mainnet
   and unknown networks never silently downgrade from batch to per-pair. The
   deployed mainnet ABI may expose both exact `updateFeed` (legacy) and exact
   `updateFeeds` (canonical); that combination has one explicit outcome,
   `updateFeeds`. A mixed ABI on TestNet or an unknown network remains a hard
   failure, as does any duplicate, wrong-arity, or wrong-type method.
3. **No host-key N3 signing path is reintroduced.** Per-pair TestNet writes still
   go through enclave `/feed/sign` (`write_mode` and `operation` both
   `updateFeed`) and the host rebuild guard. Mainnet stays batch `updateFeeds`.
   Broadcast accept is not success in either mode; the cycle persists the
   signed identity and waits a bounded `getapplicationlog` `HALT`. Mainnet
   batch additionally persists validated raw replay material in
   `<PUSH_STATUS>.pending-batch.json`, so an ambiguous oneshot cannot be
   followed by a fresh nonce while the old transaction is still unexpired. See
   [`TESTNET-FEED-WRITER.md`](./TESTNET-FEED-WRITER.md). Local implementation
   is not a live heal: deploy a **separate** TestNet-pinned EIF, never an
   in-place cutover of the live mainnet writer. Deploying the batch HALT
   path still does not recover mainnet while TwelveData returns no quotes.
4. **AWS is a liveness signal, not a credential harvest.** The audit records
   only `reachable` / `reason` (and `profile` when the documented fallback
   was what worked). Reasons are `credentials_absent` (exact
   `Unable to locate credentials`), `credentials_expired_or_denied` (exact
   AWS codes: `ExpiredToken`, `AccessDenied`, `UnauthorizedOperation`,
   `InvalidClientTokenId`, `TokenRefreshRequired`, `SignatureDoesNotMatch`),
   and `aws_unreachable` (everything else, including bare `ENOENT` with empty
   stderr and generic TLS/connection expired messages). Identity output and
   stderr are never returned. The default credential chain is tried first.
   If that fails as `credentials_absent` and `AWS_PROFILE` is unset/empty,
   STS is retried with documented profile `morpheus` (`DOCUMENTED_AWS_PROFILE`).
   An explicit `AWS_PROFILE` is never overridden. `identity_ok` means the
   CLI can call STS; it is not an instance describe and not a host-journal
   read. The 2026-08-29 mainnet stall was a still-running writer whose
   TwelveData key received HTTP 401 `subscription has expired` — every
   symbol looked "missing" and the Aug-20 box image exited 0.
5. **`getAllFeedRecords` is fail-closed for every reader.** FAULT, empty
   HALT, malformed stack, or any undecodable row in a nonempty registry is
   not healthy and is not bootstrap. The monitor exits `2` with `ok=false`
   and never upgrades that to healthy via a fresh NEO-USD `getLatest`. The
   pusher aborts before planning or submitting writes (nonzero status,
   explicit reason). Per-pair `getLatest` fallback is allowed only when the
   contract clearly does not implement `getAllFeedRecords`. The audit
   returns `readable: false`, decode counts, and exit `2`.
6. **Age uses chain/header time when `getblock` is available.** Header time
   is normalized from seconds or milliseconds. A timestamp ahead of header
   time by more than the skew tolerance is `clock_skew`, not ordinary stale,
   and fails closed (exit `2`). The monitor uses the same header clock and
   exits `2` with `ok=false` and explicit `clock_skew` when any active pair
   is more than 120s ahead.
7. **Hash160 decode supports the HALT encodings the contract actually returns**
   (ByteString/ByteArray base64 LE, Hash160 hex, hex LE ByteString) and throws
   on unsupported representations.

## Usage examples

```bash
# Operator view (JSON on stdout, headline on stderr). Exit 1 if testnet is stale.
npm run audit:feeds:health -- --network testnet

# Machine view for CI / acceptance notes.
npm run audit:feeds:health -- --json --network all --stale-hours 6
```

Example testnet headline while the writer is absent (counts are illustrative;
re-run the command for the current numbers):

```
FEED HEALTH testnet FAIL active_stale=<n>/<n> (retired_stale=<n>) newest=NEO-USD age=<h>h
  confirmed  testnet_abi_missing_updateFeeds
  confirmed  default_pusher_targets_mainnet
  confirmed  all_active_pairs_beyond_slo
  live_blocker aws_credentials_absent or aws_inspection_skipped (cannot inspect i-0c52851f134db20ee)
  ruled_out  updater_gas_exhausted (canonical testnet updater funded)
```

## Test coverage

| Case                                               | Expected                                                     |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `resolveFeedNetwork()` default                     | mainnet hash + magic + updater                               |
| `FEED_NETWORK=testnet`                             | `9bea75cf…` / `894710606` / `e421999c…`                      |
| `MORPHEUS_NETWORK=testnet` without `FEED_NETWORK`  | still mainnet (no silent retarget)                           |
| RPC whose `getversion` magic mismatches            | rejected; zero matches → configuration error                 |
| ABI manifest without `updateFeeds` on mainnet      | `resolveFeedWriteMode` refuses silent per-pair downgrade     |
| Testnet ABI `updateFeed` only                      | `per_pair_update_feed` after magic-pinned selection          |
| Mainnet batch mempool accept                       | `submitted`/`pending`; `ok` only after application-log HALT  |
| Mainnet batch FAULT / timeout / rejection          | fail-closed; distinct status; unit exit 1                    |
| Active pairs older than 6h                         | `active_stale` excludes retired; exit 1                      |
| Writable ABI + funded updater + all active stale   | `live_writer_not_advancing`; not an ABI mismatch             |
| `--skip-aws`                                       | `aws_inspection_skipped` live blocker; Hetzner is not probed |
| `getAllFeedRecords` FAULT / empty / malformed      | `readable: false`; CLI/library exit 2                        |
| Future timestamp vs header time                    | `clock_skew`; not ordinary stale; exit 2                     |
| Monitor pair >120s ahead of header (s or ms)       | `ok=false`, `clock_skew=true`; exit 2                        |
| `getAllFeedRecords` FAULT "key does not exist"     | not missing-method; no per-pair fallback                     |
| Leftover `N3_FEED` / `FEED_MAGIC` mismatch         | fail closed; cannot silently retarget                        |
| Neo X vs mainnet N3 pusher state files             | distinct `PUSH_*` / `MISSING_STATE`; exec pin wins           |
| updater GAS above warn                             | `updater_gas_exhausted` in `ruled_out`                       |
| AWS CLI exact “Unable to locate credentials”       | `credentials_absent` after default **and** `morpheus` retry  |
| Default STS absent, documented `morpheus` ok       | `identity_ok` with `profile=morpheus`; no identity echo      |
| Explicit `AWS_PROFILE` set                         | documented profile is not substituted                        |
| AWS exact ExpiredToken / AccessDenied codes        | `credentials_expired_or_denied` (no stderr echo)             |
| Bare ENOENT + empty stderr; TLS/connection expired | `aws_unreachable` (not credential denial)                    |
| Mixed valid + undecodable registry rows            | `readable: false`; `undecodable`; decode counts; exit 2      |
| Monitor FAULT / empty / malformed / partial        | exit 2, `ok=false`; no NEO-USD fallback upgrade              |
| Pusher empty / malformed / partial HALT            | abort before plan/write; nonzero; not bootstrap              |
| Leftover `FEED_NETWORK` in EnvironmentFile         | ignored; ExecStart `/usr/bin/env` pin wins                   |
| Hash160 ByteString / Hash160 / hex LE              | canonical `0x` + 40 hex; unsupported throws                  |
| `FEED_CHAINS=none`                                 | pusher still exits 0                                         |
| enabled chain, no `TD_KEY`                         | pusher exits 1                                               |
| Testnet unit files                                 | distinct log/status/metrics paths vs mainnet                 |
| Retired-pair lists                                 | drift-checked against `DEFAULT_RETIRED_FEED_PAIRS`           |

## Implementation notes

- Shared network defaults live in `deploy/feed-pusher/lib-feed-network.mjs` so
  the pusher, monitor, topup, and audit cannot drift.
- `feed-monitor.mjs` / `feed-topup.mjs` resolve `lib-feed-network.mjs` from
  the script directory first, then `deploy/feed-pusher/` relative to cwd, so a
  live-box symlink or a root copy still starts **if** the library was installed
  atomically with the script.
- Testnet systemd templates (`morpheus-feed-*-testnet.{service,timer}`) are
  local files only. Copying them onto a host is an operator deploy; this
  checkout does not install them. Copy named unit files, never a glob of
  `*.service`.
