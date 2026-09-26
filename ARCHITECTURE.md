# neo-os-services in the NeoOS architecture

This file is a pointer, not an authority. The enforced binding is the `Architecture authority`
section of `README.md`, declared in `neo-os-web/docs/workspace/neoos-target-architecture.v1.json`
and checked by `npm run check:architecture-sources` in `neo-os-web`. The proposed successor is
`neoos-target-architecture.v2.json` (status `PROPOSED`), checked by `npm run check:architecture:v2`;
its design is `neo-os/claudedocs/NEOOS-TARGET-ARCHITECTURE-V2-20260921.md`.

## v1 binding (enforced)

| Component                  | Plane          | Published interfaces                                                                                |
| -------------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| `protocol-did-registry`    | protocol plane | owned by `neo-os-did`; services runs pinned copies at consumer paths (`vendor/neo-os-did.pin.json`) |
| `gateway-network-identity` | gateway plane  | interfaces: NetworkIdentity, NetworkPolicy                                                          |
| `gateway-signer`           | gateway plane  | interfaces: ScopedSigner, SubmissionReceipt, SignerPolicy                                           |
| `gateway-service-kernel`   | gateway plane  | interfaces: DurableJob, CallbackEnvelope, RelayerPolicy                                             |

## v2 binding (proposed)

Repository layer: `L3` (gateway).

| Component              | Layer | Ownership                                                                                                                                               |
| ---------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `C04` identity         | L1    | owned by `neo-os-did`: NeoDIDRegistry bindings, claims, nullifiers, action tickets and verifier rotation                                                | must not own: authorization                                           |
| `C05` oracle           | L1    | owns: MorpheusOracle request routing and fulfilment, MorpheusDataFeed, callback consumer adapter                                                        | must not own: app-registration, module-grants, app-state, fee-credits |
| `C12` sign             | L3    | owns: signer policy, caller auth, network binding, per-key limits…                                                                                      | must not own: key-custody                                             |
| `C14` deliver          | L3    | owns: DeliveryJob, journal-before-broadcast, callbacks, sponsored submission with idempotent claim…                                                     | must not own: confirmation-semantics                                  |
| `C15` compute          | L3    | owns: oracle/HTTP/VRF/seal/compute/datafeed execution in the enclave, attested result envelopes, game-session service (Rust replay kernel, finalize.v2) | must not own: signing                                                 |
| `C16` identity-service | L3    | owned by `neo-os-did`: DID issuer/verifier/resolver did:morpheus, action-ticket minting and commitment computation                                      | must not own: registry-contract                                       |
| `C17` ingress          | L3    | owns: public edge gateway, queues and workflows, fixed-origin proxies, one rate limiter…                                                                | must not own: policy, identity, business-logic                        |

### Declared moves out of this repository

| Path                            | Destination |
| ------------------------------- | ----------- |
| `contracts`                     | C05         |
| `apps/web`                      | C20         |
| `services/neoswap`              | delete      |
| `workers/morpheus-relayer`      | delete      |
| `workers/morpheus-relater-rs`   | delete      |
| `contracts-evm`                 | archive     |
| `workers/nitro-worker/src/game` | retire      |
| `config/networks`               | C08         |

C04's `NeoDIDRegistry` has already moved to `neo-os-did`; this repository keeps only the pinned NEF and manifest
under `vendor/neo-os-did/contracts/build/`, which its testnet registry probes deploy.

No deployment or production status is asserted here. Status is generated, never written:
see `neo-os-web/docs/workspace/ARCHITECTURE-STATUS.generated.md`.
