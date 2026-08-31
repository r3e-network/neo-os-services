//! Caller credentials: who is asking, and from where.
//!
//! Two independent facts are checked here, because they answer different
//! questions. The bearer token answers *which caller* — it is the only thing a
//! server-to-server integration has to authenticate with. The `Origin` answers
//! *whether a browser is in the loop at all*, which a token cannot tell you:
//! the same string works from a laptop terminal and from a page the operator
//! never intended to be able to sign. Binding a caller to a set of origins is
//! what makes a leaked token usable only from the deployed app.
//!
//! The rules, stated once so the two directions cannot be confused:
//!
//! * A caller **with** `allowed_origins` must present one that matches exactly.
//!   A missing `Origin` is refused, not treated as "nothing to check".
//! * A caller **without** `allowed_origins` declared itself server-to-server, so
//!   a request arriving *with* an origin is refused. An origin can only come
//!   from a browser, and a browser that holds a service token is the leak we are
//!   trying to notice.
//!
//! Digests are compared over the whole SHA-256 output in constant time:
//! comparing digests rather than tokens keeps the token's length and any shared
//! prefix out of the timing channel.

use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::model::{CallerCapability, KeyGrant, SignerCaller};

/// Opaque marker browsers send instead of their real origin — a sandboxed
/// iframe, a `data:` document, a request with `Referrer-Policy` stripping it.
/// It matches nothing and is never a configured allow-list entry.
pub const NULL_ORIGIN: &str = "null";

/// Why a request was refused before the key's policy was consulted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessRejection {
    /// No `Authorization: Bearer …` header could be read.
    MissingToken,
    /// The token matched no enabled caller.
    UnknownToken,
    /// The token matched a caller that an operator has disabled.
    CallerDisabled,
    /// The caller declares origins and this request presented none.
    OriginRequired,
    /// The caller declares origins and this request's did not match.
    OriginNotAllowed,
    /// A server-to-server caller received a browser origin.
    OriginUnexpected,
    /// The caller's key grant does not include the key it named.
    KeyNotGranted,
    /// The caller holds the token but not the capability this route needs.
    ///
    /// One code covers both directions — an admin credential presented to a
    /// signing route and a signing credential presented to the management API —
    /// and it is deliberately not two codes. The caller does not know which
    /// capability it holds until this check answers, so a code that varied by
    /// direction would let anyone holding a bearer string use the endpoint to
    /// classify it. The distinction the audit keeps is between this and
    /// `signer-key-unknown`, which is why the capability check runs before the
    /// key is ever looked up: a missing capability and a missing key are
    /// different operator actions, and disguising the first as the second costs
    /// an afternoon of guessing per incident.
    CapabilityMissing,
}

impl AccessRejection {
    /// Stable identifier for the response body and the audit row.
    pub fn code(self) -> &'static str {
        match self {
            AccessRejection::MissingToken => "missing-token",
            AccessRejection::UnknownToken => "unknown-token",
            AccessRejection::CallerDisabled => "caller-disabled",
            AccessRejection::OriginRequired => "origin-required",
            AccessRejection::OriginNotAllowed => "origin-not-allowed",
            AccessRejection::OriginUnexpected => "origin-unexpected",
            AccessRejection::KeyNotGranted => "key-not-granted",
            AccessRejection::CapabilityMissing => "admin-capability-missing",
        }
    }
}

impl std::fmt::Display for AccessRejection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            AccessRejection::MissingToken => "a Bearer token is required",
            AccessRejection::UnknownToken => "the token does not match any caller",
            AccessRejection::CallerDisabled => "this caller is disabled",
            AccessRejection::OriginRequired => {
                "this caller is bound to an origin list but the request carried no Origin"
            }
            AccessRejection::OriginNotAllowed => "the Origin is not in this caller's list",
            AccessRejection::OriginUnexpected => {
                "this caller is server-to-server and accepts no browser origin"
            }
            AccessRejection::KeyNotGranted => "this caller is not granted the requested key",
            AccessRejection::CapabilityMissing => "this credential is not valid for this endpoint",
        };
        formatter.write_str(message)
    }
}

/// What the request said about where it came from.
///
/// Three states because two are not the same event. `Absent` is a curl command
/// or a partner backend; `Unusable` is a request that *did* carry an origin
/// header and cannot show a good one — a sandboxed frame, a `data:` document, or
/// someone hand-writing headers. Collapsing the two would mean a crafted
/// `Origin: garbage` reads as "no browser involved", which is exactly the
/// downgrade an origin-bound caller is meant to prevent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OriginClaim {
    Absent,
    Unusable,
    Known(String),
}

impl OriginClaim {
    /// The normalized origin, when there was one.
    pub fn value(&self) -> Option<&str> {
        match self {
            OriginClaim::Known(value) => Some(value),
            OriginClaim::Absent | OriginClaim::Unusable => None,
        }
    }

    pub fn is_absent(&self) -> bool {
        matches!(self, OriginClaim::Absent)
    }
}

/// What a request presented, already reduced to the two facts that matter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallerCredentials {
    token: Option<String>,
    origin: OriginClaim,
}

impl CallerCredentials {
    /// Read the credentials out of raw header values.
    ///
    /// `Origin` wins over `Referer`, and `Referer` is only consulted when no
    /// `Origin` arrived at all. A `Referer` is trusted no further than its
    /// origin: its path is whatever the browser happened to be looking at, so
    /// comparing it whole would accept or reject on a detail that carries no
    /// authentication weight.
    pub fn new(authorization: Option<&str>, origin: Option<&str>, referer: Option<&str>) -> Self {
        // `or_else` runs only when `Origin` was not sent at all. An `Origin`
        // that arrived unusable already produced a claim, so it cannot be
        // replaced by a friendlier `Referer`.
        let origin = origin_claim(origin)
            .or_else(|| origin_claim(referer))
            .unwrap_or(OriginClaim::Absent);
        CallerCredentials {
            token: bearer_token(authorization).map(str::to_owned),
            origin,
        }
    }

    /// Credentials with a token and no browser origin — a server-to-server call,
    /// and the shape the tests and the CLI use.
    pub fn server_to_server(token: &str) -> Self {
        CallerCredentials {
            token: (!token.is_empty()).then(|| token.to_owned()),
            origin: OriginClaim::Absent,
        }
    }

    pub fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    pub fn origin(&self) -> &OriginClaim {
        &self.origin
    }

    /// Short, stable label for a presented origin, safe to audit: it names where
    /// a request came from without reproducing a token.
    pub fn origin_label(&self) -> Option<String> {
        match &self.origin {
            OriginClaim::Absent => None,
            OriginClaim::Unusable => Some("<unusable>".to_string()),
            OriginClaim::Known(value) => Some(value.clone()),
        }
    }

    /// The token digest, for storing. Returns `None` when no token was
    /// presented, so a caller cannot be created with an empty credential that
    /// every tokenless request would then match.
    pub fn presented_digest(&self) -> Option<[u8; 32]> {
        self.token.as_deref().map(token_digest)
    }
}

/// Classify one origin-carrying header.
///
/// `None` means "this header said nothing", which lets the next header speak.
/// `Some(Unusable)` means it said something we cannot honour, and that answer is
/// final.
fn origin_claim(value: Option<&str>) -> Option<OriginClaim> {
    let raw = value?.trim();
    if raw.is_empty() {
        return None;
    }
    Some(match normalize_origin(raw) {
        Some(normalized) => OriginClaim::Known(normalized),
        None => OriginClaim::Unusable,
    })
}

/// Pull the token out of an `Authorization` header value.
///
/// Case-insensitive on the scheme name only, per RFC 6750; the token itself is
/// compared byte for byte after trimming, because a trailing space in a pasted
/// config is common and a leading one is not.
fn bearer_token(authorization: Option<&str>) -> Option<&str> {
    let value = authorization?.trim();
    let (scheme, token) = value.split_once(char::is_whitespace)?;
    if !scheme.eq_ignore_ascii_case("Bearer") {
        return None;
    }
    let token = token.trim();
    (!token.is_empty()).then_some(token)
}

/// SHA-256 of a token, which is all this service ever keeps.
pub fn token_digest(token: &str) -> [u8; 32] {
    let digest = Sha256::digest(token.as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// A new bearer token.
///
/// 32 hex characters would be a UUID's worth of entropy and UUIDv4 is not
/// specified as cryptographically random; two v4 UUIDs joined are, in practice,
/// `getrandom` output (the crate's `v4` feature resolves to it), and 250-odd
/// bits of it is far past what this endpoint needs. Prefixing with `nsk1_`
/// makes the string self-identifying in a log or a leaked `.env`, which is how
/// the operator is supposed to notice one outside the vault.
pub fn generate_token() -> String {
    format!(
        "nsk1_{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

/// Reduce a header value to `scheme://host[:port]`, lowercase, no path.
///
/// Returns `None` for anything that is not a URL or has no host, and for the
/// `null` origin: an unparseable origin is a request we cannot attribute, and
/// the only safe reading of that is "not allowed".
pub fn normalize_origin(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.eq_ignore_ascii_case(NULL_ORIGIN) {
        return None;
    }
    let parsed = url::Url::parse(trimmed).ok()?;
    if !parsed.has_authority() {
        return None;
    }
    let origin = parsed.origin().ascii_serialization();
    if origin.eq_ignore_ascii_case(NULL_ORIGIN) || parsed.host_str().is_none() {
        return None;
    }
    Some(origin.to_ascii_lowercase())
}

/// Whether `presented` may be found in `allowed`.
///
/// Exact match on the normalized form. A suffix or prefix match would let
/// `https://neo.org.evil.test` through as `https://neo.org`, which is the single
/// most common way an origin allow-list is written and then bypassed.
pub fn origin_matches(allowed: &[String], presented: Option<&str>) -> bool {
    let Some(presented) = presented else {
        return false;
    };
    allowed
        .iter()
        .any(|entry| entry.trim().eq_ignore_ascii_case(presented))
}

/// Constant-time digest comparison.
///
/// Folding the XOR of every byte and testing the accumulator once means the
/// running time does not depend on how early a mismatch appears, so neither the
/// position of the first differing byte nor a shared prefix leaks.
fn digest_matches(expected: &[u8; 32], candidate: &[u8; 32]) -> bool {
    let difference = expected
        .iter()
        .zip(candidate.iter())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b));
    difference == 0
}

/// Find the caller a request is speaking for, and check it may do *this* thing
/// to *this* key.
///
/// `key_id` is `None` for a management route that names no key — list the vault,
/// create a key, provision a caller. Takes the whole caller list rather than
/// doing its own lookup: the grant set is a handful of rows, and resolving by
/// SQL equality on the digest would put the comparison inside an index probe,
/// which is a worse timing surface than a constant-time loop over a few hundred
/// bytes.
///
/// On `Ok` the caller is enabled, it holds `required`, its origin is accepted,
/// and the key — if the route named one — is granted. A rejection does not mean
/// the caller is unknown: [`identify`] says who asked, which is how the service
/// attributes the refusal.
pub fn authenticate<'a>(
    callers: &'a [SignerCaller],
    credentials: &CallerCredentials,
    required: CallerCapability,
    key_id: Option<&str>,
) -> Result<&'a SignerCaller, AccessRejection> {
    if credentials.token().is_none() {
        return Err(AccessRejection::MissingToken);
    }
    let caller = identify(callers, credentials).ok_or(AccessRejection::UnknownToken)?;
    authorize(caller, credentials, required, key_id)
}

/// The caller whose token matched, whatever it is entitled to.
///
/// [`authenticate`] answers "may this request happen"; this answers "who asked",
/// so a refusal can be audited against the identity that produced it. A row that
/// says only "key-not-granted" with no caller names an event nobody can
/// investigate: the operator cannot tell which integration to go and correct.
///
/// `None` when no token matched, when no token was presented at all, and when
/// more than one caller shares a digest. That last case is a creation bug rather
/// than an attack, and naming either holder would be a guess about who made the
/// request — so neither is blamed.
pub fn identify<'a>(
    callers: &'a [SignerCaller],
    credentials: &CallerCredentials,
) -> Option<&'a SignerCaller> {
    let digest = credentials.presented_digest()?;
    let mut matched = callers
        .iter()
        .filter(|caller| digest_matches(&caller.token_digest, &digest));
    let caller = matched.next()?;
    if matched.next().is_some() {
        return None;
    }
    Some(caller)
}

/// The same decision [`authenticate`] makes once the caller is known, without a
/// token to match. Split out so the caller's `disabled` flag and its origin
/// binding can be exercised without minting tokens that hash alike.
pub fn authorize<'a>(
    caller: &'a SignerCaller,
    credentials: &CallerCredentials,
    required: CallerCapability,
    key_id: Option<&str>,
) -> Result<&'a SignerCaller, AccessRejection> {
    if caller.disabled {
        return Err(AccessRejection::CallerDisabled);
    }
    // Capability is checked before the origin, not after it. A credential of the
    // wrong kind should receive one answer whatever headers it brings, so the
    // endpoint cannot be used to learn anything beyond "this is the wrong kind".
    if !caller.has_capability(required) {
        return Err(AccessRejection::CapabilityMissing);
    }
    let presented = credentials.origin();
    if caller.allowed_origins.is_empty() {
        if !presented.is_absent() {
            return Err(AccessRejection::OriginUnexpected);
        }
    } else {
        match presented.value() {
            None => {
                return Err(if presented.is_absent() {
                    AccessRejection::OriginRequired
                } else {
                    AccessRejection::OriginNotAllowed
                })
            }
            Some(origin) if origin_matches(&caller.allowed_origins, Some(origin)) => {}
            Some(_) => return Err(AccessRejection::OriginNotAllowed),
        }
    }
    match key_id {
        Some(key_id) => {
            if !caller.key_grant.grants(key_id) {
                return Err(AccessRejection::KeyNotGranted);
            }
        }
        // An operation naming no key reaches the whole vault — list it, create
        // into it, provision callers. Only a caller granted the whole vault may
        // attempt one: a scoped admin must not be able to read out the keys it
        // was scoped away from, which a permissive reading of "no key named"
        // would allow.
        None if !matches!(caller.key_grant, KeyGrant::Any) => {
            return Err(AccessRejection::KeyNotGranted);
        }
        None => {}
    }
    Ok(caller)
}

#[cfg(test)]
#[path = "../tests/unit/auth.rs"]
mod tests;
