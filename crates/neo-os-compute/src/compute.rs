//! `workers/nitro-worker/src/compute/index.js` — the builtin compute catalog
//! and its pure execution core. The standalone script/wasm lanes live in
//! [`crate::standalone`]; `handleComputeExecute`'s envelope composition and
//! the confidential payload pre-resolution (`resolveConfidentialPayload`) land
//! with the Phase 6 wiring, so `execute_builtin_compute` takes the
//! already-resolved payload.
//!
//! Host I/O is injected: `cryptoRandomUnit` becomes the `random_unit` closure
//! and `verifyGroth16ProofWithCli` (temp dir + external snarkjs process)
//! becomes the `verify_groth16_cli` closure; everything else — validation
//! chain, BigInt/matrix/merkle math, RSA-SHA256 verification (via AWS-LC,
//! matching Node's `createVerify('RSA-SHA256')` PKCS#1 v1.5 semantics),
//! digest lanes and the zERC20 statement checks — runs in-enclave.

use aws_lc_rs::{
    rsa::PublicKey,
    signature::{ParsedPublicKey, RSA_PKCS1_1024_8192_SHA256_FOR_LEGACY_USE_ONLY},
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use num_bigint::BigInt;
use num_traits::{One, Signed, Zero};
use serde_json::{json, Map, Value as Json};
use sha2::{Digest, Sha256};
use sha3::Keccak256;
use std::cmp::Ordering;

use crate::core::{enforce_serialized_size_limit, read_env, resolve_max_bytes, EnvReader};
use crate::js::{
    hex_decode_stop_at_invalid, js_bigint_from_string, js_first_truthy, js_number,
    js_number_to_string, js_number_value, js_stringify, js_to_number, js_trim, js_trim_string,
    js_truthy,
};
use crate::stable_stringify::stable_stringify;

const DEFAULT_ZKP_VERIFY_MAX_INPUT_BYTES: u64 = 128 * 1024;
const DEFAULT_BUILTIN_MAX_INPUT_BYTES: u64 = 64 * 1024;
const MAX_BIGINT_INPUT_CHARS: usize = 1024;
const MAX_MATRIX_DIMENSION: usize = 128;
const MAX_MATRIX_MULTIPLY_OPS: u64 = 250_000;
const MAX_VECTOR_ELEMENTS: usize = 8192;
const MAX_POLYNOMIAL_COEFFICIENTS: usize = 2048;
const MAX_MERKLE_LEAVES: usize = 4096;

/// `String(value ?? '')` — only null/undefined collapse (a JSON `false` or `0`
/// stringifies to `"false"`/`"0"`, never the empty string).
fn js_string_value(value: Option<&Json>) -> String {
    match value {
        None | Some(Json::Null) => String::new(),
        Some(other) => js_stringify(other),
    }
}

/// `a ?? b` over optional JSON fields.
fn nullish_coalesce<'a>(primary: Option<&'a Json>, fallback: Option<&'a Json>) -> Option<&'a Json> {
    match primary {
        None | Some(Json::Null) => fallback,
        _ => primary,
    }
}

/// JS string `.length` — UTF-16 code units.
fn js_utf16_len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

/// `BigInt(number)` for an integral finite double. `NaN`/`±Infinity`/fractions
/// throw RangeError in JS; the caller turns `None` into that error.
fn bigint_from_integral_double(value: f64) -> Option<BigInt> {
    if !value.is_finite() || value.fract() != 0.0 {
        return None;
    }
    if value.abs() < 9_007_199_254_740_992.0 {
        Some(BigInt::from(value as i64))
    } else {
        // |value| < 1e21 on the validated domain, where String(value) is
        // positional decimal — parse those digits directly.
        BigInt::parse_bytes(js_number_to_string(value).as_bytes(), 10)
    }
}

fn assert_bounded_integer_string(
    raw: &str,
    field_name: &str,
    non_negative: bool,
    non_zero: bool,
) -> Result<BigInt, String> {
    if raw.is_empty() || js_utf16_len(raw) > MAX_BIGINT_INPUT_CHARS {
        return Err(format!("{field_name} exceeds the bigint input limit"));
    }
    let parsed =
        js_bigint_from_string(raw).ok_or_else(|| format!("{field_name} must be an integer"))?;
    if non_negative && parsed.is_negative() {
        return Err(format!("{field_name} must be non-negative"));
    }
    if non_zero && parsed.is_zero() {
        return Err(format!("{field_name} must be non-zero"));
    }
    Ok(parsed)
}

/// `assertBoundedInteger(value, fieldName, {nonNegative, nonZero})`
/// (compute/index.js:42).
fn assert_bounded_integer_value(
    value: Option<&Json>,
    field_name: &str,
    non_negative: bool,
    non_zero: bool,
) -> Result<BigInt, String> {
    let owned = js_string_value(value);
    let raw = js_trim(&owned);
    assert_bounded_integer_string(raw, field_name, non_negative, non_zero)
}

/// `assertFiniteNumericArray(values, fieldName, maxLength)`
/// (compute/index.js:58).
fn assert_finite_numeric_array(
    values: Option<&Json>,
    field_name: &str,
    max_elements: usize,
) -> Result<(), String> {
    let Some(Json::Array(items)) = values else {
        return Err(format!("{field_name} length exceeds limit"));
    };
    if items.is_empty() || items.len() > max_elements {
        return Err(format!("{field_name} length exceeds limit"));
    }
    for item in items {
        if !js_to_number(item).is_finite() {
            return Err(format!("{field_name} must contain finite numbers"));
        }
    }
    Ok(())
}

/// `Math.max(a, b)` — NaN-propagating, unlike Rust's `f64::max`.
fn js_max_f64(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        f64::NAN
    } else {
        left.max(right)
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex_encode(&Sha256::digest(bytes))
}

/// `enforceBuiltinComputeLimits(fn, input)` (compute/index.js:68) — the
/// serialized-size ceiling first, then per-function work bounds. Errors match
/// the JS throw order exactly.
fn enforce_builtin_compute_limits(
    fn_name: &str,
    input: &Json,
    env: EnvReader<'_>,
) -> Result<(), String> {
    enforce_serialized_size_limit(
        input,
        "builtin compute input",
        resolve_max_bytes(
            Some(&Json::String(read_env(
                env,
                &[
                    "COMPUTE_MAX_BUILTIN_INPUT_BYTES",
                    "MORPHEUS_MAX_BUILTIN_INPUT_BYTES",
                ],
            ))),
            DEFAULT_BUILTIN_MAX_INPUT_BYTES,
            1024,
        ),
    )?;
    match fn_name {
        "math.modexp" => {
            assert_bounded_integer_value(input.get("base"), "base", false, false)?;
            assert_bounded_integer_value(input.get("exponent"), "exponent", true, false)?;
            assert_bounded_integer_value(input.get("modulus"), "modulus", false, true)?;
        }
        "math.polynomial" => {
            assert_finite_numeric_array(
                input.get("coefficients"),
                "coefficients",
                MAX_POLYNOMIAL_COEFFICIENTS,
            )?;
            let x_number = js_to_number(input.get("x").unwrap_or(&Json::Null));
            assert_bounded_integer_string(
                js_number_to_string(x_number.floor()).as_str(),
                "x",
                false,
                false,
            )?;
            // `input.modulus !== undefined && !== null && !== ''` — a
            // whitespace-only string passes the guard and fails the trimmed
            // parse with the limit error, exactly like JS.
            match input.get("modulus") {
                None | Some(Json::Null) => {}
                Some(Json::String(text)) if text.is_empty() => {}
                Some(_) => {
                    assert_bounded_integer_value(input.get("modulus"), "modulus", false, true)?;
                }
            }
        }
        "matrix.multiply" => {
            let left = input.get("left");
            let right = input.get("right");
            let (Some(Json::Array(left_rows)), Some(Json::Array(right_rows))) = (left, right)
            else {
                return Err("matrix.multiply requires non-empty left/right matrices".to_string());
            };
            if left_rows.is_empty() || right_rows.is_empty() {
                return Err("matrix.multiply requires non-empty left/right matrices".to_string());
            }
            let rows = left_rows.len();
            let shared = left_rows[0].as_array().map(Vec::len).unwrap_or(0);
            let cols = right_rows[0].as_array().map(Vec::len).unwrap_or(0);
            if rows > MAX_MATRIX_DIMENSION
                || shared > MAX_MATRIX_DIMENSION
                || right_rows.len() > MAX_MATRIX_DIMENSION
                || cols > MAX_MATRIX_DIMENSION
                || (rows * shared * cols) as u64 > MAX_MATRIX_MULTIPLY_OPS
            {
                return Err("matrix.multiply work estimate exceeds limit".to_string());
            }
            for (name, matrix) in [("left", left_rows), ("right", right_rows)] {
                for row in matrix {
                    let Some(cells) = row.as_array() else {
                        return Err(format!("invalid {name} matrix"));
                    };
                    for cell in cells {
                        if !js_to_number(cell).is_finite() {
                            return Err(format!("{name} matrix must be finite"));
                        }
                    }
                }
            }
        }
        "vector.cosine_similarity" => {
            assert_finite_numeric_array(input.get("left"), "left vector", MAX_VECTOR_ELEMENTS)?;
            assert_finite_numeric_array(input.get("right"), "right vector", MAX_VECTOR_ELEMENTS)?;
        }
        "merkle.root"
            if !matches!(
                input.get("leaves"),
                Some(Json::Array(leaves)) if leaves.len() <= MAX_MERKLE_LEAVES
            ) =>
        {
            return Err("merkle leaves length exceeds limit".to_string());
        }
        "merkle.root" => {}
        "fhe.rotation_plan" => {
            if matches!(input.get("indices"), Some(Json::Array(indices)) if indices.len() > MAX_VECTOR_ELEMENTS)
            {
                return Err("rotation indices length exceeds limit".to_string());
            }
        }
        _ => {}
    }
    Ok(())
}

/// `bigintPowMod` (compute/index.js:131) — square-and-multiply with JS BigInt
/// remainder semantics (`%` keeps the dividend's sign, num-bigint agrees).
fn bigint_pow_mod(base: &BigInt, exponent: &BigInt, modulus: &BigInt) -> BigInt {
    let mut result = BigInt::one();
    let mut b = base % modulus;
    let mut e = exponent.clone();
    while e.sign() != num_bigint::Sign::NoSign {
        if e.bit(0) {
            result = &result * &b % modulus;
        }
        e >>= 1;
        b = &b * &b % modulus;
    }
    result
}

/// `multiplyMatrices` (compute/index.js:144) — rectangularity checks in the JS
/// order, then f64 accumulation in row-major `i/j/k` order.
fn multiply_matrices(left: Option<&Json>, right: Option<&Json>) -> Result<Json, String> {
    let (Some(Json::Array(left_rows)), Some(Json::Array(right_rows))) = (left, right) else {
        return Err("matrix.multiply requires non-empty left/right matrices".to_string());
    };
    if left_rows.is_empty() || right_rows.is_empty() {
        return Err("matrix.multiply requires non-empty left/right matrices".to_string());
    }
    let shared = left_rows[0].as_array().map(Vec::len).unwrap_or(0);
    let cols = right_rows[0].as_array().map(Vec::len).unwrap_or(0);
    if !left_rows.iter().all(|row| {
        row.as_array()
            .map(|cells| cells.len() == shared)
            .unwrap_or(false)
    }) {
        return Err("invalid left matrix".to_string());
    }
    if !right_rows.iter().all(|row| {
        row.as_array()
            .map(|cells| cells.len() == cols)
            .unwrap_or(false)
    }) {
        return Err("invalid right matrix".to_string());
    }
    if right_rows.len() != shared {
        return Err("matrix dimensions do not align".to_string());
    }
    let mut out = Vec::with_capacity(left_rows.len());
    for left_row in left_rows {
        let left_cells = left_row.as_array().unwrap_or(&Vec::new()).clone();
        let mut row_out = Vec::with_capacity(cols);
        for col in 0..cols {
            let mut sum = 0.0f64;
            for (k, left_cell) in left_cells.iter().enumerate() {
                sum += js_to_number(left_cell)
                    * js_to_number(&right_rows[k].as_array().unwrap_or(&Vec::new())[col]);
            }
            row_out.push(js_number_value(sum));
        }
        out.push(Json::Array(row_out));
    }
    Ok(Json::Array(out))
}

/// `cosineSimilarity` (compute/index.js:167).
fn cosine_similarity(left: Option<&Json>, right: Option<&Json>) -> Result<Json, String> {
    let (Some(Json::Array(left_items)), Some(Json::Array(right_items))) = (left, right) else {
        return Err("vector.cosine_similarity requires equal-length non-empty vectors".to_string());
    };
    if left_items.len() != right_items.len() || left_items.is_empty() {
        return Err("vector.cosine_similarity requires equal-length non-empty vectors".to_string());
    }
    let mut dot = 0.0f64;
    let mut left_norm = 0.0f64;
    let mut right_norm = 0.0f64;
    for (a_raw, b_raw) in left_items.iter().zip(right_items.iter()) {
        let a = js_to_number(a_raw);
        let b = js_to_number(b_raw);
        dot += a * b;
        left_norm += a * a;
        right_norm += b * b;
    }
    if left_norm == 0.0 || right_norm == 0.0 {
        return Err("cosine similarity undefined for zero vector".to_string());
    }
    Ok(js_number_value(
        dot / (left_norm.sqrt() * right_norm.sqrt()),
    ))
}

/// `asLeafHash` (compute/index.js:191) — the regex allows only a lowercase
/// `0x` prefix; the even-length parity is measured on the stripped body.
fn as_leaf_hash(value: &Json) -> Vec<u8> {
    let raw = js_trim_string(Some(value));
    let body = raw.strip_prefix("0x").unwrap_or(&raw);
    let hex_form = match raw.strip_prefix("0x") {
        Some(stripped) => {
            !stripped.is_empty() && stripped.bytes().all(|byte| byte.is_ascii_hexdigit())
        }
        None => !raw.is_empty() && raw.bytes().all(|byte| byte.is_ascii_hexdigit()),
    };
    if hex_form && body.len().is_multiple_of(2) {
        hex_decode_stop_at_invalid(body)
    } else {
        raw.into_bytes()
    }
}

/// JS `+` operand for maskString: strings concatenate, everything else is
/// numeric (`null` → 0, arrays join first). Defaults apply only to undefined.
#[derive(Debug, Clone)]
enum MaskOperand {
    Num(f64),
    Text(String),
}

fn mask_operand(value: Option<&Json>, undefined_default: f64) -> MaskOperand {
    match value {
        None => MaskOperand::Num(undefined_default),
        Some(Json::String(text)) => MaskOperand::Text(text.clone()),
        Some(Json::Array(items)) => MaskOperand::Text(js_stringify(&Json::Array(items.clone()))),
        Some(other) => MaskOperand::Num(js_to_number(other)),
    }
}

fn js_add_mask(left: &MaskOperand, right: &MaskOperand) -> MaskOperand {
    match (left, right) {
        (MaskOperand::Num(a), MaskOperand::Num(b)) => MaskOperand::Num(a + b),
        (MaskOperand::Num(a), MaskOperand::Text(b)) => {
            MaskOperand::Text(format!("{}{}", js_number_to_string(*a), b))
        }
        (MaskOperand::Text(a), MaskOperand::Num(b)) => {
            MaskOperand::Text(format!("{a}{}", js_number_to_string(*b)))
        }
        (MaskOperand::Text(a), MaskOperand::Text(b)) => MaskOperand::Text(format!("{a}{b}")),
    }
}

fn operand_number(operand: &MaskOperand) -> f64 {
    match operand {
        MaskOperand::Num(value) => *value,
        MaskOperand::Text(text) => js_number(text),
    }
}

/// `str.slice(0, end)` with JS index coercion (NaN → 0, negatives from the
/// end). Character-indexed; differs from JS UTF-16 indexing only for astral
/// characters.
fn js_slice_from_start(value: &str, end: &MaskOperand) -> String {
    let length = value.chars().count() as f64;
    let raw = operand_number(end);
    let end_index = if raw.is_nan() { 0.0 } else { raw.trunc() };
    let end_index = if end_index < 0.0 {
        (length + end_index).max(0.0)
    } else {
        end_index.min(length)
    };
    value.chars().take(end_index as usize).collect()
}

/// `str.slice(-right)` — `slice(-0)` is `slice(0)`, the whole string.
fn js_slice_from_end(value: &str, right: &MaskOperand) -> String {
    let length = value.chars().count() as f64;
    let raw = -operand_number(right);
    let start_index = if raw.is_nan() { 0.0 } else { raw.trunc() };
    let start_index = if start_index < 0.0 {
        (length + start_index).max(0.0)
    } else {
        start_index.min(length)
    };
    value.chars().skip(start_index as usize).collect()
}

/// `maskString(value, unmaskedLeft = 2, unmaskedRight = 2)`
/// (compute/index.js:199). Defaults bind only to undefined; `null` coerces to
/// 0 like JS arithmetic. A negative repeat count is unreachable (the guard
/// `length > left + right` bounds it) — clamped to zero like `String.repeat`
/// on NaN.
fn mask_string(
    value: Option<&Json>,
    unmasked_left: Option<&Json>,
    unmasked_right: Option<&Json>,
) -> String {
    let str_value = match value {
        Some(raw) if js_truthy(raw) => js_stringify(raw),
        _ => String::new(),
    };
    let left = mask_operand(unmasked_left, 2.0);
    let right = mask_operand(unmasked_right, 2.0);
    let length = str_value.chars().count() as f64;
    let combined = operand_number(&js_add_mask(&left, &right));
    if length <= combined {
        let stars = length.max(4.0);
        return "*".repeat(if stars.is_nan() { 0 } else { stars as usize });
    }
    let stars = (length - operand_number(&left) - operand_number(&right)).trunc();
    let stars = if stars.is_nan() || stars < 0.0 {
        0.0
    } else {
        stars
    };
    format!(
        "{}{}{}",
        js_slice_from_start(&str_value, &left),
        "*".repeat(stars as usize),
        js_slice_from_end(&str_value, &right),
    )
}

/// `laplaceNoiseFromUnit` (compute/index.js:215) — inverse-CDF Laplace noise;
/// `Math.sign(0)` is 0 and the clamping keeps `log(1 - 2|u|)` finite.
fn laplace_noise_from_unit(value: f64, scale: f64, raw_unit: f64) -> f64 {
    let clamped = if raw_unit <= 0.0 {
        f64::EPSILON
    } else if raw_unit >= 1.0 {
        1.0 - f64::EPSILON
    } else {
        raw_unit
    };
    let u = clamped - 0.5;
    let sign = if u > 0.0 {
        1.0
    } else if u < 0.0 {
        -1.0
    } else {
        0.0
    };
    let noise = -scale * sign * (1.0 - 2.0 * u.abs()).ln();
    value + noise
}

/// `merkleRoot` (compute/index.js:229) — an odd node duplicates itself
/// (`right = level[i + 1] || left`).
fn merkle_root(leaves: &Json) -> Result<String, String> {
    let Some(items) = leaves.as_array() else {
        return Err("merkle.root requires at least one leaf".to_string());
    };
    if items.is_empty() {
        return Err("merkle.root requires at least one leaf".to_string());
    }
    let mut level: Vec<Vec<u8>> = items
        .iter()
        .map(|leaf| Sha256::digest(as_leaf_hash(leaf)).to_vec())
        .collect();
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        for chunk in level.chunks(2) {
            let left = &chunk[0];
            let right = chunk.get(1).unwrap_or(left);
            let mut concat = Vec::with_capacity(left.len() + right.len());
            concat.extend_from_slice(left);
            concat.extend_from_slice(right);
            next.push(Sha256::digest(&concat).to_vec());
        }
        level = next;
    }
    Ok(hex_encode(&level[0]))
}

/// `evaluatePolynomial` (compute/index.js:245) — Horner evaluation over BigInt
/// with the `((r % m) + m) % m` non-negative correction.
fn evaluate_polynomial(
    coefficients: Option<&Json>,
    x_value: Option<&Json>,
    modulus: Option<&Json>,
) -> Result<String, String> {
    let Some(Json::Array(items)) = coefficients else {
        return Err("math.polynomial requires at least one coefficient".to_string());
    };
    if items.is_empty() {
        return Err("math.polynomial requires at least one coefficient".to_string());
    }
    let to_bigint = |raw: f64| -> Result<BigInt, String> {
        bigint_from_integral_double(raw).ok_or_else(|| {
            format!(
                "The number {} cannot be converted to a BigInt because it is not an integer",
                js_number_to_string(raw)
            )
        })
    };
    let x = to_bigint(js_to_number(x_value.unwrap_or(&Json::Null)).floor())?;
    let m = match modulus {
        Some(value) if js_truthy(value) => {
            // JS BigInt(modulus) trims internally, but the SyntaxError message
            // embeds the untrimmed String(modulus).
            let owned = js_stringify(value);
            js_bigint_from_string(&owned)
                .ok_or_else(|| format!("Cannot convert {owned} to a BigInt"))?
        }
        _ => BigInt::zero(),
    };
    let has_modulus = matches!(modulus, Some(value) if js_truthy(value));
    let mut result = BigInt::zero();
    for coefficient in items {
        let c = to_bigint(js_to_number(coefficient).floor())?;
        result = result * &x + c;
        if has_modulus {
            result = (&result % &m + &m) % &m;
        }
    }
    Ok(result.to_string())
}

/// `verifyRSASignature` (compute/index.js:263) — Node's
/// `createVerify('RSA-SHA256')` accepts SPKI (`PUBLIC KEY`) and PKCS#1
/// (`RSA PUBLIC KEY`) PEM keys, string payloads only; every failure mode
/// (parse, length, verify) collapses to `false`.
fn verify_rsa_signature(
    public_key: Option<&Json>,
    signature: Option<&Json>,
    payload: Option<&Json>,
) -> bool {
    let (Some(Json::String(pem)), Some(Json::String(signature_hex)), Some(Json::String(payload))) =
        (public_key, signature, payload)
    else {
        return false;
    };
    let der = pem
        .lines()
        .filter(|line| !line.starts_with("---"))
        .collect::<String>();
    let Ok(der) = BASE64.decode(der.as_bytes()) else {
        return false;
    };
    let signature_bytes = hex_decode_stop_at_invalid(signature_hex);
    let Ok(public_key) = PublicKey::from_der(&der) else {
        return false;
    };
    // Preserve the Node `createVerify('RSA-SHA256')` compatibility boundary, which
    // accepts the existing 1024-bit fixture, while still rejecting keys outside
    // the AWS-LC 1024-8192-bit range.
    ParsedPublicKey::new(
        &RSA_PKCS1_1024_8192_SHA256_FOR_LEGACY_USE_ONLY,
        public_key.as_ref(),
    )
    .is_ok_and(|key| key.verify_sig(payload.as_bytes(), &signature_bytes).is_ok())
}

fn normalize_hex_string(value: Option<&Json>, field_name: &str) -> Result<String, String> {
    let raw = js_trim_string(value);
    if raw.is_empty() {
        return Err(format!("{field_name} is required"));
    }
    let normalized = if raw.starts_with("0x") {
        raw.to_lowercase()
    } else {
        format!("0x{}", raw.to_lowercase())
    };
    let digits = &normalized[2..];
    if digits.is_empty()
        || !digits
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(format!("{field_name} must be a hex string"));
    }
    Ok(normalized)
}

fn normalize_scalar_string(value: Option<&Json>, field_name: &str) -> Result<String, String> {
    let raw = js_trim_string(value);
    if raw.is_empty() {
        return Err(format!("{field_name} is required"));
    }
    Ok(raw)
}

/// `normalizePublicSignals` (compute/index.js:290) — entries stringify like
/// `String(entry)` (`null` → `"null"`, objects → `"[object Object]"`).
fn normalize_public_signals(value: Option<&Json>) -> Result<Json, String> {
    match value {
        Some(Json::Array(items)) => Ok(Json::Array(
            items
                .iter()
                .map(|item| Json::String(js_stringify(item)))
                .collect(),
        )),
        None | Some(Json::Null) => Ok(Json::Array(Vec::new())),
        Some(_) => Err("public_signals must be an array".to_string()),
    }
}

fn resolve_zkp_verify_max_input_bytes(env: EnvReader<'_>) -> u64 {
    resolve_max_bytes(
        Some(&Json::String(read_env(
            env,
            &[
                "COMPUTE_MAX_ZKP_VERIFY_INPUT_BYTES",
                "MORPHEUS_MAX_ZKP_VERIFY_INPUT_BYTES",
            ],
        ))),
        DEFAULT_ZKP_VERIFY_MAX_INPUT_BYTES,
        4096,
    )
}

/// `resolveZkpVerificationRuntime` (compute/index.js:308) — anything but
/// `'cli'` (including the blank default) keeps external verification off.
fn resolve_zkp_verification_runtime(env: EnvReader<'_>) -> String {
    let raw = read_env(
        env,
        &["MORPHEUS_ZKP_VERIFY_RUNTIME", "COMPUTE_ZKP_VERIFY_RUNTIME"],
    );
    let normalized = js_trim(&raw).to_lowercase();
    if normalized.is_empty() {
        "disabled".to_string()
    } else {
        normalized
    }
}

/// `verifyGroth16Proof` (compute/index.js:358) — size ceiling, then the
/// runtime gate, then the host closure standing in for the snarkjs CLI.
fn verify_groth16_proof(
    env: EnvReader<'_>,
    verifying_key: Option<&Json>,
    public_signals: &Json,
    proof: Option<&Json>,
    verify_groth16_cli: &dyn Fn(&Json, &Json, &Json) -> Result<bool, String>,
) -> Result<bool, String> {
    let mut sized = Map::new();
    if let Some(key) = verifying_key {
        sized.insert("verifying_key".to_string(), key.clone());
    }
    sized.insert("public_signals".to_string(), public_signals.clone());
    if let Some(proof) = proof {
        sized.insert("proof".to_string(), proof.clone());
    }
    enforce_serialized_size_limit(
        &Json::Object(sized),
        "zkp verification input",
        resolve_zkp_verify_max_input_bytes(env),
    )?;
    if resolve_zkp_verification_runtime(env) != "cli" {
        return Err(
            "groth16 verification runtime disabled; set MORPHEUS_ZKP_VERIFY_RUNTIME=cli to enable explicit external verification"
                .to_string(),
        );
    }
    verify_groth16_cli(
        &verifying_key.cloned().unwrap_or(Json::Null),
        public_signals,
        &proof.cloned().unwrap_or(Json::Null),
    )
}

/// `normalizeZerc20SingleWithdrawStatement` (compute/index.js:373) — a truthy
/// object-or-array `public_inputs` replaces the whole source (array sources
/// have no fields, so every required check fires).
fn normalize_zerc20_single_withdraw_statement(input: &Json) -> Result<Json, String> {
    let source = match input.get("public_inputs") {
        Some(value @ (Json::Object(_) | Json::Array(_))) => value,
        _ => input,
    };
    Ok(json!({
        "recipient": normalize_hex_string(source.get("recipient"), "recipient")?,
        "withdraw_value": normalize_scalar_string(
            nullish_coalesce(source.get("withdraw_value"), source.get("withdrawValue")),
            "withdraw_value",
        )?,
        "tree_root": normalize_hex_string(
            nullish_coalesce(source.get("tree_root"), source.get("treeRoot")),
            "tree_root",
        )?,
        "path_indices": normalize_hex_string(
            nullish_coalesce(source.get("path_indices"), source.get("pathIndices")),
            "path_indices",
        )?,
        "blacklisted_root": normalize_hex_string(
            nullish_coalesce(source.get("blacklisted_root"), source.get("blacklistedRoot")),
            "blacklisted_root",
        )?,
    }))
}

/// `compareExpected` (compute/index.js:391) — labels containing `value`
/// compare scalars, everything else hex; an unchecked expectation carries no
/// `expected` key.
fn compare_expected(label: &str, actual: &str, expected: Option<&Json>) -> Result<Json, String> {
    if matches!(expected, None | Some(Json::Null)) || js_trim_string(expected).is_empty() {
        return Ok(json!({ "checked": false, "ok": true, "actual": actual }));
    }
    let normalized_expected = if label.contains("value") {
        normalize_scalar_string(expected, label)?
    } else {
        normalize_hex_string(expected, label)?
    };
    Ok(json!({
        "checked": true,
        "ok": actual == normalized_expected,
        "actual": actual,
        "expected": normalized_expected,
    }))
}

/// `verifyZerc20SingleWithdraw` (compute/index.js:406).
fn verify_zerc20_single_withdraw(
    env: EnvReader<'_>,
    input: &Json,
    verify_groth16_cli: &dyn Fn(&Json, &Json, &Json) -> Result<bool, String>,
) -> Result<Json, String> {
    let statement = normalize_zerc20_single_withdraw_statement(input)?;
    let statement_field = |key: &str| {
        statement
            .get(key)
            .and_then(Json::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let statement_array = json!([
        statement["recipient"],
        statement["withdraw_value"],
        statement["tree_root"],
        statement["path_indices"],
        statement["blacklisted_root"],
    ]);
    let public_signals = normalize_public_signals(nullish_coalesce(
        nullish_coalesce(input.get("public_signals"), input.get("publicSignals")),
        Some(&statement_array),
    ))?;

    let expected_pair = |snake: &str, camel: &str| {
        nullish_coalesce(input.get(snake), input.get(camel))
            .cloned()
            .unwrap_or(Json::Null)
    };
    let checks = json!({
        "recipient": compare_expected(
            "expected_recipient",
            &statement_field("recipient"),
            Some(&expected_pair("expected_recipient", "expectedRecipient")),
        )?,
        "withdraw_value": compare_expected(
            "expected_withdraw_value",
            &statement_field("withdraw_value"),
            Some(&expected_pair("expected_withdraw_value", "expectedWithdrawValue")),
        )?,
        "tree_root": compare_expected(
            "expected_tree_root",
            &statement_field("tree_root"),
            Some(&expected_pair("expected_tree_root", "expectedTreeRoot")),
        )?,
        "path_indices": compare_expected(
            "expected_path_indices",
            &statement_field("path_indices"),
            Some(&expected_pair("expected_path_indices", "expectedPathIndices")),
        )?,
        "blacklisted_root": compare_expected(
            "expected_blacklisted_root",
            &statement_field("blacklisted_root"),
            Some(&expected_pair("expected_blacklisted_root", "expectedBlacklistedRoot")),
        )?,
    });

    let proof_verified = if js_truthy(input.get("verifying_key").unwrap_or(&Json::Null))
        || js_truthy(input.get("verifyingKey").unwrap_or(&Json::Null))
    {
        let verifying_key = nullish_coalesce(input.get("verifying_key"), input.get("verifyingKey"))
            .cloned()
            .unwrap_or(Json::Null);
        // `typeof [] === 'object'` in JS — arrays pass the proof gate too.
        match input.get("proof") {
            Some(proof) if matches!(proof, Json::Object(_) | Json::Array(_)) => {
                enforce_serialized_size_limit(
                    &json!({
                        "verifying_key": verifying_key,
                        "public_signals": public_signals,
                        "proof": proof,
                    }),
                    "zkp verification input",
                    resolve_zkp_verify_max_input_bytes(env),
                )?;
                Some(verify_groth16_proof(
                    env,
                    Some(&verifying_key),
                    &public_signals,
                    Some(proof),
                    verify_groth16_cli,
                )?)
            }
            _ => return Err("proof object is required when verifying_key is supplied".to_string()),
        }
    } else {
        return Err("verifying_key is required for zERC20 proof verification".to_string());
    };

    let statements_match = checks
        .as_object()
        .map(|map| {
            map.values()
                .all(|entry| entry.get("ok").and_then(Json::as_bool).unwrap_or(false))
        })
        .unwrap_or(false);
    let is_valid = statements_match && proof_verified == Some(true);
    Ok(json!({
        "statement": statement,
        "public_signals": public_signals,
        "statement_hash": sha256_hex(stable_stringify(&statement).as_bytes()),
        "checks": checks,
        "proof_verified": proof_verified.unwrap_or(false),
        "is_valid": is_valid,
    }))
}

/// `BUILTIN_COMPUTE_CATALOG` (compute/index.js:479).
pub fn builtin_compute_catalog() -> Json {
    json!([
        { "name": "hash.sha256", "category": "hash", "description": "Hashes any JSON-serializable payload with SHA-256." },
        { "name": "hash.keccak256", "category": "hash", "description": "Hashes any JSON-serializable payload with Keccak-256." },
        { "name": "crypto.rsa_verify", "category": "crypto", "description": "Verifies an RSA-SHA256 signature (expensive on-chain)." },
        { "name": "math.modexp", "category": "math", "description": "Performs big integer modular exponentiation." },
        { "name": "math.polynomial", "category": "math", "description": "Evaluates a polynomial of arbitrary degree." },
        { "name": "matrix.multiply", "category": "linear_algebra", "description": "Multiplies two dense matrices." },
        { "name": "vector.cosine_similarity", "category": "linear_algebra", "description": "Computes cosine similarity between two vectors." },
        { "name": "merkle.root", "category": "merkle", "description": "Builds a SHA-256 Merkle root from a list of leaves." },
        { "name": "zkp.public_signal_hash", "category": "zkp", "description": "Computes a deterministic digest over public signals." },
        { "name": "zkp.proof_digest", "category": "zkp", "description": "Computes a deterministic digest over a proof object." },
        { "name": "zkp.witness_digest", "category": "zkp", "description": "Computes a digest over witness material before proving." },
        { "name": "zkp.groth16.verify", "category": "zkp", "description": "Verifies a Groth16 proof against a verifying key and public signals." },
        { "name": "zkp.groth16.prove.plan", "category": "zkp", "description": "Returns a planning estimate for Groth16 proving workloads." },
        { "name": "zkp.plonk.prove.plan", "category": "zkp", "description": "Returns a planning estimate for PLONK proving workloads." },
        { "name": "zkp.zerc20.single_withdraw.verify", "category": "zkp", "description": "Verifies zERC20 single-withdraw public inputs and optionally checks a Groth16 proof." },
        { "name": "fhe.batch_plan", "category": "fhe", "description": "Builds a ciphertext batching plan." },
        { "name": "fhe.noise_budget_estimate", "category": "fhe", "description": "Estimates a rough FHE noise budget." },
        { "name": "fhe.rotation_plan", "category": "fhe", "description": "Returns a rotation/key-switch planning summary." },
        { "name": "privacy.mask", "category": "privacy", "description": "Masks a sensitive string, leaving edges visible." },
        { "name": "privacy.add_noise", "category": "privacy", "description": "Adds illustrative Laplace noise. Demonstration only — not a calibrated differential-privacy mechanism (no privacy budget / sensitivity accounting)." },
    ])
}

/// `executeBuiltinCompute(payload)` (compute/index.js:584) — the resolved
/// payload in, the `{ function, result }` body out; JS throws surface as
/// `Err(String)` and reach the caller as `jsonError(400, ...)` at wiring.
pub fn execute_builtin_compute(
    env: EnvReader<'_>,
    payload: &Json,
    random_unit: &dyn Fn() -> f64,
    verify_groth16_cli: &dyn Fn(&Json, &Json, &Json) -> Result<bool, String>,
) -> Result<Json, String> {
    let fn_name = js_trim_string(js_first_truthy(payload, &["function", "compute_fn"]));
    let empty_input = Json::Object(Map::new());
    let input = match nullish_coalesce(payload.get("input"), payload.get("compute_args")) {
        Some(value) => value,
        None => &empty_input,
    };
    enforce_builtin_compute_limits(&fn_name, input, env)?;
    let result = match fn_name.as_str() {
        "hash.sha256" => json!({ "digest": sha256_hex(stable_stringify(input).as_bytes()) }),
        "hash.keccak256" => json!({
            "digest": format!("0x{}", hex_encode(&Keccak256::digest(stable_stringify(input).as_bytes()))),
        }),
        "crypto.rsa_verify" => json!({
            "is_valid": verify_rsa_signature(input.get("public_key"), input.get("signature"), input.get("payload")),
        }),
        "math.modexp" => {
            let parse = |key: &str| {
                let owned = js_string_value(input.get(key));
                let raw = js_trim(&owned);
                js_bigint_from_string(raw).ok_or_else(|| format!("{key} must be an integer"))
            };
            let base = parse("base")?;
            let exponent = parse("exponent")?;
            let modulus = parse("modulus")?;
            json!({ "value": bigint_pow_mod(&base, &exponent, &modulus).to_string() })
        }
        "math.polynomial" => json!({
            "value": evaluate_polynomial(input.get("coefficients"), input.get("x"), input.get("modulus"))?,
        }),
        "matrix.multiply" => {
            json!({ "matrix": multiply_matrices(input.get("left"), input.get("right"))? })
        }
        "vector.cosine_similarity" => json!({
            "similarity": cosine_similarity(input.get("left"), input.get("right"))?,
        }),
        "merkle.root" => {
            let leaves = js_first_truthy(input, &["leaves"])
                .cloned()
                .unwrap_or_else(|| Json::Array(Vec::new()));
            json!({ "root": merkle_root(&leaves)? })
        }
        "zkp.public_signal_hash" => {
            let digest_input = json!({
                "circuit_id": js_first_truthy(input, &["circuit_id"]).cloned().unwrap_or(Json::Null),
                "signals": js_first_truthy(input, &["signals"])
                    .cloned()
                    .unwrap_or_else(|| Json::Array(Vec::new())),
            });
            json!({ "digest": sha256_hex(stable_stringify(&digest_input).as_bytes()) })
        }
        "zkp.proof_digest" => {
            let digest_input = json!({
                "proof": js_first_truthy(input, &["proof"]).cloned().unwrap_or_else(|| input.clone()),
                "verifying_key": js_first_truthy(input, &["verifying_key"]).cloned().unwrap_or(Json::Null),
            });
            json!({ "digest": sha256_hex(stable_stringify(&digest_input).as_bytes()) })
        }
        "zkp.witness_digest" => {
            let digest_input = json!({
                "witness": js_first_truthy(input, &["witness"]).cloned().unwrap_or_else(|| input.clone()),
                "circuit_id": js_first_truthy(input, &["circuit_id"]).cloned().unwrap_or(Json::Null),
            });
            json!({ "digest": sha256_hex(stable_stringify(&digest_input).as_bytes()) })
        }
        "zkp.groth16.verify" => {
            let verifying_key =
                nullish_coalesce(input.get("verifying_key"), input.get("verifyingKey"));
            let public_signals = normalize_public_signals(nullish_coalesce(
                input.get("public_signals"),
                input.get("publicSignals"),
            ))?;
            let is_valid = verify_groth16_proof(
                env,
                verifying_key,
                &public_signals,
                input.get("proof"),
                verify_groth16_cli,
            )?;
            json!({ "is_valid": is_valid })
        }
        "zkp.groth16.prove.plan" => {
            let constraints = js_first_truthy(input, &["constraints"])
                .map(js_to_number)
                .unwrap_or(0.0);
            let witness_count = js_first_truthy(input, &["witness_count", "witnessCount"])
                .map(js_to_number)
                .unwrap_or(0.0);
            json!({
                "constraints": js_number_value(constraints),
                "witness_count": js_number_value(witness_count),
                "estimated_segments": js_number_value(js_max_f64(
                    (constraints / 50_000.0).ceil(),
                    1.0,
                )),
                "estimated_memory_mb": js_number_value(js_max_f64(
                    ((constraints + witness_count) / 25_000.0).ceil(),
                    1.0,
                )),
            })
        }
        "zkp.plonk.prove.plan" => {
            let gates = js_first_truthy(input, &["gates"])
                .map(js_to_number)
                .unwrap_or(0.0);
            json!({
                "gates": js_number_value(gates),
                "estimated_polynomials": js_number_value(js_max_f64((gates / 65_536.0).ceil(), 1.0)),
                "estimated_memory_mb": js_number_value(js_max_f64((gates / 30_000.0).ceil(), 1.0)),
            })
        }
        "zkp.zerc20.single_withdraw.verify" => {
            verify_zerc20_single_withdraw(env, input, verify_groth16_cli)?
        }
        "fhe.batch_plan" => {
            let slot_count = js_first_truthy(input, &["slot_count", "slotCount"])
                .map(js_to_number)
                .unwrap_or(0.0);
            let ciphertext_count = js_first_truthy(input, &["ciphertext_count", "ciphertextCount"])
                .map(js_to_number)
                .unwrap_or(0.0);
            let slots_per_ciphertext = if slot_count > 0.0 && ciphertext_count > 0.0 {
                (slot_count / ciphertext_count).ceil()
            } else {
                slot_count
            };
            json!({
                "slot_count": js_number_value(slot_count),
                "ciphertext_count": js_number_value(ciphertext_count),
                "slots_per_ciphertext": js_number_value(slots_per_ciphertext),
            })
        }
        "fhe.noise_budget_estimate" => {
            let multiplicative_depth =
                js_first_truthy(input, &["multiplicative_depth", "multiplicativeDepth"])
                    .map(js_to_number)
                    .unwrap_or(1.0);
            let scale_bits = js_first_truthy(input, &["scale_bits", "scaleBits"])
                .map(js_to_number)
                .unwrap_or(40.0);
            let modulus_bits = js_first_truthy(input, &["modulus_bits", "modulusBits"])
                .map(js_to_number)
                .unwrap_or(218.0);
            let estimated = js_max_f64(modulus_bits - multiplicative_depth * scale_bits, 0.0);
            json!({
                "multiplicative_depth": js_number_value(multiplicative_depth),
                "scale_bits": js_number_value(scale_bits),
                "modulus_bits": js_number_value(modulus_bits),
                "estimated_noise_budget": js_number_value(estimated),
            })
        }
        "fhe.rotation_plan" => {
            let indices: Vec<f64> = match input.get("indices") {
                Some(Json::Array(items)) => items.iter().map(js_to_number).collect(),
                _ => Vec::new(),
            };
            let mut unique: Vec<f64> = Vec::new();
            for value in &indices {
                // Set semantics: SameValueZero — NaN dedupes to one entry,
                // -0 and 0 collapse.
                if !unique
                    .iter()
                    .any(|seen| seen == value || (seen.is_nan() && value.is_nan()))
                {
                    unique.push(*value);
                }
            }
            // `sort((a, b) => a - b)` — V8's sort is stable and an
            // NaN-poisoned comparator behaves as "equal", so keep order.
            unique.sort_by(|a, b| {
                if a.is_nan() || b.is_nan() {
                    Ordering::Equal
                } else {
                    a.partial_cmp(b).unwrap_or(Ordering::Equal)
                }
            });
            json!({
                "indices": indices.iter().map(|value| js_number_value(*value)).collect::<Vec<_>>(),
                "unique_rotations": unique.iter().map(|value| js_number_value(*value)).collect::<Vec<_>>(),
                "key_switch_steps": indices.len(),
            })
        }
        "privacy.mask" => json!({
            "masked": mask_string(input.get("value"), input.get("unmasked_left"), input.get("unmasked_right")),
        }),
        "privacy.add_noise" => {
            let value = js_to_number(input.get("value").unwrap_or(&Json::Null));
            let scale = match input.get("scale") {
                Some(raw) => js_to_number(raw),
                None => 1.0,
            };
            json!({ "noisy_value": js_number_value(laplace_noise_from_unit(value, scale, random_unit())) })
        }
        _ => return Err(format!("unknown builtin compute function: {fn_name}")),
    };
    Ok(json!({ "function": fn_name, "result": result }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;

    fn env_from(entries: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = entries
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        move |name| map.get(name).cloned()
    }

    fn no_env(_name: &str) -> Option<String> {
        None
    }

    /// Deterministic [0, 1) uniform draws (xorshift64) standing in for
    /// `cryptoRandomUnit`.
    fn xorshift_unit_sequence(seed: u64) -> impl Fn() -> f64 {
        let state = Cell::new(seed);
        move || {
            let mut s = state.get();
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            state.set(s);
            (s >> 11) as f64 / (1u64 << 53) as f64
        }
    }

    fn cli_true(_key: &Json, _signals: &Json, _proof: &Json) -> Result<bool, String> {
        Ok(true)
    }

    fn cli_false(_key: &Json, _signals: &Json, _proof: &Json) -> Result<bool, String> {
        Ok(false)
    }

    fn cli_boom(_key: &Json, _signals: &Json, _proof: &Json) -> Result<bool, String> {
        Err("boom".to_string())
    }

    fn run(payload: &Json) -> Result<Json, String> {
        execute_builtin_compute(
            &no_env,
            payload,
            &xorshift_unit_sequence(0x2545_F491_4F6C_DD1D),
            &cli_true,
        )
    }

    fn run_with_cli(
        env: EnvReader<'_>,
        payload: &Json,
        cli: &dyn Fn(&Json, &Json, &Json) -> Result<bool, String>,
    ) -> Result<Json, String> {
        execute_builtin_compute(
            env,
            payload,
            &xorshift_unit_sequence(0x2545_F491_4F6C_DD1D),
            cli,
        )
    }

    #[test]
    fn catalog_lists_every_builtin_in_order() {
        let names: Vec<String> = builtin_compute_catalog()
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["name"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(
            names,
            vec![
                "hash.sha256",
                "hash.keccak256",
                "crypto.rsa_verify",
                "math.modexp",
                "math.polynomial",
                "matrix.multiply",
                "vector.cosine_similarity",
                "merkle.root",
                "zkp.public_signal_hash",
                "zkp.proof_digest",
                "zkp.witness_digest",
                "zkp.groth16.verify",
                "zkp.groth16.prove.plan",
                "zkp.plonk.prove.plan",
                "zkp.zerc20.single_withdraw.verify",
                "fhe.batch_plan",
                "fhe.noise_budget_estimate",
                "fhe.rotation_plan",
                "privacy.mask",
                "privacy.add_noise",
            ]
        );
    }

    #[test]
    fn catalog_privacy_add_noise_is_labelled_illustrative() {
        let catalog = builtin_compute_catalog();
        let entry = catalog
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == "privacy.add_noise")
            .expect("privacy.add_noise must be present in the catalog");
        let description = entry["description"]
            .as_str()
            .unwrap_or_default()
            .to_lowercase();
        assert!(
            description.contains("illustrative")
                || description.contains("not a calibrated")
                || description.contains("demonstration"),
            "privacy.add_noise description must flag it as non-calibrated: {description}"
        );
    }

    #[test]
    fn laplace_endpoints_stay_finite() {
        for raw_unit in [
            0.0,
            1.0,
            -0.0001,
            1.0001,
            0.5,
            f64::EPSILON,
            1.0 - f64::EPSILON,
        ] {
            let noisy = laplace_noise_from_unit(42.0, 2.5, raw_unit);
            assert!(
                noisy.is_finite(),
                "expected finite noisy value for rawUnit={raw_unit}"
            );
        }
    }

    #[test]
    fn laplace_midpoint_draw_returns_the_input() {
        // u = 0.5 → u - 0.5 = 0 → sign(0) = 0 → zero noise.
        assert_eq!(laplace_noise_from_unit(7.0, 1.0, 0.5), 7.0);
    }

    #[test]
    fn add_laplace_noise_draws_stay_finite() {
        let random_unit = xorshift_unit_sequence(0x1234_5678_9ABC_DEF0);
        for draw in 0..5000 {
            let noisy = laplace_noise_from_unit(100.0, 1.0, random_unit());
            assert!(
                noisy.is_finite(),
                "draw {draw} produced non-finite value {noisy}"
            );
        }
    }

    #[test]
    fn privacy_add_noise_builtin_stays_finite() {
        let random_unit = xorshift_unit_sequence(0x0FED_CBA9_8765_4321);
        for call in 0..2000 {
            let payload =
                json!({ "function": "privacy.add_noise", "input": { "value": 10, "scale": 1.0 } });
            let executed = execute_builtin_compute(&no_env, &payload, &random_unit, &cli_true)
                .expect("privacy.add_noise evaluates");
            let noisy = executed["result"]["noisy_value"]
                .as_f64()
                .expect("number result");
            assert!(
                noisy.is_finite(),
                "call {call} produced non-finite noisy_value {noisy}"
            );
        }
    }

    #[test]
    fn oversized_bigint_and_matrix_work_are_rejected() {
        let modexp = json!({
            "function": "math.modexp",
            "input": { "base": "2", "exponent": "9".repeat(1025), "modulus": "17" },
        });
        let error = run(&modexp).expect_err("oversized exponent is rejected");
        assert!(error.contains("bigint input limit"), "{error}");

        let side = 64;
        let matrix: Vec<_> = (0..side).map(|_| vec![1i64; side]).collect();
        let matrix_payload = json!({
            "function": "matrix.multiply",
            "input": { "left": matrix, "right": matrix },
        });
        let error = run(&matrix_payload).expect_err("64³ work estimate is rejected");
        assert!(error.contains("work estimate exceeds limit"), "{error}");
    }

    #[test]
    fn oversized_builtin_input_hits_the_size_limit() {
        // resolveMaxBytes floors every configured ceiling at 1024, so the
        // smallest enforceable limit is 1025 bytes.
        let env = env_from(&[("COMPUTE_MAX_BUILTIN_INPUT_BYTES", "1025")]);
        let payload = json!({ "function": "privacy.mask", "input": { "value": "x".repeat(1100) } });
        let error = execute_builtin_compute(&env, &payload, &|| 0.5, &cli_true)
            .expect_err("1111-byte input exceeds the 1025-byte ceiling");
        assert_eq!(
            error,
            "builtin compute input exceeds max size of 1025 bytes"
        );

        // A 1024-byte body passes the same ceiling.
        let payload = json!({ "function": "privacy.mask", "input": { "value": "x".repeat(1013) } });
        execute_builtin_compute(&env, &payload, &|| 0.5, &cli_true)
            .expect("1013-byte body stays under the 1025-byte ceiling");
    }

    #[test]
    fn hash_sha256_uses_stable_serialization() {
        // Node golden: sha256(stableStringify({z:1,a:[1,2,null],m:{k:null,s:"x"}})).
        let payload = json!({
            "function": "hash.sha256",
            "input": { "z": 1, "a": [1, 2, null], "m": { "k": null, "s": "x" } },
        });
        let executed = run(&payload).expect("hash.sha256 evaluates");
        assert_eq!(
            executed["result"]["digest"],
            "ec0161104498d2f9414482b6d851646e7203dd8f611a56cc4274ff2cc77d17a1"
        );
        // An empty input defaults to `{}` through the nullish chain.
        let payload = json!({ "function": "hash.sha256" });
        let executed = run(&payload).expect("hash.sha256 with no input evaluates");
        assert_eq!(
            executed["result"]["digest"],
            sha256_hex(stable_stringify(&json!({})).as_bytes())
        );
    }

    #[test]
    fn hash_keccak256_prefixes_the_digest() {
        let payload = json!({
            "function": "hash.keccak256",
            "input": { "z": 1, "a": [1, 2, null], "m": { "k": null, "s": "x" } },
        });
        let executed = run(&payload).expect("hash.keccak256 evaluates");
        assert_eq!(
            executed["result"]["digest"],
            "0x13b618ae14b05b9c78c77466012aa368d594f4da90dc3e329da30a75caeb8082"
        );
    }

    #[test]
    fn modexp_uses_bigint_remainder_semantics() {
        let payload = json!({
            "function": "math.modexp",
            "input": { "base": "2", "exponent": "10", "modulus": "1000" },
        });
        let executed = run(&payload).expect("math.modexp evaluates");
        assert_eq!(executed["result"]["value"], "24");

        // JS BigInt `%` keeps the dividend's sign: (-8) % 5 = -3.
        let payload = json!({
            "function": "math.modexp",
            "input": { "base": "-2", "exponent": "3", "modulus": "5" },
        });
        let executed = run(&payload).expect("negative base evaluates");
        assert_eq!(executed["result"]["value"], "-3");
    }

    #[test]
    fn polynomial_applies_the_modulus_correction() {
        let payload = json!({
            "function": "math.polynomial",
            "input": { "coefficients": [2, 3, 1], "x": 5 },
        });
        let executed = run(&payload).expect("math.polynomial evaluates");
        assert_eq!(executed["result"]["value"], "66");

        // (-1) mod 7 normalizes to 6.
        let payload = json!({
            "function": "math.polynomial",
            "input": { "coefficients": [-1], "x": 0, "modulus": "7" },
        });
        let executed = run(&payload).expect("moduled polynomial evaluates");
        assert_eq!(executed["result"]["value"], "6");
    }

    #[test]
    fn matrix_multiply_golden_and_guards() {
        let payload = json!({
            "function": "matrix.multiply",
            "input": { "left": [[1, "2"]], "right": [[3], [4]] },
        });
        let executed = run(&payload).expect("matrix.multiply evaluates");
        assert_eq!(executed["result"]["matrix"], json!([[11]]));

        let ragged = json!({
            "function": "matrix.multiply",
            "input": { "left": [[1, 2], [3]], "right": [[1], [2]] },
        });
        assert_eq!(
            run(&ragged).expect_err("ragged left matrix is rejected"),
            "invalid left matrix"
        );

        let misaligned = json!({
            "function": "matrix.multiply",
            "input": { "left": [[1, 2]], "right": [[1], [2], [3]] },
        });
        assert_eq!(
            run(&misaligned).expect_err("misaligned matrices are rejected"),
            "matrix dimensions do not align"
        );
    }

    #[test]
    fn cosine_similarity_golden() {
        let payload = json!({
            "function": "vector.cosine_similarity",
            "input": { "left": [1, 2, 3], "right": [4, 5, 6] },
        });
        let executed = run(&payload).expect("cosine similarity evaluates");
        assert_eq!(
            executed["result"]["similarity"].as_f64(),
            Some(0.9746318461970762)
        );

        let zero = json!({
            "function": "vector.cosine_similarity",
            "input": { "left": [0, 0], "right": [1, 2] },
        });
        assert_eq!(
            run(&zero).expect_err("zero vector is rejected"),
            "cosine similarity undefined for zero vector"
        );
    }

    #[test]
    fn merkle_root_goldens() {
        let single = json!({ "function": "merkle.root", "input": { "leaves": ["a"] } });
        assert_eq!(
            run(&single).expect("single leaf evaluates")["result"]["root"],
            "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb"
        );

        let pair = json!({ "function": "merkle.root", "input": { "leaves": ["a", "bb"] } });
        assert_eq!(
            run(&pair).expect("pair evaluates")["result"]["root"],
            "c8992d2867090f84ba65ece63048549da792651cbbe2663f9c1ebb1d34f38896"
        );

        // Odd leaf duplicates itself on the last pair.
        let triple =
            json!({ "function": "merkle.root", "input": { "leaves": ["a", "bb", "ccc"] } });
        assert_eq!(
            run(&triple).expect("triple evaluates")["result"]["root"],
            "edc9f4c3e74cbd691ad651e7e454b616ae17f2395e967d66ce8bd2e212a270b1"
        );

        // Hex leaves decode as bytes, not utf8.
        let hex_leaf = json!({ "function": "merkle.root", "input": { "leaves": ["0xdeadbeef"] } });
        assert_eq!(
            run(&hex_leaf).expect("hex leaf evaluates")["result"]["root"],
            "5f78c33274e43fa9de5659265c1d917e25c03722dcb0b8d27db8d5feaa813953"
        );

        let empty = json!({ "function": "merkle.root", "input": { "leaves": [] } });
        assert_eq!(
            run(&empty).expect_err("empty leaves are rejected"),
            "merkle.root requires at least one leaf"
        );
    }

    #[test]
    fn mask_string_edges() {
        let mask = |input: Json| {
            let payload = json!({ "function": "privacy.mask", "input": input });
            run(&payload).expect("privacy.mask evaluates")["result"]["masked"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        };
        assert_eq!(mask(json!({ "value": "abcdef" })), "ab**ef");
        assert_eq!(mask(json!({ "value": "abc" })), "****"); // short → max(len, 4)
        assert_eq!(mask(json!({ "value": "ab" })), "****");
        assert_eq!(
            mask(json!({ "value": "abcdefgh", "unmasked_left": 3, "unmasked_right": 1 })),
            "abc****h"
        );
        assert_eq!(mask(json!({ "value": 12345 })), "12*45"); // non-string value
        assert_eq!(
            mask(json!({ "value": "ab", "unmasked_left": 0, "unmasked_right": 0 })),
            "**ab"
        );
        // null ≠ the undefined default: null coerces to 0, so the tail slice
        // becomes slice(-0) — Node appends the WHOLE string back, not a tail.
        assert_eq!(
            mask(json!({ "value": "abcdef", "unmasked_left": 2, "unmasked_right": null })),
            "ab****abcdef"
        );
    }

    #[test]
    fn rotation_plan_dedupes_and_sorts() {
        let payload = json!({
            "function": "fhe.rotation_plan",
            "input": { "indices": [3, 1, 2, 3, 0] },
        });
        let executed = run(&payload).expect("rotation plan evaluates");
        assert_eq!(executed["result"]["indices"], json!([3, 1, 2, 3, 0]));
        assert_eq!(executed["result"]["unique_rotations"], json!([0, 1, 2, 3]));
        assert_eq!(executed["result"]["key_switch_steps"], 5);

        let absent = json!({ "function": "fhe.rotation_plan", "input": {} });
        let executed = run(&absent).expect("absent indices evaluates");
        assert_eq!(executed["result"]["indices"], json!([]));
        assert_eq!(executed["result"]["unique_rotations"], json!([]));
        assert_eq!(executed["result"]["key_switch_steps"], 0);
    }

    #[test]
    fn batch_plan_and_noise_budget() {
        let payload = json!({
            "function": "fhe.batch_plan",
            "input": { "slot_count": 1024, "ciphertext_count": 4 },
        });
        let executed = run(&payload).expect("batch plan evaluates");
        assert_eq!(executed["result"]["slots_per_ciphertext"], 256);

        // Zero ciphertext count leaves slots_per_ciphertext at slot_count.
        let payload = json!({
            "function": "fhe.batch_plan",
            "input": { "slot_count": 8, "ciphertext_count": 0 },
        });
        let executed = run(&payload).expect("degenerate batch plan evaluates");
        assert_eq!(executed["result"]["slots_per_ciphertext"], 8);

        let payload = json!({
            "function": "fhe.noise_budget_estimate",
            "input": { "multiplicative_depth": 3, "scale_bits": 40, "modulus_bits": 218 },
        });
        let executed = run(&payload).expect("noise budget evaluates");
        assert_eq!(executed["result"]["estimated_noise_budget"], 98);

        // Defaults: depth 1, scale 40, modulus 218 → 178.
        let payload = json!({ "function": "fhe.noise_budget_estimate", "input": {} });
        let executed = run(&payload).expect("default noise budget evaluates");
        assert_eq!(executed["result"]["estimated_noise_budget"], 178);

        // 218 - 10*40 < 0 clamps to 0.
        let payload = json!({
            "function": "fhe.noise_budget_estimate",
            "input": { "multiplicative_depth": 10, "scale_bits": 40, "modulus_bits": 218 },
        });
        let executed = run(&payload).expect("clamped noise budget evaluates");
        assert_eq!(executed["result"]["estimated_noise_budget"], 0);

        // Garbage depth → NaN budget → JSON null.
        let payload = json!({
            "function": "fhe.noise_budget_estimate",
            "input": { "multiplicative_depth": "abc" },
        });
        let executed = run(&payload).expect("NaN noise budget evaluates");
        assert!(executed["result"]["estimated_noise_budget"].is_null());
    }

    #[test]
    fn prove_plans_scale_by_constraints() {
        let payload = json!({
            "function": "zkp.groth16.prove.plan",
            "input": { "constraints": 120_000, "witness_count": 50_000 },
        });
        let executed = run(&payload).expect("groth16 plan evaluates");
        assert_eq!(executed["result"]["constraints"], 120_000);
        assert_eq!(executed["result"]["estimated_segments"], 3);
        assert_eq!(executed["result"]["estimated_memory_mb"], 7);

        let payload = json!({
            "function": "zkp.plonk.prove.plan",
            "input": { "gates": 70_000 },
        });
        let executed = run(&payload).expect("plonk plan evaluates");
        assert_eq!(executed["result"]["estimated_polynomials"], 2);
        assert_eq!(executed["result"]["estimated_memory_mb"], 3);

        // Garbage constraints → NaN everywhere NaN survives.
        let payload = json!({
            "function": "zkp.groth16.prove.plan",
            "input": { "constraints": "abc", "witness_count": 1 },
        });
        let executed = run(&payload).expect("NaN plan evaluates");
        assert!(executed["result"]["constraints"].is_null());
        assert!(executed["result"]["estimated_segments"].is_null());
        assert!(executed["result"]["estimated_memory_mb"].is_null());
    }

    #[test]
    fn groth16_verify_requires_the_cli_runtime() {
        let payload = json!({
            "function": "zkp.groth16.verify",
            "input": { "verifying_key": { "k": 1 }, "public_signals": ["1"], "proof": { "p": 1 } },
        });
        let error = run(&payload).expect_err("external verification is disabled by default");
        assert_eq!(
            error,
            "groth16 verification runtime disabled; set MORPHEUS_ZKP_VERIFY_RUNTIME=cli to enable explicit external verification"
        );
    }

    #[test]
    fn groth16_verify_delegates_to_the_cli_closure() {
        let env = env_from(&[("MORPHEUS_ZKP_VERIFY_RUNTIME", "cli")]);
        let payload = json!({
            "function": "zkp.groth16.verify",
            "input": { "verifying_key": { "k": 1 }, "public_signals": ["1"], "proof": { "p": 1 } },
        });
        let executed =
            run_with_cli(&env, &payload, &cli_true).expect("cli-approved proof evaluates");
        assert_eq!(executed["result"]["is_valid"], true);
        let executed =
            run_with_cli(&env, &payload, &cli_false).expect("cli-rejected proof evaluates");
        assert_eq!(executed["result"]["is_valid"], false);
        let error = run_with_cli(&env, &payload, &cli_boom).expect_err("cli failure propagates");
        assert_eq!(error, "boom");
    }

    #[test]
    fn groth16_verify_receives_the_resolved_arguments() {
        let env = env_from(&[("MORPHEUS_ZKP_VERIFY_RUNTIME", "cli")]);
        let payload = json!({
            "function": "zkp.groth16.verify",
            "input": { "verifyingKey": { "k": 1 }, "publicSignals": [1, null] },
        });
        let captured = RefCell::new(None);
        let record = |key: &Json, signals: &Json, proof: &Json| {
            *captured.borrow_mut() = Some((key.clone(), signals.clone(), proof.clone()));
            Ok(true)
        };
        let executed = run_with_cli(&env, &payload, &record).expect("verification evaluates");
        assert_eq!(executed["result"]["is_valid"], true);
        let (key, signals, proof) = captured.into_inner().unwrap();
        assert_eq!(key, json!({ "k": 1 })); // camelCase alias resolved
        assert_eq!(signals, json!(["1", "null"])); // normalized + stringified
        assert_eq!(proof, Json::Null); // absent proof reaches the closure as null
    }

    fn zerc20_payload(extra: Json) -> Json {
        let mut input = json!({
            "recipient": "0x91522B07D030405A7BD815A409C5A8AAC8BB4B61",
            "withdraw_value": "1000000000000000000",
            "tree_root": "0x27ae5ba5cd2f8b7c3ae8d3c0eb2eb5e5e4a1a3b9c2d1e0f1a2b3c4d5e6f70819",
            "path_indices": "0x0000000000000000000000000000000000000000000000000000000000000003",
            "blacklisted_root": "0x1111111111111111111111111111111111111111111111111111111111111111",
        });
        let object = input.as_object_mut().unwrap();
        for (key, value) in extra.as_object().expect("extra is an object") {
            object.insert(key.clone(), value.clone());
        }
        json!({ "function": "zkp.zerc20.single_withdraw.verify", "input": input })
    }

    #[test]
    fn zerc20_verifies_the_statement_and_optional_proof() {
        let env = env_from(&[("MORPHEUS_ZKP_VERIFY_RUNTIME", "cli")]);
        let payload = zerc20_payload(json!({
            "verifying_key": { "k": 1 },
            "proof": { "pi_a": [1, 2] },
        }));
        let executed =
            run_with_cli(&env, &payload, &cli_true).expect("zERC20 verification evaluates");
        let result = &executed["result"];
        // Uppercase recipient hex normalized to lowercase.
        assert_eq!(
            result["statement"]["recipient"],
            "0x91522b07d030405a7bd815a409c5a8aac8bb4b61"
        );
        // Node golden: sha256(stableStringify(statement)).
        assert_eq!(
            result["statement_hash"],
            "2535f96d0c633ee2c5d747c82aab478c0b0e6509986d36513591ce6fdc842876"
        );
        // No expected_* inputs → every check unchecked; proof closure approved.
        for key in [
            "recipient",
            "withdraw_value",
            "tree_root",
            "path_indices",
            "blacklisted_root",
        ] {
            let check = &result["checks"][key];
            assert_eq!(check["checked"], false, "check {key}");
            assert_eq!(check["ok"], true, "check {key}");
            assert!(
                check.get("expected").is_none(),
                "unchecked check {key} carries no expected"
            );
        }
        assert_eq!(result["proof_verified"], true);
        assert_eq!(result["is_valid"], true);
        // Public signals default to the statement fields, stringified.
        assert_eq!(result["public_signals"].as_array().map(Vec::len), Some(5));
    }

    #[test]
    fn zerc20_mismatched_expectations_deny() {
        let env = env_from(&[("MORPHEUS_ZKP_VERIFY_RUNTIME", "cli")]);
        let payload = zerc20_payload(json!({
            "expected_recipient": "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
            "expected_withdraw_value": "1000000000000000000",
            "verifying_key": { "k": 1 },
            "proof": { "pi_a": [1, 2] },
        }));
        let executed =
            run_with_cli(&env, &payload, &cli_true).expect("zERC20 verification evaluates");
        let recipient = &executed["result"]["checks"]["recipient"];
        assert_eq!(recipient["checked"], true);
        assert_eq!(recipient["ok"], false);
        assert_eq!(
            recipient["expected"],
            "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
        );
        // The scalar expectation matched, but any failed check denies.
        assert_eq!(executed["result"]["checks"]["withdraw_value"]["ok"], true);
        assert_eq!(executed["result"]["is_valid"], false);
    }

    #[test]
    fn zerc20_requires_verifying_key_and_object_proof() {
        let payload = zerc20_payload(json!({}));
        assert_eq!(
            run(&payload).expect_err("missing verifying key is rejected"),
            "verifying_key is required for zERC20 proof verification"
        );

        let payload =
            zerc20_payload(json!({ "verifying_key": { "k": 1 }, "proof": "not-an-object" }));
        assert_eq!(
            run(&payload).expect_err("non-object proof is rejected"),
            "proof object is required when verifying_key is supplied"
        );
    }

    #[test]
    fn zerc20_honors_the_public_inputs_alias_and_statement_signals() {
        // Fields nested under public_inputs drive the statement; the camelCase
        // verifyingKey alias satisfies the proof gate.
        let payload = json!({
            "function": "zkp.zerc20.single_withdraw.verify",
            "input": {
                "public_inputs": {
                    "recipient": "0x91522b07d030405a7bd815a409c5a8aac8bb4b61",
                    "withdrawValue": "1000000000000000000",
                    "tree_root": "0x27ae5ba5cd2f8b7c3ae8d3c0eb2eb5e5e4a1a3b9c2d1e0f1a2b3c4d5e6f70819",
                    "path_indices": "0x0000000000000000000000000000000000000000000000000000000000000003",
                    "blacklisted_root": "0x1111111111111111111111111111111111111111111111111111111111111111",
                },
                "verifyingKey": { "k": 1 },
                "proof": { "pi_a": [1, 2] },
            },
        });
        let env = env_from(&[("MORPHEUS_ZKP_VERIFY_RUNTIME", "cli")]);
        let executed =
            run_with_cli(&env, &payload, &cli_true).expect("zERC20 verification evaluates");
        assert_eq!(
            executed["result"]["statement_hash"],
            "2535f96d0c633ee2c5d747c82aab478c0b0e6509986d36513591ce6fdc842876"
        );
        assert_eq!(executed["result"]["is_valid"], true);
    }

    #[test]
    fn zkp_digests_compose_over_stable_serialization() {
        let payload = json!({
            "function": "zkp.public_signal_hash",
            "input": { "signals": [1, "2"] },
        });
        let executed = run(&payload).expect("public signal hash evaluates");
        let expected = sha256_hex(
            stable_stringify(&json!({ "circuit_id": Json::Null, "signals": [1, "2"] })).as_bytes(),
        );
        assert_eq!(executed["result"]["digest"], expected);

        // Absent proof falls back to the whole input as the proof payload.
        let payload = json!({
            "function": "zkp.proof_digest",
            "input": { "circuit_id": "circuit-1", "signals": [7] },
        });
        let executed = run(&payload).expect("proof digest evaluates");
        let expected = sha256_hex(
            stable_stringify(&json!({
                "proof": { "circuit_id": "circuit-1", "signals": [7] },
                "verifying_key": Json::Null,
            }))
            .as_bytes(),
        );
        assert_eq!(executed["result"]["digest"], expected);

        let payload = json!({
            "function": "zkp.witness_digest",
            "input": { "witness": ["w1"], "circuit_id": "circuit-1" },
        });
        let executed = run(&payload).expect("witness digest evaluates");
        let expected = sha256_hex(
            stable_stringify(&json!({ "witness": ["w1"], "circuit_id": "circuit-1" })).as_bytes(),
        );
        assert_eq!(executed["result"]["digest"], expected);
    }

    const RSA_PEM: &str = "-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDpqrRfzOcgtJ7pqtFFkwsL3Phs\njD1/RsFbqrD57/tXPwqYBojgZITTsoL7lLccrTzeQChOIw718ILv/rr4p1FjY9+4\nzQvrRFIWDdQyyOgtdbYS2nTppBnnvsHJg0F76Lzn2xi5dW6GJHRXgGJDAXRMx1pJ\nR8uO+jlzRWUK0ina+QIDAQAB\n-----END PUBLIC KEY-----";
    const RSA_SIGNATURE: &str = "70ac7f5e0643effe11ba0ea2dc03a966d0d072aa093460c7e0dc21be313c9348a47f9157749ca6304220f3d7e68e8594a4c14ab7d9904fdbf4daaa0ec824f18c189090a6a8dce56549146596ba80f761c8c6fbd220ea17a9d5b985c53a8aedd676a98a5a7ae11ce64f02fa5f26324430aee956da2e8c9d742ddb8fdc2a62916e";

    #[test]
    fn rsa_verify_accepts_a_node_generated_signature() {
        let payload = json!({
            "function": "crypto.rsa_verify",
            "input": {
                "public_key": RSA_PEM,
                "signature": RSA_SIGNATURE,
                "payload": "hello morpheus",
            },
        });
        let executed = run(&payload).expect("rsa_verify evaluates");
        assert_eq!(executed["result"]["is_valid"], true);

        // Tampered payload fails verification.
        let payload = json!({
            "function": "crypto.rsa_verify",
            "input": {
                "public_key": RSA_PEM,
                "signature": RSA_SIGNATURE,
                "payload": "hello morpheuX",
            },
        });
        let executed = run(&payload).expect("tampered rsa_verify evaluates");
        assert_eq!(executed["result"]["is_valid"], false);
    }

    #[test]
    fn rsa_verify_failure_modes_collapse_to_false() {
        let verify = |input: Json| {
            let payload = json!({ "function": "crypto.rsa_verify", "input": input });
            run(&payload).expect("rsa_verify never throws")["result"]["is_valid"]
                .as_bool()
                .unwrap()
        };
        // Non-string payload — Node's verify.update throws, caught → false.
        assert!(!verify(json!({
            "public_key": RSA_PEM,
            "signature": RSA_SIGNATURE,
            "payload": 42,
        })));
        // Unparsable key.
        assert!(!verify(json!({
            "public_key": "not a pem",
            "signature": RSA_SIGNATURE,
            "payload": "hello morpheus",
        })));
        // Invalid signature hex decodes to nothing.
        assert!(!verify(json!({
            "public_key": RSA_PEM,
            "signature": "zz",
            "payload": "hello morpheus",
        })));
        // Truncated signature has the wrong length.
        assert!(!verify(json!({
            "public_key": RSA_PEM,
            "signature": "70ac7f5e",
            "payload": "hello morpheus",
        })));
    }

    #[test]
    fn unknown_function_errors_like_the_switch_default() {
        let payload = json!({ "function": "nope", "input": {} });
        assert_eq!(
            run(&payload).expect_err("unknown function is rejected"),
            "unknown builtin compute function: nope"
        );
        // Both name fields absent → trimString('') → same default arm.
        let payload = json!({ "input": {} });
        assert_eq!(
            run(&payload).expect_err("absent function is rejected"),
            "unknown builtin compute function: "
        );
    }

    #[test]
    fn input_falls_back_through_the_nullish_chain() {
        // input: null collapses to compute_args.
        let payload = json!({
            "function": "hash.sha256",
            "input": Json::Null,
            "compute_args": { "z": 1, "a": [1, 2, null], "m": { "k": null, "s": "x" } },
        });
        let executed = run(&payload).expect("compute_args fallback evaluates");
        assert_eq!(
            executed["result"]["digest"],
            "ec0161104498d2f9414482b6d851646e7203dd8f611a56cc4274ff2cc77d17a1"
        );
        // compute_fn resolves the same function lane.
        let payload = json!({ "compute_fn": "hash.sha256", "input": {} });
        let executed = run(&payload).expect("compute_fn alias evaluates");
        assert_eq!(executed["function"], "hash.sha256");
    }

    #[test]
    fn bigint_input_validation_matches_the_js_grammar() {
        // Radix prefixes parse like BigInt(string).
        let payload = json!({
            "function": "math.modexp",
            "input": { "base": "0x10", "exponent": "0b101", "modulus": "0o377" },
        });
        let executed = run(&payload).expect("radix prefixes evaluate");
        // 16^5 mod 255 = 1048576 mod 255 = 16.
        assert_eq!(executed["result"]["value"], "16");
        // Exponent must be non-negative; modulus non-zero.
        let payload = json!({
            "function": "math.modexp",
            "input": { "base": "2", "exponent": "-1", "modulus": "17" },
        });
        assert_eq!(
            run(&payload).expect_err("negative exponent is rejected"),
            "exponent must be non-negative"
        );
        let payload = json!({
            "function": "math.modexp",
            "input": { "base": "2", "exponent": "1", "modulus": "0" },
        });
        assert_eq!(
            run(&payload).expect_err("zero modulus is rejected"),
            "modulus must be non-zero"
        );
        // Decimal floats and NaN strings fail the BigInt grammar.
        let payload = json!({
            "function": "math.modexp",
            "input": { "base": 2.5, "exponent": "1", "modulus": "17" },
        });
        assert_eq!(
            run(&payload).expect_err("fractional base is rejected"),
            "base must be an integer"
        );
    }
}
