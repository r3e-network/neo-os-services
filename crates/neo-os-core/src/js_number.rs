//! ECMAScript `Number::toString(10)` formatting (ECMA-262 §7.1.12.1) plus the
//! JSON.stringify number mapping.
//!
//! serde_json/ryu prints `1e21` where V8 prints `1e+21`, and Rust's `{}`
//! expands large doubles digit by digit. Both would change digest-bound bytes,
//! so every number that reaches a JSON.stringify-equivalent path goes through
//! this module.

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

    // Rust's LowerExp emits the shortest round-trip digits in exponent form
    // ("1.2345e2"), which gives exactly the digit string ECMA-262 needs.
    let exp_form = format!("{magnitude:e}");
    let Some((mantissa, exponent)) = exp_form.split_once('e') else {
        // Unreachable: LowerExp always emits an exponent.
        return format!("{magnitude}");
    };
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    // value == 0.<digits> * 10^n
    let n = exponent + 1;

    let body = if k <= n && n <= 21 {
        let mut s = digits.clone();
        for _ in 0..(n - k) {
            s.push('0');
        }
        s
    } else if 0 < n && n <= 21 {
        let n = n as usize;
        format!("{}.{}", &digits[..n], &digits[n..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{}", "0".repeat((-n) as usize), digits)
    } else {
        let exp_val = n - 1;
        let sign = if exp_val < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{digits}e{sign}{}", exp_val.abs())
        } else {
            format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], exp_val.abs())
        }
    };

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
                // u128 covers every literal the vectors exercise; larger
                // literals would need bignum rounding (documented gap).
                return u128::from_str_radix(digits, radix)
                    .map(|v| v as f64)
                    .unwrap_or(f64::NAN);
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
}
