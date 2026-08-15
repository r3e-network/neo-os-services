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

## Generated Runtime Catalog Contract

The public workflow contract is checked in as a generated artifact:

- `apps/web/public/morpheus-runtime-catalog.json` is the canonical public export from the workflow registry
- `neo-os-web/node_modules/@r3e-network/neo-miniapp-shared/constants/generated-morpheus-runtime-catalog.ts` consumes the same catalog for host-app/runtime defaults
- `neo-abstract-account/frontend/src/config/generatedMorpheusRuntimeCatalog.js` consumes the same catalog for AA runtime defaults and paymaster routing

CI and workspace live validation must fail if the envelope version or workflow ids drift across those files.

## Support Stance

- Neo N3 is the active supported path.
- New documentation, examples, and validation flows should treat Neo N3 as canonical.
