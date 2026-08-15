# Nitro / CVM Deployment

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

For mainnet request fulfillment, keep the signer roles explicit and network-scoped:

- `MORPHEUS_RELAYER_NEO_N3_WIF_MAINNET` / `MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_MAINNET`
- `MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET` / `MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_MAINNET`

`npm run render:nitro-hub-env` reads those values from local secure env
overrides such as `.env.local` before falling back to packed runtime config.
Do not use the domain-owner signer for request fulfillment.

Recommended durability settings:

- `MORPHEUS_DURABLE_QUEUE_ENABLED=true`
- `MORPHEUS_DURABLE_QUEUE_FAIL_CLOSED=true`
- `MORPHEUS_RELAYER_INSTANCE_ID=<stable-id>`

## Deployment

Deploy runs inside an AWS Nitro Enclave. Build the enclave image, then launch
it on a Nitro-capable host and provision secrets via the enclave scripts:

```bash
# Build the Nitro Enclave Image File (EIF) for the worker + signer
./deploy/nitro/build-enclave-eif.sh

# On the Nitro-capable host: launch the signer enclave, then provision the
# in-enclave worker compute (chain config, provider keys, auth token, and the
# AWS credentials the SDK egresses through the vsock proxy)
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
`MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64`. The ciphertext plaintext is a
versioned JSON envelope bound to purpose `neoos/nitro-runtime-auth/v1` and the
target network. On first `/provision`, KMS releases that envelope only to the
expected enclave measurement; the request bearer must match it. Plaintext token
fields are never installed from the request body, and later rotation requires
the current token plus a strictly newer KMS-envelope version.

## Required Runtime Capabilities

The Oracle runtime should be provisioned with:

- `MORPHEUS_RUNTIME_TOKEN` (or `NITRO_API_TOKEN`)
- `MORPHEUS_RUNTIME_CONFIG_JSON`
- Supabase server credentials
- pinned N3 signing identities
- optional Better Stack telemetry values

The DataFeed runtime should be provisioned with the same runtime config but operate in feed-only mode.
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
