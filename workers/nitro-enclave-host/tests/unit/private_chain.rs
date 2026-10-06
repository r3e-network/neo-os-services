//! Driven by scripts/test-host-private-chain.py with a freshly deployed kernel.
use crate::{fulfill::handle_oracle_fulfill, state, RuntimeError};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use serde_json::{json, Value};

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)]
mod support;

/// Disposable software signing substitutes only for custody/NSM hardware.
/// The kernel verifies this real P-256 signature over the host-produced digest.
struct LocalSigner(SigningKey);

impl LocalSigner {
    fn identity(&self) -> Value {
        let public = self.0.verifying_key().to_encoded_point(true);
        let hash = neo_os_core::n3_tx::script_hash_from_public_key(public.as_bytes()).unwrap();
        let address = neo_os_core::n3_tx::address_from_script_hash(&hash);
        let display: Vec<_> = hash.iter().rev().copied().collect();
        json!({"public_key": hex::encode(public.as_bytes()), "address": address,
               "script_hash": format!("0x{}", hex::encode(display))})
    }
}

impl state::SignerPlane for LocalSigner {
    fn role_report(&self, _: &str, _: &str) -> state::RoleReport {
        let identity = self.identity();
        state::RoleReport {
            ok: true,
            materialized: true,
            public_key: identity["public_key"].as_str().unwrap().into(),
            identity,
            issues: vec![],
            key_source: "host_plaintext".into(),
        }
    }

    fn sign_payload(&self, network: &str, role: &str, digest: &str) -> Result<Value, RuntimeError> {
        assert_eq!(network, "testnet");
        assert!(matches!(role, "worker" | "oracle_verifier"));
        let signature: Signature = self.0.sign(&hex::decode(digest).expect("digest hex"));
        let mut response = self.identity();
        response["signature"] = json!(hex::encode(signature.to_bytes()));
        Ok(response)
    }
}

#[test]
#[ignore = "requires the disposable private-chain driver"]
fn fulfill_deployed_kernel_request() {
    let path = std::env::var("HOST_PRIVATE_CHAIN_FIXTURE").expect("private-chain fixture required");
    let fixture: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let contract = fixture["request"]["fulfillment_context"]["contract_script_hash"]
        .as_str()
        .unwrap();
    let mut harness = support::test_state(
        &[
            ("NODE_ENV", "test"),
            ("MORPHEUS_NETWORK", "testnet"),
            ("MORPHEUS_TEST_MEASURED_ORACLE_CONTRACT_OVERRIDE", contract),
        ],
        support::FakeAttest::with_document(b"private-chain-only"),
        support::FakeSigner::healthy(),
        support::FakeBridge::new(),
        support::FakeKms::default(),
    );
    harness.state.fulfillment_compute_override = None;
    harness.state.signer = Box::new(LocalSigner(SigningKey::random(&mut rand::rngs::OsRng)));
    let response = handle_oracle_fulfill(&harness.state, &fixture["request"])
        .expect("freshly deployed kernel request must fulfill");
    assert_eq!(response["success"], true);
    assert!(harness.bridge.forwards().is_empty());
    assert!(harness.signer.sign_calls().is_empty());
    std::fs::write(
        format!("{path}.response"),
        serde_json::to_vec(&response).unwrap(),
    )
    .unwrap();
}
