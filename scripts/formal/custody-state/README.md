# Custody Durable State Protocol Model

This is an executable SMT-LIB bounded state-machine model of the proposed custody
durability protocol. It is **not** a proof of the Rust signer, SQLite, AWS resource
policies, or a deployed coordinator. The production CAS/coordinator and complete
commit-before-release integration are not implemented by these files.

## Run

Requires Node.js 22-24 and an installed Z3 executable. No npm packages, credentials,
network calls, contract invocations, or AWS access are used.

```sh
node --test scripts/formal/custody-state/check.test.mjs
node scripts/formal/custody-state/check.mjs --z3 /opt/homebrew/bin/z3 --bound 14 --emit docs/reports/custody-durable-formal-20260911/bound14
```

Use `--json` for the full result and `--timeout-ms` for each solver query's timeout.
The runner exits nonzero for missing Z3, timeout, `unknown`, unexpected answers,
missing/reordered obligation IDs, malformed output, or missing SAT witnesses.
The emitted directory contains the exact SMT input, raw solver stdout/stderr, and
`result.json` with source hashes, solver version, bounds and decoded traces.

## State And Operations

One immutable vault/profile namespace has two enclave owners, two request IDs,
two distinct digests, one consensus slot and a shared authorization bit. A result
is the abstract pair `(request ID, digest)`, not actual cryptographic bytes.
Request results, authorization, audit and spend markers, and the reserved digest
are atomic members of each modeled full snapshot.

The coordinator holds HEAD generation/hash, independent snapshot fence, owner,
lease epoch and lease status. Each enclave holds a local snapshot, snapshot
fence, phase, epoch, pending commit ID and acknowledged receipt ID. Prepared
snapshots are immutable candidates that bind both their predecessor fence and
their creating lease epoch as the new fence; upload, submission, remote CAS,
receipt processing and output are separate transitions. A submitted request
persists outside the enclave, so it can commit after its caller crashes.
Crash clears only volatile enclave state. Timeout and client cancellation do not
silently undo a commit or permit another decision from the candidate state.

Restore reads the current HEAD. Lease admission independently checks that HEAD
still matches the restored generation/hash; interleavings can change it between
these transitions. Acquisition advances the epoch. Remote CAS checks both epoch
and owner, lease validity, and the exact previous generation/hash/snapshot fence.
Takeover changes the lease owner and epoch but preserves the committed snapshot
fence. Received
receipts can refer to any existing committed object, including a wrong prior
commit, but the correct protocol accepts only the exact pending object, owner and
epoch. Snapshot identity represents the complete authenticated metadata, object
version and result binding, not merely the human-readable generation number.

Cache output requires the authorized, ready owner. The model checks that its local
snapshot and result match current HEAD. Owner/lease checks at an output transition
represent a trusted coordinator authorization linearization point. Real response
delivery can occur later: this model does not claim revocation can retract an
already committed signature or suppress delayed network delivery.

## Safety Checks

- Every new signature output has the exact acknowledged committed decision.
- Its audit, spend marker and consensus reservation are present together.
- Cached output uses current committed authorization, state and exact result.
- Restored state matches HEAD at lease admission.
- Only the current epoch/owner with a live lease commits.
- Candidate generation follows the actual previous HEAD.
- Every commit consumes the exact predecessor snapshot fence and installs its
  creating lease epoch as the new snapshot fence.
- A committed request cannot switch to a different digest on output.
- Two output requests for the same consensus slot cannot use conflicting digests.

These are searches for a bad state in any execution prefix up to the requested
bound. Idle transitions permit shorter traces. Safety queries place the first
violation in the last step: prepending idle steps and consistently renaming
opaque object IDs can shift any shorter counterexample there. `unsat` means no counterexample
within that finite prefix bound under the stated assumptions; it is not induction
or a theorem about arbitrary execution lengths.

SAT coverage searches require concrete reachable executions for timeout recovery,
commit after crash, committed state restored into cache, rejected wrong receipts,
rejected restore races, cancellation with a completed remote commit, a second
owner taking over, and takeover after a non-genesis snapshot while preserving its
fence. Another coverage query requires both request IDs to be output,
so the conflicting-consensus check is not made vacuous by a one-signature bound.
They establish non-vacuity, not eventual progress or fairness.

Negative mutation controls weaken actual transition guards or snapshot contents:

- `early-release`: output is allowed before a committed receipt.
- `stale-restore-admission`: lease acquisition omits restored HEAD equality.
- `inexact-receipt`: any committed object's receipt is accepted for the pending
  operation.
- `omit-audit`: the candidate snapshot omits the signature audit marker.
- `omit-fencing`: CAS stops checking the candidate's owner and epoch.
- `rewind-generation`: CAS installs the previous generation instead of its successor.
- `rewind-snapshot-fence`: CAS leaves the predecessor fence installed instead of
  advancing it to the candidate's lease epoch.

Each control must be SAT and return a complete decoded counterexample. A green
run requires both the safe model and all mutation controls to behave as expected.

## Assumptions And Limits

Profile identity, AEAD validation, collision-free snapshot hashes, exact version
binding, NSM/session authentication and coordinator receipt authenticity are
ideal primitives in this model. Their correctness, key/nonce generation, full
SQLite schema coverage and policy parsing must be verified separately. Audit and
spend are presence markers; no asset value, rolling limit arithmetic or smart
contract is modeled. Authorization is a single revoke-only flag.

The coordinator is a trusted independent linearizable authority: the parent host
cannot write or reset HEAD, committed objects do not disappear or mutate, and
lease expiry uses trusted coordinator time. There is no multi-region replication,
clock arithmetic, Byzantine coordinator, signature forgery, scheduler fairness,
storage capacity, throughput, or disaster recovery implementation proof. The
solver uses unsigned eight-bit generation/epoch/object counters. The supported
bound is at most 40 transitions, each advancing a counter by at most one; hence
overflow cannot occur in a reachable modeled execution. Actual production
integer overflow must still be guarded separately.

Generation, epoch and owner transitions bind the design's state coordination and
commit barrier. D-01/D-02/D-03/D-04 cryptographic and infrastructure requirements
are assumptions, D-05/D-06 protocol interleavings are the modeled subject, D-07 is
this checker, and D-08/D-09 real restart, migration and production acceptance
remain external validation work. Source reference hashes record the files present
during a run; they are not a semantic binding from this model to those sources.

No release acceptance or financial safety claim follows from this model's PASS.
