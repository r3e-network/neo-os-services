//! Build, fee, sign, and broadcast Neo N3 transactions — the Rust port of
//! neo-n3.js `buildSignAndBroadcastNeoN3Tx` + the custody signer adapter +
//! `confirmNeoN3FulfillExecution` + the fee top-up lane (`ensureNeoN3FeeBalance`,
//! `sendNeoN3GasTransfer`, `readNeoN3GasBalance`).
//!
//! Fee shaping (JS BigInt arithmetic, raw GAS fractions at 8 decimals): every
//! fee gets a flat 0.001 GAS pad, runtime-signed transactions add 20%
//! system-fee headroom over the simulated cost, and locally-built txs use a
//! 120-block validity window.

use serde_json::{json, Value};

use neo_os_core::n3_tx::{
    create_invoke_script, script_hash_from_address, script_hash_from_public_key, ContractParam,
    FeedSigner, FeedTx, N3EncodeError, Witness,
};

use crate::custody::CustodyClient;
use crate::rpc::{NeoRpcClient, GAS_CONTRACT_HASH};
use crate::HttpTransport;

pub const NEO_N3_TX_VALID_BLOCKS: u32 = 120;
/// 0.001 GAS pad on system and network fees.
pub const NEO_N3_FEE_PADDING: u128 = 100_000;
/// +20% simulated-cost headroom for runtime-signed paths.
pub const NEO_N3_SYSTEM_FEE_HEADROOM_DIVISOR: u128 = 5;
pub const DEFAULT_FULFILL_CONFIRM_TIMEOUT_MS: u64 = 45_000;
pub const DEFAULT_FEE_TOP_UP_MIN_BALANCE: u128 = 50_000_000; // 0.5 GAS
pub const DEFAULT_FEE_TOP_UP_AMOUNT: u128 = 100_000_000; // 1 GAS
pub const DEFAULT_FEE_TOP_UP_MAX_AMOUNT: u128 = 500_000_000; // 5 GAS

/// CSPRNG nonce source (SECURITY S20: never a PRNG seeded from the clock).
pub trait NonceSource: Send + Sync {
    fn nonce(&self) -> u32;
}

/// The production nonce source: the OS CSPRNG.
#[cfg(feature = "http")]
pub struct OsNonce;

#[cfg(feature = "http")]
impl NonceSource for OsNonce {
    fn nonce(&self) -> u32 {
        let mut bytes = [0u8; 4];
        getrandom::getrandom(&mut bytes).expect("OS RNG is always available");
        u32::from_le_bytes(bytes)
    }
}

/// A deterministic nonce source for tests.
pub struct FixedNonce(pub u32);

impl NonceSource for FixedNonce {
    fn nonce(&self) -> u32 {
        self.0
    }
}

/// A custody-resolved signing identity: the public half only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustodySigner {
    pub key_id: String,
    pub public_key: String,
    pub script_hash: String,
    pub address: String,
}

/// clock + sleep seam so confirmation polling is testable without real time.
pub trait Waiter: Send + Sync {
    fn now_ms(&self) -> u64;
    fn sleep(&self, ms: u64);
}

/// The production waiter: system clock + thread sleep.
pub struct SystemWaiter;

impl Waiter for SystemWaiter {
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0)
    }
    fn sleep(&self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}

/// The VM outcome of a confirmed execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VmOutcome {
    pub vm_state: String,
    pub exception: Option<String>,
}

/// Site-specific FAULT message builder for the test-invoke failure.
pub type TestInvokeFaultError<'a> = Box<dyn Fn(&str) -> String + 'a>;
/// Pre-broadcast fee check: receives system + network + padding and rejects
/// when the updater cannot afford it.
pub type EnsureFeeBalance<'a> = Box<dyn Fn(u128) -> Result<(), String> + 'a>;

/// Everything `buildSignAndBroadcastNeoN3Tx` takes beyond (client, script):
/// the signing identity and the site-specific error shaping.
pub struct BroadcastOptions<'a> {
    pub label: &'a str,
    pub system_fee_headroom: bool,
    /// Site-specific FAULT message for the default test-invoke failure
    /// (JS `buildTestInvokeFaultError`).
    pub build_test_invoke_fault_error: Option<TestInvokeFaultError<'a>>,
    /// Awaited with the total fee (system + network + padding) before the
    /// final signature (JS `ensureFeeBalance`).
    pub ensure_fee_balance: Option<EnsureFeeBalance<'a>>,
}

impl Default for BroadcastOptions<'_> {
    fn default() -> Self {
        Self {
            label: "Neo N3 transaction",
            system_fee_headroom: false,
            build_test_invoke_fault_error: None,
            ensure_fee_balance: None,
        }
    }
}

/// The broadcast receipt: the display hash (keys the confirmation poll), the
/// signed payload, and the witness the caller may need for audit trails.
#[derive(Debug, Clone)]
pub struct BroadcastReceipt {
    pub tx_hash: String,
    pub signed_base64: String,
    pub valid_until_block: u32,
}

/// `publicKeyFromSignedWitness`: the pinned verification script carries the
/// public key (no bare public_key on §5 /sign/transaction replies), recovered
/// exactly the way the custody service itself does for /sign/raw.
pub fn public_key_from_signed_witness(signed: &Value) -> Result<String, String> {
    let verification = signed
        .get("verification_script")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if verification.to_lowercase().starts_with("0c21") && verification.len() >= 70 {
        return normalize_public_key(&verification[4..70]);
    }
    normalize_public_key(
        signed
            .get("public_key")
            .and_then(Value::as_str)
            .unwrap_or(""),
    )
}

/// `normalizePublicKey`: 66-char (compressed) or 130-char (uncompressed)
/// lowercase hex, 0x-stripped. Anything else is a custody-side contradiction.
pub fn normalize_public_key(value: &str) -> Result<String, String> {
    let public_key = value.trim();
    let public_key = public_key
        .strip_prefix("0x")
        .or_else(|| public_key.strip_prefix("0X"))
        .unwrap_or(public_key)
        .to_lowercase();
    let is_compressed = public_key.len() == 66 && public_key.bytes().all(|b| b.is_ascii_hexdigit());
    let is_uncompressed =
        public_key.len() == 130 && public_key.bytes().all(|b| b.is_ascii_hexdigit());
    if !is_compressed && !is_uncompressed {
        return Err("runtime derived updater returned an invalid public key".to_string());
    }
    Ok(public_key)
}

/// `normalizeHash160`: 0x-prefixed or bare 40-char hex → lowercase 0x form;
/// a Neo address decodes to its wire (little-endian) script hash, which is the
/// form custody's script_hash field carries. Empty string when unparseable.
pub fn normalize_hash160(value: &str) -> String {
    let trimmed = value.trim();
    let raw = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed);
    if raw.len() == 40 && raw.bytes().all(|b| b.is_ascii_hexdigit()) {
        return format!("0x{raw}").to_lowercase();
    }
    match script_hash_from_address(trimmed) {
        Some(hash) => format!("0x{}", hex_lower(&hash)),
        None => String::new(),
    }
}

/// The custody signer adapter: the unsigned serialization goes to the enclave,
/// which policy-checks the calls inside and returns the complete witness
/// scripts. The recovered public key is re-checked against the identity
/// resolved at lookup time so a custody-side key swap cannot pass.
pub struct CustodySignerAdapter<'a, T: HttpTransport> {
    pub client: &'a CustodyClient<T>,
    pub signer: &'a CustodySigner,
}

impl<T: HttpTransport> CustodySignerAdapter<'_, T> {
    pub fn sign(&self, unsigned_hex: &str) -> Result<Witness, String> {
        let signed = self
            .client
            .sign_transaction(&self.signer.key_id, unsigned_hex)?;
        let public_key = public_key_from_signed_witness(&signed)?;
        if public_key.to_lowercase() != self.signer.public_key.to_lowercase() {
            return Err("custody signing key changed between lookup and signing".to_string());
        }
        Ok(Witness {
            invocation_script: hex_field(&signed, "invocation_script"),
            verification_script: hex_field(&signed, "verification_script"),
        })
    }

    /// Post-sign assertion: the witness's verification script must hash back
    /// to the identity script hash. `hash160` yields the big-endian form; the
    /// custody `script_hash` identity carries the little-endian display form
    /// (the neon-js convention), so compare in that form.
    pub fn verify_witness(&self, witness: &Witness) -> Result<(), String> {
        let mut hash = neo_os_core::n3_tx::hash160(&witness.verification_script);
        hash.reverse();
        let witness_hash = format!("0x{}", hex_lower(&hash));
        let expected = normalize_hash160(&self.signer.script_hash);
        if witness_hash != expected {
            return Err(format!(
                "custody signer witness mismatch: expected {expected}, got {witness_hash}"
            ));
        }
        Ok(())
    }
}

/// buildSignAndBroadcastNeoN3Tx. Resolves the broadcast receipt after
/// sendrawtransaction accepts it; confirmation polling stays with the callers.
///
/// Signature passes: (1) before calculatenetworkfee so the fee covers the
/// witness size, (2) after the network fee lands — both via the custody
/// service, which re-signs idempotently.
pub fn build_sign_and_broadcast<T: HttpTransport, N: NonceSource>(
    client: &NeoRpcClient<T>,
    custody: &CustodyClient<T>,
    signer: &CustodySigner,
    nonce_source: &N,
    script: &[u8],
    options: &BroadcastOptions<'_>,
) -> Result<BroadcastReceipt, String> {
    let signed = build_and_sign(client, custody, signer, nonce_source, script, options)?;
    let accepted = client
        .send_raw_transaction(&signed.signed_base64)
        .map_err(|error| error.to_string())?;
    if !accepted {
        return Err("Neo N3 sendrawtransaction rejected the signed transaction".into());
    }
    Ok(signed)
}

/// Prepare the exact bytes without broadcasting. Durable callers must persist
/// this receipt before asking any RPC node to accept the transaction.
pub fn build_and_sign<T: HttpTransport, N: NonceSource>(
    client: &NeoRpcClient<T>,
    custody: &CustodyClient<T>,
    signer: &CustodySigner,
    nonce_source: &N,
    script: &[u8],
    options: &BroadcastOptions<'_>,
) -> Result<BroadcastReceipt, String> {
    let signer_hash = normalize_hash160(&signer.script_hash);
    if signer_hash.is_empty() {
        return Err("invalid signer script hash".to_string());
    }
    let signer_bytes =
        decode_20(&signer_hash).ok_or_else(|| "invalid signer script hash".to_string())?;
    let valid_until_block = client
        .get_block_count()
        .map_err(|error| error.to_string())?
        + NEO_N3_TX_VALID_BLOCKS;
    let nonce = nonce_source.nonce();

    let build_tx = |system_fee: u64, network_fee: u64| FeedTx {
        nonce,
        valid_until_block,
        system_fee,
        network_fee,
        signer: FeedSigner {
            script_hash: signer_bytes,
        },
        script,
    };

    // Test invoke: FAULT detection and the simulated system-fee cost in one
    // round-trip (zero-fee tx — the fees land below).
    let zero_fee_tx = build_tx(0, 0);
    let test_invoke = client
        .call(
            "invokescript",
            json!([
                base64(zero_fee_tx.script),
                [{ "account": signer_hash, "scopes": "CalledByEntry" }]
            ]),
        )
        .map_err(|error| error.to_string())?;
    if test_invoke
        .get("state")
        .and_then(Value::as_str)
        .map(|state| state.eq_ignore_ascii_case("FAULT"))
        .unwrap_or(false)
    {
        let exception = test_invoke
            .get("exception")
            .and_then(Value::as_str)
            .unwrap_or("");
        return Err(match &options.build_test_invoke_fault_error {
            Some(build) => build(exception),
            None => format!(
                "{} test invoke faulted: {}",
                options.label,
                if exception.is_empty() {
                    "unknown error"
                } else {
                    exception
                }
            ),
        });
    }

    let gas_consumed = parse_u128(&test_invoke, "gasconsumed").unwrap_or(0);
    let system_fee = if options.system_fee_headroom {
        gas_consumed + gas_consumed / NEO_N3_SYSTEM_FEE_HEADROOM_DIVISOR + NEO_N3_FEE_PADDING
    } else {
        gas_consumed + NEO_N3_FEE_PADDING
    };

    let adapter = CustodySignerAdapter {
        client: custody,
        signer,
    };

    // Signature pass 1: witness present so calculatenetworkfee sees its size.
    let first_tx = build_tx(system_fee as u64, 0);
    let witness = adapter.sign(&hex_lower(&first_tx.serialize_unsigned()))?;
    adapter.verify_witness(&witness)?;

    let signed_for_fee = base64(
        first_tx
            .serialize_signed(std::slice::from_ref(&witness))
            .as_slice(),
    );
    let network_fee_raw = client
        .calculate_network_fee(&signed_for_fee)
        .map_err(|error| error.to_string())?;
    let network_fee = network_fee_raw + NEO_N3_FEE_PADDING;

    if let Some(ensure_fee_balance) = &options.ensure_fee_balance {
        ensure_fee_balance(system_fee + network_fee)?;
    }

    // Signature pass 2: the fee-complete transaction.
    let final_tx = build_tx(system_fee as u64, network_fee as u64);
    let witness = adapter.sign(&hex_lower(&final_tx.serialize_unsigned()))?;
    adapter.verify_witness(&witness)?;

    let signed_base64 = base64(
        final_tx
            .serialize_signed(std::slice::from_ref(&witness))
            .as_slice(),
    );
    let tx_hash = final_tx.hash_display();
    Ok(BroadcastReceipt {
        tx_hash,
        signed_base64,
        valid_until_block,
    })
}

/// assertNeoN3HaltExecution: a FAULT (or any non-HALT VM state) is an error —
/// a faulted fulfill must never be recorded as successful.
pub fn assert_halt_execution(
    request_id: &str,
    tx_hash: &str,
    execution: &Value,
    label: &str,
) -> Result<VmOutcome, String> {
    let vm_state = execution
        .get("vmstate")
        .and_then(Value::as_str)
        .map(|state| state.trim().to_uppercase())
        .filter(|state| !state.is_empty())
        .unwrap_or_else(|| "HALT".to_string());
    let exception = execution
        .get("exception")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if vm_state != "HALT" {
        let detail = if exception.is_empty() {
            format!("VM state {vm_state}")
        } else {
            exception.clone()
        };
        return Err(format!(
            "Neo N3 {label} faulted for request {request_id} ({tx_hash}): {detail}"
        ));
    }
    Ok(VmOutcome {
        vm_state,
        exception: if exception.is_empty() {
            None
        } else {
            Some(exception)
        },
    })
}

/// confirmNeoN3FulfillExecution: poll the application log until a concrete
/// vmstate is observed. HALT resolves; FAULT throws; a timeout throws a
/// TRANSIENT error (message contains "timed out", so the classifier routes it
/// to a re-broadcast) unless `throw_on_timeout` is false, which degrades to
/// `UNKNOWN`. Re-broadcast is idempotent — a landed-but-unindexed tx FAULTs
/// "already fulfilled" on retry and settles.
pub fn confirm_fulfill_execution<T: HttpTransport, W: Waiter>(
    client: &NeoRpcClient<T>,
    waiter: &W,
    request_id: &str,
    tx_hash: &str,
    label: &str,
    timeout_ms: u64,
    throw_on_timeout: bool,
) -> Result<VmOutcome, String> {
    let deadline = waiter.now_ms().saturating_add(timeout_ms);
    let mut last_error: Option<String> = None;
    loop {
        match client.get_application_log(tx_hash) {
            Ok(app_log) => {
                let execution = app_log
                    .pointer("/executions/0")
                    .cloned()
                    .unwrap_or(Value::Null);
                let vm_state = execution
                    .get("vmstate")
                    .and_then(Value::as_str)
                    .map(|state| state.trim().to_uppercase())
                    .unwrap_or_default();
                if !vm_state.is_empty() {
                    return assert_halt_execution(request_id, tx_hash, &execution, label);
                }
                // Log exists but has no execution result yet; keep polling.
            }
            Err(error) => {
                let error_text = error.to_string();
                if error_text.contains(&format!("Neo N3 {label} faulted")) {
                    return Err(error_text);
                }
                last_error = Some(error_text);
            }
        }
        if waiter.now_ms() >= deadline {
            let detail = last_error
                .clone()
                .unwrap_or_else(|| format!("{label} application log unavailable before timeout"));
            if throw_on_timeout {
                return Err(format!(
                    "Neo N3 {label} confirmation timed out for request {request_id} ({tx_hash}): {detail}"
                ));
            }
            return Ok(VmOutcome {
                vm_state: "UNKNOWN".to_string(),
                exception: Some(detail),
            });
        }
        waiter.sleep(1000);
    }
}

// ---- fee top-up lane ----

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FeeTopUpSettings {
    pub enabled: bool,
    pub min_balance: u128,
    pub top_up_amount: u128,
    pub max_top_up_amount: u128,
}

/// getNeoN3FeeTopUpSettings.
pub fn fee_top_up_settings(config: &Value) -> FeeTopUpSettings {
    let Some(raw) = config.pointer("/neo_n3/feeTopUp") else {
        return FeeTopUpSettings {
            enabled: false,
            min_balance: 0,
            top_up_amount: 0,
            max_top_up_amount: 0,
        };
    };
    if !raw.get("enabled").and_then(Value::as_bool).unwrap_or(false) {
        return FeeTopUpSettings {
            enabled: false,
            min_balance: 0,
            top_up_amount: 0,
            max_top_up_amount: 0,
        };
    }
    FeeTopUpSettings {
        enabled: true,
        min_balance: parse_non_negative_bigint(
            raw.get("minBalance"),
            DEFAULT_FEE_TOP_UP_MIN_BALANCE,
        ),
        top_up_amount: parse_non_negative_bigint(raw.get("topUpAmount"), DEFAULT_FEE_TOP_UP_AMOUNT),
        max_top_up_amount: parse_non_negative_bigint(
            raw.get("maxTopUpAmount"),
            DEFAULT_FEE_TOP_UP_MAX_AMOUNT,
        ),
    }
}

fn parse_non_negative_bigint(value: Option<&Value>, fallback: u128) -> u128 {
    let Some(text) = value.and_then(Value::as_str) else {
        return fallback;
    };
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return fallback;
    }
    text.parse::<u128>().unwrap_or(fallback)
}

/// readNeoN3GasBalance.
pub fn read_gas_balance<T: HttpTransport>(
    client: &NeoRpcClient<T>,
    script_hash: &str,
) -> Result<u128, String> {
    let normalized = normalize_hash160(script_hash);
    if normalized.is_empty() {
        return Err("Neo N3 GAS balance read failed: invalid account".to_string());
    }
    let result = client
        .invoke_function(
            GAS_CONTRACT_HASH,
            "balanceOf",
            json!([{ "type": "Hash160", "value": normalized }]),
        )
        .map_err(|error| error.to_string())?;
    if result
        .get("state")
        .and_then(Value::as_str)
        .map(|state| state.eq_ignore_ascii_case("FAULT"))
        .unwrap_or(false)
    {
        let exception = result
            .get("exception")
            .and_then(Value::as_str)
            .unwrap_or("");
        return Err(if exception.is_empty() {
            "Neo N3 GAS balance read faulted".to_string()
        } else {
            exception.to_string()
        });
    }
    let stack_value = result
        .pointer("/stack/0/value")
        .cloned()
        .unwrap_or(Value::Null);
    let text = match &stack_value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => return Err("Neo N3 GAS balance read returned no numeric value".to_string()),
    };
    text.parse::<u128>()
        .map_err(|_| "Neo N3 GAS balance read returned an invalid numeric value".to_string())
}

/// sendNeoN3GasTransfer: the GAS `transfer` script + the shared broadcast
/// pipeline, then wait for HALT.
pub fn send_gas_transfer<T: HttpTransport, N: NonceSource, W: Waiter>(
    client: &NeoRpcClient<T>,
    custody: &CustodyClient<T>,
    nonce_source: &N,
    waiter: &W,
    funder: &CustodySigner,
    to_script_hash: &str,
    amount: u128,
) -> Result<String, String> {
    let to = normalize_hash160(to_script_hash);
    if to.is_empty() {
        return Err("invalid recipient".to_string());
    }
    let from = normalize_hash160(&funder.script_hash);

    let gas_bytes = decode_20(&strip0x_lower(GAS_CONTRACT_HASH))
        .ok_or_else(|| "invalid GAS contract hash".to_string())?;
    let script = create_invoke_script(
        &gas_bytes,
        "transfer",
        &[
            ContractParam::Hash160(from),
            ContractParam::Hash160(to),
            // Fee arithmetic stays inside the fee domain (top-up max 5 GAS).
            ContractParam::Integer(amount as i64),
            ContractParam::Any,
        ],
    )
    .map_err(|error: N3EncodeError| error.to_string())?;
    let receipt = build_sign_and_broadcast(
        client,
        custody,
        funder,
        nonce_source,
        &script,
        &BroadcastOptions {
            label: "Neo N3 updater fee top-up",
            ..Default::default()
        },
    )?;
    confirm_fulfill_execution(
        client,
        waiter,
        &receipt.tx_hash,
        &receipt.tx_hash,
        "Neo N3 updater fee top-up",
        45_000,
        true,
    )?;
    Ok(receipt.tx_hash)
}

/// ensureNeoN3FeeBalance. Fail-soft at the call site by design: a
/// manually-funded deployment provisions no fee-funder key, and this returns
/// Err in that case — which, if propagated, would block EVERY fulfill.
/// `Ok(())` means satisfied or topped up; the JS skip/throw distinction is
/// irrelevant to the only caller (best-effort, errors swallowed).
#[allow(clippy::too_many_arguments)]
pub fn ensure_fee_balance<T: HttpTransport, N: NonceSource, W: Waiter>(
    client: &NeoRpcClient<T>,
    custody: &CustodyClient<T>,
    nonce_source: &N,
    waiter: &W,
    fee_top_up: &FeeTopUpSettings,
    custody_key_ids: &Value,
    target: &CustodySigner,
    required_fee: u128,
    resolve_signer_by_id: &dyn Fn(&str) -> Result<CustodySigner, String>,
) -> Result<(), String> {
    if !fee_top_up.enabled {
        return Err("disabled".to_string());
    }
    let target_hash = normalize_hash160(&target.script_hash);
    if target_hash.is_empty() {
        return Err("invalid-target".to_string());
    }
    let required_balance = required_fee + fee_top_up.min_balance;
    let current_balance = read_gas_balance(client, &target_hash)?;
    if current_balance >= required_balance {
        return Ok(());
    }
    let funder_key_id =
        custody_key_id(custody_key_ids, "fee_funder").map_err(|error| error.to_string())?;
    let funder = resolve_signer_by_id(&funder_key_id)?;
    let funder_hash = normalize_hash160(&funder.script_hash);
    if funder_hash == target_hash {
        return Err(
            "Neo N3 updater fee top-up funder cannot be the same account as the updater"
                .to_string(),
        );
    }
    let deficit = required_balance - current_balance;
    let amount = if deficit > fee_top_up.top_up_amount {
        deficit
    } else {
        fee_top_up.top_up_amount
    };
    if fee_top_up.max_top_up_amount > 0 && amount > fee_top_up.max_top_up_amount {
        return Err(format!(
            "Neo N3 updater fee top-up amount {amount} exceeds configured max {}",
            fee_top_up.max_top_up_amount
        ));
    }
    let funder_balance = read_gas_balance(client, &funder_hash)?;
    if funder_balance < amount + fee_top_up.min_balance {
        return Err("Neo N3 updater fee top-up funder has insufficient GAS reserve".to_string());
    }
    send_gas_transfer(
        client,
        custody,
        nonce_source,
        waiter,
        &funder,
        &target_hash,
        amount,
    )?;
    Ok(())
}

/// `resolveCustodyUpdater` / `resolveCustodyKeyById`: name a key id, receive
/// the public identity — never a secret — and normalize the public key. No
/// cache on purpose: a rotated key must never keep signing under a stale
/// identity.
pub fn resolve_signer<T: HttpTransport>(
    custody: &CustodyClient<T>,
    key_id: &str,
) -> Result<CustodySigner, String> {
    let key = custody.key_info(key_id)?;
    let public_key = normalize_public_key(&key.public_key)?;
    let script_hash = {
        let normalized = normalize_hash160(&key.script_hash);
        if !normalized.is_empty() {
            normalized
        } else {
            let hash = script_hash_from_public_key(&hex_to_bytes(&public_key))
                .ok_or_else(|| "invalid custody public key".to_string())?;
            format!("0x{}", hex_lower(&hash))
        }
    };
    Ok(CustodySigner {
        key_id: key_id.to_string(),
        public_key,
        script_hash,
        address: key.address,
    })
}

/// buildNeoN3RelayRequestId — the UUID comes from the injected source so the
/// function stays deterministic under test.
pub fn build_relay_request_id(scope: &str, request_id: &str, uuid: &str) -> String {
    let normalized_scope = if scope.trim().is_empty() {
        "invoke"
    } else {
        scope.trim()
    };
    format!("relayer:n3:{normalized_scope}:{request_id}:{uuid}")
}

// ---- small helpers ----

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_to_bytes(text: &str) -> Vec<u8> {
    let raw = text.strip_prefix("0x").unwrap_or(text);
    (0..raw.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&raw[i..i + 2], 16).unwrap_or(0))
        .collect()
}

fn decode_20(hex: &str) -> Option<[u8; 20]> {
    let bytes = hex_to_bytes(hex);
    if bytes.len() != 20 {
        return None;
    }
    let mut out = [0u8; 20];
    out.copy_from_slice(&bytes);
    Some(out)
}

fn strip0x_lower(value: &str) -> String {
    let trimmed = value.trim();
    let raw = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed);
    raw.to_lowercase()
}

fn base64(bytes: &[u8]) -> String {
    neo_os_core::base64::encode_standard(bytes)
}

fn parse_u128(value: &Value, field: &str) -> Option<u128> {
    match value.get(field) {
        Some(Value::String(text)) => text.parse::<u128>().ok(),
        Some(Value::Number(number)) => number.as_u64().map(|v| v as u128),
        _ => None,
    }
}

fn hex_field(value: &Value, field: &str) -> Vec<u8> {
    let text = value.get(field).and_then(Value::as_str).unwrap_or("");
    let raw = text.strip_prefix("0x").unwrap_or(text);
    (0..raw.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&raw[i..i + 2], 16).unwrap_or(0))
        .collect()
}

/// The custody key ids the JS reads off `config.neo_n3.custodyKeyIds`.
pub fn custody_key_id(custody_key_ids: &Value, role: &str) -> Result<String, String> {
    let key_id = custody_key_ids
        .get(role)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if key_id.is_empty() {
        return Err(format!(
            "custody key for role {role} is not provisioned (SIGNER_ROLE_{}_KEY_ID)",
            role.to_uppercase()
        ));
    }
    Ok(key_id.to_string())
}
