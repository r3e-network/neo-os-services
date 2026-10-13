//! Acceptance for the sponsorable intent validator (CU-150).
//!
//! The row: *validate sponsorable intents by script shape (registerAccount,
//! executeSponsoredUserOp) with fee ceilings*, accepted when *wrong shapes,
//! wrong targets and over-ceiling fees are refused with stable codes*.
//!
//! Every fixture below is built with `create_invoke_script`, the encoder the
//! relayer actually uses, so a test cannot pass against a script shape this
//! repository never emits. Rejection cases are built by giving that encoder the
//! wrong inputs (wrong method, wrong arity, wrong argument kinds) or by handing
//! it raw bytes it did not produce.

use neo_os_core::n3_tx::{create_invoke_script, ContractParam};
use neo_os_core::sponsor_intent::{
    validate_sponsorable_intent, SponsorIntentCode, SponsorIntentError, SponsorIntentRequest,
    SponsorableIntent, SponsorableMethod,
};

/// Display-order script hashes (`0x…` 40-hex form), the order the public API uses.
const AA_CONTRACT: [u8; 20] = [
    0x03, 0x01, 0x3f, 0x49, 0xc4, 0x2a, 0x14, 0x54, 0x6c, 0x8b, 0xbe, 0x58, 0xf9, 0xd4, 0x34, 0xc3,
    0x51, 0x7f, 0xcc, 0xab,
];
const OTHER_CONTRACT: [u8; 20] = [
    0xd2, 0xa4, 0xcf, 0xf3, 0x19, 0x13, 0x01, 0x61, 0x55, 0xe3, 0x8e, 0x47, 0x4a, 0x2c, 0x06, 0xd0,
    0x8b, 0xe2, 0x76, 0xcf,
];
const ACCOUNT: [u8; 20] = [
    0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11,
    0x11, 0x11, 0x11, 0x11,
];
const VERIFIER: [u8; 20] = [
    0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22,
    0x22, 0x22, 0x22, 0x22,
];
const HOOK: [u8; 20] = [
    0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33, 0x33,
    0x33, 0x33, 0x33, 0x33,
];
const BACKUP: [u8; 20] = [
    0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44, 0x44,
    0x44, 0x44, 0x44, 0x44,
];
const DOWNSTREAM: [u8; 20] = [
    0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55,
    0x55, 0x55, 0x55, 0x55,
];
const PAYMASTER: [u8; 20] = [
    0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
    0x66, 0x66, 0x66, 0x66,
];
const SPONSOR: [u8; 20] = [
    0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77,
    0x77, 0x77, 0x77, 0x77,
];

/// A GAS-datoshi ceiling well inside the schema bound, far above every fee below.
const CEILING: u64 = 10_000_000;

fn hash_param(hash: &[u8; 20]) -> ContractParam {
    ContractParam::Hash160(format!("0x{}", hex::encode(hash)))
}

fn register_account_args() -> Vec<ContractParam> {
    vec![
        hash_param(&ACCOUNT),
        hash_param(&VERIFIER),
        ContractParam::HexBytes("cafebabe".to_string()),
        hash_param(&HOOK),
        hash_param(&BACKUP),
        ContractParam::Integer(3600),
    ]
}

/// `UserOperation` as the deployed V3 ABI declares it, in field order:
/// TargetContract, Method, Args, Nonce, Deadline, Signature.
fn user_op(
    target: ContractParam,
    method: ContractParam,
    args: Vec<ContractParam>,
    nonce: i64,
    deadline: i64,
    signature: ContractParam,
) -> ContractParam {
    ContractParam::Array(vec![
        target,
        method,
        ContractParam::Array(args),
        ContractParam::Integer(nonce),
        ContractParam::Integer(deadline),
        signature,
    ])
}

fn good_user_op() -> ContractParam {
    user_op(
        hash_param(&DOWNSTREAM),
        ContractParam::String("transfer".to_string()),
        vec![],
        1,
        4102444800,
        ContractParam::HexBytes("01020304".to_string()),
    )
}

fn execute_sponsored_args(reimbursement: i64) -> Vec<ContractParam> {
    vec![
        hash_param(&ACCOUNT),
        good_user_op(),
        hash_param(&PAYMASTER),
        hash_param(&SPONSOR),
        ContractParam::Integer(reimbursement),
    ]
}

fn register_account_script() -> Vec<u8> {
    create_invoke_script(&AA_CONTRACT, "registerAccount", &register_account_args())
        .expect("valid registerAccount fixture")
}

fn execute_sponsored_script(reimbursement: i64) -> Vec<u8> {
    create_invoke_script(
        &AA_CONTRACT,
        "executeSponsoredUserOp",
        &execute_sponsored_args(reimbursement),
    )
    .expect("valid executeSponsoredUserOp fixture")
}

fn request<'a>(
    script: &'a [u8],
    contract: [u8; 20],
    ceiling: u64,
    transaction_fee_units: u64,
) -> SponsorIntentRequest<'a> {
    SponsorIntentRequest {
        script,
        sponsorable_contract: contract,
        fee_ceiling_units: ceiling,
        transaction_fee_units,
    }
}

fn code_of(result: Result<SponsorableIntent, SponsorIntentError>) -> SponsorIntentCode {
    match result {
        Ok(intent) => panic!(
            "expected a refusal, got an accepted {} intent",
            intent.method.as_str()
        ),
        Err(error) => error.code,
    }
}

// ---------------------------------------------------------------------------
// 1. Wrong shapes are refused
// ---------------------------------------------------------------------------

#[test]
fn empty_script_is_refused() {
    let code = code_of(validate_sponsorable_intent(&request(
        b"",
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::ScriptRequired);
    assert_eq!(code.as_str(), "SPONSOR_INTENT_SCRIPT_REQUIRED");
}

#[test]
fn a_push_only_script_is_refused_as_undecodable() {
    // PUSHDATA1 "hello" — valid VM, not a contract call at all.
    let script = vec![0x0c, 0x05, b'h', b'e', b'l', b'l', b'o'];
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::ScriptUndecodable);
    assert_eq!(code.as_str(), "SPONSOR_INTENT_SCRIPT_UNDECODABLE");
}

#[test]
fn two_contract_calls_in_one_script_are_refused() {
    let once = register_account_script();
    let mut script = once.clone();
    script.extend_from_slice(&once);
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::ScriptUndecodable);
}

#[test]
fn trailing_opcodes_after_the_call_are_refused() {
    let mut script = register_account_script();
    script.push(0x0c);
    script.push(0x01);
    script.push(0xff);
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::ScriptUndecodable);
}

#[test]
fn a_leftover_stack_item_before_the_call_is_refused() {
    // An extra PUSH0 in front of a canonical single call: the call still decodes,
    // but one stack item is unaccounted for, so the shape is not fully described.
    let mut script = vec![0x10];
    script.extend_from_slice(&register_account_script());
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::ScriptUndecodable);
}

#[test]
fn a_non_contract_call_syscall_is_refused() {
    // The canonical call with its `System.Contract.Call` interop hash replaced by
    // `Neo.Crypto.Verify` (`41 56 e7 b3 27`).
    let mut script = register_account_script();
    let len = script.len();
    script[len - 4..].copy_from_slice(&[0x56, 0xe7, 0xb3, 0x27]);
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::ScriptUndecodable);
}

#[test]
fn an_unsupported_opcode_is_refused_rather_than_guessed() {
    // A jump opcode, which no wallet puts in an invocation script: the decoder
    // must refuse it instead of treating the rest of the script as data.
    let mut script = vec![0x22]; // JMP
    script.extend_from_slice(&register_account_script());
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::ScriptUndecodable);
}

#[test]
fn the_plural_spelling_register_accounts_is_refused() {
    let script = create_invoke_script(&AA_CONTRACT, "registerAccounts", &register_account_args())
        .expect("valid fixture");
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::WrongShape);
    assert_eq!(code.as_str(), "SPONSOR_INTENT_WRONG_SHAPE");
}

#[test]
fn the_plural_spelling_execute_sponsored_user_ops_is_refused() {
    let args = vec![
        hash_param(&ACCOUNT),
        ContractParam::Array(vec![good_user_op()]),
        hash_param(&PAYMASTER),
        hash_param(&SPONSOR),
        ContractParam::Integer(1),
    ];
    let script = create_invoke_script(&AA_CONTRACT, "executeSponsoredUserOps", &args)
        .expect("valid fixture");
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::WrongShape);
}

#[test]
fn an_unrelated_method_is_refused() {
    let script = create_invoke_script(&AA_CONTRACT, "updateVerifier", &register_account_args())
        .expect("valid fixture");
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::WrongShape);
}

#[test]
fn register_account_with_five_arguments_is_refused() {
    let mut args = register_account_args();
    args.pop();
    let script =
        create_invoke_script(&AA_CONTRACT, "registerAccount", &args).expect("valid fixture");
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::WrongShape);
}

#[test]
fn register_account_with_seven_arguments_is_refused() {
    let mut args = register_account_args();
    args.push(ContractParam::Integer(0));
    let script =
        create_invoke_script(&AA_CONTRACT, "registerAccount", &args).expect("valid fixture");
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::WrongShape);
}

#[test]
fn execute_sponsored_user_op_with_six_arguments_is_refused() {
    let mut args = execute_sponsored_args(1);
    args.push(ContractParam::Integer(0));
    let script =
        create_invoke_script(&AA_CONTRACT, "executeSponsoredUserOp", &args).expect("valid fixture");
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::WrongShape);
}

#[test]
fn a_hash160_slot_that_is_not_a_twenty_byte_string_is_refused() {
    let mut args = register_account_args();
    args[0] = ContractParam::String("not-a-hash".to_string());
    let script =
        create_invoke_script(&AA_CONTRACT, "registerAccount", &args).expect("valid fixture");
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::WrongShape);
}

#[test]
fn a_nineteen_byte_hash160_slot_is_refused() {
    let mut args = register_account_args();
    args[0] = ContractParam::HexBytes("11111111111111111111111111111111111111".to_string());
    let script =
        create_invoke_script(&AA_CONTRACT, "registerAccount", &args).expect("valid fixture");
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::WrongShape);
}

#[test]
fn an_integer_slot_pushed_as_a_byte_string_is_refused() {
    let mut args = register_account_args();
    args[5] = ContractParam::HexBytes("400e".to_string());
    let script =
        create_invoke_script(&AA_CONTRACT, "registerAccount", &args).expect("valid fixture");
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::WrongShape);
}

#[test]
fn a_user_operation_that_is_not_an_array_is_refused() {
    let mut args = execute_sponsored_args(1);
    args[1] = ContractParam::String("not-an-op".to_string());
    let script =
        create_invoke_script(&AA_CONTRACT, "executeSponsoredUserOp", &args).expect("valid fixture");
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::WrongShape);
}

#[test]
fn a_user_operation_with_five_fields_is_refused() {
    let mut op = match good_user_op() {
        ContractParam::Array(fields) => fields,
        _ => panic!("good_user_op must build a VM array"),
    };
    op.pop();
    let mut args = execute_sponsored_args(1);
    args[1] = ContractParam::Array(op);
    let script =
        create_invoke_script(&AA_CONTRACT, "executeSponsoredUserOp", &args).expect("valid fixture");
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::WrongShape);
}

#[test]
fn a_user_operation_with_seven_fields_is_refused() {
    let mut op = match good_user_op() {
        ContractParam::Array(fields) => fields,
        _ => panic!("good_user_op must build a VM array"),
    };
    op.push(ContractParam::Integer(0));
    let mut args = execute_sponsored_args(1);
    args[1] = ContractParam::Array(op);
    let script =
        create_invoke_script(&AA_CONTRACT, "executeSponsoredUserOp", &args).expect("valid fixture");
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::WrongShape);
}

#[test]
fn a_zero_downstream_target_is_refused() {
    let op = match good_user_op() {
        ContractParam::Array(mut fields) => {
            fields[0] = hash_param(&[0u8; 20]);
            fields
        }
        _ => panic!("good_user_op must build a VM array"),
    };
    let mut args = execute_sponsored_args(1);
    args[1] = ContractParam::Array(op);
    let script =
        create_invoke_script(&AA_CONTRACT, "executeSponsoredUserOp", &args).expect("valid fixture");
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::WrongShape);
}

#[test]
fn an_empty_downstream_method_is_refused() {
    let op = match good_user_op() {
        ContractParam::Array(mut fields) => {
            fields[1] = ContractParam::String(String::new());
            fields
        }
        _ => panic!("good_user_op must build a VM array"),
    };
    let mut args = execute_sponsored_args(1);
    args[1] = ContractParam::Array(op);
    let script =
        create_invoke_script(&AA_CONTRACT, "executeSponsoredUserOp", &args).expect("valid fixture");
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::WrongShape);
}

#[test]
fn a_downstream_method_longer_than_the_contract_bound_is_refused() {
    // UnifiedSmartWallet.Execution.cs MaxUserOperationMethodLength = 128.
    let op = match good_user_op() {
        ContractParam::Array(mut fields) => {
            fields[1] = ContractParam::String("m".repeat(129));
            fields
        }
        _ => panic!("good_user_op must build a VM array"),
    };
    let mut args = execute_sponsored_args(1);
    args[1] = ContractParam::Array(op);
    let script =
        create_invoke_script(&AA_CONTRACT, "executeSponsoredUserOp", &args).expect("valid fixture");
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::WrongShape);
}

#[test]
fn downstream_args_beyond_the_contract_cardinality_bound_are_refused() {
    // UnifiedSmartWallet.Execution.cs MaxUserOperationArgsLength = 64.
    let op = match good_user_op() {
        ContractParam::Array(mut fields) => {
            fields[2] = ContractParam::Array((0..65).map(|_| ContractParam::Integer(0)).collect());
            fields
        }
        _ => panic!("good_user_op must build a VM array"),
    };
    let mut args = execute_sponsored_args(1);
    args[1] = ContractParam::Array(op);
    let script =
        create_invoke_script(&AA_CONTRACT, "executeSponsoredUserOp", &args).expect("valid fixture");
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::WrongShape);
}

#[test]
fn a_negative_nonce_is_refused() {
    let op = match good_user_op() {
        ContractParam::Array(mut fields) => {
            fields[3] = ContractParam::Integer(-1);
            fields
        }
        _ => panic!("good_user_op must build a VM array"),
    };
    let mut args = execute_sponsored_args(1);
    args[1] = ContractParam::Array(op);
    let script =
        create_invoke_script(&AA_CONTRACT, "executeSponsoredUserOp", &args).expect("valid fixture");
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::WrongShape);
}

#[test]
fn a_negative_deadline_is_refused() {
    let op = match good_user_op() {
        ContractParam::Array(mut fields) => {
            fields[4] = ContractParam::Integer(-1);
            fields
        }
        _ => panic!("good_user_op must build a VM array"),
    };
    let mut args = execute_sponsored_args(1);
    args[1] = ContractParam::Array(op);
    let script =
        create_invoke_script(&AA_CONTRACT, "executeSponsoredUserOp", &args).expect("valid fixture");
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::WrongShape);
}

#[test]
fn a_signature_beyond_the_contract_bound_is_refused() {
    // UnifiedSmartWallet.Execution.cs MaxUserOperationSignatureLength = 1024.
    let op = match good_user_op() {
        ContractParam::Array(mut fields) => {
            fields[5] = ContractParam::HexBytes("00".repeat(1025));
            fields
        }
        _ => panic!("good_user_op must build a VM array"),
    };
    let mut args = execute_sponsored_args(1);
    args[1] = ContractParam::Array(op);
    let script =
        create_invoke_script(&AA_CONTRACT, "executeSponsoredUserOp", &args).expect("valid fixture");
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::WrongShape);
}

#[test]
fn a_zero_reimbursement_is_refused() {
    // ExecuteSponsoredUserOp asserts reimbursementAmount > 0 on chain.
    let script = execute_sponsored_script(0);
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::WrongShape);
}

#[test]
fn a_negative_reimbursement_is_refused() {
    let script = execute_sponsored_script(-5);
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::WrongShape);
}

// ---------------------------------------------------------------------------
// 2. Wrong targets are refused
// ---------------------------------------------------------------------------

#[test]
fn register_account_at_another_contract_is_refused() {
    let script = create_invoke_script(&OTHER_CONTRACT, "registerAccount", &register_account_args())
        .expect("valid fixture");
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::WrongTarget);
    assert_eq!(code.as_str(), "SPONSOR_INTENT_WRONG_TARGET");
}

#[test]
fn execute_sponsored_user_op_at_another_contract_is_refused() {
    let script = create_invoke_script(
        &OTHER_CONTRACT,
        "executeSponsoredUserOp",
        &execute_sponsored_args(1),
    )
    .expect("valid fixture");
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::WrongTarget);
}

#[test]
fn the_target_check_precedes_the_fee_check() {
    // Both the target and the fee are wrong: the first refusal is the target,
    // so the codes stay predictable for a caller that matches on one of them.
    let script = create_invoke_script(&OTHER_CONTRACT, "registerAccount", &register_account_args())
        .expect("valid fixture");
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        1,
        1_000_000,
    )));
    assert_eq!(code, SponsorIntentCode::WrongTarget);
}

// ---------------------------------------------------------------------------
// 3. Over-ceiling fees are refused
// ---------------------------------------------------------------------------

#[test]
fn a_reimbursement_alone_above_the_ceiling_is_refused() {
    let script = execute_sponsored_script(2_000_000);
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        1_000_000,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::FeeOverCeiling);
    assert_eq!(code.as_str(), "SPONSOR_INTENT_FEE_OVER_CEILING");
}

#[test]
fn a_transaction_fee_alone_above_the_ceiling_is_refused() {
    let script = execute_sponsored_script(1_000);
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        1_000_000,
        2_000_000,
    )));
    assert_eq!(code, SponsorIntentCode::FeeOverCeiling);
}

#[test]
fn a_sum_above_the_ceiling_is_refused_even_when_neither_part_is() {
    // 600_000 + 600_000 = 1_200_000 > 1_000_000, while each part alone fits.
    let script = execute_sponsored_script(600_000);
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        1_000_000,
        600_000,
    )));
    assert_eq!(code, SponsorIntentCode::FeeOverCeiling);
}

#[test]
fn a_register_account_fee_above_the_ceiling_is_refused() {
    // registerAccount carries no reimbursement, so the sponsor's exposure is
    // the enclosing transaction fee alone.
    let script = register_account_script();
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        1_000_000,
        1_000_001,
    )));
    assert_eq!(code, SponsorIntentCode::FeeOverCeiling);
}

#[test]
fn a_reimbursement_beyond_the_ceiling_domain_is_refused_as_over_ceiling() {
    // A reimbursement claim no realistic ceiling can cover is refused as
    // over-ceiling, not accepted because it happens to fit the integer domain.
    let script = execute_sponsored_script(i64::MAX);
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        CEILING,
        1_000,
    )));
    assert_eq!(code, SponsorIntentCode::FeeOverCeiling);
}

#[test]
fn a_zero_ceiling_is_refused_as_invalid() {
    let script = register_account_script();
    let code = code_of(validate_sponsorable_intent(&request(
        &script,
        AA_CONTRACT,
        0,
        0,
    )));
    assert_eq!(code, SponsorIntentCode::FeeCeilingInvalid);
    assert_eq!(code.as_str(), "SPONSOR_INTENT_FEE_CEILING_INVALID");
}

#[test]
fn a_fee_exactly_at_the_ceiling_is_accepted() {
    let script = register_account_script();
    let intent = validate_sponsorable_intent(&request(&script, AA_CONTRACT, 1_000_000, 1_000_000))
        .expect("exactly at the ceiling must be accepted");
    assert_eq!(intent.sponsor_fee_units, 1_000_000);
}

#[test]
fn a_fee_one_datoshi_under_the_ceiling_is_accepted() {
    let script = execute_sponsored_script(400_000);
    let intent = validate_sponsorable_intent(&request(&script, AA_CONTRACT, 1_000_000, 599_999))
        .expect("one datoshi under the ceiling must be accepted");
    assert_eq!(intent.sponsor_fee_units, 999_999);
}

// ---------------------------------------------------------------------------
// 4. The code table is frozen
// ---------------------------------------------------------------------------

#[test]
fn the_refusal_code_table_is_frozen() {
    let codes = [
        (
            SponsorIntentCode::ScriptRequired,
            "SPONSOR_INTENT_SCRIPT_REQUIRED",
        ),
        (
            SponsorIntentCode::ScriptUndecodable,
            "SPONSOR_INTENT_SCRIPT_UNDECODABLE",
        ),
        (SponsorIntentCode::WrongShape, "SPONSOR_INTENT_WRONG_SHAPE"),
        (
            SponsorIntentCode::WrongTarget,
            "SPONSOR_INTENT_WRONG_TARGET",
        ),
        (
            SponsorIntentCode::FeeCeilingInvalid,
            "SPONSOR_INTENT_FEE_CEILING_INVALID",
        ),
        (
            SponsorIntentCode::FeeOverCeiling,
            "SPONSOR_INTENT_FEE_OVER_CEILING",
        ),
    ];
    for (code, expected) in codes {
        assert_eq!(code.as_str(), expected);
    }
    assert_eq!(codes.len(), SponsorIntentCode::ALL.len());
    for (code, expected) in codes {
        assert!(
            SponsorIntentCode::ALL.contains(&code),
            "{expected} is missing from SponsorIntentCode::ALL"
        );
    }
}

// ---------------------------------------------------------------------------
// 5. Happy paths, and the facts the caller is given
// ---------------------------------------------------------------------------

#[test]
fn a_register_account_intent_is_accepted_and_derives_its_facts() {
    let script = register_account_script();
    let intent = validate_sponsorable_intent(&request(&script, AA_CONTRACT, CEILING, 7_500))
        .expect("a canonical registerAccount must be accepted");
    assert_eq!(intent.method, SponsorableMethod::RegisterAccount);
    assert_eq!(intent.method.as_str(), "registerAccount");
    assert_eq!(intent.target, AA_CONTRACT);
    assert_eq!(intent.account_id, ACCOUNT);
    assert_eq!(intent.downstream_target, None);
    assert_eq!(intent.downstream_method, None);
    assert_eq!(intent.reimbursement_units, 0);
    assert_eq!(intent.transaction_fee_units, 7_500);
    assert_eq!(intent.sponsor_fee_units, 7_500);
}

#[test]
fn an_execute_sponsored_user_op_intent_is_accepted_and_derives_its_facts() {
    let script = execute_sponsored_script(250_000);
    let intent = validate_sponsorable_intent(&request(&script, AA_CONTRACT, CEILING, 7_500))
        .expect("a canonical executeSponsoredUserOp must be accepted");
    assert_eq!(intent.method, SponsorableMethod::ExecuteSponsoredUserOp);
    assert_eq!(intent.method.as_str(), "executeSponsoredUserOp");
    assert_eq!(intent.target, AA_CONTRACT);
    assert_eq!(intent.account_id, ACCOUNT);
    assert_eq!(intent.downstream_target, Some(DOWNSTREAM));
    assert_eq!(intent.downstream_method.as_deref(), Some("transfer"));
    assert_eq!(intent.reimbursement_units, 250_000);
    assert_eq!(intent.transaction_fee_units, 7_500);
    assert_eq!(intent.sponsor_fee_units, 257_500);
}

#[test]
fn the_derived_target_is_the_script_target_not_the_request_target() {
    // The request names the sponsorable contract; the accepted intent reports
    // what the script actually calls. A caller that echoed the request back
    // would let a submitted description stand in for the bytes.
    let script = create_invoke_script(&OTHER_CONTRACT, "registerAccount", &register_account_args())
        .expect("valid fixture");
    let refused = validate_sponsorable_intent(&request(&script, OTHER_CONTRACT, CEILING, 1))
        .expect("matching target must be accepted");
    assert_eq!(refused.target, OTHER_CONTRACT);
}

#[test]
fn a_sponsored_user_op_may_target_any_well_formed_downstream_contract() {
    // The downstream target is derived and reported; whether it is payable is
    // the paymaster allow-list and the signer policy, not this validator.
    let op = match good_user_op() {
        ContractParam::Array(mut fields) => {
            fields[0] = hash_param(&AA_CONTRACT);
            fields[1] = ContractParam::String("vote_on_proposal".to_string());
            fields
        }
        _ => panic!("good_user_op must build a VM array"),
    };
    let mut args = execute_sponsored_args(1);
    args[1] = ContractParam::Array(op);
    let script =
        create_invoke_script(&AA_CONTRACT, "executeSponsoredUserOp", &args).expect("valid fixture");
    let intent = validate_sponsorable_intent(&request(&script, AA_CONTRACT, CEILING, 1_000))
        .expect("a well-formed downstream call must be accepted");
    assert_eq!(intent.downstream_target, Some(AA_CONTRACT));
    assert_eq!(
        intent.downstream_method.as_deref(),
        Some("vote_on_proposal")
    );
}

// ---------------------------------------------------------------------------
// 6. Fail closed
// ---------------------------------------------------------------------------

#[test]
fn every_refusal_is_an_error_never_a_flagged_success() {
    let cases: Vec<(Vec<u8>, [u8; 20], u64, u64)> = vec![
        (vec![], AA_CONTRACT, CEILING, 1),
        (vec![0x0c, 0x00], AA_CONTRACT, CEILING, 1),
        (register_account_script(), OTHER_CONTRACT, CEILING, 1),
        (register_account_script(), AA_CONTRACT, CEILING, u64::MAX),
        (execute_sponsored_script(0), AA_CONTRACT, CEILING, 1),
        (register_account_script(), AA_CONTRACT, 0, 0),
    ];
    for (script, contract, ceiling, fee) in cases {
        let result = validate_sponsorable_intent(&request(&script, contract, ceiling, fee));
        assert!(
            result.is_err(),
            "expected a refusal for script {} bytes / ceiling {ceiling} / fee {fee}",
            script.len()
        );
    }
}

#[test]
fn refusals_are_reproducible() {
    let script = create_invoke_script(&OTHER_CONTRACT, "registerAccount", &register_account_args())
        .expect("valid fixture");
    let first =
        validate_sponsorable_intent(&request(&script, AA_CONTRACT, CEILING, 1)).unwrap_err();
    let second =
        validate_sponsorable_intent(&request(&script, AA_CONTRACT, CEILING, 1)).unwrap_err();
    assert_eq!(first, second);
    assert_eq!(first.to_string(), second.to_string());
    assert!(first.to_string().starts_with("SPONSOR_INTENT_WRONG_TARGET"));
}

// ---------------------------------------------------------------------------
// 7. The fee is measured, never declared (CU-151)
//
// CU-150 left one obligation to the sponsor API: `transaction_fee_units` must
// be read from the unsigned transaction envelope that is about to be signed
// and broadcast. These tests pin that hand-off against the real encoder, so a
// caller cannot reintroduce a declared figure by passing one.
// ---------------------------------------------------------------------------

use neo_os_core::n3_tx::{parse_unsigned_tx, FeedSigner, FeedTx};

const FEE_PAYER: [u8; 20] = [
    0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88,
    0x88, 0x88, 0x88, 0x88,
];

fn envelope(script: &[u8], system_fee: u64, network_fee: u64) -> Vec<u8> {
    FeedTx {
        nonce: 1,
        valid_until_block: 42,
        system_fee,
        network_fee,
        signer: FeedSigner {
            script_hash: FEE_PAYER,
        },
        script,
    }
    .serialize_unsigned()
}

#[test]
fn the_fee_the_validator_prices_is_read_from_the_envelope() {
    let script = register_account_script();
    let bytes = envelope(&script, 1_000, 250);
    let parsed = parse_unsigned_tx(&bytes).expect("the encoder's own envelope must parse");
    let measured = parsed
        .transaction_fee_units()
        .expect("fee fits the datoshi domain");

    let accepted = validate_sponsorable_intent(&SponsorIntentRequest {
        script: &parsed.script,
        sponsorable_contract: AA_CONTRACT,
        fee_ceiling_units: CEILING,
        transaction_fee_units: measured,
    })
    .expect("a priced-by-envelope intent is sponsorable");

    assert_eq!(measured, 1_250);
    assert_eq!(accepted.transaction_fee_units, 1_250);
    assert_eq!(accepted.reimbursement_units, 0);
    assert_eq!(accepted.sponsor_fee_units, 1_250);
}

#[test]
fn a_sponsored_operation_prices_the_envelope_fee_plus_the_script_claim() {
    let script = execute_sponsored_script(4_000);
    let parsed = parse_unsigned_tx(&envelope(&script, 1_000, 250)).expect("valid envelope");
    let measured = parsed.transaction_fee_units().expect("fee fits");

    let accepted = validate_sponsorable_intent(&SponsorIntentRequest {
        script: &parsed.script,
        sponsorable_contract: AA_CONTRACT,
        fee_ceiling_units: CEILING,
        transaction_fee_units: measured,
    })
    .expect("valid sponsored operation");

    assert_eq!(accepted.reimbursement_units, 4_000);
    assert_eq!(accepted.sponsor_fee_units, 5_250);
}

#[test]
fn an_envelope_whose_measured_fee_exceeds_the_ceiling_is_refused() {
    // The submitter cannot declare its way under the ceiling: the figure the
    // validator prices is the one in the bytes that will be signed.
    let script = register_account_script();
    let parsed =
        parse_unsigned_tx(&envelope(&script, 9_000_000, 2_000_000)).expect("valid envelope");
    let measured = parsed.transaction_fee_units().expect("fee fits");

    let refused = validate_sponsorable_intent(&SponsorIntentRequest {
        script: &parsed.script,
        sponsorable_contract: AA_CONTRACT,
        fee_ceiling_units: CEILING,
        transaction_fee_units: measured,
    })
    .unwrap_err();

    assert_eq!(refused.code, SponsorIntentCode::FeeOverCeiling);
}

#[test]
fn the_script_the_validator_sees_is_the_one_inside_the_envelope() {
    // There is no separate script field on the request. The bytes that are
    // priced and the bytes that are validated come from the same envelope.
    let script = register_account_script();
    let parsed = parse_unsigned_tx(&envelope(&script, 10, 10)).expect("valid envelope");

    let accepted = validate_sponsorable_intent(&SponsorIntentRequest {
        script: &parsed.script,
        sponsorable_contract: AA_CONTRACT,
        fee_ceiling_units: CEILING,
        transaction_fee_units: parsed.transaction_fee_units().expect("fee fits"),
    })
    .expect("valid intent");

    assert_eq!(parsed.script, script);
    assert_eq!(accepted.method, SponsorableMethod::RegisterAccount);
}
