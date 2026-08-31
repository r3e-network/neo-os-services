//! The attestation-gated release orchestration: the full Nitro Recipient flow
//! in one call — ephemeral single-use RSA keypair, its public key bound into a
//! fresh NSM attestation document, KMS `Decrypt` with the Recipient, and the
//! local CMS open of the returned CiphertextForRecipient.
//!
//! This is the code path `deploy/nitro/KMS-ATTESTATION-DESIGN.md` calls "the
//! enclave kms-decrypts it in-TEE": every step runs inside the enclave, and the
//! released plaintext exists only in the caller's memory (the private key is
//! dropped at return). The nsm-attest-rs CLI walks the same steps by hand for
//! its Go-parity CLI contract; the enclave host and the custody service call
//! [`release_bytes`] / [`release_master_key`] instead of shelling out.
//!
//! The two seams are traits so unit tests can exercise the whole flow without
//! an NSM device or a live KMS:
//!
//! * [`AttestationSource`] — production [`NsmAttestation`] talks to /dev/nsm
//!   (and fails closed everywhere else, per `attest_unsupported.go`).
//! * [`KmsTransport`] — production [`HttpKmsTransport`] is reqwest blocking
//!   with end-to-end TLS to the real `kms.<region>.amazonaws.com` hostname. It
//!   honors `HTTPS_PROXY`, which is exactly the enclave's no-MITM egress
//!   posture (`host-egress-proxy.mjs` allow-lists the KMS hostname; the proxy
//!   sees only the CONNECT target, never plaintext).

use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rsa::pkcs8::EncodePublicKey;
use rsa::RsaPrivateKey;

use crate::{cms, kms, AttestResult};

/// Where attestation documents come from. The enclave host and the custody
/// service take this as a dependency rather than reaching for /dev/nsm
/// directly, so a test can substitute a source that returns a canned document.
/// `Send + Sync`: every consumer shares one instance across request threads.
pub trait AttestationSource: Send + Sync {
    fn attest(
        &self,
        nonce: Option<&[u8]>,
        user_data: Option<&[u8]>,
        public_key: Option<&[u8]>,
    ) -> AttestResult<Vec<u8>>;
}

/// The real thing: the NSM driver. Off the enclave this fails closed with the
/// same message the Go tool's attest_unsupported.go produces.
pub struct NsmAttestation;

impl AttestationSource for NsmAttestation {
    fn attest(
        &self,
        nonce: Option<&[u8]>,
        user_data: Option<&[u8]>,
        public_key: Option<&[u8]>,
    ) -> AttestResult<Vec<u8>> {
        crate::nsm::attest(nonce, user_data, public_key)
    }
}

/// Executes a signed KMS request and returns the raw HTTP status and body. The
/// response's JSON is parsed (and its status judged) by
/// [`kms::parse_kms_decrypt_response`], so the trait stays transport-shaped.
/// `Send + Sync`: every consumer shares one instance across request threads.
pub trait KmsTransport: Send + Sync {
    fn post_json(
        &self,
        url: &str,
        headers: &[(String, String)],
        body: &str,
    ) -> AttestResult<(u16, String)>;
}

/// The production transport. `HTTPS_PROXY` is honored by reqwest's default
/// environment handling: inside the enclave that is the in-enclave socat →
/// host CONNECT allow-list bridge, and TLS is still end-to-end to the real
/// KMS hostname.
pub struct HttpKmsTransport;

impl KmsTransport for HttpKmsTransport {
    fn post_json(
        &self,
        url: &str,
        headers: &[(String, String)],
        body: &str,
    ) -> AttestResult<(u16, String)> {
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| format!("kms decrypt: build http client: {error}"))?;
        let mut builder = client.post(url);
        for (name, value) in headers {
            builder = builder.header(name, value);
        }
        let response = builder
            .body(body.to_owned())
            .send()
            .map_err(|error| format!("kms decrypt: {error}"))?;
        let status = response.status().as_u16();
        let text = response
            .text()
            .map_err(|error| format!("kms decrypt: {error}"))?;
        Ok((status, text))
    }
}

/// Everything a release needs besides the seams. `amz_date` is a parameter
/// rather than a clock read so a test can drive the signing deterministically.
pub struct ReleaseParams<'a> {
    pub region: &'a str,
    pub credentials: &'a kms::Credentials,
    pub ciphertext_b64: &'a str,
    pub amz_date: &'a str,
}

/// Run the full release flow and return the plaintext KMS released to this
/// enclave — the data key bytes, at whatever length the caller's ciphertext
/// wraps. Secret callers should reach for [`release_master_key`], which pins
/// the length to the vault's 32-byte key.
pub fn release_bytes(
    source: &dyn AttestationSource,
    transport: &dyn KmsTransport,
    params: &ReleaseParams<'_>,
) -> AttestResult<Vec<u8>> {
    let mut rng = rsa::rand_core::OsRng;
    let priv_key =
        RsaPrivateKey::new(&mut rng, 2048).map_err(|error| format!("generate RSA key: {error}"))?;
    let spki = priv_key
        .to_public_key()
        .to_public_key_der()
        .map_err(|error| format!("marshal public key: {error}"))?;
    let document = source.attest(None, None, Some(spki.as_bytes()))?;
    let signed = kms::build_kms_decrypt_request(
        params.region,
        params.credentials,
        params.amz_date,
        params.ciphertext_b64,
        &document,
    )?;
    let (status, body) = transport.post_json(&signed.url, &signed.headers, &signed.body)?;
    let ctb_b64 = kms::parse_kms_decrypt_response(status, &body)?;
    let cms_der = BASE64
        .decode(ctb_b64.as_bytes())
        .map_err(|error| format!("kms decrypt: decode CiphertextForRecipient: {error}"))?;
    cms::decrypt_cms_enveloped_data(&cms_der, &priv_key)
}

/// [`release_bytes`] pinned to the custody vault's 32-byte master key.
pub fn release_master_key(
    source: &dyn AttestationSource,
    transport: &dyn KmsTransport,
    params: &ReleaseParams<'_>,
) -> AttestResult<[u8; 32]> {
    let plaintext = release_bytes(source, transport, params)?;
    <[u8; 32]>::try_from(plaintext.as_slice()).map_err(|_| {
        format!(
            "kms released {} bytes; expected the 32-byte master key",
            plaintext.len()
        )
    })
}
