# Cargo.lock provenance

## Overview

`Cargo.lock` is a release artifact. Removing the retired
`workers/morpheus-relater-rs` graph deletes packages that must stay gone.
Opportunistic version bumps that are not implied by that graph removal are
recorded here so they are not mistaken for a required resolve.

`npm run check:cargo-lock-provenance` (`node scripts/check-cargo-lock-provenance.mjs`)
asserts the retired graph stays absent and that any remaining recorded
upgrades match `scripts/fixtures/cargo-lock-provenance.json`.

## API Reference

| Symbol / file                                 | Contract                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| `scripts/fixtures/cargo-lock-provenance.json` | Deny-list of retired packages and documented leftover upgrades                 |
| `auditCargoLockProvenance(root)`              | Fails if a retired package returns or an undocumented leftover upgrade appears |
| `RETIRED_LOCK_PACKAGES`                       | Direct retired-graph names that must not appear in `Cargo.lock`                |

## Usage Examples

```bash
npm run check:cargo-lock-provenance
node --test scripts/check-cargo-lock-provenance.test.mjs
```

A lock edit that only removes retired-graph packages is expected. Leftover
patch bumps that appeared in the dirty worktree (`bytemuck`, `bytemuck_derive`,
`cpufeatures 0.3.1`, `mio`, `tinyvec`, `tokio-rustls`) were pinned back to the
remaining `origin/main` versions. A later bump of those crates must be split
or recorded in `leftoverUpgrades` with a reason.

## Design Decisions

1. **Do not restore the retired graph.** `morpheus-relayer-rs`,
   `tee-attestation` (the nested placeholder), `async-retry`, `dotenvy`, and
   the unique `metrics` / `config 0.14` tree belong to the archive, not the
   production workspace.
2. **Do not blindly revert leftover patch bumps.** Those lines were already
   in the dirty worktree. The gate marks them; shrinking them back to
   `origin/main` is allowed only when `cargo metadata --locked` still
   resolves the current workspace.
3. **Provenance is a deny-list plus an explicit leftover set.** The gate
   does not snapshot the entire lock against `origin/main` after merge.

## Test Coverage

| Case                                             | Expected                                               |
| ------------------------------------------------ | ------------------------------------------------------ |
| Current lock                                     | Retired packages absent                                |
| Fixture with `morpheus-relayer-rs` reintroduced  | Audit fails                                            |
| Leftover upgrade versions drift from the fixture | Audit fails until the fixture is updated with a reason |
