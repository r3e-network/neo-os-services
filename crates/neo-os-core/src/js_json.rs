//! `JSON.stringify` semantics over `JsValue` (ECMA-262 §25.5.2).
//!
//! Divergences from a naive `serde_json::to_string`:
//! - object entries whose value is `undefined` are DROPPED;
//! - array elements that are `undefined` serialize as `null`;
//! - NaN/Infinity serialize as `null`;
//! - key order is insertion order (never sorted).

use crate::js_value::JsValue;

/// `Err` mirrors JSON.stringify throwing: it throws on BigInt values and
/// returns `undefined` (modelled here as `None`) for a top-level `undefined`.
pub fn stringify(value: &JsValue) -> Result<Option<String>, &'static str> {
    match value {
        JsValue::Undefined => Ok(None),
        JsValue::BigInt(_) => Err("JSON.stringify cannot serialize a BigInt"),
        _ => {
            let mut out = String::new();
            write_value(value, &mut out);
            Ok(Some(out))
        }
    }
}

/// `Buffer.byteLength(JSON.stringify(value), 'utf8')` with the relayer's
/// try/catch: unserializable values measure as infinity.
pub fn measure_bytes(value: &JsValue) -> usize {
    match stringify(value) {
        Ok(Some(text)) => text.len(),
        _ => usize::MAX,
    }
}

fn write_value(value: &JsValue, out: &mut String) {
    match value {
        JsValue::Undefined | JsValue::Null => out.push_str("null"),
        JsValue::Bool(true) => out.push_str("true"),
        JsValue::Bool(false) => out.push_str("false"),
        JsValue::Number(n) => out.push_str(&crate::js_number::json_number_to_string(*n)),
        // BigInt cannot reach here: stringify() rejects it up front.
        JsValue::BigInt(_) => out.push_str("null"),
        JsValue::Str(s) => escape_string(s, out),
        JsValue::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(item, out);
            }
            out.push(']');
        }
        JsValue::Object(obj) => {
            out.push('{');
            let mut first = true;
            for (key, val) in obj.iter() {
                if val.is_undefined() {
                    continue;
                }
                if !first {
                    out.push(',');
                }
                first = false;
                escape_string(key, out);
                out.push(':');
                write_value(val, out);
            }
            out.push('}');
        }
    }
}

/// JSON string escaping exactly as ECMAScript does: `"` and `\` plus the five
/// named control escapes; other C0 controls as `\u00xx` (lowercase). DEL and
/// all non-ASCII characters pass through unescaped.
pub fn escape_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js_value::{JsObject, JsValue};

    #[test]
    fn object_semantics() {
        let mut obj = JsObject::new();
        obj.set("b", JsValue::Number(1.0));
        obj.set("a", JsValue::Str("x".into()));
        obj.set("skip", JsValue::Undefined);
        let value = JsValue::Object(obj);
        assert_eq!(
            stringify(&value).unwrap().as_deref(),
            Some(r#"{"b":1,"a":"x"}"#)
        );
    }

    #[test]
    fn array_and_specials() {
        let value = JsValue::Array(vec![
            JsValue::Undefined,
            JsValue::Null,
            JsValue::Number(f64::NAN),
            JsValue::Number(1e21),
        ]);
        assert_eq!(
            stringify(&value).unwrap().as_deref(),
            Some("[null,null,null,1e+21]")
        );
    }

    #[test]
    fn control_escape() {
        let value = JsValue::Str("a\u{1}b\u{7f}cé".into());
        assert_eq!(
            stringify(&value).unwrap().as_deref(),
            Some("\"a\\u0001b\u{7f}cé\"")
        );
    }
}
