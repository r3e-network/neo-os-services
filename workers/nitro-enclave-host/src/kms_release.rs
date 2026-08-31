//! The production KMS release seam: `nitro_attest::release_bytes` over the
//! NSM attestation source and the signed-HTTPS transport. The recipient
//! attestation is generated fresh per release, so the data key leaves KMS
//! only for the enclave whose measurement the key policy pins — the same
//! flow the Node server reached through the `kms-decrypt` CLI helper, minus
//! the process boundary.

use nitro_attest::kms::{self, Credentials};
use nitro_attest::release::{self, HttpKmsTransport, NsmAttestation};

use crate::state::{KmsReleaseParams, KmsReleaser};

pub struct ProductionKms {
    source: Box<dyn release::AttestationSource>,
    transport: Box<dyn release::KmsTransport>,
}

impl ProductionKms {
    pub fn new() -> Self {
        ProductionKms {
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

impl KmsReleaser for ProductionKms {
    fn decrypt(&self, params: &KmsReleaseParams) -> Result<Vec<u8>, String> {
        let credentials = Credentials {
            access_key_id: params.access_key_id.clone(),
            secret_access_key: params.secret_access_key.clone(),
            session_token: params.session_token.clone(),
        };
        let amz_date = kms::utc_amz_date_now();
        release::release_bytes(
            &*self.source,
            &*self.transport,
            &release::ReleaseParams {
                region: &params.region,
                credentials: &credentials,
                ciphertext_b64: &params.ciphertext_b64,
                amz_date: &amz_date,
            },
        )
    }
}

#[cfg(test)]
#[path = "../tests/unit/kms_release.rs"]
mod tests;
