//! Explicit boundary for fulfillment lanes that have not migrated to the
//! in-process Rust compute plane.
//!
//! Production never performs loopback IO and never starts a Node child. The
//! remaining [`BridgePlane`] name is a temporary compatibility seam used by
//! fulfillment tests while their canned compute responses are kept separate
//! from digest/signature assertions. The production implementation always
//! returns one deterministic refusal-shaped compute reply.

use crate::state::{BridgePlane, BridgeReply};
use crate::RUNTIME_NAME;

pub const UNAVAILABLE_CODE: &str = "rust-compute-lane-unavailable";

#[derive(Debug, Clone, Copy, Default)]
pub struct UnavailableLegacyCompute;

pub fn unavailable_reply(route: &str) -> BridgeReply {
    BridgeReply {
        ok: false,
        status: 503,
        body: serde_json::json!({
            "status": "error",
            "code": UNAVAILABLE_CODE,
            "error": format!("the {route} fulfillment lane has not migrated to Rust"),
            "runtime": RUNTIME_NAME,
        }),
    }
}

impl BridgePlane for UnavailableLegacyCompute {
    fn forward(
        &self,
        route: &str,
        _payload: &serde_json::Value,
        _auth_token: Option<&str>,
    ) -> BridgeReply {
        unavailable_reply(route)
    }
}

#[cfg(test)]
#[path = "../tests/unit/bridge.rs"]
mod tests;
