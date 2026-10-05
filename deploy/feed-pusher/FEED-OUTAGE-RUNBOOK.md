# Price feed outage — restore runbook

> This document records recovery for the frozen Node compatibility writer.
> Production feed recovery must restore the Rust `neo-os-relayer`. Before any
> command below starts `morpheus-feed-pusher*` or `morpheus-feed-topup*`, stop
> both Rust relayer units and create the corresponding
> `/opt/morpheus/nitro/ENABLE_NODE_FEED_PUSHER_COMPAT` or
> `/opt/morpheus/nitro/ENABLE_NODE_FEE_TOPUP_COMPAT` marker. Remove the markers
> before returning authority to Rust. The systemd units enforce this mutual
> exclusion so Node and Rust cannot write chain state concurrently.

## Runway alerts, stale paging and the daily write budget (CU-11, 2026-10-05)

Written for the 2026-10-01 outage. The live mainnet writer made 752 transactions on 2026-09-30, 0.00606339
GAS each, about 4.56 GAS a day and four times the plan, while the monitor's only balance alert was a fixed floor
(12 GAS) that says nothing about days left. The updater ran dry on 2026-10-01 and the NEO-USD and GAS-USD
prices went dark. `feed-monitor.mjs` and `feed-pusher.mjs` now count days instead of balances and bound the
writes. Read "What this does not cover" below before relying on them: the live writer is not one of the
processes the budget binds.

### What the monitor alerts on

`morpheus-feed-monitor.service` runs every 15 minutes. Any alert fails the unit, and failing the unit is what
pages (`OnFailure=morpheus-alert@%n.service`, delivered to `ALERT_WEBHOOK_URL`). The level in the text says how
urgent it is; the notifier has no repeat suppression, so while an alert holds it posts again on every run.

| Problem text                                    | Level    | Condition                                                                                                                   | What to do                                                                                      |
| ----------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `RUNWAY WARNING Nd left`                        | warning  | runway of 14 days or less                                                                                                   | Plan the top-up this week (section 2.1).                                                        |
| `RUNWAY HIGH Nd left`                           | high     | runway of 7 days or less                                                                                                    | Fund the updater now.                                                                           |
| `RUNWAY CRITICAL Nd left`                       | critical | runway of 3 days or less                                                                                                    | Fund the updater immediately.                                                                   |
| `UPDATER CANNOT PAY A WRITE`                    | critical | balance below one write's fee (`FEED_WRITE_FEE_GAS`, 0.00606339 GAS by default); the feed cannot move                       | Fund the updater immediately.                                                                   |
| `FEED STALE <pair> age=Nmin`                    | critical | an active pair older than its limit (`MAX_AGE_SEC`, 2700 s by default, wider for TradFi while closed)                       | Find which writer stopped and why: check the balance, the provider report and the budget first. |
| `PROVIDER FAILURE unauthorized\|expired\|quota` | critical | the Node pusher reported, in its last cycle and within `MAX_AGE_SEC`, a rejected key, an expired plan or an exhausted quota | Renew the TwelveData plan or replace `TD_KEY` (billing and secrets: an operator step).          |
| `LOW GAS updater=N`                             | high     | balance below `MIN_GAS` (default 12 GAS), the old fixed floor; the condition is unchanged                                   | Fund the updater.                                                                               |
| `CLOCK SKEW <pair>`                             | critical | a pair more than 120 s ahead of chain time (exit 2, unchanged)                                                              | Unchanged: compare the writer host's clock with chain time.                                     |

Runway is the balance divided by the burn. The burn is the GAS the updater spent per day over the last 24
hours of the monitor's own balance samples, kept in `<MONITOR_STATUS>.balance-samples.json` beside the status
file (so a TestNet monitor and a mainnet monitor never mix them). A balance that rises between two samples is a
top-up, and that interval is left out. The estimate needs one hour of clean samples; until then
`runway_basis` is `insufficient_history` and only the other rows apply. A transient provider trouble (a
per-minute rate limit, a provider hiccup, an empty answer) is reported in `provider_failure` with
`"page": false` and does not page by itself: if it persists the feed goes stale and the stale row pages.

### Reading `feed-status.json`

`/opt/morpheus/nitro/feed-status.json` (TestNet: `feed-status-testnet.json`) keeps its earlier fields and gains:

| Field              | Meaning                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `alert_level`      | `ok`, `warning`, `high` or `critical`: the worst of the alerts above                                                               |
| `runway_days`      | days the balance pays for at the observed burn; `0` when the balance cannot pay one write; `null` when it cannot be estimated      |
| `runway_basis`     | `observed_burn`, `balance_below_write_fee`, `no_burn_observed` (balance not falling) or `insufficient_history`                     |
| `burn_gas_per_day` | GAS spent per day over the window, or `null`                                                                                       |
| `writes_per_day`   | `burn_gas_per_day` divided by `write_fee_gas` (an equivalent, only as good as the fee), or `null`                                  |
| `write_fee_gas`    | fee of one write used for the conversion and the cannot-pay rule (0.00606339, a two-pair write; `FEED_WRITE_FEE_GAS` overrides it) |
| `last_write_age`   | seconds since the freshest active pair was written, or `null`                                                                      |
| `stale_pairs`      | names of the active pairs past their limit                                                                                         |
| `provider_failure` | `null`, or `{ category, kind, page, reported_at, age_seconds, summary }` from the pusher's last cycle                              |
| `balance_samples`  | how many balance samples the estimate had                                                                                          |

An unreadable registry (exit 2) writes `alert_level: "critical"` with `unreadable_reason`.

### The daily write budget

`MAX_WRITES_PER_DAY` in `/opt/morpheus/nitro/feed-pusher.env` is the most transactions the Node pusher may
broadcast per UTC day on the Neo N3 lane. A mainnet Neo N3 pusher does not start without it (it exits 1 with
`missing_write_budget` before it fetches any price), and a value that is not a whole number from 1 to 9999999 is
refused (`invalid_write_budget`) rather than read as "no cap". TestNet may leave it unset.

- Every broadcast is counted first. The write past the cap is refused before anything is sent. The journal
  line and the status error both begin `daily write budget exhausted: N of N writes already made for UTC day D`
  and end with the time the budget restarts. The cycle fails, so the pusher unit pages until the day turns or
  the cap is raised; the signed batch stays in the pending-batch sidecar and is reconciled later.
- A broadcast the node refuses (an unfunded updater answers `Insufficient funds`) spent no GAS and gives its
  write back, so a stretch of refusals cannot use up the day. A lost connection or an "already exists" keeps the
  write counted, because the transaction may have landed.
- The count is `<PUSH_STATUS>.write-budget.json` (`/opt/morpheus/nitro/feed-pusher-status.json.write-budget.json`
  on mainnet): `{ "version": 1, "day": "2026-10-05", "writes": 123 }`. It restarts at 00:00:00Z, and a clock that
  moves back cannot give a day back. An unreadable or invalid file stops the writes (fail-closed) until the file
  is fixed or removed; removing it is a decision to forget today's count, so note it.
- To allow more writes the same day, raise `MAX_WRITES_PER_DAY` and run the unit again. Do not delete the file
  to get around the cap.

The cap counts writes, not GAS. GAS per day is at most the cap times the fee of one write, and the fee of a write
grows with the pairs it updates: 0.00606339 GAS for the two-pair writes the live writer made on 2026-09-30,
0.0501 GAS for a 28-pair batch on 2026-08-20 (0.02474 GAS per cycle on average, 7.12 GAS a day at 288 cycles).
Size the cap from the fee of your own `SYMBOLS` list, set `FEED_WRITE_FEE_GAS` (monitor) to that fee, and fund the
updater for cap x fee x the days of runway wanted.

| `MAX_WRITES_PER_DAY`                                    | GAS per day at 0.00606339 | GAS per day at 0.0501 |
| ------------------------------------------------------- | ------------------------- | --------------------- |
| 144 (a write every 10 minutes)                          | 0.873                     | 7.21                  |
| 288 (a write every 5 minutes, the timer)                | 1.746                     | 14.43                 |
| 360 (288 plus a quarter for re-broadcasts, the example) | 2.183                     | 18.04                 |
| 576                                                     | 3.493                     | 28.86                 |
| 752 (what the live writer did on 09-30)                 | 4.560                     | 37.68                 |

Multiply by 30 for a month: a cap of 360 at 0.00606339 GAS is 65.5 GAS, and at 0.0501 GAS it is 541 GAS.

### Proving the alert path

A never-fired alert path is worth nothing (section 3). To fire the monitor on purpose without touching the feed,
make the fee per write larger than the balance for one run, then remove the drop-in:

```bash
mkdir -p /etc/systemd/system/morpheus-feed-monitor.service.d
printf '[Service]\nEnvironment=FEED_WRITE_FEE_GAS=1000000\n' \
  > /etc/systemd/system/morpheus-feed-monitor.service.d/90-drill.conf
systemctl daemon-reload
systemctl start morpheus-feed-monitor.service       # expect exit 1: UPDATER CANNOT PAY A WRITE
journalctl -u 'morpheus-alert@*' -n 20 --no-pager   # expect the alert line and the webhook result
rm /etc/systemd/system/morpheus-feed-monitor.service.d/90-drill.conf && systemctl daemon-reload
systemctl start morpheus-feed-monitor.service       # back to the real balance
```

### What this does not cover

1. **The live writer.** The budget lives in the tracked Node pusher. `morpheus-public-feed-writer.service` runs
   `workers/nitro-worker/.neoos-live-feed-write.mjs`, a script that is in no repository, every 60 seconds
   (`morpheus-public-feed-writer.timer`), and it does not read `feed-pusher.env`. The budget does not bind it,
   and nothing else in this repository does: its cadence is that timer plus thresholds inside a script this
   repository cannot see, so capping it is the owner's step (OP-02). The monitor's runway alert is the backstop,
   because it measures what the updater actually spends, whichever process spends it.
2. **The Rust writers.** The relayer's feed lane and the `/feed/sign` price plane have no budget and do not
   classify provider errors (an expired key there reads as "nothing to update"). Their equivalents ride the
   enclave rebuild window (CU-90).
3. **Neo X.** The Neo X lane of the pusher is not budgeted (it is de-scoped).
4. **Provider failure.** It is read from the Node pusher's status file beside the monitor's status
   (`feed-pusher-status.json`, TestNet `feed-pusher-testnet-status.json`). With another writer, only the stale
   and runway rows can page.
5. **The estimate.** It needs an hour of samples, and a 24-hour average lags a sudden burst of writes; the
   3-day level and the stale row are the backstops.
6. **Delivery.** Nothing reaches a person until `ALERT_WEBHOOK_URL` is set in `alert-notify.env` (OP-02).

**Recheck 2026-08-31T21:06Z (read-only SSM + public RPC). No writes, no
restart, no secret print, no chain tx.**

**Mainnet `0x03013f49…` — TwelveData subscription expired, not a dead host.**
Readable `getAllFeedRecords` HALT, 36/36 stale, **active_stale=32/32**,
newest `NEO-USD` still 2026-08-29T09:39:01Z. ABI has `updateFeeds` and
`updateFeed`. Updater `0x9fb28bda…` holds **40.892 GAS**. Class: **live
writer cycling with no usable upstream quotes**.

Documented writer `i-0c52851f134db20ee` (`AWS_PROFILE=morpheus`): running
`m6i.xlarge`, Nitro enclaves enabled, system/instance reachability **ok**,
SSM **Online**, last boot 2026-06-02 (matches `LaunchTime`).
`morpheus-feed-pusher.timer` is **enabled/active** and last fired this
minute. Enclave `morpheus-oracle-exec-10` is **RUNNING**; `127.0.0.1:8787/health`
returns `ready` + `signer:true`. Last successful N3 write on the box log:
`2026-08-29T09:39:08Z` `(enclave) pushed 4 pairs … txid 0x86618971…`. Next
N3 cycle `09:44:12Z` logged `no updates (skipped 0, missing 32)` and has
done so every cycle since. A redacted TwelveData `quote` probe with the
box `TD_KEY` returned **HTTP 401** `status=error` message class
`Your subscription has expired, please, pay last invoice…`. The Aug-20
box `td()` has no `assertTwelveDataResponse`, so a 401 JSON is treated as
every symbol missing and the oneshot **exits 0** (`OnFailure=` never
fires). Do **not** restart the instance, timer, or enclave — they are
healthy. Minimum remaining action: renew the TwelveData subscription (or
install a paid `TD_KEY`) and wait for the next 5-minute timer, or
`systemctl start morpheus-feed-pusher.service` after billing works. This
checkout must not pay the invoice, rotate the key, or deploy.

**Testnet `0x9bea75cf…` — writer exists in this checkout, not on the host.**
Readable, **active_stale=34/34** (retired_stale=2: FLM, COPPER), newest
`NEO-USD` still 2026-08-22T22:00:07Z (**214.3 h**). ABI has `updateFeed`
and **not** `updateFeeds`. Updater `0xe421999c…` holds **9026.448 GAS**.
Default `FEED_NETWORK` is still mainnet. This checkout now has a fail-closed
testnet-only per-pair `updateFeed` writer (enclave `/feed/sign`, no host-key
path). **Local implementation does not make TestNet healthy** until an
operator deploys the files onto a funded signer/writer host **and** a
**separate** TestNet-pinned EIF / isolated enclave. Do not rebuild or
retarget the live mainnet EIF, and do not enable both write paths in one
enclave. See [`../../docs/TESTNET-FEED-WRITER.md`](../../docs/TESTNET-FEED-WRITER.md).
Do not close this incident from timestamps that are still stale.

**Hetzner Fura/MCP `95.216.148.60` (`ubuntu-32gb-hel1-1`) is not the feed
host.** Read-only SSH: every `morpheus-feed-*` unit/timer is `not-found`,
journals empty, and `/opt/neoos/services/deploy/feed-pusher`,
`/opt/morpheus/neo-morpheus-oracle/deploy/feed-pusher`, and
`/opt/morpheus/nitro` are absent. Do not treat that box as a substitute
for `i-0c52851f134db20ee`. Canonical install path remains
`/opt/neoos/services/deploy/feed-pusher`.

`--skip-aws` still skips the box. The default AWS chain on this laptop has
no credentials; documented profile `morpheus` does. The health audit now
retries that profile when `AWS_PROFILE` is unset. Re-run
`npm run audit:feeds:health -- --network mainnet` after TwelveData billing
works; close the incident only when active pairs are inside the 6-hour SLO.

### Least-risk mainnet recovery (operator — do not run from this checkout)

Do **not** reboot `i-0c52851f134db20ee`, restart `morpheus-nitro-signer`,
or `systemctl enable` timers that are already enabled. Those are healthy.

1. Renew the TwelveData Grow subscription (pay the last invoice) **or**
   replace `TD_KEY` in `/opt/morpheus/nitro/feed-pusher.env` (chmod 600)
   with a paid key. Paying the invoice is a financial action; rotating
   the key is a secret write. This checkout must do neither.
2. After billing or the new key is in place, force one N3 cycle (or wait
   ≤5 minutes for `morpheus-feed-pusher.timer`):

   ```bash
   systemctl start morpheus-feed-pusher.service
   journalctl -u morpheus-feed-pusher -n 50 --no-pager
   ```

   Expect `(enclave) batch updateFeeds … confirmed` and a txid only after
   application-log `HALT`. Mempool `sendrawtransaction` accept is
   `submitted`/`pending` and the oneshot exits `1` until confirmed. A
   transport-ambiguous batch is retained at
   `/opt/morpheus/nitro/feed-pusher-status.json.pending-batch.json` and the
   next oneshot must reconcile/replay that exact raw transaction; do not delete
   the sidecar or force another writer while it is unexpired. A
   repeat of `no updates (skipped 0, missing 32)` means TwelveData still
   returns no prices (401/empty). This checkout's HALT-closed batch path
   is local until deployed; live recovery still needs a valid TwelveData
   subscription/key. Do not restart the enclave for a quote outage.

3. Prove recovery with all three checks in §2.4 (on-chain `getLatest`,
   `systemctl start morpheus-feed-monitor.service`, public
   `/api/feeds/status`). Also
   `npm run audit:feeds:health -- --network mainnet` must exit 0.

**Rollback:** if the only change was paying the invoice, there is nothing
to roll back on the box. If `TD_KEY` was rotated, restore
`/opt/morpheus/nitro/feed-pusher.env.bak.20260820-registry` (or the
newest `feed-pusher.env.bak.*`) and rerun step 2. Do not roll back the
enclave EIF or unit files for this incident.

**Do not automate next:** invoice payment and key rotation are
human/billing steps. After TwelveData answers again, the existing
5-minute timer self-heals. Automating `systemctl restart
morpheus-nitro-signer` or an instance reboot would add risk without
restoring quotes. Deploying the checkout's `assertTwelveDataResponse`
(401 → exit 1 → `OnFailure=`) is a later, separate change so a repeat
expiry pages instead of exiting 0.

---

**RESOLVED 2026-08-20T13:12:31Z after 22.5 days. Kept as the incident record and
the procedure for the next time.** What actually happened, verified on the box
and on chain, is in §0. Everything below §0 is the original 2026-08-17 writeup;
where it disagrees with §0, §0 wins.

---

## 0. Resolution and the real causal chain

The feed came back **4 minutes after the updater was funded**, on the pusher's own
5-minute timer, with no operator intervention. There was no second fault.

| Time (UTC, 2026-08-20) | Event                                                                             |
| ---------------------- | --------------------------------------------------------------------------------- |
| 13:07:25               | pusher cycle: `sendrawtransaction: {"code":-511,"message":"Insufficient funds"}`  |
| 13:08:31               | owner funds `NN8tbpgAx8zm5BNJZEqvi71Rj2Z8LX2RHh` with 100 GAS (block 12532641)    |
| 13:12:37               | pusher cycle: `(enclave) pushed 28 pairs (skipped 1, missing 0), fee 0.05010 GAS` |
| 13:24:01               | `feed-monitor` returns to `ok feed_age=6min gas=99.9`                             |

A read between 13:08:31 and 13:12:31 shows a funded wallet and a still-stale
feed. That gap is the timer interval, not a fault — check the pusher journal
before concluding anything from it.

**The causal chain is one level deeper than "the updater ran out of GAS":**

1. The dedicated topup key `NZFMvLj6mxTHEn8gRGrjZDeFCDMTm96p6R` holds
   **19.997 GAS** and has not moved since block 11024483.
2. `TOPUP_AMOUNT` is 40, so `feed-topup.mjs` cannot transfer and instead alerts
   `updater LOW 0.0 AND funding key LOW 20.0 — REFILL funding key NZFMvLj6…`
   and exits 1. `morpheus-feed-topup.service` has been in the **failed** state
   ever since. The auto-topup has therefore never successfully topped up.
3. The updater drained on 2026-07-29 and stayed empty.
4. `morpheus-feed-monitor` **did** detect it, every 15 minutes for 22 days:
   `ALERT: FEED STALE NEO-USD age=32416min | LOW GAS updater=0.0`, exit 1.
5. Nothing was subscribed to that exit code. Confirmed on the box:
   `grep -l OnFailure /etc/systemd/system/*.service` returned nothing.

So the outage was detected continuously and reported to no one. **Funding the
updater buys ~25 days and does not fix this** — without step 1 the same outage
recurs.

### Box layout — read before copying any unit file

Repo units use `WorkingDirectory=/opt/neoos/services/deploy/feed-pusher`.
Install `feed-pusher.mjs`, `feed-monitor.mjs`, `feed-topup.mjs`, `db-prune.mjs`,
`lib-feed-network.mjs`, **and** `lib-feed-writer-metrics.mjs` into that
directory in one step. Do not copy a single script.

Historical (2026-08-20): `i-0c52851f134db20ee` had its checkout only at
`/opt/morpheus/neo-morpheus-oracle`, with scripts at that root. If a host still
looks like that, do **not** edit `WorkingDirectory=` in the unit. Install a
drop-in that points at the directory where the scripts **and** library were
atomically installed, for example:

```
# /etc/systemd/system/morpheus-feed-pusher.service.d/10-workingdirectory.conf
[Service]
WorkingDirectory=/opt/morpheus/neo-morpheus-oracle/deploy/feed-pusher
```

Or migrate the checkout to `/opt/neoos/services` (`npm run install:code-path-compat`)
so the shipped units work without a drop-in.

### Alert path — installed 2026-08-20, drill-verified

Installed with drop-ins rather than by replacing the units, precisely because of
the path mismatch above:

```bash
BOX=/opt/morpheus/neo-morpheus-oracle
install -D deploy/systemd/alert-notify.mjs $BOX/deploy/systemd/alert-notify.mjs
# morpheus-alert@.service with WorkingDirectory=$BOX/deploy/systemd
for u in morpheus-feed-pusher morpheus-feed-monitor morpheus-feed-topup; do
  mkdir -p /etc/systemd/system/$u.service.d
  printf '[Unit]\nOnFailure=morpheus-alert@%%n.service\n' \
    > /etc/systemd/system/$u.service.d/10-onfailure.conf
done
printf '[Service]\nEnvironmentFile=-/opt/morpheus/nitro/feed-pusher.env\n' \
  > /etc/systemd/system/morpheus-feed-monitor.service.d/20-envfile.conf
systemctl daemon-reload
```

Drill (2026-08-20T13:38:15Z), forcing a real monitor failure with a temporary
`MAX_AGE_SEC=1` drop-in that was removed afterwards:

```
morpheus-feed-monitor.service          Result=exit-code ExecMainStatus=1
morpheus-alert@morpheus-feed-monitor…  Result=exit-code ExecMainStatus=78 failed
node[…]: ALERT "[NeoOS oracle] morpheus-feed-monitor.service FAILED: FEED STALE NEO-USD age=5min"
node[…]: ALERT_WEBHOOK_URL is not set — no alert was delivered off-box.
```

The chain works. **It still does not page anybody**: `ALERT_WEBHOOK_URL` in
`/opt/morpheus/nitro/alert-notify.env` is unset, which is why the notifier exits
78 and shows up in `systemctl --failed`. Supplying that URL is the one remaining
step, and it needs a human with the alerting endpoint.

### Still-open items this incident exposed

- ~~**Refill the topup key `NZFMvLj6mxTHEn8gRGrjZDeFCDMTm96p6R`**~~ **Done
  2026-08-20** — funded to 60 GAS, `morpheus-feed-topup.service` reset and no
  longer failed. The transfer branch had never once executed in the service's
  life, so it was exercised deliberately with a temporary drop-in
  (`TOPUP_THRESHOLD=150`, `TOPUP_AMOUNT=1`): txid
  `0x58c2c2b294fc031e3351d378cc182b05936888b77f512814715b0d1df69812ea`,
  updater 99.49063235 -> 100.49063235, funding key 59.99746251 -> 58.99492582.
  Drop-in removed; defaults (25/40) restored and re-verified.

  **The refill loop delays the outage class, it does not close it.** Measured
  burn is 0.02474 GAS/cycle x 288 cycles/day = **7.12 GAS/day** (re-measured
  independently on 2026-08-20 from 36 on-chain fee burns over a 3.07 h window:
  0.02548 GAS/cycle = **7.17 GAS/day** — same number). The funding key
  holds 59 GAS = exactly **one** 40-GAS topup, because the script refuses to
  transfer unless the key holds `TOPUP_AMOUNT + 1` = 41. Timeline from
  2026-08-20: updater crosses the 25-GAS threshold at ~day 10.6 and gets its one
  topup (-> 65 GAS); crosses again at ~day 16.2 with the key down to 19 GAS,
  which reproduces the exact 2026-07-29 failure; feed dies ~day 19.7
  (**~2026-09-09**). To actually close it the funding key must hold several
  multiples of `TOPUP_AMOUNT`, or be auto-refilled from treasury — and
  `ALERT_WEBHOOK_URL` must be set, or the "funding key LOW" alert again reaches
  nobody.

- **Set `ALERT_WEBHOOK_URL`.** Without it every alert stops at the journal.
- ~~**The box runs a 92-line `feed-monitor.mjs`; this repo ships a 221-line one.**~~
  **Synced 2026-08-20.** Root cause: top-level `feed-pusher.mjs` is a _symlink_
  into `deploy/feed-pusher/`, but `feed-monitor.mjs` was a plain _copy_ taken
  2026-06-11 and never refreshed when the source was updated 2026-06-14 — so
  `ExecStart=/usr/bin/node feed-monitor.mjs` silently resolved to a two-month-old
  file. Fixed by making it a symlink too, matching the pattern the box already
  used for the pusher, so future updates propagate and this cannot recur:

  Historical repair on that box (do not treat this as the current install):

  ```bash
  cd /opt/morpheus/neo-morpheus-oracle
  cp -a feed-monitor.mjs /opt/morpheus/nitro/feed-monitor.mjs.bak-$(date -u +%Y%m%dT%H%M%SZ)
  ln -sfn /opt/morpheus/neo-morpheus-oracle/deploy/feed-pusher/feed-monitor.mjs feed-monitor.mjs
  ln -sfn /opt/morpheus/neo-morpheus-oracle/deploy/feed-pusher/lib-feed-network.mjs lib-feed-network.mjs
  ```

  Current install: atomically place the scripts, `lib-feed-network.mjs`,
  and `lib-feed-writer-metrics.mjs`
  in the unit `WorkingDirectory=/opt/neoos/services/deploy/feed-pusher`, or
  keep the legacy checkout and add a `WorkingDirectory=` drop-in that points
  at `…/deploy/feed-pusher` after the same atomic copy. Do not copy
  `feed-monitor.mjs` alone.

  Detection was then proven against live data with a temporary
  `MAX_AGE_SEC` drop-in: at `MAX_AGE_SEC=1` all **36/36** pairs were flagged
  (NEO-USD included); with defaults, 8. Drop-in removed.

- **The dead-pair set is bigger than CORN, and predates the deviation guard.**
  The synced monitor reads the full on-chain registry: **36 pairs, 28 fresh
  (<=28 min), 8 dead.** The dead ones are `BRENT-USD`, `NATGAS-USD`,
  `COPPER-USD`, `WHEAT-USD`, `CORN-USD`, `SOY-USD` — all stale ~108,620 min
  (**~75 days**, i.e. they died together around 2026-06-07) — plus two zombie
  denomination variants nobody had noticed, `1000FLM-USD` and `1000JPY-USD`,
  stale ~233,330 min (**~162 days**), whose plain `FLM-USD` / `JPY-USD`
  counterparts are live and fresh. So CORN was already dead 75 days before the
  deviation rejection below; the rejection is why it cannot _recover_, not why
  it stopped.
- **`CORN-USD` is permanently rejected by the deviation guard:**
  `rejected CORN-USD deviation_spike: src=18.73 on-chain=417.41831`. TwelveData's
  `CORN` now returns ~18.73 (the ETF) against an on-chain futures price of
  ~417 (cents/bushel). The guard is right to refuse; the symbol mapping is what
  is wrong. Re-point it or deregister the pair — do not raise
  `MAX_DEVIATION_BPS`, which would let a 22x mispriced quote onto the feed.
- **`/api/feeds/status` will report `degraded` forever** until the five pairs the
  web app advertises but the pusher never writes (BRENT, NATGAS, COPPER, WHEAT,
  SOY) plus CORN are resolved, and `FLM-USD` — pushed on chain but absent from
  the web list — is added. A permanently red health signal is the same class of
  defect as the one that caused this outage.

  Note that as of the monitor sync this now also applies to
  `morpheus-feed-monitor.service` itself, which exits 1 every 15 minutes on the
  8 dead pairs. That is _truthful_ — the previous 92-line monitor reported
  `"ok": true, "problems": []` while those 8 pairs had been dead for 75-162 days
  — but a permanently-red monitor cannot signal a _new_ failure. Retiring or
  re-pointing the 8 pairs is what returns it to green; that decision belongs
  with the pair-registry reconciliation above, not with the monitor.

- **The Neo X lane is silently down and is not covered by any of the above.**
  `morpheus-feed-pusher-neox.service` fails every single cycle with
  `INSUFFICIENT_FUNDS` (balance 0.00234 vs ~0.0189 required per tx), yet the
  script catches its own error, logs `push error (recovers next cycle)` and
  exits 0 — 672 "Deactivated successfully" and 0 failures in 24h. `OnFailure=`
  therefore never fires and it never appears in `systemctl --failed`. This is
  the same defect class as the 22-day N3 outage, currently live, on a second
  chain, and the monitor does not watch Neo X.

---

## Original writeup (2026-08-17)

**Status when this was written: 2026-08-17, feed DEAD for 19.1 days.**

Everything in this document was verified against mainnet on 2026-08-17 with
read-only `invokefunction` calls. No transaction was broadcast and no wallet was
funded — **funding the updater is a financial action and is the operator's to
perform, not an agent's.**

---

## 1. What is broken

Read-only reproduction (safe to re-run at any time):

```bash
# Freshest record for one pair
curl -s -X POST https://api.n3index.dev/mainnet \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"invokefunction","params":[
        "0x03013f49c42a14546c8bbe58f9d434c3517fccab","getLatest",
        [{"type":"String","value":"TWELVEDATA:BTC-USD"}]]}'

# Updater GAS balance (integer, 1e8 = 1 GAS)
curl -s -X POST https://api.n3index.dev/mainnet \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"invokefunction","params":[
        "0xd2a4cff31913016155e38e474a2c06d08be276cf","balanceOf",
        [{"type":"Hash160","value":"0x9fb28bdacfaa7fcc0a4d660d0dc990b0e7d46118"}]]}'
```

Observed 2026-08-17T03:49:28Z:

| Fact                                          | Value                               |
| --------------------------------------------- | ----------------------------------- |
| `getLatest("TWELVEDATA:BTC-USD")` timestamp   | `1785285991` = 2026-07-29T00:46:31Z |
| Age                                           | 1 652 577 s = **19.13 days**        |
| Staleness budget (`MAX_STALE_SEC` 1800 + 900) | 2 700 s → **612x over**             |
| Updater GAS balance                           | `82813` = **0.00082813 GAS**        |
| Pairs on chain (`getAllFeedRecords`)          | 36, **every one stale**             |

The age is not uniform, which matters for triage — three distinct death dates:

| Age      | Pairs                                                                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~19.1 d  | 28 pairs (NEO, GAS, FLM, BTC, ETH, SOL, TRX, PAXG, WTI, USDT, USDC, BNB, XRP, DOGE, EUR, GBP, CNY, JPY, AAPL, GOOGL, MSFT, AMZN, TSLA, META, NVDA, SPY, QQQ, GLD) |
| ~72.0 d  | BRENT-USD, NATGAS-USD, COPPER-USD, WHEAT-USD, CORN-USD, SOY-USD                                                                                                   |
| ~158.6 d | 1000FLM-USD, 1000JPY-USD                                                                                                                                          |

The 72-day and 158-day groups are **not** explained by the GAS exhaustion and
are a separate question — those pairs are registered on chain but are not in the
pusher's `SYMBOLS` list in `feed-pusher.env.example`, so nothing has been writing
them for months. Decide whether to push them or deregister them; do not assume
funding the wallet revives them.

**Root cause of the 19-day group:** the updater account
`NN8tbpgAx8zm5BNJZEqvi71Rj2Z8LX2RHh` (`0x9fb28bdacfaa7fcc0a4d660d0dc990b0e7d46118`)
ran out of GAS. It burns roughly 4 GAS/day (RUNBOOK.md), and its last GAS movement
matches the freshest feed record. `UpdateFeeds` needs the updater's witness, so a
zero-balance updater cannot broadcast.

---

## 2. Restore the feed — operator actions

These steps move funds. **Do them yourself.**

### 2.1 Fund the updater

- **Wallet to fund:** `NN8tbpgAx8zm5BNJZEqvi71Rj2Z8LX2RHh`
  (script hash `0x9fb28bdacfaa7fcc0a4d660d0dc990b0e7d46118`) — Neo N3 **mainnet**.
- **Asset:** GAS (`0xd2a4cff31913016155e38e474a2c06d08be276cf`). NEO is not needed.
- **How much:** burn rate is ~4 GAS/day; the monitor warns below `MIN_GAS` = 12
  and the auto-topup tops up at `TOPUP_THRESHOLD` = 25 to `TOPUP_AMOUNT` = 40.
  **40–60 GAS** gives 10–15 days of runway and lands above both thresholds.
  Do not send hundreds: this key lives on a single box.
- **From where:** the deployer account is the contract admin and has historically
  been the refund source. Preferably fund the dedicated low-value topup key
  instead and let `morpheus-feed-topup.timer` do the transfer — see 2.2.

### 2.2 Historical compatibility auto-topup

`morpheus-feed-topup.timer` is a Node compatibility chain writer and is
deliberately non-installable. Do not enable it on a Rust production host. For a
time-bounded compatibility rollback only, stop the Rust relayer, create the
marker, and start it manually:

```bash
systemctl stop morpheus-relayer.service morpheus-relayer-nitro.service
install -m 0600 /dev/null /opt/morpheus/nitro/ENABLE_NODE_FEE_TOPUP_COMPAT
systemctl start morpheus-feed-topup.timer
```

It reads `CUSTODY_URL`, `CUSTODY_TOKEN`, and `FUNDER_KEY_ID` from
`/opt/morpheus/nitro/feed-topup.env` (chmod 600, generated on the box, never
committed) and signs the GAS transfer through the custody signer service with
the fee_funder key — the box holds no funder WIF. The funder key's custody
policy must allow the GAS transfer to the updater address. If that file or
those keys do not exist, the auto-topup has never worked and the wallet has
only ever been refilled by hand.

### 2.3 Force one push and confirm

```bash
systemctl start morpheus-feed-pusher.service
journalctl -u morpheus-feed-pusher -n 50 --no-pager
```

### 2.4 Verify recovery — three independent checks

All three must pass. Do not close the incident on one.

1. **On chain** — re-run the `getLatest` curl from §1. The timestamp must be
   within 2 700 s of now:

   ```bash
   node -e 'const t=Number(process.argv[1]);const a=Math.floor(Date.now()/1000)-t;
   console.log("age_s",a,a<=2700?"FRESH":"STILL STALE")' <timestamp-from-curl>
   ```

2. **Box monitor** — it must exit 0 and write a clean snapshot:

   ```bash
   systemctl start morpheus-feed-monitor.service
   systemctl is-failed morpheus-feed-monitor.service   # expect: inactive
   cat /opt/morpheus/nitro/feed-status.json            # expect: "ok": true, empty problems[]
   ```

3. **Served API** — the public route must say `ok`, not `stale`:

   ```bash
   curl -si 'https://<web-host>/api/feeds/TWELVEDATA:BTC-USD' | head -20
   ```

   Expect `"status":"ok"`, `x-morpheus-feed-stale: 0`, and a small
   `age_seconds`. A `"status":"stale"` body with `x-morpheus-feed-stale: 1`
   means the chain is still behind — the API is now reporting truthfully, which
   is the point of the 2026-08 change.

   Operator overview: `GET /api/feeds/status` → `status` must be `ok`,
   `stale_configured_pair_count` must be `0`, `alerts` must be empty. The
   page at `/docs/feed-status` renders the same data with an **Age** column.

---

## 3. Why nobody noticed for 19 days, and what changed

Three independent blind spots, all now closed in code:

| Blind spot                       | Was                                                                                                                                                                       | Now                                                                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Serving path had no age check    | `app/api/feeds/[symbol]/route.ts` rejected only a missing or non-positive record; a 19-day price returned HTTP 200 `status:"ok"` with `cache-control: public, max-age=15` | Age compared to the budget; stale returns `status:"stale"`, `no-store`, `x-morpheus-feed-stale: 1`, and **no top-level `price`** so a consumer cannot read a stale quote by accident                                        |
| Status page could not see it     | `lib/feeds-status.ts` defined `synced` as "a record exists at any age" (reported 33/33) and hardcoded `delta_pct: 0`                                                      | Per-pair `age_seconds` / `stale` / `status`; new `fresh_*` and `stale_*` counts, `max_age_seconds`, `oldest_pair`, `alerts[]`; `delta_pct` is now `null` with `delta_basis: "no_reference_quote"` instead of a fabricated 0 |
| Monitor's exit code went nowhere | zero `OnFailure=` in any unit file; `RUNBOOK.md` named a human running `systemctl is-failed` as the detection mechanism                                                   | `OnFailure=morpheus-alert@%n.service` on the pusher, monitor and topup units, delivering to `ALERT_WEBHOOK_URL`                                                                                                             |

The staleness budget is defined once, in `apps/web/lib/feed-freshness.ts`, and
`apps/web/__tests__/feed-freshness.test.ts` asserts it against
`feed-monitor.mjs`'s own `staleAgeLimit()` so the API and the box monitor cannot
drift apart again.

### Finish wiring the alert path

The code is in place but the endpoint is per-deployment. On the box:

```bash
install -m 600 /dev/null /opt/morpheus/nitro/alert-notify.env
# populate ALERT_WEBHOOK_URL (see deploy/systemd/alert-notify.env.example)
cp deploy/systemd/morpheus-alert@.service /etc/systemd/system/
cp deploy/systemd/alert-notify.mjs /opt/neoos/services/deploy/systemd/
# Units require WorkingDirectory=/opt/neoos/services/deploy/feed-pusher.
# Atomically install scripts + lib-feed-network.mjs + lib-feed-writer-metrics.mjs there (or add a drop-in).
install -d /opt/neoos/services/deploy/feed-pusher
cp deploy/feed-pusher/feed-pusher.mjs \
   deploy/feed-pusher/feed-monitor.mjs \
   deploy/feed-pusher/feed-topup.mjs \
   deploy/feed-pusher/db-prune.mjs \
   deploy/feed-pusher/lib-feed-network.mjs \
   deploy/feed-pusher/lib-feed-writer-metrics.mjs \
   /opt/neoos/services/deploy/feed-pusher/
# Named unit files only.
cp deploy/feed-pusher/morpheus-feed-monitor.service /etc/systemd/system/
cp deploy/feed-pusher/morpheus-feed-pusher.service /etc/systemd/system/
cp deploy/feed-pusher/morpheus-feed-pusher-neox.service /etc/systemd/system/
cp deploy/feed-pusher/morpheus-feed-topup.service /etc/systemd/system/
# Testnet (optional): also copy the -testnet units; they use distinct log/status paths.
systemctl daemon-reload
```

Prove it end to end before trusting it — a never-fired alert path is worth
nothing:

```bash
systemctl start morpheus-alert@morpheus-feed-monitor.service
journalctl -u 'morpheus-alert@*' -n 20 --no-pager
```

With no webhook configured the notifier still journals the alert line and exits
**78** (`EX_CONFIG`), so `systemctl --failed` shows the alert path itself as
broken rather than silently discarding alerts.

`MONITOR_PROM_TEXTFILE` and `PUSH_PROM_TEXTFILE` are reserved exec-time pins.
A leftover value in `/opt/morpheus/nitro/feed-pusher.env` cannot retarget the
mainnet or testnet textfile path. Monitor series remain pair age and updater
GAS. Writer confirmation states (`neoos_feed_writer_*`) are a separate
surface — see `docs/FEED-WRITER-METRICS.md`. `skipped` is no planned writes;
`submitted`/`pending` are unconfirmed; `fault` is application-log FAULT.
Those series do not configure alert delivery. To scrape mainnet monitor or
writer textfiles, add a systemd drop-in that changes the matching
`ExecStart=/usr/bin/env …` pin — do not put those keys in the env file.
`TRADFI_*` / `MAX_AGE_SEC` still come from
`EnvironmentFile=-/opt/morpheus/nitro/feed-pusher.env`.

---

## 4. Still open — needs a decision, not a fix

- **The 72-day and 158-day pairs** (§1). Registered on chain, not in `SYMBOLS`.
  Push them or deregister them.
- **Is this oracle a live product?** Mainnet `getTotalRequests` is 7, all
  developer smoke tests from 2026-06-06. If the answer is "paused experiment",
  the correct action may be to retire the feed rather than fund it indefinitely.
- **Single-box SPOF.** One enclave signer, one updater key, one timer host.

## Independent verification — 2026-08-20 16:12–16:20 UTC

Re-checked from outside the box, against mainnet RPC and the public edge, after
the pair-registry reconciliation landed. Every number below was read fresh, not
copied from an earlier pass.

**Feed is live.** `MorpheusDataFeed 0x03013f49c42a14546c8bbe58f9d434c3517fccab`,
all 32 advertised pairs read directly over public RPC: **27 fresh, 5 stale, 0
absent**; oldest fresh pair 1740 s against a 2700 s budget; `NEO-USD` 50 s.
`morpheus-feed-pusher.service` ran at 15:51:03, 15:56:11, 16:01:21, 16:06:31 and
16:11:41 UTC — an unbroken 5-minute cadence — with **0 failed starts in 24 h**.
The feed did not go down at any point during this work.

**No agent moved funds.** `getnep17transfers` on both keys: the updater
`NN8tbpgAx8zm5BNJZEqvi71Rj2Z8LX2RHh` has **0** outbound transfers to any address
(36 entries, all network-fee burns), and the funding key
`NZFMvLj6mxTHEn8gRGrjZDeFCDMTm96p6R` has exactly **one** outbound transfer ever —
the 1.0 GAS the topup _service_ sent itself during the drill
(`0x58c2c2…9812ea`, 15:01:19 UTC). Its balance 58.99492582 GAS is unchanged since,
at `lastupdatedblock` 12534793. Both keys were funded by the operator from
`NhWxcoEc9qtmnjsTLF1fVF6myJ5MZZhSMK` at 13:08 and 14:47 UTC.

**The 5 stale pairs are the enclave-EIF blocker, not a mapping regression.**
`BRENT`, `NATGAS`, `WHEAT`, `CORN`, `SOY` last _written_ on chain 2026-06-06
(~75.5 d) carrying quotes already dated 2026-03-11 (~162 d) — the on-chain struct
holds both a source timestamp (field 1) and a write timestamp (field 3), and they
diverge by 86.6 days for exactly these pairs. The host now names them every cycle
(`planned by this host but NOT written by the enclave`), which is the intended
behaviour of the divergence detector; clearing them needs the EIF rebuild.

**Edge gateway honours origin `no-store`.** Four probes each through
`oracle.meshmini.app`: stale `CORN-USD` → `cache-control: no-store`,
`cf-cache-status: DYNAMIC` every time, `x-morpheus-feed-age-seconds` advancing
6521696 → 6521699 → 6521703 (revalidated, never served from cache). Fresh
`BTC-USD` → `public, max-age=15`, `DYNAMIC` then `HIT age: 7`. Caching was not
disabled wholesale. **Still broken:** on a HIT the zone Cache Rule rewrites the
client-facing header to `public, max-age=14400` — Cloudflare evicts at 15 s but
browsers are told 4 hours. That is zone configuration, not this worker.

**`systemctl --failed` is NOT empty**, and that is the honest state:
`morpheus-feed-monitor.service` (exit 1, naming exactly the 5 stale pairs) and
`morpheus-alert@morpheus-feed-monitor.service.service` (exit 78/CONFIG,
`ALERT_WEBHOOK_URL` unset — `/opt/morpheus/nitro/alert-notify.env` does not
exist). `morpheus-feed-topup.service` is **not** failed: last run 15:01:55 UTC,
`ok: updater 100.5 GAS >= 25, no topup needed`, next 21:01:53 UTC.

**Neo X remains silently down.** Confirmed live at 16:12:14 and 16:14:23 UTC:
`INSUFFICIENT_FUNDS`, balance 0.00234256 vs a 0.01772 tx cost, and the unit still
reports `Finished … Deactivated successfully` so `OnFailure=` never fires.
