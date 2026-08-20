# Feed pair registry — what is advertised, what is pushed, what is retired

Status: reconciled 2026-08-20. Verified against mainnet MorpheusDataFeed
`0x03013f49c42a14546c8bbe58f9d434c3517fccab` and against `api.twelvedata.com`
using the production key on i-0c52851f134db20ee.

## Why this document exists

`/api/feeds/status` read `degraded` permanently. A health signal that is always red
is a health signal nobody reads, and that is how a 22-day feed outage hid in plain
sight. The cause was not one bug but four registries that had drifted apart:

| Registry   | File                                                                        | Role                            |
| ---------- | --------------------------------------------------------------------------- | ------------------------------- |
| Advertised | `apps/web/lib/feed-defaults.ts` (`DEFAULT_FEED_BASE_SYMBOLS`)               | what `/api/feeds/status` counts |
| Pushed     | `deploy/feed-pusher/feed-pusher.mjs` (`TD_SYMBOLS`) + the box `SYMBOLS` env | what is written on chain        |
| Quoted     | `workers/nitro-worker/src/oracle/feed-registry.js` (`DEFAULT_FEED_PAIRS`)   | what the worker can quote       |
| Runtime    | `MORPHEUS_FEED_SYMBOLS` in `deploy/nitro/morpheus.env.example`              | what the runtime configures     |

`npm run check:feeds:registries` now fails while any of them disagree. Add
`--onchain` to also reconcile against the live contract.

## The set: 32 pairs

12 crypto, 4 FX, 6 commodity, 7 equity, 3 ETF. All four registries name exactly these
pairs, and each pair's provider symbol is identical in the advertised list and the
pusher table. The worker may use a different provider symbol only where it declares a
`price_transform` that makes it the same instrument (JPY-USD and CNY-USD: the worker
fetches `USD/JPY` / `USD/CNY` and inverts, the pusher fetches `JPY/USD` / `CNY/USD`
directly — the same quantity either way).

## Retired pairs — and the evidence

Retirement removes a pair from every active registry and from the health count. It is
the honest alternative to leaving a pair advertised and permanently stale. All four
are recorded in `RETIRED_FEED_PAIRS` in `feed-defaults.ts`, `feed-pusher.mjs`,
`feed-registry.js` and as `RETIRED_PAIRS` in `feed-monitor.mjs`.

### COPPER-USD — the provider symbol is a German equity

TwelveData's `/commodities` reference lists `HG1` as "Copper Spot". Its `/price` and
`/quote` endpoints do not agree:

```
/quote?symbol=HG1                 -> Homag Group AG | FSX | EUR | close 24.40000
/quote?symbol=HG1&exchange=Forex  -> Copper Spot    | Forex     | close  6.46363
```

The on-chain `COPPER-USD` record is `24.40`, last written 2026-06-06 — i.e. the feed
has been publishing the share price of a Frankfurt-listed woodworking-machinery
manufacturer, in EUR, under a pair named for copper in USD.

Reinstating it needs **both**:

1. a per-symbol fetch carrying `exchange=Forex`, which cannot ride the batched
   comma-separated `/price?symbol=a,b,c` call the pusher uses; and
2. an admin feed reset for the pair — re-anchoring `24.40` to the real `6.46` USD/lb
   is a −73.5% move, which the deviation guard correctly refuses. **Do not raise
   `MAX_DEVIATION_BPS` to force it through**; the guard is right and the stored value
   is wrong.

### FLM-USD — the provider symbol is a different coin

TwelveData's own reference is explicit:

```
/cryptocurrencies?symbol=FLM/USD
  -> {"symbol":"FLM/USD","available_exchanges":["Synthetic"],
      "currency_base":"FolmCoin","currency_quote":"US Dollar"}
```

FolmCoin, not Flamingo Finance — which is what FLM means to every Neo consumer of
this feed. Cross-check on 2026-08-20:

| source                                         | value                        |
| ---------------------------------------------- | ---------------------------- |
| TwelveData `FLM/USD` (and the on-chain record) | 0.0025054                    |
| CoinGecko `flamingo-finance`                   | 0.00053932                   |
| CoinGecko `neo` vs on-chain `NEO-USD`          | 1.87 vs 1.864 (method check) |

4.6x apart. `symbol_search?symbol=flamingo` returns nothing: the provider has no
Flamingo Finance listing at all. The pair was being pushed to both Neo N3 and Neo X
while being advertised nowhere. It is now retired rather than advertised, because
publishing the wrong asset under the right ticker is worse than not publishing it.
Reinstating it needs a provider that actually lists Flamingo.

### 1000FLM-USD, 1000JPY-USD

Legacy scaled variants left on chain from an earlier feed generation, last written
2026-03-11, in no configuration since. Superseded by `FLM-USD` (itself retired) and
`JPY-USD`. Recorded so they stop being reported as unexplained extras.

## The CORN-USD mis-mapping

`CORN-USD` was in the pusher's symbol list and rejected on every cycle:

```
⚠️ rejected CORN-USD deviation_spike: src=18.93 on-chain=417.41831
```

The guard was right and the mapping was wrong. The bare ticker `CORN` is the
**Teucrium Corn Fund**, an NYSE ETF quoting ~$18.9; the on-chain series is CBOT corn
futures, `C_1`, quoting ~479 US cents per bushel. The 2026-06-15 fix that correctly
moved equities and ETFs to bare tickers (`AAPL/USD` 404s, `AAPL` does not) swept
`CORN` into the same bare-ticker set, and a heuristic that derives a provider symbol
from a pair name cannot tell the two apart.

The heuristic is gone. `TD_SYMBOLS` is an explicit table, every entry verified against
`/quote` with the resolved instrument name recorded in a comment, and a symbol with no
entry is now **refused loudly** rather than guessed at:

```
⚠️ ALERT: FLM-USD has no TwelveData mapping — add it to TD_SYMBOLS (with the resolved
instrument verified) or drop it from SYMBOLS. Refusing to guess a provider symbol.
```

## Verified sourceable — the four pairs put back

Advertised but absent from the pusher, so they could never be fresh; 75 days stale.
All four resolve correctly today, and each is well inside the 50% deviation guard
against its stored value, so no guard needs relaxing for them to land:

| pair       | provider symbol | resolves to             | source  | on-chain | deviation |
| ---------- | --------------- | ----------------------- | ------- | -------- | --------- |
| BRENT-USD  | `XBR/USD`       | Brent Spot / US Dollar  | 91.586  | 92.914   | 1.4%      |
| NATGAS-USD | `NG/USD`        | Natural Gas / US Dollar | 2.730   | 3.229    | 15.4%     |
| WHEAT-USD  | `W_1`           | Wheat Futures           | 686.49  | 580.24   | 18.3%     |
| SOY-USD    | `S_1`           | Soybeans Futures        | 1224.68 | 1121.39  | 9.2%      |
| CORN-USD   | `C_1`           | Corn Futures            | 479.92  | 417.42   | 15.0%     |

## Open blocker: the enclave carries its own copy of the mapping

`MORPHEUS_FEED_PUSHER_ENCLAVE_SIGN=true`, so the **enclave** fetches prices and plans
the batch inside the measured boundary — the authoritative provider-symbol mapping is
the `feed-pusher.mjs` baked into the running EIF, not the file on the host.

The running enclave is `morpheus-oracle-exec-10` (PCR0 `39fad73b…`), built from
`/opt/morpheus/nitro/morpheus-oracle.eif` on 2026-06-15. Its baked `feed-pusher.mjs`
is at commit `fb6c32b` ("fix(feeds): map equity/ETF symbols to bare TwelveData
tickers") — the commit that introduced the `CORN` mis-mapping and that has no entries
for `XBR/USD`, `NG/USD`, `W_1` or `S_1`.

So the five commodity pairs above are correctly configured everywhere on the host and
still do not land: the enclave fetches `BRENT/USD`, `NATGAS/USD`, `WHEAT/USD`,
`SOY/USD` (all 404) and `CORN` (the ETF, which its own deviation guard then rejects).

**This used to be completely silent.** The cycle succeeded, the log said
`pushed N pairs`, and the pairs simply never moved. The host now detects it:

```
⚠️ ALERT: CORN-USD was planned by this host but NOT written by the enclave, and is
1811h stale on chain — the enclave EIF is fetching it with a different (older)
provider-symbol mapping. Rebuild and re-run the enclave image so its baked
feed-pusher.mjs matches this host.
```

Only pairs already past the forced-heartbeat window are reported, so an ordinary
disagreement between the host's fetch and the enclave's fetch a second later does not
raise noise.

**To close it:** rebuild the enclave EIF from a tree containing the corrected
`deploy/feed-pusher/feed-pusher.mjs` and run it as exec-11
(`deploy/nitro/build-enclave-eif.sh`, then record the measurement under
`deploy/nitro/measurements/`). This changes PCR0/PCR2, so any KMS key policy or
attestation policy pinned to the current measurements must be updated in the same
change, and the feed has no signer while the enclave restarts. It is a deliberate,
coordinated operation — not a side effect of a config edit.

Until it is done, `/api/feeds/status` will read `degraded` and
`morpheus-feed-monitor.service` will fail, naming exactly those five pairs and nothing
else. That is correct: something is genuinely wrong, it is named, and it is bounded.

## What each signal should read

| condition                             | `/api/feeds/status`                | `feed-monitor`                          |
| ------------------------------------- | ---------------------------------- | --------------------------------------- |
| all 32 advertised pairs within budget | `ok`                               | exit 0                                  |
| an advertised pair past its budget    | `degraded`, pair named in `alerts` | exit 1, pair named                      |
| a retired pair ageing on chain        | not counted (not advertised)       | reported with `retired: true`, no alert |
| registries disagree                   | —                                  | `npm run check:feeds:registries` fails  |

## Weekend behaviour — an open question, deliberately not guessed

`DEFAULT_TRADFI_PAIRS` now covers the FX pairs and the whole TwelveData commodity lane
(`WTI`, `BRENT`, `NATGAS`, `WHEAT`, `CORN`, `SOY`), which stop quoting across a market
close exactly as `WTI-USD` already did. Equities and ETFs are **not** included: whether
TwelveData keeps serving their last close over a weekend has never been observed with
a working feed, and widening a staleness budget on a guess is how a real outage gets
waved through. If the first weekend after 2026-08-20 shows the equity/ETF pairs ageing
out, add them to `DEFAULT_TRADFI_PAIRS` (and the box `TRADFI_PAIRS`) on that evidence.

## Changing the pair set

1. Verify the provider symbol with `/quote` and record the instrument name it resolves
   to. Two of the four retirements above exist because a symbol resolved to something
   else entirely.
2. Add it to `TD_SYMBOLS`, `DEFAULT_FEED_BASE_SYMBOLS` + a descriptor,
   `DEFAULT_FEED_PAIRS`, `MORPHEUS_FEED_SYMBOLS`, and the box `SYMBOLS`.
3. Run `npm run check:feeds:registries` (and `--onchain` once it should be live).
4. If the enclave signs, rebuild the EIF — the host table alone does not change what
   gets written.
