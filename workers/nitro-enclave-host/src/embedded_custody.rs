//! In-process transport for the existing custody wire contract. The caller
//! still supplies its credential, and the signer router still authenticates,
//! applies policy and commits durable state before returning a signature.
//! This adapter has no socket client, signing primitive or alternate vault.

use axum::body::{to_bytes, Body};
use axum::http::{header, Request};
use axum::Router;
use tower::ServiceExt;

use crate::custody::{CustodyReply, CustodyRequest, CustodyTransport};

pub const MAX_CUSTODY_BODY_BYTES: usize = 256 * 1024;

/// A private, non-listening address used only to preserve CustodySigner's URL
/// contract. Each transport is permanently bound to one network and router;
/// a provisioned URL cannot select the other network or an external service.
pub fn embedded_base_url(network: &str) -> Result<String, &'static str> {
    if !matches!(network, "mainnet" | "testnet") {
        return Err("invalid embedded custody network");
    }
    Ok(format!("http://127.0.0.1:0/{network}"))
}

#[derive(Clone)]
pub struct InProcessCustodyTransport {
    prefix: String,
    router: Router,
    internal_raw: Option<crate::custody_bootstrap::InternalRawBridge>,
    internal_semantic: Option<crate::custody_bootstrap::InternalSemanticBridge>,
}

impl InProcessCustodyTransport {
    /// The router must be obtained from the attested custody runtime. Its
    /// cloned state must retain the runtime's process lease for its lifetime.
    pub fn new(network: &str, router: Router) -> Result<Self, &'static str> {
        Ok(Self {
            prefix: embedded_base_url(network)?,
            router,
            internal_raw: None,
            internal_semantic: None,
        })
    }

    /// This typed handle can only originate in a measured custody runtime.
    pub fn with_internal_raw(
        mut self,
        bridge: crate::custody_bootstrap::InternalRawBridge,
    ) -> Result<Self, &'static str> {
        if self.prefix != embedded_base_url("mainnet")? {
            return Err("internal raw migration requires mainnet");
        }
        self.internal_raw = Some(bridge);
        Ok(self)
    }

    /// Supplied only by the measured v2 runtime, never by provisioning.
    pub fn with_internal_semantic(
        mut self,
        bridge: crate::custody_bootstrap::InternalSemanticBridge,
    ) -> Result<Self, &'static str> {
        if self.prefix != embedded_base_url("mainnet")? || self.internal_raw.is_none() {
            return Err("internal semantic migration requires the mainnet raw migration handle");
        }
        self.internal_semantic = Some(bridge);
        Ok(self)
    }

    fn request(&self, request: CustodyRequest) -> Result<Request<Body>, String> {
        let path = request
            .url
            .strip_prefix(&self.prefix)
            .filter(|path| allowed_path(request.method, path))
            .ok_or_else(|| "embedded custody route is not permitted".to_string())?;
        // Compare the original URL, without URL normalization. Encoded/dot
        // paths, query selectors, userinfo and sibling prefixes cannot become
        // an allowed endpoint after parsing.
        let body = request
            .body
            .map(|value| serde_json::to_vec(&value))
            .transpose()
            .map_err(|_| "invalid custody request body".to_string())?
            .unwrap_or_default();
        if body.len() > MAX_CUSTODY_BODY_BYTES {
            return Err("custody request body exceeds limit".to_string());
        }
        let mut builder = Request::builder()
            .method(request.method)
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(token) = request.token.filter(|value| !value.is_empty()) {
            let value = axum::http::HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|_| "invalid custody credential header".to_string())?;
            builder = builder.header(header::AUTHORIZATION, value);
        }
        builder
            .body(Body::from(body))
            .map_err(|_| "invalid custody request".to_string())
    }

    /// The async seam is also used by local integration tests. The production
    /// synchronous caller runs on the host's blocking pool; that pool must
    /// retain separate capacity for the custody router's own blocking tasks.
    pub async fn send_async(&self, request: CustodyRequest) -> Result<CustodyReply, String> {
        let request = self.request(request)?;
        let semantic = self
            .internal_semantic
            .as_ref()
            .filter(|_| request.uri().path() == "/signer/api/v1/sign/transaction");
        let response = match (semantic, &self.internal_raw) {
            (Some(bridge), _) => bridge.dispatch(request).await.map_err(str::to_string)?,
            (None, Some(bridge)) => bridge.dispatch(request).await.map_err(str::to_string)?,
            (None, None) => self
                .router
                .clone()
                .oneshot(request)
                .await
                .expect("Router's error type is Infallible"),
        };
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), MAX_CUSTODY_BODY_BYTES)
            .await
            .map_err(|_| "invalid or oversized custody response".to_string())?;
        let body = serde_json::from_slice(&bytes)
            .map_err(|_| "custody response is not JSON".to_string())?;
        Ok(CustodyReply { status, body })
    }
}

impl CustodyTransport for InProcessCustodyTransport {
    fn has_private_raw_lane(&self) -> bool {
        self.internal_raw.is_some()
    }

    fn has_private_semantic_lane(&self) -> bool {
        self.internal_semantic.is_some()
    }

    fn send(&self, request: CustodyRequest) -> Result<CustodyReply, String> {
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| "embedded custody requires the host runtime".to_string())?;
        runtime.block_on(self.send_async(request))
    }
}

fn allowed_path(method: &str, path: &str) -> bool {
    match method {
        "POST" => matches!(
            path,
            "/signer/api/v1/sign/raw"
                | "/signer/api/v1/sign/transaction"
                | "/signer/api/v1/sign/eip191-fulfillment"
        ),
        "GET" => path.strip_prefix("/signer/api/v1/keys/").is_some_and(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        }),
        _ => false,
    }
}

#[cfg(test)]
#[path = "../tests/unit/embedded_custody.rs"]
mod tests;
