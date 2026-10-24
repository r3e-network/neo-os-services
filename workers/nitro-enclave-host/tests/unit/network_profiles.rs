use super::*;

#[test]
fn oracle_family_exception_preserves_exact_javascript_whitespace() {
    for route in ["/oracle/decrypt", "/oracle/message-reveal"] {
        for label in ["neox", "NEO_X", "Neo-X"] {
            let bom = serde_json::json!({"network": format!("\u{feff}{label}\u{feff}")});
            assert!(assert_payload_network("testnet", route, &bom).is_ok());
            let nel = serde_json::json!({"network": format!("\u{85}{label}\u{85}")});
            assert!(assert_payload_network("testnet", route, &nel).is_err());
            let conflict = serde_json::json!({"network": format!("\u{feff}{label}\u{feff}"), "environment":"mainnet"});
            assert!(assert_payload_network("testnet", route, &conflict).is_err());
            assert!(assert_payload_network("testnet", "/compute", &bom).is_err());
        }
    }
}

#[path = "network_context.rs"]
mod effective_context;

#[test]
fn profiles_copy_only_boot_policy_not_ambient_credentials_or_rpc() {
    let base = EnvOverlay::new([
        (PROFILES_ENV, r#"{"mainnet":{},"testnet":{}}"#),
        ("NODE_ENV", "production"),
        ("MORPHEUS_ATTESTED_BOOT", "require"),
        ("MORPHEUS_RUNTIME_TOKEN", "ambient-fixture"),
        ("NEO_RPC_URL", "http://wrong.invalid"),
    ]);
    let mut profiles = NetworkProfiles::from_overlay(&base).unwrap();
    assert!(profiles.explicit);
    for (network, overlay) in &profiles.overlays {
        assert_eq!(overlay.get("MORPHEUS_NETWORK"), Some(network.as_str()));
        assert_eq!(overlay.get("NODE_ENV"), Some("production"));
        assert_eq!(overlay.get("MORPHEUS_ATTESTED_BOOT"), Some("require"));
        assert_eq!(overlay.get("MORPHEUS_RUNTIME_TOKEN"), None);
        assert_eq!(overlay.get("NEO_RPC_URL"), None);
    }
    profiles
        .overlays
        .get_mut("mainnet")
        .unwrap()
        .set_runtime_token("new-mainnet-fixture");
    assert_eq!(
        profiles.overlays["testnet"].get("MORPHEUS_RUNTIME_TOKEN"),
        None
    );
}

#[test]
fn invalid_and_duplicate_headers_are_rejected() {
    let mut headers = http::HeaderMap::new();
    headers.append("x-morpheus-network", "mainnet".parse().unwrap());
    headers.append("x-morpheus-network", "mainnet".parse().unwrap());
    assert_eq!(
        select_request("GET", "/mainnet/health", &headers, "")
            .err()
            .unwrap()
            .status,
        400
    );
    for body in [
        r#"{"network":null}"#,
        r#"{"network":12}"#,
        r#"{"network":"unknown"}"#,
    ] {
        assert!(select_request(
            "POST",
            "/mainnet/sign/payload",
            &http::HeaderMap::new(),
            body
        )
        .is_err());
    }
}

#[test]
fn canonical_nested_route_survives_but_additional_prefix_does_not() {
    let headers = http::HeaderMap::new();
    let selected =
        select_request("GET", "/testnet/neodid/providers?limit=2", &headers, "").unwrap();
    assert_eq!(selected.network, "testnet");
    assert_eq!(selected.raw_url, "/neodid/providers?limit=2");
    for path in [
        "/mainnet/evil/health",
        "/mainnet/testnet/health",
        "/mainnet/../testnet/health",
    ] {
        assert!(select_request("GET", path, &headers, "").is_err());
    }
}

#[test]
fn empty_profile_setting_is_invalid_and_legacy_mode_remains_explicitly_single() {
    assert!(NetworkProfiles::from_overlay(&EnvOverlay::new([(PROFILES_ENV, "")])).is_err());
    let profiles =
        NetworkProfiles::from_overlay(&EnvOverlay::new([("MORPHEUS_NETWORK", "mainnet")])).unwrap();
    assert!(!profiles.explicit);
    assert_eq!(profiles.overlays.len(), 1);
    assert!(profiles.overlays.contains_key("mainnet"));
}

#[test]
fn oracle_chain_family_aliases_preserve_the_selected_deployment() {
    for deployment in ["mainnet", "testnet"] {
        for route in ["/oracle/decrypt", "/oracle/message-reveal"] {
            for family in ["neox", " NEO_X ", "Neo-X"] {
                let payload = serde_json::json!({"network":family});
                assert!(assert_payload_network(deployment, route, &payload).is_ok());
                let selected = select_request(
                    "POST",
                    &format!("/{deployment}{route}"),
                    &http::HeaderMap::new(),
                    &payload.to_string(),
                )
                .unwrap();
                assert_eq!(selected.network, deployment);
                assert_eq!(selected.raw_url, route);
            }
        }
    }
}

#[test]
fn oracle_chain_family_exception_cannot_exempt_deployment_aliases_or_other_routes() {
    for deployment in ["mainnet", "testnet"] {
        let other = if deployment == "mainnet" {
            "testnet"
        } else {
            "mainnet"
        };
        for route in ["/oracle/decrypt", "/oracle/message-reveal"] {
            for alias in ["morpheus_network", "runtime_network", "environment"] {
                assert!(assert_payload_network(
                    deployment,
                    route,
                    &serde_json::json!({"network":"neox",alias:other})
                )
                .is_err());
            }
            for invalid in ["neo_n3", "unknown", "", other] {
                assert!(assert_payload_network(
                    deployment,
                    route,
                    &serde_json::json!({"network":invalid})
                )
                .is_err());
            }
        }
        for route in [
            "/oracle/query",
            "/oracle/smart-fetch",
            "/compute/execute",
            "/neodid/bind",
        ] {
            assert!(assert_payload_network(
                deployment,
                route,
                &serde_json::json!({"network":"neox"})
            )
            .is_err());
        }
    }
}

#[test]
fn every_supported_payload_alias_is_bound_but_recovery_chain_family_is_not_a_network() {
    let headers = http::HeaderMap::new();
    for alias in [
        "network",
        "morpheus_network",
        "runtime_network",
        "environment",
    ] {
        let body = serde_json::json!({alias: "testnet"}).to_string();
        assert!(
            select_request("POST", "/mainnet/attestation", &headers, &body).is_err(),
            "{alias}"
        );
    }
    for family in ["neo_n3", "neox"] {
        let body = serde_json::json!({"network": family}).to_string();
        assert!(select_request("POST", "/mainnet/neodid/recovery-ticket", &headers, &body).is_ok());
    }
}

#[test]
fn aa_v3_network_text_does_not_select_or_bypass_the_deployment_context() {
    let headers = http::HeaderMap::new();
    for (route, callback_encoding) in [
        ("/neodid/action-ticket", "neo_n3_action_v3"),
        ("/neodid/recovery-ticket", "neo_n3_recovery_v3"),
    ] {
        for deployment in ["mainnet", "testnet"] {
            let payload = serde_json::json!({
                "network": "neo3-testnet",
                "callback_encoding": callback_encoding,
            });
            assert!(assert_payload_network(deployment, route, &payload).is_ok());
            let selected = select_request(
                "POST",
                &format!("/{deployment}{route}"),
                &headers,
                &payload.to_string(),
            )
            .unwrap();
            assert_eq!(selected.network, deployment);
            assert_eq!(selected.raw_url, route);

            let foreign = serde_json::json!({
                "network": "neo3-testnet",
                "callback_encoding": callback_encoding,
                "environment": if deployment == "testnet" { "mainnet" } else { "testnet" },
            });
            assert!(assert_payload_network(deployment, route, &foreign).is_err());
            let malformed = serde_json::json!({
                "network": false,
                "callback_encoding": callback_encoding,
            });
            assert!(assert_payload_network(deployment, route, &malformed).is_err());
        }
    }

    for payload in [
        serde_json::json!({"network":"neo3-testnet"}),
        serde_json::json!({"network":"neo3-testnet","callback_encoding":"neo_n3_action_v1"}),
        serde_json::json!({"network":"neo3-testnet","callback_encoding":"neo_n3_recovery_v3"}),
    ] {
        assert!(assert_payload_network("testnet", "/neodid/action-ticket", &payload).is_err());
    }
    assert!(assert_payload_network(
        "testnet",
        "/neodid/recovery-ticket",
        &serde_json::json!({"network":"neo3-testnet"})
    )
    .is_err());
}
