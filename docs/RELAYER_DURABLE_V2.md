# Durable relayer v2 acceptance contract

The remediation is local development until the migration, import/reconciliation,
and fault-injection gates pass. No production rollout is implied.

- Discovery may advance only after every observed request is durable. Unresolved
  reads abort the contiguous range; they are never silently skipped.
- Every request entry point claims the same business key: network, chain,
  contract, request id. Lease time comes from PostgreSQL; all mutations require
  the current owner/generation. Renewal cannot resurrect an expired lease.
- Prepared results and signed transactions are persisted before broadcast.
  Unknown broadcast/confirmation resumes the same transaction, not compute.
- Delivery success records callback or job completion only. The system must
  never infer chain confirmation from delivery success. Chain confirmation
  requires the exact transaction identity and an independently validated
  receipt.
- The store, not the worker, is the completion authority. `completed` is
  refused unless the journal already holds the signed stage, the receipt hash
  equals the signed hash exactly, and the receipt state is HALT. RECONCILED
  settlement enters only through `reconciled` for unsigned request jobs and a
  finalized fault only through `faulted` against the signed hash. Journal
  stages must be objects with non-blank string `tx_hash`/`raw`; every refusal
  is SQLSTATE `22023` and leaves the row untouched, while lease loss stays
  `P0002`. This is enforced by
  `db/services/migrations/20260920102300_relayer_delivery_completion_identity.sql`
  and exercised on real PostgreSQL by `scripts/test-relayer-delivery-v2.sh`.
- Due time and terminal outcomes are enforced in the store. Replay is explicit.
- Account-level nonce ownership serializes sends across instances.
- A failed store/commit is degraded, not a successful tick. Backoff survives ticks.
- Work is bounded by batch/time budgets; shutdown stops new claims and resumes
  already-signed transactions from the journal on restart.

Local regression tests must include two workers racing an aged queued row,
stale-owner completion, renewal, crash after accepted broadcast, restart without
local state, future retry, terminal/dead-letter replay, DB outage across ticks,
and an unavailable RPC in the middle of a discovery range.

## Runtime and ownership

Set `MORPHEUS_DELIVERY_PROTOCOL=v2` for every production mode. The old local
protocol is permitted only outside production with
`MORPHEUS_ALLOW_LEGACY_LOCAL=true`. `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are required; a store failure cannot fall back to
local claims. Use the same network-scoped store for every writer.

`morpheus_delivery_jobs` keys include network, chain, contract, kind and request
id. Request discovery, scheduled feeds and XCM share one conservative
network/chain updater scope, including when a key id is rotated or aliased.
That scope permits one active owner and reserves signed unknown transactions
until they settle. Waiting unsigned kinds rotate by last claim time; an
unconfirmed signed transaction always takes precedence over another nonce.
Feed scheduling coalesces to one open update per datafeed contract.

The lease clock and generation belong to PostgreSQL. Claim, renewal and every
journal/terminal transition use database transactions and fencing predicates.
The lease is renewed while a bounded compute/signing stage runs. Losing the
lease prevents subsequent durable writes and broadcasts. Recovery can still
re-observe or resend the same previously durable signed bytes. The delivery
guarantee is recoverable at-least-once transport with chain idempotency; it is
not a claim of globally exactly-once computation.
Each new job freezes `maxRetries + 1` as its bounded attempt budget; receipt
observation of already signed bytes does not consume new compute attempts.

Events and prepared results have canonical base64 JSON bodies, preserving NUL
and other payload characters that JSONB cannot store directly. Searchable
identity/digest fields stay separate from these lossless bodies. Feed baselines
are committed with the confirmed feed receipt and read from the database after
restart. Local processed/dead-letter caches never override a v2 job's state.

## Safe cutover

1. Stop all old Rust and Node writers before migrating a network. A new binary
   cannot fence an old binary that still has external chain credentials.
2. Back up the existing state file and export `morpheus_relayer_jobs`, including
   transaction hashes, retries and dead letters. Preserve immutable copies.
3. Apply the additive migration
   `db/services/migrations/20260908040427_relayer_delivery_v2.sql` and its follow-up
   `db/services/migrations/20260920102300_relayer_delivery_completion_identity.sql`
   through the normal reviewed database release process. No migration has been
   applied to a remote database by the remediation task.
4. Configure v2 and run `neo-os-relayer config:validate`. The first v2 tick imports
   the local retry/dead-letter recovery lanes and legacy nonterminal DB jobs.
   Fresh, never-attempted queued rows may execute. Any prior attempt or known
   transaction hash is quarantined as `reconcile_required`; it must not be
   guessed to be unsent. Exported arrays can also be imported explicitly with
   `neo-os-relayer delivery:import /absolute/path/jobs.json`.
5. Inspect every quarantine. `delivery:reconcile JOB_KEY ACTOR REASON` reads the
   recorded transaction from the configured chain and commits only the observed
   HALT/FAULT result. `delivery:resolve-legacy JOB_KEY ACTOR REASON` is the explicit
   operator release for an imported unsigned unknown: first reconcile pending
   transactions and account nonces and record the evidence reference as REASON.
   It cannot clear a v2 signed journal.
6. `delivery:replay JOB_KEY ACTOR REASON` is permitted for unsigned dead letters
   or a signed attempt with matching finalized failure/expiry evidence. It
   archives the old journal before starting a fresh result/transaction attempt.
7. Start one v2 instance, verify durable progress and runtime health, then add
   replicas. Feed, request and XCM writers must all use this same protocol.

Existing precise local cursors seed the DB only when no durable cursor exists;
subsequent instances restore the DB cursor. To repair an older discovery gap,
use `delivery:rescan CHAIN FROM TO` with at most 1,000 block heights (N3) or
request IDs (NeoX) per invocation. Rescans re-enqueue through the same business
identity and do not advance or rewind the authoritative cursor.
Legacy feed baselines must come from the same network and contract deployment;
their initial DB seed never overwrites an already persisted baseline. Confirmed
partial feed updates merge by symbol so unchanged pairs retain their rounds.

CLI job keys contain JSON punctuation; quote the complete key as one shell
argument. Actor and reason are mandatory audit provenance. These commands need
the private service-role runtime and are not exposed to anonymous clients.

## Unknown and expired transactions

The observer makes one confirmation request per scheduled visit. It never
recomputes merely because confirmation is slow. A successful result from
`getRequest` can reconcile an already-settled request without inventing a
transaction hash; the journal records bound request-state evidence instead.

For N3 expiry, configure two independent archive nodes in
`MORPHEUS_N3_RECONCILIATION_ARCHIVE_RPC_URLS`. A fresh attempt is authorized only
when both nodes are past the signed validity height, agree on that canonical
block hash, and return the exact `getrawtransaction` unknown-transaction error.
The probe records hashed endpoint identities, not credential-bearing URLs.
This is explicitly an archive-RPC trust assumption, not a cryptographic proof.
The -103 response is defined by the [Neo RPC reference](https://docs.neo.org/docs/n3/reference/rpc/getrawtransaction.html).
Without this evidence the account remains quarantined. A timeout or arbitrary
RPC error is never treated as transaction absence.

EVM pending transactions keep their exact nonce, calldata and signed bytes.
The implementation does not automatically increase fee spending or discard a
pending nonce. Operators should observe/reconcile the recorded transaction;
an unsupported replacement must not be implemented by deleting its journal.

## Verification and rollback

Run locally:

```bash
cargo test -p neo-os-chain-evm -p neo-os-chain-n3 -p neo-os-relayer-store -p neo-os-relayer --locked
bash scripts/test-relayer-delivery-v2.sh
cargo clippy -p neo-os-chain-evm -p neo-os-chain-n3 -p neo-os-relayer-store -p neo-os-relayer --all-targets --locked -- -D warnings
```

The SQL script creates a temporary local PostgreSQL cluster on a private Unix
socket, tests service-role permissions and two real database sessions, and
removes the cluster on exit. It does not load application `.env` files.
The production Compose healthcheck now checks the running worker's recent
progress/failure file; configuration validation remains a startup preflight.

Rollback keeps the new tables and journals. Stop new claims and use the v2
observer to settle signed work; retain replay/reconciliation history. Do not
restore an older local JSON snapshot and start an old writer against outstanding
v2 transactions. Schema removal is not an emergency rollback mechanism.
