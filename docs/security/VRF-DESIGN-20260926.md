# VRF Design and Domain Separation (2026-09-26)

Scope: the `random.generate` lane of the Rust enclave host (`workers/nitro-enclave-host`) and
the key it shares with the confidential game-session lane. This records the construction
introduced on branch `prep/vrf-domain`, what it fixes relative to `bb07163`, what it leaves
open for owner decision O18, and the status of the legacy Neo X host fulfiller.

## 1. Where randomness comes from

| Path                                                                                              | Caller                                                                                                                                                      | Output                                                                                                                                         |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /oracle/fulfill`, `random.generate` lane (`fulfill.rs` → `vrf::handle_vrf_fulfillment`)     | The relayer for on-chain requests: the Rust `neo-os-relayer` (`src/delivery.rs`), or the Node `morpheus-relayer` with `MORPHEUS_RELAYER_ENCLAVE_FULFILL` on | 32 bytes delivered as the compact callback; the fulfilment digest over them is signed by `oracle_verifier` (Neo N3) or `neox_verifier` (Neo X) |
| `POST /vrf/random` (`vrf::handle_vrf_random`)                                                     | Any holder of an enclave bearer token; the runtime probe in `scripts/runtime-service-matrix.mjs`                                                            | Custody-signed `{randomness}` envelope                                                                                                         |
| `POST /automation/execute` with a `random` execution (`automation.rs` → `vrf::handle_vrf_random`) | Bearer holders directly, or an on-chain `automation_*` request through `/oracle/fulfill`                                                                    | `{randomness}` nested in the automation result                                                                                                 |
| Node relayer local fallback (`workers/morpheus-relayer/src/fulfillment/executor.js`)              | Node relayer with enclave fulfilment off                                                                                                                    | `randomBytes(32)`; refused when `NODE_ENV=production`                                                                                          |
| `deploy/evm/neox-fulfiller.mjs`                                                                   | Nothing in the repositories (section 6)                                                                                                                     | `randomBytes(32)`                                                                                                                              |

The public edge (`deploy/cloudflare/morpheus-edge-gateway/worker.mjs`) does not map
`/vrf/random`; it answers 503 `runtime_route_unavailable`. Its runtime-box passthrough covers
only `/oracle/decrypt` and `/oracle/message-reveal`. The Cloudflare control plane answers 503
for `/automation/execute`.

Key material: `/provision` materializes one 32-byte root, `MORPHEUS_GAME_SECRET_ROOT_HEX`
(source `nitro-recipient-kms`), from the KMS envelope
`MORPHEUS_GAME_SECRET_KMS_CIPHERTEXT_BASE64` released for purpose `neoos/game-secret/v1` to
the attested enclave. The VRF and the game-session state machine (`neo_os_games::session`)
both use it.

## 2. The v1 construction (`bb07163`) and its problems

```text
randomness = HMAC-SHA256(root, LP("neoos-vrf-random-v1") || LP(network)
                               || LP(JSON(request_id)) || LP("random.generate"))
LP(x)      = u32_be(len(x)) || x
```

`network` was the first truthy payload alias (`network`, `morpheus_network`,
`runtime_network`, `environment`) naming `mainnet` or `testnet`, else the host network;
`request_id` was the payload value.

1. **No chain family, no oracle contract.** Both relayers send Neo N3 and Neo X request ids
   as decimal strings (Node: `String(event.requestId)`, with Neo X ids from
   `record.id.toString()`; Rust: the event's `requestId`). `/oracle/fulfill` forwards
   `chain`, but v1 ignored it, so N3 request `k` and Neo X request `k` under one network
   label received identical randomness, as would two oracle deployments whose counters
   overlap (for example an N3 oracle redeployed under a new measured contract hash).
2. **Lanes were interchangeable.** `/vrf/random`, or a nested automation execution with
   `request_id: "k"`, computed exactly the fulfil-lane output of on-chain request `k` under
   the same network label. The on-chain automation envelope omits nested results larger than
   384 bytes (`MAX_ONCHAIN_RESULT_VALUE_BYTES`, `crates/neo-os-core/src/envelope.rs`) and a
   signed VRF body is larger, so the fulfil path did not publish it; the exposure was bearer
   holders, who can compute outputs anyway (section 4). Any future route exposing
   `/vrf/random` or an automation result would have published the randomness of future
   on-chain requests.
3. **Payload-chosen network label on the fulfil lane.** There the VRF payload is the
   requester's on-chain payload, so its `network` alias chose the label bound into the
   output.
4. **One key, two purposes.** The game-session lane keys
   `problem_secret_for = HMAC(root, canonical)` and its resume-record proofs with the same
   root. The two uses were separated only by input format.

## 3. The v2 construction (this change)

### Keys

```text
k_vrf  = HKDF-SHA256(salt = "neoos-kms-secret-root/v1", ikm = root,
                     info = "neoos-vrf-random-key/v1",   L = 32)
k_game = HKDF-SHA256(salt = "neoos-kms-secret-root/v1", ikm = root,
                     info = "neoos-game-session-key/v1", L = 32)
```

`workers/nitro-enclave-host/src/secret_root.rs` owns the salt and both labels. No lane keys a
MAC with the root itself.

### Output

```text
randomness = HMAC-SHA256(k_vrf, LP("neoos-vrf-random-v2") || LP(lane) || LP(network)
                                || LP(chain) || LP(chain_id) || LP(oracle_contract)
                                || LP(JSON(request_id)) || LP(module_id))
```

| Field             | `/oracle/fulfill` (lane `oracle-fulfill`)                                                                                                                                          | `/vrf/random` and automation (lane `direct`)    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `network`         | the host's measured network                                                                                                                                                        | payload alias or host network, as before        |
| `chain`           | `neo_n3` or `neox` from the request body                                                                                                                                           | empty                                           |
| `chain_id`        | Neo N3: the measured network magic; Neo X: `fulfillment_context.chain_id`                                                                                                          | empty                                           |
| `oracle_contract` | Neo N3: the measured oracle contract, which `fulfillment_context.contract_script_hash` must name; Neo X: `fulfillment_context.oracle_contract` as `0x` and 40 lowercase hex digits | empty                                           |
| `request_id`      | the request body's `request_id` (a string)                                                                                                                                         | the payload's `request_id`, JSON type preserved |
| `module_id`       | `random.generate`                                                                                                                                                                  | `random.generate`                               |

Every field is length-framed, so distinct field tuples never encode to the same bytes. A v2
input always starts with the framed `neoos-vrf-random-v2` tag, which no v1 input shares, and
v2 is keyed with `k_vrf` where v1 used the root, so no v2 request reproduces a v1 output.

### Fulfil-lane validation

`handle_oracle_fulfill` resolves the domain before anything is computed. A failure is an
HTTP 400 for the whole call: nothing is computed or signed, so a malformed domain can never
settle as a signed unsuccessful fulfilment.

- `chain` must be a string that trims and lowercases to `neo_n3` or `neox`. Missing,
  `legacy`, other labels and non-strings are refused.
- Neo N3: `fulfillment_context.contract_script_hash` is required and must equal the measured
  oracle contract of the host network; a supplied `network_magic` must equal the measured
  magic.
- Neo X: `fulfillment_context.chain_id` is required and must be a positive integer;
  `fulfillment_context.oracle_contract` is required and must be an optional `0x` followed by
  40 hex digits (the spelling the Neo X digest builder accepts). It is bound as its 20
  bytes, so a checksummed or unprefixed spelling of the same address yields the same output
  and cannot re-roll a request.

Both relayers already send these fields (`workers/neo-os-relayer/src/delivery.rs`;
`buildEnclaveFulfillmentContext` in `workers/morpheus-relayer/src/fulfillment/enclave.js`), so
no relayer field was added; tests in both relayers now pin them. A relayer that omitted one
receives an error instead of a result to sign. The Node coordinator then applies its existing
error policy (retry, then a failure callback it signs itself once retries are exhausted or the
error is classified permanent); no randomness is produced.

### Game-session lane

The host passes `k_game` to `neo_os_games::session::SessionStore` wherever it passed the root.
The crate is unchanged, so its protocol, codec and vectors are unchanged: the shared vector
file `crates/neo-os-games/tests/vectors/game-result-v2.vectors.json` (byte-identical with
neo-os-contracts) still reproduces with the crate's test key `[9; 32]`. Host tests that derived
game secrets from the provisioned root now derive them through `k_game`. The host's kernel-lane
LOSS bytes for `session-loss-sudoku` necessarily differ from the vector in the two
key-dependent fields (commitment and loss answer hash, bytes 1 to 64); the host test checks the
remaining 47 bytes against the vector and recomputes the key-dependent 64 under `k_game`.

## 4. What remains open: operator predictability

The enclave reads no chain state on this lane, and every v2 input is known before the request
exists: request ids are sequential per oracle contract, and contract, chain id and network are
public. Anyone holding a token from the enclave's trusted set (`NITRO_SIGNER_TOKEN`,
`MORPHEUS_RUNTIME_TOKEN`, `NITRO_API_TOKEN`, `NITRO_SHARED_SECRET`; `auth.rs`) can post the body
of request `k + 1` to `/oracle/fulfill` before that request is submitted and learn its
randomness. The relayer holds such a token, as does any service configured with one of those
values (for example the edge gateway's runtime-box token when it is set to the runtime token).
The operator can therefore time or front-run requests, which is exactly the trust a TEE oracle
should remove.

- `bb07163` chose determinism to stop re-rolling: with the earlier OS CSPRNG the operator could
  retry a request until it saw a favoured value and submit that one. v2 keeps determinism.
- Neither construction is verifiable by third parties. The output is an HMAC under a key only
  the enclave holds; users rely on the attestation and the custody signatures. The comment in
  `workers/morpheus-relayer/src/fulfillment/executor.js` that rejects a request-bound
  derivation for the Node fallback ("a derivation whose seed is never revealed is
  unverifiable") applies equally to the enclave HMAC and should be reconciled when O18 is
  decided.
- Withholding survives every option below: whoever submits fulfilments sees the output first
  and can decline to fulfil a request whose outcome it dislikes. Any design needs on-chain
  handling for that (deadlines, alternate fulfillers, penalties).
- The direct and automation lanes are deterministic functions of caller-chosen ids. They are
  not a randomness source against anyone else who can call them, and should not be offered as
  one.

## 5. Options for O18

**A. ECVRF with published proofs, keyed by an enclave key (RFC 9381).** The enclave generates
or KMS-releases a VRF key pair, publishes the public key in an attestation document bound to its
PCRs, and the oracle contract (or an off-chain verifier) pins it. The enclave returns
`beta = ECVRF_proof_to_hash(pi)`, `pi = ECVRF_prove(sk, alpha)`, with `alpha` the v2 field
encoding, and delivers `pi` with the result.

- Gains: uniqueness, so for a given `alpha` exactly one output verifies and neither the operator
  nor the enclave can choose among outputs; anyone can verify the output against the pinned
  key.
- Does not stop prediction on its own: while `alpha` is known in advance and the operator can ask
  the enclave to evaluate it, the operator learns the output early. It needs B (or C) for that.
- Costs: a key lifecycle (generation, attestation, rotation, pinning on two chains), proof
  delivery, and verification cost. EVM verification of ECVRF proofs is established practice;
  Neo N3 on-chain verification has to be assessed. If verification stays off chain, contracts
  still trust the signature path.

**B. Chain-bound input verified in the enclave.** `alpha` additionally binds values fixed only
when the request is included, such as the request transaction hash and the including block hash
(or an inclusion-time value the oracle contract records in the request, for example N3
`System.Runtime.GetRandom`, which the block's primary can influence). The enclave refuses to
evaluate until it has verified that the request with that id, contract and payload exists in
that block.

- Verification choices: (B1) independent RPC reads from inside the enclave, from at least two
  providers the operator does not control, with TLS terminated in the enclave against pinned
  roots and agreement required; (B2) inclusion or state proofs checked against block headers the
  enclave follows (N3 state roots signed by the designated state validators, Neo X headers signed
  by its validator set), which is a light client per chain.
- Gains: nobody, the operator included, can compute an output before inclusion. dBFT
  single-block finality leaves no alternative final block to grind.
- Residual: after inclusion the operator sees the output before fulfilling (withholding); B1
  trusts the RPC providers not to collude with the operator; B2 needs validator-set tracking on
  two chains.
- Costs: enclave egress to RPC endpoints (the oracle lanes already have egress) or light-client
  code; the relayer already acts after inclusion, so latency grows only by the verification.

**C. Commit-reveal with a user seed.** The requester commits `H(s)` in the request, the enclave
output `r_e` is bound to the request, the requester later reveals `s`, and the contract derives
`H(r_e || s)`.

- Gains: the operator alone cannot predict the result without `s`, and the requester cannot
  without `r_e`.
- Residual: the operator can still predict `r_e` before the request, so a requester colluding
  with the operator controls the result; the revealer sees `r_e` before revealing and can abort,
  so the contract needs a reveal deadline and a default outcome; contract-initiated randomness
  (draws with no single user) has no natural seed holder.
- Costs: two transactions and a reveal window; changes to both oracle contracts and to every
  consumer.

| Property                                                          | A                        | B                                         | C                                  | A with B                 |
| ----------------------------------------------------------------- | ------------------------ | ----------------------------------------- | ---------------------------------- | ------------------------ |
| Operator cannot compute the output before the request is included | no                       | yes                                       | only without a colluding requester | yes                      |
| Output verifiable without trusting the enclave                    | yes                      | no                                        | no                                 | yes                      |
| Withholding after inclusion still possible                        | yes                      | yes                                       | yes (and revealer abort)           | yes                      |
| Oracle contract changes                                           | key pinning and verifier | none, or an inclusion-time snapshot field | two-phase flow                     | key pinning and verifier |
| Enclave changes                                                   | VRF key and prover       | RPC quorum or light client                | none                               | both                     |

Technical recommendation for the owner: A with B. Bind `alpha` to the including block, verified
first through an RPC quorum (B1) and later through proofs (B2), and publish an ECVRF proof with
each result. If only one step is taken, B closes the operator-predictability finding and A adds
verifiability. C fits only application-level, user-initiated randomness.

## 6. `deploy/evm/neox-fulfiller.mjs`

The script fulfils `random.generate` with a local `randomBytes(32)` and signs with host-held
keys. Nothing in the repositories deploys or starts it:

- It exits 78 before reading a key when `NODE_ENV=production`, and also unless
  `MORPHEUS_ALLOW_INSECURE_HOST_EVM_SIGNER` is set (`deploy/evm/neox-fulfiller.test.mjs` covers
  both exits and runs under `npm run test:ops`).
- Its unit `deploy/evm/morpheus-neox-fulfiller.service` has no `[Install]` section, requires the
  marker `/opt/morpheus/nitro/ENABLE_NODE_NEOX_FULFILLER_COMPAT`, sets `NODE_ENV=production` (so
  the unit can only start a process that exits 78), and conflicts with both Rust relayer units,
  which list it in their own `Conflicts=`.
- `scripts/check-rust-production-topology.mjs` requires the production exit, forbids a runbook
  that enables the unit, and classifies the unit as a historical writer behind a compatibility
  marker. `deploy/evm/RUNBOOK.md` documents it as a non-production compatibility artifact.
- The remaining references are documentation and inventory: `deploy/evm/validate-vrf.mjs` (a
  manual check whose timeout message asks whether the fulfiller is running), the Nitro gap notes,
  `docs/PRODUCTION_RUST_TOPOLOGY.md`, and in sibling repositories
  `neo-os-web/docs/workspace/hot-key-baseline.v1.json` (listed as non-production) and workspace
  audit notes. No CI workflow, install script or other unit references it.

Host state was not inspected for this change: whether any machine has the compatibility marker,
or runs the script by hand outside production with the insecure-signer flag, is not established
here. Retiring the script, its unit, env example and test (and the matching topology-gate and
runbook entries) is a separate change.

## 7. Deployment notes

- Every VRF output changes at deployment. A `random.generate` request attempted under v1 but not
  yet settled gets a different value under v2, which gives the relayer operator two values to
  choose from for such requests. Deploy with the `random.generate` queue drained, or accept that
  window.
- Changing the game key is equivalent to rotating the game root for sessions in flight: a session
  started before the deployment cannot be rebuilt from its HMAC resume record or finalized
  against its committed problem afterwards. RewardGame settlement stays open for at most
  `MAX_SETTLE_AGE_MS` (26 hours), which bounds the affected window.
- Signatures, envelopes and fulfilment digests are computed exactly as before, over the new
  bytes.

## 8. Tests

`workers/nitro-enclave-host`:

- `secret_root::tests`: the RFC 5869 reference (test case 1), both subkeys against the reference
  and against values computed outside Rust, and distinct, non-root keys for both purposes.
- `vrf::tests::fulfilled_randomness_follows_the_v2_construction_on_both_chains`: fulfil-lane
  output equals an independent implementation of section 3 and pinned values.
- `vrf::tests::identical_request_ids_on_neo_n3_and_neox_get_different_randomness`.
- `vrf::tests::different_oracle_contracts_get_different_randomness`: different contracts, the same
  address on another chain id, and spelling-independence.
- `vrf::tests::vrf_fulfillment_refuses_a_missing_or_malformed_chain_domain_before_computing`: 18
  malformed bodies, each a 400 with no compute and no signing call.
- `vrf::tests::every_domain_field_changes_the_vrf_input` and that the payload's network label
  cannot move a fulfilment.
- `vrf::tests::v2_never_reproduces_a_v1_output`.
- `vrf::tests::neither_the_direct_route_nor_the_automation_lane_reproduces_a_fulfilled_output`.
- `session::tests::the_game_lane_keys_its_hmacs_with_the_game_session_subkey`.

`workers/morpheus-relayer`: `flag-ON VRF sends the chain domain the enclave binds` for `neo_n3`
and `neox`. `workers/neo-os-relayer`: the N3 and Neo X delivery tests assert the chain domain in
the `/oracle/fulfill` body.

Each new enclave test was run against a build with its guard reverted (chain domain, chain family,
contract, chain id or canonical spelling unbound; validation removed; the v1 construction, the v1
tag or the raw root restored; the VRF keyed with the game key; the game lane keyed with the root
or the VRF key; one label for both purposes; the fulfil lane encoded as the direct lane) and
failed in every case. Removing the contract fields from the Node relayer's fulfil context fails
both relayer tests.
