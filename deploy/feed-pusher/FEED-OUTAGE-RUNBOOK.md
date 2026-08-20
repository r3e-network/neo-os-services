# Mainnet price feed outage — restore runbook

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

- **Refill the topup key `NZFMvLj6mxTHEn8gRGrjZDeFCDMTm96p6R`** (currently 20
  GAS, below `TOPUP_AMOUNT` 40). Until then the auto-topup stays failed and the
  updater's 100 GAS is a ~25-day fuse.
- **Set `ALERT_WEBHOOK_URL`.** Without it every alert stops at the journal.
- **The box runs a 92-line `feed-monitor.mjs`; this repo ships a 221-line one.**
  The per-pair registry walk, TradFi weekend widening and
  `MONITOR_PROM_TEXTFILE` export documented here are **not running** — the box
  copy only checks NEO-USD and the GAS balance.
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

### 2.2 Make sure the auto-topup is actually installed

`morpheus-feed-topup.timer` is **absent from the enable list** in
`RUNBOOK.md` step 5, so it may never have been installed on the box. Check and
install it:

```bash
systemctl list-timers --all | grep -E 'feed-(pusher|monitor|topup)'
systemctl status morpheus-feed-topup.timer
# if missing:
systemctl enable --now morpheus-feed-topup.timer
```

It reads `TOPUP_WIF` from `/opt/morpheus/nitro/feed-topup.env` (chmod 600,
generated on the box, never committed). If that file or key does not exist, the
auto-topup has never worked and the wallet has only ever been refilled by hand.

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
