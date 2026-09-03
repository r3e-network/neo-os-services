# Morpheus MiniApp OS Architecture

## Production Topology

```text
[ dApp / operator / automation client / registered miniapp ]
        |
        | encrypt optional secrets locally
        v
[ Neo N3 MiniApp OS kernel + built-in modules ] --+
        |                                         |
        | async kernel request / shared reads     | inbox delivery / optional adapter callback
        v                                         |
[ relayer durable intake ]                        |
        |                                         |
        | persist + retry + recover               |
        v                                         |
[ Cloudflare control plane ]                      |
  - auth / validation                             |
  - rate limiting                                 |
  - job persistence                               |
  - queue / workflow dispatch                     |
        |                                         |
        +--------------------------+--------------+
                                   |
                                   v
                       [ confidential execution plane ]
                       - Oracle CVM: built-in fetch / compute / NeoDID modules
                       - DataFeed CVM: continuous shared resource publication
                                   |
                                   v
                           [ signed / attested result ]
                                   |
                                   v
                        [ relayer broadcast + kernel inbox write ]
```

Compatibility note:

- several off-chain routes still use legacy `/oracle/*` naming
- the on-chain N3 contract model is now a shared `miniapp-os + miniapps` kernel
- optional external callback adapters still exist, but the kernel inbox is canonical

## Four Layers

### 1. Serverless ingress and control

Cloudflare Workers provide:

- `/mainnet/*` and `/testnet/*` API ingress
- request authentication and validation
- per-lane throttling and recovery endpoints
- operator-facing health and job status routes
- runtime access to built-in module lanes that can be shared across many miniapps

This layer is intentionally stateless except for the job records it writes to Supabase.

### 2. Durable orchestration

Morpheus uses managed Cloudflare primitives instead of custom in-TEE schedulers:

- **Queues**
  - `oracle_request`
  - `feed_tick`
- **Workflows**
  - `callback_broadcast`
  - `automation_execute`

This keeps orchestration outside the TEE while still preserving retry and recovery semantics.
Queue names remain partly oracle-shaped today for compatibility with existing runtime code.

### 3. Durable state

Supabase is the durable source of truth for:

- request records
- encrypted refs and secret metadata
- control-plane jobs
- relayer jobs
- automation jobs and runs
- feed snapshots
- operation logs

Durability lives here, not in transient worker memory.

### 4. Confidential execution

The confidential boundary is intentionally narrow.

Only these operations enter the TEE:

- decrypting sealed payloads
- private HTTP fetches
- private compute and JS/WASM execution
- NeoDID private ticket flows
- confidential signing and attested result creation

Everything else stays outside.

## Runtime Roles

### Oracle CVM

- name: `oracle-morpheus-neo-r3e`
- app id: `ddff154546fe22d15b65667156dd4b7c611e6093`
- role: built-in confidential module lane for fetch/query, compute, NeoDID, and paymaster-related logic
- public paths:
  - `https://oracle.meshmini.app/mainnet`
  - `https://oracle.meshmini.app/testnet`

### DataFeed CVM

- name: `datafeed-morpheus-neo-r3e`
- app id: `ac5b6886a2832df36e479294206611652400178f`
- role: isolated built-in shared resource publication lane
- priority: highest; feed publication must not be starved by interactive workloads

## Request/Response Flow

1. The client seals optional confidential fields with the runtime X25519 public key.
2. A registered or compatibility-mode Neo N3 contract submits an async kernel request.
3. The relayer persists the event before it advances checkpoints.
4. The appropriate built-in module lane executes the confidential job.
5. The runtime returns a signed result envelope and optional attestation metadata.
6. The relayer fulfills the request on-chain.
7. The kernel stores the canonical inbox item and optionally notifies an external adapter contract.

## DataFeed Flow

1. A control-plane or operator tick enters the `feed_tick` lane.
2. The DataFeed CVM fetches and normalizes source data.
3. Only materially changed quantized prices are prepared for publication.
4. The relayer publishes the update to `MorpheusDataFeed`, which acts as a shared numeric resource registry.
5. Feed snapshots and operational telemetry are recorded in Supabase.

## Network Model

- Mainnet and testnet may share the same Oracle/DataFeed CVM hardware.
- Each hub runs separate network-scoped worker and relayer processes with
  isolated runtime config and signer variables; one mutable process must not
  serve both networks.
- Network selection is enforced by service topology, runtime metadata, and path
  prefix, without requiring separate CVMs per network.
- The Oracle execution plane is network-aware and process-isolated.
- Built-in module lanes are reusable across many registered miniapps.

This keeps runtime behavior consistent and reduces operational drift.

## Trust Boundaries

- secrets are encrypted before leaving the client boundary
- control plane, edge gateway, and relayer never decrypt payloads
- TEE outputs derived results only
- pricefeed publishing is isolated from request/response execution
- signer identities are pinned and checked before deployment
- public attestation anchors are verified in-app via the `/api/attestation/verify` endpoint (and the `/verifier` page), backed by AWS Nitro attestation for the Oracle and DataFeed CVMs

## Production Confidential-Path Contract

### Overview

Production requests that decrypt, compute, sign, relay a transaction, or mutate a
feed use one explicitly configured Nitro endpoint and fail closed when that
endpoint is absent or unavailable. The web tier and relayer must not manufacture
or traverse `oracle.meshmini.app` / `edge.meshmini.app` fallback candidates for
these requests. Public health, status, and catalog reads remain separate,
non-confidential routes and may name a public endpoint explicitly. A production
proxy may retry those reads against public candidates, but it sends the runtime
bearer only to an exact server-configured runtime candidate; public and registry
fallbacks are always credential-free.

The data-plane bearer (`MORPHEUS_RUNTIME_TOKEN`) authenticates calls to the Nitro
runtime only. It grants no control-plane authority. Workflow delivery, operator
actions, and relayer administration use independent credentials:

- `MORPHEUS_WORKFLOW_API_KEY` authenticates Cloudflare Workflow/Queue delivery
  to the web backend.
- `MORPHEUS_OPERATOR_API_KEY` authenticates human/operator control-plane
  actions.
- `MORPHEUS_RELAYER_ADMIN_API_KEY` authenticates legacy relayer metrics, retry,
  replay, and relayer-operation control-plane calls;
  `MORPHEUS_RELAYER_API_KEY` is the preferred credential for new
  relayer-originated control-plane calls.
- `MORPHEUS_SIGNING_ADMIN_API_KEY` and `MORPHEUS_RELAY_ADMIN_API_KEY`
  independently authorize signing and transaction-relay administration.
- `MORPHEUS_CONTROL_PLANE_API_KEY` remains the control-plane ingress credential;
  it is not a Nitro runtime credential.

A development-only migration switch may temporarily accept the old runtime
token for control-plane requests. Production ignores that switch and always
fails closed. Merely copying the runtime token value into a differently named
workflow/operator/relayer/signing/relay variable is also rejected. Production
preflight compares all populated privilege domains pairwise; aliases are
permitted only within their documented domain.

### API reference

- Confidential runtime callers configure `MORPHEUS_RUNTIME_URL` (or its
  network-scoped form) and the runtime bearer. In production, only the first
  server-only explicit endpoint is attempted. A `NEXT_PUBLIC_*` URL never
  becomes a confidential server route.
- Explicit `NEXT_PUBLIC_MORPHEUS_RUNTIME_URL` and registry public URLs remain
  candidates only for operations marked non-confidential (health/status/catalog).
  In production they never receive `Authorization` or `x-nitro-token`; those
  credentials are attached only to exact `MORPHEUS_RUNTIME_URL` candidates.
- Internal workflow routes
  `/api/internal/control-plane/callback-broadcast`,
  `/api/internal/control-plane/feed-tick`, and
  `/api/internal/control-plane/automation-execute` accept the workflow or
  operator credential; they reject the runtime token.
- `MORPHEUS_CONTROL_PLANE_LEGACY_RUNTIME_TOKEN_COMPAT` (and migration alias
  `MORPHEUS_ALLOW_LEGACY_RUNTIME_CONTROL_PLANE`) is honored only outside
  production.
- Vercel, Cloudflare control-plane, and relayer process environments reject
  Neo N3 and Neo X WIF/private-key variables. Neo N3 writes use
  `SIGNER_SERVICE_URL`, `SIGNER_SERVICE_TOKEN`, and
  `SIGNER_ROLE_*_KEY_ID`.
- The shipped Rust enclave host has no complete secp256k1 custody/signing
  contract. Therefore a production relayer configured with `neox` active or
  with a host EVM private key is a configuration error. The historical Node
  reference implementation is not proof that the measured Rust EIF serves the
  lane.

### Usage examples

Production confidential execution:

```dotenv
NODE_ENV=production
MORPHEUS_RUNTIME_URL=http://127.0.0.1:8787
MORPHEUS_RUNTIME_TOKEN=<data-plane-only-token>
MORPHEUS_WORKFLOW_API_KEY=<workflow-delivery-token>
MORPHEUS_OPERATOR_API_KEY=<operator-token>
MORPHEUS_RELAYER_ADMIN_API_KEY=<relayer-operations-token>
MORPHEUS_RELAYER_API_KEY=<relayer-to-control-plane-token>
MORPHEUS_SIGNING_ADMIN_API_KEY=<signing-admin-token>
MORPHEUS_RELAY_ADMIN_API_KEY=<relay-admin-token>
```

The runtime token in an `Authorization: Bearer ...` header is valid for the
Nitro data plane, but the same request to an internal control-plane route must
return `401`. A workflow caller uses `MORPHEUS_WORKFLOW_API_KEY` instead. If a
non-confidential catalog read retries from this configured runtime to a public
fallback, the retry contains neither runtime-token header.

### Design decisions

Endpoint failover is a trust-boundary decision, not merely an availability
optimization: retrying confidential plaintext or ciphertext against a public
host silently changes where decryption/compute occurs. Credential separation
follows the same rule—possession of a data-plane bearer must not imply authority
to schedule or broadcast control-plane work, and a fallback host must never
learn that bearer merely because it serves a public catalog. Host signing is rejected rather
than labeled "temporary" because an EVM signature does not reveal whether its
private key lived inside the measured enclave.

### Test coverage and expected outcomes

- A production confidential call with two candidates contacts only the first.
- A production non-confidential read may retry a public candidate, but only the
  exact server-configured candidate receives runtime authentication headers.
- Production config without an explicit confidential runtime URL contains no
  automatic public candidate.
- The runtime token receives `401` from workflow/control-plane routes; workflow
  and operator credentials succeed; the development migration switch is ignored
  in production.
- Vercel/control-plane/relayer checks reject WIF or private-key configuration.
- A production Neo X host-sign attempt fails with a stable configuration error
  before signing or broadcasting.

## Generated Runtime Catalog Contract

The public workflow contract is checked in as a generated artifact:

- `apps/web/public/morpheus-runtime-catalog.json` is the canonical public export from the workflow registry
- `neo-os-web/node_modules/@r3e-network/neo-miniapp-shared/constants/generated-morpheus-runtime-catalog.ts` consumes the same catalog for host-app/runtime defaults
- `neo-abstract-account/frontend/src/config/generatedMorpheusRuntimeCatalog.js` consumes the same catalog for AA runtime defaults and paymaster routing

CI and workspace live validation must fail if the envelope version or workflow ids drift across those files.

## Support Stance

- Neo N3 is the active supported path.
- New documentation, examples, and validation flows should treat Neo N3 as canonical.
