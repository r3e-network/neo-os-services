# Morpheus Relayer — Environment Variables (new / robustness knobs)

These variables tune the relayer's fault-recovery and observability behavior. All
have backward-compatible defaults: an unset variable preserves the prior behavior,
so a live deployment is unchanged until the variable is set.

> The canonical full env reference lives in `docs/ENVIRONMENT.md` and
> `deploy/nitro/morpheus.env.example` (outside this package). The variables below
> were added with the 2026-06-14 robustness pass and should also be mirrored there.

## Operator introspection: `config:validate` / `config:dump`

The full env surface (~146 variables read through aliased fallback chains in
`src/config.js`) is described by a declarative manifest in `src/config-schema.js`.
Two read-only CLI subcommands introspect it — they never change runtime
resolution:

| Command                                                       | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run config:dump` (`node src/cli.js config:dump`)         | Prints the **resolved** configuration: for each logical setting it shows the value (secrets redacted to `«redacted» [set]`), which env **alias won**, and the precedence source (`env` vs `runtime_config_json` vs `default`).                                                                                                                                                                                                                                                              |
| `npm run config:validate` (`node src/cli.js config:validate`) | Builds the config, validates that conditionally-**required** settings are present (e.g. the Neo N3 oracle contract + updater signer when `neo_n3` is active and mode is not `feed_only` with derived keys off; the Neo X oracle + updater key when `neox` is active), and **warns** on `MORPHEUS_*`/`NITRO_*` variables that match no known alias (likely typos that `config.js` silently ignores), suggesting the closest alias. Emits JSON and exits non-zero when invalid (CI-gateable). |

Secrets (any var whose name contains `WIF`, `PRIVATE_KEY`, `SECRET`, `TOKEN`,
`SERVICE_ROLE_KEY`, `PASSWORD`, `SEED`, `MNEMONIC`, …) are shown only as set/unset
— their values are never printed. The schema's alias lists are kept truthful to
`config.js` by a drift-guard test (`src/config-introspect.test.mjs`).

## Alerting (F1)

| Variable                                      | Default                                                  | Purpose                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MORPHEUS_BETTERSTACK_RELAYER_DEADLETTER_URL` | falls back to `MORPHEUS_BETTERSTACK_RELAYER_FAILURE_URL` | Push-alert (BetterStack heartbeat) channel fired when a callback delivery is **permanently** dropped (dead-lettered). This is the single most important relayer incident; route it to a dedicated channel. When unset, the existing failure URL is used so configuring only the failure URL keeps single-channel behavior. |

## Retry queue ceiling (B10)

| Variable                             | Default          | Purpose                                                                                                                                                                                                                                                                    |
| ------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MORPHEUS_RELAYER_RETRY_QUEUE_LIMIT` | `0` (no ceiling) | Maximum in-memory retry-queue length per chain. When exceeded, the **oldest** retry items are shed into the dead-letter lane (recoverable via manual replay) and counted in `morpheus_relayer_retry_queue_overflow_total`. `0` keeps the queue unbounded (prior behavior). |

## Supabase transient backoff (B11)

| Variable                                                                         | Default | Purpose                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MORPHEUS_SUPABASE_TRANSIENT_BACKOFF_MS` (alias `SUPABASE_TRANSIENT_BACKOFF_MS`) | `30000` | Backoff window armed on a **non-quota** connectivity / 5xx / timeout Supabase outage, so the relayer stops paying the full Supabase request timeout on every operation during the outage. Quota (402) outages still use the longer `MORPHEUS_SUPABASE_BACKOFF_MS` (default 5min) window. |

## Neo X RPC read failover (B4)

| Variable                                                 | Default                                                     | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MORPHEUS_RELAYER_NEOX_RPC_URLS` (alias `NEOX_RPC_URLS`) | per-net public defaults appended after the primary `rpcUrl` | Comma-separated failover RPC list for Neo X **reads** (`getBlockNumber` / `totalRequests` / `getRequest`). A single dead RPC no longer kills the whole neox lane. The primary `MORPHEUS_RELAYER_NEOX_RPC_URL` is always tried first and stays pinned to the signer/submit path (failover never rotates the nonce-management URL mid-flight). A deterministic `CALL_EXCEPTION`/revert is never failed over (it is identical on every endpoint). |

## Prometheus counters seeded / added

- `morpheus_relayer_discovery_failures_total`, `morpheus_relayer_reconciliation_failures_total`,
  `morpheus_relayer_durable_claim_skipped_during_backoff_total` — now always exported (A5).
- `morpheus_relayer_retry_queue_overflow_total` — items shed by the retry-queue ceiling (B10).
- `morpheus_relayer_oldest_retry_age_seconds{chain}`, `morpheus_relayer_oldest_dead_letter_age_seconds{chain}`,
  `morpheus_relayer_last_fulfill_latency_ms` — queue-age / latency gauges (F2).
- `morpheus_relayer_failures_total{chain,module,operation}` — labeled failure counter (F5); flat totals retained.
- `morpheus_relayer_log_sink_dropped_total` — BetterStack log-sink drops (F7).
