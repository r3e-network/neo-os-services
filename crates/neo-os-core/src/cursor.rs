//! Chain-cursor safety logic (port of
//! workers/morpheus-relayer/src/chain-cursor.js): the request-cursor floor,
//! retry-queue pruning below the floor, and the block-cursor start
//! resolution that refuses to silently reset to genesis.

use crate::js_number::number_of as js_number_of_value;
use crate::js_json;
use crate::js_value::JsValue;

/// Port of `getRequestCursorFloor`: a configured start request id counts only
/// when it is a finite number > 0 (NaN/null/0/undefined all mean "tail").
pub fn get_request_cursor_floor(start_request_id: &JsValue) -> Option<f64> {
    let raw = js_number_of_value(start_request_id);
    if raw.is_finite() && raw > 0.0 {
        Some(raw)
    } else {
        None
    }
}

/// Port of `pruneRetryQueueBelowRequestFloor`: drop queued retries whose
/// event requestId parses below the floor. Non-finite request ids are KEPT
/// (`!Number.isFinite` passes), because a garbage id must not silently
/// discard a queued retry. Returns the number of pruned items.
pub fn prune_retry_queue_below_request_floor(
    chain_state: &mut crate::js_value::JsObject,
    min_request_id: Option<f64>,
) -> usize {
    let Some(floor) = min_request_id else {
        return 0;
    };
    let Some(queue) = chain_state.get("retry_queue").and_then(|v| v.as_array()) else {
        return 0;
    };
    let before = queue.len();
    let kept: Vec<JsValue> = queue
        .iter()
        .filter(|item| {
            let request_id = item
                .as_object()
                .and_then(|obj| obj.get("event"))
                .and_then(|event| event.as_object())
                .and_then(|event| event.get("requestId"))
                .cloned()
                .unwrap_or(JsValue::Undefined);
            // JS: Number(item?.event?.requestId || 0) — falsy → 0.
            let raw = if request_id.truthy() {
                js_number_of_value(&request_id)
            } else {
                0.0
            };
            !raw.is_finite() || raw >= floor
        })
        .cloned()
        .collect();
    let pruned = before - kept.len();
    chain_state.set("retry_queue", JsValue::Array(kept));
    pruned
}

/// Port of `resolveChainFromBlock`: the next block to scan. Errors carry the
/// EXACT JS message strings (the vectors pin them) because operators paste
/// them into incident reports.
pub fn resolve_chain_from_block(
    chain: &str,
    configured_start: &JsValue,
    last_block_raw: &JsValue,
    confirmed_tip: f64,
) -> Result<f64, String> {
    // JS: Math.max(configuredStart ?? 0, 0) — nullish coalescing, not ||.
    let configured_number = match configured_start {
        JsValue::Undefined | JsValue::Null => 0.0,
        other => js_number_of_value(other),
    };
    let default_start = if configured_number.is_nan() {
        f64::NAN
    } else {
        configured_number.max(0.0)
    };

    if matches!(last_block_raw, JsValue::Null | JsValue::Undefined) {
        return Ok(default_start);
    }

    let last_block = js_number_of_value(last_block_raw);
    if !last_block.is_finite() || last_block < -1.0 {
        return Err(format!(
            "Invalid relayer checkpoint for {chain}: {}. Refusing to reset to genesis ({}).",
            json_stringify_or_undefined(last_block_raw),
            js_render(default_start)
        ));
    }

    if last_block > confirmed_tip {
        return Err(format!(
            "Relayer checkpoint for {chain} ({}) is ahead of the confirmed tip ({}). Refusing to reset to genesis ({}).",
            js_render(last_block),
            js_render(confirmed_tip),
            js_render(default_start)
        ));
    }

    Ok(last_block + 1.0)
}

/// `${value}` of JSON.stringify(value) — strings quote, NaN renders `null`,
/// undefined renders the literal text `undefined`.
fn json_stringify_or_undefined(value: &JsValue) -> String {
    match js_json::stringify(value) {
        Ok(Some(s)) => s,
        _ => "undefined".to_string(),
    }
}

/// `${number}` interpolation (ECMAScript ToString).
fn js_render(x: f64) -> String {
    crate::js_number::number_to_string(x)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floor_requires_finite_positive() {
        assert_eq!(get_request_cursor_floor(&JsValue::Number(123.0)), Some(123.0));
        assert_eq!(get_request_cursor_floor(&JsValue::Str("456".to_string())), Some(456.0));
        assert_eq!(get_request_cursor_floor(&JsValue::Null), None);
        assert_eq!(get_request_cursor_floor(&JsValue::Number(0.0)), None);
        assert_eq!(get_request_cursor_floor(&JsValue::Number(f64::NAN)), None);
        assert_eq!(get_request_cursor_floor(&JsValue::Undefined), None);
    }

    #[test]
    fn prune_keeps_nonfinite_ids_and_drops_below_floor() {
        let make_item = |id: &str| {
            let mut event = crate::js_value::JsObject::new();
            event.set("requestId", JsValue::Str(id.to_string()));
            let mut item = crate::js_value::JsObject::new();
            item.set("event", JsValue::Object(event));
            JsValue::Object(item)
        };
        let mut obj = crate::js_value::JsObject::new();
        obj.set(
            "retry_queue",
            JsValue::Array(vec![
                make_item("abc"),
                make_item("10"),
                make_item("20"),
            ]),
        );
        let pruned = prune_retry_queue_below_request_floor(&mut obj, Some(15.0));
        assert_eq!(pruned, 1);
        let queue = obj.get("retry_queue").unwrap().as_array().unwrap();
        assert_eq!(queue.len(), 2);
        assert_eq!(
            queue[0].as_object().unwrap().get("event").unwrap().as_object().unwrap().get("requestId"),
            Some(&JsValue::Str("abc".to_string()))
        );
    }

    #[test]
    fn floor_none_prunes_nothing() {
        let mut obj = crate::js_value::JsObject::new();
        obj.set("retry_queue", JsValue::Array(vec![JsValue::Null]));
        assert_eq!(prune_retry_queue_below_request_floor(&mut obj, None), 0);
        assert_eq!(obj.get("retry_queue").unwrap().as_array().unwrap().len(), 1);
    }

    #[test]
    fn resolve_chain_starts_at_configured_when_cold() {
        let start = resolve_chain_from_block(
            "neo_n3",
            &JsValue::Number(100.0),
            &JsValue::Null,
            999.0,
        )
        .unwrap();
        assert_eq!(start, 100.0);
    }

    #[test]
    fn resolve_chain_advances_past_checkpoint() {
        let next = resolve_chain_from_block(
            "neo_n3",
            &JsValue::Null,
            &JsValue::Number(499.0),
            500.0,
        )
        .unwrap();
        assert_eq!(next, 500.0);
    }

    #[test]
    fn resolve_chain_refuses_invalid_checkpoint_with_exact_message() {
        let err = resolve_chain_from_block(
            "neo_n3",
            &JsValue::Number(0.0),
            &JsValue::Str("garbage".to_string()),
            500.0,
        )
        .unwrap_err();
        assert_eq!(
            err,
            "Invalid relayer checkpoint for neo_n3: \"garbage\". Refusing to reset to genesis (0)."
        );
    }

    #[test]
    fn resolve_chain_refuses_checkpoint_ahead_of_tip() {
        let err = resolve_chain_from_block(
            "neox",
            &JsValue::Number(0.0),
            &JsValue::Number(700.0),
            500.0,
        )
        .unwrap_err();
        assert_eq!(
            err,
            "Relayer checkpoint for neox (700) is ahead of the confirmed tip (500). Refusing to reset to genesis (0)."
        );
    }

    #[test]
    fn negative_one_checkpoint_restarts_at_genesis() {
        // -1 is the sentinel "scan from genesis" and is >= -1, so allowed.
        let next = resolve_chain_from_block(
            "neo_n3",
            &JsValue::Number(0.0),
            &JsValue::Number(-1.0),
            500.0,
        )
        .unwrap();
        assert_eq!(next, 0.0);
    }
}
