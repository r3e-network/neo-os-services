//! Tests for the hash type that decides what a policy list means, and for the
//! policy shape that a page and the database both depend on.

use super::*;
use crate::tx::{native, script_hash_to_display};

/// NEO as an operator copies it out of an explorer.
const NEO_DISPLAY: &str = "0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5";

fn account(byte: u8) -> ScriptHash {
    ScriptHash::from_wire([byte; 20])
}

#[test]
fn text_is_display_order_and_bytes_are_wire_order() {
    let neo = ScriptHash::from_wire(native::NEO);
    assert_eq!(neo.to_string(), NEO_DISPLAY);
    // The one confusion this type exists to prevent: the text form and the byte
    // form of the same hash are reverses of each other, so a comparison written
    // against the wrong one can never match.
    assert_ne!(
        hex::encode(neo.as_bytes()),
        NEO_DISPLAY.trim_start_matches("0x")
    );
    assert_eq!(ScriptHash(neo.as_bytes()), neo);
}

#[test]
fn parsing_reverses_what_rendering_reversed() {
    for byte in [0x00u8, 0x01, 0x7f, 0x80, 0xfe, 0xff] {
        let hash = account(byte);
        let parsed: ScriptHash = hash.to_string().parse().expect("round trip");
        assert_eq!(
            parsed, hash,
            "display text must parse back to the same bytes"
        );
    }
}

#[test]
fn parsing_accepts_what_an_operator_pastes_and_rejects_the_rest() {
    let expected = ScriptHash::from_wire(native::NEO);
    for input in [
        NEO_DISPLAY.to_string(),
        NEO_DISPLAY[2..].to_string(),
        format!("  {NEO_DISPLAY}  "),
        NEO_DISPLAY.to_uppercase().replacen("0X", "0x", 1),
    ] {
        assert_eq!(input.parse::<ScriptHash>(), Ok(expected), "input {input:?}");
    }
    for input in [
        String::new(),
        "0x".to_string(),
        "0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f".to_string(),
        "0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5aa".to_string(),
        "0xzz4073a0f2b305a38ec4050e4d3d28bc40ea63f5".to_string(),
        "NWvP42DaUATm9ULce44T9evAizDuxMzSWg".to_string(),
    ] {
        assert!(
            input.parse::<ScriptHash>().is_err(),
            "input {input:?} must not silently become a hash"
        );
    }
}

#[test]
fn a_wire_order_paste_is_the_same_length_and_the_wrong_hash() {
    // There is no way to tell a wire-order paste from a display-order one, so
    // the type resolves the ambiguity the only safe way: display order always,
    // stated in the docs. This test exists so that decision is visible rather
    // than accidental.
    let wire = script_hash_to_display(&native::NEO);
    let reversed = ScriptHash::from_wire({
        let mut bytes = native::NEO;
        bytes.reverse();
        bytes
    });
    assert_eq!(
        reversed.to_string(),
        format!("0x{}", hex::encode(native::NEO))
    );
    assert_eq!(wire, NEO_DISPLAY);
    assert_ne!(reversed, ScriptHash::from_wire(native::NEO));
}

#[test]
fn ordering_is_by_bytes_so_lists_are_stable() {
    let mut list = vec![account(0x02), account(0x01), account(0x01)];
    list.sort_unstable();
    list.dedup();
    assert_eq!(list, vec![account(1), account(2)]);
}

#[test]
fn normalizing_sorts_and_deduplicates_every_list() {
    let policy = SignerPolicy {
        contract_whitelist: vec![account(9), account(3), account(9)],
        contract_blacklist: vec![account(4), account(4)],
        asset_whitelist: vec![account(7), account(1), account(7)],
        asset_blacklist: vec![account(2), account(2)],
        asset_limits: vec![
            AssetLimit {
                asset: account(7),
                max_single_amount: Some(9),
                window_limit: None,
            },
            AssetLimit {
                asset: account(1),
                max_single_amount: Some(3),
                window_limit: None,
            },
            AssetLimit {
                asset: account(7),
                max_single_amount: Some(9),
                window_limit: None,
            },
        ],
        transfer_to_whitelist: vec![account(8), account(8), account(5)],
        transfer_to_blacklist: vec![account(6), account(6)],
        ..Default::default()
    }
    .normalized();
    assert_eq!(policy.contract_whitelist, vec![account(3), account(9)]);
    assert_eq!(policy.contract_blacklist, vec![account(4)]);
    assert_eq!(policy.asset_whitelist, vec![account(1), account(7)]);
    assert_eq!(policy.asset_blacklist, vec![account(2)]);
    assert_eq!(policy.asset_limits.len(), 2);
    assert_eq!(policy.asset_limits[0].asset, account(1));
    assert_eq!(policy.asset_limits[1].asset, account(7));
    assert_eq!(policy.transfer_to_whitelist, vec![account(5), account(8)]);
    assert_eq!(policy.transfer_to_blacklist, vec![account(6)]);
    // Round-tripping through the database has to compare equal, so a second
    // save of an unchanged policy stays a no-op.
    assert_eq!(policy.clone().normalized(), policy);
}

#[test]
fn a_fresh_policy_allows_nothing() {
    let policy = SignerPolicy::default();
    assert!(!policy.allow_consensus);
    assert!(!policy.allow_transfer);
    assert!(!policy.allow_contract_call);
    assert!(!policy.allow_global_scope);
    assert!(policy.max_single_amount.is_none());
    assert!(policy.window_limit.is_none());
}

#[test]
fn raw_authority_is_valid_only_on_a_semantically_closed_key() {
    let raw_only = SignerPolicy {
        allow_raw: true,
        ..Default::default()
    };
    assert!(!raw_only.mixes_raw_and_semantic_authority());

    for mixed in [
        SignerPolicy {
            allow_raw: true,
            allow_consensus: true,
            ..Default::default()
        },
        SignerPolicy {
            allow_raw: true,
            allow_transfer: true,
            ..Default::default()
        },
        SignerPolicy {
            allow_raw: true,
            allow_contract_call: true,
            ..Default::default()
        },
        SignerPolicy {
            allow_raw: true,
            allow_global_scope: true,
            ..Default::default()
        },
    ] {
        assert!(mixed.mixes_raw_and_semantic_authority());
    }
}

#[test]
fn a_window_ceiling_and_its_length_cannot_be_configured_apart() {
    // Two independent optional fields would let an operator set a ceiling with
    // no window, or a window with no ceiling, and believe the key was limited.
    let policy = SignerPolicy {
        window_limit: Some(WindowLimit {
            seconds: 3_600,
            max_amount: 10_000_000_000,
        }),
        ..Default::default()
    };
    let limit = policy.window_limit.expect("one struct holds both halves");
    assert_eq!((limit.seconds, limit.max_amount), (3_600, 10_000_000_000));
}

#[test]
fn warning_about_rules_that_can_never_be_reached() {
    let policy = SignerPolicy {
        asset_whitelist: vec![account(1)],
        max_single_amount: Some(100),
        ..Default::default()
    };
    let codes: Vec<&str> = policy
        .problems()
        .iter()
        .map(|problem| problem.code())
        .collect();
    assert_eq!(codes, vec!["transfer-rules-without-transfer"]);
}

#[test]
fn warning_about_boundaries_that_are_wider_than_they_look() {
    let policy = SignerPolicy {
        allow_contract_call: true,
        allow_transfer: true,
        allow_global_scope: true,
        ..Default::default()
    };
    let codes: Vec<&str> = policy
        .problems()
        .iter()
        .map(|problem| problem.code())
        .collect();
    assert_eq!(
        codes,
        vec![
            "contract-calls-unbounded",
            "global-scope-enabled",
            "transfers-without-asset-list",
        ]
    );

    let tight = SignerPolicy {
        allow_contract_call: true,
        contract_whitelist: vec![account(3)],
        ..Default::default()
    };
    assert!(tight.problems().is_empty());
}

#[test]
fn warning_about_a_ceiling_nothing_can_satisfy() {
    for ceiling in [0, -1] {
        let policy = SignerPolicy {
            allow_transfer: true,
            max_single_amount: Some(ceiling),
            asset_whitelist: vec![account(1)],
            ..Default::default()
        };
        assert!(
            policy
                .problems()
                .contains(&PolicyProblem::ZeroAmountCeiling),
            "ceiling {ceiling}"
        );
    }
    let window = SignerPolicy {
        window_limit: Some(WindowLimit {
            seconds: 60,
            max_amount: 0,
        }),
        ..Default::default()
    };
    assert!(window
        .problems()
        .contains(&PolicyProblem::ZeroAmountCeiling));
}

// -- SVC-B-5: the boundary's own identity -------------------------------------

/// SVC-B-5 (CL-18). CL-18 requires that "the policy version used is recorded
/// in the audit record", and nothing in this service could record one: no
/// version column, no digest, and the single place a policy reached the audit
/// trail reduced every list to a COUNT. So the digest has to actually
/// distinguish boundaries — including ones the count-based summary rendered
/// identically, which is the exact widen-sign-narrow case an incident review
/// cannot otherwise answer.
#[test]
fn the_policy_digest_separates_boundaries_a_count_summary_cannot() {
    let with_contracts = |contracts: Vec<ScriptHash>| SignerPolicy {
        allow_contract_call: true,
        contract_whitelist: contracts,
        ..SignerPolicy::default()
    };
    // Same LENGTH, different contracts — indistinguishable to "contracts 1/0".
    let narrow = with_contracts(vec![account(0x11)]);
    let widened = with_contracts(vec![account(0x22)]);
    assert_ne!(narrow.digest(), widened.digest());
    assert_ne!(narrow.digest_label(), widened.digest_label());

    // A genuinely wider boundary differs too.
    let wider = with_contracts(vec![account(0x11), account(0x22)]);
    assert_ne!(narrow.digest(), wider.digest());
}

/// Usable as evidence only if it is stable: the same boundary must digest the
/// same every time, and a policy round-tripped through the store (which
/// normalizes list order) must not look like a different one.
#[test]
fn the_policy_digest_is_stable_and_order_independent() {
    let ordered = SignerPolicy {
        allow_transfer: true,
        contract_whitelist: vec![account(0x11), account(0x22)],
        asset_whitelist: vec![account(0x33)],
        ..SignerPolicy::default()
    };
    let shuffled = SignerPolicy {
        contract_whitelist: vec![account(0x22), account(0x11)],
        ..ordered.clone()
    };
    assert_eq!(ordered.digest(), ordered.digest(), "deterministic");
    assert_eq!(
        ordered.digest(),
        shuffled.digest(),
        "normalization must make list order a non-difference"
    );

    // The label is a hex prefix of the digest, not a separate hash.
    let label = ordered.digest_label();
    assert_eq!(label.len(), POLICY_DIGEST_LABEL_LEN);
    assert!(hex::encode(ordered.digest()).starts_with(&label));
}

/// Every field must be covered, or the digest silently stops describing part
/// of the boundary. The exhaustive destructuring inside `digest` is the
/// compile-time half of this; these are the fields most likely to be treated
/// as "just a limit" and left out.
#[test]
fn the_policy_digest_covers_the_switches_and_the_ceilings() {
    let base = SignerPolicy::default();
    let variants = [
        SignerPolicy {
            allow_raw: true,
            ..base.clone()
        },
        SignerPolicy {
            allow_global_scope: true,
            ..base.clone()
        },
        SignerPolicy {
            max_single_amount: Some(1),
            ..base.clone()
        },
        SignerPolicy {
            max_signers: Some(1),
            ..base.clone()
        },
        SignerPolicy {
            max_system_fee: Some(1),
            ..base.clone()
        },
        SignerPolicy {
            max_network_fee: Some(1),
            ..base.clone()
        },
        SignerPolicy {
            window_limit: Some(WindowLimit {
                seconds: 60,
                max_amount: 5,
            }),
            ..base.clone()
        },
        SignerPolicy {
            max_signatures: Some(SignatureRateLimit {
                seconds: 60,
                count: 5,
            }),
            ..base.clone()
        },
        SignerPolicy {
            evm_chain_id: Some(47763),
            ..base.clone()
        },
        SignerPolicy {
            evm_max_gas_price: Some(1),
            ..base.clone()
        },
        SignerPolicy {
            evm_max_gas_limit: Some(1),
            ..base.clone()
        },
        SignerPolicy {
            evm_method_whitelist: vec!["0xa9059cbb".to_string()],
            ..base.clone()
        },
        SignerPolicy {
            evm_method_blacklist: vec!["0xa9059cbb".to_string()],
            ..base.clone()
        },
        SignerPolicy {
            asset_limits: vec![AssetLimit {
                asset: account(0x44),
                max_single_amount: Some(2),
                window_limit: None,
            }],
            ..base.clone()
        },
        SignerPolicy {
            contract_method_whitelist: vec![ContractMethod {
                contract: account(0x55),
                method: "transfer".to_string(),
            }],
            ..base.clone()
        },
        SignerPolicy {
            chain_family: Some(crate::network::ChainFamily::NeoX),
            ..base.clone()
        },
    ];
    let mut seen = vec![base.digest()];
    for variant in variants {
        let digest = variant.digest();
        assert!(
            !seen.contains(&digest),
            "a field change must move the digest: {variant:?}"
        );
        seen.push(digest);
    }

    // Unset and empty are not the same thing — a whitelist that was cleared
    // is a different boundary from one that was never configured, and the
    // length-prefixed encoding keeps them apart.
    assert_ne!(
        SignerPolicy {
            evm_method_whitelist: Vec::new(),
            evm_chain_id: None,
            ..base.clone()
        }
        .digest(),
        SignerPolicy {
            evm_method_whitelist: Vec::new(),
            evm_chain_id: Some(0),
            ..base
        }
        .digest(),
    );
}
