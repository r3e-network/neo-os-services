# Feed public-source quorum

The key-free price plane behind `/feed/sign`. Companion to
`workers/nitro-enclave-host/src/feed_public_quorum.rs`; that module is the
authority on behaviour, this document is the contract and the reasoning.

## Overview

`/feed/sign` builds an on-chain feed update and hands a complete unsigned Neo N3
transaction to the custody plane. Every number in it is a price. Until now every
price came from one keyed HTTP call to TwelveData
(`feed_sign::TwelveDataPrices`), so one external party decided every number the
enclave signed — and one expired key read as "nothing to update", which is how
the mainnet feed went dark unnoticed.

This plane replaces the _source_ of the numbers and nothing else. It asks three
key-free public venues, and offers a price to the signing fold only when at least
two independent venues agree on it, agree within a stated bound, and the agreed
value is a robust centre of their quotes rather than any one of them.

|                     |                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------ |
| Sources             | `binance-spot`, `coinbase-spot`, `coingecko` — no API key, no credential on the wire |
| Minimum             | two distinct venues per symbol                                                       |
| Centre              | median (mean of the two middles on an even count)                                    |
| Deviation guard     | 500 bps (5 %), inclusive, from the median                                            |
| Re-quorum           | a drop that leaves fewer than two venues is a refusal                                |
| Refusal disposition | the symbol is absent from the price map — `missing` to the fold, never signed        |
| Activation          | dark and default-off (DEC-CU-30); `FEED_PRICE_PLANE=public-quorum`                   |

## API Reference

### `PriceSource` (unchanged)

```rust
fn fetch_prices(&self, symbols: &[String]) -> Result<BTreeMap<String, f64>, RuntimeError>;
```

`PublicSourcePrices` implements the same trait the keyed plane does, so the
signing fold, the planner, the scaling, the transaction encoding and the custody
witness are untouched. The map is keyed by the ORIGINAL request symbol; a
refused or unmapped symbol is simply absent.

### The quorum fold

```rust
pub fn quorum_prices(quotes: &[Quote]) -> BTreeMap<String, QuorumDecision>;
```

`Quote { source, symbol, price }` is one venue's reading after parse.
`QuorumDecision` is either `Quoted { price, contributors, dropped }` or
`Refused { reason, contributors, dropped }`, with
`reason ∈ { SingleSource, Divergent }`.

Per symbol, in order:

1. **Usable** — keep a reading only if it is finite and strictly positive. A 0,
   a negative, a NaN or an infinite value is a missing quote, not a price.
2. **Distinct** — one contribution per source id; the first usable reading wins.
   A venue cannot contribute twice, so no arrangement of responses lets one
   party pose as two.
3. **Minimum** — fewer than `PUBLIC_QUORUM_MIN_SOURCES` (2) distinct venues is
   `Refused { SingleSource }`.
4. **Centre** — the median of the remaining readings.
5. **Deviation guard** — drop every reading for which
   `|price − median| * 10000 > PUBLIC_QUORUM_MAX_DEVIATION_BPS * median`.
   Inclusive: a reading exactly 5 % from the median is kept.
6. **Re-quorum** — fewer than 2 survivors is `Refused { Divergent }`. Dropping
   an outlier can never promote a single source to a decision.
7. **Result** — the median of the survivors.

### Venue adapters

| venue           | request                                                                         | quote path     |
| --------------- | ------------------------------------------------------------------------------- | -------------- |
| `binance-spot`  | `GET https://api1.binance.com/api/v3/ticker/price?symbol=<BINANCE>`             | `.price`       |
| `coinbase-spot` | `GET https://api.coinbase.com/v2/prices/<PAIR>/spot`                            | `.data.amount` |
| `coingecko`     | `GET https://api.coingecko.com/api/v3/simple/price?ids=<IDS>&vs_currencies=usd` | `.<id>.usd`    |

Binance and Coinbase are one request per symbol; CoinGecko batches every mapped
id into one. Every request is a `GET` with `accept: application/json`, no
credential, no redirect following, and the shared price-plane timeout
(`FEED_TD_TIMEOUT_MS`, `feed_sign::feed_td_timeout_ms`). A response is used only
if its status is 2xx, its body is at most
`PUBLIC_QUORUM_MAX_RESPONSE_BYTES` (64 KiB) and it parses as JSON. Anything else
is an absent venue — the same disposition as a venue that answered with no
quote — **unless nothing answered at all**, which is an outage and fails the
fetch (below).

The URL strings are built from the reviewed symbol table below, never from
request input.

### The symbol table

`public_source_symbol_ids` is the plane's whole coverage: the crypto block
`feed_sign::to_twelve_data_symbol` already serves.

| feed symbol | Binance    | Coinbase   | CoinGecko id  |
| ----------- | ---------- | ---------- | ------------- |
| `NEO-USD`   | `NEOUSDT`  | `NEO-USD`  | `neo`         |
| `GAS-USD`   | `GASUSDT`  | `GAS-USD`  | `gas`         |
| `BTC-USD`   | `BTCUSDT`  | `BTC-USD`  | `bitcoin`     |
| `ETH-USD`   | `ETHUSDT`  | `ETH-USD`  | `ethereum`    |
| `SOL-USD`   | `SOLUSDT`  | `SOL-USD`  | `solana`      |
| `TRX-USD`   | `TRXUSDT`  | `TRX-USD`  | `tron`        |
| `PAXG-USD`  | `PAXGUSDT` | `PAXG-USD` | `pax-gold`    |
| `USDT-USD`  | —          | `USDT-USD` | `tether`      |
| `USDC-USD`  | `USDCUSDT` | `USDC-USD` | `usd-coin`    |
| `BNB-USD`   | `BNBUSDT`  | `BNB-USD`  | `binancecoin` |
| `XRP-USD`   | `XRPUSDT`  | `XRP-USD`  | `ripple`      |
| `DOGE-USD`  | `DOGEUSDT` | `DOGE-USD` | `dogecoin`    |

Anything else is unmapped: never requested, always absent.

### Boot selection

`FEED_PRICE_PLANE`, read once from the live overlay at boot:

| value                      | plane                                                 |
| -------------------------- | ----------------------------------------------------- |
| unset, empty, `twelvedata` | `TwelveDataPrices` — the keyed plane, **the default** |
| `public-quorum`            | `PublicSourcePrices` — this plane                     |
| anything else              | the host refuses to boot                              |

## Design Decisions

**A refusal is an absence, not an error.** A quorum that cannot form is a
decision not to quote. Returning `Err` would make the route fail and the caller
retry a condition that will not improve; the trait's existing disposition for a
dropped quote is already "absent", and the fold already answers `missing` and
signs nothing. Nothing about the response shape changes.

**A dead upstream is an error.** The converse case is different in kind. When
every venue was asked and none returned a usable response, there is no quorum to
refuse — nobody was asked successfully at all. `fetch_prices` answers `502 no
public price source answered for the requested symbols`, which is the same
disposition `TwelveDataPrices` has for a provider failure and which
`fetch_prices_recording` records for `/health`. Folding that into an empty map
would reproduce the exact failure mode this lane is being fixed for: an upstream
that stopped answering reading as "nothing to update", and a feed going quietly
stale. Venues that answered and simply disagreed, or answered without a quote,
are still a refusal and still quiet.

**The deviation bound is a constant, not a knob.** A bound an untrusted parent
can raise is not a bound. 5 % is set to absorb venue basis — Binance quotes
`NEOUSDT` where the feed stores `NEO-USD` — while still requiring the venues to
be talking about the same price. The comparison is written without a division
(`|q − m| * 10000 <= bound * m`) so the decimal fixtures in the test suite hit
the boundary exactly.

**Re-quorum after the guard is half the property.** Without it, a three-venue
reading of 100 / 110 / 120 would drop the flanking pair and publish 110 as a
"two-source median" of one. With it, the median survives its own check, the
flanking readings do not, and a one-source remainder is refused.

**One contribution per source id.** A quorum of identifiers is not a quorum of
parties unless the identifiers differ. The first usable reading from a venue is
its contribution.

**No redirect following, no credential, bounded bodies.** The plane reaches the
public internet from inside the measured boundary. It sends nothing that
identifies anyone and it never follows a redirect, which is the same egress
discipline the oracle read lanes apply.

**FX is unmapped on purpose.** `EUR-USD`, `GBP-USD` and the equity symbols have
no public spot market on any of the three venues. Claiming them would be a
coverage claim this code cannot support; they are absent, and the caller sees
them in `missing`. This is a real coverage difference against
`TwelveDataPrices` and is listed under Test Coverage rather than hidden.

## Test Coverage

`workers/nitro-enclave-host/tests/unit/feed_public_quorum.rs` — 18 cases, no
network, all recorded:

- the acceptance: the expected median from recorded quotes; a lone source
  refused; an outlier dropped and the median recomputed on what survived;
- the guard: a divergent pair refused; a divergent triple refused rather than
  averaged; the 5 % bound inclusive at the boundary and one basis point over;
- the distinct-source rule: one venue cannot pose as two, and a real second
  venue still lifts a duplicate pair to a quorum;
- unusable readings: 0, negative, NaN and infinite are not quotes;
- per-symbol independence: one symbol quoting does not carry a refused
  neighbour, and a refusal does not poison the batch;
- the venue adapters over recorded HTTP bodies for all three documented shapes;
- a failed venue leaving the remaining quorum, and a failed venue leaving a
  single source that is refused;
- a batch where every venue failed, or every venue answered with something
  unusable, failing the fetch with 502 — while venues that answered and merely
  disagreed stay a quiet refusal;
- every captured request checked for a missing credential header and a missing
  credential query parameter;
- the symbol table's exact coverage, including `USDT-USD`'s absent Binance
  market and the unmapped FX block;
- boot selection defaulting to the keyed plane and refusing an unknown label.

`deploy/nitro/enclave-host.test.mjs` adds one HTTP-boundary case against the
built binary: an unknown `FEED_PRICE_PLANE` stops the host before it listens.

Not verified here: live venue behaviour, live response shapes beyond the three
documented ones, whether a given venue currently lists a given market (a venue
that no longer does simply contributes nothing, which is the safe direction),
and any property of the signing fold or the chain — this slice does not touch
them.

## Usage Examples

Default, unchanged production behaviour:

```
# FEED_PRICE_PLANE unset
enclave_host: {"level":"info","msg":"morpheus enclave-server listening",...,"price_plane":"twelvedata"}
```

Quorum selected at the next enclave build:

```
FEED_PRICE_PLANE=public-quorum
enclave_host: {"level":"info","msg":"morpheus enclave-server listening",...,"price_plane":"public-quorum"}
```

Misconfiguration refuses rather than falling back:

```
FEED_PRICE_PLANE=public_quorum
enclave_host: refusing to serve — invalid FEED_PRICE_PLANE "public_quorum"; expected "twelvedata" or "public-quorum"
```

A symbol whose venues disagree is not signed:

```
POST /feed/sign  {"chain":"neo_n3","symbols":["NEO-USD","GAS-USD"]}
→ {"status":"no-update",...,"missing":["NEO-USD","GAS-USD"]}
```

## Rollout

Built dark (DEC-CU-30). The measured image is unchanged and the quorum is
unreachable without an explicit boot label. It ships with the next enclave build
(OP-11), not before. Rollback is to leave `FEED_PRICE_PLANE` unset or to revert
the branch: no data, no chain state, no credential and no migration is involved.
