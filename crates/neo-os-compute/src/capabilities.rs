//! The capability registry — the routing table and resolver from
//! `src/capabilities.js` (the handlers stay in the Node child until the
//! 5b-5f lanes land; only routing resolves here).
//!
//! Three resolver facts carry over verbatim:
//!
//! * Exact paths match strictly: the path itself, or a `/mainnet`/`/testnet`
//!   first segment (case-insensitive) whose remainder equals the route. A bare
//!   `endsWith` would let `/evil/vrf/random` reach a sensitive capability —
//!   the S19 guard in the JS refuses arbitrary prefixes and so does this.
//! * The two parameterized routes are JS REGEXES (`/\/feeds\/price\/.+/`,
//!   `/\/compute\/jobs\/.+/`), and `RegExp.test` is UNANCHORED — any path
//!   *containing* the marker with at least one character after it matches,
//!   including `/evil/feeds/price/x`. The port reproduces that (a
//!   `contains`-style suffix match), because "fixing" it here would diverge
//!   from the oracle, not harden it.
//! * Action fallback only fires for capabilities that declare `actions`;
//!   sensitive lanes (`sign_payload`, `relay_transaction` included) declare
//!   theirs but are ALSO reachable by action — the actions list is the allow
//!   list, not a restriction on path matching.

use serde_json::Value as Json;

/// The workflow-catalog entry a capability was registered with
/// (`getWorkflowDefinition(id)` in JS — the port carries the two fields the
/// worker's execution plan reads: `capability.workflow.id` and `.version`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkflowRef {
    pub id: &'static str,
    pub version: u64,
}

/// How a route matches a path. `Exact` mirrors `paths: [{ match }]`,
/// `Suffix` mirrors `paths: [{ pattern: /\/marker\/.+/ }]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoutePattern {
    Exact(&'static str),
    Suffix(&'static str),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CapabilityRoute {
    pub id: &'static str,
    pub pattern: RoutePattern,
    pub actions: &'static [&'static str],
    pub feature_path: &'static str,
    pub workflow: Option<WorkflowRef>,
}

/// The registry, in the JS file's order — the resolver returns the FIRST
/// match, so the pattern routes (`feeds_price_symbol`, `compute_jobs_id`) must
/// sit before their exact siblings.
pub static CAPABILITIES: &[CapabilityRoute] = &[
    CapabilityRoute {
        id: "keys_derived",
        pattern: RoutePattern::Exact("/keys/derived"),
        actions: &[],
        feature_path: "keys/derived",
        workflow: None,
    },
    CapabilityRoute {
        id: "neodid_providers",
        pattern: RoutePattern::Exact("/neodid/providers"),
        actions: &[],
        feature_path: "neodid/providers",
        workflow: None,
    },
    CapabilityRoute {
        id: "neodid_runtime",
        pattern: RoutePattern::Exact("/neodid/runtime"),
        actions: &[],
        feature_path: "neodid/runtime",
        workflow: None,
    },
    CapabilityRoute {
        id: "neodid_bind",
        pattern: RoutePattern::Exact("/neodid/bind"),
        actions: &[],
        feature_path: "neodid/bind",
        workflow: Some(WorkflowRef {
            id: "neodid.bind",
            version: 1,
        }),
    },
    CapabilityRoute {
        id: "neodid_action_ticket",
        pattern: RoutePattern::Exact("/neodid/action-ticket"),
        actions: &[],
        feature_path: "neodid/action-ticket",
        workflow: Some(WorkflowRef {
            id: "neodid.action_ticket",
            version: 1,
        }),
    },
    CapabilityRoute {
        id: "neodid_recovery_ticket",
        pattern: RoutePattern::Exact("/neodid/recovery-ticket"),
        actions: &[],
        feature_path: "neodid/recovery-ticket",
        workflow: Some(WorkflowRef {
            id: "neodid.recovery_ticket",
            version: 1,
        }),
    },
    CapabilityRoute {
        id: "neodid_zklogin_ticket",
        pattern: RoutePattern::Exact("/neodid/zklogin-ticket"),
        actions: &[],
        feature_path: "neodid/zklogin-ticket",
        workflow: None,
    },
    CapabilityRoute {
        id: "providers",
        pattern: RoutePattern::Exact("/providers"),
        actions: &[],
        feature_path: "providers",
        workflow: None,
    },
    CapabilityRoute {
        id: "oracle_public_key",
        pattern: RoutePattern::Exact("/oracle/public-key"),
        actions: &[],
        feature_path: "oracle/public-key",
        workflow: None,
    },
    CapabilityRoute {
        id: "oracle_decrypt",
        pattern: RoutePattern::Exact("/oracle/decrypt"),
        actions: &["decrypt"],
        feature_path: "oracle/decrypt",
        workflow: None,
    },
    CapabilityRoute {
        id: "oracle_message_reveal",
        pattern: RoutePattern::Exact("/oracle/message-reveal"),
        actions: &["message_reveal"],
        feature_path: "oracle/message-reveal",
        workflow: None,
    },
    CapabilityRoute {
        id: "oracle_heartbeat",
        pattern: RoutePattern::Exact("/oracle/heartbeat"),
        actions: &[],
        feature_path: "oracle/heartbeat",
        workflow: None,
    },
    CapabilityRoute {
        id: "oracle_query",
        pattern: RoutePattern::Exact("/oracle/query"),
        actions: &[],
        feature_path: "oracle/query",
        workflow: Some(WorkflowRef {
            id: "oracle.query",
            version: 1,
        }),
    },
    CapabilityRoute {
        id: "oracle_smart_fetch",
        pattern: RoutePattern::Exact("/oracle/smart-fetch"),
        actions: &[],
        feature_path: "oracle/smart-fetch",
        workflow: Some(WorkflowRef {
            id: "oracle.smart_fetch",
            version: 1,
        }),
    },
    CapabilityRoute {
        id: "feeds_catalog",
        pattern: RoutePattern::Exact("/feeds/catalog"),
        actions: &[],
        feature_path: "feeds/catalog",
        workflow: None,
    },
    CapabilityRoute {
        id: "feeds_price_symbol",
        pattern: RoutePattern::Suffix("/feeds/price/"),
        actions: &[],
        feature_path: "feeds/price/:symbol",
        workflow: None,
    },
    CapabilityRoute {
        id: "feeds_price",
        pattern: RoutePattern::Exact("/feeds/price"),
        actions: &[],
        feature_path: "feeds/price",
        workflow: None,
    },
    CapabilityRoute {
        id: "vrf_random",
        pattern: RoutePattern::Exact("/vrf/random"),
        actions: &[],
        feature_path: "vrf/random",
        workflow: None,
    },
    CapabilityRoute {
        id: "oracle_feed",
        pattern: RoutePattern::Exact("/oracle/feed"),
        actions: &["oracle_feed"],
        feature_path: "oracle/feed",
        workflow: Some(WorkflowRef {
            id: "feed.sync",
            version: 1,
        }),
    },
    CapabilityRoute {
        id: "txproxy_invoke",
        pattern: RoutePattern::Exact("/txproxy/invoke"),
        actions: &[],
        feature_path: "txproxy/invoke",
        workflow: None,
    },
    CapabilityRoute {
        id: "sign_payload",
        pattern: RoutePattern::Exact("/sign/payload"),
        actions: &["sign_payload"],
        feature_path: "sign/payload",
        workflow: None,
    },
    CapabilityRoute {
        id: "relay_transaction",
        pattern: RoutePattern::Exact("/relay/transaction"),
        actions: &["relay_transaction"],
        feature_path: "relay/transaction",
        workflow: None,
    },
    CapabilityRoute {
        id: "paymaster_authorize",
        pattern: RoutePattern::Exact("/paymaster/authorize"),
        actions: &[],
        feature_path: "paymaster/authorize",
        workflow: Some(WorkflowRef {
            id: "paymaster.authorize",
            version: 1,
        }),
    },
    CapabilityRoute {
        id: "session_start",
        pattern: RoutePattern::Exact("/session/start"),
        actions: &[],
        feature_path: "session/start",
        workflow: None,
    },
    CapabilityRoute {
        id: "session_step",
        pattern: RoutePattern::Exact("/session/step"),
        actions: &[],
        feature_path: "session/step",
        workflow: None,
    },
    CapabilityRoute {
        id: "session_finalize",
        pattern: RoutePattern::Exact("/session/finalize"),
        actions: &[],
        feature_path: "session/finalize",
        workflow: None,
    },
    CapabilityRoute {
        id: "compute_functions",
        pattern: RoutePattern::Exact("/compute/functions"),
        actions: &[],
        feature_path: "compute/functions",
        workflow: None,
    },
    CapabilityRoute {
        id: "compute_execute",
        pattern: RoutePattern::Exact("/compute/execute"),
        actions: &[],
        feature_path: "compute/execute",
        workflow: Some(WorkflowRef {
            id: "compute.execute",
            version: 1,
        }),
    },
    CapabilityRoute {
        id: "compute_jobs_id",
        pattern: RoutePattern::Suffix("/compute/jobs/"),
        actions: &[],
        feature_path: "compute/jobs/:id",
        workflow: None,
    },
    CapabilityRoute {
        id: "compute_jobs",
        pattern: RoutePattern::Exact("/compute/jobs"),
        actions: &[],
        feature_path: "compute/jobs",
        workflow: None,
    },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchedBy {
    Path,
    Action,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Resolved {
    pub capability: &'static CapabilityRoute,
    pub matched_by: MatchedBy,
}

/// `isRoutablePath` (capabilities.js:479-491). The network-prefix branch
/// lowercases only the first segment and re-joins the rest — empty segments
/// collapse the way `split('/').filter(Boolean)` collapses them in JS.
pub fn is_routable_path(path: &str, pattern: &RoutePattern) -> bool {
    match pattern {
        RoutePattern::Exact(route) => {
            if path == *route {
                return true;
            }
            let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
            let Some(first) = segments.first() else {
                return false;
            };
            let network = first.to_ascii_lowercase();
            (network == "mainnet" || network == "testnet")
                && format!("/{}", segments[1..].join("/")) == *route
        }
        // `/\/marker\/.+/` — an unanchored regex needs the marker anywhere
        // with at least one following character (`.` never matches a newline;
        // a URL pathname percent-encodes those away).
        RoutePattern::Suffix(marker) => path
            .find(marker)
            .is_some_and(|idx| idx + marker.len() < path.len()),
    }
}

fn action_of(payload: &Json) -> Option<&str> {
    let Json::Object(map) = payload else {
        return None;
    };
    // `const action = payload.action; if (action) ...` — truthy string only;
    // a number or empty string falls through exactly like in JS.
    match map.get("action") {
        Some(Json::String(s)) if !s.is_empty() => Some(s),
        _ => None,
    }
}

/// `resolveCapability`: path first (first registry hit wins), then the
/// payload's `action` against the declaring capabilities.
pub fn resolve_capability(path: &str, payload: &Json) -> Option<Resolved> {
    for capability in CAPABILITIES {
        if is_routable_path(path, &capability.pattern) {
            return Some(Resolved {
                capability,
                matched_by: MatchedBy::Path,
            });
        }
    }
    if let Some(action) = action_of(payload) {
        for capability in CAPABILITIES {
            if capability.actions.contains(&action) {
                return Some(Resolved {
                    capability,
                    matched_by: MatchedBy::Action,
                });
            }
        }
    }
    None
}

/// `resolveRouteName` — the capability id, or `None` where JS returns `''`
/// (the overload guard's falsy check reads the same through `Option`).
pub fn resolve_route_name(path: &str, payload: &Json) -> Option<&'static str> {
    resolve_capability(path, payload).map(|resolved| resolved.capability.id)
}

/// `listCapabilityFeatures` — the `/health` feature list, in registry order.
pub fn list_capability_features() -> Vec<&'static str> {
    CAPABILITIES.iter().map(|c| c.feature_path).collect()
}

/// Registry lookup by id — the JS exposes no such helper, but the lanes and
/// the guard table need id-based access (`MORPHEUS_MAX_INFLIGHT_<ID>` names a
/// capability id, not a path).
pub fn capability_by_id(id: &str) -> Option<&'static CapabilityRoute> {
    CAPABILITIES.iter().find(|c| c.id == id)
}
