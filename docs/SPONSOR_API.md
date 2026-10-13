# The sponsor API

One route that accepts a sponsored intent, journals it before anything is
broadcast, and answers with a journal id and a HALT-confirmed receipt.

This is the DELIVER sponsor lane's request surface (`SVC-U02c`). It replaces the
five hot-key payers in `explorer/api/sponsor.js`, `explorer/api/relayer.js`,
`web/pages/api/rpc/sponsor.ts`, `web/lib/onegate-vault-tx-proxy.ts` and
`aa/frontend/api/relay-transaction.js` once the callers are migrated.

## Route

```
POST /sponsor/intent
POST /<network>/sponsor/intent
```

One optional leading path segment names the network, matching the host's
`matches_route` rule (`workers/nitro-enclave-host/src/routes.rs`): the route
exactly, or with a single prefix segment. `POST` only; every other method is a
404 like an unknown path.

### Headers

| header | required | meaning |
| --- | --- | --- |
| `Idempotency-Key` (or `x-idempotency-key`) | yes | 1–128 characters. The durable identity of this request. |
| `x-neoos-principal` | yes | The principal the authenticated hop established. Configurable via `sponsor.principalHeader`. |

**There is no principal in the body.** The principal arrives from the hop in
front of this service and is handed to the state machine as a typed value. Until
`ACCESS PrincipalAssertion` reaches `neo-os-services` there is nothing in this
repository that can verify an assertion, so the hop binding
(`sponsor_api::HopPrincipal`) is the seam that claim sits behind — see
[Limitations](#limitations).

### Body

```json
{ "envelope_hex": "00…" }
```

One field. `envelope_hex` is the unsigned Neo N3 transaction envelope, hex
without a `0x` prefix. Every other JSON field is **ignored**, on purpose: a
declared `principal`, `fee_ceiling_units`, `method` or `target` must not be able
to become a fact.

Everything the sponsor pays for is read out of those bytes:

| fact | where it comes from |
| --- | --- |
| the invocation script | the envelope's `script` |
| the sponsor account | the envelope's signer |
| the transaction fee | `SystemFee + NetworkFee` in the envelope |
| the transaction hash | the envelope's own hash |
| the reimbursement claim | the `reimbursementAmount` argument inside the script |

The envelope must be exactly the shape
`neo_os_core::n3_tx::FeedTx::serialize_unsigned` emits — version 0, one signer,
`CalledByEntry` scope, no attributes, canonical `num2VarInt` script length, and
nothing after the script. Anything else is refused rather than half-parsed. The
invocation script must decode to one `System.Contract.Call` of `registerAccount`
or `executeSponsoredUserOp` at the configured sponsorable contract, checked by
`neo_os_core::sponsor_intent::validate_sponsorable_intent` (CU-150).

## Responses

### 200 — a confirmed receipt

```json
{
  "code": "SPONSOR_CONFIRMED",
  "journal_id": "[\"testnet\",\"neo_n3\",\"0x…\",\"sponsor\",\"0x…\"]",
  "tx_hash": "0x…",
  "vm_state": "HALT",
  "transaction_fee_units": 1250,
  "reimbursement_units": 0,
  "sponsor_fee_units": 1250,
  "replayed": false
}
```

`SPONSOR_FAULTED` is also a 200: the transaction was confirmed and it faulted.
A fault is a completed outcome the sponsor paid for, not a failure to submit.
`replayed` is `true` when nothing was reserved, signed or sent for this request
because the journal already held the answer.

### 202 — `SUBMISSION_UNKNOWN`

```json
{
  "code": "SUBMISSION_UNKNOWN",
  "journal_id": "[…]",
  "tx_hash": "0x…",
  "vm_state": null,
  "transaction_fee_units": 1250,
  "reimbursement_units": 0,
  "sponsor_fee_units": 1250,
  "replayed": false
}
```

The outcome of the send could not be established: a timeout, an ambiguous node
error, or a receipt that never appeared within the observation budget. **Do not
resubmit and do not re-sign.** Carry the `journal_id`; the job is parked
`broadcast_unknown` and the same signed transaction is what will be resumed. A
retry of the same request with the same `Idempotency-Key` returns this same
state without paying again.

### Refusals

| status | `code` | when |
| --- | --- | --- |
| 503 | `SPONSOR_DISABLED` | the kill switch is halted |
| 401 | `SPONSOR_PRINCIPAL_REQUIRED` | no principal reached the surface |
| 400 | `SPONSOR_REQUEST_INVALID` | the body or the envelope could not be understood, or the intent validator refused (see `intent_code`) |
| 400 | `SPONSOR_IDEMPOTENCY_KEY_REQUIRED` | missing or blank key |
| 409 | `SPONSOR_IDEMPOTENCY_CONFLICT` | the key already names a different intent |
| 429 | `SPONSOR_BUDGET_EXHAUSTED` | a budget cap refused the reservation |
| 500 | `SPONSOR_JOURNAL_REFUSED` | the durable record refused or disagreed |
| 500 | `SPONSOR_RECEIPT_MISMATCH` | a receipt came back for a transaction other than the signed one |
| 502 | `SPONSOR_SEND_REFUSED` | the signature or the send was refused and nothing is in flight |

```json
{
  "code": "SPONSOR_IDEMPOTENCY_CONFLICT",
  "detail": "this idempotency key already names a different intent"
}
```

An intent refusal carries the validator's own code, verbatim, in `intent_code`:

```json
{
  "code": "SPONSOR_REQUEST_INVALID",
  "detail": "SPONSOR_INTENT_FEE_OVER_CEILING: the sponsor would pay …",
  "intent_code": "SPONSOR_INTENT_FEE_OVER_CEILING"
}
```

Branch on `code`, and on `intent_code` when it is present. `detail` is for logs
and operators and is not a stability surface. The complete vocabulary is frozen
by `the_api_code_table_is_frozen` and `the_refusal_code_table_is_frozen`.

## The commit protocol

One request, in this order:

```
reserve          the intent is journalled and the budgets are debited
stage:prepared   the derived facts and the reserved fee ceiling
sign             the custody witness is produced
stage:signed     the signed bytes are journalled
broadcast        the journalled bytes are sent
stage:completed  the HALT receipt is journalled   (or stage:faulted / stage:retry)
```

Nothing reaches the network before `stage:signed` is durable. A crash at any
point is safe, and each state is covered by a test in
`workers/neo-os-relayer/tests/sponsor_api.rs`:

| crash point | what a retry does |
| --- | --- |
| before `reserve` | reserves normally; nothing has been spent |
| after `reserve`, before `sign` | finishes the **same** reservation; one reservation, one payment |
| after `stage:signed` | resends the **journaled** bytes; never re-signs |
| after a confirmed receipt | answers from the journal; touches neither the store's stages nor the send port |

Idempotency is the store's, not the API's. `morpheus_delivery_sponsor_reserve`
writes the intent, debits the three budgets and enqueues the bound delivery job
in one database transaction, returns the original job on an identical retry and
raises `22023 sponsor idempotency conflict` on a different one. The API routes
every request through that one primitive and never invents a second spend path.
Reservations are charged for every outcome and are never released.

## The kill switch

`sponsor.enabled` is **`false` unless it is explicitly set to `true`**. While it
is halted, a request is refused with `SPONSOR_DISABLED` (503) and nothing is
journalled, reserved or sent. The switch is read before the principal, so a halt
always wins.

Opening it is a configuration change and nothing else: the identical request
that was refused a moment earlier is accepted.

## Configuration

Under `sponsor` in the relayer configuration:

| key | default | meaning |
| --- | --- | --- |
| `host`, `port` | `127.0.0.1:9465` | where the route listens |
| `contract` | — | the one sponsorable contract, `0x` + 40 hex, display order |
| `feeCeilingUnits` | — | approved ceiling for one intent, GAS datoshi (1–20000000) |
| `enabled` | `false` | the kill switch |
| `leaseMs` | `60000` | the delivery lease a request takes for its own commit |
| `confirmAttempts`, `confirmWaitMs` | `5`, `1000` | application-log polling |
| `principalHeader` | `x-neoos-principal` | the hop header carrying the principal |

Plus the existing relayer keys: `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` for
the delivery store, `nitro.custodyUrl` / `nitro.custodyToken` for the signer
service, `neo_n3.rpcUrls` for the chain, and `neo_n3.custodyKeyIds.sponsor` (or
`nitro.sponsorCustodyKeyId`) for the sponsor key.

The sponsor account the transaction must name is derived from the custody key
identity at startup. An envelope that names any other fee payer is refused
before the signature is taken.

## Running it

```
neo-os-relayer serve:sponsor
```

The lane is Neo N3 only. The envelope, the custody call and the application log
are all N3, and the delivery schema fixes a sponsor job's chain to `neo_n3`.

## Limitations

- **The hop header is not an assertion.** `HopPrincipal` reads a header the
  authenticating hop sets. Exposed directly, it is not a claim of
  authentication and must not be deployed without that hop. Replacing it with a
  verified `ACCESS PrincipalAssertion` is the open item.
- **The signature boundary is not here.** Which key, which contract and which
  methods it may sign is CU-152's custody policy. This surface signs one
  transaction per request through the configured sponsor key and refuses an
  envelope whose fee payer is not that key.
- **No end-to-end chain proof in this slice.** CU-153 drives this API against a
  private chain with a faked signing endpoint.
- **Only Neo N3.** A Neo X sponsor lane needs a different envelope and a
  different receipt shape.
