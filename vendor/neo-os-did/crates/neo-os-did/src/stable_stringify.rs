//! Deterministic JSON stringification over `serde_json::Value` — the same
//! semantics as neo-os-core's JsValue port and the JS `stableStringify`
//! oracle (packages/shared/src/utils.js):
//! - object keys sort under an ICU 'en' tertiary collation (caseFirst false),
//!   NOT code-unit order — matching every digest the worker has ever signed;
//! - serde_json has no `undefined` variant, so every `Value` serializes;
//!   callers model JS-undefined entries by omitting them from the map.
//! - bigints have no `Value` variant; their stable form is a quoted decimal
//!   string, so callers pass them pre-stringified.

use std::cell::RefCell;
use std::cmp::Ordering;

use icu_collator::options::{CollatorOptions, Strength};
use icu_collator::preferences::CollationCaseFirst;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};
use serde_json::Value as Json;

use crate::js::js_number_to_string;

thread_local! {
    // CollatorBorrowed is not Sync (its payload types are internally
    // non-Sync), so instead of a global OnceLock each thread lazily builds
    // its own from the baked provider — construction is just pointer setup
    // and every consumer builds identical tables, so results are
    // deterministic across threads.
    static COLLATOR: RefCell<Option<CollatorBorrowed<'static>>> = const { RefCell::new(None) };
}

/// `Intl.Collator('en', { sensitivity: 'variant', caseFirst: 'false' })`:
/// tertiary strength (variant = full tertiary differences) with no case
/// reordering. CLDR has no `en` collation tailoring beyond root, so the root
/// compiled-data tables decide; a failed `en` lookup falls back to root.
fn init_collator() -> CollatorBorrowed<'static> {
    let mut prefs: CollatorPreferences = icu_locale_core::locale!("en").into();
    prefs.case_first = Some(CollationCaseFirst::False);
    let mut options = CollatorOptions::default();
    options.strength = Some(Strength::Tertiary);
    Collator::try_new(prefs, options)
        .expect("ICU collation compiled data for 'en' must be available")
}

/// The comparator the JS `Array.prototype.sort` used. JS sorts are stable and
/// so is Rust's `sort_by`, so ties keep insertion order on both sides.
pub fn compare_keys(a: &str, b: &str) -> Ordering {
    COLLATOR.with(|slot| {
        let mut slot = slot.borrow_mut();
        let collator = slot.get_or_insert_with(init_collator);
        collator.compare(a, b)
    })
}

pub fn stable_stringify(value: &Json) -> String {
    let mut out = String::new();
    write_value(value, &mut out);
    out
}

fn write_value(value: &Json, out: &mut String) {
    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(true) => out.push_str("true"),
        Json::Bool(false) => out.push_str("false"),
        Json::Number(n) => out.push_str(&js_number_to_string(n.as_f64().unwrap_or(0.0))),
        Json::String(s) => escape_string(s, out),
        Json::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(item, out);
            }
            out.push(']');
        }
        Json::Object(obj) => {
            let mut keys: Vec<(&String, &Json)> = obj.iter().collect();
            keys.sort_by(|(a, _), (b, _)| compare_keys(a, b));
            out.push('{');
            for (i, (key, val)) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
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
fn escape_string(s: &str, out: &mut String) {
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
    use serde_json::Map;

    /// Decode the Phase-0 golden vectors (`__t`-tagged) into serde_json
    /// values. `bigint` maps to `Json::String` because stableStringify emits
    /// bigints as quoted decimal strings, so the output bytes are identical.
    /// `undefined` maps to `Json::Null` (top level and in arrays); object
    /// entries tagged undefined are dropped to model JS-undefined keys.
    fn tagged_to_json(input: &Json) -> Option<Json> {
        let tag = input.get("__t")?.as_str()?;
        match tag {
            "null" | "undefined" => Some(Json::Null),
            "bool" | "string" => input.get("v").cloned(),
            "number" => {
                let raw = input.get("v")?.as_str()?;
                if raw == "null" {
                    return Some(Json::Null);
                }
                Some(Json::from(raw.parse::<f64>().ok()?))
            }
            "bigint" => Some(Json::String(input.get("v")?.as_str()?.to_string())),
            "array" => {
                let items = input.get("v")?.as_array()?;
                Some(Json::Array(
                    items.iter().filter_map(tagged_to_json).collect(),
                ))
            }
            "object" => {
                let entries = input.get("v")?.as_object()?;
                let mut map = Map::new();
                for (key, value) in entries {
                    if value.get("__t").and_then(Json::as_str) == Some("undefined") {
                        continue;
                    }
                    map.insert(key.clone(), tagged_to_json(value)?);
                }
                Some(Json::Object(map))
            }
            _ => None,
        }
    }

    #[test]
    fn golden_vectors_match_the_js_oracle() {
        let raw = include_str!("../tests/vectors/stable_stringify.json");
        let document: Json = serde_json::from_str(raw).expect("vector file parses");
        let cases = document
            .get("cases")
            .and_then(Json::as_array)
            .expect("cases array");
        assert!(!cases.is_empty());
        for case in cases {
            let name = case.get("name").and_then(Json::as_str).unwrap_or("");
            let input = case.get("input").expect("case input");
            let expected = case
                .get("expected")
                .and_then(Json::as_str)
                .expect("expected string");
            let value =
                tagged_to_json(input).unwrap_or_else(|| panic!("case {name} is representable"));
            assert_eq!(stable_stringify(&value), expected, "case {name}");
        }
    }

    #[test]
    fn mixed_case_keys_use_icu_collation_not_code_units() {
        // Code-unit order would put "ZZZ" before "a"; ICU tertiary puts the
        // lowercase letter set before uppercase at the tertiary level and
        // treats case as a tie-break inside the same letter.
        let mut obj = Map::new();
        obj.insert("zeta".into(), Json::from(1));
        obj.insert("ZZZ".into(), Json::from(3));
        obj.insert("a_1".into(), Json::from(2));
        let out = stable_stringify(&Json::Object(obj));
        assert!(out.starts_with("{\"a_1\":2,"), "{out}");
    }
}
