//! Shared helpers for the golden-vector oracle tests.

#![allow(dead_code)]

use std::path::PathBuf;

use neo_os_core::js_value::{JsObject, JsValue};
use serde_json::Value;

pub fn vectors_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("vectors")
}

pub fn load_family(file: &str) -> Vec<Value> {
    let path = vectors_dir().join(format!("{file}.json"));
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("vector file {} unreadable: {e}", path.display()));
    let parsed: Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("vector file {file} is not valid JSON: {e}"));
    parsed
        .get("cases")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| panic!("vector file {file} has no cases array"))
}

/// Convert a vector's raw JSON into the JsValue model exactly the way the JS
/// oracle parsed it (numbers become doubles, key order preserved).
pub fn to_js(value: &Value) -> JsValue {
    JsValue::from_json(value)
}

/// Canonicalize a JsValue into a sorted-map serde_json Value with every
/// number as f64, so Rust results can be deep-compared against the vectors
/// (whose key order serde normalizes away).
pub fn canonical(value: &JsValue) -> Value {
    match value {
        JsValue::Undefined => Value::String("__undefined__".to_string()),
        JsValue::Null => Value::Null,
        JsValue::Bool(b) => Value::Bool(*b),
        JsValue::Number(n) => number_value(*n),
        JsValue::BigInt(v) => Value::String(v.clone()),
        JsValue::Str(s) => Value::String(s.clone()),
        JsValue::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        JsValue::Object(obj) => {
            let mut map = serde_json::Map::new();
            for (k, v) in obj.iter() {
                map.insert(k.to_string(), canonical(v));
            }
            Value::Object(map)
        }
    }
}

/// Canonicalize a vector JSON the same way (all numbers -> f64) so the two
/// sides compare equal for values like `7` vs `7.0`.
pub fn canonical_file(value: &Value) -> Value {
    match value {
        Value::Number(n) => number_value(n.as_f64().unwrap_or(f64::NAN)),
        Value::Array(items) => Value::Array(items.iter().map(canonical_file).collect()),
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                out.insert(k.clone(), canonical_file(v));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn number_value(n: f64) -> Value {
    serde_json::Number::from_f64(n)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

/// Build a JsObject from a vector's `keys` array with index values.
pub fn keys_object(keys: &[Value]) -> JsValue {
    let mut obj = JsObject::new();
    for (index, key) in keys.iter().enumerate() {
        let key = key.as_str().expect("collation keys are strings");
        obj.set(key, JsValue::Number(index as f64));
    }
    JsValue::Object(obj)
}
