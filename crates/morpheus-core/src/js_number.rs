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
