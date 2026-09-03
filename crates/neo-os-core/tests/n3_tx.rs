//! Golden vectors for the Neo N3 wire encoding, harvested from the repo's own
//! neon-js (`sc.createScript` / `tx.Transaction.getMessageForSigning`) with
//! the exact fixtures the feed lane drives: the updateFeeds argument arrays,
//! the FakeSigner script hash, and the testnet magic. The integer edge cases
//! (255 → `ff 00`, 4294967295 → 8 bytes) pin the signed two's-complement
//! emission; the `Base64Bytes` cases pin the `ContractParam.byteArray`
//! base64-decode quirk.

use neo_os_core::n3_tx::{create_invoke_script, ContractParam, FeedSigner, FeedTx};

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
    );
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
    );
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
        );
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
    );
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
    );
    assert!(hex(&empty).starts_with("0c00"));

    let two = create_invoke_script(
        &FEED_N3_CONTRACT,
        "updateFeeds",
        &[ContractParam::Array(vec![
            ContractParam::String("A".to_string()),
            ContractParam::String("B".to_string()),
        ])],
    );
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
    );
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
    );
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
    );
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
