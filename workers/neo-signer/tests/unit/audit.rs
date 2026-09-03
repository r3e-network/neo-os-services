//! The vocabulary a refusal is written in.
//!
//! These are small rules, and they are the rules the rest of the service cannot
//! check for itself: which text a caller is allowed to see, how long a detail
//! string may be, and whether a code means "the policy said no" or "the vault
//! could not answer".

use super::*;
use crate::auth::AccessRejection;

/// A detail in the shape the policy engine actually writes: the reason, plus an
/// account only that request and that policy mention.
fn account_named_detail() -> String {
    format!(
        "recipient 0x{} is not in the recipient whitelist",
        "ab".repeat(20)
    )
}

#[test]
fn the_caller_sees_a_generic_message_and_the_log_keeps_the_specifics() {
    let detail = account_named_detail();
    let refusal = Refusal::policy(DenyReason::RecipientNotWhitelisted, detail.clone());

    assert_eq!(refusal.code, "recipient-not-whitelisted");
    assert_eq!(refusal.detail, detail);
    assert_eq!(refusal.outcome, SignerAuditOutcome::Denied);
    // The response body is built from `message`, so an account that only ever
    // appeared in the detail must not reach it.
    assert!(!refusal.message.contains("ababab"), "{}", refusal.message);
    assert_ne!(refusal.message, detail);
}

#[test]
fn an_access_rejection_carries_its_own_code_and_no_detail() {
    let refusal = Refusal::access(AccessRejection::OriginNotAllowed);

    assert_eq!(refusal.code, "origin-not-allowed");
    assert_eq!(refusal.outcome, SignerAuditOutcome::Denied);
    assert_eq!(
        refusal.detail,
        AccessRejection::OriginNotAllowed.to_string()
    );
}

#[test]
fn every_access_rejection_refuses_with_a_distinct_code() {
    let rejections = [
        AccessRejection::MissingToken,
        AccessRejection::UnknownToken,
        AccessRejection::CallerDisabled,
        AccessRejection::OriginRequired,
        AccessRejection::OriginNotAllowed,
        AccessRejection::OriginUnexpected,
        AccessRejection::KeyNotGranted,
    ];
    let codes: Vec<&str> = rejections
        .iter()
        .map(|rejection| rejection.code())
        .collect();
    let mut sorted = codes.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), codes.len(), "{codes:?}");
}

#[test]
fn a_broken_record_is_reported_as_a_failure_not_a_denial() {
    // The distinction decides who is paged: a denial is a caller that asked for
    // something, a failure is a vault that cannot answer.
    assert_eq!(
        Refusal::guard(GuardRejection::KeyDisabled, String::new()).outcome,
        SignerAuditOutcome::Denied
    );
    assert_eq!(
        Refusal::guard(GuardRejection::ConsensusEquivocation, String::new()).outcome,
        SignerAuditOutcome::Denied
    );
    assert_eq!(
        Refusal::guard(GuardRejection::CustodyMismatch, String::new()).outcome,
        SignerAuditOutcome::Failed
    );
    assert_eq!(
        Refusal::guard(GuardRejection::PublicKeyUnusable, String::new()).outcome,
        SignerAuditOutcome::Failed
    );
}

#[test]
fn a_guard_refusal_without_specifics_still_explains_itself() {
    let refusal = Refusal::guard(GuardRejection::CustodyMismatch, String::new());

    assert_eq!(refusal.code, "signer-custody-mismatch");
    assert_eq!(refusal.detail, refusal.message);
    assert!(!refusal.detail.is_empty());
}

#[test]
fn every_guard_code_is_distinct() {
    let codes = [
        GuardRejection::KeyDisabled,
        GuardRejection::CustodyMismatch,
        GuardRejection::PublicKeyUnusable,
        GuardRejection::ConsensusEquivocation,
    ]
    .map(GuardRejection::code);
    let unique: std::collections::BTreeSet<&str> = codes.iter().copied().collect();
    assert_eq!(unique.len(), codes.len(), "{codes:?}");
}

#[test]
fn a_detail_is_clipped_to_the_limit() {
    let long = "x".repeat(DETAIL_LIMIT * 3);
    let clipped = bounded(&long);

    assert_eq!(clipped.chars().count(), DETAIL_LIMIT);
    assert!(clipped.ends_with('…'));
}

#[test]
fn clipping_never_splits_a_character() {
    // The bug this guards against is a byte-index slice landing inside a
    // multi-byte character, which panics — in this service, on the request path.
    let long = "见证".repeat(DETAIL_LIMIT);
    let clipped = bounded(&long);

    assert!(clipped.chars().count() <= DETAIL_LIMIT);
    assert!(clipped.ends_with('…'));
    assert!(std::str::from_utf8(clipped.as_bytes()).is_ok());
}

#[test]
fn a_short_detail_survives_untouched() {
    assert_eq!(bounded("nothing allowed"), "nothing allowed");
    assert_eq!(bounded(""), "");
}
