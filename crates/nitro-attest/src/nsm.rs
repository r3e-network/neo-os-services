//! The only module that touches /dev/nsm — the Rust counterpart of
//! attest_linux.go + attest_unsupported.go.
//!
//! `aws-nitro-enclaves-nsm-api` issues the raw ioctl calls through /dev/nsm,
//! so the real implementation only compiles on Linux and the crate's
//! dependency on it is target-gated in Cargo.toml. Every other platform gets
//! the fail-closed stub: an attestation document is the root of trust for KMS
//! key release, so a build outside a Nitro enclave must refuse rather than
//! ever return something that could be mistaken for one.
//!
//! `None`/empty handling mirrors the Go tool: main.go passes nil for absent
//! fields and hf/nsm omits empty fields, so `None` and `Some(&[])` produce the
//! same document here.

#[cfg(target_os = "linux")]
pub fn attest(
    nonce: Option<&[u8]>,
    user_data: Option<&[u8]>,
    public_key: Option<&[u8]>,
) -> AttestResult<Vec<u8>> {
    use aws_nitro_enclaves_nsm_api::api::{Request, Response};
    use aws_nitro_enclaves_nsm_api::driver;
    use serde_bytes::ByteBuf;

    let fd = driver::nsm_init();
    if fd < 0 {
        return Err(format!(
            "open /dev/nsm: nsm_init returned {fd} (not running inside a Nitro enclave?)"
        ));
    }
    let request = Request::Attestation {
        nonce: nonce.map(|v| ByteBuf::from(v.to_vec())),
        user_data: user_data.map(|v| ByteBuf::from(v.to_vec())),
        public_key: public_key.map(|v| ByteBuf::from(v.to_vec())),
    };
    let response = driver::nsm_process_request(fd, request);
    driver::nsm_exit(fd);

    match response {
        Response::Attestation { document } => {
            if document.is_empty() {
                Err("nsm returned an empty attestation document".to_string())
            } else {
                Ok(document)
            }
        }
        // Go prints the error code as its string form; the Rust enum's Debug
        // rendering is the variant name (InvalidArgument, InvalidIndex, ...),
        // so the message shape "nsm error code: <code>" is preserved.
        Response::Error(code) => Err(format!("nsm error code: {code:?}")),
        _ => Err("nsm: unexpected response type".to_string()),
    }
}

#[cfg(not(target_os = "linux"))]
pub fn attest(
    _nonce: Option<&[u8]>,
    _user_data: Option<&[u8]>,
    _public_key: Option<&[u8]>,
) -> AttestResult<Vec<u8>> {
    Err("NSM attestation is only available inside a Linux AWS Nitro enclave".to_string())
}

use crate::AttestResult;
