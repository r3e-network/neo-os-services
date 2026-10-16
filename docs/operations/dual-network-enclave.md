# One enclave, two network contexts

Target topology: the existing host runs one Nitro enclave and one Rust business
process for MainNet and TestNet. Network contexts are logical boundaries inside
the same address space. A crash, OOM or memory compromise can affect both.

## Current implementation boundary

The frontier supports an opt-in measured `MORPHEUS_NETWORK_PROFILES_JSON` map:

```json
{
  "mainnet": { "MORPHEUS_NETWORK": "mainnet" },
  "testnet": { "MORPHEUS_NETWORK": "testnet" }
}
```

This minimal map is unprovisioned and does **not** make either network ready.
Each entry needs its reviewed RPC, contract, role and KMS configuration. These
must be incorporated into the measured image; plaintext secrets do not belong
in this map, Docker build arguments or source control. Existing attested
provisioning supplies secrets separately to each selected context.

No RPC, credential, role ID or secret is inherited from the process-wide
configuration. Only `NODE_ENV`, `MORPHEUS_ATTESTED_BOOT` and
`MORPHEUS_ALLOW_EPHEMERAL_KEY` are common boot policy; profiles cannot override
them. Unknown/duplicate profile names, duplicate configuration keys and network
identity mismatches refuse startup. An absent map preserves single-network
operation; an empty or malformed map never silently falls back.

Dual mode requires `/mainnet/<route>` or `/testnet/<route>`, or the exact
`x-morpheus-network` header on an unprefixed route. A supplied header must agree
with the path. Unknown, encoded and extra prefix segments are refused. Query
and payload network aliases must agree with the selected context. The historical
NeoDID recovery `network` field may instead name `neo_n3` or `neox`; that field
describes chain family, while the request's deployment network remains explicit.

Each context owns its environment overlay, provisioning version, provider cache,
ephemeral key, automation replay records and game-session store. Identical
idempotency keys on different networks are independent. Provisioning one context
must not install a credential in the other. No request switches process-global
variables. The source composes the existing policy-aware custody client with
the canonical signer router in the same business process. This is a source
implementation; a reviewed measured image and live recovery are still required.

### Embedded custody configuration

Each measured network entry must provide all four values below and its exact
`SIGNER_SERVICE_URL`: `http://127.0.0.1:0/mainnet` or
`http://127.0.0.1:0/testnet`. These addresses are private routing identifiers;
no socket listens on them and the adapter cannot dispatch to another address.

- `MORPHEUS_CUSTODY_PROFILE_FILE`: absolute path to the measured public vault
  profile, a regular file no larger than 64 KiB.
- `MORPHEUS_CUSTODY_PROFILE_SHA256`: exact lowercase SHA-256 of those bytes.
- `MORPHEUS_CUSTODY_DATA_DIR`: absolute private state directory for this vault.
- `MORPHEUS_CUSTODY_WORKLOAD_AUDIENCE`: canonical origin for its existing
  audience-bound workload authentication.

The two entries must have distinct vault IDs, root commitments, directories and
workload audiences. Profile environment must match its selected context. All
plans validate before boot. Each vault then verifies a fresh NSM challenge,
retains its OS lease, and starts sealed. Partial configuration, profile drift,
failed attestation or lease conflict prevents the listener. A production dual
host requires both embedded vaults; it cannot fall back to external custody.
Development hosts with no custody configuration preserve their existing
unconfigured behavior. These four values are not provisionable.

Native custody is exposed under the selected context's `/custody` namespace:
for example `/mainnet/custody/provision`, `/testnet/custody/attestation` and
`/mainnet/custody/signer/api/v1/keys`. The native router retains all original
authorization and recovery checks. Frontier runtime credentials do not become
custody administration credentials. `/mainnet/provision` continues to provision
only the frontier's own allowlisted encrypted configuration. A sealed vault's
health does not mean it is ready to sign.

Each native vault has an eight-request internal budget, within the shared
sixteen-request frontier budget. Router clones and detached native work retain
their leases. Local synthetic-attestation tests prove software wiring only;
they are not hardware, KMS, durable-authority or production readiness evidence.

### Feed-state compatibility

Feed runs serialize on the parent directory's device/inode and the ASCII-folded
scoped filename, so a slow MainNet provider does not hold TestNet's feed lock.
Parent directory symlinks and case variants share that identity, including
before a file exists and across atomic replacement. Case-sensitive volumes may
conservatively serialize distinct case variants. State filenames must use ASCII
letters, digits, dots, underscores and hyphens; other names fail closed rather
than guessing filesystem Unicode normalization. Leaf symlinks, dangling links,
hard-linked and non-regular files are refused for scoped and legacy state before
provider fetch or signing. Failure counters belong to each context;
disk is the baseline authority and failed writes never become cached history.

Existing `state.<network>.<chain>.json` files with an object-valued `records`
and object-valued entries remain readable. This validates record containers,
not every field of every historical provider schema. New writes also include `scope.network` and
`scope.target_chain`. If present, both must match the selected context exactly.
An unscoped legacy file is imported only when that explicit scope matches;
unlabelled or foreign history returns 503 before provider fetch or signing.
Unreadable/malformed scoped state never falls back to an empty or legacy file.

Before enabling both networks, inventory the existing state files and establish
each legacy file's provenance from its actual deployment. Back up and verify it,
then migrate only to its proven network/chain; never copy an unknown baseline to
both networks or delete it to clear the error. Read back the records after the
first scoped write and after restart. Persistence uses file sync, atomic rename
and directory sync; a failed rename does not delete the old baseline. Temporary
file collisions preserve the existing file. Cleanup only removes a temporary
file owned by that save, and never runs after its successful rename.

The state directory must be controlled by this process's operator. These checks
do not protect against a hostile local process continually replacing directory
entries, and the locks are in-process only. Do not configure multiple business
processes as concurrent writers to the same baseline. A directory-sync failure
after rename may leave the new file visible while reporting persistence failure;
it is not evidence of a chain submission or of rollback to the old file.

## Required before production cutover

The HTTP frontier reserves from one shared 16-request budget before reading a
body. Excess requests receive 503 with `Retry-After: 1`; incomplete bodies time
out after 10 seconds. A blocking dispatch retains its slot even when its HTTP
client disconnects, until that work actually finishes. Tokio's blocking pool is
capped at 32: sixteen admitted frontier calls plus sixteen reserved nested
custody workers. Per-route guards remain additional controls; neither network
receives a second copy of the process budget. This is a bounded admission
policy, not measured production throughput or a guarantee against overload.

1. Independently review the composed executable and verify caller/grant checks,
   attested recovery and durable result barriers through its native router.
   Do not launch a second signer business process or substitute unrestricted key
   calls. Bind both stores, leases, callers and receipts to their network.
2. Complete MainNet support throughout custody coordinator, signed receipt
   encoding/validation and state authority. Preserve old TestNet vectors and
   reject otherwise valid cross-network receipts.
3. Review remaining shared-resource behavior (public JWKS cache, blocking pool,
   metrics and process memory), profile paths and actual feed-state migration.
   Measure both networks concurrently under the existing enclave budget.
4. Produce the combined measured image, admit its measurement through the
   existing approved policy flow, and bind deployment evidence to exact source
   and image bytes. Keep the previous verified image/configuration available.
5. Rehearse provisioning, both network readiness/identity readbacks, wrong-network
   refusals and restart recovery. Cut over only after independent review and the
   affected CI jobs pass. Verify both networks after restart and roll back on
   either network's failure. Do not describe the opt-in frontier tests as proof
   of a complete dual-network production deployment.

The same hardware boundary serves both networks; separate roots and namespaces
prevent ordinary routing/replay mistakes but do not recreate separate enclaves.
