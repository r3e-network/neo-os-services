//! KMS Decrypt request construction for the Nitro Recipient flow, plus the
//! response parsing — the counterpart of main.go's runKMSDecrypt KMS call
//! (main.go itself delegates the wire protocol to the AWS SDK; this crate
//! hand-rolls it to keep the enclave image dependency-light).
//!
//! The signed request is returned as pure data ([`SignedRequest`]) so callers
//! execute it with whatever HTTP client they run: the CLI bin uses
//! reqwest::blocking, the future enclave host can use an async client without
//! re-signing logic.
//!
//! Deliberate divergences from the Go tool (documented in the crate root):
//! AWS credentials come from env only; error strings surface the raw
//! status/type instead of the SDK's multi-line operation-error chatter.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use hmac::{Hmac, Mac};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::AttestResult;

type HmacSha256 = Hmac<Sha256>;

/// Static AWS credentials — the enclave passes them through env vars.
pub struct Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

pub fn credentials_from_env() -> AttestResult<Credentials> {
    let access_key_id = std::env::var("AWS_ACCESS_KEY_ID")
        .map_err(|_| "AWS_ACCESS_KEY_ID is not set".to_string())?;
    let secret_access_key = std::env::var("AWS_SECRET_ACCESS_KEY")
        .map_err(|_| "AWS_SECRET_ACCESS_KEY is not set".to_string())?;
    if access_key_id.is_empty() || secret_access_key.is_empty() {
        return Err("AWS credentials are empty".to_string());
    }
    let session_token = std::env::var("AWS_SESSION_TOKEN")
        .ok()
        .filter(|t| !t.is_empty());
    Ok(Credentials {
        access_key_id,
        secret_access_key,
        session_token,
    })
}

/// A fully signed HTTP request, ready to execute.
pub struct SignedRequest {
    pub url: String,
    /// (name, value) pairs in the order they were signed (lowercase names).
    pub headers: Vec<(String, String)>,
    pub body: String,
}

pub fn utc_amz_date_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is before the Unix epoch")
        .as_secs();
    format_amz_date(secs)
}

/// 20260831T123000Z-style ISO-8601 basic timestamp (SigV4 x-amz-date form).
pub fn format_amz_date(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let sod = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        year,
        month,
        day,
        sod / 3_600,
        (sod % 3_600) / 60,
        sod % 60
    )
}

/// Days-since-epoch to (year, month, day) in the proleptic Gregorian calendar
/// (Howard Hinnant's civil_from_days). Avoids a chrono dependency just for
/// date math.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn sha256_hex(data: &[u8]) -> String {
    hex_encode(
        {
            let mut hasher = Sha256::new();
            hasher.update(data);
            hasher.finalize()
        }
        .as_slice(),
    )
}

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

pub(crate) fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// Builds the KMS Decrypt call for a Nitro Recipient: the body carries the
/// CiphertextBlob plus the Recipient (attestation document + the key
/// encryption algorithm KMS must re-wrap the plaintext with). Object keys are
/// inserted in sorted order — serde_json runs with `preserve_order` in this
/// workspace, so insertion order is wire order.
pub fn build_kms_decrypt_request(
    region: &str,
    credentials: &Credentials,
    amz_date: &str,
    ciphertext_b64: &str,
    attestation_document: &[u8],
) -> AttestResult<SignedRequest> {
    if region.is_empty() {
        return Err("region is required".to_string());
    }
    if amz_date.len() < 8 || !amz_date.ends_with('Z') {
        return Err("amz date must be YYYYMMDDTHHMMSSZ".to_string());
    }

    let host = format!("kms.{region}.amazonaws.com");
    let mut recipient = Map::new();
    recipient.insert(
        "AttestationDocument".to_string(),
        Value::String(BASE64.encode(attestation_document)),
    );
    recipient.insert(
        "KeyEncryptionAlgorithm".to_string(),
        Value::String("RSAES_OAEP_SHA_256".to_string()),
    );
    let mut body_map = Map::new();
    body_map.insert(
        "CiphertextBlob".to_string(),
        Value::String(ciphertext_b64.to_string()),
    );
    body_map.insert("Recipient".to_string(), Value::Object(recipient));
    let body = Value::Object(body_map).to_string();

    let datestamp = &amz_date[..8];
    let mut headers: Vec<(String, String)> = vec![
        (
            "content-type".to_string(),
            "application/x-amz-json-1.1".to_string(),
        ),
        ("host".to_string(), host.clone()),
        ("x-amz-date".to_string(), amz_date.to_string()),
    ];
    if let Some(token) = &credentials.session_token {
        headers.push(("x-amz-security-token".to_string(), token.clone()));
    }
    headers.push((
        "x-amz-target".to_string(),
        "TrentService.Decrypt".to_string(),
    ));

    let canonical_headers: String = headers
        .iter()
        .map(|(name, value)| format!("{name}:{value}\n"))
        .collect();
    let signed_headers: String = headers
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>()
        .join(";");

    let canonical_request = format!(
        "POST\n/\n\n{canonical_headers}{signed_headers}\n{}",
        sha256_hex(body.as_bytes())
    );
    let scope = format!("{datestamp}/{region}/kms/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );

    let k_date = hmac_sha256(
        format!("AWS4{}", credentials.secret_access_key).as_bytes(),
        datestamp.as_bytes(),
    );
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, b"kms");
    let k_signing = hmac_sha256(&k_service, b"aws4_request");
    let signature = hex_encode(&hmac_sha256(&k_signing, string_to_sign.as_bytes()));

    headers.push((
        "authorization".to_string(),
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
            credentials.access_key_id, scope, signed_headers, signature
        ),
    ));

    Ok(SignedRequest {
        url: format!("https://{host}/"),
        headers,
        body,
    })
}

/// Parses the KMS Decrypt JSON response, returning the CiphertextForRecipient
/// blob (base64) that decrypt_cms_enveloped_data consumes.
pub fn parse_kms_decrypt_response(status: u16, body: &str) -> AttestResult<String> {
    if status != 200 {
        // Best-effort AWS error shape; a non-JSON error body surfaces
        // verbatim after the status.
        let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
        let typ = parsed["__type"].as_str().unwrap_or("unknown");
        let message = parsed["message"].as_str().unwrap_or(body);
        return Err(format!("kms decrypt: HTTP {status} {typ}: {message}"));
    }
    let parsed: Value =
        serde_json::from_str(body).map_err(|e| format!("kms decrypt: parse response: {e}"))?;
    let ciphertext = parsed["CiphertextForRecipient"].as_str().unwrap_or("");
    if ciphertext.is_empty() {
        return Err(
            "kms returned an empty CiphertextForRecipient (Recipient not honored?)".to_string(),
        );
    }
    Ok(ciphertext.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 2024-02-29 (leap year) and 2000-02-29 (century leap year).
        assert_eq!(civil_from_days(1_709_164_800 / 86_400), (2024, 2, 29));
        assert_eq!(civil_from_days(951_782_400 / 86_400), (2000, 2, 29));
        assert_eq!(format_amz_date(0), "19700101T000000Z");
        assert_eq!(format_amz_date(1_788_134_400), "20260831T000000Z");
    }

    /// Golden signature cross-checked against an independent Node
    /// implementation of the AWS SigV4 spec (Node's crypto library, not this
    /// crate's HMAC chain).
    #[test]
    fn sigv4_known_signature() {
        let credentials = Credentials {
            access_key_id: "AKIDEXAMPLE".to_string(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".to_string(),
            session_token: None,
        };
        let request = build_kms_decrypt_request(
            "us-east-1",
            &credentials,
            "20260831T000000Z",
            "AQEB",
            b"attestation-doc-bytes",
        )
        .unwrap();

        assert_eq!(request.url, "https://kms.us-east-1.amazonaws.com/");
        assert_eq!(request.body, "{\"CiphertextBlob\":\"AQEB\",\"Recipient\":{\"AttestationDocument\":\"YXR0ZXN0YXRpb24tZG9jLWJ5dGVz\",\"KeyEncryptionAlgorithm\":\"RSAES_OAEP_SHA_256\"}}");
        let names: Vec<&str> = request.headers.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            [
                "content-type",
                "host",
                "x-amz-date",
                "x-amz-target",
                "authorization"
            ]
        );
        let authorization = &request.headers[4].1;
        assert_eq!(
            authorization,
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260831/us-east-1/kms/aws4_request, \
             SignedHeaders=content-type;host;x-amz-date;x-amz-target, \
             Signature=64796ad3ff2af1bf012df2e2ec80380d79db6adce4e2ebc39225e7a96b409ec4"
        );
    }

    #[test]
    fn sigv4_signs_session_token() {
        let credentials = Credentials {
            access_key_id: "AKIDEXAMPLE".to_string(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".to_string(),
            session_token: Some("tok".to_string()),
        };
        let request = build_kms_decrypt_request(
            "eu-west-1",
            &credentials,
            "20260831T000000Z",
            "AQEB",
            b"doc",
        )
        .unwrap();
        let names: Vec<&str> = request.headers.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            [
                "content-type",
                "host",
                "x-amz-date",
                "x-amz-security-token",
                "x-amz-target",
                "authorization"
            ]
        );
        assert!(request.headers[3].1.contains("tok"));
        // SignedHeaders must list the token header in sorted position.
        assert!(request.headers[5].1.contains(
            "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target"
        ));
    }

    #[test]
    fn parses_decrypt_response() {
        let ok = parse_kms_decrypt_response(
            200,
            "{\"CiphertextForRecipient\":\"YWJj\",\"KeyId\":\"arn:x\",\"Plaintext\":null}",
        )
        .unwrap();
        assert_eq!(ok, "YWJj");

        // Missing CiphertextForRecipient = Recipient was not honored.
        let err = parse_kms_decrypt_response(200, "{\"KeyId\":\"arn:x\"}").unwrap_err();
        assert_eq!(
            err,
            "kms returned an empty CiphertextForRecipient (Recipient not honored?)"
        );

        let err = parse_kms_decrypt_response(
            400,
            "{\"__type\":\"AccessDeniedException\",\"message\":\"not authorized\"}",
        )
        .unwrap_err();
        assert_eq!(
            err,
            "kms decrypt: HTTP 400 AccessDeniedException: not authorized"
        );

        // Non-JSON error body surfaces verbatim after the status/type.
        let err = parse_kms_decrypt_response(503, "upstream timeout").unwrap_err();
        assert_eq!(err, "kms decrypt: HTTP 503 unknown: upstream timeout");

        let err = parse_kms_decrypt_response(200, "not json").unwrap_err();
        assert!(err.starts_with("kms decrypt: parse response:"));
    }
}
