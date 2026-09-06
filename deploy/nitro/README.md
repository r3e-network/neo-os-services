# Nitro / CVM Deployment

Production service authority, immutable image publication, and the explicit
Rust-authority/Node-compatibility boundary are documented in
[`docs/PRODUCTION_RUST_TOPOLOGY.md`](../../docs/PRODUCTION_RUST_TOPOLOGY.md).

This directory contains the canonical Morpheus deployment layout for the confidential
execution plane (AWS Nitro signer plus the worker runtime).

For environment variable details, see `docs/ENVIRONMENT.md`.

## Current CVM Topology

Morpheus uses **two role-specialized CVMs**.

### Oracle CVM

- name: `oracle-morpheus-neo-r3e`
- app id: `ddff154546fe22d15b65667156dd4b7c611e6093`
- baseline size: `Large TDX`
- responsibilities:
  - request/response oracle
  - confidential compute
  - NeoDID private flows
  - confidential signing
  - attested response generation

### DataFeed CVM

- name: `datafeed-morpheus-neo-r3e`
- app id: `ac5b6886a2832df36e479294206611652400178f`
- baseline size: `Small TDX`
- responsibilities:
  - feed synchronization
  - feed publication
  - continuous market-data lane isolation

This split ensures pricefeeds keep running even when request/response traffic is bursty.

## Routing Model

- Oracle public entry:
  - `https://oracle.meshmini.app/mainnet`
  - `https://oracle.meshmini.app/testnet`
- Oracle attestation verification:
  - in-app `POST /api/attestation/verify` (or the `/verifier` page)
- DataFeed attestation verification:
  - in-app `POST /api/attestation/verify` (or the `/verifier` page)

Mainnet and testnet may share the same Oracle and DataFeed CVM hardware, but
they do not share a mutable worker process. The request and feed hubs run
separate mainnet/testnet worker and relayer services, each with its own runtime
config, signer variables, and `MORPHEUS_NETWORK` value. Network selection is
also carried in the public path and forwarded request metadata.

## Compose Files

- `deploy/nitro/docker-compose.request-hub.yml`
- `deploy/nitro/docker-compose.feed-hub.yml`
- `deploy/nitro/docker-compose.ui.yml`
- `deploy/nitro/docker-compose.ingress.ui.yml`

## Recommended Render Flow

```bash
npm run render:nitro-env:mainnet
npm run render:nitro-env:testnet
npm run render:nitro-hub-env
npm run check:signers
npm run check:nitro-env
```

Notes:

- `npm run render:nitro-env` aliases mainnet
- signer identities are pinned in `config/signer-identities.json`
- generated env files stay local and uncommitted

## Relayer Modes

Use explicit relayer mode per CVM:

- Oracle CVM: `MORPHEUS_RELAYER_MODE=requests_only`
- DataFeed CVM: `MORPHEUS_RELAYER_MODE=feed_only`
- Co-located request + feed delivery: `MORPHEUS_RELAYER_MODE=combined`

Each mode may select `neo_n3`, `neox`, or both through
`MORPHEUS_ACTIVE_CHAINS`. Feed modes require feed sync, symbols, and the active
chain datafeed contracts. Automation remains disabled and fails configuration
validation if enabled.

For mainnet request fulfillment, provision the custody signer roles instead of
any WIF (no signing key material is provisioned to relayers or workers):

- `SIGNER_SERVICE_URL` / `SIGNER_SERVICE_TOKEN`
- `SIGNER_ROLE_UPDATER_KEY_ID` (Neo N3 transaction authority used by Rust
  request and feed delivery through custody)
- `SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID` (Neo N3 fulfillment-proof authority)
- `SIGNER_ROLE_RELAYER_KEY_ID` (dedicated relayer custody role measured into
  the frontier even when a selected lane does not consume it)
- `SIGNER_ROLE_WORKER_KEY_ID` (dedicated raw-only signed-result role)
- `SIGNER_ROLE_NEOX_UPDATER_KEY_ID` (EIP-1559 transaction authority used by
  Rust NeoX request and feed delivery; it is not a host private key)
- `SIGNER_ROLE_NEOX_VERIFIER_KEY_ID` (semantic EIP-191 fulfillment-proof
  authority; it must be a different custody key from the NeoX updater)

The custody caller used by raw lanes needs `raw_sign`; semantic transaction and
consensus callers need `sign`. A key policy cannot combine `allow_raw` with
semantic authority.

`npm run render:nitro-hub-env` renders only the oracle verifier PUBLIC key;
custody vars are interpolated from the deployment shell env. Fulfillment signs
with the custody updater key — never the domain-owner signer.

Recommended durability settings:

- `MORPHEUS_DURABLE_QUEUE_ENABLED=true`
- `MORPHEUS_DURABLE_QUEUE_FAIL_CLOSED=true`
- `MORPHEUS_RELAYER_INSTANCE_ID=<stable-id>`

## Deployment

Deploy runs inside an AWS Nitro Enclave. Build the enclave image, then launch
it on a Nitro-capable host and provision secrets via the enclave scripts:

```bash
# Build the network- and custody-bound Nitro Enclave Image File (EIF)
MORPHEUS_NETWORK=mainnet \
SIGNER_SERVICE_URL=https://custody.internal.example \
SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID=<raw-verifier-key-id> \
SIGNER_ROLE_UPDATER_KEY_ID=<raw-updater-key-id> \
SIGNER_ROLE_RELAYER_KEY_ID=<raw-relayer-key-id> \
SIGNER_ROLE_WORKER_KEY_ID=<raw-worker-key-id> \
SIGNER_ROLE_NEOX_UPDATER_KEY_ID=<neox-updater-key-id> \
SIGNER_ROLE_NEOX_VERIFIER_KEY_ID=<neox-verifier-key-id> \
  ./deploy/nitro/build-enclave-eif.sh

# On the Nitro-capable host: launch the signer enclave, then provision the
# in-enclave worker compute (KMS ciphertext, provider keys, auth token, and
# temporary AWS credentials used only for Recipient decrypt requests)
./deploy/nitro/start-nitro-signer.sh
./deploy/nitro/provision-enclave-compute.sh
```

Run one compose per role:

- Oracle CVM: `deploy/nitro/docker-compose.request-hub.yml`
- DataFeed CVM: `deploy/nitro/docker-compose.feed-hub.yml`

The request/feed hub compose files intentionally contain one worker pair per
network. Do not collapse them back into a single process whose network is chosen
from mutable request metadata.

Inject secrets through the enclave provisioning scripts rather than baking
plaintext env files into the image. Enable the mainnet request profile only
after the mainnet request/updater signer pair is present and
`npm run check:signers` passes.

The host transport config must contain a non-empty `MORPHEUS_RUNTIME_TOKEN`,
`NITRO_SIGNER_TOKEN`, `NITRO_API_TOKEN`, or `NITRO_SHARED_SECRET`, plus
`MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64` and the distinct
`SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64`. The runtime ciphertext plaintext is a
versioned JSON envelope bound to purpose `neoos/nitro-runtime-auth/v1` and the
target network; the custody caller envelope uses
`neoos/custody-caller-token/v1`. On the one allowed `/provision`, KMS releases
those envelopes only
to the expected enclave measurement; the request bearer must match it. Plaintext
token fields are never installed from the request body. Later calls return 409.
Temporary AWS credentials rotate through `/provision/credentials`; rotating
runtime or confidential key material requires a fresh enclave boot.

## Required Runtime Capabilities

The Rust Oracle frontier accepts only the provisioning allowlist in
`docs/RUST_SERVICE_MIGRATION.md`: KMS ciphertexts, temporary AWS credentials,
and TwelveData provider credentials. `NODE_ENV`, network, endpoints, custody
routing, Supabase, policy switches, and trust anchors are image-owned and are
rejected at `/provision`.

The DataFeed compatibility runtime uses its own deployment configuration and
operates in feed-only mode.
The DataFeed compose also exposes a small Caddy router on `MORPHEUS_PUBLIC_PORT` so the control
plane can route `feed_tick` jobs to the dedicated feed workers instead of the request hub.

## Key Operational Notes

- keep `/var/run/dstack.sock` mounted
- keep the Oracle transport key sealed in the CVM volume
- do not rotate worker or verifier signers accidentally
- use `request_cursor` scan mode on testnet
- keep DataFeed isolated; do not merge it back into the Oracle runtime

## Post-Deploy Verification

```bash
npm run smoke:n3
npm run smoke:control-plane
npm run check:signers
MORPHEUS_NETWORK=testnet npm run verify:n3
```

If you need direct runtime confirmation inside the guest:

```bash
curl http://127.0.0.1:8080/health
docker exec -it morpheus-relayer npm --prefix workers/morpheus-relayer run metrics
```
