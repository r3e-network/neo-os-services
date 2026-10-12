//! The key-free public-source quorum behind [`crate::state::PriceSource`].
//!
//! `/feed/sign` signs numbers. Until now every number came from one keyed HTTP
//! call to TwelveData ([`crate::feed_sign::TwelveDataPrices`]): one external
//! party deciding what the enclave attests to. This module is the alternative
//! price plane — three key-free public venues, and a rule that a price is only
//! offered to the signing fold when at least two independent venues agree on
//! it, agree within a stated bound, and the agreed value is a robust centre of
//! their quotes rather than any one of them.
//!
//! The contract, in full:
//!
//! 1. **Usable** — a quote counts only if it is finite and strictly positive.
//! 2. **Distinct** — a venue contributes at most one quote per symbol; the
//!    first usable one wins. No arrangement of responses lets one party pose
//!    as two.
//! 3. **Minimum** — fewer than [`PUBLIC_QUORUM_MIN_SOURCES`] distinct venues
//!    is a **refusal**. A lone source never produces a quote the fold can sign.
//! 4. **Centre** — the candidate is the median of the remaining quotes.
//! 5. **Deviation guard** — every quote further than
//!    [`PUBLIC_QUORUM_MAX_DEVIATION_BPS`] from that candidate is dropped.
//! 6. **Re-quorum** — fewer than the minimum survivors is a **refusal** again,
//!    so dropping an outlier can never promote a single source to a decision.
//! 7. **Result** — the median of the survivors.
//!
//! A refusal is an **absence**, not an error: [`PublicSourcePrices`] returns
//! `Ok` with the symbol missing from the map, which is exactly the trait's
//! disposition for an unmapped or dropped quote, and the fold answers with the
//! symbol in `missing` and signs nothing for it. That is deliberate — a quorum
//! that cannot form is a decision not to quote, not a route failure to retry.
//!
//! Nothing here is configurable at request time. The minimum, the bound, the
//! venues and the symbol table are reviewed constants: a bound an untrusted
//! parent can raise is not a bound, and a source list it can extend is a way to
//! manufacture a quorum. See `docs/FEED-PUBLIC-QUORUM.md`.
//!
//! The plane is **dark and default-off** (DEC-CU-30): [`select_price_plane`]
//! keeps `TwelveDataPrices` unless an operator explicitly names
//! `public-quorum`, and it refuses an unknown label rather than falling back.

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, RwLock};

use neo_os_compute::js::js_to_number;
use neo_os_compute::transport::{HttpRequest, HttpResponse};

use crate::http_error;
use crate::overlay::EnvOverlay;
use crate::state::PriceSource;
use crate::RuntimeError;

/// The minimum number of DISTINCT venues that must agree on a symbol before a
/// quote is offered. Two, and only two, is what makes a signed price key-free:
/// one venue cannot decide it alone, and a third is not needed to say so.
pub const PUBLIC_QUORUM_MIN_SOURCES: usize = 2;

/// The inclusive cross-source deviation bound, in basis points of the median.
///
/// Chosen to sit well above normal venue basis — Binance quotes `NEOUSDT` where
/// the feed stores `NEO-USD`, so a few tens of basis points are expected and
/// must be absorbed — and well below the multi-fold spreads the feed pair
/// registry has already recorded between venues. At 5 % the venues must still
/// be talking about the same price; the bound absorbs basis, not disagreement.
///
/// Inclusive, so a quote exactly 5 % from the median is kept. The comparison is
/// written as `|q - median| * 10000 <= bound * median`, which is the same
/// inequality as `|q - median| / median * 10000 <= bound` but keeps the
/// decimal fixtures in the test suite exact.
pub const PUBLIC_QUORUM_MAX_DEVIATION_BPS: f64 = 500.0;

/// A bound on one venue response body. These are unauthenticated endpoints on
/// the public internet answering in JSON; a body beyond this is an absent
/// venue, never something the enclave parses.
pub const PUBLIC_QUORUM_MAX_RESPONSE_BYTES: usize = 65_536;

/// The three key-free venues of SVC-U01a, in the order a symbol is offered to
/// them. The order is what makes `Quote`'s `contributors` and `dropped` lists
/// deterministic for a given set of responses.
pub const PUBLIC_QUORUM_SOURCES: [&str; 3] = ["binance-spot", "coinbase-spot", "coingecko"];

/// One venue's quote for one symbol, after parse and usability filtering has
/// already had its say. `price` is finite and strictly positive by
/// construction of [`quorum_prices`]'s own filtering as well.
#[derive(Debug, Clone, PartialEq)]
pub struct Quote {
    /// The venue id from [`PUBLIC_QUORUM_SOURCES`].
    pub source: &'static str,
    /// The FEED symbol as the caller asked for it, e.g. `NEO-USD`.
    pub symbol: String,
    pub price: f64,
}

/// Why a symbol was refused. Both reasons are dispositions, not faults: the
/// plane returns `Ok` and the symbol is simply absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefusalReason {
    /// Fewer than [`PUBLIC_QUORUM_MIN_SOURCES`] distinct venues contributed a
    /// usable quote at all — the "a single source is refused" case.
    SingleSource,
    /// The deviation guard dropped quotes and fewer than the minimum survived,
    /// so the surviving sources cannot decide a price between them.
    Divergent,
}

impl RefusalReason {
    /// The operator-facing word for the refusal, for logs and `/health`.
    pub fn as_str(self) -> &'static str {
        match self {
            RefusalReason::SingleSource => "single_source",
            RefusalReason::Divergent => "divergent_sources",
        }
    }
}

/// What the quorum decided for one symbol.
#[derive(Debug, Clone, PartialEq)]
pub enum QuorumDecision {
    /// A candidate the fold may sign: `price` is the median of `contributors`,
    /// whose quotes all sat inside the deviation bound.
    Quoted {
        price: f64,
        /// Source ids that survived, in the order they were recorded.
        contributors: Vec<&'static str>,
        /// Source ids the deviation guard dropped.
        dropped: Vec<&'static str>,
    },
    /// No quote. Absent from the price map, `missing` to the fold.
    Refused {
        reason: RefusalReason,
        /// Source ids that contributed a usable quote before the guard.
        contributors: Vec<&'static str>,
        /// Source ids the deviation guard dropped (empty for a lone source).
        dropped: Vec<&'static str>,
    },
}

impl QuorumDecision {
    /// The signed-feed candidate, when there is one.
    pub fn price(&self) -> Option<f64> {
        match self {
            QuorumDecision::Quoted { price, .. } => Some(*price),
            QuorumDecision::Refused { .. } => None,
        }
    }
}

/// The quorum fold over already-collected quotes: one decision per symbol, in
/// symbol order. This is the whole of CU-89's rule, with the venues already
/// spoken to — which is what lets the acceptance be asserted against recorded
/// quotes rather than against the network.
pub fn quorum_prices(quotes: &[Quote]) -> BTreeMap<String, QuorumDecision> {
    // Collect per symbol in the order the quotes arrive, so the contributor and
    // dropped lists are deterministic for a given response set.
    let mut by_symbol: BTreeMap<String, Vec<(&'static str, f64)>> = BTreeMap::new();
    for quote in quotes {
        // (1) Usable — a 0, negative, NaN or infinite reading is a missing
        // quote from that venue, never a price.
        if !quote.price.is_finite() || quote.price <= 0.0 {
            continue;
        }
        let entries = by_symbol.entry(quote.symbol.clone()).or_default();
        // (2) Distinct — one contribution per venue id. The first usable quote
        // wins; a later one from the same venue is not a second party.
        if entries.iter().any(|(source, _)| *source == quote.source) {
            continue;
        }
        entries.push((quote.source, quote.price));
    }

    by_symbol
        .into_iter()
        .map(|(symbol, entries)| {
            let decision = decide(&entries);
            (symbol, decision)
        })
        .collect()
}

/// The per-symbol rule: minimum, median, deviation guard, re-quorum, median of
/// the survivors.
fn decide(entries: &[(&'static str, f64)]) -> QuorumDecision {
    let contributors: Vec<&'static str> = entries.iter().map(|(source, _)| *source).collect();
    let values: Vec<f64> = entries.iter().map(|(_, price)| *price).collect();

    // (3) Minimum — a lone source never decides a signed price.
    if entries.len() < PUBLIC_QUORUM_MIN_SOURCES {
        return QuorumDecision::Refused {
            reason: RefusalReason::SingleSource,
            contributors,
            dropped: Vec::new(),
        };
    }

    // (4) Centre — `median` averages the two middles on an even count, the
    // same rule the oracle aggregation engine uses.
    let candidate = median_or_zero(&values);

    // (5) Deviation guard, then (6) re-quorum.
    let mut kept: Vec<(&'static str, f64)> = Vec::new();
    let mut dropped: Vec<&'static str> = Vec::new();
    for (source, price) in entries {
        if within_deviation_bound(*price, candidate) {
            kept.push((source, *price));
        } else {
            dropped.push(*source);
        }
    }
    if kept.len() < PUBLIC_QUORUM_MIN_SOURCES {
        return QuorumDecision::Refused {
            reason: RefusalReason::Divergent,
            contributors,
            dropped,
        };
    }

    // (7) Result — the median of the survivors, not of the original set.
    let kept_values: Vec<f64> = kept.iter().map(|(_, price)| *price).collect();
    QuorumDecision::Quoted {
        price: median_or_zero(&kept_values),
        contributors: kept.iter().map(|(source, _)| *source).collect(),
        dropped,
    }
}

/// `|price - candidate| * 10000 <= PUBLIC_QUORUM_MAX_DEVIATION_BPS * candidate`.
///
/// Inclusive on the bound and free of a division, so the decimal fixtures the
/// tests use hit the boundary exactly rather than to within a rounding error.
fn within_deviation_bound(price: f64, candidate: f64) -> bool {
    if !price.is_finite() || !candidate.is_finite() || candidate <= 0.0 {
        return false;
    }
    (price - candidate).abs() * 10_000.0 <= PUBLIC_QUORUM_MAX_DEVIATION_BPS * candidate
}

/// [`neo_os_compute::oracle::aggregation::median`] over a non-empty slice.
/// Every call site is guarded by `PUBLIC_QUORUM_MIN_SOURCES >= 2`, so the
/// empty-input error is unreachable; it is mapped to 0.0 and then rejected by
/// the positive/finite rules rather than unwrapped.
fn median_or_zero(values: &[f64]) -> f64 {
    neo_os_compute::oracle::aggregation::median(values).unwrap_or(0.0)
}

// ---------------------------------------------------------------------------
// The reviewed symbol table
// ---------------------------------------------------------------------------

/// A feed symbol's identifier on each venue. `None` means the venue has no such
/// market and therefore contributes nothing for that symbol — which is how
/// `USDT-USD` reaches quorum on two venues instead of three.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PublicSourceSymbolIds {
    /// The Binance `BASEQUOTE` market, quoted against USDT.
    pub binance: Option<&'static str>,
    /// The Coinbase `BASE-QUOTE` pair.
    pub coinbase: Option<&'static str>,
    /// The CoinGecko asset id.
    pub coingecko: Option<&'static str>,
}

/// The plane's whole coverage: the crypto block [`crate::feed_sign`]'s keyed
/// symbol table already serves. The FX and equity symbols have no public spot
/// market on any of these three venues and are deliberately unmapped — absent
/// under this plane, exactly as the `PriceSource` contract says for an unmapped
/// symbol. See `docs/FEED-PUBLIC-QUORUM.md` for the resulting coverage
/// difference against `TwelveDataPrices`.
pub fn public_source_symbol_ids(symbol: &str) -> Option<PublicSourceSymbolIds> {
    let ids = match symbol.trim().to_ascii_uppercase().as_str() {
        "NEO-USD" => PublicSourceSymbolIds {
            binance: Some("NEOUSDT"),
            coinbase: Some("NEO-USD"),
            coingecko: Some("neo"),
        },
        "GAS-USD" => PublicSourceSymbolIds {
            binance: Some("GASUSDT"),
            coinbase: Some("GAS-USD"),
            coingecko: Some("gas"),
        },
        "BTC-USD" => PublicSourceSymbolIds {
            binance: Some("BTCUSDT"),
            coinbase: Some("BTC-USD"),
            coingecko: Some("bitcoin"),
        },
        "ETH-USD" => PublicSourceSymbolIds {
            binance: Some("ETHUSDT"),
            coinbase: Some("ETH-USD"),
            coingecko: Some("ethereum"),
        },
        "SOL-USD" => PublicSourceSymbolIds {
            binance: Some("SOLUSDT"),
            coinbase: Some("SOL-USD"),
            coingecko: Some("solana"),
        },
        "TRX-USD" => PublicSourceSymbolIds {
            binance: Some("TRXUSDT"),
            coinbase: Some("TRX-USD"),
            coingecko: Some("tron"),
        },
        "PAXG-USD" => PublicSourceSymbolIds {
            binance: Some("PAXGUSDT"),
            coinbase: Some("PAXG-USD"),
            coingecko: Some("pax-gold"),
        },
        // No `USDTUSDT` market exists, so this pair is a two-venue quorum.
        "USDT-USD" => PublicSourceSymbolIds {
            binance: None,
            coinbase: Some("USDT-USD"),
            coingecko: Some("tether"),
        },
        "USDC-USD" => PublicSourceSymbolIds {
            binance: Some("USDCUSDT"),
            coinbase: Some("USDC-USD"),
            coingecko: Some("usd-coin"),
        },
        "BNB-USD" => PublicSourceSymbolIds {
            binance: Some("BNBUSDT"),
            coinbase: Some("BNB-USD"),
            coingecko: Some("binancecoin"),
        },
        "XRP-USD" => PublicSourceSymbolIds {
            binance: Some("XRPUSDT"),
            coinbase: Some("XRP-USD"),
            coingecko: Some("ripple"),
        },
        "DOGE-USD" => PublicSourceSymbolIds {
            binance: Some("DOGEUSDT"),
            coinbase: Some("DOGE-USD"),
            coingecko: Some("dogecoin"),
        },
        _ => return None,
    };
    Some(ids)
}

// ---------------------------------------------------------------------------
// Venue adapters
// ---------------------------------------------------------------------------

/// The Binance spot ticker body: `{"symbol":"NEOUSDT","price":"12.34"}`.
pub fn parse_binance_price(body: &serde_json::Value) -> Option<f64> {
    usable_quote(body.get("price"))
}

/// The Coinbase spot body: `{"data":{"base":"NEO","currency":"USD","amount":"12.34"}}`.
pub fn parse_coinbase_price(body: &serde_json::Value) -> Option<f64> {
    usable_quote(body.get("data").and_then(|data| data.get("amount")))
}

/// The CoinGecko simple-price body: `{"neo":{"usd":12.34}}`.
pub fn parse_coingecko_price(body: &serde_json::Value, id: &str) -> Option<f64> {
    usable_quote(body.get(id).and_then(|entry| entry.get("usd")))
}

/// A quoted value, if it is one: finite and strictly positive after the same
/// JS coercion the keyed plane applies. Absent, null, empty-string and
/// non-numeric fields are simply not a quote.
fn usable_quote(value: Option<&serde_json::Value>) -> Option<f64> {
    let value = value?;
    if value.is_null() || value.is_array() || value.is_object() {
        return None;
    }
    let price = js_to_number(value);
    (price.is_finite() && price > 0.0).then_some(price)
}

/// The transport seam for the three venues' GETs.
///
/// One seam, over the request/response shapes
/// [`neo_os_compute::transport`] already defines, so the production
/// implementation is the enclave egress client the oracle read lanes already
/// use and a test can answer with recorded bytes without inventing a parallel
/// HTTP type.
pub trait PublicQuoteTransport: Send + Sync {
    fn get(&self, request: &HttpRequest) -> Result<HttpResponse, String>;
}

/// Production transport: [`neo_os_compute::transport::reqwest_transport`], the
/// same blocking reqwest client over the enclave egress lane. It carries no
/// credential, and every request this module builds is a plain GET.
pub struct ReqwestPublicQuotes;

impl PublicQuoteTransport for ReqwestPublicQuotes {
    fn get(&self, request: &HttpRequest) -> Result<HttpResponse, String> {
        neo_os_compute::transport::reqwest_transport()(request)
    }
}

/// The public-source price plane. Implements [`PriceSource`] exactly as the
/// keyed plane does, so the signing fold, the planner and the encoding are
/// untouched: only where the numbers come from changes.
pub struct PublicSourcePrices {
    transport: Box<dyn PublicQuoteTransport>,
    /// The live overlay, read per request for the shared price-plane timeout
    /// knob (`FEED_TD_TIMEOUT_MS`). The public plane sends no key, so that is
    /// the only thing it reads — which is the point of the plane.
    overlay: Arc<RwLock<EnvOverlay>>,
}

impl PublicSourcePrices {
    pub fn new(transport: Box<dyn PublicQuoteTransport>, overlay: Arc<RwLock<EnvOverlay>>) -> Self {
        PublicSourcePrices { transport, overlay }
    }

    /// Ask the three venues for `symbols` and return everything they said that
    /// parses as a usable quote, together with the count of venues that
    /// answered with a usable response at all.
    ///
    /// A venue that fails contributes nothing — for its symbols and nothing
    /// else — because a missing venue is a smaller quorum, not a broken
    /// request. But when NOTHING answers, the batch is not "nothing to quote":
    /// it is an outage, and the caller must see it. Folding that into an empty
    /// map is the exact failure mode SVC-U01 recorded against this lane — an
    /// upstream that stopped answering reading as "no update" and the feed
    /// going quietly stale.
    fn collect_quotes(&self, symbols: &[String]) -> (Vec<Quote>, VenueResponses) {
        let resolved: Vec<(String, PublicSourceSymbolIds)> = symbols
            .iter()
            .filter_map(|symbol| public_source_symbol_ids(symbol).map(|ids| (symbol.clone(), ids)))
            .collect();
        let timeout_ms = {
            let overlay = self.overlay.read().expect("overlay lock");
            let merged = overlay.merged_map();
            crate::feed_sign::feed_td_timeout_ms(&merged)
        };

        let mut quotes = Vec::new();
        let mut responses = VenueResponses::default();

        // Binance and Coinbase quote one market per request.
        for (symbol, ids) in &resolved {
            if let Some(market) = ids.binance {
                let url = format!("https://api1.binance.com/api/v3/ticker/price?symbol={market}");
                if let Some(body) = self.get_json(&url, timeout_ms, &mut responses) {
                    if let Some(price) = parse_binance_price(&body) {
                        quotes.push(Quote {
                            source: "binance-spot",
                            symbol: symbol.clone(),
                            price,
                        });
                    }
                }
            }
            if let Some(pair) = ids.coinbase {
                let url = format!("https://api.coinbase.com/v2/prices/{pair}/spot");
                if let Some(body) = self.get_json(&url, timeout_ms, &mut responses) {
                    if let Some(price) = parse_coinbase_price(&body) {
                        quotes.push(Quote {
                            source: "coinbase-spot",
                            symbol: symbol.clone(),
                            price,
                        });
                    }
                }
            }
        }

        // CoinGecko takes a batch of ids in one call.
        let mut ids: Vec<&'static str> = Vec::new();
        let mut seen = HashSet::new();
        for (_, entry) in &resolved {
            if let Some(id) = entry.coingecko {
                if seen.insert(id) {
                    ids.push(id);
                }
            }
        }
        if !ids.is_empty() {
            let url = format!(
                "https://api.coingecko.com/api/v3/simple/price?ids={}&vs_currencies=usd",
                ids.join(",")
            );
            if let Some(body) = self.get_json(&url, timeout_ms, &mut responses) {
                for (symbol, entry) in &resolved {
                    let Some(id) = entry.coingecko else {
                        continue;
                    };
                    if let Some(price) = parse_coingecko_price(&body, id) {
                        quotes.push(Quote {
                            source: "coingecko",
                            symbol: symbol.clone(),
                            price,
                        });
                    }
                }
            }
        }

        (quotes, responses)
    }

    /// One GET whose body is bounded and parses as JSON, or nothing. Every
    /// failure mode — transport, status, oversize, non-JSON — is the same
    /// disposition for the QUORUM: that venue said nothing usable. The
    /// response count is what distinguishes "the venues disagreed" from "the
    /// venues are gone", which [`PublicSourcePrices::fetch_prices`] treats very
    /// differently.
    fn get_json(
        &self,
        url: &str,
        timeout_ms: u64,
        responses: &mut VenueResponses,
    ) -> Option<serde_json::Value> {
        responses.attempted += 1;
        let response = self
            .transport
            .get(&HttpRequest {
                url: url.to_string(),
                method: "GET".to_string(),
                // No credential of any kind goes on this wire. The accept
                // header is a content-type request, not an identity.
                headers: vec![("accept".to_string(), "application/json".to_string())],
                body: None,
                timeout_ms,
                // A redirect must never move a quote to another host: the SSRF
                // discipline that applies to every other enclave fetch applies
                // here too, and there is nothing on this path worth following.
                follow_redirects: false,
            })
            .ok()?;
        if !(200..300).contains(&response.status) {
            return None;
        }
        if response.body.len() > PUBLIC_QUORUM_MAX_RESPONSE_BYTES {
            return None;
        }
        let parsed = serde_json::from_slice::<serde_json::Value>(&response.body).ok();
        if parsed.is_some() {
            responses.answered += 1;
        }
        parsed
    }
}

/// What the three venues did, in aggregate: enough to tell "they disagreed"
/// from "they are gone".
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct VenueResponses {
    /// Requests the plane put on the wire.
    attempted: usize,
    /// Requests that came back 2xx with a bounded, parseable JSON body.
    answered: usize,
}

impl PriceSource for PublicSourcePrices {
    /// Quoted symbols only. A refused symbol is ABSENT from the map — the same
    /// disposition the trait already documents for an unmapped or dropped
    /// quote — so the fold answers `missing` and signs nothing for it.
    ///
    /// A batch in which every venue was asked and none answered is NOT a
    /// refusal and NOT an empty quote set: it is an upstream outage, and it
    /// returns the 502 the keyed plane returns for a provider failure so the
    /// caller and `/health` see it. Anything quieter turns a dead internet
    /// into a feed that looks like it has nothing new to say.
    fn fetch_prices(&self, symbols: &[String]) -> Result<BTreeMap<String, f64>, RuntimeError> {
        let (quotes, responses) = self.collect_quotes(symbols);
        if responses.attempted > 0 && responses.answered == 0 {
            return Err(http_error(
                502,
                "no public price source answered for the requested symbols",
            ));
        }
        Ok(quorum_prices(&quotes)
            .into_iter()
            .filter_map(|(symbol, decision)| decision.price().map(|price| (symbol, price)))
            .collect())
    }
}

// ---------------------------------------------------------------------------
// Boot-time plane selection (DEC-CU-30: dark and default-off)
// ---------------------------------------------------------------------------

/// Which price plane serves `/feed/sign`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PricePlane {
    /// `TwelveDataPrices` — the keyed single-source plane. The default, and
    /// what every running system has today.
    TwelveData,
    /// `PublicSourcePrices` — this module's quorum. Reachable only by naming it.
    PublicQuorum,
}

impl PricePlane {
    pub fn as_str(self) -> &'static str {
        match self {
            PricePlane::TwelveData => "twelvedata",
            PricePlane::PublicQuorum => "public-quorum",
        }
    }
}

/// `FEED_PRICE_PLANE` — which plane serves `/feed/sign`.
///
/// Unset, empty and `twelvedata` all keep the keyed plane, so this branch is
/// dark in every deployment that has not been told otherwise. An **unknown**
/// value refuses rather than falling back: an operator who typed
/// `public_quorum` must not be served by the single-source plane they thought
/// they had replaced, which is the same fail-closed disposition
/// [`crate::normalize_network`] applies to an unreviewed network label.
pub fn select_price_plane(raw: Option<&str>) -> Result<PricePlane, String> {
    let normalized = raw.unwrap_or("").trim().to_ascii_lowercase();
    match normalized.as_str() {
        "" | "twelvedata" => Ok(PricePlane::TwelveData),
        "public-quorum" => Ok(PricePlane::PublicQuorum),
        other => Err(format!(
            "invalid FEED_PRICE_PLANE {other:?}; expected \"twelvedata\" or \"public-quorum\""
        )),
    }
}

#[cfg(test)]
#[path = "../tests/unit/feed_public_quorum.rs"]
mod tests;
