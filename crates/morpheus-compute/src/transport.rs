//! Transport-agnostic HTTP request/response shapes for the oracle egress lane.
//!
//! `workers/nitro-worker` reaches the network through undici (`fetch`) with a
//! 15s request timeout on the RPC/claim paths and a dispatcher-pinned
//! `undici.fetch` on the oracle-fetch path. The pure lanes here take an
//! injected [`HttpTransport`] so fixtures can stub the wire; [`reqwest_transport`]
//! is the enclave-side implementation.

/// One outbound request. `headers` preserve insertion order (the claim PATCH
/// and the provider fetches copy fixed header sets).
pub struct HttpRequest {
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    pub timeout_ms: u64,
    /// `redirect: 'error'` on the oracle-fetch path (a 30x must never be
    /// followed — the SSRF checks only ran against the original URL);
    /// plain fetch on the RPC/claim paths follows redirects.
    pub follow_redirects: bool,
}

#[derive(Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// Errors are opaque transport failures (DNS, refused, reset, timeout). The
/// oracle lane re-classifies the message with `to_upstream_transport_error`.
pub type HttpTransport<'a> = &'a dyn Fn(&HttpRequest) -> Result<HttpResponse, String>;

/// Blocking reqwest implementation. A fresh client per request mirrors the
/// `AbortSignal.timeout` semantics; dispatcher/keep-alive pooling is a host
/// concern, not a parity one.
pub fn reqwest_transport() -> impl Fn(&HttpRequest) -> Result<HttpResponse, String> {
    |request: &HttpRequest| -> Result<HttpResponse, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_millis(request.timeout_ms))
            .redirect(if request.follow_redirects {
                reqwest::redirect::Policy::limited(10)
            } else {
                reqwest::redirect::Policy::none()
            })
            .build()
            .map_err(|error| error.to_string())?;
        let method =
            reqwest::Method::from_bytes(request.method.as_bytes()).expect("valid HTTP method");
        let mut builder = client.request(method, &request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = &request.body {
            builder = builder.body(body.clone());
        }
        // `AbortSignal.timeout` aborts render as a TimeoutError in JS; the
        // oracle lane classifies timeouts by the "timed out" wording, so the
        // concrete transport must produce it.
        let send = builder
            .send()
            .and_then(|response| {
                let status = response.status().as_u16();
                let headers = response
                    .headers()
                    .iter()
                    .map(|(name, value)| {
                        (
                            name.as_str().to_string(),
                            value.to_str().unwrap_or_default().to_string(),
                        )
                    })
                    .collect();
                let body = response.bytes()?.to_vec();
                Ok((status, headers, body))
            })
            .map_err(|error| {
                if error.is_timeout() {
                    format!("oracle fetch timed out after {}ms", request.timeout_ms)
                } else {
                    error.to_string()
                }
            })?;
        let (status, headers, body) = send;
        Ok(HttpResponse {
            status,
            headers,
            body,
        })
    }
}

/// `readResponseTextWithLimit(response, maxBytes, label)` (platform/core.js) —
/// the body must fit the byte cap, then decodes as UTF-8 (lossy, matching
/// Buffer's replacement-char behavior on malformed sequences).
pub fn read_response_text_with_limit(
    response: &HttpResponse,
    max_bytes: usize,
    label: &str,
) -> Result<String, String> {
    if response.body.len() > max_bytes {
        return Err(format!("{label} exceeds max size of {max_bytes} bytes"));
    }
    Ok(String::from_utf8_lossy(&response.body).into_owned())
}
