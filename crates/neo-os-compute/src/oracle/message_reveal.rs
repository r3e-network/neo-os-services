//! Port of `workers/nitro-worker/src/oracle/message-reveal.js` — the
//! recipient-gated confidential reveal lane: statement builder, EIP-191 signer
//! recovery (EIP-55 checksummed, matching ethers), address comparison,
//! freshness window, BigInt messageId grammar, the trusted chain-context
//! resolver, the on-chain read (`readMessageFromChain` as a single `eth_call`
//! over the injected transport) and the full handler decision tree rendered as
//! `(status, json-body)` responses.

use k256::ecdsa::{RecoveryId, Signature as EcdsaSignature, VerifyingKey};
use num_bigint::BigInt;
use serde_json::{json, Value as Json};
use sha3::{Digest as _, Keccak256};
use url::Url;

use crate::core::{read_env, sanitize_error_message, EnvReader};
use crate::js::{
    js_number, js_number_to_string, js_number_value, js_stringify, js_to_number, js_trim_string,
    js_truthy,
};
use crate::oracle::crypto::{
    decrypt_encrypted_token_resolved, KeystoreReader, OracleKeyMaterial, WrapKeyDeriver,
};
use crate::transport::{HttpRequest, HttpTransport};

pub const REVEAL_FRESHNESS_WINDOW_SECONDS: f64 = 600.0; // ±10 min tolerance for clock skew

/// `NEOX_CHAIN_ALIASES` (also re-exported in JS as
/// `NEOX_DECRYPT_CHAIN_ALIASES`); membership is tested against the
/// trim+lowercased chain name.
pub const NEOX_CHAIN_ALIASES: [&str; 3] = ["neox", "neo_x", "neo-x"];

fn reviewed_neox_chain_id(network: &str) -> f64 {
    neo_os_core::network_identity::known_neox_chain_id(network)
        .expect("message reveal network must have a reviewed NeoX identity") as f64
}

pub fn is_neox_chain_alias(chain: &str) -> bool {
    NEOX_CHAIN_ALIASES.contains(&chain)
}

/// Canonical statement the recipient signs (EIP-191 personal_sign). The
/// frontend MUST construct the byte-identical string.
///
/// Binding chain + contract + messageId stops a signature being replayed
/// across messages, contracts, or chains, and `issued` bounds replay to a
/// short freshness window.
pub fn build_reveal_statement(
    chain_id: &Json,
    contract: &str,
    message_id: &Json,
    issued_at: &Json,
) -> String {
    let chain = js_number_to_string(js_to_number(chain_id));
    let message = js_stringify(message_id);
    let issued = js_number_to_string(js_to_number(issued_at));
    [
        "Morpheus Neo Message",
        "Recipient reveal request",
        &format!("chain: {chain}"),
        &format!("contract: {}", contract.to_lowercase()),
        &format!("message: {message}"),
        &format!("issued: {issued}"),
    ]
    .join("\n")
}

/// `addressesEqual(a, b)` — both exactly 42 chars, case-insensitive.
pub fn addresses_equal(a: &str, b: &str) -> bool {
    a.len() == 42 && b.len() == 42 && a.eq_ignore_ascii_case(b)
}

/// The in-enclave single-use ledger for reveal presentations (SVC-E-9,
/// CL-15/CL-19). Entries are `(key, expires_at_seconds)`; the key is a SHA-256
/// over the exact statement and signature bytes, so nothing about the
/// recipient or the plaintext is retained.
///
/// Why this exists: `/oracle/message-reveal` is deliberately unauthenticated
/// at the edge — `deploy/cloudflare/morpheus-edge-gateway/worker.mjs` proxies
/// it to the box with the runtime token precisely so public clients can reach
/// it without holding one, and the box enforces per-message access in-TEE.
/// The edge therefore terminates TLS and re-originates, so a signed reveal
/// statement exists in cleartext inside it. Without a used-nonce set the only
/// replay control was [`REVEAL_FRESHNESS_WINDOW_SECONDS`], which means anyone
/// who observed one presentation — a logging sink that captures bodies, a
/// browser extension, a shared-device history — could replay the identical
/// body for ten minutes and receive the plaintext.
///
/// Bounded by construction: every entry carries its own expiry and the sweep
/// runs on each claim, so the set never holds more than one freshness window
/// of traffic. Tightening the window instead is not a fix — it would penalise
/// legitimate clients on slow links and still leave the replay open.
static REVEAL_PRESENTATIONS: std::sync::OnceLock<std::sync::Mutex<Vec<(String, f64)>>> =
    std::sync::OnceLock::new();

/// A presentation's identity: the statement the recipient signed plus the
/// signature that answers it. Two honest reveals of the same message differ
/// in `issued`, so this never collides across distinct requests, and a replay
/// is byte-identical by definition.
pub fn reveal_presentation_key(statement: &str, signature: &str) -> String {
    use sha2::{Digest as _, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(statement.as_bytes());
    hasher.update([0u8]);
    hasher.update(signature.trim().to_ascii_lowercase().as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Claim a presentation. `true` on the first presentation, `false` on every
/// repeat inside the freshness window. Expired entries are swept on the way
/// in, which is what keeps the set bounded without a background task.
pub fn claim_reveal_presentation(key: &str, now_seconds: f64) -> bool {
    let ledger = REVEAL_PRESENTATIONS.get_or_init(|| std::sync::Mutex::new(Vec::new()));
    let mut entries = ledger
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    entries.retain(|(_, expires_at)| *expires_at > now_seconds);
    if entries.iter().any(|(seen, _)| seen == key) {
        return false;
    }
    // One window is the longest a presentation can still pass the freshness
    // check, so an entry older than that can never be replayed anyway.
    entries.push((
        key.to_string(),
        now_seconds + REVEAL_FRESHNESS_WINDOW_SECONDS,
    ));
    true
}

/// `isRevealTimestampFresh(issuedAt, nowSeconds)` — both finite and positive,
/// within ±10 minutes.
pub fn is_reveal_timestamp_fresh(issued_at: f64, now_seconds: f64) -> bool {
    if !issued_at.is_finite() || issued_at <= 0.0 {
        return false;
    }
    if !now_seconds.is_finite() || now_seconds <= 0.0 {
        return false;
    }
    (now_seconds - issued_at).abs() <= REVEAL_FRESHNESS_WINDOW_SECONDS
}

/// `parseIssuedAt(value)` — `Number(value)`, finite and positive, floored;
/// `undefined` (`None`) is NaN in JS and therefore null too.
pub fn parse_issued_at(value: Option<&Json>) -> Option<f64> {
    let issued = match value {
        Some(value) => js_to_number(value),
        None => f64::NAN,
    };
    if issued.is_finite() && issued > 0.0 {
        Some(issued.floor())
    } else {
        None
    }
}

/// `parseMessageId(value)` — `BigInt(value)`, rejecting non-positive ids. The
/// BigInt grammar: strings trim, carry an optional sign, and accept
/// `0x`/`0o`/`0b` radix prefixes (underscores and fractional/exponent forms
/// throw); numbers must be integral and use their EXACT double value
/// (`BigInt(1e23)` is the real double, not the shortest string); `null` → 0,
/// booleans → 0/1, single-element arrays coerce through
/// `Array.prototype.join`, plain objects throw.
pub fn parse_message_id(value: &Json) -> Option<String> {
    let digits = match value {
        Json::Null => Some("0".to_string()), // BigInt(null) === 0n
        Json::Bool(flag) => Some(if *flag { "1" } else { "0" }.to_string()),
        Json::Number(_) => bigint_digits_from_f64(js_to_number(value)),
        Json::String(raw) => bigint_from_string(raw),
        Json::Array(items) if items.len() == 1 => bigint_from_string(&js_stringify(&items[0])),
        Json::Array(_) => None,
        Json::Object(_) => None,
    }?;
    if digits == "0" || digits.starts_with('-') {
        return None; // parseMessageId requires a positive id
    }
    Some(digits)
}

/// `resolveNeoxMessageChainContext()` — trusted worker-configured Neo X
/// message contract context; the contract is NEVER taken from the caller.
/// The reviewed NeoX registry is authoritative; explicit env values must match it.
pub struct NeoxMessageChainContext {
    pub rpc_url: String,
    pub contract: String,
    pub chain_id: f64,
    pub chain_identity_valid: bool,
}

pub fn resolve_neox_message_chain_context(env: EnvReader<'_>) -> NeoxMessageChainContext {
    let configured_network = read_env(env, &["MORPHEUS_NETWORK", "NEXT_PUBLIC_MORPHEUS_NETWORK"]);
    let normalized_network = configured_network.trim().to_ascii_lowercase();
    let (network, network_identity_valid) = if normalized_network == "testnet" {
        ("testnet", true)
    } else if normalized_network == "mainnet" || normalized_network.is_empty() {
        ("mainnet", true)
    } else {
        ("mainnet", false)
    };
    let reviewed_chain_id = reviewed_neox_chain_id(network);
    let chain_raw = read_env(env, &["NEOX_MESSAGE_CHAIN_ID", "NEOX_CHAIN_ID"]);
    let parsed = js_number(&chain_raw);
    let chain_identity_valid = network_identity_valid
        && (chain_raw.is_empty()
            || (parsed.is_finite() && parsed.fract() == 0.0 && parsed == reviewed_chain_id));
    NeoxMessageChainContext {
        rpc_url: read_env(env, &["NEOX_MESSAGE_RPC", "NEOX_RPC", "EVM_RPC_URL"]),
        contract: read_env(env, &["NEOX_MESSAGE_CONTRACT"]),
        chain_id: reviewed_chain_id,
        chain_identity_valid,
    }
}

fn hex_bytes(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).ok())
        .collect()
}

fn eip55_checksum(addr_bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let lower: String = addr_bytes
        .iter()
        .flat_map(|byte| [HEX[(byte >> 4) as usize], HEX[(byte & 0xf) as usize]])
        .map(|b| b as char)
        .collect();
    let digest = Keccak256::digest(lower.as_bytes());
    let mut out = String::with_capacity(42);
    out.push_str("0x");
    for (index, character) in lower.chars().enumerate() {
        let nibble = if index % 2 == 0 {
            digest[index / 2] >> 4
        } else {
            digest[index / 2] & 0xf
        };
        if character.is_ascii_lowercase() && nibble >= 8 {
            out.push(character.to_ascii_uppercase());
        } else {
            out.push(character);
        }
    }
    out
}

/// `recoverRevealSigner(statement, signature)` — ethers `verifyMessage`:
/// keccak256 over the EIP-191 personal-message prefix, secp256k1 recovery,
/// and the EIP-55 checksummed address. `v` accepts 27/28 and EIP-155 forms;
/// malformed signatures return `None` like the JS catch does. (The statement
/// is the ASCII statement buildRevealStatement constructs, so JS `.length`
/// and the byte length agree.)
pub fn recover_reveal_signer(statement: &str, signature: &str) -> Option<String> {
    let hex = signature
        .strip_prefix("0x")
        .or_else(|| signature.strip_prefix("0X"))
        .unwrap_or(signature);
    if hex.len() != 130 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let signature_bytes = hex_bytes(hex)?;
    if signature_bytes.len() != 65 {
        return None;
    }
    let mut recovery_id = signature_bytes[64];
    if recovery_id >= 35 {
        recovery_id = (recovery_id - 35) % 2; // EIP-155 chain parity
    } else if recovery_id >= 27 {
        recovery_id -= 27;
    }
    if recovery_id > 1 {
        return None;
    }
    let personal = format!(
        "\x19Ethereum Signed Message:\n{}{}",
        statement.len(),
        statement
    );
    let digest = Keccak256::digest(personal.as_bytes());
    let signature = EcdsaSignature::from_slice(&signature_bytes[..64]).ok()?;
    let recovery = RecoveryId::new(recovery_id == 1, false);
    let verifying_key =
        VerifyingKey::recover_from_prehash(digest.as_slice(), &signature, recovery).ok()?;
    let encoded = verifying_key.to_sec1_point(false);
    let hash = Keccak256::digest(&encoded.as_bytes()[1..]);
    Some(eip55_checksum(&hash[12..]))
}

/// `StringToBigInt` over a string: JS-whitespace trim, optional sign, optional
/// radix prefix, digits only. Returns the canonical decimal digit string.
fn bigint_from_string(raw: &str) -> Option<String> {
    let trimmed = raw.trim_matches(crate::js::is_js_whitespace);
    if trimmed.is_empty() {
        return None;
    }
    let (negative, rest) = match trimmed.as_bytes()[0] {
        b'+' => (false, &trimmed[1..]),
        b'-' => (true, &trimmed[1..]),
        _ => (false, trimmed),
    };
    let rest_bytes = rest.as_bytes();
    let value = match rest_bytes.first() {
        Some(b'0') => match rest_bytes.get(1) {
            Some(b'x') | Some(b'X') => parse_radix_bigint(&rest[2..], 16)?,
            Some(b'o') | Some(b'O') => parse_radix_bigint(&rest[2..], 8)?,
            Some(b'b') | Some(b'B') => parse_radix_bigint(&rest[2..], 2)?,
            _ => parse_radix_bigint(rest, 10)?,
        },
        _ => parse_radix_bigint(rest, 10)?,
    };
    if value == BigInt::from(0) {
        return Some("0".to_string());
    }
    Some(if negative {
        format!("-{value}")
    } else {
        value.to_string()
    })
}

fn parse_radix_bigint(digits: &str, radix: u32) -> Option<BigInt> {
    if digits.is_empty() {
        return None;
    }
    let valid = match radix {
        16 => digits.bytes().all(|b| b.is_ascii_hexdigit()),
        10 => digits.bytes().all(|b| b.is_ascii_digit()),
        8 => digits.bytes().all(|b| (b'0'..=b'7').contains(&b)),
        2 => digits.bytes().all(|b| b == b'0' || b == b'1'),
        _ => return None,
    };
    if !valid {
        return None;
    }
    BigInt::parse_bytes(digits.as_bytes(), radix)
}

/// The exact double as decimal digits: `n = mantissa * 2^exp` with the
/// mantissa in an i128 and the shift applied through [`BigInt`], so values
/// beyond `2^53` (where `String(number)` goes exponential) still expand
/// exactly — matching `BigInt(1e23) === 99999999999999991611392n`.
fn bigint_digits_from_f64(n: f64) -> Option<String> {
    if !n.is_finite() || n.fract() != 0.0 {
        return None;
    }
    if n == 0.0 {
        return Some("0".to_string());
    }
    let bits = n.to_bits();
    let negative = bits >> 63 == 1;
    let biased = ((bits >> 52) & 0x7ff) as i32;
    let frac = bits & 0x000f_ffff_ffff_ffff;
    let (mantissa, exp2) = if biased == 0 {
        (frac as i128, -1074i32)
    } else {
        ((frac | (1u64 << 52)) as i128, biased - 1075)
    };
    let mut value = BigInt::from(mantissa);
    if exp2 >= 0 {
        value <<= exp2;
    } else {
        value >>= -exp2;
    }
    if value == BigInt::from(0) {
        return Some("0".to_string());
    }
    Some(if negative {
        format!("-{value}")
    } else {
        value.to_string()
    })
}

/// `MESSAGE_READ_TIMEOUT_MS` — ethers defaults to 300s, far too long for a
/// request lane.
pub const MESSAGE_READ_TIMEOUT_MS: u64 = 10_000;

/// `ethers.ZeroAddress` — the sentinel the handler treats as "no recipient".
pub const ZERO_ADDRESS: &str = "0x0000000000000000000000000000000000000000";

/// The decoded `getMessage(uint256)` tuple, shaped like the ethers result the
/// JS handler consumes (`unlockTime`/`sentAt` as Numbers, matching
/// `Number(bigint)`).
#[derive(Clone, Debug)]
pub struct NeoXMessage {
    pub sender: String,
    pub recipient: String,
    pub envelope: Vec<u8>,
    pub unlock_time: f64,
    pub sent_at: f64,
    pub revealed: bool,
    pub plaintext: String,
}

/// `readMessageFromChain({ rpcUrl, chainId, contract, messageId })` inputs.
#[derive(Clone)]
pub struct ReadMessageRequest {
    pub rpc_url: String,
    pub chain_id: f64,
    pub contract: String,
    pub message_id: String,
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    bytes
        .iter()
        .flat_map(|byte| [HEX[(byte >> 4) as usize], HEX[(byte & 0xf) as usize]])
        .map(|nibble| nibble as char)
        .collect()
}

fn word_at(encoded: &[u8], index: usize) -> Option<&[u8]> {
    encoded.get(index * 32..(index + 1) * 32)
}

fn word_u64(word: &[u8]) -> Option<u64> {
    word.get(24..)
        .and_then(|tail| tail.try_into().ok())
        .map(u64::from_be_bytes)
}

fn word_usize(encoded: &[u8], index: usize) -> Option<usize> {
    word_at(encoded, index)
        .and_then(word_u64)
        .map(|value| value as usize)
}

fn word_address(word: &[u8]) -> String {
    eip55_checksum(&word[12..])
}

fn dynamic_field(encoded: &[u8], offset: usize) -> Option<Vec<u8>> {
    let length_word = encoded.get(offset..offset.checked_add(32)?)?;
    let length = word_u64(length_word)? as usize;
    let start = offset.checked_add(32)?;
    encoded
        .get(start..start.checked_add(length)?)
        .map(<[u8]>::to_vec)
}

/// ABI-decode
/// `(address,address,bytes,uint64,uint64,bool,string)` — every bound is
/// checked, so a hostile/misconfigured contract's garbage decodes to `None`
/// (surfaced as a read failure) instead of a panic.
fn decode_message_tuple(encoded: &[u8]) -> Option<NeoXMessage> {
    let w0 = word_at(encoded, 0)?;
    let w1 = word_at(encoded, 1)?;
    let w3 = word_at(encoded, 3)?;
    let w4 = word_at(encoded, 4)?;
    let w5 = word_at(encoded, 5)?;
    let sender = word_address(w0);
    let recipient = word_address(w1);
    let envelope_offset = word_usize(encoded, 2)?;
    let unlock_time = word_u64(w3)? as f64;
    let sent_at = word_u64(w4)? as f64;
    let revealed = w5[31] & 1 == 1;
    let plaintext_offset = word_usize(encoded, 6)?;
    let envelope = dynamic_field(encoded, envelope_offset)?;
    let plaintext = String::from_utf8(dynamic_field(encoded, plaintext_offset)?).ok()?;
    Some(NeoXMessage {
        sender,
        recipient,
        envelope,
        unlock_time,
        sent_at,
        revealed,
        plaintext,
    })
}

/// `readMessageFromChain` — a single `eth_call` for `getMessage(uint256)`
/// against the trusted worker-configured contract (the contract is NEVER taken
/// from the caller), with the pinned 10s read timeout, decoded into the
/// [`NeoXMessage`] tuple.
pub fn read_message_from_chain(
    request: &ReadMessageRequest,
    transport: HttpTransport<'_>,
) -> Result<NeoXMessage, String> {
    let parsed_url =
        Url::parse(&request.rpc_url).map_err(|_| "RPC URL must use HTTPS".to_string())?;
    if parsed_url.scheme() != "https" {
        return Err("RPC URL must use HTTPS".to_string());
    }
    let selector = Keccak256::digest(b"getMessage(uint256)");
    let mut data = selector[..4].to_vec();
    let id = BigInt::parse_bytes(request.message_id.as_bytes(), 10)
        .ok_or_else(|| "malformed message id".to_string())?;
    let (_, id_bytes) = id.to_bytes_be();
    if id_bytes.len() > 32 {
        return Err("message id exceeds the uint256 argument range".to_string());
    }
    data.extend(std::iter::repeat_n(0u8, 32 - id_bytes.len()));
    data.extend_from_slice(&id_bytes);

    let rpc_body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_call",
        "params": [
            {
                "to": request.contract,
                "data": format!("0x{}", hex_encode(&data)),
            },
            "latest",
        ],
    });
    let http_request = HttpRequest {
        url: request.rpc_url.clone(),
        method: "POST".to_string(),
        headers: vec![("content-type".to_string(), "application/json".to_string())],
        body: Some(serde_json::to_vec(&rpc_body).expect("rpc body serializes")),
        timeout_ms: MESSAGE_READ_TIMEOUT_MS,
        follow_redirects: true,
    };
    let response = transport(&http_request)?;
    let payload: Json = serde_json::from_slice(&response.body).unwrap_or(Json::Null);
    let error_message = |payload: &Json| -> Option<String> {
        payload
            .get("error")
            .and_then(|error| error.get("message"))
            .filter(|message| !message.is_null())
            .map(|message| js_trim_string(Some(message)))
            .filter(|message| !message.is_empty())
    };
    if !(200..300).contains(&response.status) {
        let fallback = || format!("rpc request failed with status {}", response.status);
        return Err(payload
            .get("error")
            .and_then(|error| error.get("message"))
            .filter(|message| !message.is_null())
            .map(|message| js_trim_string(Some(message)))
            .filter(|message| !message.is_empty())
            .or_else(|| {
                payload
                    .get("message")
                    .map(|message| js_trim_string(Some(message)))
                    .filter(|message| !message.is_empty())
            })
            .unwrap_or_else(fallback));
    }
    if let Some(message) = error_message(&payload) {
        return Err(message);
    }
    let result = js_trim_string(payload.get("result"));
    let hex = result
        .strip_prefix("0x")
        .or_else(|| result.strip_prefix("0X"))
        .unwrap_or(&result);
    if hex.is_empty() {
        return Err("eth_call returned no data".to_string());
    }
    let encoded = hex_bytes(hex)
        .filter(|bytes| bytes.len() >= 7 * 32)
        .ok_or_else(|| "malformed getMessage return data".to_string())?;
    decode_message_tuple(&encoded).ok_or_else(|| "malformed getMessage return data".to_string())
}

/// `handleMessageReveal(payload, nowSeconds, { readMessage })` — the full
/// decision tree, rendered as `(status, json-body)` exactly like the JS
/// `json()`/`jsonError()` responses. The plaintext of a recipient-only
/// message leaves ONLY through the authenticated response — never on-chain.
#[allow(clippy::too_many_arguments)]
pub fn handle_message_reveal(
    payload: &Json,
    now_seconds: f64,
    env: EnvReader<'_>,
    deriver: WrapKeyDeriver<'_>,
    reader: KeystoreReader<'_>,
    repo_root: &str,
    warn_log: &dyn Fn(&str, &str, &str),
    ephemeral: &mut dyn FnMut() -> OracleKeyMaterial,
    read_message: &dyn Fn(&ReadMessageRequest) -> Result<NeoXMessage, String>,
) -> (u16, Json) {
    let bad_request = |message: &str| (400u16, json!({ "error": message }));

    // `String(payload.chain || payload.network || 'neox').trim().toLowerCase()`
    let chain = ["chain", "network"]
        .iter()
        .find_map(|key| payload.get(key).filter(|value| js_truthy(value)))
        .map_or_else(|| "neox".to_string(), |value| js_trim_string(Some(value)))
        .to_lowercase();
    if !is_neox_chain_alias(&chain) {
        return bad_request("recipient reveal currently supports the neox chain only");
    }

    // `payload.messageId ?? payload.id` — first non-nullish
    let id_raw = payload
        .get("messageId")
        .filter(|value| !value.is_null())
        .or_else(|| payload.get("id"));
    let Some(message_id) = id_raw.and_then(parse_message_id) else {
        return bad_request("valid messageId required");
    };

    // `typeof payload.signature === 'string' ? payload.signature.trim() : ''`
    let signature = match payload.get("signature") {
        Some(value @ Json::String(_)) => js_trim_string(Some(value)),
        _ => String::new(),
    };
    if signature.is_empty() {
        return bad_request("recipient signature required (field: signature)");
    }

    // `payload.issuedAt ?? payload.issued_at ?? payload.issued`
    let issued_raw = ["issuedAt", "issued_at", "issued"]
        .iter()
        .find_map(|key| payload.get(key).filter(|value| !value.is_null()));
    let Some(issued_at) = parse_issued_at(issued_raw) else {
        return bad_request("issuedAt (unix seconds) required");
    };
    if !is_reveal_timestamp_fresh(issued_at, now_seconds) {
        return (
            403,
            json!({ "error": "reveal request expired; re-sign with a current timestamp" }),
        );
    }

    let context = resolve_neox_message_chain_context(env);
    if !context.chain_identity_valid {
        return (
            503,
            json!({ "error": "recipient reveal is not configured for the reviewed Neo X identity" }),
        );
    }
    if context.rpc_url.is_empty() || context.contract.is_empty() {
        return (
            503,
            json!({ "error": "recipient reveal is not configured on this worker" }),
        );
    }

    let message = match read_message(&ReadMessageRequest {
        rpc_url: context.rpc_url.clone(),
        chain_id: context.chain_id,
        contract: context.contract.clone(),
        message_id: message_id.clone(),
    }) {
        Ok(message) => message,
        Err(error) => {
            return (
                502,
                json!({
                    "error": format!(
                        "failed to read message on-chain: {}",
                        sanitize_error_message(&error)
                    )
                }),
            );
        }
    };

    let recipient = message.recipient;
    if !js_truthy(&Json::String(recipient.clone())) || recipient == ZERO_ADDRESS {
        return bad_request("message has no designated recipient");
    }

    // This lane serves recipient-only messages exclusively: a time-locked
    // message must go through the contract-gated /oracle/decrypt lane after
    // its unlock has passed — decrypting here would hand the recipient the
    // plaintext before the time-lock expires.
    if message.unlock_time != 0.0 {
        return (
            403,
            json!({ "error": "time-locked messages must use the contract-gated reveal lane" }),
        );
    }

    let statement = build_reveal_statement(
        &json!(context.chain_id),
        &context.contract,
        &Json::String(message_id.clone()),
        &json!(issued_at),
    );
    let Some(signer) = recover_reveal_signer(&statement, &signature) else {
        return bad_request("malformed signature");
    };
    if !addresses_equal(&signer, &recipient) {
        return (
            403,
            json!({ "error": "signature does not match the message recipient" }),
        );
    }

    // Single-use, claimed only once the presentation is PROVEN to be the
    // recipient's: a malformed or mismatched signature must not be able to
    // burn a key the legitimate recipient is about to use. The cost of
    // claiming here rather than after the decrypt is that a reveal whose
    // stored envelope is undecodable consumes its key — but that failure is
    // not retry-fixable, so no honest client loses anything.
    if !claim_reveal_presentation(
        &reveal_presentation_key(&statement, &signature),
        now_seconds,
    ) {
        return (
            403,
            json!({ "error": "reveal request already used; re-sign with a current timestamp" }),
        );
    }

    // `ethers.toUtf8String(message.envelope)` throws on invalid UTF-8.
    let Ok(envelope) = String::from_utf8(message.envelope) else {
        return bad_request("stored envelope is not decodable");
    };

    match decrypt_encrypted_token_resolved(
        &Json::String(envelope),
        env,
        deriver,
        reader,
        repo_root,
        warn_log,
        ephemeral,
    ) {
        Ok(Some(plaintext)) => (
            200,
            json!({
                "plaintext": plaintext,
                "recipient": recipient,
                "messageId": message_id,
                "unlockTime": js_number_value(message.unlock_time),
            }),
        ),
        Ok(None) => bad_request("decryption returned empty result"),
        Err(error) => (400, json!({ "error": sanitize_error_message(&error) })),
    }
}

// ---------------------------------------------------------------------------
// Gated decrypt lane (`capabilities.js` handleOracleDecrypt + the E5 gate)
// ---------------------------------------------------------------------------

/// `decryptBindingRequired()` — the E5/C3/S21 gate: production ignores the
/// opt-out entirely (fail closed); elsewhere `0|false|no|off` opts out and
/// everything else (including unset) requires binding.
pub fn decrypt_binding_required(env: EnvReader<'_>) -> bool {
    // `trimString(env('NODE_ENV')).toLowerCase() === 'production'`
    if read_env(env, &["NODE_ENV"]).to_lowercase() == "production" {
        return true;
    }
    let raw = read_env(env, &["MORPHEUS_ORACLE_DECRYPT_REQUIRE_BINDING"]).to_lowercase();
    !matches!(raw.as_str(), "0" | "false" | "no" | "off")
}

/// `extractDecryptCiphertext(payload)` — the first non-empty trimmed string
/// among the accepted field names (the `&&`/`||` chain yields the TRIMMED
/// value and falls through on empty).
pub fn extract_decrypt_ciphertext(payload: &Json) -> String {
    ["envelope", "ciphertext", "sealed", "encrypted_payload"]
        .iter()
        .find_map(|key| match payload.get(*key) {
            Some(Json::String(value)) => {
                let trimmed = value.trim();
                (!trimmed.is_empty()).then(|| trimmed.to_string())
            }
            _ => None,
        })
        .unwrap_or_default()
}

/// `hasDecryptBindingFields(payload)` — `!== undefined` on the parsed JSON,
/// so an explicit `null` counts as present.
pub fn has_decrypt_binding_fields(payload: &Json) -> bool {
    ["messageId", "message_id", "id"]
        .iter()
        .any(|key| payload.get(*key).is_some())
}

/// `assertDecryptBinding(payload, ciphertext, {readMessage})` — the trust
/// DECISION re-derived inside the enclave: the message comes from the
/// worker-configured contract (never caller fields), the supplied envelope
/// must BE the on-chain stored envelope, and the time-lock must have
/// actually expired. `Ok(())` passes the gate; `Err` is the rejection
/// Response as `(status, body)`. `now_seconds` is Date.now()/1000 (floored
/// here, where the JS floors).
pub fn assert_decrypt_binding(
    payload: &Json,
    ciphertext: &str,
    env: EnvReader<'_>,
    now_seconds: f64,
    read_message: &dyn Fn(&ReadMessageRequest) -> Result<NeoXMessage, String>,
) -> Result<(), (u16, Json)> {
    let reject = |status: u16, message: &str| Err((status, json!({ "error": message })));

    // `trimString(payload.chain || payload.network || 'neox').toLowerCase()`
    let chain = ["chain", "network"]
        .iter()
        .find_map(|key| payload.get(key).filter(|value| js_truthy(value)))
        .map_or_else(|| "neox".to_string(), |value| js_trim_string(Some(value)))
        .to_lowercase();
    if !is_neox_chain_alias(&chain) {
        return reject(400, "gated decrypt currently supports the neox chain only");
    }

    // `payload.messageId ?? payload.message_id ?? payload.id` — first non-nullish
    let id_raw = ["messageId", "message_id", "id"]
        .iter()
        .find_map(|key| payload.get(key).filter(|value| !value.is_null()));
    let Some(message_id) = id_raw.and_then(parse_message_id) else {
        return reject(400, "valid messageId required for gated decrypt");
    };

    let context = resolve_neox_message_chain_context(env);
    if !context.chain_identity_valid {
        return reject(
            503,
            "gated decrypt is not configured for the reviewed Neo X identity",
        );
    }
    if context.rpc_url.is_empty() || context.contract.is_empty() {
        return reject(503, "gated decrypt is not configured on this worker");
    }

    // If the caller names a contract it MUST match the trusted worker
    // contract; the read itself always uses the worker-configured address.
    let requested_contract = ["contract", "contract_address"]
        .iter()
        .find_map(|key| payload.get(key).filter(|value| js_truthy(value)))
        .map_or_else(String::new, |value| js_trim_string(Some(value)));
    if !requested_contract.is_empty()
        && requested_contract.to_lowercase() != context.contract.to_lowercase()
    {
        return reject(
            403,
            "contract does not match the worker-configured message contract",
        );
    }

    let message = match read_message(&ReadMessageRequest {
        rpc_url: context.rpc_url.clone(),
        chain_id: context.chain_id,
        contract: context.contract.clone(),
        message_id: message_id.clone(),
    }) {
        Ok(message) => message,
        Err(error) => {
            return Err((
                502,
                json!({
                    "error": format!(
                        "failed to read message on-chain: {}",
                        sanitize_error_message(&error)
                    )
                }),
            ));
        }
    };

    // Bind the ciphertext to the on-chain stored envelope so a captured or
    // foreign ciphertext cannot ride a valid messageId.
    let Ok(stored_envelope) = String::from_utf8(message.envelope) else {
        return reject(400, "stored envelope is not decodable");
    };
    if stored_envelope.trim() != ciphertext.trim() {
        return reject(
            403,
            "envelope does not match the on-chain message for this messageId",
        );
    }

    // `Number(message.unlockTime || 0)` — the decode path yields a
    // non-negative f64, so the falsy coercion collapses to the <= 0 check.
    if message.unlock_time <= 0.0 {
        return reject(
            403,
            "message is not time-locked; use the recipient reveal lane",
        );
    }
    if now_seconds.floor() < message.unlock_time {
        return reject(403, "message time-lock has not expired yet");
    }

    Ok(())
}

/// `handleOracleDecrypt({ payload }, deps)` — the token-gated decrypt lane.
/// Envelope extraction, the E5 binding gate, then the X25519 envelope
/// decrypt with the key material resolved here (the JS singleton cache is a
/// runtime concern the host owns).
#[allow(clippy::too_many_arguments)]
pub fn handle_oracle_decrypt(
    payload: &Json,
    env: EnvReader<'_>,
    now_seconds: f64,
    deriver: WrapKeyDeriver<'_>,
    reader: KeystoreReader<'_>,
    repo_root: &str,
    warn_log: &dyn Fn(&str, &str, &str),
    ephemeral: &mut dyn FnMut() -> OracleKeyMaterial,
    read_message: &dyn Fn(&ReadMessageRequest) -> Result<NeoXMessage, String>,
) -> (u16, Json) {
    let bad_request = |message: &str| (400u16, json!({ "error": message }));

    let ciphertext = extract_decrypt_ciphertext(payload);
    if ciphertext.is_empty() {
        return bad_request("sealed envelope required (field: envelope)");
    }

    if has_decrypt_binding_fields(payload) {
        if let Err(rejection) =
            assert_decrypt_binding(payload, &ciphertext, env, now_seconds, read_message)
        {
            return rejection;
        }
    } else if decrypt_binding_required(env) {
        return bad_request("gated decrypt requires (chain, contract, messageId) binding fields");
    }

    match decrypt_encrypted_token_resolved(
        &Json::String(ciphertext),
        env,
        deriver,
        reader,
        repo_root,
        warn_log,
        ephemeral,
    ) {
        Ok(Some(plaintext)) => (200, json!({ "plaintext": plaintext })),
        Ok(None) => bad_request("decryption returned empty result"),
        Err(error) => (400, json!({ "error": sanitize_error_message(&error) })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oracle::crypto::{
        generate_x25519_key_material, KeystoreReadError, ORACLE_ENVELOPE_INFO,
    };
    use crate::transport::HttpResponse;
    use serde_json::json;
    use std::collections::HashMap;

    fn env_from(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |name| map.get(name).cloned()
    }

    // Golden vector harvested from ethers (wallet 0x1111…11, personal_sign).
    const GOLDEN_STATEMENT: &str = "Morpheus Neo Message\nRecipient reveal request\nchain: 47763\ncontract: 0x9e21879d5487ee0c577263629c6bd4d0bff5c678\nmessage: 42\nissued: 1900000000";
    const GOLDEN_SIGNATURE: &str = "0x344e50cb49ab10bad17d387a6b66a8045d788d457b3e5859037ba10dadad20066cd57a03b0ecf15e8cb2172e830e0445c8c86feb0715c4f0bf17158a59a1ac9f1c";
    const GOLDEN_ADDRESS: &str = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";

    #[test]
    fn eip191_recovery_matches_ethers_and_eip55_checksums() {
        let signer = recover_reveal_signer(GOLDEN_STATEMENT, GOLDEN_SIGNATURE).expect("recovers");
        assert_eq!(signer, GOLDEN_ADDRESS);
        // addressesEqual is case-insensitive, so a lowercase rendering of the
        // recovered address still matches the on-chain checksummed recipient.
        assert!(addresses_equal(&signer, &signer.to_lowercase()));
        assert!(addresses_equal(
            &signer,
            &signer.to_uppercase().replace("0X", "0x")
        ));

        // The exact v byte ethers produces is 27-based; both parity spellings
        // of the same signature recover the same signer.
        let mut raw = hex_bytes(GOLDEN_SIGNATURE.trim_start_matches("0x")).unwrap();
        raw[64] -= 27; // v=27 → recid 0 spelling
        let v0: String = raw.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            recover_reveal_signer(GOLDEN_STATEMENT, &v0).as_deref(),
            Some(GOLDEN_ADDRESS)
        );

        assert!(recover_reveal_signer(GOLDEN_STATEMENT, "0xdead").is_none());
        assert!(recover_reveal_signer(GOLDEN_STATEMENT, "not-a-signature").is_none());
        let garbage_v = "0x".to_string() + &"ab".repeat(64) + "02";
        assert!(recover_reveal_signer(GOLDEN_STATEMENT, &garbage_v).is_none());
        let wrong_statement = GOLDEN_STATEMENT.replace("message: 42", "message: 43");
        assert_ne!(
            recover_reveal_signer(&wrong_statement, GOLDEN_SIGNATURE).as_deref(),
            Some(GOLDEN_ADDRESS)
        );
    }

    #[test]
    fn chain_context_resolves_env_aliases_with_the_number_or_default() {
        let context = resolve_neox_message_chain_context(&env_from(&[
            ("NEOX_MESSAGE_RPC", "https://rpc.example"),
            ("NEOX_MESSAGE_CONTRACT", "0xabc"),
        ]));
        assert_eq!(context.rpc_url, "https://rpc.example");
        assert_eq!(context.contract, "0xabc");
        assert_eq!(context.chain_id, reviewed_neox_chain_id("mainnet"));
        assert!(context.chain_identity_valid);

        let context = resolve_neox_message_chain_context(&env_from(&[
            ("NEOX_RPC", "https://rpc-alias.example"),
            ("EVM_RPC_URL", "https://ignored.example"),
            ("NEOX_CHAIN_ID", "31337"),
        ]));
        assert_eq!(context.rpc_url, "https://rpc-alias.example");
        assert_eq!(context.chain_id, reviewed_neox_chain_id("mainnet"));
        assert!(!context.chain_identity_valid);

        let context = resolve_neox_message_chain_context(&env_from(&[("NEOX_CHAIN_ID", "junk")]));
        assert_eq!(context.chain_id, reviewed_neox_chain_id("mainnet"));
        assert!(!context.chain_identity_valid);

        let context =
            resolve_neox_message_chain_context(&env_from(&[("MORPHEUS_NETWORK", "staging")]));
        assert!(!context.chain_identity_valid);
    }

    #[test]
    fn reveal_statement_is_deterministic_and_lowercases_the_contract() {
        let a = build_reveal_statement(
            &json!(47763),
            "0xABCdef0000000000000000000000000000000001",
            &json!("5"),
            &json!(1_700_000_000),
        );
        let b = build_reveal_statement(
            &json!("47763"),
            "0xabcdef0000000000000000000000000000000001",
            &json!(5),
            &json!("1700000000"),
        );
        assert_eq!(a, b);
        assert!(a.contains("contract: 0xabcdef0000000000000000000000000000000001"));
        assert!(a.contains("message: 5"));
        assert!(a.contains("issued: 1700000000"));
        assert_eq!(
            a,
            "Morpheus Neo Message\nRecipient reveal request\nchain: 47763\n\
             contract: 0xabcdef0000000000000000000000000000000001\nmessage: 5\n\
             issued: 1700000000"
        );
    }

    #[test]
    fn address_equality_compares_checksum_insensitively() {
        let address = "0xdD880fF60bA61c7a8C0B6F2ee0AC0Db63aCB9e39";
        assert!(addresses_equal(address, &address.to_lowercase()));
        assert!(!addresses_equal(
            address,
            "0x0000000000000000000000000000000000000000"
        ));
        assert!(!addresses_equal("", address));
        assert!(!addresses_equal("not-an-address", "not-an-address"));
    }

    #[test]
    fn reveal_freshness_enforces_the_window() {
        let now = 1_700_000_000.0;
        assert!(is_reveal_timestamp_fresh(now, now));
        assert!(is_reveal_timestamp_fresh(now - 300.0, now));
        assert!(is_reveal_timestamp_fresh(now + 300.0, now));
        assert!(!is_reveal_timestamp_fresh(now - 601.0, now));
        assert!(!is_reveal_timestamp_fresh(now + 601.0, now));
        assert!(!is_reveal_timestamp_fresh(0.0, now));
        assert!(!is_reveal_timestamp_fresh(f64::NAN, now));
        assert!(!is_reveal_timestamp_fresh(1_700_000_000.0, f64::NAN));
    }

    #[test]
    fn chain_aliases_accept_only_the_neox_spellings() {
        for alias in NEOX_CHAIN_ALIASES {
            assert!(is_neox_chain_alias(alias));
        }
        assert!(!is_neox_chain_alias("neo_n3"));
        assert!(!is_neox_chain_alias("neo-n3"));
        assert_eq!(reviewed_neox_chain_id("mainnet"), 47763.0);
    }

    #[test]
    fn issued_at_parses_and_floors_positive_finite_values() {
        assert_eq!(
            parse_issued_at(Some(&json!(1_700_000_000))),
            Some(1_700_000_000.0)
        );
        assert_eq!(
            parse_issued_at(Some(&json!(1_700_000_000.9))),
            Some(1_700_000_000.0)
        );
        assert_eq!(
            parse_issued_at(Some(&json!("1700000000"))),
            Some(1_700_000_000.0)
        );
        assert_eq!(parse_issued_at(Some(&json!("abc"))), None);
        assert_eq!(parse_issued_at(Some(&json!(0))), None);
        assert_eq!(parse_issued_at(Some(&json!(-5))), None);
        // Number(null) is 0 → rejected; Number(undefined) is NaN → rejected
        assert_eq!(parse_issued_at(Some(&Json::Null)), None);
        assert_eq!(parse_issued_at(None), None);
    }

    #[test]
    fn message_ids_follow_the_bigint_grammar() {
        assert_eq!(parse_message_id(&json!(1)), Some("1".to_string()));
        assert_eq!(parse_message_id(&json!(9)), Some("9".to_string()));
        assert_eq!(parse_message_id(&json!(0)), None); // id must be positive
        assert_eq!(parse_message_id(&json!(-5)), None);
        assert_eq!(parse_message_id(&json!("5")), Some("5".to_string()));
        assert_eq!(parse_message_id(&json!("007")), Some("7".to_string()));
        assert_eq!(parse_message_id(&json!("0x1f")), Some("31".to_string()));
        assert_eq!(parse_message_id(&json!("0B101")), Some("5".to_string()));
        assert_eq!(parse_message_id(&json!("0o17")), Some("15".to_string()));
        assert_eq!(parse_message_id(&json!("  7  ")), Some("7".to_string()));
        assert_eq!(parse_message_id(&json!("+12")), Some("12".to_string()));
        assert_eq!(parse_message_id(&json!("-1")), None);
        // fractional, exponent and underscore forms throw in JS
        assert_eq!(parse_message_id(&json!("1.5")), None);
        assert_eq!(parse_message_id(&json!("1e3")), None);
        assert_eq!(parse_message_id(&json!("1_000")), None);
        assert_eq!(parse_message_id(&json!("")), None);
        assert_eq!(parse_message_id(&json!("abc")), None);
        assert_eq!(parse_message_id(&json!(1.5)), None);
        assert_eq!(parse_message_id(&json!(true)), Some("1".to_string()));
        // BigInt(null) is 0n → not positive
        assert_eq!(parse_message_id(&Json::Null), None);
        // single-element arrays coerce through join
        assert_eq!(parse_message_id(&json!([5])), Some("5".to_string()));
        assert_eq!(parse_message_id(&json!(["0x2"])), Some("2".to_string()));
        assert_eq!(parse_message_id(&json!([])), None);
        assert_eq!(parse_message_id(&json!([1, 2])), None);
        assert_eq!(parse_message_id(&json!([null])), None);
        // objects and huge non-integral values throw
        assert_eq!(parse_message_id(&json!({})), None);
    }

    #[test]
    fn bigint_numbers_expand_the_exact_double_value() {
        assert_eq!(
            parse_message_id(&json!(1e21)),
            Some("1000000000000000000000".to_string())
        );
        // the double nearest 1e23 is NOT 1e23 — BigInt(1e23) sees the exact value
        assert_eq!(
            bigint_digits_from_f64(1e23),
            Some("99999999999999991611392".to_string())
        );
        assert_eq!(bigint_digits_from_f64(0.0), Some("0".to_string()));
        assert_eq!(bigint_digits_from_f64(-0.0), Some("0".to_string()));
        assert_eq!(bigint_digits_from_f64(f64::NAN), None);
        assert_eq!(bigint_digits_from_f64(f64::INFINITY), None);
        // -3.0 parses as a BigInt but loses at the positivity gate
        assert_eq!(parse_message_id(&json!(-3.0)), None);
    }

    // ---- 5b-3: on-chain read (`readMessageFromChain`) + the handler ----

    // Mirrors crypto.rs's harvested golden keypair: the oracle X25519 key the
    // handler resolves through MORPHEUS_ORACLE_KEY_MATERIAL_JSON.
    const GOLDEN_PUBLIC_KEY_RAW_B64: &str = "vAB/ripK5xzT1PT+KGbSvEEPfGQoxQliNWjSFjDfuhU=";
    const GOLDEN_PRIVATE_KEY_PKCS8_B64: &str =
        "MC4CAQAwBQYDK2VuBCIEIEgdmKz6RqTG40pP8SVY+7XPGOUXAIbmI4alIH3uMYZ8";
    // Deterministic throwaway test key (hardhat account #1; not used live).
    const TEST_PK_HEX: &str = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const REVEAL_CONTRACT: &str = "0xd1906192c2308ae416acda96238ca846ebb83f15";
    const REVEAL_NOW: f64 = 1_700_000_000.0;
    const SEAL_EPK_SCALAR: [u8; 32] = [42u8; 32];
    const SEAL_IV: [u8; 12] = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];

    fn reveal_wallet() -> k256::ecdsa::SigningKey {
        let bytes = hex_bytes(TEST_PK_HEX).unwrap();
        k256::ecdsa::SigningKey::from_slice(&bytes[..]).unwrap()
    }

    fn reveal_wallet_address() -> String {
        let encoded = reveal_wallet().verifying_key().to_sec1_point(false);
        let hash = Keccak256::digest(&encoded.as_bytes()[1..]);
        eip55_checksum(&hash[12..])
    }

    /// `wallet.signMessage(statement)` — keccak256 over the EIP-191 prefix,
    /// 65-byte hex signature with the 27-based parity byte.
    fn sign_statement(statement: &str) -> String {
        let key = reveal_wallet();
        let personal = format!(
            "\x19Ethereum Signed Message:\n{}{}",
            statement.len(),
            statement
        );
        let digest = Keccak256::digest(personal.as_bytes());
        let prehash: [u8; 32] = digest.into();
        let (signature, recid) = key.sign_prehash_recoverable(&prehash);
        assert!(!recid.is_x_reduced());
        let mut raw = signature.to_bytes().to_vec();
        raw.push(27 + recid.is_y_odd() as u8);
        format!("0x{}", hex_encode(&raw))
    }

    /// Seals plaintext to the oracle's X25519 key the same way frontends do
    /// (X25519-HKDF-SHA256-AES-256-GCM, info 'morpheus-confidential-payload-v2').
    fn seal_for_oracle(recipient_public: &[u8], plaintext: &str) -> String {
        use aes_gcm::aead::Aead as _;
        use aes_gcm::KeyInit as _;
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine as _;
        use curve25519_dalek::constants::X25519_BASEPOINT;
        use curve25519_dalek::montgomery::MontgomeryPoint;
        use hkdf::Hkdf;
        use sha2::Sha256;

        let mut recipient_point = [0u8; 32];
        recipient_point.copy_from_slice(recipient_public);
        let epk = X25519_BASEPOINT.mul_clamped(SEAL_EPK_SCALAR);
        let shared = MontgomeryPoint(recipient_point).mul_clamped(SEAL_EPK_SCALAR);
        let mut info = ORACLE_ENVELOPE_INFO.to_vec();
        info.extend_from_slice(epk.as_bytes());
        info.extend_from_slice(recipient_public);
        let hkdf = Hkdf::<Sha256>::new(Some(recipient_public), shared.as_bytes());
        let mut aes_key = [0u8; 32];
        hkdf.expand(&info, &mut aes_key).unwrap();
        let cipher = aes_gcm::Aes256Gcm::new_from_slice(&aes_key).unwrap();
        let sealed = cipher
            .encrypt(SEAL_IV.as_slice().into(), plaintext.as_bytes())
            .unwrap();
        let (ct, tag) = sealed.split_at(sealed.len() - 16);
        let envelope = json!({
            "v": 2,
            "alg": "X25519-HKDF-SHA256-AES-256-GCM",
            "epk": STANDARD.encode(epk.as_bytes()),
            "iv": STANDARD.encode(SEAL_IV),
            "ct": STANDARD.encode(ct),
            "tag": STANDARD.encode(tag),
        });
        STANDARD.encode(envelope.to_string().as_bytes())
    }

    fn no_keystore(_path: &str) -> Result<String, KeystoreReadError> {
        Err(KeystoreReadError::NotFound)
    }

    fn panic_read(_request: &ReadMessageRequest) -> Result<NeoXMessage, String> {
        panic!("readMessage must not be reached");
    }

    fn configured_env() -> impl Fn(&str) -> Option<String> {
        // The JS suite sets MORPHEUS_ALLOW_EPHEMERAL_KEY=true globally, so a
        // decrypt without configured key material falls back to an ephemeral
        // key (which then fails envelope parsing with the JS message).
        env_from(&[
            ("NEOX_MESSAGE_RPC", "https://rpc.example.com"),
            ("NEOX_MESSAGE_CONTRACT", REVEAL_CONTRACT),
            ("MORPHEUS_ALLOW_EPHEMERAL_KEY", "true"),
        ])
    }

    fn reveal_key_env() -> impl Fn(&str) -> Option<String> {
        let key_json = json!({
            "public_key_raw": GOLDEN_PUBLIC_KEY_RAW_B64,
            "private_key_pkcs8": GOLDEN_PRIVATE_KEY_PKCS8_B64,
        })
        .to_string();
        env_from(&[
            ("NEOX_MESSAGE_RPC", "https://rpc.example.com"),
            ("NEOX_MESSAGE_CONTRACT", REVEAL_CONTRACT),
            ("MORPHEUS_ORACLE_KEY_MATERIAL_JSON", key_json.as_str()),
        ])
    }

    fn signed_reveal_payload(message_id: i64) -> Json {
        let statement = build_reveal_statement(
            &json!(reviewed_neox_chain_id("mainnet")),
            REVEAL_CONTRACT,
            &Json::String(message_id.to_string()),
            &json!(REVEAL_NOW),
        );
        json!({
            "chain": "neox",
            "signature": sign_statement(&statement),
            "messageId": message_id,
            "issuedAt": REVEAL_NOW,
        })
    }

    fn reveal(
        payload: &Json,
        env: &dyn Fn(&str) -> Option<String>,
        read: &dyn Fn(&ReadMessageRequest) -> Result<NeoXMessage, String>,
    ) -> (u16, Json) {
        // Reached only on the stable-key-source attempt; the tests that reach
        // decrypt either configure key material or fall back to ephemeral.
        let deriver =
            |_key_path: &str, _context: &str| -> Result<Vec<u8>, String> { Ok(vec![7u8; 48]) };
        let warn = |_level: &str, _event: &str, _detail: &str| {};
        let mut state = 0u8;
        let mut rng = move |buffer: &mut [u8]| {
            for byte in buffer.iter_mut() {
                *byte = state;
                state = state.wrapping_add(1);
            }
        };
        // The lane no longer mints its own ephemeral key: it serves the one its
        // caller owns, so the deterministic generator rides in as the provider.
        let mut ephemeral = || generate_x25519_key_material(&mut rng);
        handle_message_reveal(
            payload,
            REVEAL_NOW,
            env,
            &deriver,
            &no_keystore,
            "/repo",
            &warn,
            &mut ephemeral,
            read,
        )
    }

    #[test]
    fn read_message_from_chain_encodes_get_message_and_decodes_the_tuple() {
        let sender = "0x1111111111111111111111111111111111111111";
        let recipient = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
        let envelope = b"sealed-payload".to_vec();
        let plaintext = b"stored plaintext";
        let envelope_offset = 7 * 32;
        let plaintext_offset = envelope_offset + 32 + 32;

        fn address_word(address: &str) -> String {
            let bytes = hex_bytes(&address[2..]).unwrap();
            let mut word = [0u8; 32];
            word[12..].copy_from_slice(&bytes);
            hex_encode(&word)
        }
        fn uint64_word(value: u64) -> String {
            let mut word = [0u8; 32];
            word[24..].copy_from_slice(&value.to_be_bytes());
            hex_encode(&word)
        }
        fn bool_word(flag: bool) -> String {
            let mut word = [0u8; 32];
            word[31] = flag as u8;
            hex_encode(&word)
        }
        fn dynamic_word(data: &[u8]) -> String {
            let padded = data.len().div_ceil(32) * 32;
            let mut chunk = data.to_vec();
            chunk.resize(padded, 0);
            format!("{}{}", uint64_word(data.len() as u64), hex_encode(&chunk))
        }

        let mut encoded = String::new();
        encoded.push_str(&address_word(sender));
        encoded.push_str(&address_word(recipient));
        encoded.push_str(&uint64_word(envelope_offset as u64));
        encoded.push_str(&uint64_word(1_700_100_000));
        encoded.push_str(&uint64_word(1_700_000_000));
        encoded.push_str(&bool_word(false));
        encoded.push_str(&uint64_word(plaintext_offset as u64));
        encoded.push_str(&dynamic_word(&envelope));
        encoded.push_str(&dynamic_word(plaintext));

        let read = |request: &HttpRequest| -> Result<HttpResponse, String> {
            assert_eq!(request.method, "POST");
            assert_eq!(request.url, "https://rpc.example.com");
            assert_eq!(request.timeout_ms, MESSAGE_READ_TIMEOUT_MS);
            assert_eq!(
                request.headers[0],
                ("content-type".to_string(), "application/json".to_string())
            );
            let body: Json = serde_json::from_slice(request.body.as_deref().unwrap()).unwrap();
            assert_eq!(body["jsonrpc"], "2.0");
            assert_eq!(body["method"], "eth_call");
            assert_eq!(body["params"][0]["to"], REVEAL_CONTRACT);
            let selector = hex_encode(&Keccak256::digest(b"getMessage(uint256)")[..4]);
            let data = body["params"][0]["data"].as_str().unwrap();
            assert!(data.starts_with(&format!("0x{selector}")));
            assert!(data.ends_with(&format!("{:0>64}", "9")));
            assert_eq!(body["params"][1], "latest");
            Ok(HttpResponse {
                status: 200,
                headers: Vec::new(),
                body: serde_json::to_vec(&json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": format!("0x{encoded}"),
                }))
                .unwrap(),
            })
        };
        let request = ReadMessageRequest {
            rpc_url: "https://rpc.example.com".to_string(),
            chain_id: reviewed_neox_chain_id("mainnet"),
            contract: REVEAL_CONTRACT.to_string(),
            message_id: "9".to_string(),
        };
        let message = read_message_from_chain(&request, &read).unwrap();
        assert_eq!(message.sender, sender);
        assert_eq!(message.recipient, recipient); // EIP-55 of hardhat account #1
        assert_eq!(message.envelope, envelope);
        assert_eq!(message.unlock_time, 1_700_100_000.0);
        assert_eq!(message.sent_at, 1_700_000_000.0);
        assert!(!message.revealed);
        assert_eq!(message.plaintext, "stored plaintext");
    }

    #[test]
    fn read_message_from_chain_maps_rpc_errors_like_the_worker() {
        let json_response = |status: u16, body: Json| -> Result<HttpResponse, String> {
            Ok(HttpResponse {
                status,
                headers: Vec::new(),
                body: serde_json::to_vec(&body).unwrap(),
            })
        };
        let transport = |request: &HttpRequest| -> Result<HttpResponse, String> {
            match request.url.as_str() {
                "https://revert.example" => json_response(
                    500,
                    json!({ "error": { "message": " execution reverted " } }),
                ),
                "https://rpc-error.example" => json_response(
                    200,
                    json!({"jsonrpc": "2.0", "id": 1, "error": {"code": -32000, "message": "out of gas"}}),
                ),
                "https://empty.example" => {
                    json_response(200, json!({"jsonrpc": "2.0", "id": 1, "result": "0x"}))
                }
                "https://garbage.example" => {
                    json_response(200, json!({"jsonrpc": "2.0", "id": 1, "result": "0x1234"}))
                }
                "https://broken.example" => Err("connection refused".to_string()),
                other => panic!("unexpected url {other}"),
            }
        };
        let base = ReadMessageRequest {
            rpc_url: String::new(),
            chain_id: reviewed_neox_chain_id("mainnet"),
            contract: REVEAL_CONTRACT.to_string(),
            message_id: "9".to_string(),
        };
        for (url, expected) in [
            ("https://revert.example", "execution reverted"),
            ("https://rpc-error.example", "out of gas"),
            ("https://empty.example", "eth_call returned no data"),
            (
                "https://garbage.example",
                "malformed getMessage return data",
            ),
            ("https://broken.example", "connection refused"),
        ] {
            let call = ReadMessageRequest {
                rpc_url: url.to_string(),
                ..base.clone()
            };
            assert_eq!(
                read_message_from_chain(&call, &transport).unwrap_err(),
                expected,
                "unexpected error for {url}"
            );
        }
    }

    #[test]
    fn direct_message_rpc_reads_reject_cleartext_urls() {
        let request = ReadMessageRequest {
            rpc_url: "http://rpc.example".to_string(),
            chain_id: reviewed_neox_chain_id("mainnet"),
            contract: REVEAL_CONTRACT.to_string(),
            message_id: "9".to_string(),
        };
        let error = read_message_from_chain(&request, &|_| {
            panic!("cleartext RPC must be rejected before transport")
        })
        .expect_err("cleartext RPC must be rejected before transport");
        assert_eq!(error, "RPC URL must use HTTPS");
    }

    #[test]
    fn handler_rejects_malformed_requests_before_any_chain_access() {
        let env = env_from(&[]);
        let bad: Vec<Json> = vec![
            json!({"chain": "neo_n3", "signature": "0x", "messageId": 1, "issuedAt": REVEAL_NOW}),
            json!({"chain": "neox", "signature": "0x", "messageId": 0, "issuedAt": REVEAL_NOW}),
            json!({"chain": "neox", "messageId": 1, "issuedAt": REVEAL_NOW}),
            json!({"chain": "neox", "signature": "sig", "issuedAt": REVEAL_NOW}),
            json!({"chain": "neox", "signature": "sig", "messageId": 1}),
        ];
        for payload in &bad {
            let (status, body) = reveal(payload, &env, &panic_read);
            assert_eq!(status, 400, "expected 400 for {payload}");
            assert!(!body["error"].as_str().unwrap().is_empty());
        }
        // stale timestamp -> 403
        let (stale_status, stale_body) = reveal(
            &json!({
                "chain": "neox",
                "signature": "sig",
                "messageId": 1,
                "issuedAt": REVEAL_NOW - 10_000.0,
            }),
            &env,
            &panic_read,
        );
        assert_eq!(stale_status, 403);
        assert_eq!(
            stale_body["error"],
            "reveal request expired; re-sign with a current timestamp"
        );
        // the chain alias is trim+lowercased before membership (' NEO-X ')
        let (alias_status, alias_body) = reveal(
            &json!({"chain": " NEO-X ", "signature": "sig", "messageId": 1}),
            &env,
            &panic_read,
        );
        assert_eq!(alias_status, 400);
        assert_eq!(alias_body["error"], "issuedAt (unix seconds) required");
    }

    #[test]
    fn handler_returns_503_when_the_worker_is_not_configured() {
        let env = env_from(&[]);
        let (status, body) = reveal(&signed_reveal_payload(1), &env, &panic_read);
        assert_eq!(status, 503);
        assert_eq!(
            body["error"],
            "recipient reveal is not configured on this worker"
        );
    }

    #[test]
    fn handler_refuses_time_locked_messages_even_for_the_signed_recipient() {
        let env = configured_env();
        let message = NeoXMessage {
            sender: ZERO_ADDRESS.to_string(),
            recipient: reveal_wallet_address(),
            envelope: b"never-decrypted".to_vec(),
            unlock_time: 1_700_100_000.0,
            sent_at: 0.0,
            revealed: false,
            plaintext: String::new(),
        };
        let read = move |request: &ReadMessageRequest| -> Result<NeoXMessage, String> {
            assert_eq!(request.rpc_url, "https://rpc.example.com");
            assert_eq!(request.contract, REVEAL_CONTRACT);
            assert_eq!(request.message_id, "9");
            Ok(message.clone())
        };
        let (status, body) = reveal(&signed_reveal_payload(9), &env, &read);
        assert_eq!(status, 403);
        assert_eq!(
            body["error"],
            "time-locked messages must use the contract-gated reveal lane"
        );
    }

    #[test]
    fn handler_maps_read_failures_to_sanitized_502s() {
        let env = configured_env();
        let sensitive = format!("Error: 0x{}", "ab".repeat(24));
        let read = move |_request: &ReadMessageRequest| -> Result<NeoXMessage, String> {
            Err(sensitive.clone())
        };
        let (status, body) = reveal(&signed_reveal_payload(9), &env, &read);
        assert_eq!(status, 502);
        assert_eq!(
            body["error"],
            "failed to read message on-chain: internal error"
        );

        let benign = |_request: &ReadMessageRequest| -> Result<NeoXMessage, String> {
            Err("rpc request failed with status 500".to_string())
        };
        let (status, body) = reveal(&signed_reveal_payload(9), &env, &benign);
        assert_eq!(status, 502);
        assert_eq!(
            body["error"],
            "failed to read message on-chain: rpc request failed with status 500"
        );
    }

    #[test]
    fn handler_refuses_messages_without_a_designated_recipient() {
        let env = configured_env();
        let message = NeoXMessage {
            sender: ZERO_ADDRESS.to_string(),
            recipient: ZERO_ADDRESS.to_string(),
            envelope: b"envelope".to_vec(),
            unlock_time: 0.0,
            sent_at: 0.0,
            revealed: false,
            plaintext: String::new(),
        };
        let read = move |_request: &ReadMessageRequest| -> Result<NeoXMessage, String> {
            Ok(message.clone())
        };
        let (status, body) = reveal(&signed_reveal_payload(9), &env, &read);
        assert_eq!(status, 400);
        assert_eq!(body["error"], "message has no designated recipient");
    }

    #[test]
    fn handler_signature_and_envelope_gates_run_after_the_chain_read() {
        let env = configured_env();
        let base = NeoXMessage {
            sender: ZERO_ADDRESS.to_string(),
            recipient: reveal_wallet_address(),
            envelope: b"not-really-sealed".to_vec(),
            unlock_time: 0.0,
            sent_at: 0.0,
            revealed: false,
            plaintext: String::new(),
        };

        // malformed signature -> 400
        let mut payload = signed_reveal_payload(9);
        payload["signature"] = json!("0xdead");
        let read = {
            let base = base.clone();
            move |_request: &ReadMessageRequest| -> Result<NeoXMessage, String> { Ok(base.clone()) }
        };
        let (status, body) = reveal(&payload, &env, &read);
        assert_eq!(status, 400);
        assert_eq!(body["error"], "malformed signature");

        // recovered signer does not match the on-chain recipient -> 403
        let mismatch = NeoXMessage {
            recipient: "0x2222222222222222222222222222222222222222".to_string(),
            ..base.clone()
        };
        let read = move |_request: &ReadMessageRequest| -> Result<NeoXMessage, String> {
            Ok(mismatch.clone())
        };
        let (status, body) = reveal(&signed_reveal_payload(9), &env, &read);
        assert_eq!(status, 403);
        assert_eq!(
            body["error"],
            "signature does not match the message recipient"
        );

        // undecodable (non-UTF-8) envelope -> 400.
        //
        // From here on each sub-case needs its OWN message id: these are the
        // cases that get past the recipient check, and a presentation is
        // single-use once proven (SVC-E-9), so reusing id 9 would make the
        // second one a replay rather than the envelope failure under test.
        let broken = NeoXMessage {
            envelope: vec![0xff, 0xfe, 0xfd],
            ..base.clone()
        };
        let read = move |_request: &ReadMessageRequest| -> Result<NeoXMessage, String> {
            Ok(broken.clone())
        };
        let (status, body) = reveal(&signed_reveal_payload(91), &env, &read);
        assert_eq!(status, 400);
        assert_eq!(body["error"], "stored envelope is not decodable");

        // unsupported envelope format surfaces through the sanitized decrypt error
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine as _;
        let unsupported = NeoXMessage {
            envelope: STANDARD.encode("not-an-envelope").into_bytes(),
            ..base
        };
        let read = move |_request: &ReadMessageRequest| -> Result<NeoXMessage, String> {
            Ok(unsupported.clone())
        };
        let (status, body) = reveal(&signed_reveal_payload(92), &env, &read);
        assert_eq!(status, 400);
        assert_eq!(
            body["error"],
            "unsupported confidential payload format; expected X25519-HKDF-SHA256-AES-256-GCM"
        );
    }

    #[test]
    fn handler_reveals_a_recipient_only_message_to_the_signed_recipient() {
        let recipient_public = crate::core::buffer_from_base64(GOLDEN_PUBLIC_KEY_RAW_B64);
        let sealed = seal_for_oracle(&recipient_public, "meet me at dawn");
        let message = NeoXMessage {
            sender: ZERO_ADDRESS.to_string(),
            recipient: reveal_wallet_address(),
            envelope: sealed.into_bytes(),
            unlock_time: 0.0,
            sent_at: 0.0,
            revealed: false,
            plaintext: String::new(),
        };
        let read = move |_request: &ReadMessageRequest| -> Result<NeoXMessage, String> {
            Ok(message.clone())
        };
        let (status, body) = reveal(&signed_reveal_payload(9), &reveal_key_env(), &read);
        assert_eq!(status, 200);
        assert_eq!(body["plaintext"], "meet me at dawn");
        assert_eq!(body["recipient"], reveal_wallet_address());
        assert_eq!(body["messageId"], "9");
        assert_eq!(body["unlockTime"], 0);
    }

    /// SVC-E-9 (CL-15/CL-19). The reveal statement's only replay control was
    /// the ±10-minute freshness window, on a route the edge gateway
    /// deliberately proxies for UNAUTHENTICATED public clients — so the
    /// signed body exists in cleartext inside the edge and anyone who
    /// observed one could replay it for ten minutes and get the plaintext.
    ///
    /// The statement and signature must now be single-use. Message id 4211 is
    /// unique to this test: the ledger is process-wide, exactly as it is in a
    /// running enclave, so a shared id would couple parallel test threads.
    #[test]
    fn a_reveal_presentation_is_single_use_within_the_freshness_window() {
        let recipient_public = crate::core::buffer_from_base64(GOLDEN_PUBLIC_KEY_RAW_B64);
        let sealed = seal_for_oracle(&recipient_public, "meet me at dawn");
        let message = NeoXMessage {
            sender: ZERO_ADDRESS.to_string(),
            recipient: reveal_wallet_address(),
            envelope: sealed.into_bytes(),
            unlock_time: 0.0,
            sent_at: 0.0,
            revealed: false,
            plaintext: String::new(),
        };
        let read = move |_request: &ReadMessageRequest| -> Result<NeoXMessage, String> {
            Ok(message.clone())
        };
        let payload = signed_reveal_payload(4211);

        // First presentation: the recipient gets their message.
        let (status, body) = reveal(&payload, &reveal_key_env(), &read);
        assert_eq!(status, 200);
        assert_eq!(body["plaintext"], "meet me at dawn");

        // Byte-identical replay inside the window: refused, and no plaintext.
        let (status, body) = reveal(&payload, &reveal_key_env(), &read);
        assert_eq!(status, 403);
        assert_eq!(
            body["error"],
            "reveal request already used; re-sign with a current timestamp"
        );
        assert!(body.get("plaintext").is_none());
    }

    /// The ledger's own contract: first claim wins, repeats lose, and an
    /// entry stops occupying the set once it is older than the window it
    /// could have been replayed in — which is what keeps it bounded without a
    /// sweeper task.
    #[test]
    fn the_presentation_ledger_is_single_use_and_self_expiring() {
        let key = reveal_presentation_key("statement-for-ledger-test", "0xSIG");
        assert!(claim_reveal_presentation(&key, 1_000.0));
        assert!(!claim_reveal_presentation(&key, 1_000.0));
        // Still held anywhere inside the window.
        assert!(!claim_reveal_presentation(
            &key,
            1_000.0 + REVEAL_FRESHNESS_WINDOW_SECONDS - 1.0
        ));
        // Past the window the entry is swept; a presentation that old cannot
        // pass `is_reveal_timestamp_fresh` anyway, so re-admitting it is safe.
        assert!(claim_reveal_presentation(
            &key,
            1_000.0 + REVEAL_FRESHNESS_WINDOW_SECONDS + 1.0
        ));

        // The key covers both halves: a different statement or a different
        // signature is a different presentation.
        assert_ne!(
            reveal_presentation_key("statement-a", "0xSIG"),
            reveal_presentation_key("statement-b", "0xSIG"),
        );
        assert_ne!(
            reveal_presentation_key("statement-a", "0xSIG1"),
            reveal_presentation_key("statement-a", "0xSIG2"),
        );
        // Signature casing and surrounding whitespace are not a way around it.
        assert_eq!(
            reveal_presentation_key("statement-a", "0xABCD"),
            reveal_presentation_key("statement-a", "  0xabcd  "),
        );
    }

    // -- gated decrypt lane --------------------------------------------------

    fn decrypt(
        payload: &Json,
        env: &dyn Fn(&str) -> Option<String>,
        read: &dyn Fn(&ReadMessageRequest) -> Result<NeoXMessage, String>,
    ) -> (u16, Json) {
        let deriver =
            |_key_path: &str, _context: &str| -> Result<Vec<u8>, String> { Ok(vec![7u8; 48]) };
        let warn = |_level: &str, _event: &str, _detail: &str| {};
        let mut state = 0u8;
        let mut rng = move |buffer: &mut [u8]| {
            for byte in buffer.iter_mut() {
                *byte = state;
                state = state.wrapping_add(1);
            }
        };
        // The lane no longer mints its own ephemeral key: it serves the one its
        // caller owns, so the deterministic generator rides in as the provider.
        let mut ephemeral = || generate_x25519_key_material(&mut rng);
        handle_oracle_decrypt(
            payload,
            env,
            REVEAL_NOW,
            &deriver,
            &no_keystore,
            "/repo",
            &warn,
            &mut ephemeral,
            read,
        )
    }

    #[test]
    fn extract_decrypt_ciphertext_prefers_and_trims_the_field_chain() {
        assert_eq!(
            extract_decrypt_ciphertext(&json!({ "envelope": "  E1  " })),
            "E1"
        );
        // priority: envelope > ciphertext > sealed > encrypted_payload
        assert_eq!(
            extract_decrypt_ciphertext(&json!({
                "envelope": "E", "ciphertext": "C", "sealed": "S", "encrypted_payload": "X",
            })),
            "E"
        );
        assert_eq!(
            extract_decrypt_ciphertext(&json!({ "ciphertext": "C", "sealed": "S" })),
            "C"
        );
        assert_eq!(extract_decrypt_ciphertext(&json!({ "sealed": "S" })), "S");
        assert_eq!(
            extract_decrypt_ciphertext(&json!({ "encrypted_payload": " X " })),
            "X"
        );
        // whitespace-only and non-string fields fall through
        assert_eq!(
            extract_decrypt_ciphertext(&json!({ "envelope": "   " })),
            ""
        );
        assert_eq!(
            extract_decrypt_ciphertext(&json!({ "envelope": 5, "sealed": "S" })),
            "S"
        );
        assert_eq!(extract_decrypt_ciphertext(&json!({})), "");
    }

    #[test]
    fn binding_fields_count_explicit_null_but_not_absence() {
        assert!(has_decrypt_binding_fields(&json!({ "messageId": null })));
        assert!(has_decrypt_binding_fields(&json!({ "message_id": "5" })));
        assert!(has_decrypt_binding_fields(&json!({ "id": 5 })));
        assert!(!has_decrypt_binding_fields(&json!({ "envelope": "E" })));
    }

    #[test]
    fn decrypt_binding_required_follows_the_s21_matrix() {
        // production ignores the opt-out entirely
        let production = env_from(&[
            ("NODE_ENV", "production"),
            ("MORPHEUS_ORACLE_DECRYPT_REQUIRE_BINDING", "0"),
        ]);
        assert!(decrypt_binding_required(&production));
        // dev: unset and truthy values require binding
        assert!(decrypt_binding_required(&env_from(&[])));
        assert!(decrypt_binding_required(&env_from(&[(
            "MORPHEUS_ORACLE_DECRYPT_REQUIRE_BINDING",
            "1"
        )])));
        assert!(decrypt_binding_required(&env_from(&[(
            "MORPHEUS_ORACLE_DECRYPT_REQUIRE_BINDING",
            "TRUE"
        )])));
        // dev: the four opt-out spellings
        for spelling in ["0", "false", "no", "off"] {
            assert!(!decrypt_binding_required(&env_from(&[(
                "MORPHEUS_ORACLE_DECRYPT_REQUIRE_BINDING",
                spelling
            )])));
        }
    }

    #[test]
    fn decrypt_handler_requires_a_sealed_envelope_field() {
        let (status, body) = decrypt(&json!({}), &configured_env(), &panic_read);
        assert_eq!(status, 400);
        assert_eq!(body["error"], "sealed envelope required (field: envelope)");
    }

    #[test]
    fn decrypt_handler_requires_binding_fields_unless_opted_out() {
        // default (dev): bare ciphertext is refused
        let (status, body) = decrypt(
            &json!({ "envelope": "whatever" }),
            &configured_env(),
            &panic_read,
        );
        assert_eq!(status, 400);
        assert_eq!(
            body["error"],
            "gated decrypt requires (chain, contract, messageId) binding fields"
        );

        // explicit opt-out: the gate opens and the flow reaches the decrypt,
        // which fails on envelope format with the usual 400.
        let opted_out = env_from(&[
            ("NEOX_MESSAGE_RPC", "https://rpc.example.com"),
            ("NEOX_MESSAGE_CONTRACT", REVEAL_CONTRACT),
            ("MORPHEUS_ALLOW_EPHEMERAL_KEY", "true"),
            ("MORPHEUS_ORACLE_DECRYPT_REQUIRE_BINDING", "off"),
        ]);
        let (status, body) = decrypt(&json!({ "envelope": "whatever" }), &opted_out, &panic_read);
        assert_eq!(status, 400);
        assert_eq!(
            body["error"],
            "unsupported confidential payload format; expected X25519-HKDF-SHA256-AES-256-GCM"
        );
    }

    #[test]
    fn decrypt_binding_gate_rejects_each_violation() {
        let base_env = reveal_key_env();

        // wrong chain
        let payload = json!({ "envelope": "E", "chain": "polygon", "messageId": 5 });
        let (status, body) = decrypt(&payload, &base_env, &panic_read);
        assert_eq!(status, 400);
        assert_eq!(
            body["error"],
            "gated decrypt currently supports the neox chain only"
        );

        // messageId unparseable
        let payload = json!({ "envelope": "E", "chain": "neox", "messageId": "1.5" });
        let (status, body) = decrypt(&payload, &base_env, &panic_read);
        assert_eq!(status, 400);
        assert_eq!(body["error"], "valid messageId required for gated decrypt");

        // worker chain context unconfigured
        let payload = json!({ "envelope": "E", "chain": "neox", "messageId": 5 });
        let (status, body) = decrypt(&payload, &env_from(&[]), &panic_read);
        assert_eq!(status, 503);
        assert_eq!(
            body["error"],
            "gated decrypt is not configured on this worker"
        );

        // caller contract != worker contract (the read must never be redirected)
        let payload = json!({
            "envelope": "E", "chain": "neox", "messageId": 5,
            "contract": "0x1111111111111111111111111111111111111111",
        });
        let (status, body) = decrypt(&payload, &base_env, &panic_read);
        assert_eq!(status, 403);
        assert_eq!(
            body["error"],
            "contract does not match the worker-configured message contract"
        );

        // on-chain read failure -> 502 with the sanitized error
        let read = move |_request: &ReadMessageRequest| -> Result<NeoXMessage, String> {
            Err("execution reverted".to_string())
        };
        let payload = json!({ "envelope": "E", "chain": "neox", "messageId": 5 });
        let (status, body) = decrypt(&payload, &base_env, &read);
        assert_eq!(status, 502);
        assert_eq!(
            body["error"],
            "failed to read message on-chain: execution reverted"
        );
    }

    #[test]
    fn decrypt_binding_gate_binds_the_envelope_and_the_time_lock() {
        let recipient_public = crate::core::buffer_from_base64(GOLDEN_PUBLIC_KEY_RAW_B64);
        let sealed = seal_for_oracle(&recipient_public, "release-the-funds");

        let make_read = |envelope: Vec<u8>, unlock_time: f64| {
            move |_request: &ReadMessageRequest| -> Result<NeoXMessage, String> {
                Ok(NeoXMessage {
                    sender: ZERO_ADDRESS.to_string(),
                    recipient: ZERO_ADDRESS.to_string(),
                    envelope: envelope.clone(),
                    unlock_time,
                    sent_at: 0.0,
                    revealed: false,
                    plaintext: String::new(),
                })
            }
        };

        // stored envelope differs from the supplied ciphertext
        let payload = json!({ "envelope": sealed.clone(), "chain": "neox", "messageId": 5 });
        let (status, body) = decrypt(
            &payload,
            &reveal_key_env(),
            &make_read(b"other".to_vec(), REVEAL_NOW - 10.0),
        );
        assert_eq!(status, 403);
        assert_eq!(
            body["error"],
            "envelope does not match the on-chain message for this messageId"
        );

        // envelope matches but the message is not time-locked
        let read = make_read(sealed.as_bytes().to_vec(), 0.0);
        let (status, body) = decrypt(&payload, &reveal_key_env(), &read);
        assert_eq!(status, 403);
        assert_eq!(
            body["error"],
            "message is not time-locked; use the recipient reveal lane"
        );

        // time-lock still in the future
        let read = make_read(sealed.as_bytes().to_vec(), REVEAL_NOW + 60.0);
        let (status, body) = decrypt(&payload, &reveal_key_env(), &read);
        assert_eq!(status, 403);
        assert_eq!(body["error"], "message time-lock has not expired yet");
    }

    #[test]
    fn decrypt_releases_a_time_locked_message_through_the_full_gate() {
        let recipient_public = crate::core::buffer_from_base64(GOLDEN_PUBLIC_KEY_RAW_B64);
        let sealed = seal_for_oracle(&recipient_public, "release-the-funds");
        let message = NeoXMessage {
            sender: ZERO_ADDRESS.to_string(),
            recipient: ZERO_ADDRESS.to_string(),
            envelope: sealed.clone().into_bytes(),
            unlock_time: REVEAL_NOW - 100.0,
            sent_at: 0.0,
            revealed: false,
            plaintext: String::new(),
        };
        let read = move |_request: &ReadMessageRequest| -> Result<NeoXMessage, String> {
            Ok(message.clone())
        };
        let payload = json!({
            "envelope": sealed.clone(),
            "chain": "neox",
            "messageId": 5,
        });
        let (status, body) = decrypt(&payload, &reveal_key_env(), &read);
        assert_eq!(status, 200);
        assert_eq!(body["plaintext"], "release-the-funds");

        // the alternative field spellings (network alias + message_id) too
        let payload = json!({
            "ciphertext": sealed,
            "network": "NEO_X",
            "message_id": "5",
        });
        let (status, body) = decrypt(&payload, &reveal_key_env(), &read);
        assert_eq!(status, 200);
        assert_eq!(body["plaintext"], "release-the-funds");
    }
}
