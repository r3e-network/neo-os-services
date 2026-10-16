//! The enclave's own proof: the boot guard and the PCR0 report.
//!
//! An attested-boot deployment refuses to serve until the process has shown
//! that it can produce a fresh NSM attestation — which only a real enclave
//! can. A process on the host gets no document, and a broken or spoofed NSM
//! yields one that does not parse, so the boot fails closed (§7 step 3's
//! precondition, task #14's boot guard).
//!
//! The boot guard does not carry the *pin* inside the image, because it
//! cannot: PCR0 measures the rootfs, so baking a pin into the rootfs changes
//! the PCR0 it pins. The authoritative identity gate is the KMS key policy —
//! `kms:RecipientAttestation:ImageSha384` pinned to the EIF's PCR0, exactly
//! as the merged oracle enclave deploys it — plus the remote verifier. What
//! the guard does with an optional `SIGNER_SERVICE_EXPECTED_PCR0` (a host
//! dry-run, a test) is refuse a measured value that differs from it. The
//! measured PCR0 always comes back from [`BootGuard::verify`], so the boot
//! report carries the value an operator pins in KMS.
//!
//! PCR1/PCR2 are heap/runtime measurements the deployment does not pin for
//! this service; the measurements manifest keeps them for the remote
//! verifier.
//!
//! What the guard does NOT do, stated so nobody builds on a stronger reading:
//! it does not verify the COSE_Sign1 signature and does not walk the AWS
//! certificate chain. It checks that a document parses, that it answers THIS
//! boot's challenge, and that the measurement is neither all zeros nor
//! different from an optional pin. The cryptographic gate on this service's
//! keys is the KMS key policy's `kms:RecipientAttestation:*` conditions,
//! which AWS evaluates against a document it validated itself.

use nitro_attest::release::AttestationSource;

/// `SIGNER_SERVICE_ATTESTED_BOOT=require` turns the guard on. Any other value
/// is refused rather than guessed at: a typo silently falling back to host
/// mode would be exactly the downgrade this service exists to make impossible.
pub const ATTESTED_BOOT_ENV: &str = "SIGNER_SERVICE_ATTESTED_BOOT";

/// Optional 96-hex-character PCR0 the boot compares against. See the module
/// docs for why the enclave deployment leaves it unset and pins the value in
/// the KMS key policy instead.
pub const EXPECTED_PCR0_ENV: &str = "SIGNER_SERVICE_EXPECTED_PCR0";

/// Nitro PCRs are SHA-384: 48 bytes, 96 hex characters.
pub const PCR0_LEN: usize = 48;

/// The per-boot challenge length. Nitro accepts up to 512 bytes in `nonce`;
/// 16 bytes of OS randomness is already far past any birthday concern for a
/// value that lives for one boot.
pub const NONCE_LEN: usize = 16;
const PCR0_HEX_CHARS: usize = PCR0_LEN * 2;

/// The guard, parsed from the environment. `None` is host mode: the vault
/// opens from local configuration and none of this module runs.
#[derive(Clone)]
pub struct BootGuard {
    expected_pcr0: Option<[u8; PCR0_LEN]>,
}

impl BootGuard {
    /// Require fresh attestation without consulting environment switches. The
    /// optional pin supplements the authoritative KMS image policy.
    pub fn required(expected_pcr0: Option<&str>) -> anyhow::Result<Self> {
        Ok(Self {
            expected_pcr0: expected_pcr0
                .map(|pin| decode_pcr0(pin.trim()).map_err(anyhow::Error::msg))
                .transpose()?,
        })
    }

    /// Read the two environment names. A value other than `require` is an
    /// error with the fix in the message; a pin that does not decode is an
    /// error rather than a guard that would have accepted anything.
    pub fn from_env() -> anyhow::Result<Option<Self>> {
        let raw = match std::env::var(ATTESTED_BOOT_ENV) {
            Ok(value) => value,
            Err(_) => return Ok(None),
        };
        let raw = raw.trim();
        if raw.is_empty() {
            return Ok(None);
        }
        if raw != "require" {
            anyhow::bail!(
                "{ATTESTED_BOOT_ENV} must be unset or exactly `require`; got `{raw}` — an \
                 attested boot is either demanded or it is not"
            );
        }
        let pinned = std::env::var(EXPECTED_PCR0_ENV).unwrap_or_default();
        let expected_pcr0 = if pinned.trim().is_empty() {
            None
        } else {
            Some(decode_pcr0(pinned.trim()).map_err(|error| {
                anyhow::anyhow!(
                    "{EXPECTED_PCR0_ENV} {error} — the value is 96 hex \
                                 characters, the PCR0 line of the measurements manifest"
                )
            })?)
        };
        Ok(Some(BootGuard { expected_pcr0 }))
    }

    /// Build the same check from a literal pin, for the dry-run path and the
    /// tests.
    pub fn from_pin(pin: &str) -> Result<Self, String> {
        Ok(BootGuard {
            expected_pcr0: Some(decode_pcr0(pin.trim())?),
        })
    }

    /// Demand and decode a fresh attestation document, then — when a pin is
    /// configured — compare PCR0 against it. Returns the measured PCR0, hex,
    /// which is the value an operator pins in the KMS key policy.
    ///
    /// An all-zero measurement is refused before the pin comparison: PCR0 is
    /// the SHA-384 of the enclave image, so zeros mean the register was never
    /// extended — an emulated or broken NSM, not a booted enclave. It fires
    /// with or without a pin (KMS-ATTESTATION-DESIGN.md: an all-zero PCR0 is
    /// the "nothing can decrypt yet" state, never a passing one).
    ///
    /// The nonce is fresh per boot AND compared against the document's own
    /// `nonce` field, so a recorded document from an earlier boot cannot be
    /// replayed as this boot's answer. Generating a challenge without
    /// checking the answer is the CL-03 omission: everything still verifies
    /// and the guard learns nothing about liveness.
    pub fn verify(&self, source: &dyn AttestationSource) -> Result<String, String> {
        let mut nonce = [0u8; NONCE_LEN];
        use aes_gcm::aead::{rand_core::RngCore, OsRng};
        OsRng.fill_bytes(&mut nonce);
        let document = source.attest(Some(&nonce), None, None)?;
        let answered = extract_nonce(&document)?;
        if answered.len() != nonce.len()
            || answered
                .iter()
                .zip(nonce.iter())
                .fold(0u8, |acc, (a, b)| acc | (a ^ b))
                != 0
        {
            return Err(
                "attestation nonce does not answer this boot's challenge — the document is \
                 a replay or the NSM is not the one that was challenged"
                    .to_string(),
            );
        }
        let measured = extract_pcr0(&document)?;
        if measured == [0u8; PCR0_LEN] {
            return Err(
                "attestation PCR0 is all zeros — the NSM reports an unmeasured \
                 environment, not a booted enclave"
                    .to_string(),
            );
        }
        if let Some(expected) = &self.expected_pcr0 {
            let diff = measured
                .iter()
                .zip(expected.iter())
                .fold(0u8, |acc, (a, b)| acc | (a ^ b));
            if diff != 0 {
                return Err(format!(
                    "attestation PCR0 {} does not match the pinned {}",
                    hex::encode(measured),
                    hex::encode(expected)
                ));
            }
        }
        Ok(hex::encode(measured))
    }
}

/// Pull PCR0 out of a COSE_Sign1 attestation document: the payload's `pcrs`
/// map keyed by register `0`. Anything unexpected is an error, not a guess —
/// the guard's whole value is that a document it cannot understand fails
/// closed.
pub fn extract_pcr0(document: &[u8]) -> Result<[u8; PCR0_LEN], String> {
    let decoded = neo_os_core::cbor::decode_cose_sign1(document)
        .map_err(|error| format!("attestation document: {}", error.0))?;
    let entries = match &decoded.payload {
        neo_os_core::cbor::CborValue::Map(entries) => entries,
        _ => return Err("attestation payload is not a map".to_string()),
    };
    let pcrs = entries
        .iter()
        .find(|(name, _)| name == "pcrs")
        .ok_or_else(|| "attestation payload has no pcrs map".to_string())?;
    let registers = match &pcrs.1 {
        neo_os_core::cbor::CborValue::Map(registers) => registers,
        _ => return Err("attestation pcrs is not a map".to_string()),
    };
    // The CBOR reader names integer keys by their `String()` form, so register
    // 0 arrives as "0".
    let value = registers
        .iter()
        .find(|(name, _)| name == "0")
        .ok_or_else(|| "attestation pcrs has no PCR0".to_string())?;
    let bytes = value
        .1
        .as_bytes()
        .ok_or_else(|| "attestation PCR0 is not a byte string".to_string())?;
    let measured: [u8; PCR0_LEN] = bytes.try_into().map_err(|_| {
        format!(
            "attestation PCR0 is {} bytes, expected {PCR0_LEN}",
            bytes.len()
        )
    })?;
    Ok(measured)
}

/// Pull the challenge back out of the document: the NSM echoes the caller's
/// `nonce` into the payload's `nonce` field. A document with no nonce is
/// refused rather than treated as "nothing to compare" — an unchallenged
/// document is exactly the replayable bearer artifact the challenge exists to
/// rule out.
pub fn extract_nonce(document: &[u8]) -> Result<Vec<u8>, String> {
    let decoded = neo_os_core::cbor::decode_cose_sign1(document)
        .map_err(|error| format!("attestation document: {}", error.0))?;
    let entries = match &decoded.payload {
        neo_os_core::cbor::CborValue::Map(entries) => entries,
        _ => return Err("attestation payload is not a map".to_string()),
    };
    let nonce = entries
        .iter()
        .find(|(name, _)| name == "nonce")
        .ok_or_else(|| {
            "attestation payload has no nonce — an unchallenged document proves no liveness"
                .to_string()
        })?;
    nonce
        .1
        .as_bytes()
        .map(<[u8]>::to_vec)
        .ok_or_else(|| "attestation nonce is not a byte string".to_string())
}

fn decode_pcr0(raw: &str) -> Result<[u8; PCR0_LEN], String> {
    if raw.len() != PCR0_HEX_CHARS {
        return Err(format!(
            "must be {PCR0_HEX_CHARS} hex characters, got {}",
            raw.len()
        ));
    }
    let bytes = hex::decode(raw).map_err(|error| format!("is not hexadecimal: {error}"))?;
    bytes
        .try_into()
        .map_err(|_| "is not 48 bytes after decoding".to_string())
}

#[cfg(test)]
#[path = "../tests/unit/attestation.rs"]
mod tests;
