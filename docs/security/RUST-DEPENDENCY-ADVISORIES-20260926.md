# Rust dependency advisories — 2026-09-26

Scope: this source branch's Cargo workspace. This is a local source and lockfile
review; it is not a production deployment, live runtime test, or waiver.

| Advisory | Package on starting HEAD | Dependency path | Action | Status in candidate |
| --- | --- | --- | --- | --- |
| RUSTSEC-2026-0285 | rustls 0.23.43 | reqwest / hyper-rustls / tokio-rustls into neo-signer, relayer, compute and Nitro host | Pin 0.23.45 in Cargo.lock | Patched locally; cargo check, Clippy, workspace tests and cargo audit verified |
| RUSTSEC-2024-0437 | protobuf 2.28.0 | prometheus 0.13.4 into neo-signer | Upgrade prometheus to 0.14.0 and protobuf to 3.7.2 | Patched locally; neo-signer metrics endpoint, protobuf identity and workspace tests passed |
| RUSTSEC-2023-0071 | rsa 0.9.10 | neo-signer, nitro-attest, Nitro host and compute | No fixed upgrade in the advisory database | OPEN: do not claim audit clear or release approval |

The RSA advisory concerns private-key timing exposure. Production source uses
RSA-OAEP for enclave/KMS CMS decryption and RSA-PSS for a session request proof;
`nitro-attest/src/cms.rs` now uses `RsaPrivateKey::decrypt_blinded`, and
`session_key.rs` already used the same blinded operation. The code paths that
can receive ciphertext are therefore security relevant; the new CMS regression
gate keeps the mitigation from being removed. Public-key-only
verification in compute and NeoDID does not itself expose a private key. A
complete exception would require a separate side-channel assessment, a
verified mitigation on each private-key path, and owner approval. No audit
ignore rule or release waiver has been added.

Local evidence on this candidate: the dependency test failed on the old lock,
then passed 6/6 after the change; four lock/manifest mutations were caught;
`cargo check --workspace --locked`, `cargo clippy --workspace --all-targets
--locked -- -D warnings`, and `cargo test --workspace --all-targets --locked`
passed. The post-change `cargo audit --json` has exactly one vulnerability:
RUSTSEC-2023-0071. These checks do not constitute hosted CI or production
acceptance.
