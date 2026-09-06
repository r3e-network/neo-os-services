//! Naming a refusal, so the log and the caller get different amounts of it.
//!
//! Two audiences read the same decision, and they must not read the same text.
//! The audit row carries specifics — which recipient was blacklisted, how far
//! over the ceiling a transfer was, what the parser choked on — because an
//! operator has to be able to reconstruct the request from the log alone. The
//! HTTP response carries a stable code and a generic sentence, because
//! "recipient `0x…` is not on this key's whitelist" tells a caller who was
//! probing whether that account is protected, and no refusal needs that to be
//! actionable. [`Refusal`] keeps the two apart by construction: `code` and
//! `message` are what a caller may see, `detail` is what the database gets.
//!
//! The guards below are the checks that are neither access control (which
//! [`crate::auth`] owns) nor policy (which
//! [`crate::policy`] owns): whether the operator switched this key off,
//! and whether the custody record still describes the key it holds. Both run
//! before the policy is read, so a broken or disabled key is refused without
//! its boundary ever being consulted.

use std::fmt;

use crate::{auth::AccessRejection, model::SignerAuditOutcome, policy::DenyReason};

/// Longest audit detail stored. A caller can influence this field — a script
/// error quotes bytes back — and an audit table that a request can fill is an
/// audit table that stops being writable.
pub const DETAIL_LIMIT: usize = 512;

/// A management request whose body was unusable. One code rather than one per
/// validation rule, because the caller's action is the same in every case — fix
/// the request and send it again — while the specifics differ enough that
/// enumerating them would make this code a vocabulary of vault facts.
///
/// The status map in `docs/SIGNER_SERVICE.md` §5 answers this with `400`, which
/// makes it the only `400` the management API produces; every other refusal
/// there is an access decision and answers `403`.
pub const ADMIN_REQUEST_INVALID: &str = "signer-admin-request-invalid";
pub const REQUEST_ID_INVALID: &str = "request-id-invalid";
pub const REQUEST_ID_CONFLICT: &str = "request-id-conflict";

/// The service said no before the policy was consulted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardRejection {
    /// The operator's kill switch is on.
    KeyDisabled,
    /// The sealed private key opens to a different key than the record's public
    /// key. Signing would honour a boundary written against one account with a
    /// signature from another.
    CustodyMismatch,
    /// The stored public key is not a usable point, so the key has no account
    /// and no policy can mean anything.
    PublicKeyUnusable,
    /// This key already signed another digest for the same dBFT slot.
    ConsensusEquivocation,
}

impl GuardRejection {
    /// Stable identifier for responses and audit rows.
    pub fn code(self) -> &'static str {
        match self {
            GuardRejection::KeyDisabled => "signer-key-disabled",
            GuardRejection::CustodyMismatch => "signer-custody-mismatch",
            GuardRejection::PublicKeyUnusable => "signer-public-key-unusable",
            GuardRejection::ConsensusEquivocation => "consensus-equivocation",
        }
    }

    /// What an operator can act on. `CustodyMismatch` and `PublicKeyUnusable`
    /// mean the record is corrupt, not that the request was wrong, and the
    /// difference decides whether the vault or the caller needs attention.
    pub fn outcome(self) -> SignerAuditOutcome {
        match self {
            GuardRejection::KeyDisabled | GuardRejection::ConsensusEquivocation => {
                SignerAuditOutcome::Denied
            }
            GuardRejection::CustodyMismatch | GuardRejection::PublicKeyUnusable => {
                SignerAuditOutcome::Failed
            }
        }
    }
}

impl fmt::Display for GuardRejection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            GuardRejection::KeyDisabled => "this custody key is disabled",
            GuardRejection::CustodyMismatch => {
                "the sealed key does not match the key on record for this id"
            }
            GuardRejection::PublicKeyUnusable => {
                "the stored public key cannot be used to derive an account"
            }
            GuardRejection::ConsensusEquivocation => {
                "this key already signed another payload for the same consensus slot"
            }
        };
        formatter.write_str(message)
    }
}

/// A decision not to sign, in the three forms it needs to exist in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    /// Machine-readable and stable across releases — the caller's branch point.
    pub code: &'static str,
    /// Generic sentence for the response body. Names no policy, no account, no
    /// amount.
    pub message: String,
    /// Specifics for the audit row, already bounded by [`DETAIL_LIMIT`].
    pub detail: String,
    /// `Denied` for a deliberate no, `Failed` for a request this service could
    /// not answer either way.
    pub outcome: SignerAuditOutcome,
}

impl Refusal {
    /// A caller that could not be identified, or not for this key.
    ///
    /// The message is the only text: an access rejection names nothing about
    /// the vault, and the audit row carries the origin separately.
    pub fn access(rejection: AccessRejection) -> Self {
        Refusal {
            code: rejection.code(),
            message: rejection.to_string(),
            detail: rejection.to_string(),
            outcome: SignerAuditOutcome::Denied,
        }
    }

    /// A management request whose own body could not be used: an empty label, a
    /// key that is not 64 hex characters, a NEP-2 that will not decrypt with the
    /// passphrase given.
    ///
    /// Unlike every other refusal, this one's `message` may be specific, and the
    /// asymmetry is deliberate rather than an exception made for convenience.
    /// The two-audience rule exists so a caller that is not entitled to ask
    /// cannot learn vault facts from the wording of a no — but no request reaches
    /// this constructor without already having passed
    /// [`crate::model::CallerCapability::Admin`] and a whole-vault grant, because
    /// `SignerService::guard_admin` runs first and its failure returns before the
    /// body is read. Whoever is on the receiving end of this message is the
    /// operator who can act on it.
    pub fn invalid(message: &str, detail: impl Into<String>) -> Self {
        Refusal {
            code: ADMIN_REQUEST_INVALID,
            message: message.to_string(),
            detail: bounded(&detail.into()),
            outcome: SignerAuditOutcome::Denied,
        }
    }

    /// An idempotency id that is malformed or already binds another request.
    pub fn request_id(code: &'static str, message: &str, detail: impl Into<String>) -> Self {
        Refusal {
            code,
            message: message.to_string(),
            detail: bounded(&detail.into()),
            outcome: SignerAuditOutcome::Denied,
        }
    }

    /// A deliberate request-level refusal that is neither access control nor a
    /// parsed policy verdict. Chain/key identity mismatches belong here: the
    /// service understood the request and intentionally refused to use a key
    /// outside its immutable chain binding.
    pub fn denied(code: &'static str, message: &str, detail: impl Into<String>) -> Self {
        Refusal {
            code,
            message: message.to_string(),
            detail: bounded(&detail.into()),
            outcome: SignerAuditOutcome::Denied,
        }
    }

    /// A policy engine refusal, with the specifics it produced.
    pub fn policy(reason: DenyReason, detail: impl Into<String>) -> Self {
        Refusal {
            code: reason.code(),
            message: reason.to_string(),
            detail: bounded(&detail.into()),
            outcome: SignerAuditOutcome::Denied,
        }
    }

    /// A guard refusal.
    pub fn guard(rejection: GuardRejection, detail: impl Into<String>) -> Self {
        let detail = detail.into();
        Refusal {
            code: rejection.code(),
            message: rejection.to_string(),
            detail: bounded(&if detail.is_empty() {
                rejection.to_string()
            } else {
                detail
            }),
            outcome: rejection.outcome(),
        }
    }

    /// Nothing was refused on purpose — the request could not be read, the
    /// vault could not be opened, the ledger could not be written.
    pub fn failed(code: &'static str, message: &str, detail: impl Into<String>) -> Self {
        Refusal {
            code,
            message: message.to_string(),
            detail: bounded(&detail.into()),
            outcome: SignerAuditOutcome::Failed,
        }
    }
}

/// Clip to [`DETAIL_LIMIT`] characters, never to a byte offset.
///
/// Detail strings can carry text echoed back from a caller's script, and
/// slicing at a byte index inside a multi-byte character panics — which in this
/// service would mean a malformed request taking the process down.
pub fn bounded(text: &str) -> String {
    if text.chars().count() <= DETAIL_LIMIT {
        return text.to_string();
    }
    let mut clipped: String = text.chars().take(DETAIL_LIMIT - 1).collect();
    clipped.push('…');
    clipped
}

#[cfg(test)]
#[path = "../tests/unit/audit.rs"]
mod tests;
