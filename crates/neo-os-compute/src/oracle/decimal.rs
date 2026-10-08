//! Port of `workers/nitro-worker/src/oracle/feeds/decimal.js` — the
//! fixed-decimal string ⇄ scaled-integer conversions the feed submission lane
//! uses. Every function is pure string/number math over `BigInt`.

use num_bigint::BigInt;
use serde_json::Value as Json;

use crate::js::{js_number, js_number_to_string, js_stringify, js_to_fixed, js_trim};

/// `decimalToIntegerString(value, decimals)` — a trimmed decimal string to the
/// scaled integer string (`'1.5'`, 6 → `'1500000'`). Errors keep the JS
/// messages, embedding the ORIGINAL (untrimmed) value.
pub fn decimal_to_integer_string(value: &str, decimals: usize) -> Result<String, String> {
    let raw = js_trim(value);
    if raw.is_empty() {
        return Err("decimal value required".to_string());
    }
    let negative = raw.starts_with('-');
    let normalized = raw.strip_prefix(['+', '-']).unwrap_or(raw);
    if !is_plain_decimal(normalized) {
        return Err(format!("invalid decimal value: {value}"));
    }
    let (whole_part, fraction_part) = split_decimal(normalized);
    let whole: BigInt = if whole_part.is_empty() {
        BigInt::from(0) // `BigInt(wholePart || '0')`
    } else {
        whole_part
            .parse()
            .map_err(|_| format!("invalid decimal value: {value}"))?
    };
    // (fractionPart + '0'.repeat(decimals)).slice(0, decimals)
    let mut fraction_text = fraction_part.to_string();
    while fraction_text.len() < decimals {
        fraction_text.push('0');
    }
    fraction_text.truncate(decimals);
    let fraction: BigInt = if fraction_text.is_empty() {
        BigInt::from(0)
    } else {
        fraction_text
            .parse()
            .map_err(|_| format!("invalid decimal value: {value}"))?
    };
    let scale = BigInt::from(10u8).pow(decimals as u32);
    let mut result = whole * scale + fraction;
    if negative {
        result = -result;
    }
    Ok(result.to_string())
}

/// `integerToDecimalString(value, decimals)` — the scaled integer back to the
/// decimal rendering (`'1500000'`, 6 → `'1.500000'`); null renders as `0`.
pub fn integer_to_decimal_string(value: &Json, decimals: usize) -> String {
    let raw = match value {
        Json::Null => "0".to_string(), // `String(value ?? '0')`
        other => js_stringify(other),
    };
    let negative = raw.starts_with('-');
    let stripped = raw.strip_prefix(['+', '-']).unwrap_or(&raw);
    let digits = if stripped.is_empty() { "0" } else { stripped };
    // `String.prototype.length` and `slice` in the JavaScript port count UTF-16
    // code units and tolerate splitting a surrogate pair. Slicing Rust `String`
    // byte indices panicked whenever `len - decimals` was not a char boundary
    // (CU-179: `integer_to_decimal_string("é00000", 6)`); code units keep the
    // ported semantics for every input.
    let mut padded: Vec<u16> = digits.encode_utf16().collect();
    while padded.len() < decimals + 1 {
        padded.insert(0, u16::from(b'0'));
    }
    // decimals is 6 at every call site; the 0 arm reproduces the JS
    // `slice(0, -0)` quirk for completeness.
    let (whole, fraction) = if decimals == 0 {
        ("0".to_string(), String::from_utf16_lossy(&padded))
    } else {
        let (whole, fraction) = padded.split_at(padded.len() - decimals);
        (
            String::from_utf16_lossy(whole),
            String::from_utf16_lossy(fraction),
        )
    };
    let whole = if whole.is_empty() {
        "0".to_string()
    } else {
        whole
    };
    format!("{}{}.{}", if negative { "-" } else { "" }, whole, fraction)
}

/// `multiplyDecimalString(value, multiplier)` — a decimal string times an
/// integer-truncated multiplier, trailing fraction zeros stripped; a
/// multiplier of exactly 1 returns the raw trimmed value unchanged.
pub fn multiply_decimal_string(value: &str, multiplier: f64) -> Result<String, String> {
    let raw = js_trim(value);
    if raw.is_empty() {
        return Err("decimal value required".to_string());
    }
    if !multiplier.is_finite() || multiplier <= 0.0 {
        return Err(format!(
            "invalid multiplier: {}",
            js_number_to_string(multiplier)
        ));
    }
    if multiplier == 1.0 {
        return Ok(raw.to_string());
    }
    let sign = if raw.starts_with('-') { "-" } else { "" };
    let normalized = raw.strip_prefix(['+', '-']).unwrap_or(raw);
    if !is_plain_decimal(normalized) {
        return Err(format!("invalid decimal value: {value}"));
    }
    let (whole_part, fraction_part) = split_decimal(normalized);
    let concatenated = format!("{whole_part}{fraction_part}");
    let base: BigInt = if concatenated.is_empty() {
        BigInt::from(0) // `BigInt(`${wholePart}${fractionPart}` || '0')`
    } else {
        concatenated
            .parse()
            .map_err(|_| format!("invalid decimal value: {value}"))?
    };
    let scaled = base * BigInt::from(multiplier.trunc() as i128);
    let mut digits = scaled.to_string();
    while digits.len() < fraction_part.len() + 1 {
        digits.insert(0, '0');
    }
    let whole = if !fraction_part.is_empty() {
        digits[..digits.len() - fraction_part.len()].to_string()
    } else {
        digits.clone()
    };
    let fraction = if !fraction_part.is_empty() {
        digits[digits.len() - fraction_part.len()..]
            .trim_end_matches('0')
            .to_string()
    } else {
        String::new()
    };
    Ok(if fraction.is_empty() {
        format!("{sign}{whole}")
    } else {
        format!("{sign}{whole}.{fraction}")
    })
}

/// `transformDecimalString(value, { transform, multiplier })` — the numeric
/// pass: parse via `Number`, optional `inverse`, multiplier applied when ≠ 1,
/// then rendered through `toFixed(12)` with the `/\.?0+$/` trailing-zero strip
/// (whose quirks — `"100.000000000000"` → `"100"` — are part of the wire
/// format).
pub fn transform_decimal_string(
    value: &str,
    transform: &str,
    multiplier: f64,
) -> Result<String, String> {
    let mut numeric = js_number(js_trim(value));
    if !numeric.is_finite() || numeric <= 0.0 {
        return Err(format!("invalid decimal value: {value}"));
    }
    if transform == "inverse" {
        numeric = 1.0 / numeric;
    }
    if multiplier != 1.0 {
        numeric *= multiplier;
    }
    normalize_decimal_number_string(numeric)
}

/// `normalizeDecimalNumberString(value, precision = 12)` — module-private in
/// the JS; non-finite values throw with the JS rendering of the number.
fn normalize_decimal_number_string(numeric: f64) -> Result<String, String> {
    if !numeric.is_finite() {
        return Err(format!(
            "invalid numeric value: {}",
            js_number_to_string(numeric)
        ));
    }
    Ok(strip_js_trailing_zeros(&js_to_fixed(numeric, 12)))
}

/// `String.replace(/\.?0+$/, '')` — the LEFTMOST position where the rest of
/// the string is an optional `.` followed by at least one `0` running to the
/// end. That means plain integers lose their trailing zeros too (`"100"` →
/// `"1"`) and an exponential tail is clipped (`"1e+30"` → `"1e+3"`) — both
/// quirks are faithfully replicated because callers already pin the outputs.
fn strip_js_trailing_zeros(s: &str) -> String {
    let bytes = s.as_bytes();
    for i in 0..bytes.len() {
        let mut j = i;
        if bytes[j] == b'.' {
            j += 1;
        }
        if j < bytes.len() && bytes[j..].iter().all(|&b| b == b'0') {
            return s[..i].to_string();
        }
    }
    s.to_string()
}

/// `^\d+(\.\d+)?$` — at least one integer digit, optional fraction with at
/// least one digit.
fn is_plain_decimal(s: &str) -> bool {
    match s.split_once('.') {
        Some((whole, frac)) => {
            !whole.is_empty()
                && whole.bytes().all(|b| b.is_ascii_digit())
                && !frac.is_empty()
                && frac.bytes().all(|b| b.is_ascii_digit())
        }
        None => !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()),
    }
}

fn split_decimal(normalized: &str) -> (&str, &str) {
    match normalized.split_once('.') {
        Some((whole, frac)) => (whole, frac),
        None => (normalized, ""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decimal_to_integer_scales_by_the_decimals() {
        assert_eq!(decimal_to_integer_string("1.5", 6).unwrap(), "1500000");
        assert_eq!(decimal_to_integer_string("-1.5", 6).unwrap(), "-1500000");
        assert_eq!(decimal_to_integer_string("0.000001", 6).unwrap(), "1");
        assert_eq!(decimal_to_integer_string("100", 6).unwrap(), "100000000");
        assert_eq!(decimal_to_integer_string("  2.75  ", 6).unwrap(), "2750000");
        assert_eq!(decimal_to_integer_string("+3.1", 6).unwrap(), "3100000");
        assert_eq!(
            decimal_to_integer_string("123.456789012", 12).unwrap(),
            "123456789012000"
        );
    }

    #[test]
    fn decimal_to_integer_errors_keep_the_js_messages() {
        assert_eq!(
            decimal_to_integer_string("", 6).unwrap_err(),
            "decimal value required"
        );
        assert_eq!(
            decimal_to_integer_string("   ", 6).unwrap_err(),
            "decimal value required"
        );
        assert_eq!(
            decimal_to_integer_string("abc", 6).unwrap_err(),
            "invalid decimal value: abc"
        );
        // the message embeds the ORIGINAL (untrimmed) value
        assert_eq!(
            decimal_to_integer_string(" 4x ", 6).unwrap_err(),
            "invalid decimal value:  4x "
        );
        assert_eq!(
            decimal_to_integer_string("1.2.3", 6).unwrap_err(),
            "invalid decimal value: 1.2.3"
        );
        assert_eq!(
            decimal_to_integer_string(".5", 6).unwrap_err(),
            "invalid decimal value: .5"
        );
    }

    #[test]
    fn integer_to_decimal_renders_the_fixed_width() {
        assert_eq!(integer_to_decimal_string(&json!("1500000"), 6), "1.500000");
        assert_eq!(integer_to_decimal_string(&json!(1500000), 6), "1.500000");
        assert_eq!(integer_to_decimal_string(&json!("-1"), 6), "-0.000001");
        assert_eq!(integer_to_decimal_string(&json!("0"), 6), "0.000000");
        assert_eq!(integer_to_decimal_string(&Json::Null, 6), "0.000000");
        assert_eq!(
            integer_to_decimal_string(&json!("123456789"), 6),
            "123.456789"
        );
    }

    #[test]
    fn multiply_scales_and_strips_trailing_fraction_zeros() {
        assert_eq!(multiply_decimal_string("1.5", 2.0).unwrap(), "3");
        assert_eq!(multiply_decimal_string("0.125", 2.0).unwrap(), "0.25");
        assert_eq!(multiply_decimal_string("-1.5", 2.0).unwrap(), "-3");
        assert_eq!(multiply_decimal_string("1.5", 2.9).unwrap(), "3"); // trunc(2.9) = 2
        assert_eq!(multiply_decimal_string("2.50", 3.0).unwrap(), "7.5");
        // factor 1 returns the raw trimmed value unchanged
        assert_eq!(multiply_decimal_string("2.50", 1.0).unwrap(), "2.50");
        assert_eq!(multiply_decimal_string("+1.5", 1.0).unwrap(), "+1.5");
    }

    #[test]
    fn multiply_errors_keep_the_js_messages() {
        assert_eq!(
            multiply_decimal_string("", 2.0).unwrap_err(),
            "decimal value required"
        );
        assert_eq!(
            multiply_decimal_string("1.5", 0.0).unwrap_err(),
            "invalid multiplier: 0"
        );
        assert_eq!(
            multiply_decimal_string("1.5", -1.0).unwrap_err(),
            "invalid multiplier: -1"
        );
        assert_eq!(
            multiply_decimal_string("1.5", f64::NAN).unwrap_err(),
            "invalid multiplier: NaN"
        );
        assert_eq!(
            multiply_decimal_string("abc", 2.0).unwrap_err(),
            "invalid decimal value: abc"
        );
    }

    #[test]
    fn transform_parses_inverts_and_scales() {
        assert_eq!(transform_decimal_string("2", "", 1.0).unwrap(), "2");
        assert_eq!(transform_decimal_string("  2.5  ", "", 1.0).unwrap(), "2.5");
        assert_eq!(
            transform_decimal_string("2", "inverse", 1.0).unwrap(),
            "0.5"
        );
        assert_eq!(
            transform_decimal_string("0.5", "inverse", 1.0).unwrap(),
            "2"
        );
        assert_eq!(transform_decimal_string("2", "inverse", 2.0).unwrap(), "1");
        assert_eq!(transform_decimal_string("4", "", 0.5).unwrap(), "2");
        assert_eq!(transform_decimal_string("1", "", 3.0).unwrap(), "3");
        // the toFixed(12) + strip pipeline, quirks included
        assert_eq!(transform_decimal_string("100", "", 1.0).unwrap(), "100");
        assert_eq!(
            transform_decimal_string("150", "inverse", 1.0).unwrap(),
            "0.006666666667"
        );
        assert_eq!(transform_decimal_string("1", "", 0.5).unwrap(), "0.5");
    }

    #[test]
    fn transform_errors_keep_the_js_messages() {
        assert_eq!(
            transform_decimal_string("0", "", 1.0).unwrap_err(),
            "invalid decimal value: 0"
        );
        assert_eq!(
            transform_decimal_string("-1", "", 1.0).unwrap_err(),
            "invalid decimal value: -1"
        );
        assert_eq!(
            transform_decimal_string("abc", "", 1.0).unwrap_err(),
            "invalid decimal value: abc"
        );
    }
}
