//! The JavaScript value-model edges the ported guards are defined against:
//! `trimString`, truthiness, `String(value)` coercion and `Number(value)`.
//!
//! Mirrors `morpheus-core`'s `js_value`/`js_number` (same ECMA-262 facts) but
//! stays a local copy — the workspace rule forbids path dependencies between
//! members, and this crate needs only the small slice below.

use serde_json::Value as Json;

/// JS `\s` — differs from Rust's `char::is_whitespace` (JS includes U+FEFF,
/// excludes U+0085).
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// JS `String.prototype.trim()` — `trimString` (platform/core.js:118) is
/// `String(value || '').trim()`.
pub fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

/// `trimString(value)` over a JSON value: `value || ''` first — every falsy
/// value (`null`, `0`, `false`, `""`, absent) collapses to the empty string
/// BEFORE trimming, so `trimString(0)` is `''`, never `"0"`.
pub fn js_trim_string(value: Option<&Json>) -> String {
    match value {
        Some(value) if js_truthy(value) => js_trim(&js_stringify(value)).to_string(),
        _ => String::new(),
    }
}

/// JS truthiness over a JSON value: `undefined`/`null` are falsy, `0`/`""` are
/// falsy, every object and array is truthy.
pub fn js_truthy(value: &Json) -> bool {
    match value {
        Json::Null => false,
        Json::Bool(b) => *b,
        Json::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Json::String(s) => !s.is_empty(),
        Json::Array(_) | Json::Object(_) => true,
    }
}

/// `input.a || input.b || ''` chains resolve to the first TRUTHY value, and the
/// truthiness test runs on the raw value before any trim. Returns the first
/// truthy entry's clone, or `None` when every entry is absent or falsy.
pub fn js_first_truthy<'a>(input: &'a Json, keys: &[&str]) -> Option<&'a Json> {
    let Json::Object(map) = input else {
        return None;
    };
    keys.iter()
        .filter_map(|key| map.get(*key))
        .find(|value| js_truthy(value))
}

/// `String(value)` for the coercions the guards perform on truthy values.
/// Objects render as `'[object Object]'` (no `toString` override is possible
/// through JSON); arrays render through `Array.prototype.join` — `String([1,2])`
/// is `"1,2"` and `String([])` is `""`; numbers render exactly like JS
/// `String(number)` — shortest round-trip digits, positional between 1e-6 and
/// 1e21, exponential outside that window.
pub fn js_stringify(value: &Json) -> String {
    match value {
        Json::Null => "null".to_string(),
        Json::Bool(true) => "true".to_string(),
        Json::Bool(false) => "false".to_string(),
        Json::Number(n) => js_number_to_string(n.as_f64().unwrap_or(0.0)),
        Json::String(s) => s.clone(),
        Json::Array(items) => js_array_join(items),
        Json::Object(_) => "[object Object]".to_string(),
    }
}

/// A JSON number for an f64 the way JS would serialize it: integral values
/// (1, 0, 600) carry no decimal point. `NaN`/infinities — impossible in JSON —
/// collapse to null.
pub fn js_number_value(f: f64) -> Json {
    if !f.is_finite() {
        return Json::Null;
    }
    if f.fract() == 0.0 && f.abs() < 9.007_199_254_740_992e15 {
        serde_json::Number::from(f as i64).into()
    } else {
        serde_json::Number::from_f64(f)
            .map(Json::Number)
            .unwrap_or(Json::Null)
    }
}

/// ECMAScript `Number(value)` for string inputs — `Number.isFinite` gates every
/// caller, so the exact NaN payload never matters, only finite-vs-not.
///
/// Grammar differences that matter: `''` and whitespace-only are `0`; `0x1f`/
/// `0o17`/`0b101` are radix literals (no sign allowed); `Infinity`/`NaN` are
/// recognized ONLY in exact case, so `Number('inf')` is NaN — unlike Rust's
/// `f64::from_str`, which would happily accept it.
pub fn js_number(input: &str) -> f64 {
    let trimmed = js_trim(input);
    if trimmed.is_empty() {
        return 0.0;
    }
    // Radix literals never carry a sign in the JS grammar — `Number('-0x10')`
    // is NaN, not -16 — so the 0x/0o/0b branch is tried on the raw string
    // before any sign split.
    let (radix, digits) = if let Some(hex) =
        trimmed.strip_prefix("0x").or(trimmed.strip_prefix("0X"))
    {
        (16u32, hex)
    } else if let Some(oct) = trimmed.strip_prefix("0o").or(trimmed.strip_prefix("0O")) {
        (8, oct)
    } else if let Some(bin) = trimmed.strip_prefix("0b").or(trimmed.strip_prefix("0B")) {
        (2, bin)
    } else {
        let (negative, rest) = match trimmed.as_bytes().first() {
            Some(b'-') => (true, &trimmed[1..]),
            Some(b'+') => (false, &trimmed[1..]),
            _ => (false, trimmed),
        };
        // Exact-case Infinity/NaN carry the sign; anything else that Rust's
        // parser would take but the JS grammar would not (case-insensitive
        // inf/nan) is rejected.
        let magnitude = match rest {
            "Infinity" => f64::INFINITY,
            "NaN" => f64::NAN,
            _ => {
                let lower = rest.to_ascii_lowercase();
                if lower.contains("inf") || lower.contains("nan") {
                    return f64::NAN;
                }
                return rest.parse::<f64>().unwrap_or(f64::NAN) * if negative { -1.0 } else { 1.0 };
            }
        };
        return if negative { -magnitude } else { magnitude };
    };
    match u128::from_str_radix(digits, radix) {
        Ok(value) => value as f64,
        Err(_) => f64::NAN,
    }
}

/// ECMAScript `Number(value)` over a JSON value: primitives coerce directly,
/// strings go through [`js_number`], and arrays coerce through
/// `Array.prototype.join` (null entries render empty, single-element arrays
/// inherit the element, anything longer becomes `NaN` via the comma-joined
/// string). Plain objects are always `NaN` (`'[object Object]'`).
pub fn js_to_number(value: &Json) -> f64 {
    match value {
        Json::Null => 0.0,
        Json::Bool(true) => 1.0,
        Json::Bool(false) => 0.0,
        Json::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Json::String(s) => js_number(s),
        Json::Array(items) => js_number(&js_array_join(items)),
        Json::Object(_) => f64::NAN,
    }
}

/// `Array.prototype.join(',')` for coercion purposes: null entries render as
/// the empty string, nested arrays flatten recursively, everything else goes
/// through [`js_stringify`].
fn js_array_join(items: &[Json]) -> String {
    items
        .iter()
        .map(|item| match item {
            Json::Null => String::new(),
            Json::Array(inner) => js_array_join(inner),
            other => js_stringify(other),
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// ECMAScript `Number::toString` — the exact string JS produces for a double.
/// Rust's `LowerExp` supplies the shortest round-trip digits, then the four
/// ECMA-262 layout rules apply, keyed on the decimal-point position `n`
/// against the digit count `k`: positional with appended zeros when
/// `k ≤ n ≤ 21`, a decimal point inside the digits when `0 < n ≤ 21`, a
/// leading `0.` when `-6 < n ≤ 0`, exponential `d.ddd e±(n-1)` otherwise —
/// so `String(1e21)` is `"1e+21"` and `String(1e-7)` is `"1e-7"`.
pub fn js_number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_string();
    }
    if x == 0.0 {
        return "0".to_string();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let magnitude = x.abs();
    if magnitude.is_infinite() {
        return format!("{sign}Infinity");
    }
    let sci = format!("{magnitude:e}");
    let (mantissa, exponent) = sci.split_once('e').expect("LowerExp output carries 'e'");
    let exponent: i32 = exponent.parse().expect("LowerExp exponent is an integer");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exponent + 1;

    let mut out = String::from(sign);
    if k <= n && n <= 21 {
        out.push_str(&digits);
        for _ in 0..(n - k) {
            out.push('0');
        }
    } else if 0 < n && n <= 21 {
        let point = n as usize;
        out.push_str(&digits[..point]);
        out.push('.');
        out.push_str(&digits[point..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        for _ in 0..(-n) {
            out.push('0');
        }
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        let e = n - 1;
        if e >= 0 {
            out.push('+');
        }
        out.push_str(&e.to_string());
    }
    out
}

/// ECMAScript `Number.prototype.toFixed(f)` — exact round-half-UP on the
/// binary value (ties pick the larger n), where Rust's half-even `{:.f$}`
/// would diverge on dyadic ties (2^-13 at 12 decimals: JS prints
/// `...313`, Rust prints `...312`). Decomposes `x·10^f = m·5^f·2^(e2+f)` in
/// `i128`, shifts off the fraction and rounds by the first dropped bit.
/// Callers in this lane use `f ≤ 12`; larger `f` overflows `i128` (JS only
/// errors past 100), so that is debug-asserted.
pub fn js_to_fixed(x: f64, f: usize) -> String {
    if x.is_nan() {
        return "NaN".to_string();
    }
    if x.is_infinite() {
        return if x < 0.0 { "-Infinity" } else { "Infinity" }.to_string();
    }
    if x.abs() >= 1e21 {
        return js_number_to_string(x);
    }
    debug_assert!(f <= 12, "toFixed beyond 12 digits overflows i128 here");
    let magnitude = x.abs();
    let bits = magnitude.to_bits();
    let biased = ((bits >> 52) & 0x7ff) as i32;
    let frac = bits & 0x000f_ffff_ffff_ffff;
    let (m, e2) = if biased == 0 {
        (frac as i128, -1074i32)
    } else {
        ((frac | (1u64 << 52)) as i128, biased - 1075)
    };
    let q: i128 = m * 5i128.pow(f as u32);
    let shift: i32 = e2 + f as i32;
    let n: i128 = if shift >= 0 {
        q << shift
    } else {
        let drop = (-shift) as u32;
        let mut n = if drop < 128 { q >> drop } else { 0 };
        // Round half up: the first dropped bit decides, including exact ties.
        if drop <= 128 && (q >> (drop - 1)) & 1 == 1 {
            n += 1;
        }
        n
    };
    let digits = n.to_string();
    if f == 0 {
        if x < 0.0 {
            format!("-{digits}")
        } else {
            digits
        }
    } else {
        let mut padded = digits;
        while padded.len() < f + 1 {
            padded.insert(0, '0');
        }
        let split = padded.len() - f;
        let mut out = String::new();
        if x < 0.0 {
            out.push('-');
        }
        out.push_str(&padded[..split]);
        out.push('.');
        out.push_str(&padded[split..]);
        out
    }
}

/// ECMAScript `Math.round` — `floor(x + 0.5)`, preserving the spec's `-0`
/// result for inputs in `[-0.5, +0]` (a bare Rust `floor` would yield `+0`).
pub fn js_math_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let rounded = (x + 0.5).floor();
    if rounded == 0.0 && x.is_sign_negative() {
        -0.0
    } else {
        rounded
    }
}

/// `new Date(ms).toISOString()` — always UTC `YYYY-MM-DDTHH:MM:SS.sssZ`.
/// Years outside `0..=9999` carry an explicit sign and six digits
/// (`-000001-…` / `+275760-…`), exactly like V8.
pub fn js_iso_string_from_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let millis_of_day = ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let second_of_day = millis_of_day / 1000;
    let millis = millis_of_day % 1000;
    let (hour, minute, second) = (
        second_of_day / 3600,
        (second_of_day % 3600) / 60,
        second_of_day % 60,
    );
    if (0..=9999).contains(&year) {
        format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
    } else {
        format!(
            "{}{:06}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z",
            if year < 0 { '-' } else { '+' },
            year.abs()
        )
    }
}

/// Howard Hinnant's `civil_from_days` — inverse of the `days_from_civil`
/// used by `parse_http_date_ms`; valid for negative day counts too.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// `BigInt(string)` (ECMA-262 StringToBigInt): JS-whitespace trimmed input
/// (empty → 0n), optional sign, optional `0x`/`0X`/`0o`/`0O`/`0b`/`0B` radix
/// prefix, then plain radix digits — no underscores (`BigInt("1_0")` throws
/// even though the literal `1_0n` is legal), no decimal point, no exponent,
/// no leading-zero restriction (`BigInt("012")` is 12n). Anything else is a
/// syntax error → `None`.
pub fn js_bigint_from_string(raw: &str) -> Option<num_bigint::BigInt> {
    let trimmed = js_trim(raw);
    // BigInt("") === 0n; only the empty result of trimming is zero — "0x"
    // with no digits still throws.
    if trimmed.is_empty() {
        return Some(num_bigint::BigInt::from(0));
    }
    let (negative, rest) = match trimmed.as_bytes().first() {
        Some(b'-') => (true, &trimmed[1..]),
        Some(b'+') => (false, &trimmed[1..]),
        _ => (false, trimmed),
    };
    let (radix, digits) =
        if let Some(hex) = rest.strip_prefix("0x").or_else(|| rest.strip_prefix("0X")) {
            (16u32, hex)
        } else if let Some(oct) = rest.strip_prefix("0o").or_else(|| rest.strip_prefix("0O")) {
            (8, oct)
        } else if let Some(bin) = rest.strip_prefix("0b").or_else(|| rest.strip_prefix("0B")) {
            (2, bin)
        } else {
            (10, rest)
        };
    if digits.is_empty() {
        return None;
    }
    let valid = digits.bytes().all(|byte| match radix {
        16 => byte.is_ascii_hexdigit(),
        10 => byte.is_ascii_digit(),
        8 => (b'0'..=b'7').contains(&byte),
        _ => byte == b'0' || byte == b'1',
    });
    if !valid {
        return None;
    }
    let parsed = num_bigint::BigInt::parse_bytes(digits.as_bytes(), radix)?;
    Some(if negative { -parsed } else { parsed })
}

/// `Buffer.from(str, 'hex')` — Node decodes leading valid pairs and stops at
/// the first invalid character; a dangling odd character is ignored.
pub fn hex_decode_stop_at_invalid(input: &str) -> Vec<u8> {
    fn hex_value(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut index = 0;
    while index + 1 < bytes.len() {
        match (hex_value(bytes[index]), hex_value(bytes[index + 1])) {
            (Some(high), Some(low)) => {
                out.push(high * 16 + low);
                index += 2;
            }
            _ => break,
        }
    }
    out
}

/// JS object spread `{...value}`: objects copy entries in insertion order,
/// arrays and strings copy their iterated indices as string keys (`{...'ab'}`
/// is `{ "0": "a", "1": "b" }`), every other value (null, numbers, booleans)
/// produces an empty object.
pub fn js_object_spread(value: &Json) -> serde_json::Map<String, Json> {
    match value {
        Json::Object(map) => map.clone(),
        Json::Array(items) => items
            .iter()
            .enumerate()
            .map(|(index, item)| (index.to_string(), item.clone()))
            .collect(),
        Json::String(text) => text
            .chars()
            .enumerate()
            .map(|(index, ch)| (index.to_string(), Json::String(ch.to_string())))
            .collect(),
        _ => serde_json::Map::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn truthiness_matches_js() {
        assert!(!js_truthy(&Json::Null));
        assert!(!js_truthy(&json!(0)));
        assert!(!js_truthy(&json!("")));
        assert!(js_truthy(&json!("   "))); // non-empty string IS truthy in JS
        assert!(js_truthy(&json!(0.5)));
        assert!(js_truthy(&json!("0")));
        assert!(!js_truthy(&Json::Bool(false)));
    }

    #[test]
    fn first_truthy_skips_falsy_but_present_keys() {
        let input = json!({ "a": "", "b": "x" });
        assert_eq!(
            js_first_truthy(&input, &["a", "b"]).cloned(),
            Some(json!("x"))
        );
        assert_eq!(js_first_truthy(&input, &["a"]), None);
        assert_eq!(js_first_truthy(&json!(null), &["a"]), None);
    }

    #[test]
    fn number_parses_the_js_grammar() {
        assert_eq!(js_number(""), 0.0);
        assert_eq!(js_number("  4 "), 4.0);
        assert_eq!(js_number("2.9"), 2.9);
        assert!(js_number("abc").is_nan());
        assert!(js_number("inf").is_nan());
        assert_eq!(js_number("Infinity"), f64::INFINITY);
        assert_eq!(js_number("-Infinity"), f64::NEG_INFINITY);
        assert_eq!(js_number("0x10"), 16.0);
        assert!(js_number("-0x10").is_nan());
        assert_eq!(js_number("0"), 0.0);
        assert_eq!(js_number("-3.5"), -3.5);
    }

    #[test]
    fn number_value_serializes_like_json_stringify() {
        assert_eq!(js_number_value(1.0).to_string(), "1");
        assert_eq!(js_number_value(0.5).to_string(), "0.5");
        assert_eq!(js_number_value(600.0).to_string(), "600");
    }

    #[test]
    fn number_to_string_matches_the_ecma_layout_rules() {
        assert_eq!(js_number_to_string(0.0), "0");
        assert_eq!(js_number_to_string(-0.0), "0");
        assert_eq!(js_number_to_string(f64::NAN), "NaN");
        assert_eq!(js_number_to_string(f64::INFINITY), "Infinity");
        assert_eq!(js_number_to_string(f64::NEG_INFINITY), "-Infinity");
        assert_eq!(js_number_to_string(123.456), "123.456");
        assert_eq!(js_number_to_string(0.1), "0.1");
        assert_eq!(js_number_to_string(-2.5), "-2.5");
        assert_eq!(js_number_to_string(1e-6), "0.000001");
        assert_eq!(js_number_to_string(1e-7), "1e-7");
        assert_eq!(js_number_to_string(1e20), "100000000000000000000");
        assert_eq!(js_number_to_string(1e21), "1e+21");
        assert_eq!(js_number_to_string(5e-324), "5e-324");
        assert_eq!(
            js_number_to_string(1.7976931348623157e308),
            "1.7976931348623157e+308"
        );
    }

    #[test]
    fn stringify_renders_numbers_like_js_string() {
        assert_eq!(js_stringify(&json!(600)), "600");
        assert_eq!(js_stringify(&json!(0.1)), "0.1");
        assert_eq!(js_stringify(&json!(1e21)), "1e+21");
        assert_eq!(js_stringify(&json!(1e-7)), "1e-7");
        assert_eq!(js_stringify(&json!([1, 2])), "1,2"); // Array.prototype.join
        assert_eq!(js_stringify(&json!([null, "x"])), ",x");
        assert_eq!(js_stringify(&json!([])), "");
        assert_eq!(js_stringify(&json!({ "a": 1 })), "[object Object]");
    }

    #[test]
    fn to_number_coerces_like_number_value() {
        assert_eq!(js_to_number(&Json::Null), 0.0);
        assert_eq!(js_to_number(&json!(true)), 1.0);
        assert_eq!(js_to_number(&json!("2.9")), 2.9);
        assert_eq!(js_to_number(&json!("")), 0.0);
        assert_eq!(js_to_number(&json!("0x10")), 16.0);
        assert_eq!(js_to_number(&json!("Infinity")), f64::INFINITY);
        assert_eq!(js_to_number(&json!([])), 0.0);
        assert_eq!(js_to_number(&json!([1])), 1.0);
        assert_eq!(js_to_number(&json!([null])), 0.0); // join renders null as ""
        assert!(js_to_number(&json!([1, 2])).is_nan());
        assert!(js_to_number(&json!([true])).is_nan());
        assert!(js_to_number(&json!({})).is_nan());
    }

    #[test]
    fn to_fixed_rounds_half_up_on_the_binary_value() {
        assert_eq!(js_to_fixed(0.0, 2), "0.00");
        assert_eq!(js_to_fixed(0.5, 0), "1"); // ties pick the larger n
        assert_eq!(js_to_fixed(1.5, 0), "2");
        assert_eq!(js_to_fixed(2.5, 0), "3");
        assert_eq!(js_to_fixed(0.125, 2), "0.13");
        // 2^-13 sits exactly on a rounding tie at 12 decimals; half-up (JS)
        // yields ...313, Rust's half-even `{:.12}` would print ...312.
        assert_eq!(js_to_fixed(2f64.powi(-13), 12), "0.000122070313");
        assert_eq!(js_to_fixed(0.1, 12), "0.100000000000");
        assert_eq!(js_to_fixed(100.0, 12), "100.000000000000");
        assert_eq!(js_to_fixed(-0.4, 2), "-0.40");
        assert_eq!(js_to_fixed(-0.0, 2), "0.00"); // -0 loses its sign
        assert_eq!(js_to_fixed(-2.5, 0), "-3");
        assert_eq!(js_to_fixed(f64::NAN, 2), "NaN");
        assert_eq!(js_to_fixed(1e21, 2), "1e+21"); // >= 1e21 falls back to String
    }

    #[test]
    fn math_round_is_floor_of_half_with_negative_zero() {
        assert_eq!(js_math_round(2.5), 3.0);
        assert_eq!(js_math_round(2.4), 2.0);
        assert_eq!(js_math_round(-2.5), -2.0);
        assert_eq!(js_math_round(-0.7), -1.0);
        let zero = js_math_round(0.4);
        assert_eq!(zero, 0.0);
        assert!(zero.is_sign_positive());
        let neg_zero = js_math_round(-0.4);
        assert_eq!(neg_zero, 0.0);
        assert!(neg_zero.is_sign_negative());
        assert!(js_math_round(-0.0).is_sign_negative());
    }

    #[test]
    fn iso_string_matches_new_date_to_iso_string() {
        assert_eq!(js_iso_string_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(js_iso_string_from_ms(1), "1970-01-01T00:00:00.001Z");
        assert_eq!(js_iso_string_from_ms(-1), "1969-12-31T23:59:59.999Z");
        assert_eq!(
            js_iso_string_from_ms(1_736_951_400_000),
            "2025-01-15T14:30:00.000Z"
        );
        // Leap-year and year boundaries.
        assert_eq!(
            js_iso_string_from_ms(951_782_400_000),
            "2000-02-29T00:00:00.000Z"
        );
        assert_eq!(
            js_iso_string_from_ms(4_102_444_799_999),
            "2099-12-31T23:59:59.999Z"
        );
        assert_eq!(
            js_iso_string_from_ms(4_102_444_800_000),
            "2100-01-01T00:00:00.000Z"
        );
        assert_eq!(
            js_iso_string_from_ms(253_402_300_799_999),
            "9999-12-31T23:59:59.999Z"
        );
        assert_eq!(
            js_iso_string_from_ms(253_402_300_800_000),
            "+010000-01-01T00:00:00.000Z"
        );
        // One ms before 0000-01-01T00:00:00Z crosses into the signed-year form.
        assert_eq!(
            js_iso_string_from_ms(-62_167_219_200_000),
            "0000-01-01T00:00:00.000Z"
        );
        assert_eq!(
            js_iso_string_from_ms(-62_167_219_200_001),
            "-000001-12-31T23:59:59.999Z"
        );
    }

    #[test]
    fn bigint_string_grammar_is_stringtobigint() {
        // The StringToBigInt grammar, not the stricter literal grammar: leading
        // decimal zeros are fine, underscore separators are not.
        assert_eq!(js_bigint_from_string("012").unwrap().to_string(), "12");
        assert!(js_bigint_from_string("1_0").is_none());
        assert!(js_bigint_from_string("_10").is_none());
        assert!(js_bigint_from_string("1_").is_none());
        assert_eq!(js_bigint_from_string("0x1F").unwrap().to_string(), "31");
        assert_eq!(js_bigint_from_string("0Xff").unwrap().to_string(), "255");
        assert_eq!(js_bigint_from_string("0b101").unwrap().to_string(), "5");
        assert_eq!(js_bigint_from_string("0o17").unwrap().to_string(), "15");
        assert!(js_bigint_from_string("0x").is_none());
        assert!(js_bigint_from_string("1e3").is_none());
        assert!(js_bigint_from_string("١٢").is_none());
        // Trimming is part of BigInt(string), and "" is 0n — not an error.
        assert_eq!(js_bigint_from_string("  5  ").unwrap().to_string(), "5");
        assert_eq!(js_bigint_from_string("\t+5\n").unwrap().to_string(), "5");
        assert_eq!(js_bigint_from_string("").unwrap().to_string(), "0");
        assert_eq!(js_bigint_from_string("\u{feff}7").unwrap().to_string(), "7");
        // U+0085 is not JS whitespace — BigInt('\u0085') throws.
        assert!(js_bigint_from_string("\u{85}5").is_none());
        assert_eq!(js_bigint_from_string("-42").unwrap().to_string(), "-42");
        assert_eq!(js_bigint_from_string("+42").unwrap().to_string(), "42");
        assert!(js_bigint_from_string("- 42").is_none());
        // A huge value stays exact.
        assert_eq!(
            js_bigint_from_string(&"9".repeat(400)).unwrap().to_string(),
            "9".repeat(400)
        );
    }

    #[test]
    fn hex_decode_is_node_lenient() {
        assert_eq!(
            hex_decode_stop_at_invalid("deadbeef"),
            vec![0xde, 0xad, 0xbe, 0xef]
        );
        assert_eq!(
            hex_decode_stop_at_invalid("DEADBEEF"),
            vec![0xde, 0xad, 0xbe, 0xef]
        );
        assert_eq!(hex_decode_stop_at_invalid("abc"), vec![0xab]);
        assert_eq!(hex_decode_stop_at_invalid("xy"), Vec::<u8>::new());
        assert_eq!(hex_decode_stop_at_invalid("abzz"), vec![0xab]);
        assert_eq!(hex_decode_stop_at_invalid(""), Vec::<u8>::new());
    }

    #[test]
    fn object_spread_is_js_spread() {
        let object = json!({ "b": 2, "a": 1 });
        let spread = Json::Object(js_object_spread(&object));
        assert_eq!(spread["b"], 2);
        assert_eq!(spread["a"], 1);
        let keys: Vec<&String> = spread.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["b", "a"]); // insertion order preserved

        // Arrays spread their indices; so do strings (they're iterable).
        assert_eq!(
            Json::Object(js_object_spread(&json!(["x", "y"]))),
            json!({ "0": "x", "1": "y" })
        );
        assert_eq!(
            Json::Object(js_object_spread(&json!("ab"))),
            json!({ "0": "a", "1": "b" })
        );
        assert_eq!(Json::Object(js_object_spread(&Json::Null)), json!({}));
        assert_eq!(Json::Object(js_object_spread(&json!(5))), json!({}));
        assert_eq!(Json::Object(js_object_spread(&json!(true))), json!({}));
    }
}
