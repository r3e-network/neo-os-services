# NeoOS Signer Service v2

Status: implemented security contract and continuing migration specification. The
existing v1 API remains compatible while later operational hardening is delivered in
independently deployable increments.

## Overview

NeoOS Signer is the Rust trust boundary that holds Neo private keys and decides
whether each requested signature is allowed. The measured AWS Nitro image contains
the signer, policy engine, transaction parser, audit journal, and key-encryption
code. A web application, relayer, node, operator console, or `neo-nexus` instance
never receives an exportable private key after custody has accepted it.

The service is not a generic signing oracle. It accepts an operation it can parse,
evaluates the policy attached to the selected key, reserves all state needed to make
the decision atomic, signs inside the enclave, and records the result before returning
the witness.

The initial integration consumer is `neo-nexus`:

- `neo-os-services/workers/neo-signer` owns custody and policy.
- `neo-nexus/src/signer_client` owns only the HTTP client and wire types.
- `neo-nexus/src/web/pages/signer.rs` is the operator UI.
- `neo-nexus` must not open, derive, persist, export, or cryptographically operate on
  a custody private key.

### Security invariant

> No component can produce a valid signature from a custody key unless the measured
> Rust signer authenticated the caller, parsed the intent, atomically evaluated the
> key policy, and durably recorded the decision.

### Delivery status

The current source already implements Rust P-256 custody, Neo N3 transaction parsing,
contract/asset/recipient allow and deny lists, per-transfer and rolling value limits,
caller bearer tokens, exact Origin binding, audit rows, KMS recipient-attested master
key release, and a Rust-only custody EIF.

Implemented in the first v2 increment:

1. signing decisions are serialized with policy/key/caller mutation, and one signer
   process exclusively leases a data directory;
2. an allowed audit row and its rolling-value reservations commit atomically before
   the witness is returned; when a request id is supplied, the completed public witness
   commits in that same transaction and exact retries survive restart without charging
   either value or signature capacity again;
3. Neo N3 v3.10.1 dBFT bodies are parsed to their exact wire shape. PrepareRequest and
   PrepareResponse share one proposal checkpoint, Commit reservations are independent
   of view, and slots are keyed by immutable public key plus network magic. A slot is
   durably reserved before private-key material is opened; exact retries are idempotent
   and conflicts survive restart as `consensus-equivocation`;
4. policy now includes exact contract-method allow/deny lists, signer-count ceilings,
   system/network fee ceilings, and a key-wide rolling signature-rate ceiling shared
   by every signing route, plus per-asset single and multi-window value ceilings; all
   are covered by the attested boundary digest;
5. Ed25519 workload identities bind caller, subject, method, route, exact body,
   timestamp, nonce, and Origin, with durable one-time nonce enforcement;
6. `neo-nexus` is a client-only consumer with fail-closed endpoint validation,
   file-backed bearer/workload credentials, a non-secret operator page, and a
   real-process cross-repository contract test.
7. the measured Rust host executes the migrated compute, oracle-read, and NeoDID
   fulfillment lanes in-process; its Node child, loopback bridge, and passthrough
   manifest are removed, and unmigrated lanes refuse without I/O;
8. oracle X25519/HKDF/AES-GCM ownership is consolidated in
   `neo-os-compute::oracle::crypto`, with one client/Rust golden vector, while
   `neo-signer` delegates Base58Check to the maintained `bs58` crate.
9. raw signing has its own `raw_sign` caller capability. A policy with `allow_raw`
   cannot also grant transaction or consensus authority; raw compatibility consumers
   use dedicated raw-only keys.
10. each attested key boundary commits the numeric `network_magic`, and key-management
    API/client responses expose the same value.
11. signed compute, oracle, and NeoDID lanes require a healthy custody key on the
    selected network. Missing, disabled, mismatched, incomplete, or unreachable custody
    returns 503; a successful response never carries a null signature or public key.

The remaining v2 work is:

1. add a direct import tool that verifies enclave identity before sending any
   private key or passphrase; `neo-nexus` never relays those secrets;
2. make Nitro state durable, authenticated, and rollback-detectable;
3. add conservative pre-sign pending reservations and explicit failed/completed
   checkpoints for hardware signers that are not deterministic;
4. retire the separate Node compatibility image and its remaining JavaScript engine
   adapters only after deployment consumers reach zero and byte-for-byte parity gates
   pass; it is no longer linked into the measured Rust EIF.

## Threat model

### Protected assets

- Neo N3 P-256 private keys and future Neo X secp256k1 private keys.
- Caller credentials and workload-identity bindings.
- Per-key policies, rolling-spend state, and consensus reservations.
- Audit history and the monotonic state revision.
- The mapping between a public key, network magic, owner, and permitted operations.

### Adversaries

- an internet caller with no credential;
- a caller with a valid credential for the wrong key or operation;
- malicious browser content that obtained a bearer token;
- a compromised relayer, `neo-nexus`, or other consumer;
- concurrent callers attempting to exceed a limit;
- a host administrator controlling the Nitro parent, storage, network, and process
  lifecycle but not AWS NSM or an attestation-gated KMS plaintext;
- a host replaying an older encrypted vault snapshot;
- malformed Neo transactions, scripts, consensus payloads, or oversized requests.

### Explicit non-goals

- protecting an operator who deliberately changes the KMS policy to admit a malicious
  EIF;
- multisig, MPC, or threshold signing in this version;
- transaction construction or broadcast by the signer;
- interpreting scripts that require dynamic VM execution or chain state;
- treating TLS alone as proof that an endpoint is an enclave.

Availability loss is preferable to an unbounded signature. Unknown input, stale state,
failed persistence, unavailable attestation, and ambiguous identity all fail closed.

## Architecture

```text
consumer / neo-nexus / node
        |
        | HTTPS or loopback + caller authentication
        | fresh attestation verification for secret import
        v
Nitro parent (untrusted transport and encrypted-state carrier)
        |
        | AF_VSOCK
        v
Rust custody EIF
  axum API
    -> caller/workload authentication
    -> key grant and owner boundary
    -> Neo intent parser
    -> policy + anti-equivocation decision
    -> atomic SQLite reservation/audit transaction
    -> P-256 or secp256k1 signer
    -> authenticated durable-state checkpoint
```

### Trust-boundary rules

1. Sign parsed intent, never a caller-selected digest.
2. `sign/raw` is an internal compatibility primitive, disabled by default and guarded
   by the route-specific `raw_sign` caller capability. `allow_raw` is invalid on any
   key whose policy also enables consensus, transfer, contract-call, or global-scope
   authority. Compatibility callers use dedicated raw-only keys.
3. Each key stores its network magic; the request cannot override it.
4. Blacklists win over whitelists.
5. Empty permission lists do not grant a capability. Explicit operation switches start
   closed.
6. Authentication, key grant, policy, rolling limit, consensus reservation, audit, and
   state checkpoint are one decision path. A caller cannot invoke a shorter path.
7. An admin credential cannot sign and a signing credential cannot administer.
8. The parent host may carry ciphertext but cannot choose plaintext keys, policies,
   runtime trust anchors, or state revisions.

## Policy model

Every key has an owner boundary, operation switches, and limits.

### Existing v1 fields

- `allow_consensus`
- `allow_raw`
- `allow_transfer`
- `allow_contract_call`
- `allow_global_scope`
- `contract_whitelist` / `contract_blacklist`
- `asset_whitelist` / `asset_blacklist`
- `transfer_to_whitelist` / `transfer_to_blacklist`
- `max_single_amount`
- `window_limit { seconds, max_amount }`, counted independently per asset

### v2 fields

- `contract_method_whitelist` / `contract_method_blacklist`, entries written as
  `<script-hash>:<method>`;
- `max_network_fee` and `max_system_fee`;
- `max_signatures { count, seconds }`;
- `asset_limits`, an array of
  `{ asset, max_single_amount?, window_limit?: { seconds, max_amount } }`;
- `consensus { allowed_message_types, max_future_height, anti_equivocation }`;
- `raw_domains`, an explicit closed list for internal domain-separated messages;
- `owner`, an immutable tenant or operator subject used by management grants.

Legacy amount fields remain valid. A matching `asset_limits` entry is more restrictive:
both the legacy and every matching asset-specific check must pass. Multiple entries
for one asset are allowed so an operator can enforce, for example, both hourly and
daily windows; exact duplicates are normalized away.

`allow_raw` is a role boundary, not an extra permission on a semantic key. Saving a
policy that combines it with `allow_consensus`, `allow_transfer`,
`allow_contract_call`, or `allow_global_scope` is rejected. A raw-only key may still
use the shared signature-rate ceiling, but transaction/consensus routes cannot use it.

### Atomic accounting

The old read-evaluate-sign-write sequence permits two concurrent requests to read the
same rolling total and both pass. v2 serializes a key's policy decision in a SQLite
`BEGIN IMMEDIATE` transaction:

1. load the current policy and unexpired reservations;
2. parse and evaluate the complete request;
3. reserve spend/signature/consensus slots;
4. append the pending audit record;
5. commit;
6. produce the signature;
7. atomically mark the audit record completed and checkpoint durable state.

If signing fails after reservation, the row is marked failed but the conservative
reservation remains charged until its window expires. Returning capacity after an
uncertain signing result would let a caller retry a signature that may already exist.

### Consensus anti-equivocation

The signer parses the seven-byte dBFT consensus header:

```text
message_type:u8 | block_index:u32-le | validator_index:u8 | view_number:u8
```

Only known dBFT message types are accepted. `valid_block_start` must be zero and
`valid_block_end` must equal `block_index`. The complete v3.10.1 body is consumed:
PrepareRequest has version/previous hash/timestamp/nonce/a duplicate-free transaction
hash array, PrepareResponse has exactly one 32-byte PreparationHash, and Commit has
exactly one 64-byte block signature. Truncation, trailing bytes, and malformed arrays
are refused before custody opens the key.

```text
public_key / network_magic / block_index / phase / normalized_view
```

`validator_index` is stored and must also match for an exact retry, but it is
deliberately not part of the slot key: it is caller-controlled wire data and
must not let one public key open parallel equivocation slots by changing the
claimed committee position.

PrepareRequest's checkpoint is the hash of its unsigned ExtensiblePayload; a
PrepareResponse checkpoint is its PreparationHash. Both occupy the same `prepare`
phase slot for a validator and view. Commit occupies one height-wide `commit` slot and
normalizes the view out of the key because a validator must not commit two blocks at
one height by changing view; its checkpoint is SHA-256 of the 64-byte block
signature.
Repeating a checkpoint is idempotent; another checkpoint is
`consensus-equivocation`. The reservation is inserted before signing, so a crash or
persistence failure cannot leave an unreserved signature. Change-view and recovery
traffic is parsed and audited but does not consume an equivocation slot.

## Authentication and consumer identity

### Bearer caller

Bearer mode remains:

- only `SHA-256(token)` is stored;
- admin callers have only `admin`; signing callers may hold `sign`, `raw_sign`, or
  both, but each route checks its own capability;
- a caller has `Any` or an explicit set of key grants;
- a browser caller must exactly match one configured `Origin`;
- a server-to-server caller has no origins and rejects requests carrying one.

Origin is an additional browser constraint, not proof of server identity. `Referer` is
reduced to its origin and is consulted only when `Origin` is absent.

### Workload identity

v2 also accepts a short-lived signed caller assertion. A caller record pins an Ed25519
public key and optional subject. The request carries:

- `X-NeoOS-Caller`
- `X-NeoOS-Timestamp`
- `X-NeoOS-Nonce`
- `X-NeoOS-Signature`

The signature covers the protocol version, HTTP method, exact route, SHA-256 request
body, timestamp, nonce, and Origin. The service enforces a bounded clock skew and stores
the nonce before acting, so a captured request cannot be replayed. Bearer and workload
identity are alternative authenticators; supplying both is rejected.

OIDC and mTLS terminate at an identity gateway only when that gateway uses its pinned
workload key to make this assertion. Unsigned `X-Forwarded-User`, client-certificate,
or proxy identity headers are never trusted.

### Endpoint authentication

`neo-nexus` accepts cleartext signer URLs only on loopback. Before a raw-key or NEP-2
import, it obtains `/attestation?nonce=...` and verifies:

- the COSE Sign1 signature and X.509 chain to the pinned AWS Nitro root;
- freshness and nonce equality;
- PCR0/1/2 against the selected release manifest;
- runtime name `neo-signer-custody`;
- the expected vault fingerprint;
- the boundary document digest and nondecreasing state revision.

TLS authenticates the network endpoint; Nitro attestation authenticates the code and
vault behind it. Both are required for a remote import.

## Durable Nitro state

The current enclave root filesystem is memory-backed. v2 treats an attested deployment
without a durable state backend as development-only and refuses key import/generation
and consensus signing.

The enclave checkpoints the complete SQLite image as an AEAD envelope under a key
derived from the KMS-released master key. The envelope contains:

- format version;
- vault fingerprint;
- monotonically increasing state revision;
- previous checkpoint digest;
- SQLite bytes;
- creation time.

The parent stores only the ciphertext. Every mutation and allowed signing decision must
receive a successful compare-and-swap checkpoint before the response is released.
Rollback is detected by pinning the highest observed revision and chain digest in the
consumer/operator state and by an append-only remote revision anchor. A missing,
conflicting, or lower revision seals the signer instead of starting from an empty vault.

Backups copy ciphertext only. Restore requires the same KMS key, a matching vault
fingerprint, a valid revision chain, and an explicit operator recovery ceremony. There
is no private-key export API.

## API Reference

The v1 routes in `docs/SIGNER_SERVICE.md` remain available.

### Signing

```text
POST /signer/api/v1/sign/transaction
POST /signer/api/v1/sign/consensus
POST /signer/api/v1/sign/raw
GET  /signer/api/v1/keys/{key_id}
```

Transaction and consensus requests:

```json
{
  "key_id": "key-...",
  "unsigned_hex": "<SerializeUnsigned bytes>",
  "request_id": "caller-generated-idempotency-id"
}
```

Raw requests use the same optional field beside `key_id` and `data_hex`.
They require `raw_sign`, while transaction and consensus requests require `sign`.
Key identity reads accept either signing capability for a granted key.
`request_id` is additive and optional for v1 callers. It is 1–128 ASCII
letters, digits, `.`, `_`, `:`, or `-`, scoped to the authenticated caller, and
binds the route, key id, and exact bytes. The completed public witness is stored
atomically with its allowed audit and value reservations. Reuse with identical
bytes returns that witness without consuming value or signature capacity again;
reuse with different bytes, routes, or keys is `request-id-conflict` (`409`).
A transport timeout is still an unknown result; clients retry only when they
supplied the same request id.

### Management

```text
POST   /signer/api/v1/keys
POST   /signer/api/v1/keys/import
POST   /signer/api/v1/keys/import-nep2
GET    /signer/api/v1/keys
GET    /signer/api/v1/keys/{id}/policy
POST   /signer/api/v1/keys/{id}/policy
POST   /signer/api/v1/keys/{id}/state
DELETE /signer/api/v1/keys/{id}
POST   /signer/api/v1/callers
GET    /signer/api/v1/callers
POST   /signer/api/v1/callers/{id}/rotate
POST   /signer/api/v1/callers/{id}/state
DELETE /signer/api/v1/callers/{id}
GET    /signer/api/v1/audit
```

### Enclave identity and state

```text
GET  /health
GET  /attestation?nonce=<hex>
POST /provision
GET  /signer/api/v1/state
POST /signer/api/v1/state/checkpoint
```

`GET /state` returns public checkpoint metadata only. Ciphertext transport is separated
from public metadata and requires the provision transport credential.

Key creation and key-info responses include `network_magic`. The canonical
`boundaries_json` returned beside `/attestation` includes it too, so changing only the
magic changes `boundaries_sha256` and therefore the attested `user_data`.

### Stable additional refusal codes

- `consensus-message-unsupported`
- `consensus-height-mismatch`
- `consensus-equivocation`
- `method-blacklisted`
- `method-not-whitelisted`
- `network-fee-exceeded`
- `system-fee-exceeded`
- `signature-rate-exceeded`
- `request-id-conflict`
- `state-not-durable`
- `state-rollback-detected`
- `workload-identity-invalid`
- `workload-identity-replayed`

## Usage Examples

Create a transfer-only key boundary:

```json
{
  "allow_consensus": false,
  "allow_raw": false,
  "allow_transfer": true,
  "allow_contract_call": false,
  "allow_global_scope": false,
  "contract_whitelist": ["0xd2a4cff31913016155e38e474a2c06d08be276cf"],
  "asset_whitelist": ["0xd2a4cff31913016155e38e474a2c06d08be276cf"],
  "asset_limits": [
    {
      "asset": "0xd2a4cff31913016155e38e474a2c06d08be276cf",
      "max_single_amount": "75000000",
      "window_limit": {
        "seconds": 86400,
        "max_amount": "1000000000"
      }
    }
  ],
  "transfer_to_whitelist": ["0x0123456789abcdef0123456789abcdef01234567"],
  "max_single_amount": "100000000",
  "window_limit": {
    "seconds": 3600,
    "max_amount": "500000000"
  },
  "max_signatures": {
    "seconds": 60,
    "count": 20
  }
}
```

Register a browser-origin caller:

```json
{
  "label": "payments.example",
  "key_grant": { "mode": "only", "key_ids": ["key-..."] },
  "capabilities": ["sign"],
  "allowed_origins": ["https://payments.example"]
}
```

Register a server-to-server raw compatibility caller against a dedicated raw-only key:

```json
{
  "label": "enclave-worker-raw",
  "key_grant": { "mode": "only", "key_ids": ["key-worker-raw"] },
  "capabilities": ["raw_sign"],
  "allowed_origins": []
}
```

Configure `neo-nexus`:

```dotenv
NEONEXUS_SIGNER_URL=https://custody.internal.example
NEONEXUS_SIGNER_ADMIN_TOKEN_FILE=/run/secrets/neoos-signer-admin
```

Or use proof of possession:

```dotenv
NEONEXUS_SIGNER_URL=https://custody.internal.example
NEONEXUS_SIGNER_ADMIN_CALLER_ID=caller-admin-workbench
NEONEXUS_SIGNER_ADMIN_WORKLOAD_KEY_FILE=/run/secrets/neoos-admin-ed25519
NEONEXUS_SIGNER_ADMIN_WORKLOAD_SUBJECT=neo-nexus:production
```

Run the Rust signer locally for development:

```bash
SIGNER_SERVICE_DATA_DIR=.local/signer \
  cargo run -p neo-signer --bin signer_service -- provision-admin neo-nexus
SIGNER_SERVICE_DATA_DIR=.local/signer \
  cargo run -p neo-signer --bin signer_service -- serve
```

## Design Decisions

- A staged Rust migration is used instead of a whole-repository rewrite. The measured
  trust boundary moves first; control-plane adapters move only behind protocol parity
  tests. This limits simultaneous semantic change.
- SQLite remains the decision database because `BEGIN IMMEDIATE`, constraints, and
  deterministic backup bytes are sufficient inside one signer. Durability is supplied
  by an authenticated checkpoint backend, not by exposing the database to the parent.
- Conservative reservations are retained after uncertain signing failures.
- Workload assertions use an offline-verifiable pinned key. The enclave does not fetch
  arbitrary OIDC JWKS during a signing request.
- The signer never trusts `X-Forwarded-*` identity or URL headers.
- Neo X support is a separate curve/key kind and policy parser. A P-256 key can never be
  selected by a secp256k1 route or vice versa.
- Compatibility implementations may remain only as non-shipping golden-vector
  references. A source-purity gate prevents Node from re-entering the measured EIF.

## Rust Migration and Duplicate-Engine Removal

1. Canonicalize Neo encoding, CBOR/COSE, hashing, and confidential-envelope primitives
   in audited Rust crates.
2. Keep JavaScript implementations only while cross-language vectors prove parity.
3. Route every production caller to the Rust frontier and Rust custody service.
4. Delete Node signers and engine copies once no production route imports them.
5. Generate MiniApp/MiniGame engine artifacts from one canonical source; consumers
   verify a digest instead of keeping editable copies.
6. Reject direct crypto dependencies in consumers such as `neo-nexus` signer code.
7. Add CI source-purity checks: no Node runtime in EIFs, no WIF/private-key environment
   readers in deployed processes, and no duplicate implementation outside approved
   golden references.

## Test Coverage and Expected Outcomes

Required automated cases:

- two concurrent transfers at the remaining window capacity: exactly one succeeds;
- audit and value reservations commit together or neither becomes externally visible;
- identical idempotency requests return one signature; changed bytes under the same id
  are refused;
- PrepareRequest/PrepareResponse share a proposal checkpoint; Commit conflicts across
  views; key deletion/reimport under the same public key cannot reset a slot;
- every dBFT safety-critical slot is reserved before signing and rejects a conflicting
  checkpoint, including after restart;
- malformed/trailing consensus bodies and height mismatches are refused;
- raw-sign callers cannot reach semantic routes, semantic callers cannot reach raw,
  and `magicLE || sha256(unsignedTx)` is refused for a semantic authority key;
- changing only `network_magic` changes the attested boundary digest;
- every successful signed compute/oracle/NeoDID response has non-empty signature and
  public-key fields; custody readiness failures return 503;
- blacklist precedence, method lists, fees, per-asset limits, and signature-rate limits;
- browser Origin exact-match and server-to-server Origin rejection;
- workload assertion expiry, body/path binding, nonce replay, and mixed-auth rejection;
- remote cleartext import refusal in `neo-nexus`;
- attestation nonce, root, PCR, runtime, vault, boundary digest, and state revision
  failures all prevent import;
- tampered or rolled-back state snapshots keep the vault sealed;
- the real `neo-nexus` client exercises every supported non-secret management
  and signing route against a spawned Rust service; secret import and provision
  remain signer-side ceremonies;
- Cargo format, clippy with warnings denied, tests, secret scan, and EIF source-purity
  gates pass.

Production acceptance additionally requires a reproducible EIF, committed PCR
measurements, a KMS policy pinned to those measurements, a restart/restore drill, a
concurrency stress run, key rotation, and negative attestation evidence. Local tests do
not count as production attestation evidence.
