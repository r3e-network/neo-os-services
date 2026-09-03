//! The JavaScript value model the consensus paths are defined against.
//!
//! Object key ORDER is part of the signed bytes: `JSON.stringify` and object
//! spread both preserve insertion order, so `JsObject` is a `Vec` of entries
//! where re-assigning an existing key replaces the value but keeps the
//! original position — exactly V8's property-order semantics for string keys.

use serde_json::Value as Json;

use crate::js_number::number_to_string;
use crate::CoreResult;

/// JS `\s` character class — differs from Rust's `char::is_whitespace`
/// (JS includes U+FEFF, excludes U+0085), and the difference is observable in
/// `trimString`/`normalizeRequestType` outputs.
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// JS `String.prototype.trim()` over the JS whitespace set.
pub fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

#[derive(Debug, Clone, PartialEq)]
pub enum JsValue {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    /// `v` is the decimal digit string (never signed; BigInt inputs are
    /// non-negative in every consensus path).
    BigInt(String),
    Str(String),
    Array(Vec<JsValue>),
    Object(JsObject),
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct JsObject {
    entries: Vec<(String, JsValue)>,
}

impl JsObject {
    pub fn new() -> Self {
        JsObject {
            entries: Vec::new(),
        }
    }

    pub fn get(&self, key: &str) -> Option<&JsValue> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// Assign like `{...obj, key: value}`: an existing key keeps its position,
    /// a new key is appended.
    pub fn set(&mut self, key: impl Into<String>, value: JsValue) {
        let key = key.into();
        if let Some(slot) = self.entries.iter_mut().find(|(k, _)| *k == key) {
            slot.1 = value;
        } else {
            self.entries.push((key, value));
        }
    }

    pub fn remove(&mut self, key: &str) {
        self.entries.retain(|(k, _)| k != key);
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &JsValue)> {
        self.entries.iter().map(|(k, v)| (k.as_str(), v))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.entries.iter().any(|(k, _)| k == key)
    }
}

impl JsValue {
    /// JS `typeof` (note: `typeof null === 'object'`).
    pub fn type_of(&self) -> &'static str {
        match self {
            JsValue::Undefined => "undefined",
            JsValue::Null | JsValue::Object(_) | JsValue::Array(_) => "object",
            JsValue::Bool(_) => "boolean",
            JsValue::Number(_) => "number",
            JsValue::BigInt(_) => "bigint",
            JsValue::Str(_) => "string",
        }
    }

    pub fn is_undefined(&self) -> bool {
        matches!(self, JsValue::Undefined)
    }

    /// JS truthiness.
    pub fn truthy(&self) -> bool {
        match self {
            JsValue::Undefined | JsValue::Null => false,
            JsValue::Bool(b) => *b,
            JsValue::Number(n) => *n != 0.0 && !n.is_nan(),
            JsValue::BigInt(v) => v != "0",
            JsValue::Str(s) => !s.is_empty(),
            JsValue::Array(_) | JsValue::Object(_) => true,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            JsValue::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&JsObject> {
        match self {
            JsValue::Object(o) => Some(o),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[JsValue]> {
        match self {
            JsValue::Array(items) => Some(items),
            _ => None,
        }
    }

    /// ECMAScript ToString for the value shapes reachable from parsed JSON and
    /// the tagged vector encodings.
    pub fn to_string_js(&self) -> CoreResult<String> {
        Ok(match self {
            JsValue::Undefined => "undefined".to_string(),
            JsValue::Null => "null".to_string(),
            JsValue::Bool(true) => "true".to_string(),
            JsValue::Bool(false) => "false".to_string(),
            JsValue::Number(n) => number_to_string(*n),
            JsValue::BigInt(v) => v.clone(),
            JsValue::Str(s) => s.clone(),
            // Array.prototype.toString joins elements; used only by pathological
            // paths the vectors do not exercise — fail closed rather than
            // reproduce it imprecisely.
            JsValue::Array(_) | JsValue::Object(_) => {
                return Err(crate::CoreError::new(
                    "js: ToString of an array/object is not supported here",
                ))
            }
        })
    }

    /// Convert a `serde_json::Value` with JSON.parse semantics: numbers become
    /// doubles (JS has only f64) and object key order is preserved.
    pub fn from_json(value: &Json) -> JsValue {
        match value {
            Json::Null => JsValue::Null,
            Json::Bool(b) => JsValue::Bool(*b),
            Json::Number(n) => JsValue::Number(n.as_f64().unwrap_or(f64::NAN)),
            Json::String(s) => JsValue::Str(s.clone()),
            Json::Array(items) => JsValue::Array(items.iter().map(JsValue::from_json).collect()),
            Json::Object(map) => {
                let mut obj = JsObject::new();
                for (k, v) in map {
                    obj.set(k.clone(), JsValue::from_json(v));
                }
                JsValue::Object(obj)
            }
        }
    }

    /// Decode the exporter's tagged-scalar encoding:
    /// `{__t:'undefined'|'null'|'bool'|'number'|'bigint'|'string'|'array'|'object'}`.
    /// `number` carries the JSON.stringify form, so `1e+21` round-trips.
    pub fn from_tagged(value: &Json) -> JsValue {
        let Some(tag) = value.get("__t").and_then(Json::as_str) else {
            return JsValue::from_json(value);
        };
        match tag {
            "undefined" => JsValue::Undefined,
            "null" => JsValue::Null,
            "bool" => JsValue::Bool(value.get("v").and_then(Json::as_bool).unwrap_or(false)),
            "number" => {
                let raw = value.get("v").and_then(Json::as_str).unwrap_or("null");
                if raw == "null" {
                    JsValue::Number(f64::NAN)
                } else {
                    // ECMAScript number literals parse cleanly as f64.
                    JsValue::Number(raw.parse::<f64>().unwrap_or(f64::NAN))
                }
            }
            "bigint" => JsValue::BigInt(
                value
                    .get("v")
                    .and_then(Json::as_str)
                    .unwrap_or("0")
                    .to_string(),
            ),
            "string" => JsValue::Str(
                value
                    .get("v")
                    .and_then(Json::as_str)
                    .unwrap_or_default()
                    .to_string(),
            ),
            "array" => JsValue::Array(
                value
                    .get("v")
                    .and_then(Json::as_array)
                    .map(|items| items.iter().map(JsValue::from_tagged).collect())
                    .unwrap_or_default(),
            ),
            "object" => {
                let mut obj = JsObject::new();
                if let Some(map) = value.get("v").and_then(Json::as_object) {
                    for (k, v) in map {
                        obj.set(k.clone(), JsValue::from_tagged(v));
                    }
                }
                JsValue::Object(obj)
            }
            _ => JsValue::from_json(value),
        }
    }

    /// Re-encode into the exporter's tagged form so tests can deep-compare
    /// against the committed vectors.
    pub fn to_tagged(&self) -> Json {
        match self {
            JsValue::Undefined => serde_json::json!({ "__t": "undefined" }),
            JsValue::Null => serde_json::json!({ "__t": "null" }),
            JsValue::Bool(b) => serde_json::json!({ "__t": "bool", "v": b }),
            JsValue::Number(n) => {
                serde_json::json!({ "__t": "number", "v": crate::js_number::json_number_to_string(*n) })
            }
            JsValue::BigInt(v) => serde_json::json!({ "__t": "bigint", "v": v }),
            JsValue::Str(s) => serde_json::json!({ "__t": "string", "v": s }),
            JsValue::Array(items) => {
                serde_json::json!({ "__t": "array", "v": items.iter().map(JsValue::to_tagged).collect::<Vec<_>>() })
            }
            JsValue::Object(obj) => {
                let mut map = serde_json::Map::new();
                for (k, v) in obj.iter() {
                    map.insert(k.to_string(), v.to_tagged());
                }
                serde_json::json!({ "__t": "object", "v": map })
            }
        }
    }
}
