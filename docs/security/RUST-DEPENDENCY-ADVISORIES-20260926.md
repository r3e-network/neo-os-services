# Rust dependency advisories — 2026-09-26

Scope: this source branch's Cargo workspace. This is a local source and lockfile
review; it is not a production deployment, live runtime test, or waiver.

| Advisory          | Package before the fix | Dependency path                                                                        | Action                                                             | Status on this branch                                                  |
| ----------------- | ---------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| RUSTSEC-2026-0285 | rustls 0.23.43         | reqwest / hyper-rustls / tokio-rustls into neo-signer, relayer, compute and Nitro host | c73b8a5 pinned 0.23.45 in Cargo.lock                               | Fixed; `scripts/rust-security-dependency.test.mjs` keeps the floor     |
| RUSTSEC-2024-0437 | protobuf 2.28.0        | prometheus 0.13.4 into neo-signer                                                      | c73b8a5 moved prometheus to 0.14.0, which takes protobuf 3.7.2     | Fixed; the same test keeps the floor and the neo-signer prometheus pin |
| RUSTSEC-2023-0071 | rsa 0.9.10             | neo-signer, nitro-attest, Nitro host and compute                                       | No fixed release in the advisory database; CMS decrypt now blinded | OPEN: do not claim audit clear or release approval                     |

The RSA advisory concerns private-key timing exposure. Production source uses
RSA-OAEP for enclave/KMS CMS decryption and RSA-PSS for a session request proof;
`nitro-attest/src/cms.rs` now uses `RsaPrivateKey::decrypt_blinded`, and
`session_key.rs` already used the same blinded operation. The code paths that
can receive ciphertext are therefore security relevant; the CMS regression test
`kms_cms_private_rsa_decrypt_is_blinded` keeps the blinded call from being
removed. Public-key-only verification in compute and NeoDID does not itself
expose a private key. Blinding is a partial mitigation, not a fix: a complete
exception would require a side-channel assessment, a verified mitigation on
each private-key path, and owner approval. No audit ignore rule or release
waiver has been added.
