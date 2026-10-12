//! Key-free public-source quorum tests.
//!
//! The acceptance of CU-89 is three sentences — recorded quotes give the
//! expected median, one source is refused, an outlier is dropped — so those
//! three are asserted first and directly, against the pure quorum fold
//! ([`quorum_prices`]). Everything after them is the machinery that makes
//! those three true: the inclusive deviation bound, the distinct-source
//! collapse, the re-quorum after a drop, and the three venue adapters over
//! recorded HTTP bodies.
//!
//! Nothing here reaches the network: the transport seam is a recording double.

use super::*;
use crate::state::PriceSource;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, RwLock};

use neo_os_compute::transport::{HttpRequest, HttpResponse};

// ---------------------------------------------------------------------------
// Recorded-transport double
// ---------------------------------------------------------------------------

/// `(method, url, headers)` of one request the plane put on the seam.
type CapturedRequest = (String, String, Vec<(String, String)>);

#[derive(Clone, Default)]
struct RecordedQuotes {
    inner: Arc<RecordedQuotesInner>,
}

#[derive(Default)]
struct RecordedQuotesInner {
    replies: Mutex<BTreeMap<String, Result<HttpResponse, String>>>,
    /// Every request the plane put on the seam.
    requests: Mutex<Vec<CapturedRequest>>,
}

impl RecordedQuotes {
    fn new() -> Self {
        Self::default()
    }

    fn ok_json(&self, url: &str, body: &str) -> &Self {
        self.inner.replies.lock().expect("replies lock").insert(
            url.to_string(),
            Ok(HttpResponse {
                status: 200,
                headers: Vec::new(),
                body: body.as_bytes().to_vec(),
            }),
        );
        self
    }

    fn ok_status(&self, url: &str, status: u16, body: &str) -> &Self {
        self.inner.replies.lock().expect("replies lock").insert(
            url.to_string(),
            Ok(HttpResponse {
                status,
                headers: Vec::new(),
                body: body.as_bytes().to_vec(),
            }),
        );
        self
    }

    fn err(&self, url: &str, message: &str) -> &Self {
        self.inner
            .replies
            .lock()
            .expect("replies lock")
            .insert(url.to_string(), Err(message.to_string()));
        self
    }

    fn requests(&self) -> Vec<CapturedRequest> {
        self.inner.requests.lock().expect("requests lock").clone()
    }
}

impl PublicQuoteTransport for RecordedQuotes {
    fn get(&self, request: &HttpRequest) -> Result<HttpResponse, String> {
        self.inner.requests.lock().expect("requests lock").push((
            request.method.clone(),
            request.url.clone(),
            request.headers.clone(),
        ));
        self.inner
            .replies
            .lock()
            .expect("replies lock")
            .get(&request.url)
            .cloned()
            .unwrap_or_else(|| Err(format!("no recorded reply for {}", request.url)))
    }
}

/// An empty overlay is enough: the public plane sends no credential and reads
/// only the shared price-plane timeout knob.
fn empty_overlay() -> Arc<RwLock<crate::overlay::EnvOverlay>> {
    Arc::new(RwLock::new(crate::overlay::EnvOverlay::new(
        std::iter::empty::<(&str, &str)>(),
    )))
}

fn plane(transport: RecordedQuotes) -> PublicSourcePrices {
    PublicSourcePrices::new(Box::new(transport), empty_overlay())
}

fn quote(source: &'static str, symbol: &str, price: f64) -> Quote {
    Quote {
        source,
        symbol: symbol.to_string(),
        price,
    }
}

fn quoted_price(decision: &QuorumDecision) -> f64 {
    match decision {
        QuorumDecision::Quoted { price, .. } => *price,
        QuorumDecision::Refused { reason, .. } => {
            panic!("expected a quote, got a refusal: {reason:?}")
        }
    }
}

fn refusal(decision: &QuorumDecision) -> RefusalReason {
    match decision {
        QuorumDecision::Refused { reason, .. } => *reason,
        QuorumDecision::Quoted { price, .. } => panic!("expected a refusal, got a quote: {price}"),
    }
}

// ---------------------------------------------------------------------------
// 1-4. The acceptance
// ---------------------------------------------------------------------------

/// "Recorded quotes give the expected median" — three recorded venues, the
/// middle quote is what the fold would sign.
#[test]
fn recorded_quotes_give_the_expected_median() {
    // A realistic venue spread: a few tenths of a percent, well inside the
    // bound. The middle quote is what the fold would sign.
    let decisions = quorum_prices(&[
        quote("binance-spot", "NEO-USD", 100.0),
        quote("coinbase-spot", "NEO-USD", 102.0),
        quote("coingecko", "NEO-USD", 104.0),
    ]);
    let decision = decisions.get("NEO-USD").expect("one symbol decided");
    assert_eq!(quoted_price(decision), 102.0);
    match decision {
        QuorumDecision::Quoted {
            contributors,
            dropped,
            ..
        } => {
            assert_eq!(contributors.len(), 3);
            assert!(dropped.is_empty());
        }
        QuorumDecision::Refused { reason, .. } => panic!("unexpected refusal: {reason:?}"),
    }
}

/// An even count has no single middle quote: the two middles are averaged,
/// which is the same rule `neo_os_compute::oracle::aggregation::median` uses.
#[test]
fn two_recorded_quotes_give_their_mean() {
    let decisions = quorum_prices(&[
        quote("binance-spot", "NEO-USD", 100.0),
        quote("coinbase-spot", "NEO-USD", 104.0),
    ]);
    assert_eq!(
        quoted_price(decisions.get("NEO-USD").expect("decided")),
        102.0
    );
}

/// "One source is refused" — a lone venue never produces a quote the fold can
/// sign, whether it is the only venue configured or the only one that answered.
#[test]
fn a_single_source_is_refused() {
    let decisions = quorum_prices(&[quote("coingecko", "NEO-USD", 100.0)]);
    let decision = decisions.get("NEO-USD").expect("decided");
    assert_eq!(refusal(decision), RefusalReason::SingleSource);
    assert!(matches!(decision, QuorumDecision::Refused { .. }));
}

/// "An outlier is dropped" — the 500 quote is outside the deviation bound and
/// is dropped, and the price that survives is the median of what is left.
#[test]
fn an_outlier_is_dropped_and_the_median_recomputed() {
    let decisions = quorum_prices(&[
        quote("binance-spot", "NEO-USD", 100.0),
        quote("coinbase-spot", "NEO-USD", 101.0),
        quote("coingecko", "NEO-USD", 500.0),
    ]);
    let decision = decisions.get("NEO-USD").expect("decided");
    assert_eq!(quoted_price(decision), 100.5);
    match decision {
        QuorumDecision::Quoted {
            contributors,
            dropped,
            ..
        } => {
            assert_eq!(contributors, &["binance-spot", "coinbase-spot"]);
            assert_eq!(dropped, &["coingecko"]);
        }
        QuorumDecision::Refused { reason, .. } => panic!("unexpected refusal: {reason:?}"),
    }
}

// ---------------------------------------------------------------------------
// 5-10. The guard, the distinct-source rule, and the per-symbol split
// ---------------------------------------------------------------------------

/// Two venues that disagree by far more than the bound both fail it. Dropping
/// them leaves no quorum, so the symbol is refused rather than averaged — the
/// re-quorum after the guard is what stops a drop from promoting a single
/// source to a decision.
#[test]
fn a_divergent_pair_is_refused() {
    let decisions = quorum_prices(&[
        quote("binance-spot", "NEO-USD", 100.0),
        quote("coinbase-spot", "NEO-USD", 200.0),
    ]);
    let decision = decisions.get("NEO-USD").expect("decided");
    assert_eq!(refusal(decision), RefusalReason::Divergent);
    match decision {
        QuorumDecision::Refused { dropped, .. } => assert_eq!(dropped.len(), 2),
        QuorumDecision::Quoted { .. } => panic!("expected a refusal"),
    }
}

/// The guard applies to three venues just as it does to two. Three readings
/// 20 % apart must not average into a price the enclave signs: the median
/// survives its own check, the flanking readings do not, and a one-source
/// remainder is refused rather than published as "the middle one".
#[test]
fn three_venues_that_disagree_do_not_average_to_a_price() {
    let decisions = quorum_prices(&[
        quote("binance-spot", "NEO-USD", 100.0),
        quote("coinbase-spot", "NEO-USD", 110.0),
        quote("coingecko", "NEO-USD", 120.0),
    ]);
    let decision = decisions.get("NEO-USD").expect("decided");
    assert_eq!(refusal(decision), RefusalReason::Divergent);
    match decision {
        QuorumDecision::Refused {
            contributors,
            dropped,
            ..
        } => {
            assert_eq!(contributors.len(), 3);
            assert_eq!(dropped.len(), 2);
        }
        QuorumDecision::Quoted { .. } => panic!("expected a refusal"),
    }
}

/// The bound is inclusive: a quote exactly 5 % from the median stays. Here the
/// median is 100 and 105 is 500 bps away to the last bit, so a strict `<`
/// would wrongly drop it.
#[test]
fn the_deviation_bound_is_inclusive() {
    let decisions = quorum_prices(&[
        quote("binance-spot", "NEO-USD", 100.0),
        quote("coinbase-spot", "NEO-USD", 100.0),
        quote("coingecko", "NEO-USD", 105.0),
    ]);
    match decisions.get("NEO-USD").expect("decided") {
        QuorumDecision::Quoted {
            contributors,
            dropped,
            ..
        } => {
            assert_eq!(contributors.len(), 3);
            assert!(dropped.is_empty());
        }
        QuorumDecision::Refused { reason, .. } => panic!("unexpected refusal: {reason:?}"),
    }

    // One basis point further and it is dropped.
    let decisions = quorum_prices(&[
        quote("binance-spot", "NEO-USD", 100.0),
        quote("coinbase-spot", "NEO-USD", 100.0),
        quote("coingecko", "NEO-USD", 106.0),
    ]);
    match decisions.get("NEO-USD").expect("decided") {
        QuorumDecision::Quoted {
            contributors,
            dropped,
            price,
        } => {
            assert_eq!(contributors, &["binance-spot", "coinbase-spot"]);
            assert_eq!(dropped, &["coingecko"]);
            assert_eq!(*price, 100.0);
        }
        QuorumDecision::Refused { reason, .. } => panic!("unexpected refusal: {reason:?}"),
    }
}

/// One venue contributes at most one quote per symbol, whatever it returned.
/// Two entries carrying the same source id are still a single source and are
/// refused: a quorum of ids is not a quorum of parties unless the ids differ.
#[test]
fn one_venue_cannot_pose_as_two() {
    let decisions = quorum_prices(&[
        quote("coingecko", "NEO-USD", 100.0),
        quote("coingecko", "NEO-USD", 100.0),
    ]);
    assert_eq!(
        refusal(decisions.get("NEO-USD").expect("decided")),
        RefusalReason::SingleSource
    );

    // ... and a real second venue still lifts it to a quorum of two, with the
    // duplicate entry ignored rather than counted: the FIRST usable quote from
    // a source is its contribution and later ones are not extra parties.
    let decisions = quorum_prices(&[
        quote("coingecko", "NEO-USD", 100.0),
        quote("coingecko", "NEO-USD", 999.0),
        quote("binance-spot", "NEO-USD", 101.0),
    ]);
    match decisions.get("NEO-USD").expect("decided") {
        QuorumDecision::Quoted {
            contributors,
            dropped,
            price,
        } => {
            assert_eq!(contributors, &["coingecko", "binance-spot"]);
            assert!(dropped.is_empty());
            assert_eq!(*price, 100.5);
        }
        QuorumDecision::Refused { reason, .. } => panic!("unexpected refusal: {reason:?}"),
    }
}

/// A 0, negative or non-finite reading is a missing quote from that venue, not
/// a price. Such a reading must never reach the median.
#[test]
fn non_positive_and_non_finite_quotes_are_not_quotes() {
    for unusable in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        let decisions = quorum_prices(&[
            quote("binance-spot", "NEO-USD", 100.0),
            quote("coinbase-spot", "NEO-USD", unusable),
        ]);
        assert_eq!(
            refusal(decisions.get("NEO-USD").expect("decided")),
            RefusalReason::SingleSource,
            "quote {unusable} must not count as a contribution"
        );
    }
}

/// Each symbol is quorumed on its own: one symbol quoting does not carry a
/// refused neighbour into the signed update, and a refusal does not poison the
/// batch.
#[test]
fn symbols_are_quorumindependently() {
    let decisions = quorum_prices(&[
        quote("binance-spot", "NEO-USD", 100.0),
        quote("coinbase-spot", "NEO-USD", 102.0),
        quote("coingecko", "NEO-USD", 104.0),
        quote("coingecko", "GAS-USD", 3.5),
    ]);
    assert_eq!(
        quoted_price(decisions.get("NEO-USD").expect("NEO decided")),
        102.0
    );
    assert_eq!(
        refusal(decisions.get("GAS-USD").expect("GAS decided")),
        RefusalReason::SingleSource
    );
}

// ---------------------------------------------------------------------------
// 11-15. The venue adapters over recorded HTTP bodies
// ---------------------------------------------------------------------------

/// The three documented response shapes, end to end through the `PriceSource`
/// impl, produce the median of the three recorded quotes.
#[test]
fn recorded_venue_bodies_produce_the_expected_median() {
    let transport = RecordedQuotes::new();
    transport.ok_json(
        "https://api1.binance.com/api/v3/ticker/price?symbol=NEOUSDT",
        r#"{"symbol":"NEOUSDT","price":"100.0"}"#,
    );
    transport.ok_json(
        "https://api.coinbase.com/v2/prices/NEO-USD/spot",
        r#"{"data":{"base":"NEO","currency":"USD","amount":"102.0"}}"#,
    );
    transport.ok_json(
        "https://api.coingecko.com/api/v3/simple/price?ids=neo&vs_currencies=usd",
        r#"{"neo":{"usd":104.0}}"#,
    );
    let prices = plane(transport)
        .fetch_prices(&["NEO-USD".to_string()])
        .expect("the plane does not fail on a usable batch");
    assert_eq!(prices.get("NEO-USD"), Some(&102.0));
    assert_eq!(prices.len(), 1);
}

/// A venue that cannot be reached is an absent contribution, not a route
/// failure: the other two still form a quorum and the batch still quotes.
#[test]
fn a_failed_venue_leaves_the_remaining_quorum() {
    let transport = RecordedQuotes::new();
    transport.err(
        "https://api1.binance.com/api/v3/ticker/price?symbol=NEOUSDT",
        "connection refused",
    );
    transport.ok_json(
        "https://api.coinbase.com/v2/prices/NEO-USD/spot",
        r#"{"data":{"base":"NEO","currency":"USD","amount":"109.0"}}"#,
    );
    transport.ok_json(
        "https://api.coingecko.com/api/v3/simple/price?ids=neo&vs_currencies=usd",
        r#"{"neo":{"usd":111.0}}"#,
    );
    let prices = plane(transport)
        .fetch_prices(&["NEO-USD".to_string()])
        .expect("a failed venue is not a failed fetch");
    assert_eq!(prices.get("NEO-USD"), Some(&110.0));
}

/// ... and when the failures leave one venue, the symbol is refused: the
/// failure of two venues must not hand the third a signed price.
#[test]
fn a_failed_venue_can_leave_a_single_source_refused() {
    let transport = RecordedQuotes::new();
    transport.ok_json(
        "https://api1.binance.com/api/v3/ticker/price?symbol=NEOUSDT",
        r#"{"symbol":"NEOUSDT","price":"100.0"}"#,
    );
    transport.ok_status(
        "https://api.coinbase.com/v2/prices/NEO-USD/spot",
        502,
        "bad gateway",
    );
    transport.ok_json(
        "https://api.coingecko.com/api/v3/simple/price?ids=neo&vs_currencies=usd",
        "not json at all",
    );
    let prices = plane(transport)
        .fetch_prices(&["NEO-USD".to_string()])
        .expect("a refused symbol is an absence, not an error");
    assert!(!prices.contains_key("NEO-USD"));
    assert!(prices.is_empty());
}

/// A batch in which every venue was asked and none answered is an outage, not
/// "nothing to quote". Returning an empty map would turn a dead upstream into a
/// feed that looks like it has nothing new to say — the exact failure mode the
/// keyed plane was criticised for.
#[test]
fn when_no_public_source_answers_the_fetch_fails() {
    // Nothing came back at all.
    let transport = RecordedQuotes::new();
    transport.err(
        "https://api1.binance.com/api/v3/ticker/price?symbol=NEOUSDT",
        "connection refused",
    );
    transport.err("https://api.coinbase.com/v2/prices/NEO-USD/spot", "timeout");
    transport.err(
        "https://api.coingecko.com/api/v3/simple/price?ids=neo&vs_currencies=usd",
        "dns failure",
    );
    let error = plane(transport)
        .fetch_prices(&["NEO-USD".to_string()])
        .expect_err("a dead upstream must not read as an empty quote set");
    assert_eq!(error.status, 502);

    // Every venue answered with something unusable — still nothing was said.
    let transport = RecordedQuotes::new();
    transport.ok_status(
        "https://api1.binance.com/api/v3/ticker/price?symbol=NEOUSDT",
        503,
        "service unavailable",
    );
    transport.ok_json(
        "https://api.coinbase.com/v2/prices/NEO-USD/spot",
        "<html>gateway error</html>",
    );
    transport.ok_json(
        "https://api.coingecko.com/api/v3/simple/price?ids=neo&vs_currencies=usd",
        "",
    );
    let error = plane(transport)
        .fetch_prices(&["NEO-USD".to_string()])
        .expect_err("unusable responses from every venue are not a quote set");
    assert_eq!(error.status, 502);

    // ... while venues that answered, and simply disagreed or did not quote,
    // are a refusal, not a failure: the guard did its job.
    let transport = RecordedQuotes::new();
    transport.ok_json(
        "https://api1.binance.com/api/v3/ticker/price?symbol=NEOUSDT",
        r#"{"symbol":"NEOUSDT","price":"100.0"}"#,
    );
    transport.ok_json(
        "https://api.coinbase.com/v2/prices/NEO-USD/spot",
        r#"{"data":{"base":"NEO","currency":"USD","amount":"100.0"}}"#,
    );
    transport.ok_json(
        "https://api.coingecko.com/api/v3/simple/price?ids=neo&vs_currencies=usd",
        r#"{"neo":{}}"#,
    );
    let prices = plane(transport)
        .fetch_prices(&["NEO-USD".to_string()])
        .expect("venues that answered are not an outage");
    assert_eq!(prices.get("NEO-USD"), Some(&100.0));
}

/// Key-free is a property of the requests, not of a comment. Nothing that goes
/// on the wire may authenticate.
#[test]
fn no_request_carries_a_credential() {
    let transport = RecordedQuotes::new();
    transport.ok_json(
        "https://api1.binance.com/api/v3/ticker/price?symbol=NEOUSDT",
        r#"{"price":"100.0"}"#,
    );
    transport.ok_json(
        "https://api.coinbase.com/v2/prices/NEO-USD/spot",
        r#"{"data":{"amount":"110.0"}}"#,
    );
    transport.ok_json(
        "https://api.coingecko.com/api/v3/simple/price?ids=neo&vs_currencies=usd",
        r#"{"neo":{"usd":120.0}}"#,
    );
    let _ = plane(transport.clone())
        .fetch_prices(&["NEO-USD".to_string(), "GAS-USD".to_string()])
        .expect("batch fetch");
    let requests = transport.requests();
    assert!(!requests.is_empty());
    for (method, url, headers) in &requests {
        assert_eq!(method, "GET");
        for (name, _) in headers {
            let lowered = name.to_ascii_lowercase();
            assert!(
                !matches!(
                    lowered.as_str(),
                    "authorization" | "x-api-key" | "proxy-authorization"
                ),
                "request carried a credential header: {name}"
            );
        }
        let query = url.split_once('?').map(|(_, q)| q).unwrap_or("");
        for pair in query.split('&').filter(|pair| !pair.is_empty()) {
            let key = pair.split('=').next().unwrap_or("").to_ascii_lowercase();
            assert!(
                !key.contains("key") && !key.contains("token") && !key.contains("secret"),
                "request carried a credential parameter: {url}"
            );
        }
    }
}

/// The reviewed symbol table is the plane's whole coverage: the crypto block
/// the keyed plane already serves, and no FX. An unmapped symbol is never
/// requested and is absent from the result.
#[test]
fn the_symbol_table_maps_the_crypto_block_and_not_fx() {
    for symbol in [
        "NEO-USD", "GAS-USD", "BTC-USD", "ETH-USD", "SOL-USD", "TRX-USD", "PAXG-USD", "USDT-USD",
        "USDC-USD", "BNB-USD", "XRP-USD", "DOGE-USD",
    ] {
        let ids =
            public_source_symbol_ids(symbol).unwrap_or_else(|| panic!("{symbol} must be mapped"));
        assert!(ids.coingecko.is_some(), "{symbol} needs a coingecko id");
        // USDT-USD has no Binance market (USDTUSDT does not exist).
        if symbol == "USDT-USD" {
            assert!(ids.binance.is_none());
        } else {
            assert!(ids.binance.is_some(), "{symbol} needs a binance symbol");
        }
        assert!(ids.coinbase.is_some(), "{symbol} needs a coinbase pair");
    }

    assert!(public_source_symbol_ids("EUR-USD").is_none());
    assert!(public_source_symbol_ids("GBP-USD").is_none());
    assert!(public_source_symbol_ids("NVDA-USD").is_none());
    assert!(public_source_symbol_ids("not-a-pair").is_none());

    // The Binance venue quotes USDT, not USD — the identifier says so, so the
    // deviation bound is what absorbs the basis rather than a silent rename.
    let ids = public_source_symbol_ids("NEO-USD").expect("mapped");
    assert_eq!(ids.binance, Some("NEOUSDT"));
    assert_eq!(ids.coinbase, Some("NEO-USD"));
    assert_eq!(ids.coingecko, Some("neo"));
}

/// An unmapped symbol is never requested and is simply absent.
#[test]
fn an_unmapped_symbol_is_absent() {
    let transport = RecordedQuotes::new();
    let prices = plane(transport.clone())
        .fetch_prices(&["EUR-USD".to_string()])
        .expect("absence is not a failure");
    assert!(prices.is_empty());
    assert!(transport.requests().is_empty());
}

// ---------------------------------------------------------------------------
// 16. Boot selection — DEC-CU-30: dark and default-off
// ---------------------------------------------------------------------------

#[test]
fn the_price_plane_is_off_unless_explicitly_selected() {
    // Unset, empty and whitespace all keep the keyed plane: nothing changes in
    // a running system until an operator names the quorum.
    for raw in [None, Some(""), Some("   "), Some("twelvedata")] {
        assert_eq!(
            select_price_plane(raw).expect("default plane"),
            PricePlane::TwelveData,
            "raw={raw:?}"
        );
    }
    assert_eq!(
        select_price_plane(Some("public-quorum")).expect("quorum plane"),
        PricePlane::PublicQuorum
    );
    assert_eq!(
        select_price_plane(Some("PUBLIC-QUORUM")).expect("case-insensitive"),
        PricePlane::PublicQuorum
    );

    // An unknown value must not silently fall back to the single-source plane
    // an operator thought they had replaced.
    for raw in ["public_quorum", "quorum", "twelve-data", "1"] {
        assert!(
            select_price_plane(Some(raw)).is_err(),
            "raw={raw:?} must refuse, not fall back"
        );
    }
}
