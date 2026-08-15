# Morpheus CRE-Style TEE Design

**Problem:** `neo-morpheus-oracle` already separates ingress, orchestration, durable state, and confidential execution, but the workflow model is still implicit. Automation, paymaster policy, provider config, feed sync, callback broadcast, NeoDID actions, and confidential compute are implemented as adjacent lanes rather than as one typed workflow system. That makes the platform harder to reason about, harder to audit, and harder to extend across `neo-miniapps-platform` and `neo-abstract-account`.

**Goal:** Refactor Morpheus into a TEE-native analogue of Chainlink’s current platform direction: CRE-style workflow orchestration, Automation/Keeper-style upkeep execution, CCIP-style risk controls, DataLink-style provider/catalog governance, and ACE-style policy evaluation, while keeping confidential execution in the TEE and keeping scheduling outside the TEE.

**Non-goals:**

- Do not move scheduling into the TEE.
- Do not rewrite the on-chain MiniApp OS kernel first.
- Do not add multi-network CVM sprawl.
- Do not couple AA or miniapps directly to sibling-repo runtime code.

## Current State

The current production topology is already close to the right boundary split:

- Cloudflare edge gateway handles public ingress and cacheable reads.
- Cloudflare control plane handles auth, validation, queueing, and recovery.
- Supabase stores durable jobs, automation state, provider config, and logs.
- The Oracle/DataFeed CVMs handle confidential execution only.

That is directionally correct, but several concerns are still spread across route handlers and job types:

- workflow intent is not first-class
- automation is a lane, not a platform primitive
- policy is fragmented across paymaster rules, provider config, request guards, and app allowlists
- attestation and risk checks are application helpers, not an independent control layer
- consumer repos still mostly think in terms of endpoint families rather than named workflow products

## Approaches

### Option 1: Incremental lane cleanup

Keep the current queue/workflow model and standardize naming, payloads, and envs.

Pros:

- lowest migration cost
- minimal disruption to current deployment model

Cons:

- preserves product sprawl
- keeps automation, feeds, paymaster, compute, and NeoDID as separate local patterns
- does not produce a real platform abstraction similar to CRE

### Option 2: Recommended, Morpheus Runtime Environment

Introduce a first-class workflow layer above the existing control plane and TEE workers.

The core model becomes:

- workflow definition
- trigger
- policy evaluation
- execution plan
- confidential step execution
- attested result envelope
- delivery and retry
- risk observation and circuit breaking

This preserves the current topology but makes workflow orchestration explicit and reusable.

### Option 3: Full scheduler rewrite inside a new runtime

Move orchestration into a new bespoke runtime and rebuild the current control plane around it.

Pros:

- clean slate

Cons:

- wrong trust boundary
- higher operational risk
- loses the main lesson from Chainlink Automation/CRE: orchestration and execution should be separated

## Recommendation

Choose Option 2.

This keeps Morpheus aligned with the best parts of Chainlink’s current platform design while preserving the strongest part of Morpheus itself: confidential execution inside a TEE. The right target is not “becoming Chainlink.” The right target is “make Morpheus look like a professional workflow platform whose confidential steps are TEE-backed.”

## Target Architecture

### 1. Morpheus Workflow Registry

Add a typed registry for all supported products and internal jobs:

- `oracle.query`
- `oracle.smart_fetch`
- `feed.sync`
- `automation.upkeep`
- `compute.execute`
- `neodid.bind`
- `neodid.action_ticket`
- `neodid.recovery_ticket`
- `paymaster.authorize`

Each workflow definition should declare:

- name and version
- trigger types
- allowed networks
- required capabilities
- confidential step boundaries
- policy hooks
- retry semantics
- output envelope schema
- delivery mode: on-chain callback, kernel inbox, API response, durable artifact

### 2. Morpheus Keeper / Automation Supervisor

Lift automation into a first-class service instead of a special route/workflow pair.

It should own:

- interval-based upkeeps
- threshold/feed-driven upkeeps
- replay protection and idempotency keys
- queue admission control
- on-chain queue requests when required
- durable run records and next-fire timestamps

This is the Morpheus equivalent of Chainlink Automation/Keepers, except that confidential evaluation steps can still execute inside the TEE when needed.

### 3. Policy and Entitlements Engine

Unify provider configs, paymaster rules, dapp allowlists, feed permissions, and future compliance checks into one policy layer.

Policy should evaluate before dispatch and before confidential execution. It should support:

- tenant/project entitlements
- provider allowlists and quotas
- paymaster spend limits and target/method scopes
- network/jurisdiction/compliance rules
- execution budget limits
- require-attestation or require-human-approval flags

This is the Morpheus equivalent of ACE plus DataLink-style access governance.

### 4. Confidential Execution Adapters

The TEE should not know about product-specific ingress details. It should receive a normalized execution plan:

- workflow id
- execution id
- network
- sealed inputs
- provider refs
- execution step list
- signer requirements
- output schema expectation

Inside the TEE, adapters implement the confidential step types:

- private fetch
- compute script / WASM job
- NeoDID private actions
- confidential sponsorship authorization
- signing / attested response creation

### 5. Result Envelope and Attestation Contract

Every execution result should produce one normalized envelope with:

- workflow id and version
- execution id and correlation id
- network
- deterministic output hash
- attestation metadata
- signer metadata
- delivery targets
- retryable / terminal classification

This envelope is what the relayer, app backends, AA, and miniapps consume. It reduces ad hoc response shaping across repos.

### 6. Risk Observation Layer

Add an observer layer independent from the execution plane.

It should monitor:

- attestation drift
- signer drift
- provider degradation
- abnormal failure/retry rates
- feed anomalies and stale publication
- policy violations
- callback congestion

It should be able to:

- pause a workflow family
- pause a network or provider
- downgrade to non-confidential or read-only fallback when allowed
- require operator approval for certain product lines

This is the main CCIP lesson to import: keep a separate risk-control surface rather than trusting the primary pipeline alone.

## Cross-Repo Contract

`neo-morpheus-oracle` remains the source of truth for:

- workflow registry
- public deployment registry
- policy capability metadata
- attestation/result envelope schema

`neo-miniapps-platform` should consume generated workflow metadata for host-app routing, miniapp capabilities, and operator UI.

`neo-abstract-account` should consume generated paymaster, policy, and runtime metadata, not hardcoded endpoint assumptions.

## Migration Strategy

### Phase 1: Normalize interfaces

- Introduce workflow registry, execution envelope, and policy evaluation contract.
- Keep current routes and queues working as compatibility wrappers.

### Phase 2: Extract automation product

- Replace ad hoc automation lane logic with a dedicated upkeep service and state model.

### Phase 3: Introduce risk layer

- Add watcher jobs, pause semantics, and attestation/signer drift monitors.

### Phase 4: Productize workflow catalog

- Expose workflow definitions, policies, and capabilities to `apps/web`, AA, and miniapps through generated artifacts.

### Phase 5: Retire compatibility routing

- Move legacy `/oracle/*` mental model to typed workflow naming in docs, SDKs, and APIs.

## Testing Expectations

The refactor should be blocked on:

- workflow-registry schema tests
- policy decision matrix tests
- execution-envelope golden tests
- keeper scheduling tests
- risk watcher and pause/resume tests
- cross-repo generated artifact consistency tests
- live validation that proves legacy routes still map correctly during migration

## Chainlink Lessons Applied

These are product-pattern lessons, not protocol-copying requirements.

- CRE: make workflows first-class and typed, instead of route-local orchestration logic.
- Automation: promote upkeep execution into a dedicated scheduler/supervisor layer.
- Functions: model external data access and off-chain compute as reusable execution steps.
- DataLink: centralize provider catalog, entitlements, and usage governance.
- CCIP Risk Management Network: add independent risk observation and circuit breaking.
- ACE: evaluate compliance/policy before and after execution, not only at the edge.
- Confidential Compute: keep the confidential boundary narrow and explicit.

## Official References

- Chainlink Runtime Environment: https://chain.link/chainlink-runtime-environment
- CRE launch, November 4, 2025: https://dev.chain.link/changelog/chainlink-runtime-environment-cre-is-live
- Chainlink Automation: https://docs.chain.link/chainlink-automation
- Chainlink Functions: https://docs.chain.link/chainlink-functions
- Chainlink Data Streams: https://docs.chain.link/data-streams
- Chainlink CCIP: https://docs.chain.link/ccip
- Chainlink DataLink: https://chain.link/datalink
- Chainlink Proof of Reserve: https://chain.link/proof-of-reserve
- Chainlink Automated Compliance Engine: https://chain.link/automated-compliance-engine
- Chainlink Privacy / Confidential systems direction: https://chain.link/privacy
