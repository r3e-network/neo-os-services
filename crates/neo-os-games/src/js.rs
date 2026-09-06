//! Narrow JavaScript coercion shim used by the frozen game protocol.
//!
//! Number formatting and whitespace classification come from `neo-os-core`,
//! so moving the engines out of `neo-os-compute` does not create a second
//! consensus implementation.

use neo_os_core::js_number::number_to_string;
use neo_os_core::js_value::js_trim;
use serde_json::Value as Json;

pub fn js_trim_string(value: Option<&Json>) -> String {
    match value {
        Some(value) if js_truthy(value) => js_trim(&js_stringify(value)).to_string(),
        _ => String::new(),
    }
}

fn js_truthy(value: &Json) -> bool {
    match value {
        Json::Null => false,
        Json::Bool(value) => *value,
        Json::Number(value) => value.as_f64().is_some_and(|number| number != 0.0),
        Json::String(value) => !value.is_empty(),
        Json::Array(_) | Json::Object(_) => true,
    }
}

fn js_stringify(value: &Json) -> String {
    match value {
        Json::Null => "null".to_string(),
        Json::Bool(true) => "true".to_string(),
        Json::Bool(false) => "false".to_string(),
        Json::Number(value) => number_to_string(value.as_f64().unwrap_or(0.0)),
        Json::String(value) => value.clone(),
        Json::Array(items) => js_array_join(items),
        Json::Object(_) => "[object Object]".to_string(),
    }
}

pub fn js_number_value(value: f64) -> Json {
    if !value.is_finite() {
        return Json::Null;
    }
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        Json::from(value as i64)
    } else {
        serde_json::Number::from_f64(value)
            .map(Json::Number)
            .unwrap_or(Json::Null)
    }
}

fn js_number(input: &str) -> f64 {
    let trimmed = js_trim(input);
    if trimmed.is_empty() {
        return 0.0;
    }
    let (radix, digits) = if let Some(hex) =
        trimmed.strip_prefix("0x").or(trimmed.strip_prefix("0X"))
    {
        (16u32, hex)
    } else if let Some(octal) = trimmed.strip_prefix("0o").or(trimmed.strip_prefix("0O")) {
        (8, octal)
    } else if let Some(binary) = trimmed.strip_prefix("0b").or(trimmed.strip_prefix("0B")) {
        (2, binary)
    } else {
        let (negative, rest) = match trimmed.as_bytes().first() {
            Some(b'-') => (true, &trimmed[1..]),
            Some(b'+') => (false, &trimmed[1..]),
            _ => (false, trimmed),
        };
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
    u128::from_str_radix(digits, radix).map_or(f64::NAN, |value| value as f64)
}

pub fn js_to_number(value: &Json) -> f64 {
    match value {
        Json::Null => 0.0,
        Json::Bool(true) => 1.0,
        Json::Bool(false) => 0.0,
        Json::Number(value) => value.as_f64().unwrap_or(f64::NAN),
        Json::String(value) => js_number(value),
        Json::Array(items) => js_number(&js_array_join(items)),
        Json::Object(_) => f64::NAN,
    }
}

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

pub fn js_math_round(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    let rounded = (value + 0.5).floor();
    if rounded == 0.0 && value.is_sign_negative() {
        -0.0
    } else {
        rounded
    }
}
