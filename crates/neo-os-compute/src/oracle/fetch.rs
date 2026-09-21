//! Port of the pure half of `workers/nitro-worker/src/oracle/fetch.js` — the
//! ORACLE_HTTP_ALLOWLIST gate, `normalizeOracleUrl`, the D4 upstream-error
//! shaping (`UpstreamFetchError` classification), and `performOracleFetch`.
//! The egress itself (`fetchWithTimeout` + dispatcher pinning) stays behind
//! the injected [`crate::transport::HttpTransport`]; `buildOracleResponse`
//! lands with the programmable lanes (5e/5f) and the chain signed envelopes.

use serde_json::Value as Json;
use url::Url;

use crate::core::{
    capped_duration_ms, get_json_path_value, parse_body_maybe, read_env, resolve_max_bytes,
    EnvReader, JsHeaders,
};
use crate::js::{js_first_truthy, js_stringify, js_trim, js_trim_string, js_truthy};
use crate::oracle::crypto::{
    decrypt_encrypted_token, resolve_encrypted_token_ciphertext, OracleKeyMaterial,
};
use crate::oracle::providers::{
    build_provider_request, fetch_provider_json, resolve_provider_payload, ProviderIo,
    ProviderRuntime,
};
use crate::ssrf::{assert_resolved_host_allowed, resolve_pinned_addresses, DnsLookup};
use crate::transport::{read_response_text_with_limit, HttpRequest};

/// The refusal a production enclave gives when no destination policy reached
/// it. Distinct from the not-in-list refusal so an operator can tell "the
/// image shipped without an allowlist" from "this URL is not allowed".
pub const ALLOWLIST_UNCONFIGURED_REFUSAL: &str =
    "ORACLE_HTTP_ALLOWLIST is unset — production egress has no in-enclave destination policy";

/// `assertUrlInAllowlist(parsedUrl)` — when `ORACLE_HTTP_ALLOWLIST` is set,
/// the URL must match an entry's origin and (unless the entry's path is empty
/// or `/`) be the entry path or a descendant of it.
///
/// SVC-C-2 (CL-24/CL-25). An unset allowlist used to be an OPEN gate, which
/// made the host-side `vsock-proxy.allowlist.yaml` the only destination
/// policy in the system — and that file says of itself that it is "NOT baked
/// into the measured enclave image … so it can be tuned operationally without
/// changing the enclave PCRs". An operator could therefore add a destination,
/// restart the host proxy, and have the enclave decrypt a stored third-party
/// credential into a request aimed at it, with no PCR change a remote
/// verifier could see. The value must reach the enclave through the measured
/// image (`ENV ORACLE_HTTP_ALLOWLIST=…` in `deploy/nitro/Dockerfile.enclave`,
/// which lands in PCR2), so widening it becomes an EIF rebuild and a
/// measurement republish — the point of the control.
///
/// Unset stays an open gate OUTSIDE production so local runs and the
/// Node-parity fixtures keep working; in production it fails closed, the same
/// shape `message_reveal::decrypt_binding_required` already uses to
/// production-lock the decrypt binding.
pub fn assert_url_in_allowlist(parsed_url: &Url, env: EnvReader<'_>) -> Result<(), String> {
    let raw_allowlist = read_env(env, &["ORACLE_HTTP_ALLOWLIST"]);
    let is_production = read_env(env, &["NODE_ENV"]).to_lowercase() == "production";
    if raw_allowlist.is_empty() {
        if is_production {
            return Err(ALLOWLIST_UNCONFIGURED_REFUSAL.to_string());
        }
        return Ok(());
    }
    let allowlist: Vec<&str> = raw_allowlist
        .split(',')
        .map(js_trim)
        .filter(|entry| !entry.is_empty())
        .collect();
    if allowlist.is_empty() {
        if is_production {
            return Err(ALLOWLIST_UNCONFIGURED_REFUSAL.to_string());
        }
        return Ok(());
    }
    for entry in allowlist {
        let Ok(allowed_url) = Url::parse(entry) else {
            continue;
        };
        if allowed_url.origin().ascii_serialization() != parsed_url.origin().ascii_serialization() {
            continue;
        }
        let allowed_path = allowed_url.path().trim_end_matches('/').to_string();
        if allowed_path.is_empty() || allowed_path == "/" {
            return Ok(());
        }
        if parsed_url.path() == allowed_path
            || parsed_url.path().starts_with(&format!("{allowed_path}/"))
        {
            return Ok(());
        }
    }
    Err("url is not in ORACLE_HTTP_ALLOWLIST".to_string())
}

/// `normalizeOracleUrl(rawUrl, { validateHost })` — trim, parse, force http(s),
/// resolve+validate the host (fail-closed SSRF classifier), then apply the
/// allowlist. Returns the normalized URL serialization.
pub fn normalize_oracle_url(
    raw_url: &Json,
    validate_host: bool,
    env: EnvReader<'_>,
    dns: DnsLookup<'_>,
) -> Result<String, String> {
    let parsed_url =
        Url::parse(&js_trim_string(Some(raw_url))).map_err(|_| "Invalid URL".to_string())?;
    if parsed_url.scheme() != "http" && parsed_url.scheme() != "https" {
        return Err("url must use http or https".to_string());
    }
    if validate_host {
        // JS `URL.hostname` strips IPv6 brackets; the url crate keeps them in
        // host_str().
        let host = parsed_url.host_str().unwrap_or("");
        let host = host
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
            .unwrap_or(host);
        assert_resolved_host_allowed(&Json::String(host.to_string()), dns)?;
    }
    assert_url_in_allowlist(&parsed_url, env)?;
    Ok(parsed_url.to_string())
}

/// D4 — typed upstream failure so `oracle.query` / `oracle.smart-fetch` can
/// surface an upstream data-source failure as a gateway error (502/504) with a
/// stable machine-readable `kind`, instead of a misleading 400.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpstreamFetchError {
    pub message: String,
    pub http_status: u16,
    pub kind: UpstreamErrorKind,
    pub upstream_status: Option<u16>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpstreamErrorKind {
    UpstreamError,
    UpstreamTimeout,
    UpstreamUnreachable,
    UpstreamHttpError,
}

impl UpstreamErrorKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            UpstreamErrorKind::UpstreamError => "upstream_error",
            UpstreamErrorKind::UpstreamTimeout => "upstream_timeout",
            UpstreamErrorKind::UpstreamUnreachable => "upstream_unreachable",
            UpstreamErrorKind::UpstreamHttpError => "upstream_http_error",
        }
    }
}

impl UpstreamFetchError {
    pub fn new(
        message: impl Into<String>,
        http_status: u16,
        kind: UpstreamErrorKind,
        upstream_status: Option<u16>,
    ) -> Self {
        UpstreamFetchError {
            message: message.into(),
            http_status,
            kind,
            upstream_status,
        }
    }
}

/// `isTimeoutError(error)` — the injected transport renders its own timeouts
/// with a "timed out" message (see `transport::reqwest_transport`); the JS
/// name checks (`TimeoutError`/`AbortError`) are runtime-specific.
pub fn is_timeout_error(message: &str) -> bool {
    message.to_lowercase().contains("timed out")
}

fn is_caller_url_problem(message: &str) -> bool {
    let lowered = message.to_lowercase();
    lowered.contains("not allowed")
        || lowered.contains("must use http")
        || lowered.contains("not in oracle_http_allowlist")
}

/// What `toUpstreamTransportError` hands the handler: a caller-fixable URL
/// problem keeps its 400-class semantics; everything else is a gateway fault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportFailure {
    /// Caller-supplied URL problem — surface as-is.
    CallerUrl(String),
    Upstream(UpstreamFetchError),
}

/// `toUpstreamTransportError(error)` — wrap a raw transport error (DNS,
/// connection refused, reset, timeout, SSRF rejection) into the typed gateway
/// error. SSRF/validation rejections are caller-fixable and pass through.
pub fn to_upstream_transport_error(message: String) -> TransportFailure {
    if is_caller_url_problem(&message) {
        return TransportFailure::CallerUrl(message);
    }
    if is_timeout_error(&message) {
        return TransportFailure::Upstream(UpstreamFetchError::new(
            message,
            504,
            UpstreamErrorKind::UpstreamTimeout,
            None,
        ));
    }
    TransportFailure::Upstream(UpstreamFetchError::new(
        message,
        502,
        UpstreamErrorKind::UpstreamUnreachable,
        None,
    ))
}

fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        ' ' | '\t' | '\n' | '\r' | '\x0b' | '\x0c' | '\u{00a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `buildUpstreamErrorMessage(source, status, data, rawResponse)` — the body is
/// the string data, the JSON-stringified object data, or the raw response; all
/// JS whitespace runs collapse to single spaces and the detail is capped at
/// 180 characters. (The cap counts `char`s; JS counts UTF-16 code units — the
/// two differ only for astral-plane characters in upstream error bodies.)
pub fn build_upstream_error_message(
    source: &str,
    status: u16,
    data: &Json,
    raw_response: &str,
) -> String {
    let body = match data {
        Json::String(text) => text.clone(),
        // JSON.stringify(data) — NOT String(data) ("[object Object]")
        value if value.is_object() => value.to_string(),
        _ => raw_response.to_string(),
    };
    let mut compact = String::new();
    let mut in_run = false;
    for c in js_trim(&body).chars() {
        if is_js_whitespace(c) {
            if !in_run {
                compact.push(' ');
                in_run = true;
            }
        } else {
            compact.push(c);
            in_run = false;
        }
    }
    let detail = if compact.is_empty() {
        String::new()
    } else {
        format!(": {}", compact.chars().take(180).collect::<String>())
    };
    format!("{source} upstream returned HTTP {status}{detail}")
}

/// `performOracleFetch`'s resolved fetch result (fetch.js:309) — everything
/// `buildOracleResponse` consumes downstream.
#[derive(Debug, Clone, PartialEq)]
pub struct FetchOutcome {
    pub upstream_status: u16,
    pub upstream_headers: Json,
    pub raw_response: String,
    pub data: Json,
    pub selected_value: Option<Json>,
    pub provider: Option<String>,
    pub provider_pair: Option<String>,
    pub encrypted_token_present: bool,
}

/// `performOracleFetch(payload)` (fetch.js:213) — resolve the provider lane
/// (falling back to twelvedata when a symbol rides without a URL) or the
/// direct-URL lane, and shape the raw fetch result. Every failure surfaces as
/// a [`TransportFailure`]: errors the JS handler rethrows as 400-class plain
/// errors (URL/config problems, SSRF rejections, body-cap overflow) arrive as
/// [`TransportFailure::CallerUrl`]; timeouts and unreachable upstreams arrive
/// typed for the 502/504 gateway mapping (D4).
///
/// The encrypted-token key resolution is the caller's (host) concern, mirroring
/// `decryptEncryptedToken`'s JS singleton.
pub fn perform_oracle_fetch(
    payload: &Json,
    key_material: &OracleKeyMaterial,
    io: &ProviderIo<'_>,
    runtime: &mut ProviderRuntime,
) -> Result<FetchOutcome, TransportFailure> {
    let options = {
        let no_url = !payload.get("url").is_some_and(js_truthy);
        let has_symbol = payload.get("symbol").is_some_and(js_truthy);
        let fallback_provider_id = if no_url && has_symbol {
            Json::String("twelvedata".to_string())
        } else {
            Json::Null
        };
        serde_json::json!({ "fallbackProviderId": fallback_provider_id })
    };
    let (resolved, _provider_config) =
        resolve_provider_payload(payload, &options, io.env, io.transport, runtime, io.now_ms)
            .map_err(TransportFailure::CallerUrl)?;

    let timeout_source = resolved
        .get("oracle_timeout_ms")
        .filter(|value| js_truthy(value))
        .or_else(|| {
            resolved
                .get("fetch_timeout_ms")
                .filter(|value| js_truthy(value))
        })
        .cloned()
        .or_else(|| {
            let raw = read_env(io.env, &["ORACLE_TIMEOUT"]);
            (!raw.is_empty()).then_some(Json::String(raw))
        });
    let timeout_ms = capped_duration_ms(timeout_source.as_ref(), 8_000, 10_000);

    let max_body_bytes = resolve_max_bytes(
        Some(&Json::String(read_env(
            io.env,
            &["ORACLE_MAX_UPSTREAM_BODY_BYTES"],
        ))),
        256 * 1024,
        4_096,
    ) as usize;

    let provider_request =
        build_provider_request(&resolved, io.env).map_err(TransportFailure::CallerUrl)?;
    if let Some(request) = provider_request {
        let response = match fetch_provider_json(&request, timeout_ms, io, runtime) {
            Ok(response) => response,
            Err(error) => return Err(to_upstream_transport_error(error)),
        };
        // `response.data ?? response.text`
        let data = if response.data.is_null() {
            Json::String(response.text.clone())
        } else {
            response.data.clone()
        };
        if !response.ok {
            return Err(TransportFailure::Upstream(UpstreamFetchError::new(
                build_upstream_error_message(
                    &request.provider,
                    response.status,
                    &data,
                    &response.text,
                ),
                if response.status == 504 { 504 } else { 502 },
                UpstreamErrorKind::UpstreamHttpError,
                Some(response.status),
            )));
        }
        let selected_value =
            get_json_path_value(&data, resolved.get("json_path").unwrap_or(&Json::Null));
        return Ok(FetchOutcome {
            upstream_status: response.status,
            upstream_headers: response.headers.clone(),
            raw_response: response.text.clone(),
            data,
            selected_value,
            provider: Some(request.provider.clone()),
            provider_pair: (!request.pair.is_empty()).then(|| request.pair.clone()),
            encrypted_token_present: false,
        });
    }

    let url = normalize_oracle_url(
        resolved.get("url").unwrap_or(&Json::Null),
        false,
        io.env,
        io.dns,
    )
    .map_err(TransportFailure::CallerUrl)?;

    let encrypted_token_ciphertext =
        resolve_encrypted_token_ciphertext(&resolved, io.env, io.transport)
            .map_err(TransportFailure::CallerUrl)?;
    let decrypted_token = decrypt_encrypted_token(&encrypted_token_ciphertext, key_material)
        .map_err(TransportFailure::CallerUrl)?;

    let mut headers = JsHeaders::normalize(resolved.get("headers").unwrap_or(&Json::Null));
    let token_header = {
        let raw = js_first_truthy(&resolved, &["token_header"])
            .cloned()
            .unwrap_or(Json::String("Authorization".to_string()));
        let trimmed = js_trim_string(Some(&raw));
        if trimmed.is_empty() {
            "Authorization".to_string()
        } else {
            trimmed
        }
    };
    if let Some(token) = &decrypted_token {
        let token_prefix = if let Some(prefix) = resolved.get("token_prefix") {
            js_stringify(prefix)
        } else if token_header.to_lowercase() == "authorization" {
            "Bearer ".to_string()
        } else {
            String::new()
        };
        headers.set(&token_header, &format!("{token_prefix}{token}"));
    }

    // `fetchWithTimeout` resolves + validates the host on every request; the
    // pinning itself is a host concern, so this re-validation is the boundary.
    let parsed_url =
        Url::parse(&url).map_err(|_| TransportFailure::CallerUrl("Invalid URL".into()))?;
    let hostname = parsed_url.host_str().unwrap_or_default().to_string();
    resolve_pinned_addresses(&Json::String(hostname), io.allow_unresolved, io.dns)
        .map_err(to_upstream_transport_error)?;

    let request = HttpRequest {
        url: url.clone(),
        method: js_first_truthy(&resolved, &["method"])
            .map(js_stringify)
            .unwrap_or_else(|| "GET".to_string()),
        headers: headers.entries().to_vec(),
        body: match resolved.get("body") {
            Some(Json::String(text)) => Some(text.clone().into_bytes()),
            _ => None,
        },
        timeout_ms,
        // `redirect: 'error'` — a 30x must never be followed (the SSRF checks
        // only ran against the original URL).
        follow_redirects: false,
    };
    let response = match (io.transport)(&request) {
        Ok(response) => response,
        Err(error) => {
            let error = if is_timeout_error(&error) {
                format!("oracle fetch timed out after {timeout_ms}ms")
            } else {
                error
            };
            return Err(to_upstream_transport_error(error));
        }
    };

    let raw_response =
        read_response_text_with_limit(&response, max_body_bytes, "oracle upstream response")
            .map_err(TransportFailure::CallerUrl)?;
    let upstream_headers = {
        // `Object.fromEntries(response.headers.entries())` — no normalization.
        let mut map = serde_json::Map::new();
        for (name, value) in &response.headers {
            map.insert(name.clone(), Json::String(value.clone()));
        }
        Json::Object(map)
    };
    let content_type = response
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-type"))
        .map(|(_, value)| value.as_str());
    // `parseBodyMaybe(...) ?? rawResponse` — JS `??` also collapses a parsed
    // `null` body to the raw text.
    let data = match parse_body_maybe(&raw_response, content_type) {
        Some(Json::Null) | None => Json::String(raw_response.clone()),
        Some(value) => value,
    };

    if !(200..300).contains(&response.status) {
        return Err(TransportFailure::Upstream(UpstreamFetchError::new(
            build_upstream_error_message(&url, response.status, &data, &raw_response),
            if response.status == 504 { 504 } else { 502 },
            UpstreamErrorKind::UpstreamHttpError,
            Some(response.status),
        )));
    }
    let selected_value =
        get_json_path_value(&data, resolved.get("json_path").unwrap_or(&Json::Null));

    Ok(FetchOutcome {
        upstream_status: response.status,
        upstream_headers,
        raw_response,
        data,
        selected_value,
        provider: None,
        provider_pair: None,
        encrypted_token_present: decrypted_token.is_some(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oracle::crypto::format_key_material;
    use crate::ssrf::ResolvedAddress;
    use crate::transport::HttpResponse;
    use serde_json::json;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::rc::Rc;

    fn env_from(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |name: &str| map.get(name).cloned()
    }

    fn no_dns() -> DnsLookup<'static> {
        &|_host| Err(())
    }

    #[test]
    fn allowlist_unset_or_blank_is_an_open_gate_outside_production() {
        let url = Url::parse("https://api.example.com/v1/x").unwrap();
        assert!(assert_url_in_allowlist(&url, &env_from(&[])).is_ok());
        assert!(
            assert_url_in_allowlist(&url, &env_from(&[("ORACLE_HTTP_ALLOWLIST", "  ")])).is_ok()
        );
        // entries that do not parse are skipped, not fatal
        assert!(assert_url_in_allowlist(
            &url,
            &env_from(&[("ORACLE_HTTP_ALLOWLIST", "not-a-url,https://other.com")])
        )
        .is_err());
    }

    /// SVC-C-2: in production an absent (or all-blank) allowlist is a
    /// refusal, not an open gate — otherwise the only destination policy in
    /// the system is the host-owned YAML the operator can widen without
    /// touching a PCR. A configured list still works exactly as before, so
    /// the production lock costs nothing once the value is baked into the
    /// measured image.
    #[test]
    fn production_refuses_an_unconfigured_allowlist_instead_of_opening_the_gate() {
        let url = Url::parse("https://api.example.com/v1/x").unwrap();
        for blank in ["", "  ", " , ,"] {
            let env = env_from(&[("NODE_ENV", "production"), ("ORACLE_HTTP_ALLOWLIST", blank)]);
            assert_eq!(
                assert_url_in_allowlist(&url, &env).unwrap_err(),
                ALLOWLIST_UNCONFIGURED_REFUSAL,
                "blank allowlist {blank:?} must fail closed in production",
            );
        }
        // Unset entirely is the same refusal.
        assert_eq!(
            assert_url_in_allowlist(&url, &env_from(&[("NODE_ENV", "production")])).unwrap_err(),
            ALLOWLIST_UNCONFIGURED_REFUSAL,
        );
        // A configured list is unaffected by the production lock.
        let env = env_from(&[
            ("NODE_ENV", "production"),
            ("ORACLE_HTTP_ALLOWLIST", "https://api.example.com/v1"),
        ]);
        assert!(assert_url_in_allowlist(&url, &env).is_ok());
        let denied = Url::parse("https://evil.example.com/v1/x").unwrap();
        assert_eq!(
            assert_url_in_allowlist(&denied, &env).unwrap_err(),
            "url is not in ORACLE_HTTP_ALLOWLIST",
        );
    }

    #[test]
    fn allowlist_matches_origins_and_path_descendants() {
        let env = env_from(&[("ORACLE_HTTP_ALLOWLIST", "https://api.example.com/v1")]);
        let url = Url::parse("https://api.example.com/v1/x").unwrap();
        assert!(assert_url_in_allowlist(&url, &env).is_ok());
        // exact path
        let url = Url::parse("https://api.example.com/v1").unwrap();
        assert!(assert_url_in_allowlist(&url, &env).is_ok());
        // sibling path is refused
        let url = Url::parse("https://api.example.com/v2/x").unwrap();
        assert_eq!(
            assert_url_in_allowlist(&url, &env).unwrap_err(),
            "url is not in ORACLE_HTTP_ALLOWLIST"
        );
        // a path that merely starts with the same text is not a descendant
        let url = Url::parse("https://api.example.com/v10/x").unwrap();
        assert!(assert_url_in_allowlist(&url, &env).is_err());
        // origin mismatch
        let url = Url::parse("https://evil.example.com/v1/x").unwrap();
        assert!(assert_url_in_allowlist(&url, &env).is_err());
        // scheme mismatch
        let url = Url::parse("http://api.example.com/v1/x").unwrap();
        assert!(assert_url_in_allowlist(&url, &env).is_err());
        // root-path entry allows the whole origin
        let env = env_from(&[("ORACLE_HTTP_ALLOWLIST", "https://api.example.com/")]);
        let url = Url::parse("https://api.example.com/anything").unwrap();
        assert!(assert_url_in_allowlist(&url, &env).is_ok());
        // trailing slashes on the entry are normalized away
        let env = env_from(&[("ORACLE_HTTP_ALLOWLIST", "https://api.example.com/v1///")]);
        let url = Url::parse("https://api.example.com/v1/deep").unwrap();
        assert!(assert_url_in_allowlist(&url, &env).is_ok());
    }

    #[test]
    fn normalize_enforces_scheme_host_and_allowlist() {
        assert_eq!(
            normalize_oracle_url(
                &json!("  https://api.example.com/v1  "),
                false,
                &env_from(&[]),
                no_dns()
            )
            .unwrap(),
            "https://api.example.com/v1"
        );
        assert_eq!(
            normalize_oracle_url(
                &json!("ftp://api.example.com"),
                false,
                &env_from(&[]),
                no_dns()
            )
            .unwrap_err(),
            "url must use http or https"
        );
        assert_eq!(
            normalize_oracle_url(&json!("not a url"), false, &env_from(&[]), no_dns()).unwrap_err(),
            "Invalid URL"
        );
        // validateHost routes through the fail-closed classifier
        assert_eq!(
            normalize_oracle_url(
                &json!("https://127.0.0.1/x"),
                true,
                &env_from(&[]),
                no_dns()
            )
            .unwrap_err(),
            "private/internal URLs not allowed"
        );
        // an unresolvable host is lenient at validation time
        assert!(normalize_oracle_url(
            &json!("https://unresolved.example/x"),
            true,
            &env_from(&[]),
            no_dns()
        )
        .is_ok());
        // allowlist still applies after host validation
        let env = env_from(&[("ORACLE_HTTP_ALLOWLIST", "https://api.example.com")]);
        assert_eq!(
            normalize_oracle_url(&json!("https://other.example.com"), true, &env, no_dns())
                .unwrap_err(),
            "url is not in ORACLE_HTTP_ALLOWLIST"
        );
    }

    #[test]
    fn transport_failures_classify_into_400_and_gateway_classes() {
        // caller-fixable URL problems keep their message
        assert_eq!(
            to_upstream_transport_error("url is not in ORACLE_HTTP_ALLOWLIST".to_string()),
            TransportFailure::CallerUrl("url is not in ORACLE_HTTP_ALLOWLIST".to_string())
        );
        assert!(matches!(
            to_upstream_transport_error("private/internal URLs not allowed".to_string()),
            TransportFailure::CallerUrl(_)
        ));
        assert!(matches!(
            to_upstream_transport_error("url must use http or https".to_string()),
            TransportFailure::CallerUrl(_)
        ));
        // timeouts are 504 / upstream_timeout
        assert_eq!(
            to_upstream_transport_error("oracle fetch timed out after 8000ms".to_string()),
            TransportFailure::Upstream(UpstreamFetchError::new(
                "oracle fetch timed out after 8000ms",
                504,
                UpstreamErrorKind::UpstreamTimeout,
                None
            ))
        );
        assert!(is_timeout_error("oracle fetch timed out after 8000ms"));
        assert!(!is_timeout_error("dns error"));
        // everything else is 502 / upstream_unreachable
        assert_eq!(
            to_upstream_transport_error("connection refused".to_string()),
            TransportFailure::Upstream(UpstreamFetchError::new(
                "connection refused",
                502,
                UpstreamErrorKind::UpstreamUnreachable,
                None
            ))
        );
    }

    #[test]
    fn upstream_error_messages_collapse_whitespace_and_cap_the_detail() {
        assert_eq!(
            build_upstream_error_message("https://api.example.com/x", 500, &json!("boom"), ""),
            "https://api.example.com/x upstream returned HTTP 500: boom"
        );
        // object data is JSON.stringify'd
        assert_eq!(
            build_upstream_error_message("src", 502, &json!({"error":"bad"}), "raw"),
            "src upstream returned HTTP 502: {\"error\":\"bad\"}"
        );
        // non-string non-object data falls back to the raw response
        assert_eq!(
            build_upstream_error_message("src", 500, &json!(7), "raw text"),
            "src upstream returned HTTP 500: raw text"
        );
        // whitespace runs collapse; leading/trailing whitespace is trimmed
        assert_eq!(
            build_upstream_error_message("src", 500, &json!("  a \n\t b c  "), ""),
            "src upstream returned HTTP 500: a b c"
        );
        // 180-character detail cap
        let long = "x".repeat(300);
        let message = build_upstream_error_message("src", 500, &json!(long.clone()), "");
        assert_eq!(
            message,
            format!("src upstream returned HTTP 500: {}", "x".repeat(180))
        );
        assert!(message.len() < long.len());
        // empty body → no detail
        assert_eq!(
            build_upstream_error_message("src", 503, &json!(""), "   "),
            "src upstream returned HTTP 503"
        );
    }

    // ---- perform_oracle_fetch fixtures ----

    const GOLDEN_PUBLIC_KEY_RAW_B64: &str = "vAB/ripK5xzT1PT+KGbSvEEPfGQoxQliNWjSFjDfuhU=";
    const GOLDEN_PRIVATE_KEY_PKCS8_B64: &str =
        "MC4CAQAwBQYDK2VuBCIEIEgdmKz6RqTG40pP8SVY+7XPGOUXAIbmI4alIH3uMYZ8";
    // The Node webcrypto golden envelope (crypto.rs) decrypts to
    // {"token":"golden-vector-1"} under the golden key pair.
    const GOLDEN_ENVELOPE_JSON: &str = r#"{"v":2,"alg":"X25519-HKDF-SHA256-AES-256-GCM","epk":"1C44axNdzHDw2XVn2U7/uPmX+BfTgq9H4CltjiCRGWQ=","iv":"SOSWOZ3iY82CUNz6","ct":"x4/R3xIpzySVd55wSZFWh1HnCh7nmtYIAEhT","tag":"OUAJuhSWkVm/A0rWJSkFHQ=="}"#;

    fn golden_key_material() -> OracleKeyMaterial {
        use base64::Engine as _;
        format_key_material(
            base64::engine::general_purpose::STANDARD
                .decode(GOLDEN_PUBLIC_KEY_RAW_B64)
                .unwrap(),
            base64::engine::general_purpose::STANDARD
                .decode(GOLDEN_PRIVATE_KEY_PKCS8_B64)
                .unwrap(),
            "test",
        )
    }

    fn dns_from(addresses: &[&str]) -> impl Fn(&str) -> Result<Vec<ResolvedAddress>, ()> {
        let resolved: Vec<ResolvedAddress> = addresses
            .iter()
            .map(|address| ResolvedAddress {
                address: address.to_string(),
                family: 4,
            })
            .collect();
        move |_host| Ok(resolved.clone())
    }

    fn json_response(status: u16, body: &str) -> HttpResponse {
        HttpResponse {
            status,
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body: body.as_bytes().to_vec(),
        }
    }

    fn text_response(status: u16, body: &str) -> HttpResponse {
        HttpResponse {
            status,
            headers: vec![("content-type".to_string(), "text/plain".to_string())],
            body: body.as_bytes().to_vec(),
        }
    }

    #[derive(Clone)]
    struct RecordedRequest {
        method: String,
        url: String,
        headers: Vec<(String, String)>,
        body: Option<Vec<u8>>,
        timeout_ms: u64,
        follow_redirects: bool,
    }

    fn transport_with<'a>(
        log: &'a Rc<RefCell<Vec<RecordedRequest>>>,
        response: Result<HttpResponse, String>,
    ) -> impl Fn(&HttpRequest) -> Result<HttpResponse, String> + 'a {
        move |request: &HttpRequest| {
            log.borrow_mut().push(RecordedRequest {
                method: request.method.clone(),
                url: request.url.clone(),
                headers: request.headers.clone(),
                body: request.body.clone(),
                timeout_ms: request.timeout_ms,
                follow_redirects: request.follow_redirects,
            });
            response.clone()
        }
    }

    fn oracle_io<'a>(
        env_fn: &'a dyn Fn(&str) -> Option<String>,
        dns_fn: &'a dyn Fn(&str) -> Result<Vec<ResolvedAddress>, ()>,
        transport_fn: &'a dyn Fn(&HttpRequest) -> Result<HttpResponse, String>,
        sleep_fn: &'a dyn Fn(u64),
    ) -> ProviderIo<'a> {
        ProviderIo {
            env: env_fn,
            dns: dns_fn,
            transport: transport_fn,
            now_ms: 1_000,
            sleep_ms: sleep_fn,
            allow_unresolved: false,
        }
    }

    fn recorded_header(
        log: &Rc<RefCell<Vec<RecordedRequest>>>,
        index: usize,
        name: &str,
    ) -> Option<String> {
        log.borrow()[index]
            .headers
            .iter()
            .find(|(entry_name, _)| entry_name == name)
            .map(|(_, value)| value.clone())
    }

    fn assert_caller_url_error(error: &TransportFailure, needle: &str) {
        match error {
            TransportFailure::CallerUrl(message) => {
                assert!(message.contains(needle), "got: {message}");
            }
            other => panic!("expected a caller-url failure, got: {other:?}"),
        }
    }

    #[test]
    fn plain_fetch_mode_selects_the_direct_url_lane() {
        let env_fn = env_from(&[]);
        let dns_fn = dns_from(&["93.184.216.34"]);
        let log = Rc::new(RefCell::new(Vec::<RecordedRequest>::new()));
        let transport_fn = transport_with(&log, Ok(json_response(200, r#"{"ok":true,"value":7}"#)));
        let sleep_fn = |_ms: u64| {};
        let mut runtime = ProviderRuntime::default();
        let payload = json!({"url": "https://api.example.com/plain", "target_chain": "neo_n3"});
        let io = oracle_io(&env_fn, &dns_fn, &transport_fn, &sleep_fn);

        let outcome =
            perform_oracle_fetch(&payload, &golden_key_material(), &io, &mut runtime).unwrap();
        assert_eq!(outcome.upstream_status, 200);
        assert_eq!(outcome.raw_response, r#"{"ok":true,"value":7}"#);
        assert_eq!(outcome.data.get("value"), Some(&json!(7)));
        assert_eq!(outcome.provider, None);
        assert!(!outcome.encrypted_token_present);
        assert_eq!(
            outcome.upstream_headers.get("content-type"),
            Some(&json!("application/json"))
        );

        let sent = &log.borrow()[0];
        assert_eq!(sent.method, "GET");
        assert_eq!(sent.url, "https://api.example.com/plain");
        // default capped duration, redirects refused
        assert_eq!(sent.timeout_ms, 8_000);
        assert!(!sent.follow_redirects);
    }

    #[test]
    fn builtin_provider_mode_fetches_through_the_provider_lane() {
        let env_fn = env_from(&[
            ("TWELVEDATA_API_KEY", "secret-key"),
            // the generic upstream cap must not constrain the provider lane
            ("ORACLE_MAX_UPSTREAM_BODY_BYTES", "128"),
        ]);
        let dns_fn = dns_from(&["93.184.216.34"]);
        let log = Rc::new(RefCell::new(Vec::<RecordedRequest>::new()));
        let big_body = format!("{{\"price\":\"11.11\",\"pad\":\"{}\"}}", "x".repeat(500));
        let transport_fn = transport_with(&log, Ok(json_response(200, &big_body)));
        let sleep_fn = |_ms: u64| {};
        let mut runtime = ProviderRuntime::default();
        let payload = json!({
            "provider": "twelvedata",
            "symbol": "NEO-USD",
            "json_path": "price",
            "target_chain": "neo_n3",
        });
        let io = oracle_io(&env_fn, &dns_fn, &transport_fn, &sleep_fn);

        let outcome =
            perform_oracle_fetch(&payload, &golden_key_material(), &io, &mut runtime).unwrap();
        assert_eq!(outcome.provider.as_deref(), Some("twelvedata"));
        assert!(outcome.provider_pair.is_some());
        assert_eq!(outcome.selected_value, Some(json!("11.11")));
        assert!(!outcome.encrypted_token_present);
        let sent = &log.borrow()[0];
        assert!(
            sent.url.starts_with("https://api.twelvedata.com/price?")
                && sent.url.contains("apikey=secret-key"),
            "unexpected provider url: {}",
            sent.url
        );
    }

    #[test]
    fn provider_payload_errors_surface_as_upstream_http_errors() {
        let env_fn = env_from(&[("TWELVEDATA_API_KEY", "secret-key")]);
        let dns_fn = dns_from(&["93.184.216.34"]);
        let log = Rc::new(RefCell::new(Vec::<RecordedRequest>::new()));
        let transport_fn = transport_with(
            &log,
            Ok(json_response(
                200,
                r#"{"code":429,"message":"rate limited","status":"error"}"#,
            )),
        );
        let sleep_fn = |_ms: u64| {};
        let mut runtime = ProviderRuntime::default();
        let payload = json!({"provider": "twelvedata", "symbol": "NEO-USD"});
        let io = oracle_io(&env_fn, &dns_fn, &transport_fn, &sleep_fn);

        match perform_oracle_fetch(&payload, &golden_key_material(), &io, &mut runtime) {
            Err(TransportFailure::Upstream(error)) => {
                assert_eq!(error.kind, UpstreamErrorKind::UpstreamHttpError);
                assert_eq!(error.http_status, 502);
                assert_eq!(error.upstream_status, Some(429));
                assert!(error.message.contains("429"), "got: {}", error.message);
            }
            other => panic!("expected an upstream_http_error gateway fault, got: {other:?}"),
        }
    }

    #[test]
    fn direct_url_upstream_http_errors_shape_the_gateway_fault() {
        let env_fn = env_from(&[]);
        let dns_fn = dns_from(&["93.184.216.34"]);
        let log = Rc::new(RefCell::new(Vec::<RecordedRequest>::new()));
        let transport_fn = transport_with(&log, Ok(text_response(503, "service unavailable")));
        let sleep_fn = |_ms: u64| {};
        let mut runtime = ProviderRuntime::default();
        let payload = json!({"url": "https://api.example.com/feed"});
        let io = oracle_io(&env_fn, &dns_fn, &transport_fn, &sleep_fn);

        match perform_oracle_fetch(&payload, &golden_key_material(), &io, &mut runtime) {
            Err(TransportFailure::Upstream(error)) => {
                assert_eq!(error.kind, UpstreamErrorKind::UpstreamHttpError);
                assert_eq!(error.http_status, 502);
                assert_eq!(error.upstream_status, Some(503));
                assert_eq!(
                    error.message,
                    "https://api.example.com/feed upstream returned HTTP 503: service unavailable"
                );
            }
            other => panic!("expected an upstream_http_error gateway fault, got: {other:?}"),
        }
    }

    #[test]
    fn upstream_timeouts_surface_as_504_gateway_timeouts() {
        let env_fn = env_from(&[]);
        let dns_fn = dns_from(&["93.184.216.34"]);
        let log = Rc::new(RefCell::new(Vec::<RecordedRequest>::new()));
        let transport_fn = transport_with(&log, Err("operation timed out".to_string()));
        let sleep_fn = |_ms: u64| {};
        let mut runtime = ProviderRuntime::default();
        let payload = json!({
            "url": "https://api.example.com/hanging",
            "oracle_timeout_ms": 50,
        });
        let io = oracle_io(&env_fn, &dns_fn, &transport_fn, &sleep_fn);

        match perform_oracle_fetch(&payload, &golden_key_material(), &io, &mut runtime) {
            Err(TransportFailure::Upstream(error)) => {
                assert_eq!(error.kind, UpstreamErrorKind::UpstreamTimeout);
                assert_eq!(error.http_status, 504);
                assert_eq!(error.message, "oracle fetch timed out after 50ms");
            }
            other => panic!("expected an upstream_timeout gateway fault, got: {other:?}"),
        }
        assert_eq!(log.borrow()[0].timeout_ms, 50);
    }

    #[test]
    fn oversized_upstream_responses_stay_caller_visible() {
        let env_fn = env_from(&[("ORACLE_MAX_UPSTREAM_BODY_BYTES", "128")]);
        let dns_fn = dns_from(&["93.184.216.34"]);
        let log = Rc::new(RefCell::new(Vec::<RecordedRequest>::new()));
        let transport_fn = transport_with(&log, Ok(text_response(200, &"x".repeat(8192))));
        let sleep_fn = |_ms: u64| {};
        let mut runtime = ProviderRuntime::default();
        let payload = json!({"url": "https://api.example.com/large"});
        let io = oracle_io(&env_fn, &dns_fn, &transport_fn, &sleep_fn);

        let error =
            perform_oracle_fetch(&payload, &golden_key_material(), &io, &mut runtime).unwrap_err();
        // the JS suite sets the cap to 128, but resolveMaxBytes floors it at the
        // 4096 minimum — an 8192-byte body is still rejected, reporting 4096
        assert_caller_url_error(&error, "exceeds max size of 4096 bytes");
    }

    #[test]
    fn allowlist_and_ssrf_rejections_never_reach_the_transport() {
        let sleep_fn = |_ms: u64| {};
        let mut runtime = ProviderRuntime::default();

        let env_fn = env_from(&[("ORACLE_HTTP_ALLOWLIST", "https://allowed.example")]);
        let dns_fn = dns_from(&["93.184.216.34"]);
        let log = Rc::new(RefCell::new(Vec::<RecordedRequest>::new()));
        let transport_fn = transport_with(&log, Ok(json_response(200, "{}")));
        let io = oracle_io(&env_fn, &dns_fn, &transport_fn, &sleep_fn);
        let payload = json!({"url": "https://evil.example.com/feed"});
        let error =
            perform_oracle_fetch(&payload, &golden_key_material(), &io, &mut runtime).unwrap_err();
        assert_caller_url_error(&error, "url is not in ORACLE_HTTP_ALLOWLIST");
        assert!(log.borrow().is_empty());

        let env_fn = env_from(&[]);
        let log = Rc::new(RefCell::new(Vec::<RecordedRequest>::new()));
        let transport_fn = transport_with(&log, Ok(json_response(200, "{}")));
        let io = oracle_io(&env_fn, &dns_fn, &transport_fn, &sleep_fn);
        let payload = json!({"url": "http://169.254.169.254/latest/meta-data"});
        let error =
            perform_oracle_fetch(&payload, &golden_key_material(), &io, &mut runtime).unwrap_err();
        assert_caller_url_error(&error, "private/internal URLs not allowed");
        assert!(log.borrow().is_empty());
    }

    #[test]
    fn unresolvable_hosts_are_gateway_faults_not_caller_errors() {
        let env_fn = env_from(&[]);
        let log = Rc::new(RefCell::new(Vec::<RecordedRequest>::new()));
        let transport_fn = transport_with(&log, Ok(json_response(200, "{}")));
        let sleep_fn = |_ms: u64| {};
        let mut runtime = ProviderRuntime::default();
        let payload = json!({"url": "https://nonexistent.example/feed"});
        let io = oracle_io(&env_fn, no_dns(), &transport_fn, &sleep_fn);

        match perform_oracle_fetch(&payload, &golden_key_material(), &io, &mut runtime) {
            Err(TransportFailure::Upstream(error)) => {
                assert_eq!(error.kind, UpstreamErrorKind::UpstreamUnreachable);
                assert_eq!(error.http_status, 502);
                assert_eq!(error.message, "unable to resolve host: nonexistent.example");
            }
            other => panic!("expected an upstream_unreachable gateway fault, got: {other:?}"),
        }
        assert!(log.borrow().is_empty());
    }

    #[test]
    fn encrypted_tokens_inject_the_authorization_header() {
        use base64::Engine as _;
        let env_fn = env_from(&[]);
        let dns_fn = dns_from(&["93.184.216.34"]);
        let log = Rc::new(RefCell::new(Vec::<RecordedRequest>::new()));
        let transport_fn = transport_with(&log, Ok(json_response(200, "{}")));
        let sleep_fn = |_ms: u64| {};
        let mut runtime = ProviderRuntime::default();
        let io = oracle_io(&env_fn, &dns_fn, &transport_fn, &sleep_fn);
        let ciphertext =
            base64::engine::general_purpose::STANDARD.encode(GOLDEN_ENVELOPE_JSON.as_bytes());

        // default header + default Bearer prefix
        let payload = json!({
            "url": "https://api.example.com/auth",
            "encrypted_payload": ciphertext,
        });
        let outcome =
            perform_oracle_fetch(&payload, &golden_key_material(), &io, &mut runtime).unwrap();
        assert!(outcome.encrypted_token_present);
        assert_eq!(
            recorded_header(&log, 0, "authorization").as_deref(),
            Some(r#"Bearer {"token":"golden-vector-1"}"#)
        );

        // custom header, empty prefix
        let payload = json!({
            "url": "https://api.example.com/auth",
            "token_header": "x-api-key",
            "token_prefix": "",
            "encrypted_payload": ciphertext,
        });
        let outcome =
            perform_oracle_fetch(&payload, &golden_key_material(), &io, &mut runtime).unwrap();
        assert!(outcome.encrypted_token_present);
        assert_eq!(
            recorded_header(&log, 1, "x-api-key").as_deref(),
            Some(r#"{"token":"golden-vector-1"}"#)
        );
    }

    #[test]
    fn post_bodies_and_custom_headers_pass_through() {
        let env_fn = env_from(&[]);
        let dns_fn = dns_from(&["93.184.216.34"]);
        let log = Rc::new(RefCell::new(Vec::<RecordedRequest>::new()));
        let transport_fn =
            transport_with(&log, Ok(json_response(200, r#"{"result":{"value":"7"}}"#)));
        let sleep_fn = |_ms: u64| {};
        let mut runtime = ProviderRuntime::default();
        let payload = json!({
            "url": "https://api.example.com/submit",
            "method": "POST",
            "body": "{\"a\":1}",
            "headers": {"accept": "text/plain"},
            "json_path": "result.value",
        });
        let io = oracle_io(&env_fn, &dns_fn, &transport_fn, &sleep_fn);

        let outcome =
            perform_oracle_fetch(&payload, &golden_key_material(), &io, &mut runtime).unwrap();
        assert_eq!(outcome.selected_value, Some(json!("7")));
        let sent = &log.borrow()[0];
        assert_eq!(sent.method, "POST");
        assert_eq!(sent.body.as_deref(), Some(b"{\"a\":1}".as_slice()));
        assert_eq!(
            sent.headers
                .iter()
                .find(|(name, _)| name == "accept")
                .map(|(_, value)| value.as_str()),
            Some("text/plain")
        );
    }

    #[test]
    fn null_bodies_collapse_to_the_raw_text_like_the_js_nullish_coalescing() {
        let env_fn = env_from(&[]);
        let dns_fn = dns_from(&["93.184.216.34"]);
        let log = Rc::new(RefCell::new(Vec::<RecordedRequest>::new()));
        let transport_fn = transport_with(&log, Ok(json_response(200, "null")));
        let sleep_fn = |_ms: u64| {};
        let mut runtime = ProviderRuntime::default();
        let payload = json!({"url": "https://api.example.com/null"});
        let io = oracle_io(&env_fn, &dns_fn, &transport_fn, &sleep_fn);

        let outcome =
            perform_oracle_fetch(&payload, &golden_key_material(), &io, &mut runtime).unwrap();
        assert_eq!(outcome.data, Json::String("null".to_string()));
    }
}
