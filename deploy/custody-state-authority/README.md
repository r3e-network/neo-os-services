# TestNet Custody State Authority

This directory is an independent AWS SAM service for coordinating durable custody
snapshots. It provides a strongly consistent, fenced HEAD; immutable snapshot
claims and commit records; immutable versioned S3 objects; and KMS-signed commit
receipts.

It is **not a production release by itself**. The authority now performs strict
Nitro attestation verification, but rollout remains blocked until the matching
signer client, reproducible EIF measurements, receipt public-key pin, and the
TestNet restart/takeover/restore drill all pass together.

The implementation is TestNet-only. There is no network parameter or MainNet
mode.

## Security Model

The coordinator, not the Nitro parent, owns durable state. The parent role emitted
by the stack can invoke the API and has explicit denials for direct DynamoDB, S3,
and coordinator-KMS access. Lambda roles are separate per route and receive only
the DynamoDB/S3/KMS actions needed by that route.

API Gateway uses IAM authorization. SigV4 therefore occupies the standard
`Authorization` header. Once an enclave decrypts its sealed session capability,
it sends that capability in `x-custody-session`; the header is never logged by
this service. A parent proxy must relay the enclave's TLS stream without
termination and must not receive the decrypted capability.

Wire v3 additionally requires an RSA-PSS-SHA256 proof (32-byte salt) from the
attested session key on every protected request. The proof binds the exact method,
expanded route, token hash, timestamp, fresh 32-byte nonce, and raw-body hash.
Queries and GET bodies are rejected. Each nonce is consumed by a conditional
DynamoDB write under the session hash; TTL cleanup is not the replay decision.
The Rust client reattests before session expiry using the same enclave key and
owner, serializes concurrent refreshes, and refuses the operation on refresh
failure. AWS role credential renewal is a separate, still-open deployment gate.

RSA private operations live in `nitro-attest::session_key::SessionTransportKey`,
not in the signer coordinator. The key has no import/export/clone API, token
opening uses blinded OAEP-SHA256, and request signing requires the custody proof
domain with a 32-byte PSS salt. The existing Rust ownership gate remains intact.

The intended release ordering is:

1. Read the strongly consistent HEAD and its exact S3 `version_id`.
2. Acquire an expired/uninitialized lease with `takeover`, advancing the epoch,
   then download, authenticate, and install the exact snapshot before Ready.
3. Prepare a complete encrypted snapshot for generation `HEAD + 1`, with the
   current epoch as its fence and the current HEAD hash as its predecessor.
4. Reserve a scope-unique `commit_id` and obtain an upload ticket.
5. Upload once with every returned signed header and retain the response's
   `x-amz-version-id`. If the PUT result is ambiguous, use `upload-status` for
   the existing claim; accept only one exact immutable version, with the live
   predecessor lease checked both before and after S3 verification.
6. Commit that exact version. The DynamoDB transaction checks the permanent
   claim and exact live HEAD, writes the immutable COMMIT, and advances HEAD.
7. Accept only the exact KMS-signed receipt for the pending commit before
   releasing a new signature or other irreversible custody result.

Timeout or caller cancellation does not imply that a submitted commit failed.
Retry the same `commit_id` and exact request until the stored receipt is returned.
Permanent claim and commit idempotency is enforced by immutable DynamoDB records and
transactional conditions. Claim and commit transactions deliberately omit DynamoDB's
ten-minute `ClientRequestToken`: their trusted-time conditions, lease extension, and
KMS ECDSA receipt can change between retries, so reusing one token with changed
transaction parameters would fail with `IdempotentParameterMismatch` instead of
resolving the permanent record.

## Attestation Gate

[`src/attestation.mjs`](src/attestation.mjs) implements the production gate as
one fail-closed operation. It has no environment-variable bypass, development
mode, caller assertion, or structural/base64-only acceptance path. A refused
attestation does not consume the challenge or create a session. The verifier:

- decode one canonical NSM CBOR/COSE_Sign1 document and reject malformed,
  duplicate, unknown-critical, trailing, or non-canonical security fields;
- require protected COSE algorithm ES384 and verify the COSE Sig_structure;
- validate the leaf and intermediate certificate signatures, constraints,
  validity intervals, and exact chain termination at a byte-pinned AWS Nitro
  Enclaves root certificate;
- enforce a fresh document timestamp against trusted coordinator time;
- require SHA-384 PCR0, PCR1, and PCR2 to be exactly 48 bytes and exactly equal
  the three deployment parameters;
- compare the raw NSM nonce bytes to the one-time 32-byte challenge nonce;
- compare raw NSM `user_data` to the 32-byte SHA-256 challenge binding returned
  as `attestation.user_data_hex`;
- extract the NSM `public_key` as canonical SPKI DER, require RSA with a modulus
  of exactly 3072 bits and exponent 65537, and return both its bytes and SHA-256
  digest;
- require `owner_id` to equal `nitro-<sha256-of-SPKI-DER>`, preventing two
  independently attested keys from claiming the same fence owner;
- is covered by generated positive-chain fixtures and negative vectors for chain
  anchoring, timestamp, PCR, nonce, user data, COSE algorithm/signature, SPKI
  encoding, RSA size, and exponent checks.

The core independently compares the verified claims to the challenge and PCR
pins, then encrypts the 256-bit session token to that attested RSA key with
RSA-OAEP-SHA256. The session response never contains a plaintext token. Runtime
acceptance additionally requires a positive document emitted by the exact
admitted TestNet EIF; generated certificate fixtures cannot establish that
deployment-specific fact.

## Data Model

One DynamoDB table uses `pk`/`sk` string keys. `scope` below is the exact
`vault#profile#network#root-commitment` tuple:

| Entity       | Key                            | Lifetime  | Mutation rule              |
| ------------ | ------------------------------ | --------- | -------------------------- |
| Challenge    | `CHALLENGE#id / META`          | TTL       | One atomic consume only    |
| Session      | `SESSION#sha256(token) / META` | TTL       | Insert only                |
| Request proof | `PROOF#tokenHash#nonce / META` | Session TTL | Conditional insert once |
| HEAD         | `STATE#scope / HEAD`           | Permanent | Exact conditional CAS only |
| Commit claim | `COMMIT#scope#id / CLAIM`      | Permanent | Insert only                |
| COMMIT       | `COMMIT#scope#id / RECORD`     | Permanent | Insert only                |

Every authority read uses `ConsistentRead: true`, including HEAD and idempotency
lookups. A commit transaction binds the vault, profile, network set, root-key
commitment, session owner, lease epoch, new and predecessor snapshot fences,
candidate and previous generation, previous hash, mutation digest, claim
fingerprint, bucket, object key, version, checksum, size, and live lease. It
inserts COMMIT with
`attribute_not_exists(pk) AND attribute_not_exists(sk)`. Neither claims nor
commits carry the table TTL attribute, so a `commit_id` is permanently bound
inside its full scope. An exact retry returns the stored receipt; any changed field
returns `409 commit_id_conflict`.

Counters are canonical decimal strings in the API and DynamoDB numbers at rest,
with checked unsigned-64-bit increment/decrement. Hashes and the four scope
identifiers are 64-character lowercase hex. The genesis binding is exactly
generation `"0"`, epoch `"0"`, snapshot fence `"0"`, all-zero snapshot hash and
HEAD fingerprint, and `previous_owner_id: null`; the first takeover creates epoch
`"1"` while preserving snapshot fence `"0"`. A commit sets the new snapshot
fence to its lease epoch. Later takeover/renew operations never rewrite it.

The S3 bucket has versioning, BucketOwnerEnforced ownership, all public-access
blocks, SSE-KMS with bucket keys, and Object Lock COMPLIANCE retention (10 years
by default). The bucket policy denies insecure transport, wrong/missing KMS
encryption, and snapshot deletion. Uploads are single PUTs with `If-None-Match:
*`, a signed SHA-256 checksum, exact metadata, and explicit COMPLIANCE retention.
Commit checks the exact S3 version with checksum mode enabled before changing
DynamoDB. The object remains the enclave's authenticated encrypted envelope;
SSE-KMS is a second at-rest layer.

Receipts sign the explicit binary encoding in [`src/protocol.mjs`](src/protocol.mjs)
with a KMS `ECC_NIST_P256` SIGN_VERIFY key and `ECDSA_SHA_256`. The encoding is
independent of JSON field order. A receipt contains the payload fields, canonical
payload bytes, signature, stable logical receipt-key ID, actual KMS key ARN, and
SHA-256 receipt ID. The shared golden vector is
[`test/fixtures/protocol-v2.json`](test/fixtures/protocol-v2.json). Export and pin
the KMS public key in the enclave release process before accepting receipts.

## API

All request bodies reject unknown or missing fields. `vault_id`, `profile_id`,
`network_id`, and `root_commitment` are lowercase 32-byte hex values. Other
identifiers are 1-128 ASCII characters matching
`[A-Za-z0-9][A-Za-z0-9._:@-]*`. State routes require both SigV4 IAM
authorization and `x-custody-session`.

This TestNet template is one dedicated authority per immutable vault profile.
`ExpectedVaultId`, `ExpectedProfileId`, `ExpectedNetworkId`, and
`ExpectedRootCommitment` must be copied from the reviewed profile/released root;
challenge issuance rejects every other tuple before attestation. PCR0/1/2 must
all be nonzero, which prevents accidentally admitting a debug enclave.

### Challenge and session

`POST /v1/challenges`

```json
{
  "vault_id": "64-lowercase-hex-characters",
  "profile_id": "64-lowercase-hex-characters",
  "network_id": "64-lowercase-hex-characters",
  "root_commitment": "64-lowercase-hex-characters",
  "owner_id": "nitro-<sha256-of-attested-spki>"
}
```

The response supplies `nonce_hex`, `user_data_hex`, and exact PCR pins for the
NSM request. Exchange the resulting base64 COSE_Sign1 document with:

`POST /v1/sessions`

```json
{
  "challenge_id": "returned-id",
  "attestation_document": "base64-cose-sign1"
}
```

The response contains only `sealed_session_token.ciphertext_base64`, its
RSA-OAEP algorithm and key digest. The plaintext session token never crosses the
attested RSA boundary.

### HEAD, lease and takeover

`GET /v1/vaults/{vaultId}/profiles/{profileId}/head` returns the exact HEAD,
including the immutable S3 version.

`POST /v1/vaults/{vaultId}/profiles/{profileId}/takeover` creates genesis or
acquires an expired lease. For an existing HEAD, every value is the caller's
last strongly consistent observation:

```json
{
  "owner_id": "nitro-<new-attested-key-sha256>",
  "previous_owner_id": "nitro-<prior-attested-key-sha256>",
  "epoch": "8",
  "snapshot_fence": "7",
  "generation": "41",
  "snapshot_sha256": "64-lowercase-hex-characters",
  "head_fingerprint": "64-lowercase-hex-characters"
}
```

`POST /v1/vaults/{vaultId}/profiles/{profileId}/renew` extends only a currently
live lease owned by the session:

```json
{
  "owner_id": "nitro-<new-attested-key-sha256>",
  "epoch": "9",
  "snapshot_fence": "7",
  "generation": "41",
  "snapshot_sha256": "current-head-hash",
  "head_fingerprint": "current-head-fingerprint"
}
```

Takeover cannot preempt a live lease. Renew cannot revive an expired lease.
Lease comparisons use Lambda/coordinator time, never parent-supplied time.

### Upload and commit

`POST /v1/vaults/{vaultId}/profiles/{profileId}/upload-tickets`

```json
{
  "commit_id": "globally-unique-id",
  "owner_id": "nitro-<new-attested-key-sha256>",
  "epoch": "9",
  "snapshot_fence": "9",
  "previous_snapshot_fence": "7",
  "generation": "42",
  "previous_snapshot_sha256": "current-head-hash",
  "head_fingerprint": "current-head-fingerprint",
  "mutation_digest": "64-lowercase-hex-characters",
  "snapshot_sha256": "encrypted-envelope-sha256",
  "snapshot_size_bytes": 1048576
}
```

Send one PUT to `upload.url` with every `upload.required_headers` entry exactly
as returned. Capture `x-amz-version-id` from the successful S3 response.

`POST /v1/vaults/{vaultId}/profiles/{profileId}/commits`

```json
{
  "commit_id": "globally-unique-id",
  "owner_id": "nitro-<new-attested-key-sha256>",
  "epoch": "9",
  "snapshot_fence": "9",
  "previous_snapshot_fence": "7",
  "generation": "42",
  "previous_snapshot_sha256": "current-head-hash",
  "mutation_digest": "64-lowercase-hex-characters",
  "snapshot_key": "exact-key-from-ticket",
  "snapshot_version_id": "exact-s3-version-id"
}
```

Success returns the advanced HEAD and signed receipt. A first success is `201`;
an exact permanent replay is `200` with `idempotent: true` and byte-identical
stored receipt fields.

### Exact snapshot recovery

`POST /v1/vaults/{vaultId}/profiles/{profileId}/download-tickets` accepts the
current owner, epoch, snapshot fence, generation, snapshot hash, and HEAD
fingerprint. It succeeds only while that exact owner has a live lease and returns
a short-lived GET URL pinned to the HEAD's exact bucket, key, S3 `version_id`,
SHA-256, and byte size. Recovery must verify both size and SHA-256 before
installing the encrypted snapshot.

## Infrastructure Controls

[`template.yaml`](template.yaml) creates only native CloudFormation/SAM
resources:

- an IAM-authenticated HTTP API and eight route-specific Lambda functions;
- a customer-key-encrypted DynamoDB on-demand table with PITR, TTL for ephemeral
  records, deletion protection, and Retain policies;
- a customer-key-encrypted, versioned, block-public-access S3 bucket with Object
  Lock and Retain policies;
- separate symmetric DynamoDB/S3 keys and one asymmetric receipt-signing key;
- exact log groups with retention and route-scoped execution roles;
- a Nitro parent instance profile with API invoke permission and explicit direct
  state denials.

CloudFormation cannot turn on stack termination protection from inside a
template. A deployment procedure must enable stack termination protection as a
separate control and must treat retained COMMIT records, bucket versions, and KMS
keys as recovery assets. Do not add lifecycle expiration to the commit records or
snapshot prefix.

## Local Verification

The unit suite uses in-memory/fake AWS clients and performs no network or AWS
calls:

```sh
cd deploy/custody-state-authority
npm run verify
```

The tests cover strict attestation verification, one-time challenge exchange,
encrypted session delivery, exact scope/owner/epoch/generation/snapshot-fence
fencing, takeover and renewal behavior, permanent commit idempotency, exact
version recovery, cross-language canonical protocol vectors, DynamoDB transaction
shape, S3 checksum/version/encryption/retention checks, KMS signing inputs, IAM
routing, and resource-protection declarations.

For packaging, install the lockfile-resolved SDKs in this directory and use a
current SAM CLI. These are read/build checks only and do not contact deployed
resources:

```sh
npm ci --ignore-scripts
sam validate --lint --template-file template.yaml
sam build --template-file template.yaml
```

Do not deploy until the signer client tests pass and the attestation acceptance
evidence is reviewed against the exact reproducible TestNet EIF measurements.
MainNet requires a separate reviewed stack, identities, keys, bucket, table,
receipt key and complete TestNet recovery evidence; this template cannot select
MainNet.
