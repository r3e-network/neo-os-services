//! ECMAScript `Number::toString(10)` formatting (ECMA-262 §7.1.12.1) plus the
//! JSON.stringify number mapping.
//!
//! The standard Rust JSON formatter does not use the ECMAScript rendering
//! rules for every exponent and tie boundary, so every number that reaches a
//! JSON.stringify-equivalent path goes through this module.

use num_traits::ToPrimitive;

/// ECMAScript ToString for a finite or special double. `NaN` -> `"NaN"`,
/// `-0` -> `"0"`, `Infinity` -> `"Infinity"`.
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_string();
    }
    if x == 0.0 {
        return "0".to_string();
    }
    let negative = x < 0.0;
    let magnitude = x.abs();
    if magnitude.is_infinite() {
        return if negative {
            "-Infinity".to_string()
        } else {
            "Infinity".to_string()
        };
    }

    let mut buffer = ryu_js::Buffer::new();
    let body = buffer.format_finite(magnitude).to_owned();

    if negative {
        format!("-{body}")
    } else {
        body
    }
}

/// JSON.stringify's number form: finite numbers via `number_to_string`,
/// NaN/Infinity become `null`.
pub fn json_number_to_string(x: f64) -> String {
    if x.is_nan() || x.is_infinite() {
        "null".to_string()
    } else {
        number_to_string(x)
    }
}

/// JS `Number(string)` (ECMA-262 StringNumericLiteral). Empty/whitespace-only
/// input is 0, `Infinity` (signed) is exact, `0x`/`0o`/`0b` integer literals
/// are exact-prefix forms, and any other decimal literal — including `1.`,
/// `.5`, `1e+3` — must round-trip through the same correctly-rounded parse
/// V8 performs (Rust's `f64::from_str` is also correctly rounded, so after a
/// strict grammar check the two agree bit-for-bit). Everything else is NaN;
/// notably `Number('1_000')`, `Number('12abc')` and `Number('inf')` are all
/// NaN, and hex prefixes require at least one digit.
pub fn parse_js_number(raw: &str) -> f64 {
    let s = crate::js_value::js_trim(raw);
    if s.is_empty() {
        return 0.0;
    }
    let (sign, body) = match s.as_bytes().first() {
        Some(b'+') => (1.0, &s[1..]),
        Some(b'-') => (-1.0, &s[1..]),
        _ => (1.0, s),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    // Radix-prefixed integer literals: sign is NOT allowed before 0x/0o/0b
    // in StringNumericLiteral ('-0x10' is NaN) — the sign was already peeled
    // only for the Infinity/decimal forms, so check the *original* string.
    for (prefix, radix) in [
        ("0x", 16u32),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = s.strip_prefix(prefix) {
            if !digits.is_empty() && digits.bytes().all(|b| (b as char).is_digit(radix)) {
                let digits = digits.trim_start_matches('0');
                if digits.is_empty() {
                    return 0.0;
                }
                // A non-zero radix literal above 2^1024 is necessarily
                // outside the finite f64 domain. Check the bit length before
                // constructing a BigUint so attacker-controlled strings do
                // not cause an unbounded allocation. Leading zeroes remain
                // accepted and are discarded before this bound is evaluated.
                if radix_literal_bit_length(digits, radix)
                    .is_none_or(|bits| bits > f64::MAX_EXP as usize)
                {
                    return f64::INFINITY;
                }
                let value = num_bigint::BigUint::parse_bytes(digits.as_bytes(), radix)
                    .expect("validated radix digits are parseable");
                // BigUint's conversion is correctly rounded for finite values
                // and reports overflow as None, which is JS Number's Infinity.
                return value.to_f64().unwrap_or(f64::INFINITY);
            }
            return f64::NAN;
        }
    }
    if !is_decimal_numeric_literal(body) {
        return f64::NAN;
    }
    // The grammar check rejects inf/infinity/NaN spellings, so from_str here
    // can only produce the correctly-rounded decimal value.
    body.parse::<f64>()
        .map(|v| if v == 0.0 { v.copysign(sign) } else { sign * v })
        .unwrap_or(f64::NAN)
}

fn radix_literal_bit_length(digits: &str, radix: u32) -> Option<usize> {
    let bits_per_digit = match radix {
        2 => 1,
        8 => 3,
        16 => 4,
        _ => return None,
    };
    let first = digits.as_bytes().first()?.to_ascii_lowercase();
    let value = match first {
        b'0'..=b'9' => u32::from(first - b'0'),
        b'a'..=b'f' => u32::from(first - b'a') + 10,
        _ => return None,
    };
    if value == 0 {
        return None;
    }
    let first_bits = (u32::BITS - value.leading_zeros()) as usize;
    first_bits.checked_add((digits.len() - 1).checked_mul(bits_per_digit)?)
}

/// ECMA-262 StrDecimalLiteral: `[+-]?` was already peeled; accept
/// `digits[.digits?]` | `.digits`, optionally followed by an exponent.
fn is_decimal_numeric_literal(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0;
    let mut int_digits = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
        int_digits += 1;
    }
    let mut frac_digits = 0;
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
            frac_digits += 1;
        }
    }
    if int_digits == 0 && frac_digits == 0 {
        return false;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1;
        }
        let mut exp_digits = 0;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
            exp_digits += 1;
        }
        if exp_digits == 0 {
            return false;
        }
    }
    i == bytes.len()
}

/// JS `Number(value)` coercion over the dynamic value model (ECMA-262
/// ToNumber for the shapes reachable from parsed JSON): objects/arrays via
/// their ToString form, BigInt via its decimal value, undefined → NaN.
pub fn number_of(value: &crate::js_value::JsValue) -> f64 {
    use crate::js_value::JsValue;
    match value {
        JsValue::Undefined => f64::NAN,
        JsValue::Null => 0.0,
        JsValue::Bool(true) => 1.0,
        JsValue::Bool(false) => 0.0,
        JsValue::Number(n) => *n,
        JsValue::BigInt(v) => v.parse::<u128>().map(|x| x as f64).unwrap_or(f64::NAN),
        JsValue::Str(s) => parse_js_number(s),
        JsValue::Array(_) | JsValue::Object(_) => {
            parse_js_number(&crate::js_value::to_display_string(value))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_ecmascript_forms() {
        assert_eq!(number_to_string(0.0), "0");
        assert_eq!(number_to_string(-0.0), "0");
        assert_eq!(number_to_string(7.0), "7");
        assert_eq!(number_to_string(0.1), "0.1");
        assert_eq!(number_to_string(-42.0), "-42");
        assert_eq!(number_to_string(123.456), "123.456");
        assert_eq!(number_to_string(1e21), "1e+21");
        assert_eq!(number_to_string(1e20), "100000000000000000000");
        assert_eq!(number_to_string(1e-6), "0.000001");
        assert_eq!(number_to_string(1e-7), "1e-7");
        assert_eq!(number_to_string(9007199254740992.0), "9007199254740992");
        assert_eq!(number_to_string(f64::NAN), "NaN");
        assert_eq!(json_number_to_string(f64::NAN), "null");
        assert_eq!(json_number_to_string(f64::INFINITY), "null");
    }

    #[test]
    fn number_to_string_uses_ecmascript_tie_choice() {
        // V8 chooses the even shortest round-trip candidate at this exact
        // binary/decimal boundary. Keep this vector pinned to the ECMAScript
        // formatter used by the consensus path.
        let value = f64::from_bits(0x4313_f424_38fa_d979);
        assert_eq!(number_to_string(value), "1404115242366558.2");
        assert_eq!(number_to_string(-value), "-1404115242366558.2");
    }

    #[test]
    fn parses_arbitrarily_long_radix_literals_like_v8() {
        assert_eq!(parse_js_number("0x1f"), 31.0);
        assert_eq!(parse_js_number("0b101"), 5.0);

        let finite_hex = format!("0x{}", "f".repeat(130));
        assert_eq!(parse_js_number(&finite_hex), 3.432398830065305e156_f64);

        let overflow_hex = format!("0x{}", "f".repeat(400));
        assert_eq!(parse_js_number(&overflow_hex), f64::INFINITY);

        let long_binary = format!("0b{}", "1".repeat(400));
        assert_eq!(parse_js_number(&long_binary), 2.5822498780869086e120_f64);

        let long_leading_zeroes = format!("0x{}1", "0".repeat(100_000));
        assert_eq!(parse_js_number(&long_leading_zeroes), 1.0);

        let bounded_overflow = format!("0x1{}", "0".repeat(300));
        assert_eq!(parse_js_number(&bounded_overflow), f64::INFINITY);
    }
}
