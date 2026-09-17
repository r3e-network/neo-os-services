# Retired archive — do not deploy

## Overview

This file is a non-production pointer. `workers/morpheus-relater-rs` is a
retired heartbeat skeleton. It is not a Cargo package, not a workspace
member, and not a measured or systemd production unit.

Production relaying is `workers/neo-os-relayer`. Confidential one-shot
`/automation/execute` and `/oracle/feed` observation belong to
`workers/nitro-enclave-host`. See [`RETIRED.md`](./RETIRED.md).

## API Reference

There is no supported API, binary, image, or unit. Historical source under
`src/` and `tests/` is provenance only.

The historical Cargo manifest is `Cargo.toml.retired`. The live
`Cargo.toml` in this directory is an archive stub: `cargo metadata
--manifest-path workers/morpheus-relater-rs/Cargo.toml` must fail.

## Usage Examples

Do not build, run, enable, or containerize this tree.

```bash
# Production relayer
cargo test -p neo-os-relayer --locked
cargo run --locked -p neo-os-relayer -- config:validate
```

## Design Decisions

Keeping the path as an excluded archive preserves the evidence that this
duplicate was evaluated and rejected. Deleting git history is unnecessary.
A buildable manifest or an operator guide with `cargo build` / `cargo run`
/ `systemctl` / `docker` instructions would invite a mistaken start.

## Test Coverage

`scripts/check-rust-migration.mjs` asserts:

- this path stays in `[workspace].exclude` and out of `members`
- `cargo metadata --manifest-path workers/morpheus-relater-rs/Cargo.toml` fails
- this guide and sibling markdown contain no actionable build/run/deploy commands
- measured Dockerfiles do not `COPY` this tree
