//! Ported from `workers/nitro-worker/src/platform/overload-guard.test.mjs`,
//! plus the env-coercion corners of `resolveLimit` the JS behavior implies.

use std::collections::BTreeMap;
use std::collections::HashMap;

use morpheus_compute::overload::{AcquireOutcome, OverloadGuard};
use serde_json::json;

fn env_from(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let map: HashMap<String, String> = pairs
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect();
    move |name: &str| map.get(name).cloned()
}

fn no_env(_: &str) -> Option<String> {
    None
}

fn snapshot_get(snapshot: &BTreeMap<String, u64>, key: &str) -> Option<u64> {
    snapshot.get(key).copied()
}

#[test]
fn per_route_in_flight_caps_are_enforced() {
    let guard = OverloadGuard::new();
    let env = env_from(&[("MORPHEUS_MAX_INFLIGHT_COMPUTE_EXECUTE", "2")]);

    let first = guard.acquire("/compute/execute", &json!({}), &env);
    let second = guard.acquire("/compute/execute", &json!({}), &env);
    let third = guard.acquire("/compute/execute", &json!({}), &env);

    assert!(first.ok());
    assert!(second.ok());
    assert!(!third.ok());
    let AcquireOutcome::Rejected(rejection) = third else {
        panic!("third must be rejected");
    };
    assert_eq!(rejection.route_name, "compute_execute");
    assert_eq!(rejection.limit, 2);
    assert_eq!(rejection.in_flight, 2);
    assert_eq!(rejection.status, 503);
    assert_eq!(rejection.retry_after, "1");
    assert_eq!(
        rejection.body,
        json!({ "error": "overloaded", "route": "compute_execute", "limit": 2, "in_flight": 2 })
    );
    assert_eq!(snapshot_get(&guard.snapshot(), "compute_execute"), Some(2));

    drop(first);
    drop(second);
    assert_eq!(snapshot_get(&guard.snapshot(), "compute_execute"), None);
}

#[test]
fn action_routed_requests_share_the_capability_cap() {
    let guard = OverloadGuard::new();
    let env = env_from(&[("MORPHEUS_MAX_INFLIGHT_RELAY_TRANSACTION", "1")]);
    let payload = json!({ "action": "relay_transaction" });

    let first = guard.acquire("", &payload, &env);
    let second = guard.acquire("", &payload, &env);

    let AcquireOutcome::Granted(slot) = first else {
        panic!("first must be granted");
    };
    assert_eq!(slot.route_name, "relay_transaction");
    assert!(!second.ok());
    let AcquireOutcome::Rejected(rejection) = second else {
        panic!("second must be rejected");
    };
    assert_eq!(rejection.route_name, "relay_transaction");
    assert_eq!(rejection.status, 503);
}

#[test]
fn release_is_idempotent() {
    let guard = OverloadGuard::new();
    let env = env_from(&[("MORPHEUS_MAX_INFLIGHT_ORACLE_QUERY", "1")]);

    let slot = guard.acquire("/oracle/query", &json!({}), &env);
    let AcquireOutcome::Granted(slot) = slot else {
        panic!("must be granted");
    };
    assert_eq!(snapshot_get(&guard.snapshot(), "oracle_query"), Some(1));
    slot.release();
    slot.release();
    assert_eq!(snapshot_get(&guard.snapshot(), "oracle_query"), None);
}

#[test]
fn dropping_the_slot_releases_it() {
    let guard = OverloadGuard::new();
    let env = env_from(&[("MORPHEUS_MAX_INFLIGHT_SESSION_STEP", "1")]);
    {
        let _slot = guard.acquire("/session/step", &json!({}), &env);
        assert_eq!(snapshot_get(&guard.snapshot(), "session_step"), Some(1));
    }
    assert_eq!(snapshot_get(&guard.snapshot(), "session_step"), None);
}

#[test]
fn unknown_routes_and_zero_limits_are_uncapped() {
    let guard = OverloadGuard::new();
    let outcome = guard.acquire("/not/a/route", &json!({}), &no_env);
    assert!(outcome.ok());
    let AcquireOutcome::Uncapped {
        route_name,
        limit,
        in_flight,
    } = outcome
    else {
        panic!("unknown route must be uncapped");
    };
    assert_eq!(route_name, None);
    assert_eq!(limit, 0);
    assert_eq!(in_flight, 0);

    // oracle_feed's default is 0 — uncapped even though it resolves.
    let outcome = guard.acquire("/oracle/feed", &json!({}), &no_env);
    let AcquireOutcome::Uncapped { route_name, .. } = outcome else {
        panic!("zero-limit route must be uncapped");
    };
    assert_eq!(route_name, Some("oracle_feed"));
}

#[test]
fn limit_env_values_follow_js_number_semantics() {
    let guard = OverloadGuard::new();

    // Default (4) applies when the variable is unset or empty.
    {
        let outcome = guard.acquire("/compute/execute", &json!({}), &no_env);
        let AcquireOutcome::Granted(slot) = outcome else {
            panic!("unset env must use the default limit");
        };
        assert_eq!(slot.limit, 4);
    }
    {
        let env = env_from(&[("MORPHEUS_MAX_INFLIGHT_COMPUTE_EXECUTE", "")]);
        let outcome = guard.acquire("/compute/execute", &json!({}), &env);
        let AcquireOutcome::Granted(slot) = outcome else {
            panic!("empty env must use the default limit");
        };
        assert_eq!(slot.limit, 4);
    }

    // Fractional values truncate; garbage means 0 (uncapped); negatives clamp.
    for (value, limit) in [("2.9", 2u64), ("1", 1), ("abc", 0), ("-1", 0)] {
        let guard = OverloadGuard::new();
        let env = env_from(&[("MORPHEUS_MAX_INFLIGHT_COMPUTE_EXECUTE", value)]);
        let outcome = guard.acquire("/compute/execute", &json!({}), &env);
        if limit == 0 {
            let AcquireOutcome::Uncapped {
                limit: resolved, ..
            } = outcome
            else {
                panic!("{value} must be uncapped");
            };
            assert_eq!(resolved, 0, "{value}");
        } else {
            let AcquireOutcome::Granted(slot) = outcome else {
                panic!("{value} must grant");
            };
            assert_eq!(slot.limit, limit, "{value}");
        }
    }
}
