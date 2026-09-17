# Rust format gate

## Overview

CI and local verification use one controlled format gate,
`npm run format:rust:check` (`node scripts/check-rust-format.mjs`). The gate
has two halves:

1. **Handwritten Rust** — `cargo fmt --all -- --check` over Cargo workspace
   members. Vendored patch crates and `target/` are outside that set.
2. **Generated Rust** — rustfmt is not the authority. The gate regenerates
   each committed generated table and the SignClient proto pair, then requires
   byte identity. Tonic/prost output is not rustfmt-clean and must not be
   fed to `rustfmt` or claimed as a `cargo fmt` pass.

Workflows must call this script. A document that says “fmt is green” while CI
still runs bare `cargo fmt --all --check` as its only Rust format step is a
failed release gate.

## API Reference

| Entry                                | Contract                                        |
| ------------------------------------ | ----------------------------------------------- |
| `npm run format:rust:check`          | Official gate: rustfmt + generated identity     |
| `npm run format:rust`                | Writes rustfmt on workspace members only        |
| `node scripts/check-rust-format.mjs` | Same as `format:rust:check`                     |
| `scripts/lib-rust-format.mjs`        | Exported helpers used by the gate and its tests |

Generated surfaces:

| Artifact                                                                                      | Regenerator                                                                                                              | rustfmt                              |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `crates/neo-os-core/src/config_schema.rs` tables (`DIRECT_CONTROL_ENV_KEYS`, `CONFIG_SCHEMA`) | `node scripts/gen-config-schema-rust.mjs`                                                                                | Not applied to generator output      |
| `workers/neo-signer` SignClient proto (`signpb`, `servicepb`)                                 | `tonic_build` + `protoc-bin-vendored` via `workers/neo-signer/build.rs` and `workers/neo-signer/tests/proto_identity.rs` | Excluded; tonic output fails rustfmt |

## Usage Examples

```bash
npm run format:rust:check
node --test scripts/check-rust-format.test.mjs

# Handwritten-only half (must stay green after the gate):
cargo fmt --all -- --check

# Proto identity without the Node wrapper:
cargo test -p neo-signer --test proto_identity --locked -- --exact proto_generation_is_byte_stable
```

### Remaining external dependencies

- **Config schema:** Node, and `workers/morpheus-relayer/src/config-schema.js`.
  No network.
- **Proto:** the workspace `tonic-build 0.12` and `protoc-bin-vendored 3`
  pins. No system `protoc` is required. Exact regenerate command:

  ```bash
  cargo test -p neo-signer --test proto_identity --locked -- --exact proto_generation_is_byte_stable
  ```

  The first signer build still needs a C compiler for bundled `rusqlite`.

## Design Decisions

1. **One command in every workflow.** `.github/workflows/ci.yml` and
   `publish-images.yml` invoke `scripts/check-rust-format.mjs`. They must not
   use bare `cargo fmt --all --check` as the format gate.
2. **Do not rustfmt tonic output.** Generated proto lives in `OUT_DIR` at
   build time. rustfmt rejects it; identity is “generate twice, compare
   bytes.” The matching clippy policy is `#![allow(clippy::result_large_err)]`
   on `workers/neo-signer/src/signclient.rs` (and its included proto modules):
   `tonic::Status` is the SignClient wire error; boxing it would change the
   generated gRPC trait. Workspace clippy still runs `-D warnings`.
3. **Committed generated tables stay byte-identical to the JS oracle.**
   `gen-config-schema-rust.mjs` is the only writer of those tables.
4. **Handwritten rustfmt stays required.** Excluding generated files is not
   a license to skip rustfmt on workspace sources.

## Test Coverage

| Case                     | Expected                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------- |
| Repository gate          | `node scripts/check-rust-format.mjs` exits 0                                          |
| Config schema drift      | Changing a generated table without regenerating fails identity                        |
| Proto non-determinism    | Two successive `tonic_build` outputs must match                                       |
| Workflows                | `ci.yml` and `publish-images.yml` call the script, not bare `cargo fmt --all --check` |
| rustfmt on proto OUT_DIR | Documented as unsupported; not invoked by the gate                                    |
