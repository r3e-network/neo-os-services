//! Deterministic JSON stringification (port of packages/shared/src/utils.js
//! `stableStringify`).
//!
//! Semantics carried over from the JS oracle (do NOT change without rotating
//! the verification scheme — live signatures were produced from these bytes):
//! - `null`/`undefined` serialize as `null` at the top level and inside
//!   arrays; object entries whose value is `undefined` are dropped;
//! - `bigint` serializes as its decimal string in quotes;
//! - object keys sort via a locale-pinned ICU collation — NOT code-unit
//!   order — matching every digest the worker has ever signed.

use std::cell::RefCell;
use std::cmp::Ordering;

use icu_collator::options::{CollatorOptions, Strength};
use icu_collator::preferences::CollationCaseFirst;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};

use crate::js_value::JsValue;

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

pub fn stable_stringify(value: &JsValue) -> String {
    let mut out = String::new();
    write_value(value, &mut out);
    out
}

fn write_value(value: &JsValue, out: &mut String) {
    match value {
        // `value === null || value === undefined` → 'null'
        JsValue::Null | JsValue::Undefined => out.push_str("null"),
        JsValue::Bool(true) => out.push_str("true"),
        JsValue::Bool(false) => out.push_str("false"),
        JsValue::Number(n) => out.push_str(&crate::js_number::json_number_to_string(*n)),
        JsValue::BigInt(v) => {
            out.push('"');
            out.push_str(v);
            out.push('"');
        }
        JsValue::Str(s) => crate::js_json::escape_string(s, out),
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
            let mut keys: Vec<(&str, &JsValue)> =
                obj.iter().filter(|(_, v)| !v.is_undefined()).collect();
            keys.sort_by(|(a, _), (b, _)| compare_keys(a, b));
            out.push('{');
            for (i, (key, val)) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                crate::js_json::escape_string(key, out);
                out.push(':');
                write_value(val, out);
            }
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js_value::JsObject;

    fn object(entries: &[(&str, JsValue)]) -> JsValue {
        let mut obj = JsObject::new();
        for (k, v) in entries {
            obj.set(*k, v.clone());
        }
        JsValue::Object(obj)
    }

    #[test]
    fn sorts_with_icu_collation_not_code_units() {
        // Code-unit order would put "ZZZ" before "a"; ICU tertiary puts the
        // lowercase letter set before uppercase at the tertiary level and
        // treats case as a tie-break inside the same letter.
        let value = object(&[
            ("zeta", JsValue::Number(1.0)),
            ("ZZZ", JsValue::Number(3.0)),
            ("a_1", JsValue::Number(2.0)),
        ]);
        let out = stable_stringify(&value);
        assert!(out.starts_with("{\"a_1\":2,"), "{out}");
    }

    #[test]
    fn scalars() {
        assert_eq!(stable_stringify(&JsValue::Null), "null");
        assert_eq!(stable_stringify(&JsValue::Undefined), "null");
        assert_eq!(stable_stringify(&JsValue::BigInt("42".into())), "\"42\"");
        assert_eq!(stable_stringify(&JsValue::Number(0.1)), "0.1");
    }
}
