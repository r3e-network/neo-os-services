//! Sponsorable intent validation — the decision the sponsor pays for.
//!
//! A sponsor must not pay for an intent it did not approve, and this validator
//! must not accept an intent whose shape it cannot verify. Both halves rule out
//! the same thing: validating a caller's *description* of an intent. Everything
//! accepted here is derived from the invocation script bytes, which are the
//! bytes that will be signed and broadcast. A submitted `method` or `target` is
//! never echoed back as a fact.
//!
//! The row this implements (CU-150, `SVC-U02b`) is *validate sponsorable
//! intents by script shape (`registerAccount`, `executeSponsoredUserOp`) with
//! fee ceilings*, accepted when *wrong shapes, wrong targets and over-ceiling
//! fees are refused with stable codes*. The three refusal families are
//! [`SponsorIntentCode::WrongShape`], [`SponsorIntentCode::WrongTarget`] and
//! [`SponsorIntentCode::FeeOverCeiling`]; the other codes cover the structural
//! failures around them. Every code string is frozen by a test.
//!
//! The two shapes come from the deployed V3 ABI,
//! `neo-os-aa/contracts/bin/v3/UnifiedSmartWalletV3.manifest.json`:
//!
//! * `registerAccount(accountId, verifier, verifierParams, hookId, backupOwner,
//!   escapeTimelock)` — six arguments, no reimbursement claim.
//! * `executeSponsoredUserOp(accountId, op, paymaster, sponsor,
//!   reimbursementAmount)` — five arguments, where `op` is a `UserOperation`
//!   (`UnifiedSmartWallet.Models.cs:33`) and `reimbursementAmount` is a payment
//!   the sponsor's paymaster deposit settles on chain.
//!
//! The per-argument bounds mirror `UnifiedSmartWallet.Execution.cs`
//! `ValidateUserOperation` and `UnifiedSmartWallet.Paymaster.cs`
//! `ExecuteSponsoredUserOp`, so an off-chain acceptance cannot describe a user
//! operation the chain would refuse a moment later. What is deliberately not
//! mirrored is recorded in the evidence for this slice: the serialized-argument
//! length bound (a chain-side resource limit) and any downstream-target
//! allow-list, which is the paymaster's policy and the signer's boundary.
//!
//! Byte order, stated once: [`SponsorIntentRequest::sponsorable_contract`] and
//! every hash on [`SponsorableIntent`] are in **display order** — the `0x…`
//! 40-hex form operators paste and the form the sponsor journal's `contract`
//! column stores — so comparing this against a journal row is a byte comparison.
//!
//! Nothing here performs IO, and nothing here is wired to a live path yet: the
//! sponsor HTTP API (CU-151) calls it before it reserves a budget.

use crate::n3_tx::{decode_invoke_call, InvokeArg, InvokeCall, N3DecodeError, HASH160_LEN};

/// The method names, exactly as the deployed V3 ABI spells them.
const METHOD_REGISTER_ACCOUNT: &str = "registerAccount";
const METHOD_EXECUTE_SPONSORED_USER_OP: &str = "executeSponsoredUserOp";

/// `MaxUserOperationMethodLength`, `MaxUserOperationArgsLength` and
/// `MaxUserOperationSignatureLength` from `UnifiedSmartWallet.Execution.cs`.
const MAX_USER_OP_METHOD_LEN: usize = 128;
const MAX_USER_OP_ARGS_LEN: usize = 64;
const MAX_USER_OP_SIGNATURE_LEN: usize = 1024;
/// `IsUnsignedIntegerWithinBytes(op.Nonce, 32)`, and the same bound on `Deadline`.
const MAX_USER_OP_INTEGER_BYTES: usize = 32;
/// `UserOperation` is a six-field class on the deployed ABI.
const USER_OP_FIELDS: usize = 6;
/// `registerAccount` and `executeSponsoredUserOp` arity, from the same ABI.
const REGISTER_ACCOUNT_ARGS: usize = 6;
const EXECUTE_SPONSORED_USER_OP_ARGS: usize = 5;

/// The refusal vocabulary. These strings are a compatibility surface the moment
/// the sponsor API matches on them, so they are pinned by a test and must not be
/// renamed without a migration story for every caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SponsorIntentCode {
    /// No script at all.
    ScriptRequired,
    /// The script is not one fully-accounted-for `System.Contract.Call`.
    ScriptUndecodable,
    /// The call is not one of the two sponsorable shapes.
    WrongShape,
    /// The call does not target the configured sponsorable contract.
    WrongTarget,
    /// The approved ceiling is not a usable positive amount.
    FeeCeilingInvalid,
    /// The sponsor's fee is above the approved ceiling.
    FeeOverCeiling,
}

impl SponsorIntentCode {
    /// Every code, so a test can prove none has been added or renamed behind a
    /// caller that matches on the string.
    pub const ALL: [SponsorIntentCode; 6] = [
        SponsorIntentCode::ScriptRequired,
        SponsorIntentCode::ScriptUndecodable,
        SponsorIntentCode::WrongShape,
        SponsorIntentCode::WrongTarget,
        SponsorIntentCode::FeeCeilingInvalid,
        SponsorIntentCode::FeeOverCeiling,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ScriptRequired => "SPONSOR_INTENT_SCRIPT_REQUIRED",
            Self::ScriptUndecodable => "SPONSOR_INTENT_SCRIPT_UNDECODABLE",
            Self::WrongShape => "SPONSOR_INTENT_WRONG_SHAPE",
            Self::WrongTarget => "SPONSOR_INTENT_WRONG_TARGET",
            Self::FeeCeilingInvalid => "SPONSOR_INTENT_FEE_CEILING_INVALID",
            Self::FeeOverCeiling => "SPONSOR_INTENT_FEE_OVER_CEILING",
        }
    }
}

impl std::fmt::Display for SponsorIntentCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A refusal. `detail` is for logs and operator messages; a caller that branches
/// must branch on [`SponsorIntentCode`], never on the text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SponsorIntentError {
    pub code: SponsorIntentCode,
    pub detail: String,
}

impl SponsorIntentError {
    fn new(code: SponsorIntentCode, detail: impl Into<String>) -> Self {
        SponsorIntentError {
            code,
            detail: detail.into(),
        }
    }
}

impl std::fmt::Display for SponsorIntentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for SponsorIntentError {}

/// The two script shapes a sponsor will pay for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SponsorableMethod {
    RegisterAccount,
    ExecuteSponsoredUserOp,
}

impl SponsorableMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RegisterAccount => METHOD_REGISTER_ACCOUNT,
            Self::ExecuteSponsoredUserOp => METHOD_EXECUTE_SPONSORED_USER_OP,
        }
    }
}

/// What the sponsor is being asked to pay for, derived from the script.
///
/// No field here is copied from the request. `target` is the contract the script
/// calls, `account_id` and `reimbursement_units` are arguments inside it, and
/// `sponsor_fee_units` is computed from those arguments plus the enclosing
/// transaction fee the caller read off the transaction it is about to broadcast.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SponsorableIntent {
    pub method: SponsorableMethod,
    /// The called contract, display order.
    pub target: [u8; HASH160_LEN],
    /// The account the operation runs under, display order.
    pub account_id: [u8; HASH160_LEN],
    /// The user operation's own target, display order. `None` for
    /// `registerAccount`, which has no inner call.
    pub downstream_target: Option<[u8; HASH160_LEN]>,
    /// The user operation's own method. `None` for `registerAccount`.
    pub downstream_method: Option<String>,
    /// The script-carried `reimbursementAmount`, GAS datoshi. Zero for
    /// `registerAccount`, which makes no reimbursement claim.
    pub reimbursement_units: u64,
    /// The enclosing transaction's system fee plus network fee, GAS datoshi.
    /// Supplied by the caller, which owns the transaction and must read this
    /// from its envelope rather than from anything the submitter declared.
    pub transaction_fee_units: u64,
    /// `transaction_fee_units + reimbursement_units`: the whole amount the
    /// sponsor is being asked to approve for this intent.
    pub sponsor_fee_units: u64,
    /// The `CallFlags` value the script pushed, reported not gated.
    pub call_flags: u8,
}

/// What the caller must supply. The script and the ceiling come from the
/// request; the facts in [`SponsorableIntent`] do not.
#[derive(Debug, Clone, Copy)]
pub struct SponsorIntentRequest<'a> {
    /// The invocation script exactly as it will be signed and broadcast.
    pub script: &'a [u8],
    /// The one contract whose `registerAccount` / `executeSponsoredUserOp` this
    /// sponsor will pay for, display order.
    pub sponsorable_contract: [u8; HASH160_LEN],
    /// The sponsor's approved ceiling for this intent, GAS datoshi. The
    /// reservation schema bounds this (`fee_ceiling_units between 1 and
    /// 20000000`); that bound is deliberately not duplicated here.
    pub fee_ceiling_units: u64,
    /// The enclosing transaction's system fee plus network fee, GAS datoshi.
    pub transaction_fee_units: u64,
}

/// Validate a sponsorable intent by its script shape and its fee.
///
/// Refusal order is fixed so the code a caller sees is predictable: script,
/// shape, target, then fee. Nothing is accepted on a partial reading.
pub fn validate_sponsorable_intent(
    request: &SponsorIntentRequest<'_>,
) -> Result<SponsorableIntent, SponsorIntentError> {
    if request.script.is_empty() {
        return Err(SponsorIntentError::new(
            SponsorIntentCode::ScriptRequired,
            "an intent must carry the invocation script that will be broadcast",
        ));
    }
    if request.fee_ceiling_units == 0 {
        return Err(SponsorIntentError::new(
            SponsorIntentCode::FeeCeilingInvalid,
            "the approved fee ceiling must be a positive amount of GAS datoshi",
        ));
    }

    let call = decode_invoke_call(request.script).map_err(|error: N3DecodeError| {
        SponsorIntentError::new(
            SponsorIntentCode::ScriptUndecodable,
            format!("the invocation script is not one contract call: {error}"),
        )
    })?;

    let method = match call.method.as_str() {
        METHOD_REGISTER_ACCOUNT => SponsorableMethod::RegisterAccount,
        METHOD_EXECUTE_SPONSORED_USER_OP => SponsorableMethod::ExecuteSponsoredUserOp,
        other => {
            return Err(wrong_shape(format!(
                "method `{other}` is not a sponsorable script shape"
            )))
        }
    };

    let (account_id, downstream_target, downstream_method) =
        match method {
            SponsorableMethod::RegisterAccount => {
                validate_register_account(&call)?;
                (hash_arg(&call.args[0])?, None, None)
            }
            SponsorableMethod::ExecuteSponsoredUserOp => {
                let op = validate_execute_sponsored_user_op(&call)?;
                (
                    hash_arg(&call.args[0])?,
                    Some(hash_arg(&op[0])?),
                    Some(op[1].as_text().ok_or_else(|| {
                        wrong_shape("UserOperation Method must be a UTF-8 string")
                    })?),
                )
            }
        };

    if call.contract != request.sponsorable_contract {
        return Err(SponsorIntentError::new(
            SponsorIntentCode::WrongTarget,
            format!(
                "the script calls 0x{}, not the sponsorable contract 0x{}",
                to_hex(&call.contract),
                to_hex(&request.sponsorable_contract)
            ),
        ));
    }

    // The fee check runs last so a wrong target is never reported as a price.
    let reimbursement_units = match method {
        SponsorableMethod::RegisterAccount => 0,
        SponsorableMethod::ExecuteSponsoredUserOp => {
            let amount = &call.args[4];
            // `is_integer`, positive and non-zero were established in the shape
            // check; what is left is whether the claim fits the datoshi domain.
            match amount.as_non_negative_u64() {
                Some(units) => units,
                None => {
                    return Err(SponsorIntentError::new(
                        SponsorIntentCode::FeeOverCeiling,
                        "the reimbursement claim is larger than the datoshi domain",
                    ))
                }
            }
        }
    };
    let sponsor_fee_units = request
        .transaction_fee_units
        .checked_add(reimbursement_units)
        .ok_or_else(|| {
            SponsorIntentError::new(
                SponsorIntentCode::FeeOverCeiling,
                "the sponsor's fee overflows the datoshi domain",
            )
        })?;
    if sponsor_fee_units > request.fee_ceiling_units {
        return Err(SponsorIntentError::new(
            SponsorIntentCode::FeeOverCeiling,
            format!(
                "the sponsor would pay {sponsor_fee_units} datoshi against a ceiling of {}",
                request.fee_ceiling_units
            ),
        ));
    }

    Ok(SponsorableIntent {
        method,
        target: call.contract,
        account_id,
        downstream_target,
        downstream_method,
        reimbursement_units,
        transaction_fee_units: request.transaction_fee_units,
        sponsor_fee_units,
        call_flags: call.call_flags,
    })
}

/// `registerAccount(accountId, verifier, verifierParams, hookId, backupOwner,
/// escapeTimelock)` — six arguments, four of them `Hash160`.
fn validate_register_account(call: &InvokeCall) -> Result<(), SponsorIntentError> {
    let args = call.args.as_slice();
    if args.len() != REGISTER_ACCOUNT_ARGS {
        return Err(wrong_shape(format!(
            "registerAccount takes {REGISTER_ACCOUNT_ARGS} arguments, the script supplies {}",
            args.len()
        )));
    }
    hash_arg(&args[0])?;
    hash_arg(&args[1])?;
    hash_arg(&args[3])?;
    hash_arg(&args[4])?;
    if args[2].as_bytes().is_none() {
        return Err(wrong_shape(
            "registerAccount verifierParams must be a byte string",
        ));
    }
    if !args[5].is_integer() {
        return Err(wrong_shape(
            "registerAccount escapeTimelock must be an integer",
        ));
    }
    reject_zero_hash(&hash_arg(&args[0])?, "registerAccount accountId")
}

/// `executeSponsoredUserOp(accountId, op, paymaster, sponsor,
/// reimbursementAmount)`. Returns the `UserOperation` field list so the caller
/// can derive the downstream facts from the same array it validated.
fn validate_execute_sponsored_user_op(
    call: &InvokeCall,
) -> Result<&[InvokeArg], SponsorIntentError> {
    let args = call.args.as_slice();
    if args.len() != EXECUTE_SPONSORED_USER_OP_ARGS {
        return Err(wrong_shape(format!(
            "executeSponsoredUserOp takes {EXECUTE_SPONSORED_USER_OP_ARGS} arguments, the script supplies {}",
            args.len()
        )));
    }
    reject_zero_hash(&hash_arg(&args[0])?, "executeSponsoredUserOp accountId")?;
    reject_zero_hash(&hash_arg(&args[2])?, "executeSponsoredUserOp paymaster")?;
    reject_zero_hash(&hash_arg(&args[3])?, "executeSponsoredUserOp sponsor")?;

    let op = args[1]
        .as_items()
        .ok_or_else(|| wrong_shape("executeSponsoredUserOp op must be a UserOperation array"))?;
    validate_user_operation(op)?;

    // `ExecuteSponsoredUserOp` asserts `reimbursementAmount > 0`.
    if !args[4].is_integer() {
        return Err(wrong_shape(
            "executeSponsoredUserOp reimbursementAmount must be an integer",
        ));
    }
    if args[4].is_negative_integer() || args[4].as_non_negative_u64() == Some(0) {
        return Err(wrong_shape(
            "executeSponsoredUserOp reimbursementAmount must be positive",
        ));
    }
    Ok(op)
}

/// `ValidateUserOperation` from `UnifiedSmartWallet.Execution.cs`, field by
/// field, so an off-chain acceptance cannot describe a user operation the chain
/// would then refuse.
fn validate_user_operation(fields: &[InvokeArg]) -> Result<(), SponsorIntentError> {
    if fields.len() != USER_OP_FIELDS {
        return Err(wrong_shape(format!(
            "a UserOperation has {USER_OP_FIELDS} fields, the script supplies {}",
            fields.len()
        )));
    }
    reject_zero_hash(&hash_arg(&fields[0])?, "UserOperation TargetContract")?;

    let method = fields[1]
        .as_text()
        .ok_or_else(|| wrong_shape("UserOperation Method must be a UTF-8 string"))?;
    if method.is_empty() || method.len() > MAX_USER_OP_METHOD_LEN {
        return Err(wrong_shape(format!(
            "UserOperation Method must be 1..={MAX_USER_OP_METHOD_LEN} bytes, got {}",
            method.len()
        )));
    }

    let inner_args = fields[2]
        .as_items()
        .ok_or_else(|| wrong_shape("UserOperation Args must be an array"))?;
    if inner_args.len() > MAX_USER_OP_ARGS_LEN {
        return Err(wrong_shape(format!(
            "UserOperation Args must hold at most {MAX_USER_OP_ARGS_LEN} items, got {}",
            inner_args.len()
        )));
    }

    for (index, name) in [(3usize, "Nonce"), (4, "Deadline")] {
        if !fields[index].is_unsigned_within(MAX_USER_OP_INTEGER_BYTES) {
            return Err(wrong_shape(format!(
                "UserOperation {name} must be a non-negative integer inside {MAX_USER_OP_INTEGER_BYTES} bytes"
            )));
        }
    }

    let signature = fields[5]
        .as_bytes()
        .ok_or_else(|| wrong_shape("UserOperation Signature must be a byte string"))?;
    if signature.len() > MAX_USER_OP_SIGNATURE_LEN {
        return Err(wrong_shape(format!(
            "UserOperation Signature must be at most {MAX_USER_OP_SIGNATURE_LEN} bytes, got {}",
            signature.len()
        )));
    }
    Ok(())
}

/// Read a `Hash160` argument as a display-order script hash.
fn hash_arg(arg: &InvokeArg) -> Result<[u8; HASH160_LEN], SponsorIntentError> {
    let bytes = arg
        .as_bytes()
        .ok_or_else(|| wrong_shape("a Hash160 argument must be a byte string"))?;
    if bytes.len() != HASH160_LEN {
        return Err(wrong_shape(format!(
            "a Hash160 argument must be {HASH160_LEN} bytes, got {}",
            bytes.len()
        )));
    }
    let mut wire = [0u8; HASH160_LEN];
    wire.copy_from_slice(bytes);
    wire.reverse();
    Ok(wire)
}

/// `ValidateAccountId`, `Paymaster required`, `Sponsor required` and the
/// `TargetContract` rule all refuse `UInt160.Zero`.
fn reject_zero_hash(hash: &[u8; HASH160_LEN], field: &str) -> Result<(), SponsorIntentError> {
    if hash.iter().all(|byte| *byte == 0) {
        return Err(wrong_shape(format!("{field} must not be the zero hash")));
    }
    Ok(())
}

fn wrong_shape(detail: impl Into<String>) -> SponsorIntentError {
    SponsorIntentError::new(SponsorIntentCode::WrongShape, detail)
}

/// Lowercase hex, for operator-facing refusal detail. Deliberately not the
/// `hex` crate: that is a dev-dependency of this crate and this module ships.
fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[usize::from(byte >> 4)] as char);
        out.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    out
}
