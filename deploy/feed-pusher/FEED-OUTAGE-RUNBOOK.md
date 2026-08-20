# Mainnet price feed outage — restore runbook

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
