# Mainnet Node feed compatibility outage — incident runbook

> This document records recovery for the frozen Node compatibility writer.
> Production feed recovery must restore the Rust `neo-os-relayer`. Before any
> command below starts `morpheus-feed-pusher*` or `morpheus-feed-topup*`, stop
> both Rust relayer units and create the corresponding
> `/opt/morpheus/nitro/ENABLE_NODE_FEED_PUSHER_COMPAT` or
> `/opt/morpheus/nitro/ENABLE_NODE_FEE_TOPUP_COMPAT` marker. Remove the markers
> before returning authority to Rust. The systemd units enforce this mutual
> exclusion so Node and Rust cannot write chain state concurrently.

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

The live host `i-0c52851f134db20ee` does **not** use `/opt/neoos/services`. Its
repo root is `/opt/morpheus/neo-morpheus-oracle`, with `feed-pusher.mjs`
symlinked to `deploy/feed-pusher/feed-pusher.mjs` and `feed-monitor.mjs`,
`feed-topup.mjs`, `db-prune.mjs` sitting at that root. Every installed unit uses
`WorkingDirectory=/opt/morpheus/neo-morpheus-oracle`.

The `*.service` files in this repo carry `/opt/neoos/services/...`. **Copying
them onto this box verbatim would point every feed unit at a directory that does
not exist and take the feed down.** Reconcile the path first, or add behaviour
with drop-ins as below.

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

  ```bash
  cd /opt/morpheus/neo-morpheus-oracle
  cp -a feed-monitor.mjs /opt/morpheus/nitro/feed-monitor.mjs.bak-$(date -u +%Y%m%dT%H%M%SZ)
  ln -sfn /opt/morpheus/neo-morpheus-oracle/deploy/feed-pusher/feed-monitor.mjs feed-monitor.mjs
  ```

  Revert = `rm` the symlink and restore the backup under
  `/opt/morpheus/nitro/feed-monitor.mjs.bak-*`. The unit file was **not**
  touched: the repo unit's `WorkingDirectory=/opt/neoos/services/deploy/feed-pusher`
  does not exist on this box, and copying it verbatim would take the feed down.

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
cp deploy/feed-pusher/morpheus-feed-{monitor,pusher,topup}.service /etc/systemd/system/
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

Also set `MONITOR_PROM_TEXTFILE` in `/opt/morpheus/nitro/feed-pusher.env` to a
node_exporter textfile-collector path — that file is now actually loaded by
`morpheus-feed-monitor.service` (it previously declared no `EnvironmentFile=`,
so every documented monitor knob was inert).

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
