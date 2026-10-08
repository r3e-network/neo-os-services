use neo_os_compute::oracle::{
    decimal::{decimal_to_integer_string, integer_to_decimal_string},
    feeds::{neo_stack_decode::parse_neo_stack_item, normalize_pair_symbol},
};
use neo_os_compute::paymaster::{evaluate_paymaster_authorization, PaymasterEvaluation};
use rand::{rngs::StdRng, Rng, SeedableRng};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn arbitrary(rng: &mut StdRng, depth: usize) -> Value {
    let atoms = [
        Value::Null,
        json!(true),
        json!(false),
        json!(0),
        json!(-1),
        json!(1e100),
        json!(""),
        json!("é00000"),
        json!("💰00000"),
        json!("\0"),
        json!("1e309"),
    ];
    if depth == 3 {
        return atoms[rng.gen_range(0..atoms.len())].clone();
    }
    match rng.gen_range(0..5) {
        0 => json!([arbitrary(rng, depth + 1), arbitrary(rng, depth + 1)]),
        1 => json!({"type": arbitrary(rng, depth + 1), "value": arbitrary(rng, depth + 1)}),
        2 => {
            let alphabet = ['0', '9', '-', '+', '.', 'e', 'é', '💰', '\0', '中'];
            Value::String(
                (0..rng.gen_range(0..48))
                    .map(|_| alphabet[rng.gen_range(0..alphabet.len())])
                    .collect(),
            )
        }
        _ => atoms[rng.gen_range(0..atoms.len())].clone(),
    }
}

#[test]
fn randomized_inputs() {
    let seeds = match std::env::var("FUZZ_SEED") {
        Ok(raw) => vec![raw.parse::<u64>().expect("integer FUZZ_SEED")],
        Err(_) => vec![20261005, 20260928, 4294967295],
    };
    let seconds = std::env::var("FUZZ_SECONDS")
        .unwrap_or_else(|_| "0".into())
        .parse::<u64>()
        .expect("integer FUZZ_SECONDS");
    assert!(seconds <= 600);
    let start = Instant::now();
    let mut streams: Vec<_> = seeds
        .iter()
        .map(|seed| (*seed, StdRng::seed_from_u64(*seed), 0u64))
        .collect();
    let no_http = |_: &neo_os_compute::transport::HttpRequest| -> Result<neo_os_compute::transport::HttpResponse, String> { panic!("unexpected outbound sponsor request") };
    let no_env = |_: &str| None;
    let enabled = |key: &str| (key == "MORPHEUS_PAYMASTER_TESTNET_ENABLED").then(|| "true".into());
    let valid = json!({"network":"testnet", "estimated_gas_units":1, "account_id":"fixture", "target_contract":"fixture", "method":"transfer", "operation_hash":"fixture"});
    match evaluate_paymaster_authorization(&enabled, &valid, &no_http, 0, || "fixture".into())
        .unwrap()
    {
        PaymasterEvaluation::Verdict(body) => assert_eq!(body["approved"], true),
        other => panic!("positive sponsor control rejected {other:?}"),
    }
    loop {
        for (seed, rng, count) in &mut streams {
            for _ in 0..100 {
                let input = arbitrary(rng, 0);
                let gas = arbitrary(rng, 0);
                let integer = rng.gen_range(0..1_000_000_000u64).to_string();
                let bounded_gas = rng.gen_range(-3..9i64);
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let rendered = integer_to_decimal_string(&json!(integer), 6);
                    assert_eq!(decimal_to_integer_string(&rendered, 6).unwrap(), integer);
                    assert!(decimal_to_integer_string(&format!("{input}x"), 6).is_err());
                    // Unexpected Unicode must not unwind the price plane.
                    let _ = integer_to_decimal_string(&input, 6);
                    let decoded = parse_neo_stack_item(&input);
                    assert_eq!(decoded, parse_neo_stack_item(&input));
                    for kind in [
                        "Integer",
                        "ByteString",
                        "Boolean",
                        "Array",
                        "Struct",
                        "Map",
                        "unknown",
                    ] {
                        let malformed = json!({"type":kind,"value":input});
                        let _ = parse_neo_stack_item(&malformed);
                    }
                    let stack =
                        json!({"type": "Array", "value": [{"type": "Integer", "value": integer}]});
                    assert_eq!(parse_neo_stack_item(&stack), json!([integer]));
                    assert!(!normalize_pair_symbol(Some(&input)).is_empty());
                    let payload = json!({"network":"testnet", "estimated_gas_units":gas, "account_id":input, "target_contract":input});
                    match evaluate_paymaster_authorization(&no_env, &payload, &no_http, 0, || {
                        "fixture".into()
                    })
                    .unwrap()
                    {
                        PaymasterEvaluation::Invalid(body) => assert!(body.get("error").is_some()),
                        PaymasterEvaluation::Verdict(body) => assert_eq!(body["approved"], false),
                    }
                    let capped = |key: &str| match key {
                        "MORPHEUS_PAYMASTER_TESTNET_ENABLED" => Some("true".into()),
                        "MORPHEUS_PAYMASTER_TESTNET_MAX_GAS_UNITS" => Some("5".into()),
                        _ => None,
                    };
                    let mut capped_payload = valid.clone();
                    capped_payload["estimated_gas_units"] = json!(bounded_gas);
                    match evaluate_paymaster_authorization(
                        &capped,
                        &capped_payload,
                        &no_http,
                        0,
                        || "fixture".into(),
                    )
                    .unwrap()
                    {
                        PaymasterEvaluation::Invalid(_) => assert!(bounded_gas < 1),
                        PaymasterEvaluation::Verdict(body) => {
                            assert_eq!(body["approved"], (1..=5).contains(&bounded_gas))
                        }
                    }
                    // An enabled policy still refuses a missing principal, with valid gas.
                    let enabled = |key: &str| {
                        (key == "MORPHEUS_PAYMASTER_TESTNET_ENABLED").then(|| "true".into())
                    };
                    let bad = json!({"network":"testnet", "estimated_gas_units":1});
                    match evaluate_paymaster_authorization(&enabled, &bad, &no_http, 0, || {
                        "fixture".into()
                    })
                    .unwrap()
                    {
                        PaymasterEvaluation::Verdict(body) => assert_eq!(body["approved"], false),
                        other => panic!("unexpected verdict {other:?}"),
                    }
                }));
                assert!(
                    result.is_ok(),
                    "seed={seed} case={count} input={input} gas={gas} integer={integer} bounded_gas={bounded_gas}"
                );
                *count += 1;
            }
        }
        if start.elapsed() >= Duration::from_secs(seconds) {
            break;
        }
    }
    // The receipt is machine-checked by run-services-inputs.mjs: a filtered-out
    // or shortened run fails instead of passing with no cases explored.
    println!(
        "SERVICES_INPUTS_RECEIPT {}",
        json!({
            "suite": "services-rust",
            "elapsedSeconds": start.elapsed().as_secs_f64(),
            "seeds": streams
                .iter()
                .map(|(seed, _, count)| json!({"seed": seed, "cases": count}))
                .collect::<Vec<_>>(),
        })
    );
    println!(
        "services-rust elapsed_seconds={:.3} seeds_cases={:?}",
        start.elapsed().as_secs_f64(),
        streams
            .iter()
            .map(|(seed, _, count)| (seed, count))
            .collect::<Vec<_>>()
    );
}

// Minimal inputs from the randomized run: with decimals 6 the byte index
// `len - 6` fell inside a multi-byte character and `padded[..index]` panicked.
// The fix slices UTF-16 code units, matching the JavaScript `String.slice` the
// module ports, so the rendering is defined for every input.
#[test]
fn non_ascii_integer_input_is_rendered_without_panicking() {
    assert_eq!(
        integer_to_decimal_string(&json!("é00000"), 6),
        "0.é00000",
        "must match integerToDecimalString('é00000', 6) in the JavaScript port"
    );
    // A surrogate pair can still be split by the ported slice semantics; that
    // must degrade to a replacement character, never to a panic.
    for input in ["💰00000", "💰\u{0}中", "中中中", "é", "\u{0}000000"] {
        let _ = integer_to_decimal_string(&json!(input), 6);
    }
}
