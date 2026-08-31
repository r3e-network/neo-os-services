//! nsm-attest-rs: the Rust port of deploy/nitro/nsm-attest (main.go).
//!
//! Runs INSIDE the Nitro enclave. Two subcommands, identical CLI and stdout
//! JSON shapes to the Go tool so the two can be A/B compared on a Linux box:
//!
//!  - attest (default, also when invoked with a leading flag):
//!    Prints {"ok":true,"attestation_b64":"...","document_len":N}.
//!  - kms-decrypt:
//!    Attestation-gated KMS key release: ephemeral RSA-2048 keypair, its
//!    SPKI DER bound into a fresh attestation document, KMS Decrypt with a
//!    Nitro Recipient, CMS EnvelopedData decrypt of the
//!    CiphertextForRecipient. Prints {"ok":true,"plaintext_b64":"..."}.
//!
//! Errors print {"error":...,"ok":false} on stdout and exit 1; flag errors
//! print to stderr and exit 2, mirroring Go flag.ExitOnError. JSON object
//! keys are emitted in the sorted order Go's map marshaling produces (this
//! workspace pins serde_json to preserve_order, so insertion order is wire
//! order).

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use nitro_attest::{cms::decrypt_cms_enveloped_data, kms, nsm};
use rsa::pkcs8::EncodePublicKey;
use rsa::RsaPrivateKey;
use serde_json::{Map, Value};
use std::collections::HashMap;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(first) = args.first() {
        match first.as_str() {
            "attest" => return run_attest(&args[1..]),
            "kms-decrypt" => return run_kms_decrypt(&args[1..]),
            _ => {}
        }
    }
    // No subcommand (or a leading flag / anything else): preserve the
    // original behavior.
    run_attest(&args);
}

fn emit_json(fields: &[(&str, Value)], code: i32) -> ! {
    let mut map = Map::new();
    for (name, value) in fields {
        map.insert((*name).to_string(), value.clone());
    }
    println!("{}", Value::Object(map));
    std::process::exit(code);
}

fn fail(msg: &str) -> ! {
    emit_json(
        &[
            ("error", Value::String(msg.to_string())),
            ("ok", Value::Bool(false)),
        ],
        1,
    )
}

fn flag_error(msg: &str) -> ! {
    eprintln!("{msg}");
    // Go flag.ExitOnError: usage to stderr, exit status 2.
    std::process::exit(2);
}

/// Go-flag-style parser for the tool's simple `-name value` / `-name=value`
/// flags; `--name` is accepted as Go does. Unknown flags and missing values
/// reproduce the Go error strings. Positional arguments stop parsing and are
/// ignored (Go collects them in fs.Args(), which main.go never reads).
fn parse_flags(args: &[String], defs: &[(&str, &str)]) -> HashMap<String, String> {
    let mut values: HashMap<String, String> = defs
        .iter()
        .map(|(name, default)| (name.to_string(), default.to_string()))
        .collect();
    let mut i = 0usize;
    while i < args.len() {
        let arg = &args[i];
        let Some(stripped) = arg.strip_prefix("--").or_else(|| arg.strip_prefix('-')) else {
            break;
        };
        let (key, inline_value) = match stripped.split_once('=') {
            Some((k, v)) => (k.to_string(), Some(v.to_string())),
            None => (stripped.to_string(), None),
        };
        if !defs.iter().any(|(name, _)| *name == key) {
            flag_error(&format!("flag provided but not defined: -{key}"));
        }
        let value = match inline_value {
            Some(v) => v,
            None => {
                i += 1;
                if i >= args.len() {
                    flag_error(&format!("flag needs an argument: -{key}"));
                }
                args[i].clone()
            }
        };
        values.insert(key, value);
        i += 1;
    }
    values
}

fn run_attest(args: &[String]) {
    let flags = parse_flags(
        args,
        &[("nonce", ""), ("user-data", ""), ("public-key", "")],
    );
    let nonce = decode_hex("nonce", &flags["nonce"]);
    let user_data = decode_hex("user-data", &flags["user-data"]);
    let public_key = decode_hex("public-key", &flags["public-key"]);

    let doc = match nsm::attest(
        nonce.as_deref(),
        user_data.as_deref(),
        public_key.as_deref(),
    ) {
        Ok(doc) => doc,
        Err(err) => fail(&err),
    };

    emit_json(
        &[
            ("attestation_b64", Value::String(BASE64.encode(&doc))),
            ("document_len", Value::from(doc.len() as u64)),
            ("ok", Value::Bool(true)),
        ],
        0,
    );
}

fn run_kms_decrypt(args: &[String]) {
    let flags = parse_flags(args, &[("region", "us-east-1"), ("ciphertext", "")]);
    let ciphertext_b64 = flags["ciphertext"].clone();
    if ciphertext_b64.is_empty() {
        fail("-ciphertext is required");
    }
    // Validation only: the signed request carries the base64 string itself
    // (the AWS JSON API expects CiphertextBlob encoded), but the Go tool
    // rejects invalid base64 up front and so do we.
    if let Err(err) = BASE64.decode(ciphertext_b64.as_bytes()) {
        fail(&format!(
            "invalid -ciphertext base64: {}",
            go_base64_error(&err)
        ));
    }

    // a. Ephemeral RSA-2048 keypair (single use, never leaves the enclave).
    let mut rng = rsa::rand_core::OsRng;
    let priv_key = match RsaPrivateKey::new(&mut rng, 2048) {
        Ok(key) => key,
        Err(err) => fail(&format!("generate RSA key: {err}")),
    };

    // b. DER SubjectPublicKeyInfo of the RSA public key.
    let spki = match priv_key.to_public_key().to_public_key_der() {
        Ok(doc) => doc,
        Err(err) => fail(&format!("marshal public key: {err}")),
    };

    // c. Attestation document binding that public key.
    let attestation_doc = match nsm::attest(None, None, Some(spki.as_bytes())) {
        Ok(doc) => doc,
        Err(err) => fail(&err),
    };

    // d. KMS Decrypt with a Nitro Recipient.
    let credentials = match kms::credentials_from_env() {
        Ok(c) => c,
        Err(err) => fail(&format!("kms decrypt: {err}")),
    };
    let signed = match kms::build_kms_decrypt_request(
        &flags["region"],
        &credentials,
        &kms::utc_amz_date_now(),
        &ciphertext_b64,
        &attestation_doc,
    ) {
        Ok(s) => s,
        Err(err) => fail(&format!("kms decrypt: {err}")),
    };

    let client = reqwest::blocking::Client::new();
    let mut builder = client.post(&signed.url);
    for (name, value) in &signed.headers {
        builder = builder.header(name, value);
    }
    let response = match builder.body(signed.body.clone()).send() {
        Ok(response) => response,
        Err(err) => fail(&format!("kms decrypt: {err}")),
    };
    let status = response.status().as_u16();
    let body = match response.text() {
        Ok(body) => body,
        Err(err) => fail(&format!("kms decrypt: {err}")),
    };
    let ctb_b64 = match kms::parse_kms_decrypt_response(status, &body) {
        Ok(ct) => ct,
        Err(err) => fail(&err),
    };
    let cms_der = match BASE64.decode(ctb_b64.as_bytes()) {
        Ok(der) => der,
        Err(err) => fail(&format!(
            "kms decrypt: decode CiphertextForRecipient: {}",
            go_base64_error(&err)
        )),
    };

    // e. Decrypt the CMS EnvelopedData locally with the RSA private key.
    let plaintext = match decrypt_cms_enveloped_data(&cms_der, &priv_key) {
        Ok(plaintext) => plaintext,
        Err(err) => fail(&format!("decrypt CiphertextForRecipient: {err}")),
    };

    // f. Emit the recovered plaintext.
    emit_json(
        &[
            ("ok", Value::Bool(true)),
            ("plaintext_b64", Value::String(BASE64.encode(&plaintext))),
        ],
        0,
    );
}

/// Empty string means "flag not given" and yields None, like main.go's
/// decodeHex returning nil. Invalid bytes reproduce Go encoding/hex messages.
fn decode_hex(label: &str, value: &str) -> Option<Vec<u8>> {
    if value.is_empty() {
        return None;
    }
    let bytes = value.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        fail(&format!(
            "invalid {label} hex: encoding/hex: odd length hex string"
        ));
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        out.push(hex_val(label, bytes[i]) << 4 | hex_val(label, bytes[i + 1]));
        i += 2;
    }
    Some(out)
}

fn hex_val(label: &str, byte: u8) -> u8 {
    match byte {
        b'0'..=b'9' => byte - b'0',
        b'a'..=b'f' => byte - b'a' + 10,
        b'A'..=b'F' => byte - b'A' + 10,
        _ => fail(&format!(
            "invalid {label} hex: encoding/hex: invalid byte: U+{:04X} '{}'",
            byte, byte as char
        )),
    }
}

/// Go encoding/base64 reports "illegal base64 data at input byte N"; map the
/// Rust crate's structured errors onto that shape.
fn go_base64_error(err: &base64::DecodeError) -> String {
    match err {
        base64::DecodeError::InvalidByte(offset, _) => {
            format!("illegal base64 data at input byte {offset}")
        }
        base64::DecodeError::InvalidLength(offset) => {
            format!("illegal base64 data at input byte {offset}")
        }
        base64::DecodeError::InvalidLastSymbol(offset, _) => {
            format!("illegal base64 data at input byte {offset}")
        }
        base64::DecodeError::InvalidPadding => "illegal base64 data".to_string(),
    }
}
