//! Ported from `workers/nitro-worker/src/capabilities.test.mjs` — path
//! resolution, regex precedence, action fallback, network prefixes and
//! workflow metadata, against the same registry order.

use morpheus_compute::capabilities::{
    capability_by_id, is_routable_path, list_capability_features, resolve_capability,
    resolve_route_name, MatchedBy,
    RoutePattern::{self, Exact, Suffix},
};
use serde_json::json;

fn id_for(path: &str) -> Option<&'static str> {
    resolve_capability(path, &json!({})).map(|r| r.capability.id)
}

#[test]
fn every_known_exact_path_resolves() {
    let cases = [
        ("/keys/derived", "keys_derived"),
        ("/neodid/providers", "neodid_providers"),
        ("/neodid/runtime", "neodid_runtime"),
        ("/neodid/bind", "neodid_bind"),
        ("/neodid/action-ticket", "neodid_action_ticket"),
        ("/neodid/recovery-ticket", "neodid_recovery_ticket"),
        ("/neodid/zklogin-ticket", "neodid_zklogin_ticket"),
        ("/providers", "providers"),
        ("/oracle/public-key", "oracle_public_key"),
        ("/oracle/query", "oracle_query"),
        ("/oracle/smart-fetch", "oracle_smart_fetch"),
        ("/feeds/catalog", "feeds_catalog"),
        ("/feeds/price", "feeds_price"),
        ("/vrf/random", "vrf_random"),
        ("/oracle/feed", "oracle_feed"),
        ("/txproxy/invoke", "txproxy_invoke"),
        ("/sign/payload", "sign_payload"),
        ("/relay/transaction", "relay_transaction"),
        ("/paymaster/authorize", "paymaster_authorize"),
        ("/compute/functions", "compute_functions"),
        ("/compute/execute", "compute_execute"),
        ("/compute/jobs", "compute_jobs"),
    ];
    for (path, expected) in cases {
        assert_eq!(id_for(path), Some(expected), "path {path}");
    }
}

#[test]
fn parameterized_routes_match_the_unanchored_regexes() {
    assert_eq!(id_for("/feeds/price/NEO-USD"), Some("feeds_price_symbol"));
    assert_eq!(id_for("/compute/jobs/abc-123"), Some("compute_jobs_id"));
}

#[test]
fn patterns_take_precedence_over_exact_siblings() {
    assert_eq!(id_for("/feeds/price/NEO-USD"), Some("feeds_price_symbol"));
    assert_eq!(id_for("/feeds/price"), Some("feeds_price"));
    assert_eq!(id_for("/compute/jobs/xyz"), Some("compute_jobs_id"));
    assert_eq!(id_for("/compute/jobs"), Some("compute_jobs"));
}

#[test]
fn unknown_paths_resolve_to_none() {
    assert_eq!(id_for("/unknown/route"), None);
    assert_eq!(id_for("/oracle/unknown"), None);
    assert_eq!(id_for(""), None);
}

#[test]
fn action_fallback_matches_declaring_capabilities() {
    let feed = resolve_capability("/some/random/path", &json!({ "action": "oracle_feed" }))
        .expect("oracle_feed action resolves");
    assert_eq!(feed.capability.id, "oracle_feed");
    assert_eq!(feed.matched_by, MatchedBy::Action);

    let sign = resolve_capability("/some/random/path", &json!({ "action": "sign_payload" }))
        .expect("sign_payload action resolves");
    assert_eq!(sign.capability.id, "sign_payload");

    let relay = resolve_capability(
        "/some/random/path",
        &json!({ "action": "relay_transaction" }),
    )
    .expect("relay_transaction action resolves");
    assert_eq!(relay.capability.id, "relay_transaction");

    let decrypt =
        resolve_capability("/x", &json!({ "action": "decrypt" })).expect("decrypt action resolves");
    assert_eq!(decrypt.capability.id, "oracle_decrypt");

    let reveal = resolve_capability("/x", &json!({ "action": "message_reveal" }))
        .expect("message_reveal action resolves");
    assert_eq!(reveal.capability.id, "oracle_message_reveal");
}

#[test]
fn unknown_or_falsy_actions_do_not_match() {
    assert_eq!(
        resolve_capability("/unknown", &json!({ "action": "nonexistent" })),
        None
    );
    // Truthiness gate: an empty action string is falsy in the JS.
    assert_eq!(
        resolve_capability("/unknown", &json!({ "action": "" })),
        None
    );
    // A non-string action can never equal a declared string action.
    assert_eq!(
        resolve_capability("/unknown", &json!({ "action": 1 })),
        None
    );
    assert_eq!(resolve_capability("/unknown", &json!({})), None);
}

#[test]
fn route_names_and_feature_paths_track_the_registry() {
    let cases = [
        ("/vrf/random", "vrf_random"),
        ("/compute/execute", "compute_execute"),
        ("/paymaster/authorize", "paymaster_authorize"),
        ("/txproxy/invoke", "txproxy_invoke"),
        ("/oracle/feed", "oracle_feed"),
        ("/oracle/query", "oracle_query"),
        ("/oracle/smart-fetch", "oracle_smart_fetch"),
        ("/neodid/action-ticket", "neodid_action_ticket"),
        ("/neodid/recovery-ticket", "neodid_recovery_ticket"),
        ("/neodid/zklogin-ticket", "neodid_zklogin_ticket"),
    ];
    for (path, expected) in cases {
        assert_eq!(resolve_route_name(path, &json!({})), Some(expected));
    }
    assert_eq!(resolve_route_name("/unknown", &json!({})), None);
    assert_eq!(resolve_route_name("", &json!({})), None);
}

#[test]
fn feature_list_contains_the_expected_entries() {
    let features = list_capability_features();
    assert!(!features.is_empty());
    for expected in [
        "oracle/query",
        "vrf/random",
        "feeds/price/:symbol",
        "compute/execute",
        "neodid/bind",
        "paymaster/authorize",
        "compute/jobs/:id",
    ] {
        assert!(
            features.contains(&expected),
            "features should include {expected}"
        );
    }
}

#[test]
fn arbitrary_prefixes_never_resolve() {
    // The S19 guard: only exact paths and known network prefixes.
    assert_eq!(id_for("/api/v1/vrf/random"), None);
    assert_eq!(id_for("/evil/vrf/random"), None);
}

#[test]
fn known_network_prefixes_resolve_case_insensitively() {
    let mainnet = resolve_capability("/mainnet/vrf/random", &json!({})).expect("mainnet");
    assert_eq!(mainnet.capability.id, "vrf_random");
    assert_eq!(mainnet.matched_by, MatchedBy::Path);
    let testnet = resolve_capability("/testnet/vrf/random", &json!({})).expect("testnet");
    assert_eq!(testnet.capability.id, "vrf_random");
    // The JS lowercases the first segment before comparing.
    assert_eq!(id_for("/MAINNET/vrf/random"), Some("vrf_random"));
    // But only as the FIRST segment.
    assert_eq!(id_for("/oracle/mainnet/query"), None);
    // And a bare prefix with nothing after it is not the route.
    assert_eq!(id_for("/mainnet"), None);
}

#[test]
fn catalog_backed_capabilities_attach_workflow_metadata() {
    let oracle_query = resolve_capability("/oracle/query", &json!({})).expect("oracle query");
    let workflow = oracle_query.capability.workflow.expect("workflow attached");
    assert_eq!(workflow.id, "oracle.query");
    assert_eq!(workflow.version, 1);

    let paymaster = resolve_capability("/paymaster/authorize", &json!({})).expect("paymaster");
    assert_eq!(
        paymaster.capability.workflow.expect("workflow").id,
        "paymaster.authorize"
    );

    let providers = resolve_capability("/providers", &json!({})).expect("providers");
    assert!(providers.capability.workflow.is_none());
}

#[test]
fn pattern_shapes_are_exposed_for_direct_checks() {
    let symbol = capability_by_id("feeds_price_symbol").expect("registry entry");
    assert_eq!(symbol.pattern, Suffix("/feeds/price/"));
    // The JS regex is unanchored, so the marker may sit after a foreign
    // prefix — parity keeps that hole open until the oracle changes.
    assert!(is_routable_path(
        "/evil/feeds/price/x",
        &RoutePattern::Suffix("/feeds/price/")
    ));
    // `.+` needs at least one character after the marker.
    assert!(!is_routable_path(
        "/feeds/price/",
        &RoutePattern::Suffix("/feeds/price/")
    ));

    let execute = capability_by_id("compute_execute").expect("registry entry");
    assert_eq!(execute.pattern, Exact("/compute/execute"));
}
