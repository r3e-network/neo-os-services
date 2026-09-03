//! Decoder tests, pinned to mined Neo N3 mainnet transactions.
//!
//! Every `unsigned` blob below was captured verbatim from an RPC node, and the
//! expectations were derived from the chain rather than from this module — an
//! implementation that merely agreed with itself had already shipped three
//! signing bugs. Where a wrong answer is available (argument order, hash byte
//! order, which scope bits exist), the test says what breaks if it is reversed.

use super::*;

/// NEO and GAS the way an operator pastes them from an explorer: display order,
/// which is the reverse of the 20 bytes that appear on the wire.
const NEO_DISPLAY: &str = "0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5";
const GAS_DISPLAY: &str = "0xd2a4cff31913016155e38e474a2c06d08be276cf";

/// A mined transaction and everything this module must recover from it.
struct Vector {
    name: &'static str,
    /// `SerializeUnsigned` bytes — exactly what the signing preimage hashes.
    unsigned: &'static str,
    byte_len: usize,
    nonce: u32,
    system_fee: i64,
    network_fee: i64,
    valid_until_block: u32,
    /// First signer's account, wire order.
    sender: &'static str,
    /// First signer's scope byte.
    scope: u8,
    /// Allowed contracts on the first signer, wire order.
    allowed_contracts: &'static [&'static str],
    script_len: usize,
    /// Expected calls as (contract in display order, method, call flags).
    calls: &'static [(&'static str, &'static str, u8)],
    /// Expected NEP-17 movements as (asset, destination, raw units), both
    /// hashes in display order; `from` is always the sender in these vectors.
    transfers: &'static [(&'static str, &'static str, i128)],
}

const VECTORS: &[Vector] = &[
    Vector {
        name: "neo_transfer",
        unsigned: "00dc02000051bf1000000000009f490200000000007d4b4c000178bd4e76c4e521ec4a556efc0121bb34c9c8fd040100580b01f0010c14bf3e1cb378561797193a6d908cead3e5c9d2bb360c1478bd4e76c4e521ec4a556efc0121bb34c9c8fd0414c01f0c087472616e736665720c14f563ea40bc283d4d0e05c48ea305b3f2a07340ef41627d5b52",
        byte_len: 137,
        nonce: 732,
        system_fee: 1097553,
        network_fee: 149919,
        valid_until_block: 5000061,
        sender: "78bd4e76c4e521ec4a556efc0121bb34c9c8fd04",
        scope: 0x01,
        allowed_contracts: &[],
        script_len: 88,
        calls: &[("0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5", "transfer", 15)],
        transfers: &[("0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5", "0x36bbd2c9e5d3ea8c906d3a1997175678b31c3ebf", 496)],
    },
    Vector {
        name: "mint_ftoken_with_custom_contract_scope",
        unsigned: "00ad3cf346d87f8903000000004cb80200000000005e4b4c0001cfad99a926e5f92ec4ffc645eb1f8d7bc3ba0bed10049328aec1e84c93855e2fb4a01f5eb7ec15e1abd6b15f3a93f9e33b279ef052736ba5c2bc00d40510600519b33c7506eb9a08145e425a7bc9cbbf9b79b92b3b08a322e2fd3b43f576ee5caa450143a9ff00fd2e020c5851765a4a7446396e4149453571705a376e764e37556278794d32554f5577633764704d317a4d6b6f6b322b46366d41474d7a333735756e684533707a2f4e62384d72765331772b78424b566444706a495a64436169773d3d0d5c0165794a77636d6c6a5a584d694f694237496b5a4d54534936494349784d6a49324d4441774d4441774d4441774d4441774d4441794d53497349434a46564567694f6941694d7a55314e7a59354e5441774d4441774d4441774d4441774d4441774d44417749697767496b4a5551794936494349324e6a51314e7a63344e7a55774d4441774d4441774d4449354d54417a4f444d7749697767496b4a4f51694936494349304d5463784e5455774d4441774d4441774d4441774d4455324f44517a4e43497349434a69546b5650496a6f67496a45334e7a59794e6a41774d4441774d4441774d4441774d4441774d4441694c4341695a6c644356454d694f6941694e6a59304e5463334f4463314d4441774d4441774d4441794f5445774d7a677a4d434a394c4341695a47566a6157316862484d694f6941794d437767496d563463476c795a584d694f6941784e7a41354e5463784d54453566513d3d0300b08ef01b0000000c14cfad99a926e5f92ec4ffc645eb1f8d7bc3ba0bed0c14b15f3a93f9e33b279ef052736ba5c2bc00d405100c149328aec1e84c93855e2fb4a01f5eb7ec15e1abd616c01f0c0a6d696e7446546f6b656e0c14600519b33c7506eb9a08145e425a7bc9cbbf9b7941627d5b52",
        byte_len: 690,
        nonce: 1190345901,
        system_fee: 59342808,
        network_fee: 178252,
        valid_until_block: 5000030,
        sender: "cfad99a926e5f92ec4ffc645eb1f8d7bc3ba0bed",
        scope: 0x10,
        allowed_contracts: &["9328aec1e84c93855e2fb4a01f5eb7ec15e1abd6", "b15f3a93f9e33b279ef052736ba5c2bc00d40510", "600519b33c7506eb9a08145e425a7bc9cbbf9b79", "b92b3b08a322e2fd3b43f576ee5caa450143a9ff"],
        script_len: 558,
        calls: &[("0x799bbfcbc97b5a425e14089aeb06753cb3190560", "mintFToken", 15)],
        transfers: &[],
    },
    Vector {
        name: "gas_transfer",
        unsigned: "0043b4d76b804f120000000000d0fb010000000000ac4b4c00015341cf8cf9e8cf4a9aaf36255e16901b8cb174bc01005e0b03e068accf260000000c144ebcda67ec45164df73dadec584f986c4c318e270c145341cf8cf9e8cf4a9aaf36255e16901b8cb174bc14c01f0c087472616e736665720c14cf76e28bd0062c4a478ee35561011319f3cfa4d241627d5b52",
        byte_len: 143,
        nonce: 1809298499,
        system_fee: 1200000,
        network_fee: 130000,
        valid_until_block: 5000108,
        sender: "5341cf8cf9e8cf4a9aaf36255e16901b8cb174bc",
        scope: 0x01,
        allowed_contracts: &[],
        script_len: 94,
        calls: &[("0xd2a4cff31913016155e38e474a2c06d08be276cf", "transfer", 15)],
        transfers: &[("0xd2a4cff31913016155e38e474a2c06d08be276cf", "0x278e314c6c984f58ecad3df74d1645ec67dabc4e", 166692940000)],
    },
    Vector {
        name: "batched_gas_transfers",
        unsigned: "00aa5c361690e63c0000000000e04c020000000000b14b4c0001f4291817b6024df95218c71ba4314dbf2fd305a10100fd6c010c000240787d010c145f4443e3a8cec6361894dc200f1275140684d4410c14f4291817b6024df95218c71ba4314dbf2fd305a114c01f0c087472616e736665720c14cf76e28bd0062c4a478ee35561011319f3cfa4d241627d5b520c000240787d010c140853999e728a72d65f1dd1068736c1fdc5669cda0c14f4291817b6024df95218c71ba4314dbf2fd305a114c01f0c087472616e736665720c14cf76e28bd0062c4a478ee35561011319f3cfa4d241627d5b520c000240787d010c14bac48a0dd637ab3f0a9ec78a40d2b5dc6309146e0c14f4291817b6024df95218c71ba4314dbf2fd305a114c01f0c087472616e736665720c14cf76e28bd0062c4a478ee35561011319f3cfa4d241627d5b520c000240787d010c14c6b8f8c93ab694207cf74606c2d5e7efb319e5100c14f4291817b6024df95218c71ba4314dbf2fd305a114c01f0c087472616e736665720c14cf76e28bd0062c4a478ee35561011319f3cfa4d241627d5b52",
        byte_len: 415,
        nonce: 372661418,
        system_fee: 3991184,
        network_fee: 150752,
        valid_until_block: 5000113,
        sender: "f4291817b6024df95218c71ba4314dbf2fd305a1",
        scope: 0x01,
        allowed_contracts: &[],
        script_len: 364,
        calls: &[("0xd2a4cff31913016155e38e474a2c06d08be276cf", "transfer", 15), ("0xd2a4cff31913016155e38e474a2c06d08be276cf", "transfer", 15), ("0xd2a4cff31913016155e38e474a2c06d08be276cf", "transfer", 15), ("0xd2a4cff31913016155e38e474a2c06d08be276cf", "transfer", 15)],
        transfers: &[("0xd2a4cff31913016155e38e474a2c06d08be276cf", "0x41d484061475120f20dc941836c6cea8e343445f", 25000000), ("0xd2a4cff31913016155e38e474a2c06d08be276cf", "0xda9c66c5fdc1368706d11d5fd6728a729e995308", 25000000), ("0xd2a4cff31913016155e38e474a2c06d08be276cf", "0x6e140963dcb5d2408ac79e0a3fab37d60d8ac4ba", 25000000), ("0xd2a4cff31913016155e38e474a2c06d08be276cf", "0x10e519b3efe7d5c20646f77c2094b63ac9f8b8c6", 25000000)],
    },

];

// Offsets into `VECTORS[0]` (`neo_transfer`: one `CalledByEntry` signer, no
// attributes, 88-byte script), which each mutation test below starts from.
const OFFSET_SIGNER_COUNT: usize = 25;
const OFFSET_ACCOUNT: usize = 26;
const OFFSET_SCOPE: usize = 46;
const OFFSET_ATTRIBUTES: usize = 47;
const OFFSET_SCRIPT_LEN: usize = 48;

fn from_display(display: &str) -> [u8; HASH160_LEN] {
    display_to_script_hash(display).expect("test data uses real hashes")
}

fn from_wire(encoded: &str) -> [u8; HASH160_LEN] {
    let bytes = hex::decode(encoded).expect("test data is hex");
    bytes.try_into().expect("test data is a UInt160")
}

fn bytes_of(vector: &Vector) -> Vec<u8> {
    hex::decode(vector.unsigned).expect("vector hex")
}

fn parse(vector: &Vector) -> UnsignedTransaction {
    UnsignedTransaction::parse(&bytes_of(vector))
        .unwrap_or_else(|error| unreachable!("{}: {error}", vector.name))
}

fn neo_transfer() -> Vec<u8> {
    bytes_of(&VECTORS[0])
}

#[test]
fn parses_mined_transactions_field_by_field() {
    for vector in VECTORS {
        let label = vector.name;
        assert_eq!(bytes_of(vector).len(), vector.byte_len, "{label}");
        let tx = parse(vector);
        assert_eq!(tx.version, 0, "{label}");
        assert_eq!(tx.nonce, vector.nonce, "{label}");
        assert_eq!(tx.system_fee, vector.system_fee, "{label}");
        assert_eq!(tx.network_fee, vector.network_fee, "{label}");
        assert_eq!(tx.valid_until_block, vector.valid_until_block, "{label}");
        assert_eq!(tx.sender(), Some(from_wire(vector.sender)), "{label}");
        assert_eq!(tx.signers.len(), 1, "{label}");
        assert_eq!(tx.signers[0].scope, Scope(vector.scope), "{label}");
        assert!(tx.signers[0].allowed_groups.is_empty(), "{label}");
        assert!(tx.attributes.is_empty(), "{label}");
        assert_eq!(tx.script.len(), vector.script_len, "{label}");
        let allowed: Vec<[u8; HASH160_LEN]> = vector
            .allowed_contracts
            .iter()
            .map(|hash| from_wire(hash))
            .collect();
        assert_eq!(tx.signers[0].allowed_contracts, allowed, "{label}");
    }
}

#[test]
fn recovers_every_contract_call_in_the_script() {
    for vector in VECTORS {
        let label = vector.name;
        let calls = parse(vector)
            .calls()
            .unwrap_or_else(|error| unreachable!("{label}: {error}"));
        assert_eq!(calls.len(), vector.calls.len(), "{label}");
        for (call, (contract, method, flags)) in calls.iter().zip(vector.calls) {
            assert_eq!(call.contract, from_display(contract), "{label}");
            assert_eq!(call.method, *method, "{label}");
            assert_eq!(call.flags, *flags, "{label}");
        }
    }
}

#[test]
fn folds_native_transfers_into_amounts_a_policy_can_bound() {
    for vector in VECTORS {
        let label = vector.name;
        let tx = parse(vector);
        let intents = tx
            .intents()
            .unwrap_or_else(|error| unreachable!("{label}: {error}"));
        assert_eq!(intents.len(), vector.calls.len(), "{label}");
        let transfers: Vec<&Intent> = intents
            .iter()
            .filter(|intent| matches!(intent, Intent::Transfer { .. }))
            .collect();
        assert_eq!(transfers.len(), vector.transfers.len(), "{label}");
        for (intent, (asset, to, amount)) in transfers.iter().zip(vector.transfers) {
            let Intent::Transfer {
                asset: got_asset,
                from,
                to: got_to,
                amount: got_amount,
            } = intent
            else {
                unreachable!("filtered to transfers above");
            };
            assert_eq!(*got_asset, from_display(asset), "{label}");
            assert_eq!(*got_to, from_display(to), "{label}");
            assert_eq!(*got_amount, *amount, "{label}");
            // The witness we would produce moves the sender's own tokens. A
            // `from` naming somebody else needs that account's signature too,
            // which these single-signer transactions do not carry.
            assert_eq!(*from, tx.sender().expect("sender"), "{label}");
        }
    }
}

#[test]
fn pack_puts_the_first_argument_on_top_of_the_stack() {
    // Call scripts push arguments last-argument-first, so `PACK`'s index 0 is
    // the value pushed *last*. Read the other way round, `from` and `data`
    // swap and an amount limit gets checked against the wrong argument.
    let vector = &VECTORS[0];
    let call = &parse(vector).calls().expect("one call")[0];
    assert_eq!(call.args.len(), 4);
    assert_eq!(
        call.args[0],
        StackItem::ByteString(hex::decode(vector.sender).expect("sender hex")),
        "args[0] is `from`, the account the script pushed last"
    );
    assert_eq!(call.args[3], StackItem::Null, "args[3] is `data`");
    assert_eq!(call.args[2].as_i128(), Some(496), "args[2] is `amount`");
}

#[test]
fn batched_transfers_stay_four_separate_amounts() {
    // A rolling window has to see four 0.25 GAS payments rather than one
    // aggregate: the limit is per transfer, and summing is the policy's call,
    // not the decoder's.
    let transfers: Vec<i128> = parse(&VECTORS[3])
        .intents()
        .expect("decoded")
        .iter()
        .filter_map(|intent| match intent {
            Intent::Transfer { amount, .. } => Some(*amount),
            Intent::ContractCall { .. } => None,
        })
        .collect();
    assert_eq!(transfers, vec![25_000_000; 4]);
    assert_eq!(transfers.iter().sum::<i128>(), 100_000_000);
}

#[test]
fn custom_contract_lists_are_read_in_wire_order() {
    let tx = parse(&VECTORS[1]);
    assert_eq!(tx.signers[0].scope, Scope(Scope::CUSTOM_CONTRACTS));
    assert_eq!(tx.signers[0].allowed_contracts.len(), 4);
    // The delegate contract the script actually calls must be one of the four,
    // compared in the same byte order — an explorer would have shown these
    // reversed.
    let called = tx.calls().expect("one call")[0].contract;
    assert!(tx.signers[0].allowed_contracts.contains(&called));
}

#[test]
fn native_asset_constants_are_the_display_hashes_in_wire_order() {
    assert_eq!(native::NEO, from_display(NEO_DISPLAY));
    assert_eq!(native::GAS, from_display(GAS_DISPLAY));
    // A constant that silently fell back to the zero hash would make every
    // transfer look non-native and disarm the amount limits entirely.
    assert_ne!(native::NEO, [0u8; HASH160_LEN]);
    assert_ne!(native::GAS, [0u8; HASH160_LEN]);
    assert_ne!(native::NEO, native::GAS);
}

#[test]
fn display_is_the_reverse_of_wire_order() {
    assert_eq!(script_hash_to_display(&native::NEO), NEO_DISPLAY);
    assert_eq!(script_hash_to_display(&native::GAS), GAS_DISPLAY);
    assert_ne!(
        hex::encode(native::NEO),
        NEO_DISPLAY.trim_start_matches("0x"),
        "if these ever match, one of the two stopped reversing"
    );
    assert_eq!(
        display_to_script_hash(NEO_DISPLAY.trim_start_matches("0x")),
        Some(native::NEO),
        "the 0x prefix is optional"
    );
    assert_eq!(
        display_to_script_hash(&format!("0x{}", NEO_DISPLAY[2..].to_uppercase())),
        Some(native::NEO),
        "either case is accepted"
    );
    assert_eq!(display_to_script_hash("0xef4073a0"), None, "too short");
    assert_eq!(
        display_to_script_hash(&format!("0x{}", "z".repeat(40))),
        None,
        "not hex"
    );
    assert_eq!(display_to_script_hash(""), None, "empty");
}

#[test]
fn refuses_a_transaction_with_bytes_left_over() {
    let mut bytes = neo_transfer();
    let offset = bytes.len();
    bytes.push(0x00);
    assert_eq!(
        UnsignedTransaction::parse(&bytes),
        Err(TxError::TrailingBytes { offset })
    );
}

#[test]
fn refuses_versions_and_fees_the_node_rejects() {
    let mut bytes = neo_transfer();
    bytes[0] = 1;
    assert_eq!(
        UnsignedTransaction::parse(&bytes),
        Err(TxError::UnsupportedVersion { version: 1 })
    );

    let mut bytes = neo_transfer();
    bytes[5..13].copy_from_slice(&[0xff; 8]);
    assert_eq!(
        UnsignedTransaction::parse(&bytes),
        Err(TxError::ValueOutOfRange { field: "fee" }),
        "a negative system fee would defeat any limit expressed in value"
    );
}

#[test]
fn refuses_signer_lists_the_node_rejects() {
    let mut bytes = neo_transfer();
    bytes[OFFSET_SIGNER_COUNT] = 0;
    assert_eq!(UnsignedTransaction::parse(&bytes), Err(TxError::NoSigners));

    let mut bytes = neo_transfer();
    let signer = bytes[OFFSET_ACCOUNT..=OFFSET_SCOPE].to_vec();
    bytes.splice(OFFSET_ATTRIBUTES..OFFSET_ATTRIBUTES, signer);
    bytes[OFFSET_SIGNER_COUNT] = 2;
    assert_eq!(
        UnsignedTransaction::parse(&bytes),
        Err(TxError::DuplicateSigner {
            account: from_wire(VECTORS[0].sender)
        })
    );

    let mut bytes = neo_transfer();
    bytes.splice(
        OFFSET_SIGNER_COUNT..OFFSET_SIGNER_COUNT + 1,
        [0xff, 17, 0, 0, 0, 0, 0, 0, 0],
    );
    assert_eq!(
        UnsignedTransaction::parse(&bytes),
        Err(TxError::CountOutOfRange {
            field: "signer",
            value: 17
        }),
        "`MaxTransactionAttributes` bounds signers too"
    );
}

#[test]
fn refuses_scopes_it_cannot_evaluate() {
    for (scope, expected) in [
        (0x02u8, TxError::InvalidScope { scope: 0x02 }),
        (0x81, TxError::GlobalWithOtherScope),
        (0x40, TxError::WitnessRulesUnsupported),
    ] {
        let mut bytes = neo_transfer();
        bytes[OFFSET_SCOPE] = scope;
        assert_eq!(
            UnsignedTransaction::parse(&bytes),
            Err(expected),
            "scope 0x{scope:02x}"
        );
    }
}

#[test]
fn accepts_a_global_scope_written_on_its_own() {
    let mut bytes = neo_transfer();
    bytes[OFFSET_SCOPE] = 0x80;
    let tx = UnsignedTransaction::parse(&bytes).expect("global alone is legal on the wire");
    assert!(tx.signers[0].scope.is_global());
    assert_eq!(tx.signers[0].scope.to_string(), "global");
    // Decoding it is not the same as allowing it: only policy says no.
    assert_eq!(tx.calls().expect("still decodes").len(), 1);
}

#[test]
fn names_the_scope_bits_it_found() {
    assert_eq!(Scope(0x00).to_string(), "none");
    assert_eq!(Scope(0x01).to_string(), "called-by-entry");
    assert_eq!(
        Scope(0x11).to_string(),
        "called-by-entry+custom-contracts",
        "the audit trail has to say which delegations a witness carries"
    );
    assert_eq!(Scope(0x30).to_string(), "custom-contracts+custom-groups");
}

#[test]
fn refuses_attributes_whose_effect_is_not_understood() {
    let mut bytes = neo_transfer();
    bytes.splice(OFFSET_ATTRIBUTES..OFFSET_ATTRIBUTES + 1, [0x01, 0x99]);
    assert_eq!(
        UnsignedTransaction::parse(&bytes),
        Err(TxError::UnknownAttribute {
            attribute_type: 0x99
        })
    );

    let mut bytes = neo_transfer();
    bytes.splice(OFFSET_ATTRIBUTES..OFFSET_ATTRIBUTES + 1, [0x02, 0x01, 0x01]);
    assert_eq!(
        UnsignedTransaction::parse(&bytes),
        Err(TxError::DuplicateAttribute {
            attribute_type: 0x01
        })
    );
}

#[test]
fn keeps_attributes_the_node_allows() {
    // `Conflicts.AllowMultiple` is true: a transaction may invalidate several
    // others, and refusing that would refuse valid work.
    let mut bytes = neo_transfer();
    let first = [0x11u8; 32];
    let second = [0x22u8; 32];
    let mut region: Vec<u8> = vec![0x02, 0x21];
    region.extend_from_slice(&first);
    region.push(0x21);
    region.extend_from_slice(&second);
    bytes.splice(OFFSET_ATTRIBUTES..OFFSET_ATTRIBUTES + 1, region);
    let tx = UnsignedTransaction::parse(&bytes).expect("two conflicts attributes");
    assert_eq!(
        tx.attributes,
        vec![Attribute::Conflicts(first), Attribute::Conflicts(second)]
    );
    assert_eq!(
        tx.script.len(),
        VECTORS[0].script_len,
        "the script survived"
    );

    let mut bytes = neo_transfer();
    bytes.splice(
        OFFSET_ATTRIBUTES..OFFSET_ATTRIBUTES + 1,
        [0x02, 0x20, 0x07, 0x00, 0x00, 0x00, 0x01],
    );
    let tx = UnsignedTransaction::parse(&bytes).expect("height and priority");
    assert_eq!(
        tx.attributes,
        vec![Attribute::NotValidBefore(7), Attribute::HighPriority]
    );
}

#[test]
fn refuses_scripts_it_cannot_describe() {
    let mut bytes = neo_transfer();
    bytes[OFFSET_SCRIPT_LEN] = 0;
    assert_eq!(
        UnsignedTransaction::parse(&bytes),
        Err(TxError::EmptyScript)
    );

    let mut bytes = neo_transfer();
    bytes[OFFSET_SCRIPT_LEN] = 200;
    assert_eq!(
        UnsignedTransaction::parse(&bytes),
        Err(TxError::CountOutOfRange {
            field: "script",
            value: 200
        }),
        "a length prefix past the end of the input costs a comparison, not an allocation"
    );

    assert_eq!(
        UnsignedTransaction::parse(&vec![0u8; MAX_TRANSACTION_SIZE + 1]),
        Err(TxError::TooLarge)
    );
}

#[test]
fn refuses_script_features_it_cannot_reason_about() {
    assert_eq!(decode_script(&[]), Err(TxError::NoContractCalls));
    assert_eq!(
        decode_script(&[0x22, 0x01]),
        Err(TxError::UnsupportedOpcode { opcode: 0x22 }),
        "a jump can skip past whatever the checks were looking at"
    );
    assert_eq!(
        decode_script(&[OP_SYSCALL, 0x77, 0x7a, 0xb4, 0x4f]),
        Err(TxError::UnsupportedSyscall {
            interop: [0x77, 0x7a, 0xb4, 0x4f]
        }),
        "only System.Contract.Call has a meaning this module can gate on"
    );
    assert_eq!(
        decode_script(&[OP_SYSCALL, 0x62, 0x7d]),
        Err(TxError::IncompleteSyscall)
    );
    assert_eq!(
        decode_script(&[OP_SYSCALL, 0x62, 0x7d, 0x5b, 0x52]),
        Err(TxError::MalformedCall),
        "a call with nothing on the stack"
    );
    assert_eq!(
        decode_script(&[0x15, OP_PACK]),
        Err(TxError::BadPack),
        "PACK counted more than the stack held"
    );
    assert_eq!(
        decode_script(&[0x0c, 0x14, 0x01]),
        Err(TxError::LengthOutOfRange {
            field: "byte string"
        }),
        "a truncated push"
    );
}

#[test]
fn decodes_a_hand_written_call() {
    let mut script: Vec<u8> = vec![0x10, OP_PACK, 0x1f, 0x0c, 0x04];
    script.extend_from_slice(b"noop");
    script.extend_from_slice(&[0x0c, 0x14]);
    script.extend_from_slice(&[0x11u8; HASH160_LEN]);
    script.push(OP_SYSCALL);
    script.extend_from_slice(&CONTRACT_CALL_INTEROP);
    let calls = decode_script(&script).expect("hand-written call");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].method, "noop");
    assert_eq!(calls[0].flags, 15);
    assert_eq!(calls[0].args, Vec::new());
    assert_eq!(calls[0].contract, [0x11u8; HASH160_LEN]);

    let tx = UnsignedTransaction {
        version: 0,
        nonce: 1,
        system_fee: 0,
        network_fee: 0,
        valid_until_block: 1_000,
        signers: vec![Signer {
            account: [0x11u8; HASH160_LEN],
            scope: Scope(Scope::CALLED_BY_ENTRY),
            allowed_contracts: Vec::new(),
            allowed_groups: Vec::new(),
        }],
        attributes: Vec::new(),
        script,
    };
    assert_eq!(
        tx.intents().expect("decoded"),
        vec![Intent::ContractCall {
            contract: [0x11u8; HASH160_LEN],
            method: "noop".to_string(),
            flags: 15,
        }]
    );
}

#[test]
fn a_transfer_on_an_unlisted_token_contract_is_still_a_transfer() {
    // The point of the ceilings is that they reach tokens, not only NEO and
    // GAS. Reading this as a bare contract call would let an arbitrary amount
    // of an arbitrary token leave a key whose operator believed they had
    // limited exactly that.
    let mut tx = parse(&VECTORS[0]);
    let contract_at = tx.script.len() - 25;
    tx.script[contract_at..contract_at + HASH160_LEN].copy_from_slice(&[0x33u8; HASH160_LEN]);
    assert_eq!(
        tx.intents().expect("decoded"),
        vec![Intent::Transfer {
            asset: [0x33u8; HASH160_LEN],
            from: from_wire(VECTORS[0].sender),
            to: from_display("0x36bbd2c9e5d3ea8c906d3a1997175678b31c3ebf"),
            amount: 496,
        }]
    );
}

#[test]
fn a_misshaped_transfer_stays_an_ordinary_call() {
    // A contract with a four-argument `transfer` that is not (account, account,
    // integer, _) is not moving fungible value, and inventing a transfer out of
    // it would apply token rules to something else entirely.
    for (index, replacement) in [
        (0usize, StackItem::ByteString(vec![0x01u8; 19])),
        (1, StackItem::Null),
        (2, StackItem::ByteString(b"token-id".to_vec())),
    ] {
        let mut tx = parse(&VECTORS[0]);
        let calls = tx.calls().expect("decoded");
        let mut args = calls[0].args.clone();
        args[index] = replacement;
        let script = build_transfer_script(&args);
        tx.script = script;
        assert_eq!(
            tx.intents().expect("decoded"),
            vec![Intent::ContractCall {
                contract: native::NEO,
                method: "transfer".to_string(),
                flags: 15,
            }],
            "argument {index} replaced"
        );
    }
}

#[test]
fn reports_a_from_that_is_not_the_sender_instead_of_silently_fixing_it() {
    let mut tx = parse(&VECTORS[0]);
    // The `from` push sits 60 bytes from the end of this script: PUSHNULL,
    // PUSHINT16, PUSHDATA1 `to`, then PUSHDATA1 `from`.
    let from_at = tx.script.len() - 60;
    tx.script[from_at..from_at + HASH160_LEN].copy_from_slice(&[0x44u8; HASH160_LEN]);
    let intents = tx.intents().expect("decoded");
    let Intent::Transfer { from, .. } = &intents[0] else {
        unreachable!("expected a transfer, got {:?}", intents[0]);
    };
    assert_eq!(
        *from, [0x44u8; HASH160_LEN],
        "the script, not the signer list, says where the tokens come from"
    );
}

#[test]
fn parses_a_consensus_payload_as_the_node_does() {
    let sender = from_wire(VECTORS[0].sender);
    let mut body = Vec::new();
    body.extend_from_slice(&0u32.to_le_bytes());
    body.extend_from_slice(&[0x11; 32]);
    body.extend_from_slice(&1_700_000_000u64.to_le_bytes());
    body.extend_from_slice(&42u64.to_le_bytes());
    body.push(1);
    body.extend_from_slice(&[0xaa; 32]);
    let data = [
        vec![DbftMessageType::PrepareRequest as u8],
        101u32.to_le_bytes().to_vec(),
        vec![2, 3],
        body,
    ]
    .concat();
    let bytes = payload(DBFT_CATEGORY, 0, 101, sender, &data);
    let decoded = ConsensusPayload::parse(&bytes).expect("well-formed dBFT payload");
    assert_eq!(decoded.category, "dBFT");
    assert_eq!(
        (decoded.valid_block_start, decoded.valid_block_end),
        (0, 101)
    );
    assert_eq!(decoded.sender, sender);
    assert_eq!(decoded.data, data);
    assert_eq!(
        decoded.dbft_header().expect("header"),
        DbftHeader {
            message_type: DbftMessageType::PrepareRequest,
            block_index: 101,
            validator_index: 2,
            view_number: 3,
        }
    );
}

#[test]
fn refuses_consensus_payloads_the_network_would_drop() {
    let sender = from_wire(VECTORS[0].sender);
    for (start, end) in [(101, 101), (102, 101)] {
        assert_eq!(
            ConsensusPayload::parse(&payload("dBFT", start, end, sender, &[])),
            Err(TxError::InvalidValidityRange { start, end }),
            "a payload no peer will relay is not worth a consensus signature"
        );
    }
    assert_eq!(
        ConsensusPayload::parse(&payload(&"c".repeat(33), 1, 2, sender, &[])),
        Err(TxError::CountOutOfRange {
            field: "category",
            value: 33
        })
    );
    let mut trailing = payload("dBFT", 1, 2, sender, &[]);
    trailing.push(0x00);
    assert!(matches!(
        ConsensusPayload::parse(&trailing),
        Err(TxError::TrailingBytes { .. })
    ));
    assert!(matches!(
        ConsensusPayload::parse(&[0x04, b'd']),
        Err(TxError::CountOutOfRange { .. })
    ));
    assert!(matches!(
        ConsensusPayload::parse(&[0x01, b'd', 0x00]),
        Err(TxError::Truncated)
    ));

    assert_eq!(
        ConsensusPayload::parse(&payload(DBFT_CATEGORY, 0, 2, sender, &[0x20])),
        Err(TxError::DbftHeaderTruncated)
    );
    let unknown = [vec![0xff], 2u32.to_le_bytes().to_vec(), vec![0, 0]].concat();
    assert_eq!(
        ConsensusPayload::parse(&payload(DBFT_CATEGORY, 0, 2, sender, &unknown)),
        Err(TxError::UnknownDbftMessageType { message_type: 0xff })
    );
    let header = [vec![0x20], 2u32.to_le_bytes().to_vec(), vec![0, 0]].concat();
    assert_eq!(
        ConsensusPayload::parse(&payload(DBFT_CATEGORY, 1, 2, sender, &header)),
        Err(TxError::InvalidDbftStart { start: 1 })
    );
    assert_eq!(
        ConsensusPayload::parse(&payload(DBFT_CATEGORY, 0, 3, sender, &header)),
        Err(TxError::DbftHeightMismatch {
            envelope_end: 3,
            block_index: 2,
        })
    );

    let malformed_response = [
        vec![DbftMessageType::PrepareResponse as u8],
        2u32.to_le_bytes().to_vec(),
        vec![0, 0],
        vec![0x11; 31],
    ]
    .concat();
    assert!(matches!(
        ConsensusPayload::parse(&payload(DBFT_CATEGORY, 0, 2, sender, &malformed_response)),
        Err(TxError::LengthOutOfRange {
            field: "preparation hash"
        })
    ));

    let trailing_commit = [
        vec![DbftMessageType::Commit as u8],
        2u32.to_le_bytes().to_vec(),
        vec![0, 0],
        vec![0x22; 65],
    ]
    .concat();
    assert!(matches!(
        ConsensusPayload::parse(&payload(DBFT_CATEGORY, 0, 2, sender, &trailing_commit)),
        Err(TxError::TrailingBytes { .. })
    ));

    let duplicate_hash = [0x33; 32];
    let mut duplicate_request_body = Vec::new();
    duplicate_request_body.extend_from_slice(&0u32.to_le_bytes());
    duplicate_request_body.extend_from_slice(&[0x11; 32]);
    duplicate_request_body.extend_from_slice(&1u64.to_le_bytes());
    duplicate_request_body.extend_from_slice(&2u64.to_le_bytes());
    duplicate_request_body.push(2);
    duplicate_request_body.extend_from_slice(&duplicate_hash);
    duplicate_request_body.extend_from_slice(&duplicate_hash);
    let duplicate_request = [
        vec![DbftMessageType::PrepareRequest as u8],
        2u32.to_le_bytes().to_vec(),
        vec![0, 0],
        duplicate_request_body,
    ]
    .concat();
    assert_eq!(
        ConsensusPayload::parse(&payload(DBFT_CATEGORY, 0, 2, sender, &duplicate_request)),
        Err(TxError::MalformedDbftBody {
            detail: "duplicate transaction hash"
        })
    );
}

/// Build `SerializeUnsigned` bytes for an extensible payload.
fn payload(
    category: &str,
    start: u32,
    end: u32,
    sender: [u8; HASH160_LEN],
    data: &[u8],
) -> Vec<u8> {
    let mut bytes = vec![category.len() as u8];
    bytes.extend_from_slice(category.as_bytes());
    bytes.extend_from_slice(&start.to_le_bytes());
    bytes.extend_from_slice(&end.to_le_bytes());
    bytes.extend_from_slice(&sender);
    bytes.push(data.len() as u8);
    bytes.extend_from_slice(data);
    bytes
}

/// Re-encode a stack item using only the pushes this decoder accepts.
fn push_item(item: &StackItem, out: &mut Vec<u8>) {
    match item {
        StackItem::Null => out.push(0x0b),
        StackItem::Bool(true) => out.push(0x08),
        StackItem::Bool(false) => out.push(0x09),
        StackItem::Integer(bytes) => {
            let width = bytes.len().next_power_of_two().clamp(1, 16);
            // `PUSHINT8` is opcode 0x00 and each doubling of the width is the
            // next opcode, so the exponent is the offset.
            out.push(width.trailing_zeros() as u8);
            let sign = if bytes.last().is_some_and(|byte| byte & 0x80 != 0) {
                0xff
            } else {
                0x00
            };
            out.extend_from_slice(bytes);
            out.resize(out.len() + width - bytes.len(), sign);
        }
        StackItem::ByteString(bytes) => {
            out.push(0x0c);
            out.push(bytes.len() as u8);
            out.extend_from_slice(bytes);
        }
        StackItem::Array(items) => {
            for item in items.iter().rev() {
                push_item(item, out);
            }
            out.push(0x10 + items.len() as u8);
            out.push(0xc0);
        }
    }
}

/// A canonical `NEO.transfer(..)` call script over `args`, in the order the VM
/// expects them: last argument pushed first.
fn build_transfer_script(args: &[StackItem]) -> Vec<u8> {
    let mut script = Vec::new();
    for item in args.iter().rev() {
        push_item(item, &mut script);
    }
    script.push(0x10 + args.len() as u8);
    script.push(0xc0);
    script.push(0x1f);
    script.extend_from_slice(&[0x0c, 8]);
    script.extend_from_slice(b"transfer");
    script.extend_from_slice(&[0x0c, HASH160_LEN as u8]);
    script.extend_from_slice(&native::NEO);
    script.push(0x41);
    script.extend_from_slice(&CONTRACT_CALL_INTEROP);
    script
}
