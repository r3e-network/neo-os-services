//! Route-table tests — the dispatch fixtures from `enclave-server.test.mjs`
//! (lines ~1514-1560) ported to the classifier. The property under test is
//! the same one the Node suite pins: a network prefix is ONE segment, never
//! a suffix match, and method mismatches fall through to 404.

use super::*;

fn classify_get(path: &str) -> Target {
    classify("GET", path)
}

fn classify_post(path: &str) -> Target {
    classify("POST", path)
}

#[test]
fn the_exact_routes_classify() {
    assert_eq!(classify_get("/health"), Target::Health);
    assert_eq!(classify_get("/attestation"), Target::Attestation);
    assert_eq!(classify_post("/attestation"), Target::Attestation);
    assert_eq!(classify_post("/provision"), Target::Provision);
    assert_eq!(
        classify_post("/provision/credentials"),
        Target::ProvisionCredentials
    );
    assert_eq!(classify_post("/oracle/fulfill"), Target::OracleFulfill);
    assert_eq!(classify_post("/feed/sign"), Target::FeedSign);
    assert_eq!(classify_post("/sign/payload"), Target::SignPayload);
    assert_eq!(classify_post("/keys/derived"), Target::KeysDerived);
    assert_eq!(classify_post("/neodid/bind"), Target::NeoDidBind);
    assert_eq!(
        classify_post("/neodid/action-ticket"),
        Target::NeoDidActionTicket
    );
    assert_eq!(
        classify_post("/neodid/recovery-ticket"),
        Target::NeoDidRecoveryTicket
    );
    assert_eq!(
        classify_post("/neodid/zklogin-ticket"),
        Target::NeoDidZkLoginTicket
    );
    assert_eq!(classify_post("/vrf/random"), Target::VrfRandom);
    assert_eq!(
        classify_post("/paymaster/authorize"),
        Target::PaymasterAuthorize
    );
    assert_eq!(classify_post("/session/start"), Target::SessionStart);
    assert_eq!(classify_post("/session/step"), Target::SessionStep);
    assert_eq!(classify_post("/session/finalize"), Target::SessionFinalize);
    assert_eq!(
        classify_post("/automation/execute"),
        Target::AutomationExecute
    );
    assert_eq!(classify_post("/oracle/feed"), Target::OracleFeed);
    assert_eq!(classify_post("/oracle/query"), Target::OracleQuery);
    assert_eq!(
        classify_post("/oracle/smart-fetch"),
        Target::OracleSmartFetch
    );
    assert_eq!(classify_post("/oracle/decrypt"), Target::OracleDecrypt);
    assert_eq!(
        classify_post("/oracle/message-reveal"),
        Target::OracleMessageReveal
    );
    assert_eq!(classify_get("/oracle/public-key"), Target::OraclePublicKey);
    assert_eq!(classify_post("/oracle/public-key"), Target::OraclePublicKey);
}

#[test]
fn the_former_passthrough_routes_classify_in_process() {
    // Former child-forwarded lanes classify straight to their in-process
    // targets; there is no passthrough variant or manifest to re-arm.
    for (path, target) in [
        ("/oracle/query", Target::OracleQuery),
        ("/oracle/smart-fetch", Target::OracleSmartFetch),
        ("/oracle/decrypt", Target::OracleDecrypt),
        ("/oracle/message-reveal", Target::OracleMessageReveal),
    ] {
        let prefixed = format!("/mainnet{path}");
        assert_eq!(classify_post(path), target, "exact {path}");
        assert_eq!(classify_post(&prefixed), target, "prefixed {path}");
        assert_eq!(
            classify_get(path),
            Target::NotFound,
            "GET {path} is not a route"
        );
    }
}

#[test]
fn a_single_network_prefix_is_accepted() {
    assert_eq!(classify_get("/testnet/health"), Target::Health);
    assert_eq!(classify_get("/mainnet/health"), Target::Health);
    assert_eq!(
        classify_get("/mainnet/oracle/public-key"),
        Target::OraclePublicKey
    );
    assert_eq!(classify_post("/testnet/attestation"), Target::Attestation);
}

#[test]
fn a_two_segment_prefix_is_a_suffix_match_and_refused() {
    // '/evil/path/health' ends with '/health' but the prefix is two segments —
    // exactly the shape matchesRoute exists to refuse.
    assert_eq!(classify_get("/evil/path/health"), Target::NotFound);
    assert_eq!(classify_post("/mainnet/admin/wipe"), Target::NotFound);
}

#[test]
fn method_mismatches_fall_through_to_not_found() {
    assert_eq!(classify_get("/provision"), Target::NotFound);
    assert_eq!(classify_post("/health"), Target::NotFound);
    assert_eq!(classify_get("/oracle/fulfill"), Target::NotFound);
    assert_eq!(classify_post("/oracle/public-key"), Target::OraclePublicKey);
    // Whitespace-only method collapses like the Node trimString does — no
    // route matches an empty method.
    assert_eq!(classify("   ", "/health"), Target::NotFound);
}

#[test]
fn lookalikes_do_not_match() {
    assert_eq!(classify_get("/healthz"), Target::NotFound);
    assert_eq!(classify_get("/xhealth"), Target::NotFound);
    assert_eq!(classify_get("/health/extra"), Target::NotFound);
    assert_eq!(classify_get("/health/sub/deep"), Target::NotFound);
}

#[test]
fn first_occurrence_indexof_semantics_are_preserved() {
    // Node uses indexOf (FIRST occurrence): '/a/oracle/fulfill/oracle/fulfill'
    // first sees '/oracle/fulfill' at index 2, prefix '/a' is one segment,
    // but the route does not END the path — refused. The prefix trick
    // '/oracle/fulfill-x' style paths likewise refuse.
    assert_eq!(classify_post("/a/oracle/fulfill/tail"), Target::NotFound);
    assert_eq!(classify_post("/a/oracle/fulfill"), Target::OracleFulfill);
}

#[test]
fn prefix_charset_matches_the_node_regex() {
    // ^\/[A-Za-z0-9._-]+$ — a prefix outside this charset is refused.
    assert_eq!(classify_get("/network_1/health"), Target::Health);
    assert_eq!(classify_get("/a.b-c/health"), Target::Health);
    assert_eq!(classify_get("/with space/health"), Target::NotFound);
    assert_eq!(classify_get("/with/slash/health"), Target::NotFound);
    assert_eq!(classify_get("/中文/health"), Target::NotFound);
}

#[test]
fn matches_route_agrees_with_the_node_implementation() {
    assert!(matches_route("/health", "/health"));
    assert!(matches_route("/mainnet/health", "/health"));
    assert!(!matches_route("/a/b/health", "/health"));
    assert!(!matches_route("/health", "/mainnet/health"));
    // path === route is the first branch of the Node matcher.
    assert!(matches_route("/mainnet/health", "/mainnet/health"));
    // First-occurrence: the route appears early but the path continues.
    assert!(!matches_route(
        "/oracle/fulfill/and/more",
        "/oracle/fulfill"
    ));
}
