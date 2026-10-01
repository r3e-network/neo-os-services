# Services validation receipt

This receipt binds the services candidate to the validation run. It records
the exact base commit and source hashes without containing credentials.

## Tree identity

- Base `HEAD`: `bb99c2d624cd9422e836ce7241dd085a1262063c`
- Tracked diff SHA-256 before this receipt was added:
  `eb8ba8a0403eb61aa16f1d5c3bec22af2744c6608ba782e11d799b826d3a41bd`
- The tracked diff hash excludes this receipt; the per-file hashes below bind
  the source files reviewed by the independent reviewer.

| File                                                | SHA-256                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `Cargo.lock`                                        | `8f334ae5258a1144186f9222d40570a77939162278e46db830d5e7ec5d9d4d71` |
| `crates/neo-os-compute/src/js.rs`                   | `019756cc5be7f9fd1c0f9d18a13650565390043028c00f2ee83a986d3a296854` |
| `crates/neo-os-core/Cargo.toml`                     | `f717b21bfc5a96aaa94c18bef3bf023aebea3b737144f4d8a0ff8a4ee901603f` |
| `crates/neo-os-core/src/js_number.rs`               | `d113851282922d96b4464b37ce767f054c2fc9407655b8bab31d73b5119a9773` |
| `package-lock.json`                                 | `8b600feb302a4b149c7719a0e71a070e3228b862b679f689145c2d0146ff519b` |
| `scripts/dependency-security.test.mjs`              | `b1a0188cee8f2d5dbb536d3c78e1df78e3529c50e34d3e3ae10fcff378770426` |
| `workers/nitro-enclave-host/src/dispatch.rs`        | `8febb1bba6ee15b180a9ed7c5e85a92746b02eb487a7f74d71844b84808a19c8` |
| `workers/nitro-enclave-host/tests/unit/dispatch.rs` | `f693b43c66bad116b023184599848f411d294fad32ae0f1240767ea7cff0aa9a` |

## Commands and results

The commands below were run from this exact worktree with Node 24.4.1,
`npm@10.9.2` for lockfile generation, and the repository's Rust toolchain.

| Command                                                                                          | Result                                                                                                                |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `cargo test -p neo-os-core --all-targets --locked`                                               | exit 0; 82 unit tests and all integration targets passed                                                              |
| `cargo clippy -p neo-os-core --all-targets --locked -- -D warnings`                              | exit 0                                                                                                                |
| `cargo test -p neo-os-compute --lib js::tests --locked`                                          | exit 0; 14 JavaScript compatibility tests passed                                                                      |
| `cargo test -p nitro-enclave-host --all-targets --locked`                                        | exit 0; 314 tests passed                                                                                              |
| `node --test scripts/dependency-security.test.mjs`                                               | exit 0; 8 tests passed                                                                                                |
| `MINIGAMES_ROOT=/Users/jinghuiliao/git/neo-os/neo-os-minigames node --test 'scripts/*.test.mjs'` | exit 0; 400 tests passed                                                                                              |
| `git diff --check`                                                                               | exit 0                                                                                                                |
| `cargo fmt --all -- --check`                                                                     | exit 0                                                                                                                |
| `npm audit --audit-level=high --omit=dev`                                                        | exit 0; 0 vulnerabilities                                                                                             |
| `cargo audit`                                                                                    | exit 1 as expected: `rsa 0.9.10` / `RUSTSEC-2023-0071`; no upstream fixed release; two existing unmaintained warnings |

The complete affected Node CI sequence also passed separately: catalog parity,
web consistency, format, lint, module imports, gitignore protections,
migration/topology, Cargo lock provenance, Rust dependency floors, NeoDID pin,
network identity projections and consumers, release gating, and Rust vectors.
The NeoDID check used a temporary checkout at the exact pinned commit and did
not modify the sibling checkout or the game repository.

## Cross-runtime and mutation evidence

- A deterministic Rust corpus of 20,000 rows was compared with Node/V8
  `String(number)` for both positive and negative values. Corpus SHA-256:
  `185d5de1a98e37e2e2cf31d78295fcdf00f5b8290a6446243eb6368a351a1d0c`.
  The comparison command reported `checked=20000 mismatches=0`.
- Replacing the ECMAScript formatter with ordinary exponent formatting caused
  `js_number::tests::matches_ecmascript_forms` to exit 101.
- Replacing the radix bit bound with `bits > 1` caused the finite `0x1f`
  assertion to exit 101.
- Replacing every patched `brace-expansion@5.0.12` lock entry with `5.0.9`
  caused the dependency policy test to exit 1 and identify the vulnerable
  package path.
- The release benchmark over 50,000 deterministic values measured 4.07 ms for
  the `ryu-js` formatter versus 33.45 ms for the former formatter.

## Open advisory

`cargo audit` still reports the RSA Marvin timing advisory because `rsa 0.9.10`
has no fixed upstream version. This is explicitly open for the owner/security
decision; it is not masked by the npm remediation and no production change was
made as part of this validation.
