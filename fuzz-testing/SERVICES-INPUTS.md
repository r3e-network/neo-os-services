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

Each suite prints one `SERVICES_INPUTS_RECEIPT` line with the seeds it explored,
the per-target case counts and the outcome counters. The runner parses both
receipts and fails when a suite printed none, when the seeds differ from the
committed list, when fewer than 100 cases per seed were explored, or when the
generator produced only one shape of input. A workflow change that stopped the
suite from running therefore fails the job instead of passing it.

For a ten-minute local run, run the same command at low priority with **300** as
the final argument: `nice -n 15 node fuzz-testing/run-services-inputs.mjs <build-log> 300`.
This runs each suite for at least five minutes, serially. Background the command,
retain the output and reap the process. Failed inputs should be reduced by deleting
fields/array elements and shortening strings or bytes while preserving the failure;
keep each production fix and its minimal regression in a separate commit.

Coverage:

- Relayer JSON request bodies, raw-text fallback for truncated or malformed text,
  the null body, kernel-intent routing, operator-only feed classification, the
  payload `target_chain`/`requester` binding (an explicit context value wins),
  delivery request-id/module binding and digest separation between request ids,
  results and envelope tuples.
- Delivery prepared-fulfillment records: retry metadata and callback-pending
  worker responses keep their field types for arbitrary prepared values, and a
  record without a trust tier takes the enclave tier default.
- Confidential-envelope structure and malformed CBOR/COSE signed-payload decoding.
  Explicit `cbor:`/`cose:` Error rejections are expected; native exceptions fail.
  A non-Buffer input is rejected by the decoder's own Error as well.
  This checks parsing, not cryptographic signature verification.
- Node decimal price parsing and round trips; feed timestamp clamping (both the
  accepted and the rejected branch) and its monotonicity bound.
- Rust decimal parsing/formatting including non-ASCII input, Unicode and nested
  Neo stack items, feed symbol normalization.
- Rust sponsor authorization over arbitrary gas/account/target values with the
  policy disabled, gas-cap boundaries, and missing-principal rejection when
  enabled. A valid enabled policy is a positive control.
- The exported Node sponsor entry point refuses arbitrary request bodies without
  throwing.

Boundaries. JSON depth is capped at three, generated strings at 47 characters,
and random CBOR at 95 bytes; this is a bounded robustness check, not exhaustive
validation of every service handler. The Rust sponsor test does not exercise
journal or budget persistence, and the Node sponsor entry point cannot reach the
policy decision without enclave signing material, so only its refusal path is
asserted there. `integerToDecimalString` (Node) and `integer_to_decimal_string`
(Rust) apply the JavaScript `slice(0, -0)` quirk when `decimals` is 0 and pass
non-digit input through; no production call site passes either, and a fix would
have to change both ports together. New failures outside this slice belong in dated
evidence with their minimal input; they must not be silently swallowed or allowed
to pass.
