//! `/feed/sign` fold tests. The tx message and plan-decision vectors were
//! harvested from the repo's own neon-js + feed-pusher (the same pins the
//! `neo-os-core` n3_tx suite carries), so a divergence from the merged
//! Node server's byte stream fails here first. Everything drives the pure
//! dispatch with the support doubles — no socket, no network.

use super::*;
use crate::dispatch::dispatch;
use crate::{DispatchOutcome, RUNTIME_NAME};
use serde_json::json;
use sha2::{Digest, Sha256};

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)] // intentional: one shared doubles file per test module
mod support;
use support::*;

/// Harvested `getMessageForSigning(860833102)` for the 1-symbol vector.
const GOLDEN_MESSAGE_1SYM: &str =
    "4e454f330829a97658267da5fce39aed5bf07acb195bdddb0d9ebba4d9b4f35de051a0d6";
/// Harvested message for the all-zero-fields vector (nonce 0, fees 0).
const GOLDEN_MESSAGE_ZERO_FIELDS: &str =
    "4e454f33e36db879e194fea51ebec92f15167c3d627d35f0e1df7bb624b13ed62a25d0da";
/// The same one-symbol transaction under Testnet T5's magic and deployed
/// MorpheusDataFeed contract.
const TESTNET_MESSAGE_1SYM: &str =
    "4e3354358e46b48cf7dabfbfdd40af856ca28bbe98127e194f50c24efc25539d7710e0ee";

fn plain() -> http::HeaderMap {
    let mut headers = http::HeaderMap::new();
    headers.insert(
        http::header::HOST,
        http::HeaderValue::from_static("127.0.0.1"),
    );
    headers
}

fn bearer_headers() -> http::HeaderMap {
    let mut headers = plain();
    headers.extend(bearer("s3cret"));
    headers
}

fn harness() -> TestState {
    test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    )
}

fn mainnet_harness() -> TestState {
    test_state(
        &[
            ("MORPHEUS_NETWORK", "mainnet"),
            ("NITRO_API_TOKEN", "s3cret"),
        ],
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    )
}

fn harness_with_signer(signer: FakeSigner) -> TestState {
    test_state(
        &healthy_overlay(),
        FakeAttest::with_document(b"doc"),
        signer,
        FakeBridge::new(),
        FakeKms::default(),
    )
}

fn post_feed(harness: &TestState, body: &serde_json::Value) -> DispatchOutcome {
    let mut compatible_body = body.clone();
    let object = compatible_body
        .as_object_mut()
        .expect("feed test body must be a JSON object");
    let default_mode = if harness.state.resolve_network().unwrap() == "testnet" {
        "updateFeed"
    } else {
        "updateFeeds"
    };
    object
        .entry("write_mode")
        .or_insert_with(|| json!(default_mode));
    let default_operation = object
        .get("write_mode")
        .or_else(|| object.get("writeMode"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or(default_mode)
        .to_string();
    object
        .entry("operation")
        .or_insert_with(|| json!(default_operation));
    post_raw_feed(harness, &compatible_body)
}

fn post_raw_feed(harness: &TestState, body: &serde_json::Value) -> DispatchOutcome {
    dispatch(
        &harness.state,
        "POST",
        "/feed/sign",
        &bearer_headers(),
        &body_json(body),
    )
}

fn error_body(message: &str) -> serde_json::Value {
    json!({ "status": "error", "error": message, "runtime": RUNTIME_NAME })
}

/// The 1-symbol golden tx, driven end to end: price 2.0 → px 2000000, a
/// bootstrap-shaped onchain record (round 1000, price 0) planned at now=1001,
/// caller-supplied tx params honored verbatim.
#[test]
fn golden_single_symbol_end_to_end() {
    let harness = mainnet_harness();
    harness.price.set_price("NEO-USD", 2.0);
    let body = json!({
        "symbols": ["NEO-USD"],
        "onchain_state": { "NEO-USD": { "round": 1000, "price": 0, "ts": 1718352000 } },
        "now": 1001,
        "tx_params": { "nonce": 424242, "blockCount": 100000, "systemFee": 1000000000, "networkFee": 1234567 },
    });

    let outcome = post_feed(&harness, &body);
    assert_eq!(outcome.status, 200);
    assert_eq!(outcome.body["status"], "ok");
    assert_eq!(outcome.body["chain"], "neo_n3");
    assert_eq!(outcome.body["pairs"], json!(["TWELVEDATA:NEO-USD"]));
    assert_eq!(outcome.body["rounds"], json!([1001]));
    assert_eq!(outcome.body["prices_scaled"], json!([2000000]));
    assert_eq!(outcome.body["timestamps"], json!([1718352000]));
    assert_eq!(
        outcome.body["attestation_hashes"],
        json!(["0d85465d97521b3659a2de0b338eb032"])
    );
    assert_eq!(outcome.body["source_set_ids"], json!([0]));
    assert_eq!(outcome.body["tx_message_hex"], GOLDEN_MESSAGE_1SYM);
    assert_eq!(outcome.body["tx_nonce"], 424242);
    assert_eq!(outcome.body["valid_until_block"], 100500);
    assert_eq!(outcome.body["trust_tier"], "enclave-attested");
    assert_eq!(outcome.body["skipped"], json!([]));
    assert_eq!(outcome.body["missing"], json!([]));
    // No request freshness nonce → no trailing `nonce` key (JS spread).
    assert!(outcome.body.get("nonce").is_none());

    // The complete unsigned transaction went to custody's semantic
    // transaction route. Its SHA-256 is exactly the message suffix the host
    // returns for independent broadcaster verification.
    let calls = harness.signer.n3_transaction_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "mainnet");
    assert_eq!(calls[0].1, "updater");
    assert!(calls[0].3.starts_with("n3-feed:"));
    let unsigned = hex::decode(&calls[0].2).expect("unsigned transaction hex");
    assert_eq!(
        hex::encode(Sha256::digest(unsigned)),
        &GOLDEN_MESSAGE_1SYM[8..]
    );
}

/// The all-zero-fields vector pins the tx encoder's edge encodings (PUSH0
/// fees, zero nonce, PUSHINT for a 10-digit round) through the fold.
#[test]
fn golden_zero_fields_end_to_end() {
    let harness = mainnet_harness();
    harness.price.set_price("NEO-USD", 0.000001);
    let body = json!({
        "symbols": ["NEO-USD"],
        "onchain_state": { "NEO-USD": { "round": 1756713600, "price": 0, "ts": 0 } },
        "now": 1,
        "tx_params": { "nonce": 0, "blockCount": 0, "systemFee": 0, "networkFee": 0 },
    });

    let outcome = post_feed(&harness, &body);
    assert_eq!(outcome.status, 200);
    assert_eq!(outcome.body["tx_message_hex"], GOLDEN_MESSAGE_ZERO_FIELDS);
    assert_eq!(outcome.body["tx_nonce"], 0);
    assert_eq!(outcome.body["valid_until_block"], 500);
    assert_eq!(outcome.body["rounds"], json!([1756713601]));
}

#[test]
fn testnet_selects_its_measured_magic_and_contract_despite_a_legacy_override() {
    let harness = test_state(
        &[
            ("MORPHEUS_NETWORK", "testnet"),
            ("NITRO_API_TOKEN", "s3cret"),
            // This legacy knob used to let a parent redirect the signature to
            // mainnet. It is deliberately ignored by the Rust authority.
            ("FEED_MAGIC", "860833102"),
        ],
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    harness.price.set_price("NEO-USD", 2.0);
    let outcome = post_feed(
        &harness,
        &json!({
            "write_mode": "updateFeed",
            "operation": "updateFeed",
            "symbols": ["NEO-USD"],
            "onchain_state": { "NEO-USD": { "round": 1000, "price": 0, "ts": 1718352000 } },
            "now": 1001,
            "tx_params": { "nonce": 424242, "blockCount": 100000, "systemFee": 1000000000, "networkFee": 1234567 },
        }),
    );
    assert_eq!(outcome.status, 200, "{:?}", outcome.body);
    assert_eq!(outcome.body["tx_message_hex"], TESTNET_MESSAGE_1SYM);
    let calls = harness.signer.n3_transaction_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "testnet");
    assert_eq!(calls[0].1, "updater");
    let unsigned = hex::decode(&calls[0].2).expect("unsigned transaction hex");
    assert_eq!(
        hex::encode(Sha256::digest(unsigned)),
        &TESTNET_MESSAGE_1SYM[8..]
    );
}

#[test]
fn testnet_per_pair_write_mode_returns_the_singular_update_feed_operation() {
    let harness = test_state(
        &[
            ("MORPHEUS_NETWORK", "testnet"),
            ("NITRO_API_TOKEN", "s3cret"),
        ],
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    harness.price.set_price("NEO-USD", 2.0);
    let outcome = post_feed(
        &harness,
        &json!({
            "chain": "neo_n3",
            "write_mode": "updateFeed",
            "symbols": ["NEO-USD"],
            "onchain_state": { "NEO-USD": { "round": 1000, "price": 0, "ts": 1718352000 } },
            "now": 1001,
            "tx_params": { "nonce": 424242, "blockCount": 100000, "systemFee": 1000000000, "networkFee": 1234567 },
        }),
    );
    assert_eq!(outcome.status, 200, "{}", outcome.body);
    assert_eq!(outcome.body["status"], "ok");
    assert_eq!(outcome.body["write_mode"], "updateFeed");
    assert_eq!(outcome.body["operation"], "updateFeed");
    assert_eq!(outcome.body["pairs"], json!(["TWELVEDATA:NEO-USD"]));

    let per_pair_unsigned = harness.signer.n3_transaction_calls()[0].2.clone();
    let batch_harness = test_state(
        &[
            ("MORPHEUS_NETWORK", "mainnet"),
            ("NITRO_API_TOKEN", "s3cret"),
        ],
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    batch_harness.price.set_price("NEO-USD", 2.0);
    let batch_outcome = post_feed(
        &batch_harness,
        &json!({
            "chain": "neo_n3",
            "symbols": ["NEO-USD"],
            "onchain_state": { "NEO-USD": { "round": 1000, "price": 0, "ts": 1718352000 } },
            "now": 1001,
            "tx_params": { "nonce": 424242, "blockCount": 100000, "systemFee": 1000000000, "networkFee": 1234567 },
        }),
    );
    assert_eq!(batch_outcome.status, 200, "{}", batch_outcome.body);
    let batch_unsigned = batch_harness.signer.n3_transaction_calls()[0].2.clone();
    assert_ne!(per_pair_unsigned, batch_unsigned);
}

#[test]
fn mainnet_rejects_a_per_pair_write_mode_downgrade() {
    let harness = mainnet_harness();
    harness.price.set_price("NEO-USD", 2.0);
    let outcome = post_feed(
        &harness,
        &json!({
            "chain": "neo_n3",
            "write_mode": "updateFeed",
            "symbols": ["NEO-USD"],
            "now": 1001,
            "tx_params": { "nonce": 1, "blockCount": 100, "systemFee": 1, "networkFee": 1 },
        }),
    );
    assert_eq!(outcome.status, 400);
    assert_eq!(
        outcome.body,
        error_body("Neo N3 updateFeed write mode is testnet-only; refusing mainnet downgrade")
    );
    assert!(harness.signer.n3_transaction_calls().is_empty());
}

#[test]
fn testnet_rejects_a_batch_write_mode() {
    let harness = test_state(
        &[
            ("MORPHEUS_NETWORK", "testnet"),
            ("NITRO_API_TOKEN", "s3cret"),
        ],
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    harness.price.set_price("NEO-USD", 2.0);
    let outcome = post_raw_feed(
        &harness,
        &json!({
            "chain": "neo_n3",
            "write_mode": "updateFeeds",
            "operation": "updateFeeds",
            "symbols": ["NEO-USD"],
            "now": 1001,
            "tx_params": { "nonce": 1, "blockCount": 100, "systemFee": 1, "networkFee": 1 },
        }),
    );
    assert_eq!(outcome.status, 400);
    assert_eq!(
        outcome.body,
        error_body("Neo N3 updateFeeds write mode is mainnet-only; refusing TestNet batch")
    );
    assert!(harness.signer.n3_transaction_calls().is_empty());
}

#[test]
fn mismatched_request_operation_is_rejected_before_signing() {
    let harness = test_state(
        &[
            ("MORPHEUS_NETWORK", "testnet"),
            ("NITRO_API_TOKEN", "s3cret"),
        ],
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    harness.price.set_price("NEO-USD", 2.0);
    let outcome = post_feed(
        &harness,
        &json!({
            "chain": "neo_n3",
            "write_mode": "updateFeed",
            "operation": "updateFeeds",
            "symbols": ["NEO-USD"],
            "now": 1001,
            "tx_params": { "nonce": 1, "blockCount": 100, "systemFee": 1, "networkFee": 1 },
        }),
    );
    assert_eq!(outcome.status, 400);
    assert_eq!(
        outcome.body,
        error_body("Neo N3 write mode and operation must match")
    );
    assert!(harness.signer.n3_transaction_calls().is_empty());
}

#[test]
fn missing_n3_mode_fields_are_rejected_before_signing() {
    let harness = harness();
    harness.price.set_price("NEO-USD", 2.0);
    let outcome = post_raw_feed(
        &harness,
        &json!({
            "chain": "neo_n3",
            "symbols": ["NEO-USD"],
            "now": 1001,
            "tx_params": { "nonce": 1, "blockCount": 100, "systemFee": 1, "networkFee": 1 },
        }),
    );
    assert_eq!(outcome.status, 400);
    assert_eq!(outcome.body, error_body("Neo N3 write_mode is required"));
    assert!(harness.signer.n3_transaction_calls().is_empty());
}

#[test]
fn conflicting_write_mode_aliases_are_rejected_before_signing() {
    let harness = harness();
    harness.price.set_price("NEO-USD", 2.0);
    let outcome = post_raw_feed(
        &harness,
        &json!({
            "chain": "neo_n3",
            "write_mode": "updateFeed",
            "writeMode": "updateFeeds",
            "operation": "updateFeed",
            "symbols": ["NEO-USD"],
            "now": 1001,
            "tx_params": { "nonce": 1, "blockCount": 100, "systemFee": 1, "networkFee": 1 },
        }),
    );
    assert_eq!(outcome.status, 400);
    assert_eq!(
        outcome.body,
        error_body("Neo N3 write_mode aliases conflict")
    );
    assert!(harness.signer.n3_transaction_calls().is_empty());
}

#[test]
fn conflicting_operation_aliases_are_rejected_before_signing() {
    let harness = harness();
    harness.price.set_price("NEO-USD", 2.0);
    let outcome = post_raw_feed(
        &harness,
        &json!({
            "chain": "neo_n3",
            "write_mode": "updateFeed",
            "operation": "updateFeed",
            "op": "updateFeeds",
            "symbols": ["NEO-USD"],
            "now": 1001,
            "tx_params": { "nonce": 1, "blockCount": 100, "systemFee": 1, "networkFee": 1 },
        }),
    );
    assert_eq!(outcome.status, 400);
    assert_eq!(
        outcome.body,
        error_body("Neo N3 operation aliases conflict")
    );
    assert!(harness.signer.n3_transaction_calls().is_empty());
}

/// `legacy` is an alias of the N3 lane (the mjs treats it identically) and
/// the response chain is always `neo_n3`.
#[test]
fn legacy_chain_runs_the_n3_lane() {
    let harness = harness();
    harness.price.set_price("NEO-USD", 2.0);
    let body = json!({
        "chain": "legacy",
        "symbols": ["NEO-USD"],
        "onchain_state": { "NEO-USD": { "round": 1000, "price": 0, "ts": 1718352000 } },
        "now": 1001,
        "tx_params": { "nonce": 424242, "blockCount": 100000, "systemFee": 1000000000, "networkFee": 1234567 },
    });
    let outcome = post_feed(&harness, &body);
    assert_eq!(outcome.status, 200);
    assert_eq!(outcome.body["status"], "ok");
    assert_eq!(outcome.body["chain"], "neo_n3");
}

#[test]
fn neox_lane_builds_vector_locked_calldata_and_uses_chain_bound_custody() {
    let harness = harness();
    harness.price.set_price("NEO-USD", 5.25);
    let outcome = post_feed(
        &harness,
        &json!({
            "chain": "neox",
            "symbols": ["NEO-USD"],
            "onchain_state": {
                "NEO-USD": { "round": 1_779_999_940, "price": 5.0, "timestamp": 1_779_999_940 }
            },
            "now": 1_780_000_000,
            "tx_params": {
                "to": "0x38DD6BCEBDD47f4234AE11760CEFB58f9ae6a3bB",
                "from": "0x1111111111111111111111111111111111111111",
                "chain_id": 12_227_332,
                "nonce": 7,
                "gas_limit": "2000000",
                "max_fee_per_gas": "50000000000",
                "max_priority_fee_per_gas": "1000000000"
            }
        }),
    );
    assert_eq!(outcome.status, 200, "{}", outcome.body);
    assert_eq!(outcome.body["status"], "ok");
    assert_eq!(outcome.body["chain"], "neox");
    assert_eq!(outcome.body["chain_id"], 12_227_332);
    assert_eq!(outcome.body["nonce"], 7);
    assert_eq!(outcome.body["symbols"], json!(["TWELVEDATA:NEO-USD"]));
    assert_eq!(outcome.body["prices_scaled"], json!(["5250000"]));
    assert_eq!(outcome.body["timestamps"], json!(["1780000000"]));
    assert_eq!(outcome.body["round_ids"], json!(["1780000000"]));
    assert_eq!(
        outcome.body["from"],
        "0x1111111111111111111111111111111111111111"
    );
    assert_eq!(
        outcome.body["to"],
        "0x38dd6bcebdd47f4234ae11760cefb58f9ae6a3bb"
    );
    assert_eq!(
        outcome.body["data"],
        "0x8df5110100000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000001800000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000125457454c5645444154413a4e454f2d555344000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000501bd00000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000006a18a5000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000006a18a500"
    );
    assert!(outcome.body["signed_tx"]
        .as_str()
        .is_some_and(|value| value.starts_with("0x02")));
    let calls = harness.signer.transaction_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, TEST_NETWORK);
    assert_eq!(calls[0].1, "neox_updater");
    assert_eq!(calls[0].2, 12_227_332);
    assert!(calls[0].3.starts_with("0x02"));
    assert!(calls[0].4.starts_with("feed-neox:"));
}

#[test]
fn neox_lane_requires_pinned_transaction_fields() {
    let harness = harness();
    harness.price.set_price("NEO-USD", 5.25);
    let outcome = post_feed(
        &harness,
        &json!({ "chain": "neox", "symbols": ["NEO-USD"] }),
    );
    assert_eq!(outcome.status, 400);
    assert_eq!(
        outcome.body,
        error_body("neox tx_params.to (feed contract) is required")
    );
    assert!(harness.signer.transaction_calls().is_empty());
}

#[test]
fn neox_lane_rejects_custody_transaction_substitution() {
    let signer = FakeSigner::new(SignerConfig {
        transaction_result: Some(Ok(json!({
            "address": "0x1111111111111111111111111111111111111111",
            "signed_transaction": "0x02c0"
        }))),
        ..SignerConfig::default()
    });
    let harness = harness_with_signer(signer);
    harness.price.set_price("NEO-USD", 5.25);
    let outcome = post_feed(
        &harness,
        &json!({
            "chain": "neox",
            "symbols": ["NEO-USD"],
            "now": 1_780_000_000,
            "tx_params": {
                "to": "0x38DD6BCEBDD47f4234AE11760CEFB58f9ae6a3bB",
                "chain_id": 12_227_332,
                "nonce": 7,
                "gas_limit": 2_000_000,
                "max_fee_per_gas": 50_000_000_000u64,
                "max_priority_fee_per_gas": 1_000_000_000u64
            }
        }),
    );
    assert_eq!(outcome.status, 502);
    assert_eq!(
        outcome.body,
        error_body("neox custody returned a malformed signed EIP-1559 transaction")
    );
}

#[test]
fn symbols_are_required() {
    let harness = harness();
    for body in [
        json!({}),
        json!({ "symbols": [] }),
        json!({ "symbols": ["  ", ""] }),
        json!({ "symbols": "NEO-USD" }),
        json!({ "symbols": [7] }),
    ] {
        let outcome = post_feed(&harness, &body);
        assert_eq!(outcome.status, 400, "{body}");
        assert_eq!(outcome.body, error_body("symbols[] is required"), "{body}");
    }
}

#[test]
fn the_auth_gate_still_applies() {
    let harness = harness();
    let outcome = dispatch(
        &harness.state,
        "POST",
        "/feed/sign",
        &plain(),
        &body_json(&json!({ "symbols": ["NEO-USD"] })),
    );
    assert_eq!(outcome.status, 401);
    assert_eq!(outcome.body, error_body("unauthorized"));
}

/// The no-update branch: every plan array empty, null signature fields, and
/// NO tx_nonce/valid_until_block keys (the mjs only emits those on the ok
/// branch).
#[test]
fn no_update_response_shape() {
    let harness = harness();
    harness.price.set_price("NEO-USD", 2.0);
    let body = json!({
        "symbols": ["NEO-USD"],
        "onchain_state": { "NEO-USD": { "round": 1756713500, "price": 2.0, "ts": 1756713500 } },
        "now": 1756713600,
        "nonce": " 0xAB ",
    });
    let outcome = post_feed(&harness, &body);
    assert_eq!(outcome.status, 200);
    assert_eq!(outcome.body["status"], "no-update");
    assert_eq!(outcome.body["chain"], "neo_n3");
    assert_eq!(outcome.body["pairs"], json!([]));
    assert_eq!(outcome.body["rounds"], json!([]));
    assert_eq!(outcome.body["prices_scaled"], json!([]));
    assert_eq!(outcome.body["timestamps"], json!([]));
    assert_eq!(outcome.body["attestation_hashes"], json!([]));
    assert_eq!(outcome.body["source_set_ids"], json!([]));
    assert_eq!(outcome.body["tx_message_hex"], serde_json::Value::Null);
    assert_eq!(outcome.body["signature"], serde_json::Value::Null);
    assert_eq!(outcome.body["public_key"], serde_json::Value::Null);
    assert_eq!(outcome.body["trust_tier"], "enclave-attested");
    assert_eq!(
        outcome.body["skipped"],
        json!([{ "symbol": "NEO-USD", "reason": "unchanged_recent" }])
    );
    assert_eq!(outcome.body["missing"], json!([]));
    // The freshness nonce normalizes (trim + 0x strip + lowercase) and rides
    // the response; tx_nonce/valid_until_block stay absent.
    assert_eq!(outcome.body["nonce"], "ab");
    assert!(outcome.body.get("tx_nonce").is_none());
    assert!(outcome.body.get("valid_until_block").is_none());

    // Key order of the no-update branch.
    let text = serde_json::to_string(&outcome.body).expect("body serializes");
    let order_of = |key: &str| text.find(&format!("\"{key}\":")).expect(key);
    let mut previous = order_of("status");
    for key in [
        "chain",
        "pairs",
        "rounds",
        "prices_scaled",
        "timestamps",
        "attestation_hashes",
        "source_set_ids",
        "tx_message_hex",
        "signature",
        "public_key",
        "trust_tier",
        "skipped",
        "missing",
        "nonce",
    ] {
        let position = order_of(key);
        assert!(position > previous, "{key} out of order");
        previous = position;
    }
}

/// An unmapped symbol is never guessed at: it still rides the fetcher call
/// (as the literal "null" TwelveData symbol) and comes back `missing`, while
/// the mapped sibling pushes.
#[test]
fn unmapped_symbols_come_back_missing_but_ride_the_fetch() {
    let harness = harness();
    harness.price.set_price("NEO-USD", 2.0);
    let body = json!({
        "symbols": ["NEO-USD", "FOO-USD"],
        "now": 1001,
        "tx_params": { "nonce": 424242, "blockCount": 100000, "systemFee": 1000000000, "networkFee": 1234567 },
    });
    let outcome = post_feed(&harness, &body);
    assert_eq!(outcome.status, 200);
    assert_eq!(outcome.body["status"], "ok");
    assert_eq!(outcome.body["pairs"], json!(["TWELVEDATA:NEO-USD"]));
    assert_eq!(outcome.body["missing"], json!(["FOO-USD"]));
    assert_eq!(
        harness.price.calls(),
        vec![vec!["NEO-USD".to_string(), "FOO-USD".to_string()]]
    );
}

/// `resolveUpdaterIdentity` runs BEFORE the tx-params provider: an
/// unconfigured updater 503s with its own message even without tx_params.
#[test]
fn unconfigured_updater_503s_before_the_params_check() {
    let harness = harness_with_signer(FakeSigner::unconfigured());
    harness.price.set_price("NEO-USD", 2.0);
    let outcome = post_feed(&harness, &json!({ "symbols": ["NEO-USD"], "now": 1001 }));
    assert_eq!(outcome.status, 503);
    assert_eq!(
        outcome.body,
        error_body("updater signer is not configured or does not match pinned identity")
    );
}

/// Without tx_params the (unwired) RPC provider lane 503s — the JS default
/// provider's message, verbatim.
#[test]
fn missing_tx_params_503s_with_the_provider_message() {
    let harness = harness();
    harness.price.set_price("NEO-USD", 2.0);
    let outcome = post_feed(&harness, &json!({ "symbols": ["NEO-USD"], "now": 1001 }));
    assert_eq!(outcome.status, 503);
    assert_eq!(
        outcome.body,
        error_body(
            "feed tx network params (block_count/system_fee/network_fee) unavailable: supply tx_params in the request or configure an RPC provider"
        )
    );
}

/// The fixed security ceilings and the block range, with the boundary values
/// passing and snake_case keys accepted.
#[test]
fn tx_param_ceilings_and_boundaries() {
    let ceiling = |tx_params: serde_json::Value| {
        let harness = harness();
        harness.price.set_price("NEO-USD", 2.0);
        let body = json!({
            "symbols": ["NEO-USD"],
            "onchain_state": { "NEO-USD": { "round": 1000, "price": 0, "ts": 1718352000 } },
            "now": 1001,
            "tx_params": tx_params,
        });
        post_feed(&harness, &body)
    };

    // Block range: the top boundary passes (valid_until 0xffffffff)...
    let outcome = ceiling(
        json!({ "nonce": 1, "blockCount": 4294966795u64, "systemFee": 1, "networkFee": 1 }),
    );
    assert_eq!(outcome.status, 200);
    assert_eq!(outcome.body["valid_until_block"], 4294967295u64);
    // ...one past it fails.
    let outcome = ceiling(
        json!({ "nonce": 1, "blockCount": 4294966796u64, "systemFee": 1, "networkFee": 1 }),
    );
    assert_eq!(outcome.status, 400);
    assert_eq!(
        outcome.body,
        error_body("feed tx block_count is outside the supported Neo N3 range")
    );
    // Non-integer / negative block counts land in the same message.
    for block_count in [100.5, -1.0] {
        let outcome = ceiling(
            json!({ "nonce": 1, "blockCount": block_count, "systemFee": 1, "networkFee": 1 }),
        );
        assert_eq!(outcome.status, 400, "{block_count}");
    }

    // System fee ceiling (10 GAS).
    let outcome =
        ceiling(json!({ "nonce": 1, "blockCount": 100, "systemFee": 1000000000, "networkFee": 1 }));
    assert_eq!(outcome.status, 200);
    let outcome = ceiling(
        json!({ "nonce": 1, "blockCount": 100, "systemFee": 1000000001u64, "networkFee": 1 }),
    );
    assert_eq!(outcome.status, 400);
    assert_eq!(
        outcome.body,
        error_body("feed tx system_fee exceeds the enclave safety ceiling")
    );

    // Network fee ceiling (2 GAS).
    let outcome =
        ceiling(json!({ "nonce": 1, "blockCount": 100, "systemFee": 1, "networkFee": 200000000 }));
    assert_eq!(outcome.status, 200);
    let outcome = ceiling(
        json!({ "nonce": 1, "blockCount": 100, "systemFee": 1, "networkFee": 200000001u64 }),
    );
    assert_eq!(outcome.status, 400);
    assert_eq!(
        outcome.body,
        error_body("feed tx network_fee exceeds the enclave safety ceiling")
    );

    // snake_case keys are the same inputs.
    let outcome =
        ceiling(json!({ "nonce": 1, "block_count": 10, "system_fee": 2, "network_fee": 3 }));
    assert_eq!(outcome.status, 200);
    assert_eq!(outcome.body["valid_until_block"], 510);
}

/// The tx nonce precedence chain: `tx_params.nonce` → `tx_params.tx_nonce` →
/// body `tx_nonce`; out-of-range/garbage falls to the freshness nonce's
/// sha256 prefix, or a random uint32 when none was supplied.
#[test]
fn tx_nonce_precedence() {
    let nonce_for = |body: serde_json::Value| {
        let harness = harness();
        harness.price.set_price("NEO-USD", 2.0);
        let mut full = json!({
            "symbols": ["NEO-USD"],
            "onchain_state": { "NEO-USD": { "round": 1000, "price": 0, "ts": 1718352000 } },
            "now": 1001,
        });
        let object = full.as_object_mut().expect("object");
        for (key, value) in body.as_object().expect("body object") {
            object.insert(key.clone(), value.clone());
        }
        post_feed(&harness, &full).body["tx_nonce"].clone()
    };

    let params = json!({ "blockCount": 100, "systemFee": 1, "networkFee": 1 });
    let mut with_key = params.clone();
    with_key["nonce"] = json!(7);
    with_key["tx_nonce"] = json!(8);
    assert_eq!(nonce_for(json!({ "tx_params": with_key })), 7);

    let mut tx_nonce_only = params.clone();
    tx_nonce_only["tx_nonce"] = json!(8);
    let body = json!({ "tx_params": tx_nonce_only, "tx_nonce": 9 });
    assert_eq!(nonce_for(body), 8);

    let body = json!({ "tx_params": params, "tx_nonce": 9 });
    assert_eq!(nonce_for(body), 9);

    // A garbage supplied nonce falls through to the freshness nonce:
    // first four bytes of sha256(Buffer.from(nonce, 'hex')), big-endian.
    let digest = Sha256::digest([0x00, 0xff]);
    let expected = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    let body = json!({ "tx_params": params, "tx_nonce": "garbage", "nonce": "00ff" });
    assert_eq!(nonce_for(body), expected);

    // With neither a usable supply nor a freshness nonce, a random uint32
    // still lands in range.
    let body = json!({ "tx_params": params, "tx_nonce": "garbage" });
    let tx_nonce = nonce_for(body);
    let tx_nonce = tx_nonce.as_u64().expect("integer nonce");
    assert!(tx_nonce <= 0xffffffff);
}

/// `planFeedUpdate`'s decision table, pinned against the real function's
/// outputs harvested from feed-pusher.mjs.
#[test]
fn plan_decision_vectors_match_feed_pusher() {
    fn record(round: f64, price: f64, ts: f64) -> OnchainRecord {
        OnchainRecord { round, price, ts }
    }
    fn thresholds() -> FeedThresholds {
        FeedThresholds {
            threshold_bps: 10.0,
            max_stale_sec: 1800.0,
            max_deviation_bps: 5000.0,
        }
    }
    let now = 1756713600.0;
    struct PlanCase {
        label: &'static str,
        current: OnchainRecord,
        new_price: f64,
        push: bool,
        round: f64,
        ts: f64,
        rejected: Option<&'static str>,
    }
    let cases = [
        PlanCase {
            label: "bootstrap",
            current: record(0.0, 0.0, 0.0),
            new_price: 1.5,
            push: true,
            round: 1756713600.0,
            ts: 1756713600.0,
            rejected: None,
        },
        PlanCase {
            label: "unchanged_recent",
            current: record(1756713500.0, 1.5, 1756713500.0),
            new_price: 1.500001,
            push: false,
            round: 1756713500.0,
            ts: 1756713500.0,
            rejected: None,
        },
        PlanCase {
            label: "small_move_push",
            current: record(1756713500.0, 1.5, 1756713500.0),
            new_price: 1.51,
            push: true,
            round: 1756713600.0,
            ts: 1756713600.0,
            rejected: None,
        },
        PlanCase {
            label: "deviation_spike",
            current: record(0.0, 1.0, 0.0),
            new_price: 2.0,
            push: false,
            round: 0.0,
            ts: 0.0,
            rejected: Some("deviation_spike"),
        },
        PlanCase {
            label: "invalid_price_zero",
            current: record(10.0, 1.0, 10.0),
            new_price: 0.0,
            push: false,
            round: 10.0,
            ts: 10.0,
            rejected: Some("invalid_price"),
        },
        PlanCase {
            label: "invalid_price_negative",
            current: record(10.0, 1.0, 10.0),
            new_price: -3.2,
            push: false,
            round: 10.0,
            ts: 10.0,
            rejected: Some("invalid_price"),
        },
        PlanCase {
            label: "stale_round_push",
            current: record(1756711600.0, 1.5, 1756711600.0),
            new_price: 1.5,
            push: true,
            round: 1756713600.0,
            ts: 1756713600.0,
            rejected: None,
        },
        PlanCase {
            label: "round_arithmetic_now_wins",
            current: record(1756713100.0, 1.5, 5.0),
            new_price: 1.6,
            push: true,
            round: 1756713600.0,
            ts: 1756713600.0,
            rejected: None,
        },
        PlanCase {
            label: "round_arithmetic_cur_wins",
            current: record(1756714100.0, 1.5, 1756713605.0),
            new_price: 1.6,
            push: true,
            round: 1756714101.0,
            ts: 1756713605.0,
            rejected: None,
        },
        PlanCase {
            label: "ts_monotonic",
            current: record(0.0, 1.5, 1756713642.0),
            new_price: 1.6,
            push: true,
            round: 1756713600.0,
            ts: 1756713642.0,
            rejected: None,
        },
        PlanCase {
            label: "onchain_negative_price_exempt",
            current: record(0.0, -1.0, 0.0),
            new_price: 1.5,
            push: true,
            round: 1756713600.0,
            ts: 1756713600.0,
            rejected: None,
        },
    ];
    for case in &cases {
        let plan = plan_feed_update(&case.current, case.new_price, now, &thresholds());
        assert_eq!(plan.push, case.push, "{} push", case.label);
        assert_eq!(plan.round, case.round, "{} round", case.label);
        assert_eq!(plan.ts, case.ts, "{} ts", case.label);
        assert_eq!(plan.rejected, case.rejected, "{} rejected", case.label);
    }
}

/// `normalizeOnchainState` through the fold: string fields coerce (JS
/// Number), a null `timestamp` falls through to `ts`, non-object entries are
/// skipped.
#[test]
fn onchain_state_normalization() {
    let harness = harness();
    harness.price.set_price("NEO-USD", 1.6);
    let body = json!({
        "symbols": ["NEO-USD"],
        "onchain_state": {
            "NEO-USD": { "round": "500", "price": "1.5", "timestamp": null, "ts": 7 },
            "GARBAGE": "not an object",
        },
        "now": 1,
        "tx_params": { "nonce": 1, "blockCount": 100, "systemFee": 1, "networkFee": 1 },
    });
    let outcome = post_feed(&harness, &body);
    assert_eq!(outcome.status, 200);
    assert_eq!(outcome.body["rounds"], json!([501]));
    assert_eq!(outcome.body["prices_scaled"], json!([1600000]));
    assert_eq!(outcome.body["timestamps"], json!([7]));
}

/// The plan's invalid_price guard through the fold: the fake returns a
/// non-positive quote (the production fetcher would drop it, but the guard
/// is the backstop) and the symbol lands in `skipped`, not the tx.
#[test]
fn a_non_positive_quote_is_rejected_not_signed() {
    let harness = harness();
    harness.price.set_price("NEO-USD", 0.0);
    let outcome = post_feed(
        &harness,
        &json!({ "symbols": ["NEO-USD"], "now": 1756713600 }),
    );
    assert_eq!(outcome.status, 200);
    assert_eq!(outcome.body["status"], "no-update");
    assert_eq!(
        outcome.body["skipped"],
        json!([{ "symbol": "NEO-USD", "reason": "invalid_price" }])
    );
}

/// A price-plane failure surfaces as the dispatch catch-all's 500.
#[test]
fn a_price_fetch_failure_is_a_500() {
    let harness = harness();
    harness.price.set_error("fetch failed");
    let outcome = post_feed(&harness, &json!({ "symbols": ["NEO-USD"] }));
    assert_eq!(outcome.status, 500);
    assert_eq!(outcome.body, error_body("fetch failed"));
}

/// The env-tunable thresholds read the overlay: only an absent/EMPTY value
/// falls back, so "0" is a real zero (admin override), not the default.
#[test]
fn threshold_env_overrides_take_effect() {
    // MAX_STALE_SEC=0 makes every round stale → the unchanged_recent pair
    // pushes after all.
    let harness = test_state(
        &[
            ("MORPHEUS_NETWORK", TEST_NETWORK),
            ("NITRO_API_TOKEN", "s3cret"),
            ("MAX_STALE_SEC", "0"),
        ],
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    harness.price.set_price("NEO-USD", 2.0);
    let body = json!({
        "symbols": ["NEO-USD"],
        "onchain_state": { "NEO-USD": { "round": 1756713500, "price": 2.0, "ts": 1756713500 } },
        "now": 1756713600,
        "tx_params": { "nonce": 1, "blockCount": 100, "systemFee": 1, "networkFee": 1 },
    });
    let outcome = post_feed(&harness, &body);
    assert_eq!(outcome.status, 200);
    assert_eq!(outcome.body["status"], "ok");

    // THRESHOLD_BPS=0 makes any move count as changed (0.0 < 0 is false).
    let harness = test_state(
        &[
            ("MORPHEUS_NETWORK", TEST_NETWORK),
            ("NITRO_API_TOKEN", "s3cret"),
            ("THRESHOLD_BPS", "0"),
        ],
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    harness.price.set_price("NEO-USD", 2.0);
    let body = json!({
        "symbols": ["NEO-USD"],
        "onchain_state": { "NEO-USD": { "round": 1756713500, "price": 2.0, "ts": 1756713500 } },
        "now": 1756713600,
        "tx_params": { "nonce": 1, "blockCount": 100, "systemFee": 1, "networkFee": 1 },
    });
    let outcome = post_feed(&harness, &body);
    assert_eq!(outcome.status, 200);
    assert_eq!(outcome.body["status"], "ok");
}

/// The ok branch's key order — the mjs builds the response object in a fixed
/// insertion order and the parity tests compare serialized bodies.
#[test]
fn ok_response_key_order() {
    let harness = harness();
    harness.price.set_price("NEO-USD", 2.0);
    let body = json!({
        "symbols": ["NEO-USD"],
        "onchain_state": { "NEO-USD": { "round": 1000, "price": 0, "ts": 1718352000 } },
        "now": 1001,
        "nonce": "0xAB",
        "tx_params": { "nonce": 424242, "blockCount": 100000, "systemFee": 1000000000, "networkFee": 1234567 },
    });
    let outcome = post_feed(&harness, &body);
    assert_eq!(outcome.status, 200);
    assert_eq!(outcome.body["nonce"], "ab");

    let text = serde_json::to_string(&outcome.body).expect("body serializes");
    let order_of = |key: &str| text.find(&format!("\"{key}\":")).expect(key);
    let mut previous = order_of("status");
    for key in [
        "chain",
        "pairs",
        "rounds",
        "prices_scaled",
        "timestamps",
        "attestation_hashes",
        "source_set_ids",
        "tx_message_hex",
        "tx_nonce",
        "valid_until_block",
        "signature",
        "public_key",
        "trust_tier",
        "skipped",
        "missing",
        "nonce",
    ] {
        let position = order_of(key);
        assert!(position > previous, "{key} out of order");
        previous = position;
    }
}

#[test]
fn feed_identity_rejects_unknown_network_without_testnet_fallback() {
    assert!(feed_magic("staging").is_err());
    assert!(feed_n3_contract("staging").is_err());
}
