//! The `/feed/sign` fold — `handleFeedSign` (enclave-server.mjs:1257) plus
//! the feed-pusher planning core it imports. Price fetch, `planFeedUpdate`,
//! scaling, the `updateFeeds` tx build, and the updater's policy-checked
//! transaction witness —
//! the whole feed value+decision+sign chain, inside the measured boundary.
//! The wire encoding rides [`neo_os_core::n3_tx`], pinned byte-exact
//! against the repo's own neon-js; the signing message goes to the custody
//! plane's `updater` role as a complete unsigned Neo N3 transaction. Custody
//! parses the invocation and applies its transaction policy before signing.
//!
//! Divergences from the merged server, all deliberate:
//!   - The tx-params RPC provider is not wired; the no-`tx_params` path
//!     returns the default provider's 503, verbatim.
//!   - Network magic and the feed contract are selected only from the
//!     measured `MORPHEUS_NETWORK`; an untrusted parent cannot redirect a
//!     signed update to the other network. `THRESHOLD_BPS` / `MAX_STALE_SEC`
//!     / `MAX_DEVIATION_BPS` / the TwelveData timeout read the LIVE overlay per
//!     request where the mjs froze them at module load — observably
//!     identical for boot-time configuration.
//!   - A custody sign reply without `signature`/`public_key` omits the key
//!     (JS's undefined-drop) instead of emitting null.

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use neo_os_compute::js::{js_number, js_number_to_string, js_number_value, js_to_number};
use neo_os_core::n3_tx::{create_invoke_script, ContractParam, FeedSigner, FeedTx};
use rlp::{Rlp, RlpStream};
use sha2::{Digest, Sha256};
use sha3::Keccak256;

use crate::fulfill::js_truthy;
use crate::http_error;
use crate::overlay::EnvOverlay;
use crate::state::{AppState, PriceSource};
use crate::RuntimeError;

const FEED_N3_MAINNET_MAGIC: u32 = 860_833_102;
const FEED_N3_TESTNET_MAGIC: u32 = 894_710_606;
/// Network-pinned deployed MorpheusDataFeed script hashes. These bytes use
/// the same display order as the registry and `create_invoke_script`.
const FEED_N3_MAINNET_CONTRACT: [u8; 20] = [
    0x03, 0x01, 0x3f, 0x49, 0xc4, 0x2a, 0x14, 0x54, 0x6c, 0x8b, 0xbe, 0x58, 0xf9, 0xd4, 0x34, 0xc3,
    0x51, 0x7f, 0xcc, 0xab,
];
const FEED_N3_TESTNET_CONTRACT: [u8; 20] = [
    0x9b, 0xea, 0x75, 0xcf, 0x70, 0x2f, 0x6a, 0xfc, 0x09, 0x12, 0x5a, 0xa6, 0xd2, 0x2f, 0x08, 0x2b,
    0xfd, 0x2e, 0xe0, 0x64,
];
const FEED_N3_PAIR_PREFIX: &str = "TWELVEDATA:";
/// `px = Math.round(price * FEED_PRICE_SCALE)` — the contract's 6-dp fixed point.
const FEED_PRICE_SCALE: f64 = 1e6;
/// `validUntilBlock = blockCount + FEED_VALID_UNTIL_OFFSET`.
const FEED_VALID_UNTIL_OFFSET: f64 = 500.0;
const FEED_TD_TIMEOUT_DEFAULT_MS: f64 = 25_000.0;
/// Fixed security ceilings (1 GAS = 1e8): the untrusted parent supplies fee
/// estimates, but must not turn the updater into a GAS-draining signer.
const FEED_N3_MAX_SYSTEM_FEE: f64 = 10.0 * 1e8;
const FEED_N3_MAX_NETWORK_FEE: f64 = 2.0 * 1e8;
const NEOX_FEED_PAIR_PREFIX: &str = "TWELVEDATA:";
const NEOX_FEED_PRICE_SCALE: f64 = 1e6;
const NEOX_UPDATE_FEEDS_SIGNATURE: &str = "updateFeeds(string[],uint256[],uint256[],uint256[])";
const MAX_NEOX_FEED_SYMBOLS: usize = 128;

pub fn handle_feed_sign(
    state: &AppState,
    body: &serde_json::Value,
) -> Result<serde_json::Value, RuntimeError> {
    let chain = normalize_chain(body.get("chain"));
    if chain == "neox" {
        return handle_neox_feed_sign(state, body);
    }
    // `chain` is now neo_n3 or legacy — both run the N3 lane, `legacy` as an
    // alias. The mjs's `unsupported feed chain` 400 is unreachable there
    // (normalizeChain only returns these three) and stays unreachable here.

    let symbols: Vec<String> = match body.get("symbols") {
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .map(|item| enclave_trim_string(Some(item)))
            .filter(|symbol| !symbol.is_empty())
            .collect(),
        _ => Vec::new(),
    };
    if symbols.is_empty() {
        return Err(http_error(400, "symbols[] is required"));
    }

    let raw_state = match body.get("onchain_state") {
        Some(value) if js_truthy(value) => Some(value),
        _ => body.get("onchainState").filter(|value| js_truthy(value)),
    };
    let onchain_state = normalize_onchain_state(raw_state);

    let nonce = normalize_hex_value(body.get("nonce"));
    let now = match body.get("now") {
        Some(value) => {
            let parsed = js_to_number(value);
            if parsed.is_finite() {
                parsed.floor()
            } else {
                wall_clock_now()
            }
        }
        None => wall_clock_now(),
    };

    let overlay = state.overlay.read().expect("overlay lock").merged_map();
    let thresholds = feed_thresholds(&overlay);

    // (1) COMPUTE: fetch prices in-enclave (mirrors feed-pusher's td()).
    let prices = state.price.fetch_prices(&symbols)?;

    // (2)+(3) PLAN + SCALE — identical arrays to feed-pusher.mjs pushNeoN3.
    let mut planned_pairs: Vec<ContractParam> = Vec::new();
    let mut planned_rounds: Vec<ContractParam> = Vec::new();
    let mut planned_prices: Vec<ContractParam> = Vec::new();
    let mut planned_timestamps: Vec<ContractParam> = Vec::new();
    let mut planned_hashes: Vec<ContractParam> = Vec::new();
    let mut planned_sources: Vec<ContractParam> = Vec::new();
    let mut pairs: Vec<serde_json::Value> = Vec::new();
    let mut rounds: Vec<serde_json::Value> = Vec::new();
    let mut prices_scaled: Vec<serde_json::Value> = Vec::new();
    let mut timestamps: Vec<serde_json::Value> = Vec::new();
    let mut attestation_hashes: Vec<serde_json::Value> = Vec::new();
    let mut source_set_ids: Vec<serde_json::Value> = Vec::new();
    let mut skipped: Vec<serde_json::Value> = Vec::new();
    let mut missing: Vec<serde_json::Value> = Vec::new();

    for symbol in &symbols {
        let Some(&price) = prices.get(symbol) else {
            missing.push(serde_json::Value::String(symbol.clone()));
            continue;
        };
        let current = onchain_state.get(symbol).copied().unwrap_or(OnchainRecord {
            round: 0.0,
            price: 0.0,
            ts: 0.0,
        });
        let px = (price * FEED_PRICE_SCALE).round();
        let plan = plan_feed_update(&current, price, now, &thresholds);
        if !plan.push {
            skipped.push(serde_json::json!({
                "symbol": symbol,
                "reason": plan.rejected.unwrap_or("unchanged_recent"),
            }));
            continue;
        }
        let round = plan.round;
        let ts = plan.ts;
        let attestation_hash = hex::encode(sha256(
            format!(
                "{symbol}|{}|{}",
                js_number_to_string(px),
                js_number_to_string(ts)
            )
            .as_bytes(),
        ))[..32]
            .to_string();
        let pair = format!("{FEED_N3_PAIR_PREFIX}{symbol}");
        planned_pairs.push(ContractParam::String(pair.clone()));
        planned_rounds.push(ContractParam::Integer(contract_integer(round)));
        planned_prices.push(ContractParam::Integer(contract_integer(px)));
        planned_timestamps.push(ContractParam::Integer(contract_integer(ts)));
        planned_hashes.push(ContractParam::Base64Bytes(attestation_hash.clone()));
        planned_sources.push(ContractParam::Integer(0));
        pairs.push(serde_json::Value::String(pair));
        rounds.push(js_number_value(round));
        prices_scaled.push(js_number_value(px));
        timestamps.push(js_number_value(ts));
        attestation_hashes.push(serde_json::Value::String(attestation_hash));
        source_set_ids.push(serde_json::json!(0));
    }

    // No symbol cleared the push decision — nothing to sign (matches
    // feed-pusher's "no updates" branch; not an error).
    if planned_pairs.is_empty() {
        let mut response = serde_json::Map::new();
        response.insert("status".into(), serde_json::json!("no-update"));
        response.insert("chain".into(), serde_json::json!("neo_n3"));
        response.insert("pairs".into(), serde_json::Value::Array(Vec::new()));
        response.insert("rounds".into(), serde_json::Value::Array(Vec::new()));
        response.insert("prices_scaled".into(), serde_json::Value::Array(Vec::new()));
        response.insert("timestamps".into(), serde_json::Value::Array(Vec::new()));
        response.insert(
            "attestation_hashes".into(),
            serde_json::Value::Array(Vec::new()),
        );
        response.insert(
            "source_set_ids".into(),
            serde_json::Value::Array(Vec::new()),
        );
        response.insert("tx_message_hex".into(), serde_json::Value::Null);
        response.insert("signature".into(), serde_json::Value::Null);
        response.insert("public_key".into(), serde_json::Value::Null);
        response.insert("trust_tier".into(), serde_json::json!("enclave-attested"));
        response.insert("skipped".into(), serde_json::Value::Array(skipped));
        response.insert("missing".into(), serde_json::Value::Array(missing));
        if !nonce.is_empty() {
            response.insert("nonce".into(), serde_json::json!(nonce));
        }
        return Ok(serde_json::Value::Object(response));
    }

    // The updater identity drives the tx signer's account; resolve it before
    // building the tx so the message binds the SAME signer that signs it.
    let network = state.resolve_network();
    let updater_script_hash = resolve_updater_script_hash(state, &network)?;

    // RPC-derived tx params (block count + fees). The caller may supply them
    // directly — the relayer/feed-pusher already read them on the host.
    let supplied_params = match body.get("tx_params") {
        Some(value @ (serde_json::Value::Object(_) | serde_json::Value::Array(_))) => Some(value),
        _ => None,
    };
    let (block_count, system_fee, network_fee) = match supplied_params {
        Some(params) => validate_feed_n3_tx_params(Some(params))?,
        None => {
            // defaultFeedTxParamsProvider — the enclave RPC lane is not wired.
            return Err(http_error(
                503,
                "feed tx network params (block_count/system_fee/network_fee) unavailable: \
                 supply tx_params in the request or configure an RPC provider",
            ));
        }
    };

    // The tx nonce is the reproducibility key: the enclave signs, the host
    // broadcasts, so the broadcaster must rebuild the IDENTICAL tx — the
    // nonce is an explicit, RETURNED input, never a per-instance random.
    let tx_nonce_raw = nullish_pick(supplied_params, "nonce")
        .or_else(|| nullish_pick(supplied_params, "tx_nonce"))
        .or_else(|| nullish_pick(Some(body), "tx_nonce"));
    let tx_nonce = match tx_nonce_raw {
        Some(value) => {
            let parsed = js_to_number(value);
            if parsed.is_finite() && parsed.fract() == 0.0 && (0.0..=4294967295.0).contains(&parsed)
            {
                parsed
            } else {
                derived_tx_nonce(&nonce)
            }
        }
        None => derived_tx_nonce(&nonce),
    };

    // (4) BUILD the EXACT updateFeeds tx + SIGN its message with the updater key.
    // The updateFeeds args are fixed-shape feed data — encoding is infallible
    // for this domain, so a failure here is a bug, not a runtime condition.
    let script = create_invoke_script(
        feed_n3_contract(&network),
        "updateFeeds",
        &[
            ContractParam::Array(planned_pairs),
            ContractParam::Array(planned_rounds),
            ContractParam::Array(planned_prices),
            ContractParam::Array(planned_timestamps),
            ContractParam::Array(planned_hashes),
            ContractParam::Array(planned_sources),
        ],
    )
    .expect("updateFeeds args are always encodable");
    let valid_until_block = block_count + FEED_VALID_UNTIL_OFFSET;
    let tx = FeedTx {
        nonce: tx_nonce as u32,
        valid_until_block: valid_until_block as u32,
        system_fee: system_fee as u64,
        network_fee: network_fee as u64,
        signer: FeedSigner {
            script_hash: updater_script_hash,
        },
        script: &script,
    };
    let message_hex = hex::encode(tx.message_for_signing(feed_magic(&network)));
    let unsigned_hex = hex::encode(tx.serialize_unsigned());
    let signer_request_id = format!("n3-feed:{}", tx.hash_display().trim_start_matches("0x"));
    let signed =
        state
            .signer
            .sign_n3_transaction(&network, "updater", &unsigned_hex, &signer_request_id)?;

    let mut response = serde_json::Map::new();
    response.insert("status".into(), serde_json::json!("ok"));
    response.insert("chain".into(), serde_json::json!("neo_n3"));
    response.insert("pairs".into(), serde_json::Value::Array(pairs));
    response.insert("rounds".into(), serde_json::Value::Array(rounds));
    response.insert(
        "prices_scaled".into(),
        serde_json::Value::Array(prices_scaled),
    );
    response.insert("timestamps".into(), serde_json::Value::Array(timestamps));
    response.insert(
        "attestation_hashes".into(),
        serde_json::Value::Array(attestation_hashes),
    );
    response.insert(
        "source_set_ids".into(),
        serde_json::Value::Array(source_set_ids),
    );
    response.insert("tx_message_hex".into(), serde_json::json!(message_hex));
    response.insert("tx_nonce".into(), js_number_value(tx_nonce));
    response.insert(
        "valid_until_block".into(),
        js_number_value(valid_until_block),
    );
    if let Some(signature) = signed.get("signature") {
        response.insert("signature".into(), signature.clone());
    }
    if let Some(public_key) = signed.get("public_key") {
        response.insert("public_key".into(), public_key.clone());
    }
    response.insert("trust_tier".into(), serde_json::json!("enclave-attested"));
    response.insert("skipped".into(), serde_json::Value::Array(skipped));
    response.insert("missing".into(), serde_json::Value::Array(missing));
    if !nonce.is_empty() {
        response.insert("nonce".into(), serde_json::json!(nonce));
    }
    Ok(serde_json::Value::Object(response))
}

/// NeoX equivalent of the Neo N3 feed fold. The host owns price acquisition,
/// policy-independent planning and the exact unsigned EIP-1559 transaction;
/// the chain-bound `neox_updater` custody key owns policy enforcement and
/// signing. No private key is accepted by this process.
fn handle_neox_feed_sign(
    state: &AppState,
    body: &serde_json::Value,
) -> Result<serde_json::Value, RuntimeError> {
    let symbols: Vec<String> = match body.get("symbols") {
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .map(|item| enclave_trim_string(Some(item)))
            .filter(|symbol| !symbol.is_empty())
            .collect(),
        _ => Vec::new(),
    };
    if symbols.is_empty() {
        return Err(http_error(400, "symbols[] is required"));
    }
    if symbols.len() > MAX_NEOX_FEED_SYMBOLS {
        return Err(http_error(
            400,
            format!("symbols[] exceeds the {MAX_NEOX_FEED_SYMBOLS}-symbol limit"),
        ));
    }

    let tx_params = body.get("tx_params").and_then(serde_json::Value::as_object);
    let to_raw = tx_params
        .and_then(|params| params.get("to").or_else(|| params.get("contract")))
        .or_else(|| body.get("contract"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| http_error(400, "neox tx_params.to (feed contract) is required"))?;
    let to = parse_evm_address(to_raw).map_err(|message| http_error(400, message))?;
    let canonical_to = format!("0x{}", hex::encode(to));

    let chain_id = required_u64_quantity(
        tx_params.and_then(|params| params.get("chain_id").or_else(|| params.get("chainId"))),
        "neox tx_params.chain_id is required",
    )?;
    if chain_id == 0 {
        return Err(http_error(400, "neox tx_params.chain_id is required"));
    }
    let nonce = required_u64_quantity(
        tx_params.and_then(|params| params.get("nonce")),
        "neox tx_params.nonce is required",
    )?;
    let gas_limit = required_u64_quantity(
        tx_params.and_then(|params| params.get("gas_limit").or_else(|| params.get("gasLimit"))),
        "neox tx_params.{gas_limit,max_fee_per_gas,max_priority_fee_per_gas} are required",
    )?;
    let max_fee_per_gas = required_u128_quantity(
        tx_params.and_then(|params| {
            params
                .get("max_fee_per_gas")
                .or_else(|| params.get("maxFeePerGas"))
        }),
        "neox tx_params.{gas_limit,max_fee_per_gas,max_priority_fee_per_gas} are required",
    )?;
    let max_priority_fee_per_gas = required_u128_quantity(
        tx_params.and_then(|params| {
            params
                .get("max_priority_fee_per_gas")
                .or_else(|| params.get("maxPriorityFeePerGas"))
        }),
        "neox tx_params.{gas_limit,max_fee_per_gas,max_priority_fee_per_gas} are required",
    )?;
    if max_priority_fee_per_gas > max_fee_per_gas {
        return Err(http_error(
            400,
            "neox max_priority_fee_per_gas must not exceed max_fee_per_gas",
        ));
    }

    let now = match body.get("now") {
        Some(value) => {
            let parsed = js_to_number(value);
            if parsed.is_finite() {
                parsed.floor()
            } else {
                wall_clock_now()
            }
        }
        None => wall_clock_now(),
    };
    let raw_state = match body.get("onchain_state") {
        Some(value) if js_truthy(value) => Some(value),
        _ => body.get("onchainState").filter(|value| js_truthy(value)),
    };
    let onchain_state = normalize_onchain_state(raw_state);
    let overlay = state.overlay.read().expect("overlay lock").merged_map();
    let thresholds = feed_thresholds(&overlay);
    let prices = state.price.fetch_prices(&symbols)?;

    let mut planned_symbols = Vec::new();
    let mut planned_prices = Vec::new();
    let mut planned_timestamps = Vec::new();
    let mut planned_rounds = Vec::new();
    let mut skipped = Vec::new();
    let mut missing = Vec::new();
    for symbol in &symbols {
        let Some(&price) = prices.get(symbol) else {
            missing.push(serde_json::Value::String(symbol.clone()));
            continue;
        };
        let current = onchain_state.get(symbol).copied().unwrap_or(OnchainRecord {
            round: 0.0,
            price: 0.0,
            ts: 0.0,
        });
        let plan = plan_feed_update(&current, price, now, &thresholds);
        if !plan.push {
            skipped.push(serde_json::json!({
                "symbol": symbol,
                "reason": plan.rejected.unwrap_or("unchanged_recent"),
            }));
            continue;
        }
        let scaled =
            checked_feed_integer((price * NEOX_FEED_PRICE_SCALE).round(), "scaled feed price")?;
        let timestamp = checked_feed_integer(plan.ts, "feed timestamp")?;
        let round = checked_feed_integer(plan.round, "feed round")?;
        planned_symbols.push(format!("{NEOX_FEED_PAIR_PREFIX}{symbol}"));
        planned_prices.push(scaled);
        planned_timestamps.push(timestamp);
        planned_rounds.push(round);
    }

    if planned_symbols.is_empty() {
        return Ok(serde_json::json!({
            "status": "no-update",
            "chain": "neox",
            "symbols": [],
            "prices_scaled": [],
            "timestamps": [],
            "round_ids": [],
            "signed_tx": serde_json::Value::Null,
            "from": serde_json::Value::Null,
            "trust_tier": "enclave-attested",
            "skipped": skipped,
            "missing": missing,
        }));
    }

    let data = encode_update_feeds_call(
        &planned_symbols,
        &planned_prices,
        &planned_timestamps,
        &planned_rounds,
    )?;
    let unsigned = encode_unsigned_eip1559(
        chain_id,
        nonce,
        max_priority_fee_per_gas,
        max_fee_per_gas,
        gas_limit,
        &to,
        &data,
    );
    let request_digest = Keccak256::digest(&unsigned);
    let request_id = format!("feed-neox:{}", hex::encode(request_digest));
    let network = state.resolve_network();
    let signed = state.signer.sign_transaction(
        &network,
        "neox_updater",
        chain_id,
        &format!("0x{}", hex::encode(&unsigned)),
        &request_id,
    )?;
    let signed_tx = required_object_string(&signed, "signed_transaction")
        .ok_or_else(|| http_error(502, "neox custody response omitted signed_transaction"))?;
    let from = required_object_string(&signed, "address")
        .ok_or_else(|| http_error(502, "neox custody response omitted address"))?;
    let from_bytes = parse_evm_address(&from)
        .map_err(|_| http_error(502, "neox custody response contained an invalid address"))?;
    if let Some(expected) = tx_params
        .and_then(|params| params.get("from"))
        .or_else(|| body.get("from"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let expected = parse_evm_address(expected)
            .map_err(|_| http_error(400, "neox tx_params.from is not a valid EVM address"))?;
        if expected != from_bytes {
            return Err(http_error(
                502,
                "neox custody signer address did not match tx_params.from",
            ));
        }
    }
    validate_signed_eip1559_matches(&signed_tx, &unsigned)?;

    let prices_scaled = planned_prices
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let timestamps = planned_timestamps
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let round_ids = planned_rounds
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    Ok(serde_json::json!({
        "status": "ok",
        "chain": "neox",
        "signed_tx": signed_tx,
        "from": format!("0x{}", hex::encode(from_bytes)),
        "to": canonical_to,
        "nonce": nonce,
        "chain_id": chain_id,
        "data": format!("0x{}", hex::encode(&data)),
        "symbols": planned_symbols,
        "prices_scaled": prices_scaled,
        "timestamps": timestamps,
        "round_ids": round_ids,
        "gas_limit": gas_limit.to_string(),
        "max_fee_per_gas": max_fee_per_gas.to_string(),
        "max_priority_fee_per_gas": max_priority_fee_per_gas.to_string(),
        "trust_tier": "enclave-attested",
        "skipped": skipped,
        "missing": missing,
    }))
}

fn required_object_string(value: &serde_json::Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn parse_evm_address(raw: &str) -> Result<[u8; 20], String> {
    let stripped = raw
        .trim()
        .strip_prefix("0x")
        .or_else(|| raw.trim().strip_prefix("0X"))
        .unwrap_or(raw.trim());
    if stripped.len() != 40 {
        return Err("neox tx_params.to must be a 20-byte EVM address".to_string());
    }
    let decoded = hex::decode(stripped)
        .map_err(|_| "neox tx_params.to must be a hexadecimal EVM address".to_string())?;
    decoded
        .try_into()
        .map_err(|_| "neox tx_params.to must be a 20-byte EVM address".to_string())
}

fn required_u64_quantity(
    value: Option<&serde_json::Value>,
    message: &'static str,
) -> Result<u64, RuntimeError> {
    let parsed = value.and_then(parse_u128_quantity);
    parsed
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| http_error(400, message))
}

fn required_u128_quantity(
    value: Option<&serde_json::Value>,
    message: &'static str,
) -> Result<u128, RuntimeError> {
    value
        .and_then(parse_u128_quantity)
        .ok_or_else(|| http_error(400, message))
}

fn parse_u128_quantity(value: &serde_json::Value) -> Option<u128> {
    match value {
        serde_json::Value::Number(number) => number.as_u64().map(u128::from).or_else(|| {
            let number = number.as_f64()?;
            (number.is_finite()
                && number >= 0.0
                && number.fract() == 0.0
                && number <= 9_007_199_254_740_991.0)
                .then_some(number as u128)
        }),
        serde_json::Value::String(raw) => {
            let raw = raw.trim();
            if raw.is_empty() {
                return None;
            }
            if let Some(hex) = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")) {
                (!hex.is_empty())
                    .then(|| u128::from_str_radix(hex, 16).ok())
                    .flatten()
            } else {
                raw.parse().ok()
            }
        }
        _ => None,
    }
}

fn checked_feed_integer(value: f64, field: &str) -> Result<u128, RuntimeError> {
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > u128::MAX as f64 {
        return Err(http_error(
            422,
            format!("{field} is outside the uint256 planning range"),
        ));
    }
    Ok(value as u128)
}

fn encode_update_feeds_call(
    symbols: &[String],
    prices: &[u128],
    timestamps: &[u128],
    rounds: &[u128],
) -> Result<Vec<u8>, RuntimeError> {
    if symbols.len() != prices.len()
        || symbols.len() != timestamps.len()
        || symbols.len() != rounds.len()
    {
        return Err(http_error(500, "neox feed plan arrays diverged"));
    }
    let tails = [
        abi_encode_string_array(symbols),
        abi_encode_uint_array(prices),
        abi_encode_uint_array(timestamps),
        abi_encode_uint_array(rounds),
    ];
    let mut data = Vec::new();
    data.extend_from_slice(&Keccak256::digest(NEOX_UPDATE_FEEDS_SIGNATURE.as_bytes())[..4]);
    let mut offset = 32usize * tails.len();
    for tail in &tails {
        data.extend_from_slice(&abi_word(offset as u128));
        offset = offset
            .checked_add(tail.len())
            .ok_or_else(|| http_error(413, "neox feed calldata is too large"))?;
    }
    for tail in tails {
        data.extend_from_slice(&tail);
    }
    Ok(data)
}

fn abi_encode_string_array(values: &[String]) -> Vec<u8> {
    let mut encoded = Vec::new();
    encoded.extend_from_slice(&abi_word(values.len() as u128));
    let mut tails = Vec::new();
    let mut offset = values.len() * 32;
    for value in values {
        encoded.extend_from_slice(&abi_word(offset as u128));
        let mut tail = Vec::new();
        tail.extend_from_slice(&abi_word(value.len() as u128));
        tail.extend_from_slice(value.as_bytes());
        tail.resize(tail.len().next_multiple_of(32), 0);
        offset += tail.len();
        tails.push(tail);
    }
    for tail in tails {
        encoded.extend_from_slice(&tail);
    }
    encoded
}

fn abi_encode_uint_array(values: &[u128]) -> Vec<u8> {
    let mut encoded = Vec::with_capacity((values.len() + 1) * 32);
    encoded.extend_from_slice(&abi_word(values.len() as u128));
    for value in values {
        encoded.extend_from_slice(&abi_word(*value));
    }
    encoded
}

fn abi_word(value: u128) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[16..].copy_from_slice(&value.to_be_bytes());
    word
}

fn encode_unsigned_eip1559(
    chain_id: u64,
    nonce: u64,
    max_priority_fee_per_gas: u128,
    max_fee_per_gas: u128,
    gas_limit: u64,
    to: &[u8; 20],
    data: &[u8],
) -> Vec<u8> {
    let mut stream = RlpStream::new_list(9);
    stream.append(&chain_id);
    stream.append(&nonce);
    stream.append(&max_priority_fee_per_gas);
    stream.append(&max_fee_per_gas);
    stream.append(&gas_limit);
    stream.append(&to.as_slice());
    stream.append_empty_data();
    stream.append(&data);
    stream.begin_list(0);
    let mut unsigned = vec![0x02];
    unsigned.extend_from_slice(&stream.out());
    unsigned
}

fn validate_signed_eip1559_matches(signed_hex: &str, unsigned: &[u8]) -> Result<(), RuntimeError> {
    let raw = signed_hex
        .strip_prefix("0x")
        .or_else(|| signed_hex.strip_prefix("0X"))
        .unwrap_or(signed_hex);
    let signed = hex::decode(raw)
        .map_err(|_| http_error(502, "neox custody returned non-hex signed_transaction"))?;
    if signed.first() != Some(&0x02) {
        return Err(http_error(
            502,
            "neox custody returned a non-EIP-1559 transaction",
        ));
    }
    let rlp = Rlp::new(&signed[1..]);
    if !rlp.is_list()
        || rlp.item_count().ok() != Some(12)
        || rlp.payload_info().ok().map(|info| info.total()) != Some(signed.len() - 1)
    {
        return Err(http_error(
            502,
            "neox custody returned a malformed signed EIP-1559 transaction",
        ));
    }
    let mut reconstructed = RlpStream::new_list(9);
    for index in 0..9 {
        let item = rlp.at(index).map_err(|_| {
            http_error(
                502,
                "neox custody returned a malformed signed EIP-1559 transaction",
            )
        })?;
        reconstructed.append_raw(item.as_raw(), 1);
    }
    let mut reconstructed_unsigned = vec![0x02];
    reconstructed_unsigned.extend_from_slice(&reconstructed.out());
    if reconstructed_unsigned != unsigned {
        return Err(http_error(
            502,
            "neox custody signed transaction fields did not match the planned transaction",
        ));
    }
    let parity: u8 = rlp.val_at(9).map_err(|_| {
        http_error(
            502,
            "neox custody returned an invalid EIP-1559 signature parity",
        )
    })?;
    if parity > 1 {
        return Err(http_error(
            502,
            "neox custody returned an invalid EIP-1559 signature parity",
        ));
    }
    for index in [10usize, 11] {
        let scalar = rlp.at(index).ok().and_then(|item| item.data().ok());
        if !scalar.is_some_and(|bytes| {
            !bytes.is_empty() && bytes.len() <= 32 && bytes.iter().any(|byte| *byte != 0)
        }) {
            return Err(http_error(
                502,
                "neox custody returned an invalid EIP-1559 signature scalar",
            ));
        }
    }
    Ok(())
}

/// The production price plane: one batched TwelveData `/price` call, the
/// exact URL/parse/drop discipline of feed-pusher's `td()` and the mjs's
/// `defaultPriceFetcher`. HTTP-level errors are NOT failures — a bad symbol
/// or a failed quote just leaves that symbol missing, exactly like the JS.
pub struct TwelveDataPrices {
    overlay: Arc<RwLock<EnvOverlay>>,
}

impl TwelveDataPrices {
    pub fn new(overlay: Arc<RwLock<EnvOverlay>>) -> Self {
        TwelveDataPrices { overlay }
    }
}

impl PriceSource for TwelveDataPrices {
    fn fetch_prices(&self, symbols: &[String]) -> Result<BTreeMap<String, f64>, RuntimeError> {
        let overlay = self.overlay.read().expect("overlay lock");
        let api_key = overlay.get_trimmed("TD_KEY").unwrap_or_default();
        let overlay = overlay.merged_map();
        let timeout_ms = feed_td_timeout_ms(&overlay);
        drop(overlay);

        let mapped: Vec<Option<&'static str>> = symbols
            .iter()
            .map(|symbol| to_twelve_data_symbol(symbol))
            .collect();
        // The JS builds the URL from the mapped list verbatim — an unmapped
        // symbol rides as the literal string "null" and comes back missing.
        let requested = mapped
            .iter()
            .map(|entry| entry.unwrap_or("null"))
            .collect::<Vec<_>>()
            .join(",");
        let url = format!(
            "https://api.twelvedata.com/price?symbol={}&apikey={api_key}",
            encode_uri_component(&requested),
        );

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_millis(timeout_ms))
            .build()
            .map_err(|error| http_error(500, error.to_string()))?;
        let response = client
            .get(&url)
            .send()
            .map_err(|error| http_error(500, error.to_string()))?;
        let status = response.status().as_u16();
        let text = response
            .text()
            .map_err(|error| http_error(500, error.to_string()))?;
        let parsed: serde_json::Value = serde_json::from_str(&text)
            .map_err(|_| http_error(500, format!("TwelveData non-JSON (HTTP {status})")))?;

        let mut out = BTreeMap::new();
        for (symbol, entry_key) in symbols.iter().zip(&mapped) {
            let entry = if symbols.len() == 1 {
                Some(&parsed)
            } else {
                entry_key.and_then(|key| parsed.get(key))
            };
            let Some(value) = entry.and_then(|entry| entry.get("price")) else {
                continue;
            };
            if value.is_null() {
                continue;
            }
            let price = js_to_number(value);
            // Drop non-positive / non-finite quotes: a 0/negative reading is
            // "missing".
            if price.is_finite() && price > 0.0 {
                out.insert(symbol.clone(), price);
            }
        }
        Ok(out)
    }
}

/// `Math.max(Number(FEED_TD_TIMEOUT_MS || 25000), 1000)` — an unparsable
/// value is NaN in JS; the sane fallback here is the default.
fn feed_td_timeout_ms(overlay: &BTreeMap<String, String>) -> u64 {
    let raw = overlay
        .get("FEED_TD_TIMEOUT_MS")
        .map(String::as_str)
        .unwrap_or("");
    let parsed = if raw.is_empty() {
        FEED_TD_TIMEOUT_DEFAULT_MS
    } else {
        let parsed = js_number(raw);
        if parsed.is_finite() {
            parsed
        } else {
            FEED_TD_TIMEOUT_DEFAULT_MS
        }
    };
    parsed.max(1000.0) as u64
}

fn feed_magic(network: &str) -> u32 {
    if network == "mainnet" {
        FEED_N3_MAINNET_MAGIC
    } else {
        FEED_N3_TESTNET_MAGIC
    }
}

fn feed_n3_contract(network: &str) -> &'static [u8; 20] {
    if network == "mainnet" {
        &FEED_N3_MAINNET_CONTRACT
    } else {
        &FEED_N3_TESTNET_CONTRACT
    }
}

/// `trimString(value).toLowerCase()` then the three-way match; anything else
/// collapses to `neo_n3` (an absent chain included).
fn normalize_chain(value: Option<&serde_json::Value>) -> String {
    match enclave_trim_string(value).to_ascii_lowercase().as_str() {
        "neox" => "neox".to_string(),
        "legacy" => "legacy".to_string(),
        _ => "neo_n3".to_string(),
    }
}

/// The enclave-server.mjs `trimString` (mjs:119) — the STRICT one: strings
/// trim, everything else is empty. Note this is deliberately NOT the
/// platform `String(trimString(x))` variant `fulfill::trim_string` ports;
/// the feed lane never coerces non-string symbols into pairs.
fn enclave_trim_string(value: Option<&serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(text)) => text.trim().to_string(),
        _ => String::new(),
    }
}

/// `normalizeHex(requestBody?.nonce || '')`: only a non-empty string survives
/// the `|| ''`; then trim, strip one leading `0x`, lowercase.
fn normalize_hex_value(value: Option<&serde_json::Value>) -> String {
    let Some(serde_json::Value::String(text)) = value else {
        return String::new();
    };
    if text.is_empty() {
        return String::new();
    }
    let trimmed = text.trim();
    let stripped = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed);
    stripped.to_ascii_lowercase()
}

/// One `onchain_state` entry after `normalizeOnchainState` — the three
/// fields `planFeedUpdate` reads. `price` keeps the JS semantics: a negative
/// on-chain price is preserved (and exempts the deviation guard).
#[derive(Clone, Copy)]
struct OnchainRecord {
    round: f64,
    price: f64,
    ts: f64,
}

/// `normalizeOnchainState`: the state must be a plain object (JS excludes
/// arrays at the top level); per-value the `typeof === 'object'` check PASSES
/// arrays, which then normalize to zeros. Absent/garbage fields read 0.
fn normalize_onchain_state(raw: Option<&serde_json::Value>) -> BTreeMap<String, OnchainRecord> {
    let mut out = BTreeMap::new();
    let Some(serde_json::Value::Object(entries)) = raw else {
        return out;
    };
    for (symbol, value) in entries {
        if !matches!(
            value,
            serde_json::Value::Object(_) | serde_json::Value::Array(_)
        ) {
            continue;
        }
        let round = number_or_zero(value.get("round")).max(0.0);
        let price = number_or_zero(value.get("price"));
        let ts_source = match value.get("timestamp") {
            None | Some(serde_json::Value::Null) => value.get("ts"),
            picked => picked,
        };
        let ts = number_or_zero(ts_source).max(0.0);
        out.insert(symbol.clone(), OnchainRecord { round, price, ts });
    }
    out
}

/// `Number(x ?? 0) || 0` — absent/null read as 0, a NaN parse collapses to 0
/// (NaN is falsy), while negative values survive.
fn number_or_zero(value: Option<&serde_json::Value>) -> f64 {
    let parsed = match value {
        None | Some(serde_json::Value::Null) => 0.0,
        Some(raw) => js_to_number(raw),
    };
    if parsed.is_nan() || parsed == 0.0 {
        0.0
    } else {
        parsed
    }
}

/// The three env-tunable thresholds `planFeedUpdate` defaults to.
struct FeedThresholds {
    threshold_bps: f64,
    max_stale_sec: f64,
    max_deviation_bps: f64,
}

/// `Number(process.env.NAME || default)` over the overlay snapshot — only an
/// absent/EMPTY value falls back; an unparsable one becomes NaN and disables
/// whichever guard reads it, exactly like the JS comparisons.
fn env_number_or(overlay: &BTreeMap<String, String>, name: &str, default: f64) -> f64 {
    match overlay.get(name).map(String::as_str) {
        Some(raw) if !raw.is_empty() => js_number(raw),
        _ => default,
    }
}

fn feed_thresholds(overlay: &BTreeMap<String, String>) -> FeedThresholds {
    FeedThresholds {
        threshold_bps: env_number_or(overlay, "THRESHOLD_BPS", 10.0),
        max_stale_sec: env_number_or(overlay, "MAX_STALE_SEC", 1800.0),
        max_deviation_bps: env_number_or(overlay, "MAX_DEVIATION_BPS", 5000.0),
    }
}

/// One `planFeedUpdate` decision.
struct FeedPlan {
    push: bool,
    round: f64,
    ts: f64,
    rejected: Option<&'static str>,
}

/// `planFeedUpdate` (feed-pusher.mjs:37) — the single-writer push decision,
/// comparison-for-comparison. A signed batch must never regress the on-chain
/// round OR timestamp.
fn plan_feed_update(
    current: &OnchainRecord,
    new_price: f64,
    now: f64,
    thresholds: &FeedThresholds,
) -> FeedPlan {
    // Price-sanity guard: a non-finite or non-positive candidate is always
    // rejected — signing it would poison the feed and burn the updater's gas.
    if !new_price.is_finite() || new_price <= 0.0 {
        return FeedPlan {
            push: false,
            round: current.round,
            ts: current.ts,
            rejected: Some("invalid_price"),
        };
    }
    // Deviation spike guard: the bootstrap case (cur.price <= 0, no usable
    // reference) is exempt; `maxDeviationBps <= 0` is the admin override.
    if current.price > 0.0 && thresholds.max_deviation_bps > 0.0 {
        let deviation_bps = ((new_price - current.price).abs() / current.price) * 10000.0;
        if deviation_bps > thresholds.max_deviation_bps {
            return FeedPlan {
                push: false,
                round: current.round,
                ts: current.ts,
                rejected: Some("deviation_spike"),
            };
        }
    }
    let recent = current.round > 0.0 && now - current.round < thresholds.max_stale_sec;
    let unchanged = current.price > 0.0
        && ((new_price - current.price).abs() / current.price) * 10000.0 < thresholds.threshold_bps;
    if recent && unchanged {
        return FeedPlan {
            push: false,
            round: current.round,
            ts: current.ts,
            rejected: None,
        };
    }
    FeedPlan {
        push: true,
        round: (current.round + 1.0).max(now),
        ts: current.ts.max(now),
        rejected: None,
    }
}

/// `resolveUpdaterIdentity` over the custody plane: the updater role report
/// must be healthy AND carry a usable script hash — it becomes the tx signer
/// account, so the message binds the SAME signer that signs it.
fn resolve_updater_script_hash(state: &AppState, network: &str) -> Result<[u8; 20], RuntimeError> {
    let report = state.signer.role_report(network, "updater");
    let script_hash = report
        .identity
        .get("script_hash")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if report.ok && report.materialized {
        if let Some(bytes) = parse_script_hash(script_hash) {
            return Ok(bytes);
        }
    }
    Err(http_error(
        503,
        "updater signer is not configured or does not match pinned identity",
    ))
}

/// 0x-optional display form, 20 bytes — what the custody reports carry.
fn parse_script_hash(text: &str) -> Option<[u8; 20]> {
    let trimmed = text.trim();
    let hex_text = trimmed.strip_prefix("0x").unwrap_or(trimmed);
    let bytes = hex::decode(hex_text).ok()?;
    bytes.try_into().ok()
}

/// `Number(value?.a ?? value?.b)` — `??` skips absent AND null; two explicit
/// nulls collapse to `Number(null)` = 0; a wholly absent pair is NaN.
fn nullish_number(value: Option<&serde_json::Value>, a: &str, b: &str) -> f64 {
    let picked = match value.and_then(|value| value.get(a)) {
        None | Some(serde_json::Value::Null) => value.and_then(|value| value.get(b)),
        picked => picked,
    };
    match picked {
        None => f64::NAN,
        Some(raw) => js_to_number(raw),
    }
}

/// `Number.isSafeInteger`.
fn is_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9007199254740991.0
}

/// `validateFeedN3TxParams` — camelCase and snake_case keys, JS `Number`
/// coercion, safe-integer ranges with the fixed fee ceilings.
fn validate_feed_n3_tx_params(
    value: Option<&serde_json::Value>,
) -> Result<(f64, f64, f64), RuntimeError> {
    let block_count = nullish_number(value, "blockCount", "block_count");
    let system_fee = nullish_number(value, "systemFee", "system_fee");
    let network_fee = nullish_number(value, "networkFee", "network_fee");
    if !is_safe_integer(block_count)
        || !(0.0..=4294967295.0 - FEED_VALID_UNTIL_OFFSET).contains(&block_count)
    {
        return Err(http_error(
            400,
            "feed tx block_count is outside the supported Neo N3 range",
        ));
    }
    if !is_safe_integer(system_fee) || !(0.0..=FEED_N3_MAX_SYSTEM_FEE).contains(&system_fee) {
        return Err(http_error(
            400,
            "feed tx system_fee exceeds the enclave safety ceiling",
        ));
    }
    if !is_safe_integer(network_fee) || !(0.0..=FEED_N3_MAX_NETWORK_FEE).contains(&network_fee) {
        return Err(http_error(
            400,
            "feed tx network_fee exceeds the enclave safety ceiling",
        ));
    }
    Ok((block_count, system_fee, network_fee))
}

/// `v?.key ?? ...` chain link: present-and-not-null only.
fn nullish_pick<'a>(
    value: Option<&'a serde_json::Value>,
    key: &str,
) -> Option<&'a serde_json::Value> {
    match value.and_then(|value| value.get(key)) {
        None | Some(serde_json::Value::Null) => None,
        picked => picked,
    }
}

/// The fallback tx nonce: the first four bytes of the freshness nonce's
/// sha256 when one was supplied, else a fresh random uint32.
fn derived_tx_nonce(nonce: &str) -> f64 {
    if !nonce.is_empty() {
        let digest = sha256(&buffer_hex_decode(nonce));
        return u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) as f64;
    }
    random_uint32() as f64
}

/// `Buffer.from(text, 'hex')`: pairwise, stopping at the first non-hex byte,
/// a trailing odd nibble dropped.
fn buffer_hex_decode(text: &str) -> Vec<u8> {
    fn nibble(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut index = 0;
    while index + 1 < bytes.len() {
        match (nibble(bytes[index]), nibble(bytes[index + 1])) {
            (Some(high), Some(low)) => {
                out.push(high << 4 | low);
                index += 2;
            }
            _ => break,
        }
    }
    out
}

/// `randomBytes(4).readUInt32BE(0)` — backed by the OS/Nitro CSPRNG.
fn random_uint32() -> u32 {
    use rand::RngCore;
    rand::rngs::OsRng.next_u32()
}

fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// `Math.floor(Date.now() / 1000)`.
fn wall_clock_now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as f64)
        .unwrap_or(0.0)
}

/// `ContractParam.integer(x)`'s Math.round — half toward +infinity, where
/// f64::round is half away from zero (they differ only on negative halves).
fn js_math_round(value: f64) -> f64 {
    let rounded = value.round();
    let fraction = value.fract();
    if (fraction == 0.5 || fraction == -0.5) && value < 0.0 {
        rounded + 1.0
    } else {
        rounded
    }
}

/// The i64 a `ContractParam::Integer` receives. Feed-domain values are
/// non-negative and far below 2^53; the saturating cast only bounds garbage.
fn contract_integer(value: f64) -> i64 {
    js_math_round(value) as i64
}

/// `encodeURIComponent` — byte-wise percent-encoding except the JS
/// unreserved set (`A-Za-z0-9-_.!~*'()`).
fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `toTwelveDataSymbol` (feed-pusher.mjs:250): trim+uppercase lookup, null
/// when unmapped (the request symbol then comes back `missing`).
fn to_twelve_data_symbol(symbol: &str) -> Option<&'static str> {
    match symbol.trim().to_ascii_uppercase().as_str() {
        // Crypto — TwelveData 'Synthetic'/exchange-backed X/USD pairs.
        "NEO-USD" => Some("NEO/USD"),
        "GAS-USD" => Some("GAS/USD"),
        "BTC-USD" => Some("BTC/USD"),
        "ETH-USD" => Some("ETH/USD"),
        "SOL-USD" => Some("SOL/USD"),
        "TRX-USD" => Some("TRX/USD"),
        "PAXG-USD" => Some("PAXG/USD"),
        "USDT-USD" => Some("USDT/USD"),
        "USDC-USD" => Some("USDC/USD"),
        "BNB-USD" => Some("BNB/USD"),
        "XRP-USD" => Some("XRP/USD"),
        "DOGE-USD" => Some("DOGE/USD"),
        // FX — quoted DIRECTLY as base/USD; do not invert.
        "EUR-USD" => Some("EUR/USD"),
        "GBP-USD" => Some("GBP/USD"),
        "JPY-USD" => Some("JPY/USD"),
        "CNY-USD" => Some("CNY/USD"),
        // Commodities — the `X_1` forms are front-month futures.
        "WTI-USD" => Some("WTI/USD"),
        "BRENT-USD" => Some("XBR/USD"),
        "NATGAS-USD" => Some("NG/USD"),
        "WHEAT-USD" => Some("W_1"),
        "CORN-USD" => Some("C_1"),
        "SOY-USD" => Some("S_1"),
        // Equities / ETFs — bare ticker; 'AAPL/USD' 404s.
        "AAPL-USD" => Some("AAPL"),
        "GOOGL-USD" => Some("GOOGL"),
        "MSFT-USD" => Some("MSFT"),
        "AMZN-USD" => Some("AMZN"),
        "TSLA-USD" => Some("TSLA"),
        "META-USD" => Some("META"),
        "NVDA-USD" => Some("NVDA"),
        "SPY-USD" => Some("SPY"),
        "QQQ-USD" => Some("QQQ"),
        "GLD-USD" => Some("GLD"),
        _ => None,
    }
}

#[cfg(test)]
#[path = "../tests/unit/feed_sign.rs"]
mod tests;
