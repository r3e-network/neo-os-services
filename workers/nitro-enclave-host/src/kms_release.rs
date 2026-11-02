//! The production KMS release seam: `nitro_attest::release_bytes` over the
//! NSM attestation source and the signed-HTTPS transport. The recipient
//! attestation is generated fresh per release, so the data key leaves KMS
//! only for the enclave whose measurement the key policy pins — the same
//! flow the Node server reached through the `kms-decrypt` CLI helper, minus
//! the process boundary.

use nitro_attest::kms::{self, Credentials};
use nitro_attest::release::{self, HttpKmsTransport, NsmAttestation};
use zeroize::Zeroizing;

use crate::state::{KmsReleaseParams, KmsReleaser};

pub struct ProductionKms {
    host_mode: bool,
    source: Box<dyn release::AttestationSource>,
    transport: Box<dyn release::KmsTransport>,
}

impl ProductionKms {
    pub fn new() -> Self {
        ProductionKms {
            host_mode: false,
            source: Box::new(NsmAttestation),
            transport: Box::new(HttpKmsTransport),
        }
    }

    /// Host mode (`MORPHEUS_ATTESTED_BOOT=allow`, testnet-only): releases run
    /// through a plain KMS Decrypt with no Recipient attestation. The
    /// ciphertext's binding comes from its encryption context and the pinned
    /// key id; the key policy must grant plain `kms:Decrypt` to the host's
    /// instance role without attestation conditions.
    pub fn new_host_mode() -> Self {
        ProductionKms {
            host_mode: true,
            source: Box::new(NsmAttestation),
            transport: Box::new(HttpKmsTransport),
        }
    }
}

impl Default for ProductionKms {
    fn default() -> Self {
        Self::new()
    }
}

/// The component half of every frontier encryption context. Custody uses
/// `custody` for the same pair (`neo-signer/src/provision.rs`), so a custody
/// envelope cannot be replayed into the frontier or the other way round.
pub const KMS_CONTEXT_COMPONENT: &str = "frontier";

impl KmsReleaser for ProductionKms {
    fn decrypt(&self, params: &KmsReleaseParams) -> Result<Zeroizing<Vec<u8>>, String> {
        let credentials = Credentials {
            access_key_id: params.access_key_id.clone(),
            secret_access_key: params.secret_access_key.clone(),
            session_token: params.session_token.clone(),
        };
        let amz_date = kms::utc_amz_date_now();
        // The encryption context and the key pin are the two things the
        // untrusted parent supplies neither of. Without them a recipient
        // attestation proves only WHO is decrypting, never WHAT or under
        // which key — so a host that can encrypt under any CMK its instance
        // role reaches could substitute every secret released here.
        let context = [
            ("neoos:component", KMS_CONTEXT_COMPONENT),
            ("neoos:purpose", params.purpose.as_str()),
            ("neoos:network", params.network.as_str()),
        ];
        if self.host_mode {
            // Host mode: no NSM device, so the release is a plain KMS Decrypt
            // bound by the encryption context and the pinned key id. Testnet
            // keys only — attestation-gated keys refuse this server-side.
            return release::release_bytes_plain(
                &*self.transport,
                &release::ReleaseParams {
                    region: &params.region,
                    credentials: &credentials,
                    ciphertext_b64: &params.ciphertext_b64,
                    amz_date: &amz_date,
                },
                &context,
                params.key_arn.as_deref(),
            );
        }
        release::release_bytes_with_context_and_key(
            &*self.source,
            &*self.transport,
            &release::ReleaseParams {
                region: &params.region,
                credentials: &credentials,
                ciphertext_b64: &params.ciphertext_b64,
                amz_date: &amz_date,
            },
            &context,
            params.key_arn.as_deref(),
        )
    }
}

#[cfg(test)]
#[path = "../tests/unit/kms_release.rs"]
mod tests;
