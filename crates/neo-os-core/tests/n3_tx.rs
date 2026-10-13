//! Golden vectors for the Neo N3 wire encoding, harvested from the repo's own
//! neon-js (`sc.createScript` / `tx.Transaction.getMessageForSigning`) with
//! the exact fixtures the feed lane drives: the updateFeeds argument arrays,
//! the FakeSigner script hash, and the testnet magic. The integer edge cases
//! (255 → `ff 00`, 4294967295 → 8 bytes) pin the signed two's-complement
//! emission; the `Base64Bytes` cases pin the `ContractParam.byteArray`
//! base64-decode quirk.

use neo_os_core::n3_tx::{
    create_invoke_script, decode_invoke_call, parse_unsigned_tx, ContractParam, FeedSigner, FeedTx,
    InvokeArg, Witness, WITNESS_SCOPE_CALLED_BY_ENTRY,
};

const FEED_N3_CONTRACT: [u8; 20] = [
    0x03, 0x01, 0x3f, 0x49, 0xc4, 0x2a, 0x14, 0x54, 0x6c, 0x8b, 0xbe, 0x58, 0xf9, 0xd4, 0x34, 0xc3,
    0x51, 0x7f, 0xcc, 0xab,
];
const UPDATER_SCRIPT_HASH: [u8; 20] = [
    0x5c, 0x20, 0x47, 0xb1, 0xc6, 0xb4, 0xb6, 0xe4, 0xb3, 0xa1, 0xc9, 0xd5, 0xe7, 0xf0, 0xa2, 0xb4,
    0xc6, 0xd8, 0xe0, 0xf1,
];
const TESTNET_MAGIC: u32 = 860833102;

fn feed_args(
    pairs: &[&str],
    rounds: &[i64],
    prices: &[i64],
    timestamps: &[i64],
    hashes: &[&str],
) -> Vec<ContractParam> {
    vec![
        ContractParam::Array(
            pairs
                .iter()
                .map(|p| ContractParam::String(p.to_string()))
                .collect(),
        ),
        ContractParam::Array(rounds.iter().map(|r| ContractParam::Integer(*r)).collect()),
        ContractParam::Array(prices.iter().map(|p| ContractParam::Integer(*p)).collect()),
        ContractParam::Array(
            timestamps
                .iter()
                .map(|t| ContractParam::Integer(*t))
                .collect(),
        ),
        ContractParam::Array(
            hashes
                .iter()
                .map(|h| ContractParam::Base64Bytes(h.to_string()))
                .collect(),
        ),
        ContractParam::Array(
            (0..pairs.len())
                .map(|_| ContractParam::Integer(0))
                .collect(),
        ),
    ]
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn single_symbol_script_is_byte_exact() {
    // Vector: one symbol, R=1001 (PUSHINT16), PX=2000000 (PUSHINT32),
    // TS=1718352000 (PUSHINT32), SS=0 (PUSH0), AH as Base64Bytes.
    let script = create_invoke_script(
        &FEED_N3_CONTRACT,
        "updateFeeds",
        &feed_args(
            &["TWELVEDATA:NEO-USD"],
            &[1001],
            &[2000000],
            &[1718352000],
            &["0d85465d97521b3659a2de0b338eb032"],
        ),
    )
    .expect("valid fixture");
    assert_eq!(
        hex(&script),
        "1011c00c18d1df39e3ae5df7be76d5bdfae7d6b675ed1bdf7f1e6f4df611c00280f86b6611c00280841e0011c001e90311c00c125457454c5645444154413a4e454f2d55534411c016c01f0c0b75706461746546656564730c14abcc7f51c334d4f958be8b6c54142ac4493f010341627d5b52"
    );
}

#[test]
fn two_symbol_script_is_byte_exact() {
    let script = create_invoke_script(
        &FEED_N3_CONTRACT,
        "updateFeeds",
        &feed_args(
            &["TWELVEDATA:NEO-USD", "TWELVEDATA:BTC-USD"],
            &[1001, 890123457],
            &[2000000, 65000123457],
            &[1718352000, 1756713600],
            &[
                "0d85465d97521b3659a2de0b338eb032",
                "23662a9f13a96656641ddf9aa56e5f60",
            ],
        ),
    )
    .expect("valid fixture");
    assert_eq!(
        hex(&script),
        "101012c00c18db7ebad9af5fd776bdebae7aeb8d5d75ff5a6b9e9ee5feb40c18d1df39e3ae5df7be76d5bdfae7d6b675ed1bdf7f1e6f4df612c0028052b5680280f86b6612c003412c4f220f0000000280841e0012c002c1340e3501e90312c00c125457454c5645444154413a4254432d5553440c125457454c5645444154413a4e454f2d55534412c016c01f0c0b75706461746546656564730c14abcc7f51c334d4f958be8b6c54142ac4493f010341627d5b52"
    );
}

#[test]
fn integer_encoding_matches_the_per_param_vectors() {
    // Each entry: value → the emitted bytes inside `sc.createScript` with a
    // single arg (harvested per-param).
    for (value, expected) in [
        (0i64, "10"),
        (1, "11"),
        (16, "20"),
        (-1, "0f"),
        (17, "0011"),
        (255, "01ff00"),
        (256, "010001"),
        (1001, "01e903"),
        (65535, "02ffff0000"),
        (65536, "0200000100"),
        (2000000, "0280841e00"),
        (890123457, "02c1340e35"),
        (1718352000, "0280f86b66"),
        (4294967295, "03ffffffff00000000"),
        (4294967296, "030000000001000000"),
        (65000123457, "03412c4f220f000000"),
    ] {
        let script = create_invoke_script(
            &FEED_N3_CONTRACT,
            "updateFeeds",
            &[ContractParam::Array(vec![ContractParam::Integer(value)])],
        )
        .expect("valid fixture");
        let encoded = hex(&script);
        // The integer emission is the prefix before `11c0` (count+PACK).
        let prefix = expected.split("11c0").next().unwrap().to_string();
        assert!(
            encoded.starts_with(&prefix),
            "integer {value}: expected prefix {prefix} in {encoded}"
        );
    }
}

#[test]
fn base64_bytes_decode_not_hex_decode() {
    // 'e3b0c44298fc1c149afbf4c8996fb924' (32 hex-looking chars) must emit the
    // 24 bytes of its BASE64 decoding, pinned from neon-js.
    let script = create_invoke_script(
        &FEED_N3_CONTRACT,
        "updateFeeds",
        &[ContractParam::Array(vec![ContractParam::Base64Bytes(
            "e3b0c44298fc1c149afbf4c8996fb924".to_string(),
        )])],
    )
    .expect("valid fixture");
    assert!(hex(&script).starts_with("0c187b76f4738e36f7c7dcd5cd78f5a7db7f873cf7de9f6fddb8"));
}

#[test]
fn empty_byte_array_and_multi_string_arrays_match() {
    let empty = create_invoke_script(
        &FEED_N3_CONTRACT,
        "updateFeeds",
        &[ContractParam::Array(vec![ContractParam::Base64Bytes(
            String::new(),
        )])],
    )
    .expect("valid fixture");
    assert!(hex(&empty).starts_with("0c00"));

    let two = create_invoke_script(
        &FEED_N3_CONTRACT,
        "updateFeeds",
        &[ContractParam::Array(vec![
            ContractParam::String("A".to_string()),
            ContractParam::String("B".to_string()),
        ])],
    )
    .expect("valid fixture");
    assert!(hex(&two).starts_with("0c01420c014112c0"));
}

#[test]
fn tx_serialization_and_message_are_byte_exact() {
    // Vector 1: nonce=424242, blockCount=100000 → valid 100500, fees at the
    // safety ceiling shape, single NEO-USD update.
    let script = create_invoke_script(
        &FEED_N3_CONTRACT,
        "updateFeeds",
        &feed_args(
            &["TWELVEDATA:NEO-USD"],
            &[1001],
            &[2000000],
            &[1718352000],
            &["0d85465d97521b3659a2de0b338eb032"],
        ),
    )
    .expect("valid fixture");
    let feed_tx = FeedTx {
        nonce: 424242,
        valid_until_block: 100500,
        system_fee: 1_000_000_000,
        network_fee: 1_234_567,
        signer: FeedSigner {
            script_hash: UPDATER_SCRIPT_HASH,
        },
        script: &script,
    };
    assert_eq!(
        hex(&feed_tx.serialize_unsigned()),
        "003279060000ca9a3b0000000087d61200000000009488010001f1e0d8c6b4a2f0e7d5c9a1b3e4b6b4c6b147205c0100731011c00c18d1df39e3ae5df7be76d5bdfae7d6b675ed1bdf7f1e6f4df611c00280f86b6611c00280841e0011c001e90311c00c125457454c5645444154413a4e454f2d55534411c016c01f0c0b75706461746546656564730c14abcc7f51c334d4f958be8b6c54142ac4493f010341627d5b52"
    );
    assert_eq!(
        hex(&feed_tx.message_for_signing(TESTNET_MAGIC)),
        "4e454f330829a97658267da5fce39aed5bf07acb195bdddb0d9ebba4d9b4f35de051a0d6"
    );
}

#[test]
fn two_symbol_tx_message_is_byte_exact() {
    let script = create_invoke_script(
        &FEED_N3_CONTRACT,
        "updateFeeds",
        &feed_args(
            &["TWELVEDATA:NEO-USD", "TWELVEDATA:BTC-USD"],
            &[1001, 890123457],
            &[2000000, 65000123457],
            &[1718352000, 1756713600],
            &[
                "0d85465d97521b3659a2de0b338eb032",
                "23662a9f13a96656641ddf9aa56e5f60",
            ],
        ),
    )
    .expect("valid fixture");
    let feed_tx = FeedTx {
        nonce: 424242,
        valid_until_block: 100500,
        system_fee: 1_000_000_000,
        network_fee: 1_234_567,
        signer: FeedSigner {
            script_hash: UPDATER_SCRIPT_HASH,
        },
        script: &script,
    };
    assert_eq!(
        hex(&feed_tx.message_for_signing(TESTNET_MAGIC)),
        "4e454f33ca4b12d089d40bb52ee6914a7a315fde59de700136f1362ec6da771a176977fc"
    );
}

#[test]
fn zeroed_tx_message_is_byte_exact() {
    // nonce=0, blockCount=0 (valid 500), zero fees, minimal values — pins the
    // all-zero field encodings and PUSH0-heavy script.
    let script = create_invoke_script(
        &FEED_N3_CONTRACT,
        "updateFeeds",
        &feed_args(
            &["TWELVEDATA:NEO-USD"],
            &[1756713601],
            &[1],
            &[1],
            &["4de81354d10d128f1d26e20cd2981161"],
        ),
    )
    .expect("valid fixture");
    let feed_tx = FeedTx {
        nonce: 0,
        valid_until_block: 500,
        system_fee: 0,
        network_fee: 0,
        signer: FeedSigner {
            script_hash: UPDATER_SCRIPT_HASH,
        },
        script: &script,
    };
    assert_eq!(
        hex(&feed_tx.serialize_unsigned()),
        "000000000000000000000000000000000000000000f401000001f1e0d8c6b4a2f0e7d5c9a1b3e4b6b4c6b147205c01006d1011c00c18e1d7bcd77e78775d1dd76f1fd5ddba7b6d1c776f7cd75eb511c01111c01111c0028152b56811c00c125457454c5645444154413a4e454f2d55534411c016c01f0c0b75706461746546656564730c14abcc7f51c334d4f958be8b6c54142ac4493f010341627d5b52"
    );
    assert_eq!(
        hex(&feed_tx.message_for_signing(TESTNET_MAGIC)),
        "4e454f33e36db879e194fea51ebec92f15167c3d627d35f0e1df7bb624b13ed62a25d0da"
    );
}

/// The decoder is the encoder's inverse: whatever `create_invoke_script` emits,
/// `decode_invoke_call` reads back as the same display-order contract, the same
/// method and the same arguments. This is what stops a downstream shape check
/// from validating a script this repository never produces.
#[test]
fn decode_invoke_call_round_trips_create_invoke_script() {
    let args = feed_args(
        &["TWELVEDATA:NEO-USD", "BINANCE:GAS-USDT"],
        &[1001, 1002],
        &[2_000_000, 3_000_000],
        &[1_718_352_000, 1_718_352_001],
        &[
            "0d85465d97521b3659a2de0b338eb032",
            "0d85465d97521b3659a2de0b338eb032",
        ],
    );
    let script =
        create_invoke_script(&FEED_N3_CONTRACT, "updateFeeds", &args).expect("valid fixture");
    let call = decode_invoke_call(&script).expect("the encoder's own output must decode");

    assert_eq!(call.contract, FEED_N3_CONTRACT);
    assert_eq!(call.method, "updateFeeds");
    assert_eq!(call.args.len(), 6);

    // Argument order is declared order: `PACK` pops and appends, so the decoder
    // reverses the split-off run the same way `pop_call` does.
    match &call.args[0] {
        InvokeArg::Array(items) => {
            assert_eq!(items.len(), 2);
            assert!(
                matches!(&items[0], InvokeArg::ByteString(bytes) if bytes == b"TWELVEDATA:NEO-USD")
            );
            assert!(
                matches!(&items[1], InvokeArg::ByteString(bytes) if bytes == b"BINANCE:GAS-USDT")
            );
        }
        other => panic!("expected the pairs array, got {other:?}"),
    }
    match &call.args[1] {
        InvokeArg::Array(items) => {
            assert_eq!(items[0].as_i128(), Some(1001));
            assert_eq!(items[1].as_i128(), Some(1002));
        }
        other => panic!("expected the rounds array, got {other:?}"),
    }
}

/// Hash160 arguments go on the wire in wire order and come back in display
/// order, so a decoded account id compares directly against the `0x…` form the
/// sponsor journal stores.
#[test]
fn decode_invoke_call_returns_display_order_hashes() {
    let display = [
        0x03, 0x01, 0x3f, 0x49, 0xc4, 0x2a, 0x14, 0x54, 0x6c, 0x8b, 0xbe, 0x58, 0xf9, 0xd4, 0x34,
        0xc3, 0x51, 0x7f, 0xcc, 0xab,
    ];
    let account = [
        0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
        0x00, 0x12, 0x34, 0x56, 0x78,
    ];
    let args = vec![
        ContractParam::Hash160(format!("0x{}", hex::encode(account))),
        ContractParam::Integer(3600),
    ];
    let script = create_invoke_script(&display, "registerAccount", &args).expect("valid fixture");
    let call = decode_invoke_call(&script).expect("the encoder's own output must decode");

    assert_eq!(call.contract, display);
    match &call.args[0] {
        InvokeArg::ByteString(bytes) => {
            assert_eq!(bytes.len(), 20);
            let mut round_tripped = [0u8; 20];
            round_tripped.copy_from_slice(bytes);
            round_tripped.reverse();
            assert_eq!(round_tripped, account);
        }
        other => panic!("expected the account id byte string, got {other:?}"),
    }
    assert!(matches!(call.args[1], InvokeArg::Integer(_)));
    assert_eq!(call.args[1].as_i128(), Some(3600));
}

// ---------------------------------------------------------------------------
// Unsigned transaction envelopes (CU-151). `parse_unsigned_tx` is the inverse
// of `FeedTx::serialize_unsigned`, so the sponsor API can measure `SystemFee +
// NetworkFee` out of the bytes it is about to sign rather than accepting a
// figure the submitter declared.
// ---------------------------------------------------------------------------

fn sample_tx() -> FeedTx<'static> {
    // A static script so the returned FeedTx can outlive the call site.
    static SCRIPT: [u8; 4] = [0x0c, 0x01, 0x41, 0x42];
    FeedTx {
        nonce: 0x01020304,
        valid_until_block: 1_234_567,
        system_fee: 1_234_567_890_123,
        network_fee: 456_789,
        signer: FeedSigner {
            script_hash: UPDATER_SCRIPT_HASH,
        },
        script: &SCRIPT,
    }
}

#[test]
fn parse_unsigned_tx_round_trips_every_field_the_encoder_emits() {
    let tx = sample_tx();
    let bytes = tx.serialize_unsigned();
    let parsed = parse_unsigned_tx(&bytes).expect("the encoder's own output must parse");

    assert_eq!(parsed.nonce, tx.nonce);
    assert_eq!(parsed.valid_until_block, tx.valid_until_block);
    assert_eq!(parsed.system_fee, tx.system_fee);
    assert_eq!(parsed.network_fee, tx.network_fee);
    assert_eq!(parsed.signer, UPDATER_SCRIPT_HASH);
    assert_eq!(parsed.script, tx.script);
    // Re-serialising the parsed envelope must reproduce the exact bytes, so a
    // caller cannot smuggle a second encoding past the sponsor.
    assert_eq!(parsed.serialize_unsigned(), bytes);
}

#[test]
fn the_transaction_fee_is_the_sum_of_the_two_envelope_fees() {
    let tx = sample_tx();
    let parsed = parse_unsigned_tx(&tx.serialize_unsigned()).expect("valid envelope");
    assert_eq!(
        parsed.transaction_fee_units(),
        Some(tx.system_fee + tx.network_fee)
    );
}

#[test]
fn a_fee_sum_outside_the_datoshi_domain_is_reported_as_none_rather_than_wrapped() {
    let mut tx = sample_tx();
    tx.system_fee = u64::MAX;
    tx.network_fee = 1;
    let parsed = parse_unsigned_tx(&tx.serialize_unsigned()).expect("valid envelope");
    assert_eq!(parsed.transaction_fee_units(), None);
}

#[test]
fn the_transaction_hash_is_the_unsigned_hash_the_relayer_polls() {
    let tx = sample_tx();
    let parsed = parse_unsigned_tx(&tx.serialize_unsigned()).expect("valid envelope");
    assert_eq!(parsed.hash_display(), tx.hash_display());
}

#[test]
fn parse_unsigned_tx_refuses_an_empty_envelope() {
    assert!(parse_unsigned_tx(&[]).is_err());
}

#[test]
fn parse_unsigned_tx_refuses_a_truncated_envelope() {
    let bytes = sample_tx().serialize_unsigned();
    for cut in 1..bytes.len() {
        assert!(
            parse_unsigned_tx(&bytes[..cut]).is_err(),
            "a {cut}-byte prefix of a {}-byte envelope must not parse",
            bytes.len()
        );
    }
}

#[test]
fn parse_unsigned_tx_refuses_trailing_bytes() {
    let mut bytes = sample_tx().serialize_unsigned();
    bytes.push(0);
    assert!(parse_unsigned_tx(&bytes).is_err());
}

#[test]
fn parse_unsigned_tx_refuses_a_signed_envelope() {
    // The witness array rides after the unsigned serialization, so a signed
    // transaction is exactly the shape this parser must refuse: the sponsor
    // signs the envelope it was given and never one that already carries a
    // witness.
    let signed = sample_tx().serialize_signed(&[Witness {
        invocation_script: vec![0x0c, 0x21],
        verification_script: vec![0x41],
    }]);
    assert!(parse_unsigned_tx(&signed).is_err());
}

#[test]
fn parse_unsigned_tx_refuses_more_than_one_signer() {
    let mut bytes = sample_tx().serialize_unsigned();
    // The signer count is the byte immediately after validUntilBlock
    // (version 1 + nonce 4 + systemFee 8 + networkFee 8 + validUntilBlock 4).
    bytes[1 + 4 + 8 + 8 + 4] = 2;
    assert!(parse_unsigned_tx(&bytes).is_err());
}

#[test]
fn parse_unsigned_tx_refuses_a_signer_scope_other_than_called_by_entry() {
    let mut bytes = sample_tx().serialize_unsigned();
    let scope_index = 1 + 4 + 8 + 8 + 4 + 1 + 20;
    assert_eq!(bytes[scope_index], WITNESS_SCOPE_CALLED_BY_ENTRY);
    bytes[scope_index] = 0x80; // Global, the one scope a sponsor key must never carry
    assert!(parse_unsigned_tx(&bytes).is_err());
}

#[test]
fn parse_unsigned_tx_refuses_a_nonzero_attribute_count() {
    let mut bytes = sample_tx().serialize_unsigned();
    let attribute_count_index = 1 + 4 + 8 + 8 + 4 + 1 + 20 + 1;
    bytes[attribute_count_index] = 1;
    assert!(parse_unsigned_tx(&bytes).is_err());
}

#[test]
fn parse_unsigned_tx_refuses_a_nonzero_version() {
    let mut bytes = sample_tx().serialize_unsigned();
    bytes[0] = 1;
    assert!(parse_unsigned_tx(&bytes).is_err());
}

#[test]
fn parse_unsigned_tx_refuses_a_noncanonical_script_length() {
    // `num2VarInt` emits a bare length byte below 0xfd; a 0xfd escape for the
    // same short length is a second encoding of one transaction and must not
    // be accepted alongside the canonical one.
    let canonical = sample_tx().serialize_unsigned();
    let script_len_index = 1 + 4 + 8 + 8 + 4 + 1 + 20 + 1 + 1;
    assert_eq!(canonical[script_len_index], 4);
    let mut escaped = Vec::new();
    escaped.extend_from_slice(&canonical[..script_len_index]);
    escaped.push(0xfd);
    escaped.extend_from_slice(&4u16.to_le_bytes());
    escaped.extend_from_slice(&canonical[script_len_index + 1..]);
    assert!(parse_unsigned_tx(&escaped).is_err());
}

#[test]
fn parse_unsigned_tx_refuses_an_overlong_script_length() {
    let canonical = sample_tx().serialize_unsigned();
    let script_len_index = 1 + 4 + 8 + 8 + 4 + 1 + 20 + 1 + 1;
    let mut oversize = canonical.clone();
    oversize[script_len_index] = 0xff;
    assert!(parse_unsigned_tx(&oversize).is_err());
}

#[test]
fn the_parsed_envelope_carries_the_signer_in_display_order() {
    // `serialize_unsigned` writes the account little-endian; the public surface
    // is display order, so the parsed signer must be the constant as written
    // in this file, not its byte reversal.
    let parsed = parse_unsigned_tx(&sample_tx().serialize_unsigned()).expect("valid envelope");
    assert_eq!(parsed.signer, UPDATER_SCRIPT_HASH);
    let mut wire_order = UPDATER_SCRIPT_HASH;
    wire_order.reverse();
    assert_ne!(parsed.signer, wire_order);
}

#[test]
fn unsigned_tx_exposes_no_second_script_decoder() {
    // The envelope carries an invocation script; its shape question is
    // CU-150's `decode_invoke_call`, and this parser only frames it. A parsed
    // envelope therefore hands back exactly the script bytes and no claim
    // about what they mean.
    let account = [
        0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
        0x00, 0x12, 0x34, 0x56, 0x78,
    ];
    let script = create_invoke_script(
        &UPDATER_SCRIPT_HASH,
        "registerAccount",
        &[
            ContractParam::Hash160(format!("0x{}", hex::encode(account))),
            ContractParam::Integer(3600),
        ],
    )
    .expect("valid fixture");
    let tx = FeedTx {
        nonce: 7,
        valid_until_block: 99,
        system_fee: 5,
        network_fee: 6,
        signer: FeedSigner {
            script_hash: UPDATER_SCRIPT_HASH,
        },
        script: &script,
    };
    let parsed = parse_unsigned_tx(&tx.serialize_unsigned()).expect("valid envelope");
    assert_eq!(parsed.script, script);
    assert!(!parsed.script.is_empty());
}
