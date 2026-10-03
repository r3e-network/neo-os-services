//! End-to-end tests for [`nitro_attest::release`] — the whole Nitro Recipient
//! flow with the NSM device and the network played by mocks.
//!
//! The mock attestation source records the ephemeral public key the release
//! bound into its document; the mock transport then acts as KMS, wrapping a
//! known data key to exactly that key as a CiphertextForRecipient. A release
//! that attested a different key, signed the wrong request, or opened the CMS
//! wrong fails these tests; what they cannot exercise is the real /dev/nsm
//! ioctl and a live KMS (Linux/Nitro machine only).

use std::sync::{Arc, Mutex};

use aes::cipher::{generic_array::GenericArray, BlockEncrypt, KeyInit};
use aws_lc_rs::rsa::{OaepPublicEncryptingKey, PublicEncryptingKey, OAEP_SHA256_MGF1SHA256};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use nitro_attest::asn1::{
    oid_aes256_cbc, oid_data, oid_enveloped_data, oid_mgf1, oid_p_specified, oid_rsaes_oaep,
    oid_sha256,
};
use nitro_attest::kms::{Credentials, SignedRequest};
use nitro_attest::release::{
    release_bytes, release_bytes_with_context, release_bytes_with_context_and_key,
    release_master_key, AttestationSource, KmsTransport, ReleaseParams,
};
use serde_json::{json, Value};

const DATA_KEY: [u8; 32] = [7u8; 32];
const WRAP_CEK: [u8; 32] = [0x5a; 32];
const IV: [u8; 16] = [1u8; 16];
const CIPHERTEXT_B64: &str = "AAECAwQFBgcICQ==";

// --- minimal DER helpers (same wire shape as tests/cms_roundtrip.rs) ---

fn tlv(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    let len = content.len();
    if len < 0x80 {
        out.push(len as u8);
    } else {
        let be = (len as u64).to_be_bytes();
        let significant = &be[be.iter().position(|&b| b != 0).unwrap_or(be.len() - 1)..];
        out.push(0x80 | significant.len() as u8);
        out.extend_from_slice(significant);
    }
    out.extend_from_slice(content);
    out
}

fn concat_into(tag: u8, parts: &[&[u8]]) -> Vec<u8> {
    let mut body = Vec::new();
    for part in parts {
        body.extend_from_slice(part);
    }
    tlv(tag, &body)
}

fn seq(parts: &[&[u8]]) -> Vec<u8> {
    concat_into(0x30, parts)
}

fn set(parts: &[&[u8]]) -> Vec<u8> {
    concat_into(0x31, parts)
}

fn octet(content: &[u8]) -> Vec<u8> {
    tlv(0x04, content)
}

fn null() -> Vec<u8> {
    tlv(0x05, &[])
}

fn rsa_oaep_sha256_params() -> Vec<u8> {
    let hash = seq(&[&oid(oid_sha256()), &null()]);
    let mgf_hash = seq(&[&oid(oid_sha256()), &null()]);
    let mgf = seq(&[&oid(oid_mgf1()), &mgf_hash]);
    let source = seq(&[&oid(oid_p_specified()), &octet(&[])]);
    let hash_field = tlv(0xa0, &hash);
    let mgf_field = tlv(0xa1, &mgf);
    let source_field = tlv(0xa2, &source);
    seq(&[&hash_field, &mgf_field, &source_field])
}

fn integer(value: u8) -> Vec<u8> {
    tlv(0x02, &[value])
}

fn oid(content: &[u8]) -> Vec<u8> {
    tlv(0x06, content)
}

fn pkcs7_pad(data: &[u8], block_size: usize) -> Vec<u8> {
    let pad = block_size - (data.len() % block_size);
    let mut out = data.to_vec();
    out.extend(std::iter::repeat_n(pad as u8, pad));
    out
}

fn aes256_cbc_encrypt(cek: &[u8], iv: &[u8], plaintext: &[u8]) -> Vec<u8> {
    let block = aes::Aes256::new_from_slice(cek).unwrap();
    let mut out = Vec::with_capacity(plaintext.len());
    let mut prev = [0u8; 16];
    prev.copy_from_slice(iv);
    for chunk in plaintext.as_chunks::<16>().0 {
        let mut buf = GenericArray::clone_from_slice(chunk);
        for (b, p) in buf.iter_mut().zip(prev.iter()) {
            *b ^= p;
        }
        block.encrypt_block(&mut buf);
        out.extend_from_slice(&buf);
        prev.copy_from_slice(&buf);
    }
    out
}

/// The CiphertextForRecipient shape AWS KMS returns for a Nitro Recipient:
/// one KeyTransRecipientInfo wrapping the CEK with RSAES-OAEP-SHA256 to the
/// attested public key, AES-256-CBC content, PKCS#7 padding.
fn build_kms_response(pub_key: &PublicEncryptingKey, cek: &[u8], plaintext: &[u8]) -> Value {
    let oaep = OaepPublicEncryptingKey::new(pub_key.clone()).unwrap();
    let mut encrypted_key = vec![0u8; oaep.ciphertext_size()];
    let enc_key = oaep
        .encrypt(&OAEP_SHA256_MGF1SHA256, cek, &mut encrypted_key, None)
        .unwrap();
    let padded = pkcs7_pad(plaintext, 16);
    let ct = aes256_cbc_encrypt(cek, &IV, &padded);
    let oaep_params = rsa_oaep_sha256_params();
    let oaep_algorithm = seq(&[&oid(oid_rsaes_oaep()), &oaep_params]);
    let ktri = seq(&[
        &integer(0),
        &tlv(0x02, &[1]),
        &oaep_algorithm,
        &octet(enc_key),
    ]);
    let eci = seq(&[
        &oid(oid_data()),
        &seq(&[&oid(oid_aes256_cbc()), &octet(&IV)]),
        &tlv(0x80, &ct),
    ]);
    let env = seq(&[&integer(0), &set(&[&ktri]), &eci]);
    let content_info = seq(&[&oid(oid_enveloped_data()), &tlv(0xA0, &env)]);
    json!({ "CiphertextForRecipient": BASE64.encode(&content_info) })
}

// --- mocks ---

/// Returns a canned document and records the public key it was asked to bind.
struct RecordingSource {
    captured_public_key: Arc<Mutex<Option<Vec<u8>>>>,
}

impl AttestationSource for RecordingSource {
    fn attest(
        &self,
        _nonce: Option<&[u8]>,
        _user_data: Option<&[u8]>,
        public_key: Option<&[u8]>,
    ) -> nitro_attest::AttestResult<Vec<u8>> {
        *self.captured_public_key.lock().unwrap() = public_key.map(|key| key.to_vec());
        Ok(vec![0xa1, 0xb2, 0xc3])
    }
}

struct MockKms {
    captured_public_key: Arc<Mutex<Option<Vec<u8>>>>,
    reply: KmsReply,
    seen: Mutex<Vec<SignedRequest>>,
}

/// What the mock KMS answers with. `Release` builds the real CiphertextForRecipient
/// shape around the caller-chosen data key, wrapped to the attested key.
enum KmsReply {
    Release(Vec<u8>),
    Status(u16, Value),
}

impl KmsTransport for MockKms {
    fn post_json(
        &self,
        url: &str,
        headers: &[(String, String)],
        body: &str,
    ) -> nitro_attest::AttestResult<(u16, String)> {
        let public_key = self
            .captured_public_key
            .lock()
            .unwrap()
            .clone()
            .expect("the attestation source should have run first");
        let spki = PublicEncryptingKey::from_der(&public_key)
            .expect("the attested key must be a SPKI DER RSA public key");
        self.seen.lock().unwrap().push(SignedRequest {
            url: url.to_string(),
            headers: headers.to_vec(),
            body: body.to_string(),
        });
        let (status, text) = match &self.reply {
            KmsReply::Release(data_key) => (
                200,
                build_kms_response(&spki, data_key, data_key).to_string(),
            ),
            KmsReply::Status(status, body) => (*status, body.to_string()),
        };
        Ok((status, text))
    }
}

fn params<'a>(credentials: &'a Credentials, amz_date: &'a str) -> ReleaseParams<'a> {
    ReleaseParams {
        region: "us-east-1",
        credentials,
        ciphertext_b64: CIPHERTEXT_B64,
        amz_date,
    }
}

fn credentials() -> Credentials {
    Credentials {
        access_key_id: "AKIDEXAMPLE".to_string(),
        secret_access_key: "secret".to_string(),
        session_token: None,
    }
}

#[test]
fn releases_the_key_end_to_end() {
    let captured = Arc::new(Mutex::new(None));
    let source = RecordingSource {
        captured_public_key: captured.clone(),
    };
    let kms = MockKms {
        captured_public_key: captured,
        reply: KmsReply::Release(DATA_KEY.to_vec()),
        seen: Mutex::new(Vec::new()),
    };
    let credentials = credentials();

    let released = release_bytes(&source, &kms, &params(&credentials, "20260831T000000Z"))
        .expect("the mock KMS wrapped to the attested key");
    assert_eq!(released.as_slice(), DATA_KEY);
    assert_eq!(
        &*release_master_key(&source, &kms, &params(&credentials, "20260831T000000Z")).unwrap(),
        &DATA_KEY
    );

    let seen = kms.seen.into_inner().unwrap();
    assert_eq!(seen.len(), 2);
    let first = &seen[0];
    assert_eq!(first.url, "https://kms.us-east-1.amazonaws.com/");
    assert!(first
        .headers
        .iter()
        .any(|(name, value)| name == "x-amz-target" && value == "TrentService.Decrypt"));
    assert!(first
        .headers
        .iter()
        .any(|(name, _)| name == "authorization"));
    let body: Value = serde_json::from_str(&first.body).unwrap();
    assert_eq!(body["CiphertextBlob"], CIPHERTEXT_B64);
    assert_eq!(
        body["Recipient"]["KeyEncryptionAlgorithm"],
        "RSAES_OAEP_SHA_256"
    );
    assert!(body["Recipient"]["AttestationDocument"]
        .as_str()
        .is_some_and(|document| !document.is_empty()));
}

#[test]
fn encrypted_purpose_reaches_kms_and_a_mismatch_is_not_retried_without_context() {
    struct ContextBoundKms(MockKms);
    impl KmsTransport for ContextBoundKms {
        fn post_json(
            &self,
            url: &str,
            headers: &[(String, String)],
            body: &str,
        ) -> nitro_attest::AttestResult<(u16, String)> {
            let parsed: Value = serde_json::from_str(body).unwrap();
            assert!(
                parsed.get("EncryptionContext").is_some(),
                "context must not be downgraded"
            );
            if parsed["EncryptionContext"]["neoos:purpose"] != "master-key/v1" {
                return Ok((
                    400,
                    json!({"__type":"InvalidCiphertextException"}).to_string(),
                ));
            }
            self.0.post_json(url, headers, body)
        }
    }
    let captured = Arc::new(Mutex::new(None));
    let source = RecordingSource {
        captured_public_key: captured.clone(),
    };
    let kms = ContextBoundKms(MockKms {
        captured_public_key: captured,
        reply: KmsReply::Release(DATA_KEY.to_vec()),
        seen: Mutex::new(Vec::new()),
    });
    let credentials = credentials();
    let params = params(&credentials, "20260831T000000Z");
    assert_eq!(
        release_bytes_with_context(
            &source,
            &kms,
            &params,
            &[("neoos:purpose", "master-key/v1")]
        )
        .unwrap()
        .as_slice(),
        DATA_KEY.as_slice()
    );
    assert!(release_bytes_with_context(
        &source,
        &kms,
        &params,
        &[("neoos:purpose", "transport-token/v1")]
    )
    .is_err());
    assert_eq!(kms.0.seen.lock().unwrap().len(), 1);
}

#[test]
fn pinned_key_is_sent_to_kms_and_a_different_response_key_releases_nothing() {
    const KEY_ARN: &str =
        "arn:aws:kms:us-east-1:736326664265:key/11111111-2222-3333-4444-555555555555";

    struct KeyReportingKms {
        inner: MockKms,
        response_key_id: &'static str,
    }
    impl KmsTransport for KeyReportingKms {
        fn post_json(
            &self,
            url: &str,
            headers: &[(String, String)],
            body: &str,
        ) -> nitro_attest::AttestResult<(u16, String)> {
            let request: Value = serde_json::from_str(body).unwrap();
            assert_eq!(
                request["KeyId"], KEY_ARN,
                "the request must pin the key ARN"
            );
            let (status, response) = self.inner.post_json(url, headers, body)?;
            let mut response: Value = serde_json::from_str(&response).unwrap();
            response["KeyId"] = Value::String(self.response_key_id.to_string());
            Ok((status, response.to_string()))
        }
    }

    let captured = Arc::new(Mutex::new(None));
    let source = RecordingSource {
        captured_public_key: captured.clone(),
    };
    let kms = KeyReportingKms {
        inner: MockKms {
            captured_public_key: captured,
            reply: KmsReply::Release(DATA_KEY.to_vec()),
            seen: Mutex::new(Vec::new()),
        },
        response_key_id: KEY_ARN,
    };
    let credentials = credentials();
    let release_params = params(&credentials, "20260831T000000Z");
    assert_eq!(
        release_bytes_with_context_and_key(
            &source,
            &kms,
            &release_params,
            &[("neoos:vault-id", "testnet-primary")],
            Some(KEY_ARN),
        )
        .unwrap()
        .as_slice(),
        DATA_KEY.as_slice()
    );

    let wrong_key_kms = KeyReportingKms {
        inner: kms.inner,
        response_key_id:
            "arn:aws:kms:us-east-1:736326664265:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    };
    assert_eq!(
        release_bytes_with_context_and_key(
            &source,
            &wrong_key_kms,
            &release_params,
            &[("neoos:vault-id", "testnet-primary")],
            Some(KEY_ARN),
        )
        .unwrap_err(),
        "kms decrypt: response key id did not match the pinned key"
    );
    assert_eq!(wrong_key_kms.inner.seen.lock().unwrap().len(), 2);
}

#[test]
fn a_non_200_from_kms_is_an_error() {
    let captured = Arc::new(Mutex::new(None));
    let source = RecordingSource {
        captured_public_key: captured.clone(),
    };
    let kms = MockKms {
        captured_public_key: captured,
        reply: KmsReply::Status(
            400,
            json!({"__type":"AccessDeniedException","message":"no"}),
        ),
        seen: Mutex::new(Vec::new()),
    };
    let credentials = credentials();
    let error = release_bytes(&source, &kms, &params(&credentials, "20260831T000000Z"))
        .expect_err("a KMS rejection is not a release");
    assert!(
        error.contains("kms decrypt: HTTP 400 AccessDeniedException"),
        "{error}"
    );
}

#[test]
fn master_key_pins_the_32_byte_length() {
    let captured = Arc::new(Mutex::new(None));
    let source = RecordingSource {
        captured_public_key: captured.clone(),
    };
    let short_key = vec![9u8; 16];
    let kms = ShortKms {
        captured_public_key: captured,
        plaintext: short_key.clone(),
    };
    let credentials = credentials();
    assert_eq!(
        release_bytes(&source, &kms, &params(&credentials, "20260831T000000Z"))
            .unwrap()
            .as_slice(),
        short_key.as_slice()
    );
    let error = release_master_key(&source, &kms, &params(&credentials, "20260831T000000Z"))
        .expect_err("a 16-byte release is not a master key");
    assert!(
        error.contains("released 16 bytes; expected the 32-byte master key"),
        "{error}"
    );
}

/// Acts as KMS but wraps a plaintext of the test's choosing, to prove the
/// length pin on [`release_master_key`].
struct ShortKms {
    captured_public_key: Arc<Mutex<Option<Vec<u8>>>>,
    plaintext: Vec<u8>,
}

impl KmsTransport for ShortKms {
    fn post_json(
        &self,
        _url: &str,
        _headers: &[(String, String)],
        _body: &str,
    ) -> nitro_attest::AttestResult<(u16, String)> {
        let public_key = self.captured_public_key.lock().unwrap().clone().unwrap();
        let spki = PublicEncryptingKey::from_der(&public_key).unwrap();
        // Wrap with a proper 32-byte CEK; the released plaintext itself is the
        // short content, which is exactly the case release_master_key must refuse.
        Ok((
            200,
            build_kms_response(&spki, &WRAP_CEK, &self.plaintext).to_string(),
        ))
    }
}

#[test]
fn a_transport_failure_is_surfaced() {
    struct Broken;
    impl KmsTransport for Broken {
        fn post_json(
            &self,
            _url: &str,
            _headers: &[(String, String)],
            _body: &str,
        ) -> nitro_attest::AttestResult<(u16, String)> {
            Err("connection refused".to_string())
        }
    }
    struct Never;
    impl AttestationSource for Never {
        fn attest(
            &self,
            _nonce: Option<&[u8]>,
            _user_data: Option<&[u8]>,
            _public_key: Option<&[u8]>,
        ) -> nitro_attest::AttestResult<Vec<u8>> {
            Ok(vec![])
        }
    }
    let credentials = credentials();
    let error = release_bytes(&Never, &Broken, &params(&credentials, "20260831T000000Z"))
        .expect_err("a broken transport cannot release");
    assert_eq!(error, "connection refused");
}

// The production source is imported inside each OS-gated test: a file-level
// import is unused on whichever OS the other test is compiled out of, and
// clippy -D warnings rejects it (CI and the Nitro parent are Linux).
#[test]
#[cfg(not(target_os = "linux"))]
fn the_production_source_fails_closed_off_the_enclave() {
    use nitro_attest::release::NsmAttestation;

    let error = NsmAttestation
        .attest(None, None, None)
        .expect_err("there is no NSM device here");
    assert!(
        error.contains("only available inside a Linux AWS Nitro enclave"),
        "{error}"
    );
}

#[test]
#[cfg(target_os = "linux")]
fn the_production_source_fails_closed_without_the_nsm_device() {
    use nitro_attest::release::NsmAttestation;

    // Inside an enclave the device exists and this is not the case under test.
    if std::path::Path::new("/dev/nsm").exists() {
        return;
    }
    let error = NsmAttestation
        .attest(None, None, None)
        .expect_err("a Linux host without /dev/nsm cannot attest");
    assert!(error.contains("open /dev/nsm"), "{error}");
}
