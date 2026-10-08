# Randomized services inputs

This offline suite calls production parser and validator functions. It uses the
existing seeded approach without adding dependencies: xorshift32 in Node and
`rand::rngs::StdRng` in Rust, pinned by Cargo.lock. Both run seeds **20261005**,
**20260928**, and **4294967295**. `FUZZ_SEED` selects one stream. Failure output
includes its seed, zero-based case index and generated input. Replay on the same
commit and lockfile; generators do not depend on the clock (only run length does).

Build and run the CI budget from the repository root:

```sh
cargo test --locked -p neo-os-compute --test randomized_inputs --no-run --message-format=json > /private/tmp/services-randomized-build.json
node fuzz-testing/run-services-inputs.mjs /private/tmp/services-randomized-build.json
```

The build is separate from the randomized budget. The runner executes Node and
Rust serially with a combined 55-second watchdog, including process startup. Each
normally explores for three seconds. It exits nonzero on a counterexample, native
exception, panic, hang or child failure. The Rust test process is single-threaded;
HTTP is replaced by a panic-on-use transport. The selected Node functions perform
no I/O. No credentials, signing operation, database or chain is needed.

For a ten-minute local run, run the same command at low priority with **300** as
the final argument: `nice -n 10 node fuzz-testing/run-services-inputs.mjs <build-log> 300`.
This runs each suite for at least five minutes, serially. Background the command,
retain the output and reap the process. Failed inputs should be reduced by deleting
fields/array elements and shortening strings or bytes while preserving the failure;
keep each production fix and its minimal regression in a separate commit.

Coverage:

- Relayer JSON request bodies, malformed-text fallback, kernel-intent routing and
  operator-only feed classification; delivery request-id/module binding and digest
  separation between request ids.
- Confidential-envelope structure and malformed CBOR/COSE signed-payload decoding.
  Explicit `cbor:`/`cose:` Error rejections are expected; native exceptions fail.
  This checks parsing, not cryptographic signature verification.
- Node decimal price parsing and round trips; Rust decimal parsing/formatting,
  Unicode, nested Neo stack items and feed symbol normalization.
- Rust sponsor authorization over arbitrary gas/account/target values with the
  policy disabled, gas-cap boundaries, and missing-principal rejection when enabled. A valid enabled
  policy is a positive control. It does not exercise journal/budget persistence or
  owner-configured on-chain AA hook policies.

JSON depth is capped at three, generated strings at 47 characters, and random CBOR
at 95 bytes. Fixed valid fixtures and near-valid malformed envelopes complement
random values. This is a bounded robustness check, not exhaustive validation of
all service handlers. New failures outside this slice belong in dated evidence
with their minimal input; they must not be silently swallowed or allowed to pass.
