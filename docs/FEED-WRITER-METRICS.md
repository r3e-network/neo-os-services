# Feed-writer confirmation metrics

## Overview

The host writer already persists distinct confirmation states for both
`batch_update_feeds` (mainnet) and `per_pair_update_feed` (TestNet):
`submitted`, `pending`, `confirmed`, `skipped`, and `failed`, with
`pairs_faulted` retaining application-log `FAULT`. The independent freshness
monitor Prometheus textfile still exports only on-chain pair age and updater
GAS. This module adds a **separate, network-scoped writer metric surface**
derived from persisted pusher status plus the optional pending-batch sidecar.

The series answer: did this network’s last writer cycle plan a write, was that
write accepted, and did application-log `HALT` land — without exposing
transaction bytes, hashes, pair names, account values, or TwelveData keys.

Scraping these series is **not** alert delivery. `OnFailure=morpheus-alert@%n`
remains the unit-failure signal. This checkout does not configure Prometheus,
Alertmanager, or a webhook.

## Design decisions

1. **Persisted status is the source of truth.** Gauges are rebuilt from
   `PUSH_STATUS` and `${PUSH_STATUS}.pending-batch.json` on every status write
   and again after process start. In-memory last-cycle state is not required.
2. **Sidecar presence is a boolean.** An outstanding mainnet replay sidecar
   marks `outstanding_replay=1` and will not let a stale `confirmed`/`skipped`
   status hide an unconfirmed identity. The renderer never copies `rawTx`,
   `hash`, `messageHex`, or `nonce`.
3. **`skipped` is not pending.** `confirmation_status=skipped` means the cycle
   planned no writes (threshold skip and/or missing quotes). `submitted` /
   `pending` mean broadcast-accept without `HALT`. `fault` is
   `pairs_faulted > 0` even though the five-state field stays `failed`.
4. **Low cardinality only.** Labels are `network` (`mainnet`|`testnet`),
   `state` / `result` enums, and `mode` (`batch_update_feeds`|
   `per_pair_update_feed`). Pair ids, txids, and updater addresses are never
   labels and never values.
5. **Isolation matches existing pins.** `PUSH_PROM_TEXTFILE` is a reserved
   exec-time pin. Mainnet and Neo X pin it empty (enable with a drop-in).
   TestNet pins `/opt/morpheus/nitro/feed-pusher-testnet.prom`. Durable counters
   live at `${PUSH_STATUS}.metrics.json`, so they inherit network isolation
   from `PUSH_STATUS`.
6. **Health endpoints are unchanged.** Signer `/health` acceptance, monitor
   exit codes, and web `/api/health` semantics are not part of this surface.

## API Reference

### Metric names

All series are prefixed `neoos_feed_writer_`. Every series includes
`network="mainnet"` or `network="testnet"`.

| Name                                                 | Type    | Labels              | Meaning                                                                                                                       |
| ---------------------------------------------------- | ------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `neoos_feed_writer_last_attempt_timestamp_seconds`   | gauge   | `network`           | Unix seconds of the last persisted status `ts`                                                                                |
| `neoos_feed_writer_last_submitted_timestamp_seconds` | gauge   | `network`           | Unix seconds of the last persist that recorded broadcast accept (`submitted`/`pending`). Retained across later skipped cycles |
| `neoos_feed_writer_last_confirmed_timestamp_seconds` | gauge   | `network`           | Unix seconds of the last persist that recorded `HALT` (`confirmed`)                                                           |
| `neoos_feed_writer_last_submitted_height`            | gauge   | `network`           | `submitted_identity.validUntilBlock` from the last submitted persist. Not a txid                                              |
| `neoos_feed_writer_last_confirmed_height`            | gauge   | `network`           | `validUntilBlock` retained from the last confirmed persist                                                                    |
| `neoos_feed_writer_confirmation_state`               | gauge   | `network`, `state`  | One-hot `0`/`1`. `state` is `skipped` \| `submitted` \| `pending` \| `confirmed` \| `fault` \| `failed`                       |
| `neoos_feed_writer_pairs`                            | gauge   | `network`, `result` | Counts from `pairs_*`. `result` is `submitted` \| `pending` \| `confirmed` \| `skipped` \| `faulted` \| `failed`              |
| `neoos_feed_writer_source_pairs`                     | gauge   | `network`, `result` | Planning-phase counts: `skipped` (threshold) and `missing` (no quote). Not confirmation                                       |
| `neoos_feed_writer_confirmation_latency_seconds`     | gauge   | `network`           | `last_confirmed_unix - last_submitted_unix` for the last confirmed cycle. Omitted until both exist                            |
| `neoos_feed_writer_failed_cycles_total`              | counter | `network`           | Persisted count of cycles whose classified state is `failed` or `fault`. Not incremented for `pending`/`submitted`/`skipped`  |
| `neoos_feed_writer_outstanding_replay`               | gauge   | `network`           | `1` when the pending-batch sidecar file exists for this network                                                               |
| `neoos_feed_writer_write_mode`                       | gauge   | `network`, `mode`   | One-hot `batch_update_feeds` / `per_pair_update_feed`                                                                         |

### Confirmation-state mapping

| Persisted evidence                                                                          | `confirmation_state`                         |
| ------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `confirmation_status=skipped` (planned writes empty; `ok` true)                             | `skipped` — source-stale / no planned writes |
| `confirmation_status=submitted`                                                             | `submitted` — mempool accept, not `HALT`     |
| `confirmation_status=pending`, or sidecar present while status claims `confirmed`/`skipped` | `pending` — submitted but unconfirmed        |
| `confirmation_status=confirmed` and no sidecar                                              | `confirmed`                                  |
| `pairs_faulted.length > 0`                                                                  | `fault` — application-log `FAULT`            |
| `confirmation_status=failed` and no faulted pairs                                           | `failed` — rejection / unsubmitted / other   |
| Status has no `confirmation_status` (env error, Neo X)                                      | no one-hot bit set                           |

`skipped` must not be alerted as “tx stuck”. Use `submitted`/`pending` for
unconfirmed writes and `fault`/`failed` for terminal write failures.

### Files

| Path                                             | Role                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| `deploy/feed-pusher/lib-feed-writer-metrics.mjs` | Classify, persist, render Prometheus text                              |
| `${PUSH_STATUS}`                                 | Writer status JSON (unchanged schema)                                  |
| `${PUSH_STATUS}.pending-batch.json`              | Mainnet replay sidecar; metrics read existence / network only          |
| `${PUSH_STATUS}.metrics.json`                    | Durable timestamps + `failed_cycles_total` (no secrets)                |
| `$PUSH_PROM_TEXTFILE`                            | Prometheus textfile (atomic temp + rename). Empty pin = no scrape file |

### `advanceWriterMetrics({ status, previous, pendingReplay })`

Pure. Returns the snapshot rendered to Prometheus. `previous` is the last
`${PUSH_STATUS}.metrics.json` body so counters and last-confirmed times
survive a skipped cycle and a process restart.

### `renderFeedWriterPrometheus(snapshot)`

Prometheus text exposition. Omits non-finite timestamps. Never interpolates
pair names, hashes, raw transactions, or account values.

### `loadWriterMetricsFromDisk({ statusPath, sidecarPath, metricsPath })`

Restart path. Reads persisted files and returns the same snapshot a live
process would have written.

## Usage examples

```promql
# Stuck after broadcast (not source-stale)
neoos_feed_writer_confirmation_state{network="mainnet",state="pending"} == 1
or
neoos_feed_writer_confirmation_state{network="mainnet",state="submitted"} == 1

# Application-log FAULT (not a missing TwelveData quote)
neoos_feed_writer_confirmation_state{network="mainnet",state="fault"} == 1

# No planned writes this cycle (source-stale / threshold / missing quotes)
neoos_feed_writer_confirmation_state{network="mainnet",state="skipped"} == 1
and
neoos_feed_writer_source_pairs{network="mainnet",result="missing"} > 0

# Failed cycles since the metrics sidecar was created (rate, not a page)
rate(neoos_feed_writer_failed_cycles_total{network="testnet"}[1h])
```

Enable the mainnet textfile with a drop-in that changes the exec pin — do not
put `PUSH_PROM_TEXTFILE` in `feed-pusher.env`:

```
# /etc/systemd/system/morpheus-feed-pusher.service.d/20-prom.conf
[Service]
ExecStart=
ExecStart=/usr/bin/env FEED_NETWORK=mainnet FEED_CHAINS=neo-n3 PUSH_LOG=/opt/morpheus/nitro/feed-pusher.log PUSH_STATUS=/opt/morpheus/nitro/feed-pusher-status.json MISSING_STATE=/opt/morpheus/nitro/feed-pusher-missing.json PUSH_PROM_TEXTFILE=/opt/morpheus/nitro/feed-pusher.prom /usr/bin/node feed-pusher.mjs
```

TestNet already pins `/opt/morpheus/nitro/feed-pusher-testnet.prom`. Point
node_exporter’s textfile collector at those paths if you scrape them. This
document does not claim a scrape job or alert rule is installed.

## Test coverage

| Case                                 | Expected                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Batch confirmed                      | `state=confirmed`, pair `confirmed` count, latency from submitted→confirmed timestamps, no sidecar |
| Batch pending + sidecar              | `state=pending`, `outstanding_replay=1`, `failed_cycles_total` unchanged                           |
| Batch FAULT                          | `state=fault`, `pairs{result="faulted"}`, counter increments once                                  |
| Oneshot overlay after FAULT          | Same `ts` reused; `failed_cycles_total` stays at one                                               |
| Per-pair confirmed / pending / FAULT | Same classification with `mode=per_pair_update_feed`                                               |
| Skipped / missing quotes             | `state=skipped`, `source_pairs` missing/skipped, not `pending`/`fault`                             |
| Restart                              | Rebuild from status + sidecar + metrics sidecar equals the pre-restart exposition                  |
| Leak guard                           | Rendered text contains no pair id, txid, raw tx, TD key, or account value                          |

## Implementation notes

- `feed-pusher.mjs` `writePusherStatus` advances the metrics sidecar after
  every status persist, including mid-cycle `submitted` snapshots. The trailing
  oneshot overlay reuses that write `ts` so `failed_cycles_total` counts the
  write cycle once, not the overlay persist. A restore failure is logged and
  does not change the oneshot exit code.
- Process start rebuilds the textfile from disk when `PUSH_PROM_TEXTFILE` is
  set so a scrape after a oneshot exit still matches the last persist.
- Monitor `feed_age_seconds` / `feed_updater_gas` stay on
  `MONITOR_PROM_TEXTFILE`. Do not merge writer states into that file.
- Local implementation is not a live scrape. This checkout does not deploy,
  does not submit a chain transaction, and does not configure alert routing.
