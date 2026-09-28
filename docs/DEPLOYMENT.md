# Deployment

## Canonical Host Paths

- code checkout: `/opt/neoos/services`
- secrets, generated environment, signer material, logs, and runtime state: `/opt/morpheus/nitro`
- compatibility-only code paths: `/opt/neo-morpheus-oracle` and
  `/opt/morpheus/neo-morpheus-oracle`

The systemd unit names and `MORPHEUS_*` environment variables remain stable
operator interfaces. New service units resolve code from `/opt/neoos/services`.
After installing and verifying the canonical checkout, preview and then create
backward-compatible links for older operator scripts:

```bash
npm run install:code-path-compat
sudo npm run install:code-path-compat -- --apply
```

The installer validates the checkout package identity, never modifies secrets,
and refuses to overwrite a real directory or an unrelated symbolic link. If an
old checkout still occupies either compatibility path, stop affected services,
archive that checkout explicitly, and rerun the dry-run before applying links.

## Canonical Production Topology

Morpheus now deploys by responsibility, not by network.

| Layer                  | Service                  | Current role                                                    |
| ---------------------- | ------------------------ | --------------------------------------------------------------- |
| Edge                   | Cloudflare gateway       | public ingress, caching, optional abuse controls                |
| Control                | Cloudflare control plane | auth, validation, job persistence, queue/workflow dispatch      |
| App                    | Vercel `apps/web`        | docs, explorer, backend APIs used by control plane              |
| State                  | Supabase                 | jobs, relayer state, automation, feed snapshots, encrypted refs |
| Confidential execution | Oracle CVM               | request/response oracle, compute, NeoDID, confidential signing  |
| Confidential execution | DataFeed CVM             | isolated feed publication lane                                  |

## Source Of Truth

- `config/networks/mainnet.json`
- `config/networks/testnet.json`
- `docs/ENVIRONMENT.md`
- `deploy/nitro/README.md`

Recommended operator rules:

- keep one root secret set in `.env`
- render dedicated Nitro env files per network
- keep `MORPHEUS_ACTIVE_CHAINS=neo_n3` for production
- never treat separate CVMs as separate networks; networks are selected by path and config

## Step 1: Apply Supabase

Apply every migration in `db/services/migrations/` in filename order. The
ordered list, including the dated migrations after `0020`, is maintained in
`db/services/README.md`.

Optional:

- `db/services/seed.sql`

Key durable tables:

- `morpheus_requests`
- `morpheus_feed_snapshots`
- `morpheus_relayer_jobs`
- `morpheus_automation_jobs`
- `morpheus_automation_runs`
- `morpheus_control_plane_jobs`
- `morpheus_operation_logs`

## Step 2: Deploy The Web App

Deploy `apps/web` to Vercel.

Required environment:

- `NEXT_PUBLIC_MORPHEUS_NETWORK`
- `MORPHEUS_RUNTIME_URL` or network-scoped runtime URLs
- `MORPHEUS_RUNTIME_TOKEN` or `NITRO_API_TOKEN` / `NITRO_SHARED_SECRET`
- `CRON_SECRET` for Vercel Cron requests (or `MORPHEUS_CRON_SECRET` for manual
  operator probes; the web app accepts either name)
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SECRET_KEY`
- `TWELVEDATA_API_KEY`

Recommended production environment:

- `MORPHEUS_CONTROL_PLANE_URL`
- `MORPHEUS_CONTROL_PLANE_API_KEY`
- `MORPHEUS_PROVIDER_CONFIG_API_KEY`
- `MORPHEUS_RELAYER_ADMIN_API_KEY`
- `MORPHEUS_SIGNING_ADMIN_API_KEY`
- `MORPHEUS_RELAY_ADMIN_API_KEY`
- `MORPHEUS_OPERATOR_API_KEY`
- `MORPHEUS_BETTERSTACK_CRON_FEED_HEARTBEAT_URL`
- `MORPHEUS_BETTERSTACK_CRON_FEED_FAILURE_URL`
- `MORPHEUS_BETTERSTACK_CRON_HEALTH_HEARTBEAT_URL`
- `NEXT_PUBLIC_WEB3AUTH_CLIENT_ID`
- `WEB3AUTH_CLIENT_SECRET`
- `NEXT_PUBLIC_WEB3AUTH_NETWORK`

After pulling or configuring Vercel production env, run:

```bash
npm run check:web-cron-env -- --fail-on-missing
npm run check:betterstack
```

The first command validates only key presence and never prints secret values. If
`morpheus-cron-feed` or `morpheus-cron-health` is still `pending`, the web cron
environment is not deployed or Vercel Cron is not triggering the routes. Root
`.env` / `.env.local` values are intentionally ignored by this check because the
Vercel `apps/web` deployment does not inherit them automatically.

Set Vercel's special `CRON_SECRET` on the production web deployment. Scheduled
requests carry it as `Authorization: Bearer <secret>`. Manual operator probes
may use `MORPHEUS_CRON_SECRET` through the `X-Morpheus-Cron` header; both names
are accepted when they are configured together.
If the control-plane feed endpoint rejects web dispatch credentials with 401/403,
the cron route falls back to direct runtime feed sync by default; set
`MORPHEUS_CONTROL_PLANE_FEED_FALLBACK_ON_AUTH=0` only after the control-plane key
mapping is confirmed.

## Step 3: Deploy Cloudflare Edge

Deploy `deploy/cloudflare/morpheus-edge-gateway`.

Required bindings:

- `MORPHEUS_ORIGIN_URL`
- `MORPHEUS_MAINNET_ORIGIN_URL`
- `MORPHEUS_TESTNET_ORIGIN_URL`
- `MORPHEUS_ORIGIN_TOKEN`
- `MORPHEUS_NETWORK` — the network an unprefixed path such as `/health` is
  served on (`mainnet` for the production gateway). Unset, unprefixed paths
  answer `400 network_required`; an unsupported value answers `500`.

Optional:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `TURNSTILE_SECRET_KEY`
- `MORPHEUS_RATE_LIMITER`

Current public pattern:

- `https://edge.meshmini.app/mainnet/*`
- `https://edge.meshmini.app/testnet/*`
- `https://oracle.meshmini.app/mainnet/api/runtime/catalog`
- `https://oracle.meshmini.app/mainnet/api/runtime/status`
- `https://oracle.meshmini.app/testnet/api/runtime/catalog`
- `https://oracle.meshmini.app/testnet/api/runtime/status`

## Step 4: Deploy Cloudflare Control Plane

Deploy `deploy/cloudflare/morpheus-control-plane`.

Required bindings:

- `MORPHEUS_ORACLE_REQUEST_QUEUE`
- `MORPHEUS_FEED_TICK_QUEUE`
- `CALLBACK_BROADCAST_WORKFLOW`
- `AUTOMATION_EXECUTE_WORKFLOW`

Required secrets:

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`

Recommended:

- `MORPHEUS_CONTROL_PLANE_API_KEY`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `MORPHEUS_MAINNET_EXECUTION_BASE_URL`
- `MORPHEUS_TESTNET_EXECUTION_BASE_URL`
- `MORPHEUS_MAINNET_FEED_EXECUTION_BASE_URL`
- `MORPHEUS_TESTNET_FEED_EXECUTION_BASE_URL`
- `MORPHEUS_EXECUTION_TOKEN`
- `MORPHEUS_APP_BACKEND_URL`
- `MORPHEUS_APP_BACKEND_TOKEN`

Current public pattern:

- `https://control.meshmini.app/mainnet/*`
- `https://control.meshmini.app/testnet/*`

## Step 5: Render Nitro Runtime Envs

Generate fresh env files before each deployment:

```bash
npm run render:nitro-compose-env:mainnet
npm run render:nitro-compose-env:testnet
npm run render:nitro-hub-env
npm run check:signers
npm run check:nitro-env
```

Notes:

- `npm run render:nitro-compose-env` aliases mainnet generation
- signer drift should fail deployment review
- generated env files stay local and uncommitted

## Step 6: Deploy The CVMs

### Oracle CVM

- name: `oracle-morpheus-neo-r3e`
- app id: `ddff154546fe22d15b65667156dd4b7c611e6093`
- role: request/response, compute, NeoDID, confidential signing
- baseline size: `Large TDX`

### DataFeed CVM

- name: `datafeed-morpheus-neo-r3e`
- app id: `ac5b6886a2832df36e479294206611652400178f`
- role: feed publication only
- baseline size: `Small TDX`

Historical CVM launchers (Node compatibility only; not production authority):

- `nitro.request-hub.toml`
- `nitro.feed-hub.toml`

Compatibility Compose files require explicitly pinned `MORPHEUS_COMPAT_*`
images and contain no default or `latest` tag:

- `deploy/nitro/docker-compose.request-hub.yml`
- `deploy/nitro/docker-compose.feed-hub.yml`

The production Rust service artifacts are:

- `deploy/nitro/Dockerfile.enclave`
- `deploy/nitro/Dockerfile.signer`
- `deploy/nitro/Dockerfile.relayer` (production Rust authority; immutable SHA tag only)

See [`PRODUCTION_RUST_TOPOLOGY.md`](./PRODUCTION_RUST_TOPOLOGY.md) before
deploying any compatibility launcher.

## Step 7: Configure The Relayer Modes

The Rust relayer is authoritative for Neo N3 and NeoX request/feed delivery:

- `MORPHEUS_ACTIVE_CHAINS=neo_n3`, `neox`, or both
- `MORPHEUS_RELAYER_MODE=requests_only`, `feed_only`, or `combined`
- `MORPHEUS_FEED_SYNC_ENABLED=true` plus symbols/contracts for a feed lane
- `MORPHEUS_AUTOMATION_ENABLED=false` (enforced fail-closed)

Every successful request or feed update is custody-signed, broadcast, confirmed
as HALT/receipt status 1, and durably recorded before state advances. Automation
does not yet have that commit protocol and configuration validation refuses it.

Important relayer durability settings:

- `MORPHEUS_DURABLE_QUEUE_ENABLED=true`
- `MORPHEUS_DURABLE_QUEUE_FAIL_CLOSED=true`
- `MORPHEUS_RELAYER_INSTANCE_ID`
- `MORPHEUS_RELAYER_NEO_N3_SCAN_MODE=request_cursor` on testnet

## Step 8: Publish Keys And Verify

After the runtime is live:

```bash
npm run publish:oracle-key
npm run publish:oracle-verifier-key
npm run smoke:control-plane
npm run smoke:n3
MORPHEUS_NETWORK=testnet npm run verify:n3
```

If you are deploying a new updater path:

```bash
npm run set:updater:n3
```

## Current Service Anchors

- Oracle runtime:
  - `https://oracle.meshmini.app/mainnet`
  - `https://oracle.meshmini.app/testnet`
  - public runtime contract: `/api/runtime/catalog`, `/api/runtime/status`
- Edge gateway:
  - `https://edge.meshmini.app/mainnet`
  - `https://edge.meshmini.app/testnet`
- Control plane:
  - `https://control.meshmini.app/mainnet`
  - `https://control.meshmini.app/testnet`
- Oracle attestation verification:
  - in-app `POST /api/attestation/verify` (or the `/verifier` page)
- DataFeed attestation verification:
  - in-app `POST /api/attestation/verify` (or the `/verifier` page)
- Neo N3 service anchors:
  - `oracle.morpheus.neo`
  - `pricefeed.morpheus.neo`
  - `neodid.morpheus.neo`
  - `smartwallet.neo`
- NeoDID anchor contract:
  - `NeoDIDRegistry`
  - published in `config/networks/mainnet.json`

## Operational Notes

- DataFeed is isolated so price updates keep their own execution lane.
- Mainnet and testnet may share Oracle/DataFeed CVM hardware, but each hub runs
  separate network-scoped worker and relayer processes with isolated runtime
  config and signer variables.
- Network separation is enforced in the compose topology, config, path prefix,
  and request metadata; a single mutable process must not serve both networks.
- Neo N3 remains the only supported production chain.
