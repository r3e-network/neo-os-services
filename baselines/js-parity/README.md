# Frozen JS parity baseline

`baselines/js-parity/` is a byte-for-byte snapshot of the JavaScript assets the
Rust ports are verified against. It is the **permanent anchor** that lets the
repo keep proving (and disproving) its own parity pins after
`workers/nitro-worker` and `workers/morpheus-relayer` are deleted in T05.

## What is frozen here

| Asset | Frozen from | Why it must survive the JS deletion |
|---|---|---|
| `engine-parity.goldens.json` | `workers/nitro-worker/src/game/` | 112KB of recorded per-op view/state hashes, replay hashes and canonical score outcomes for all 11 engines. The only proof the Rust engines equal the JS engines. |
| `stable-stringify-vectors.mjs` | `packages/shared/src/` | The pinned `stableStringify` golden vectors that gate the ICU `'en'` collation port. |
| `wrappers/*.wrapper.js` (11) | `workers/nitro-worker/src/game/wrappers/` | `sha256(source, CRLF-normalized)` **is** the `engineHash` literal pinned in `crates/neo-os-games/src/registry.rs`. Delete these files and those 11 hashes can never be re-derived by anyone, ever. |
| `oracle/router.js` | `workers/morpheus-relayer/src/` | JS oracle for the `fulfillment_digest`, `fulfillment_envelope` and `worker_payload` vector families. |
| `oracle/neox.js` | `workers/morpheus-relayer/src/` | JS oracle for the `neox_digest` vector family. |
| `oracle/lib/strings.js` | `workers/morpheus-relayer/src/lib/` | The relative import that closes `router.js`'s dependency graph (`trimString` / `normalizeRequestType` / `strip0x`), so the oracle can still be imported with no relayer tree present. |

`MANIFEST.sha256` records the sha256 of every asset above. It is
`sha256sum -c` compatible:

```sh
cd baselines/js-parity && sha256sum -c MANIFEST.sha256
```

## The two invariants

1. **Permanent** — every frozen asset still hashes to its `MANIFEST.sha256`
   entry. This holds forever, including after T05. Asserted by
   `crates/neo-os-games/src/parity.rs::frozen_js_parity_baseline_is_intact`
   and by `node scripts/freeze-js-parity-baseline.mjs --check`.
2. **Until T05** — every frozen asset is byte-identical to its live source.
   This is the drift alarm: edit a game wrapper or `router.js` without
   re-freezing and the gate fires. Once the live trees are deleted, invariant 2
   becomes a no-op and invariant 1 is the only remaining evidence — which is
   exactly why the freeze has to happen *before* the deletion.

## Operating rules

- **Never reformat anything in this directory.** `baselines/` is listed in
  `.prettierignore` and in the eslint `ignorePatterns` because a formatter that
  touches a byte of these files silently invalidates every hash derived from
  them. The assets are also excluded from `scripts/check-branding.mjs` (which
  only walks `apps/web`).
- **Re-freeze deliberately**:

  ```sh
  node scripts/freeze-js-parity-baseline.mjs            # re-freeze from the live sources
  node scripts/freeze-js-parity-baseline.mjs --check    # verify (exit 1 on drift)
  ```

  Re-freezing refuses to run when a live source has disappeared, so a post-T05
  run can never blank the baseline.
- **A wrapper edit is a two-step change.** Port the behaviour to the Rust
  engine, then re-freeze and commit the refreshed `MANIFEST.sha256` **in the
  same commit** as the `engineHash` re-pin. `registry.rs`'s drift test reads
  this directory, not the live tree, so an un-re-frozen edit fails there rather
  than panicking when the JS tree is gone.

## `engineHash` semantics

The 11 `engineHash` literals in `registry.rs` are **unchanged** and now mean
"engine behaviour version pin" rather than "sha256 of a JS file". The frozen
wrapper sources are the anchor that makes the pin auditable; see the comment on
`EngineHandle::engine_hash` in `crates/neo-os-games/src/registry.rs`.
