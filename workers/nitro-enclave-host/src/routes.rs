//! The route table — `matchesRoute` (enclave-server.mjs:1902) and the
//! dispatch matrix it feeds, as a pure classifier so the tests can enumerate
//! it without a socket.
//!
//! `matchesRoute` accepts the route exactly, OR with a SINGLE leading network
//! prefix segment (`/mainnet/oracle/fulfill` for `/oracle/fulfill`), which is
//! what the control plane dispatches. It is deliberately tighter than
//! `path.endsWith(route)`, which would also match `/evil/<route>`.

/// The execution-plane passthrough: the exact worker routes the Cloudflare
/// control plane sends to enclave compute. WHITELISTED — not a blanket
/// catch-all — so the public surface is exactly this list, and every entry is
/// auth-gated in `dispatch` like the other sensitive routes. (EGRESS-1: an
/// arbitrary-URL smart-fetch payload still reaches the worker through
/// `/oracle/smart-fetch`; its outbound host is gated by the egress allow-list
/// in the worker, fail-closed.)
pub const EXECUTION_PLANE_PASSTHROUGH: [&str; 8] = [
    "/oracle/query",
    "/oracle/smart-fetch",
    "/compute/execute",
    "/oracle/decrypt",
    "/oracle/message-reveal",
    "/neodid/bind",
    "/neodid/action-ticket",
    "/neodid/recovery-ticket",
];

/// Accept `route` exactly, or with a single leading path segment before it.
/// The first occurrence of `route` must sit at the end of the path, and the
/// prefix must be exactly one segment: `/mainnet` — matching the Node
/// implementation's `indexOf` (first occurrence, not last) and its
/// `^\/[A-Za-z0-9._-]+$` prefix check.
pub fn matches_route(path: &str, route: &str) -> bool {
    if path == route {
        return true;
    }
    let Some(idx) = path.find(route) else {
        return false;
    };
    if idx == 0 || idx + route.len() != path.len() {
        return false;
    }
    is_single_segment(&path[..idx])
}

fn is_single_segment(prefix: &str) -> bool {
    let bytes = prefix.as_bytes();
    bytes.len() >= 2
        && bytes[0] == b'/'
        && bytes[1..]
            .iter()
            .all(|b| matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-'))
}

/// What `dispatch` does with a (method, path). Method mismatches fall to
/// [`Target::NotFound`] — the Node dispatch's route guards are method checks
/// inside `if` chains, so `GET /provision` falls through every branch to the
/// catch-all 404 exactly like an unknown path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Health,
    Attestation,
    Provision,
    OracleFulfill,
    FeedSign,
    SignPayload,
    KeysDerived,
    Passthrough(&'static str),
    OraclePublicKey,
    NotFound,
}

pub fn classify(method: &str, path: &str) -> Target {
    let method = method.trim().to_ascii_uppercase();
    if method == "GET" && matches_route(path, "/health") {
        return Target::Health;
    }
    if (method == "GET" || method == "POST") && matches_route(path, "/attestation") {
        return Target::Attestation;
    }
    if method == "POST" {
        if matches_route(path, "/provision") {
            return Target::Provision;
        }
        if matches_route(path, "/oracle/fulfill") {
            return Target::OracleFulfill;
        }
        if matches_route(path, "/feed/sign") {
            return Target::FeedSign;
        }
        if matches_route(path, "/sign/payload") {
            return Target::SignPayload;
        }
        if matches_route(path, "/keys/derived") {
            return Target::KeysDerived;
        }
        if let Some(route) = EXECUTION_PLANE_PASSTHROUGH
            .iter()
            .copied()
            .find(|route| matches_route(path, route))
        {
            return Target::Passthrough(route);
        }
    }
    if (method == "GET" || method == "POST") && matches_route(path, "/oracle/public-key") {
        return Target::OraclePublicKey;
    }
    Target::NotFound
}

#[cfg(test)]
#[path = "../tests/unit/routes.rs"]
mod tests;
