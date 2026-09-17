# Retired: `workers/morpheus-relater-rs`

## Overview

This directory is a retired heartbeat skeleton. It is not a production
process, not a Cargo package, not a Cargo workspace member, and not part of
any measured Docker build. The historical package name `morpheus-relayer-rs`
is provenance only.

The live `Cargo.toml` files here are archive stubs. `cargo metadata` and
`cargo build` against those paths must fail. The last buildable manifests are
kept as `Cargo.toml.retired`.

## API Reference

There is no supported API. The historical sources log a start line and exit,
or loop a 60-second heartbeat. They do not scan chains, claim work, call
custody, or deliver fulfillments.

Production ownership is:

| Concern                                                                          | Authority                                      |
| -------------------------------------------------------------------------------- | ---------------------------------------------- |
| Chain scan, request/feed delivery, durable state                                 | `workers/neo-os-relayer`                       |
| Confidential session, one-shot `/automation/execute`, `/oracle/feed` observation | `workers/nitro-enclave-host`                   |
| Durable automation scheduler (claim / queue / persist)                           | Unimplemented; fail-closed in `neo-os-relayer` |
| Node compatibility / parity evidence                                             | `workers/morpheus-relayer`                     |

## Usage Examples

Do not build or deploy this crate.

```bash
# Production relayer:
cargo test -p neo-os-relayer --locked
```

A direct metadata or build against this directory's `Cargo.toml` must fail.
Do not restore `Cargo.toml.retired` as the live manifest.

Restore a `[package]` table here only if a dedicated retirement review
proves it owns a capability that `neo-os-relayer` and `nitro-enclave-host`
do not already provide. A heartbeat is not such a capability.

## Design Decisions

Keeping the tree as an excluded archive preserves the evidence that this
duplicate was evaluated and rejected. Deleting it from git history is
unnecessary; adding it back to the lockfile or Docker context would pull
unrelated crates (`async-retry`, `config 0.14`, local `tee-attestation`)
into every measured `--locked` resolve.

`DEPLOYMENT_GUIDE.md` is a pointer only. Actionable `cargo build` /
`cargo run` / `systemctl` / `docker` instructions for this tree are a
migration-gate failure.

## Test Coverage

`scripts/check-rust-migration.mjs` asserts this path stays in
`[workspace].exclude`, stays out of `[workspace].members`, is not
`COPY`ed by `Dockerfile.enclave` or `Dockerfile.signer`, has no buildable
direct manifest, and that remaining markdown has no actionable start
commands.
