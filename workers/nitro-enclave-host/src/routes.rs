//! The route table — `matchesRoute` (enclave-server.mjs:1902) and the
//! dispatch matrix it feeds, as a pure classifier so the tests can enumerate
//! it without a socket.
//!
//! `matchesRoute` accepts the route exactly, OR with a SINGLE leading network
//! prefix segment (`/mainnet/oracle/fulfill` for `/oracle/fulfill`), which is
//! what the control plane dispatches. It is deliberately tighter than
//! `path.endsWith(route)`, which would also match `/evil/<route>`.

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
    ProvisionCredentials,
    ProvisionRelayerAuth,
    OracleFulfill,
    FeedSign,
    SignPayload,
    KeysDerived,
    ComputeExecute,
    NeoDidBind,
    NeoDidActionTicket,
    NeoDidRecoveryTicket,
    NeoDidZkLoginTicket,
    OracleQuery,
    OracleSmartFetch,
    OracleDecrypt,
    OracleMessageReveal,
    OraclePublicKey,
    VrfRandom,
    PaymasterAuthorize,
    SessionStart,
    SessionStep,
    SessionFinalize,
    SessionSettle,
    AutomationExecute,
    OracleFeed,
    FeedsCatalog,
    Providers,
    NeoDidProviders,
    NeoDidRuntime,
    ComputeFunctions,
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
        if matches_route(path, "/provision/relayer-auth") {
            return Target::ProvisionRelayerAuth;
        }
        if matches_route(path, "/provision/credentials") {
            return Target::ProvisionCredentials;
        }
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
        if matches_route(path, "/compute/execute") {
            return Target::ComputeExecute;
        }
        if matches_route(path, "/neodid/bind") {
            return Target::NeoDidBind;
        }
        if matches_route(path, "/neodid/action-ticket") {
            return Target::NeoDidActionTicket;
        }
        if matches_route(path, "/neodid/recovery-ticket") {
            return Target::NeoDidRecoveryTicket;
        }
        if matches_route(path, "/neodid/zklogin-ticket") {
            return Target::NeoDidZkLoginTicket;
        }
        if matches_route(path, "/vrf/random") {
            return Target::VrfRandom;
        }
        if matches_route(path, "/paymaster/authorize") {
            return Target::PaymasterAuthorize;
        }
        if matches_route(path, "/session/start") {
            return Target::SessionStart;
        }
        if matches_route(path, "/session/step") {
            return Target::SessionStep;
        }
        if matches_route(path, "/session/finalize") {
            return Target::SessionFinalize;
        }
        if matches_route(path, "/session/settle") {
            return Target::SessionSettle;
        }
        if matches_route(path, "/automation/execute") {
            return Target::AutomationExecute;
        }
        if matches_route(path, "/oracle/feed") {
            return Target::OracleFeed;
        }
        // The Phase 9 folds: the last four child-forwarded lanes, in-process
        // since the flip ([`crate::oracle_read`]).
        if matches_route(path, "/oracle/query") {
            return Target::OracleQuery;
        }
        if matches_route(path, "/oracle/smart-fetch") {
            return Target::OracleSmartFetch;
        }
        if matches_route(path, "/oracle/decrypt") {
            return Target::OracleDecrypt;
        }
        if matches_route(path, "/oracle/message-reveal") {
            return Target::OracleMessageReveal;
        }
    }
    if (method == "GET" || method == "POST") && matches_route(path, "/oracle/public-key") {
        return Target::OraclePublicKey;
    }
    // The read-only catalog plane (CU-149): the listings and descriptors the
    // capability registry has always declared and `docs/USER_GUIDE.md` already
    // documents as direct runtime calls. GET only — a write method on one of
    // these paths falls through to the same 404 an unknown path gets, so a
    // catalog lane can never become a write surface by accident.
    if method == "GET" {
        // More specific first. `/neodid/providers` is a one-segment prefix
        // plus `/providers`, so `matches_route("/neodid/providers", "/providers")`
        // is true: the narrower arm has to run first or the general one claims
        // the path.
        if matches_route(path, "/neodid/providers") {
            return Target::NeoDidProviders;
        }
        if matches_route(path, "/neodid/runtime") {
            return Target::NeoDidRuntime;
        }
        if matches_route(path, "/feeds/catalog") {
            return Target::FeedsCatalog;
        }
        if matches_route(path, "/providers") {
            return Target::Providers;
        }
        if matches_route(path, "/compute/functions") {
            return Target::ComputeFunctions;
        }
    }
    Target::NotFound
}

#[cfg(test)]
#[path = "../tests/unit/routes.rs"]
mod tests;

impl Target {
    /// The route's own canonical path, independent of the optional
    /// single-segment network prefix `matches_route` allows. Admission
    /// control keys on this so `/mainnet/compute/execute` and
    /// `/compute/execute` share one capacity counter instead of the prefixed
    /// form silently routing around the cap.
    pub fn canonical_path(&self) -> Option<&'static str> {
        Some(match self {
            Target::OracleFulfill => "/oracle/fulfill",
            Target::FeedSign => "/feed/sign",
            Target::SignPayload => "/sign/payload",
            Target::KeysDerived => "/keys/derived",
            Target::ComputeExecute => "/compute/execute",
            Target::NeoDidBind => "/neodid/bind",
            Target::NeoDidActionTicket => "/neodid/action-ticket",
            Target::NeoDidRecoveryTicket => "/neodid/recovery-ticket",
            Target::NeoDidZkLoginTicket => "/neodid/zklogin-ticket",
            Target::OracleQuery => "/oracle/query",
            Target::OracleSmartFetch => "/oracle/smart-fetch",
            Target::OracleDecrypt => "/oracle/decrypt",
            Target::OracleMessageReveal => "/oracle/message-reveal",
            Target::OraclePublicKey => "/oracle/public-key",
            Target::VrfRandom => "/vrf/random",
            Target::PaymasterAuthorize => "/paymaster/authorize",
            Target::SessionStart => "/session/start",
            Target::SessionStep => "/session/step",
            Target::SessionFinalize => "/session/finalize",
            Target::SessionSettle => "/session/settle",
            Target::AutomationExecute => "/automation/execute",
            Target::OracleFeed => "/oracle/feed",
            Target::FeedsCatalog => "/feeds/catalog",
            Target::Providers => "/providers",
            Target::NeoDidProviders => "/neodid/providers",
            Target::NeoDidRuntime => "/neodid/runtime",
            Target::ComputeFunctions => "/compute/functions",
            Target::Health
            | Target::Attestation
            | Target::Provision
            | Target::ProvisionCredentials
            | Target::ProvisionRelayerAuth
            | Target::NotFound => return None,
        })
    }
}
