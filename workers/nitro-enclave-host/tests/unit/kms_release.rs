//! KMS release glue tests — offline only: the NSM source and the transport
//! are stubs, so what is under test is the wiring (region, credentials,
//! amz date and ciphertext actually reach the signed request) and error
//! propagation, not a real KMS round trip.

use super::*;
use nitro_attest::release::KmsTransport;
use std::sync::{Arc, Mutex};

struct StubSource {
    result: Result<Vec<u8>, String>,
}

impl release::AttestationSource for StubSource {
    fn attest(
        &self,
        _nonce: Option<&[u8]>,
        _user_data: Option<&[u8]>,
        _public_key: Option<&[u8]>,
    ) -> Result<Vec<u8>, String> {
        self.result.clone()
    }
}

/// What one transport call looked like: `(url, headers, body)`.
type CapturedRequest = (String, Vec<(String, String)>, String);

#[derive(Clone)]
struct CapturingTransport {
    captured: Arc<Mutex<Option<CapturedRequest>>>,
    result: Result<(u16, String), String>,
}

impl KmsTransport for CapturingTransport {
    fn post_json(
        &self,
        url: &str,
        headers: &[(String, String)],
        body: &str,
    ) -> Result<(u16, String), String> {
        *self.captured.lock().expect("capture lock") =
            Some((url.to_string(), headers.to_vec(), body.to_string()));
        self.result.clone()
    }
}

fn params() -> KmsReleaseParams {
    KmsReleaseParams {
        region: "eu-west-1".to_string(),
        ciphertext_b64: "Y2lwaGVydGV4dA==".to_string(),
        access_key_id: "AKIDEXAMPLE".to_string(),
        secret_access_key: "wJalrXUtnFEMI".to_string(),
        session_token: Some("session-token".to_string()),
    }
}

fn capturing_kms(source: Result<Vec<u8>, String>, transport: CapturingTransport) -> ProductionKms {
    ProductionKms {
        source: Box::new(StubSource { result: source }),
        transport: Box::new(transport),
    }
}

#[test]
fn the_release_request_carries_region_credentials_and_ciphertext() {
    let transport = CapturingTransport {
        captured: Arc::new(Mutex::new(None)),
        result: Err("kms transport unreachable".to_string()),
    };
    let kms = capturing_kms(Ok(b"doc".to_vec()), transport.clone());
    let error = kms.decrypt(&params()).expect_err("transport refused");

    assert_eq!(error, "kms transport unreachable");
    let (url, headers, body) = transport
        .captured
        .lock()
        .expect("capture lock")
        .take()
        .expect("the signed request ran");
    assert!(url.contains("kms.eu-west-1.amazonaws.com"), "{url}");
    let authorization = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
        .map(|(_, value)| value.clone())
        .expect("sigv4 authorization header");
    assert!(
        authorization.starts_with("AWS4-HMAC-SHA256"),
        "{authorization}"
    );
    let amz_date = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("x-amz-date"))
        .map(|(_, value)| value.clone())
        .expect("amz date header");
    let digits = |text: &str| text.chars().all(|c| c.is_ascii_digit());
    assert_eq!(amz_date.len(), 16, "{amz_date}");
    assert!(
        digits(&amz_date[..8]) && amz_date.as_bytes()[8] == b'T',
        "{amz_date}"
    );
    assert!(
        digits(&amz_date[9..15]) && amz_date.ends_with('Z'),
        "{amz_date}"
    );
    assert!(
        body.contains(r#""CiphertextBlob":"Y2lwaGVydGV4dA==""#),
        "{body}"
    );
    assert!(
        body.contains(r#""AttestationDocument":"ZG9j""#),
        "the attestation document rides the Recipient: {body}"
    );
}

#[test]
fn an_attestation_failure_stops_the_release_before_any_network_call() {
    let transport = CapturingTransport {
        captured: Arc::new(Mutex::new(None)),
        result: Ok((200, "{}".to_string())),
    };
    let kms = capturing_kms(
        Err("nsm: this platform does not support NSM".to_string()),
        transport.clone(),
    );
    let error = kms.decrypt(&params()).expect_err("attest refused");
    assert_eq!(error, "nsm: this platform does not support NSM");
    assert!(transport.captured.lock().expect("capture lock").is_none());
}
