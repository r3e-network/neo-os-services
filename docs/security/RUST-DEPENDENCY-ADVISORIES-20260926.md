# Rust dependency advisories — 2026-09-26

Scope: this source branch's Cargo workspace. This is a local source and lockfile
review; it is not a production deployment, live runtime test, or waiver.

`cargo audit --no-fetch` against the RustSec advisory database at commit
`e2111519` (2026-09-25) reports one vulnerability, RUSTSEC-2023-0071, and two
unmaintained-crate warnings, RUSTSEC-2024-0436 (`paste` 1.0.15, a proc-macro of
the vendored `boa_engine`) and RUSTSEC-2021-0127 (`serde_cbor` 0.11.2, through
`aws-nitro-enclaves-nsm-api` into `nitro-attest`). The repository has no
`audit.toml` or `deny.toml`, and this branch adds no ignore entry. Until this
branch, `docs/SECURITY_AUDIT.md` prescribed `cargo audit --ignore
RUSTSEC-2023-0071` as the release check; that waiver rested on the claim that
the only RSA private-key operation is a single-use KMS unwrap, which the
analysis below refutes. This branch withdraws it, so RUSTSEC-2023-0071 is not
ignored or allowed anywhere, and its disposition is owner decision O22.

**Update 2026-09-28.** Option 1 below is now in source: the custody request
proofs are signed with `Pss::new_blinded_with_salt::<Sha256>(32)`, so every RSA
private-key operation on a production key in the workspace is blinded. The
signature format is unchanged and the existing verifiers accept it. This
narrows the channel described below; it does not
close the advisory. RUSTSEC-2023-0071 stays open until the `rsa` crate is
replaced or the owner records an acceptance (O22), and the running signer keeps
signing unblinded until its image is rebuilt and re-measured, which is an owner
action.

| Advisory          | Package before the fix | Dependency path                                                                        | Action                                                                                                                                                              | Status on this branch                                                  |
| ----------------- | ---------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| RUSTSEC-2026-0285 | rustls 0.23.43         | reqwest / hyper-rustls / tokio-rustls into neo-signer, relayer, compute and Nitro host | c73b8a5 pinned 0.23.45 in Cargo.lock                                                                                                                                | Fixed; `scripts/rust-security-dependency.test.mjs` keeps the floor     |
| RUSTSEC-2024-0437 | protobuf 2.28.0        | prometheus 0.13.4 into neo-signer                                                      | c73b8a5 moved prometheus to 0.14.0, which takes protobuf 3.7.2                                                                                                      | Fixed; the same test keeps the floor and the neo-signer prometheus pin |
| RUSTSEC-2023-0071 | rsa 0.9.10             | neo-signer, nitro-attest, Nitro host and compute                                       | No fixed release in the advisory database; both OAEP decryptions and, since 2026-09-28, the PSS request proofs are blinded in source (signer image not yet rebuilt) | OPEN: owner decision O22; do not claim audit clear or release approval |

## RUSTSEC-2023-0071 (rsa 0.9.10): reachability

The advisory ("Marvin Attack") is a timing side channel in the `rsa` crate's
private-key operations: its big-integer arithmetic is not constant time, so an
attacker who can observe the timing of many private-key operations with one key,
on inputs it chooses or can compute, and time each precisely enough may recover
that key. Public-key operations handle no secret and are not affected.

Blinding, where the crate applies it, multiplies each input by a fresh random
`r^e` before the exponentiation and removes `r` afterwards, so the value that is
exponentiated is unknown to an observer. In rsa 0.9.10 a decryption is blinded
when it is called with an RNG (`decrypt_blinded`), and a PSS signature is
blinded only when its padding value asks for it (`Pss::new_blinded*` or
`pss::BlindedSigningKey`); passing an RNG to `sign_with_rng` does not blind a
signature by itself.

### Private-key operations in this workspace

1. **KMS recipient unwrap** — `crates/nitro-attest/src/cms.rs`,
   `decrypt_cms_enveloped_data`: RSA-OAEP-SHA256 decryption of the
   KeyTransRecipientInfo `encryptedKey` in a KMS `CiphertextForRecipient`,
   blinded since 23f257f (`decrypt_blinded` with `OsRng`, pinned by the
   `kms_cms_private_rsa_decrypt_is_blinded` test).
   - Callers: `release.rs` (`release_bytes`, `release_bytes_with_context`,
     `release_bytes_with_context_and_key`, `release_master_key`), used by the
     enclave host's `kms_release.rs` (runtime token, NeoDID salt, VRF root and
     the KMS diagnostic during `/provision`) and by the signer's `provision.rs`
     (the custody master key); and the `nsm-attest-rs kms-decrypt` binary.
   - Key: every release generates a fresh RSA-2048 key
     (`RsaPrivateKey::new`), binds its public key into that release's
     attestation document, performs exactly one decryption with it and drops
     it.
   - Who chooses the ciphertext: AWS KMS, in the response to the enclave's own
     SigV4-signed Decrypt request to `https://kms.<region>.amazonaws.com/`
     (TLS end to end through the no-MITM egress proxy). The parent instance
     can refuse to forward the response but cannot substitute one without
     breaking TLS.
   - Timing oracle: none usable. One blinded decryption per key, of a
     ciphertext the attacker does not choose, gives no sequence of queries to
     time.

2. **Custody coordinator session key** — `crates/nitro-attest/src/session_key.rs`,
   `SessionTransportKey` (RSA-3072), used by `workers/neo-signer/src/coordinator.rs`.
   - Key: one per `CoordinatorClient`, i.e. per signer process; never
     exported, persisted or cloned, and not a vault or chain signing key. It
     lives as long as the process and is used for every operation below.
   - `open_session_token`: blinded RSA-OAEP-SHA256 decryption (`decrypt_blinded`
     with `OsRng`) of the 384-byte `sealed_session_token` in the coordinator's
     `/v1/sessions` response, once when the session is established and once per
     refresh (a session is refreshed when it is within 30 s of expiry). Sealed
     tokens come only from the coordinator origin pinned in the validated vault
     profile, over rustls HTTPS (`https_only`) with SigV4 request signing, so
     only the coordinator (or a holder of its TLS identity) chooses them, and
     only at the establish and refresh rate.
   - `sign_request_proof`: an RSA-PSS-SHA256 signature over SHA-256 of the
     domain-prefixed canonical request (`neoos/custody-state-request-proof/v1`),
     made with `sign_with_rng(&mut OsRng, Pss::new_blinded_with_salt::<Sha256>(32), ..)`
     since 2026-09-28. It used to be made with `Pss::new_with_salt::<Sha256>(32)`.
     That padding value sets `blinded: false` (rsa 0.9.10 `src/pss.rs`,
     `Pss::new_with_salt`); `Pss::sign` then passed no blinding RNG to
     `rsa_decrypt_and_check`, and `OsRng` only drew the 32-byte salt, so **every
     request proof was an unblinded RSA-3072 private exponentiation with the
     per-process key.** The blinded padding passes `OsRng` on to
     `rsa_decrypt_and_check`, which exponentiates `EM·r^e mod n` for a fresh
     random `r` and removes `r` afterwards. The `session_key` unit test
     `request_proof_signature_is_blinded_and_standard_pss` pins this: an
     unblinded signature draws only the salt from its RNG, and the test requires
     more. Blinding changes how the signature is computed, not the signature: the
     coordinator's verifier (`deploy/custody-state-authority/src/request-proof.mjs`,
     Node `crypto.verify` with `RSA_PKCS1_PSS_PADDING` and
     `RSA_PSS_SALTLEN_DIGEST`) accepted 8 of 8 blinded signatures from
     `SessionTransportKey` on 2026-09-28 and rejected a tampered one, and the
     Rust `Pss::new_with_salt::<Sha256>(32)` verifiers in the nitro-attest and
     neo-signer tests accept them unchanged.
   - How often it signs: once per coordinator authority request, `head`,
     `takeover` and `download-tickets` at recovery, and `upload-tickets`,
     `upload-status`, `commits` (each retry signs again) and `renew` while
     serving. The durable commit runs after every observable signer operation
     (`SignerService::execute_observable`), so signatures follow the signing
     workload. `renew` runs on every `GET /health` of a durable signer
     (`health_route` → `verify_durable_lease` → `CoordinatorClient::renew`).
     `/health` needs no credentials (it is one of the signer's
     pre-authentication process routes, reached over the vsock transport that
     the parent instance carries), so the parent instance can make the signer
     compute one signature per probe, as many as it likes.
   - Who knows each exponentiation input: the signed message is built by the
     signer from its own request with a fresh 32-byte nonce, and PSS adds a
     random salt, so no party chooses the input. The coordinator verifies every
     proof, and anyone holding a signature `s` and the session public key can
     compute the encoded message as `s^e mod n`. Unblinded, that value was the
     exponentiation input, so the coordinator knew the input of every
     exponentiation after the fact: a known-input channel with one sample per
     request. Blinded, the exponentiated value is `EM·r^e mod n` for a secret
     `r` drawn per signature, so knowing `EM` no longer gives the input; the
     samples and their timing remain.
   - Who can time it: the coordinator sees when each request arrives, and in
     the multi-step exchanges (an `upload-tickets` response followed by the
     upload, `upload-status` and `commits`) it has its own previous response as
     a reference point; the interval contains one signature plus the signer's
     SigV4, JSON, TLS and network work. The parent instance can trigger
     signatures through `/health` and time the resulting outbound request at the
     egress proxy against its own probe, but the request travels inside TLS to
     the coordinator, so the parent does not learn the input. A party holding
     both positions (the coordinator colluding with the parent, or one attacker
     controlling both) got known inputs, per-operation timing against a
     reference point it sets, and an unbounded number of samples: the setting
     the advisory describes. Blinding takes away the known inputs; the timing
     and the unbounded samples remain, and the arithmetic is still not constant
     time. Whether the timing variation of this CRT exponentiation (followed by
     the unblinding and the `rsa_decrypt_and_check` re-encryption) can be
     resolved over that path has not been measured, blinded or not.
     Exploitation has not been demonstrated, and neither has its
     impossibility.
   - Impact if the key were recovered: the attacker could open this process's
     session tokens and forge its request proofs, acting as this signer towards
     the custody-state coordinator (head, takeover, renew, commit and
     snapshot-transfer requests, which also carry the signer's SigV4 signature)
     until the process restarts and generates a new key. Snapshots stay
     encrypted under the vault master key, and no vault, chain signing or
     KMS-released key is derived from or protected by the session key.

Key generation (`RsaPrivateKey::new`) runs once per key inside the enclave and
is not a repeatable operation on an existing key.

Test code only: `workers/nitro-enclave-host/tests/unit/neodid.rs` signs RS256
fixture tokens with throwaway RSA-2048 keys through `Signer::sign`, which in
rsa 0.9.10 does not blind PKCS#1 v1.5 signatures (`RandomizedSigner::sign_with_rng`
does). No production key is involved. The file is a pinned copy of
neo-os-did's `runtime/nitro-enclave-host/tests/unit/neodid.rs`
(`vendor/neo-os-did.pin.json`), so a change to it belongs in neo-os-did and a
new pin.

### Public-key-only uses (not affected)

- `crates/neo-os-compute/src/compute.rs`: PKCS#1 v1.5 signature verification.
- `workers/nitro-enclave-host/src/neodid.rs`: RS256 verification of Web3Auth
  `id_token`s against JWKS public keys.
- `neo-os-relayer` links `nitro-attest` but performs no RSA private-key
  operation.

### Options

1. **Blind the request-proof signatures in place.** Sign with
   `Pss::new_blinded_with_salt::<Sha256>(32)` in `sign_with_rng`, or hold the
   key as `rsa::pss::BlindedSigningKey::<Sha256>::new_with_salt_len(key, 32)`.
   Both produce standard RSASSA-PSS signatures that the coordinator's existing
   verifier accepts, and neither needs a new dependency. The exponentiation
   input then no longer equals the value the coordinator can recompute, which
   puts the request proofs in the same blinded position as the two decryption
   paths. Blinding does not make the arithmetic constant time, so this narrows
   the channel rather than closing the advisory. It changes the neo-signer
   binary, and so the measured signer image: new PCR manifests and a KMS
   key-policy update are needed before such a build can release keys.
   **Done in source on 2026-09-28** (the first form); rebuilding and
   re-measuring the signer image, publishing its manifest and updating the KMS
   key policy remain owner actions, and until they happen production signs
   unblinded.
2. **Replace the implementation** on the private-key paths with a
   constant-time one. `aws-lc-rs` provides RSA-OAEP decryption and RSA-PSS
   signing (with a FIPS-validated build); it adds a C/assembly build
   dependency to `Dockerfile.enclave` and `Dockerfile.signer`, which changes the
   measured enclave images and so needs new PCR manifests and KMS key-policy
   updates. `ring` signs RSA-PSS but does not decrypt RSA-OAEP, so it cannot
   serve the KMS unwrap or the session token. A future `rsa` release built on a
   constant-time big-integer library would close the advisory in place; none
   exists in the advisory database today.
3. **Narrow the remaining exposure** without a new dependency: generate a new
   `SessionTransportKey` for every session exchange, so each key performs one
   decryption and the signatures of one session, matching the single-use KMS
   keys more closely. This bounds the samples per key but not per session, and
   it also changes the measured signer image.
4. **Written acceptance** of the residual risk (a coordinator-chosen, blinded
   decryption per session refresh, and one PSS signature per authority request,
   whose rate the workload and the parent instance's `/health` probes set; the
   signature is blinded in source since 2026-09-28, and its input was known to
   the coordinator while it was not), with an owner, an expiry and a review
   trigger such as an upstream fix. Options 1 and 3 can be combined with this
   one.

**Status: open owner decision O22.** The two decryption paths and, since
2026-09-28, the request-proof signatures are blinded in source; blinding is a
partial mitigation, not a fix. The advisory stays open until the `rsa` crate is
replaced on the private-key paths (option 2) or the owner records a written
acceptance of the residual risk (option 4): this tree is not audit clean,
`cargo audit` still reports RUSTSEC-2023-0071, no audit ignore entry or release
waiver exists (the `--ignore` release check formerly in `docs/SECURITY_AUDIT.md`
is withdrawn), and nothing here approves a release.
