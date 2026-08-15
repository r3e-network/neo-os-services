# External Integrations

**Analysis Date:** 2026-07-04

## APIs & External Services

**Blockchain / RPC:**

- Neo N3 — Primary production chain for oracle requests, data feeds, and smart-contract logic
  - SDK/Client: `@cityofzion/neon-js` 5.8.1
  - Connection: `NEO_RPC_URL` env var (e.g., `https://api.n3index.dev/testnet` or mainnet RPCs)
  - Network magic: `NEO_NETWORK_MAGIC` (testnet 894710606, mainnet 860833102)
  - Contract hashes: `CONTRACT_MORPHEUS_ORACLE_HASH`, `CONTRACT_MORPHEUS_DATAFEED_HASH`, `CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH`
  - Key files: `workers/nitro-worker/src/chain/neo-n3.js`, `workers/morpheus-relayer/src/neo-n3.js`, `deploy/feed-pusher/feed-pusher.mjs`

- Neo X (EVM) — Secondary EVM chain for price feeds and oracle mirrors
  - SDK/Client: `ethers` 6.16.0
  - Connection: `NEOX_RPC` env var (e.g., `https://mainnet-1.rpc.banelabs.org`)
  - Chain ID: `NEOX_CHAIN_ID` (default 47763)
  - Contract: `MorpheusPriceFeed` / `MorpheusOracleEVM` in `contracts-evm/`
  - Key files: `contracts-evm/MorpheusPriceFeed.sol`, `contracts-evm/MorpheusOracleEVM.sol`, `deploy/feed-pusher/feed-pusher.mjs`, `deploy/evm/neox-fulfiller.mjs`

**Price Feed / Market Data:**

- TwelveData — Primary paid market-data provider for equities, crypto, forex, and commodities
  - SDK/Client: Direct HTTPS fetch
  - Auth: `TWELVEDATA_API_KEY` env var
  - Endpoints: `https://api.twelvedata.com/price` (and configurable `endpoint` param)
  - Key files: `workers/nitro-worker/src/oracle/providers.js`, `deploy/feed-pusher/feed-pusher.mjs`, `workers/nitro-worker/src/oracle/feeds.js`

- Binance Spot — Free crypto ticker endpoint
  - SDK/Client: Direct HTTPS fetch
  - Auth: none
  - Endpoint: `https://api1.binance.com/api/v3/ticker/price`
  - Key files: `workers/nitro-worker/src/oracle/providers.js`

- Coinbase Spot — Free spot-price endpoint
  - SDK/Client: Direct HTTPS fetch
  - Auth: none
  - Endpoint: `https://api.coinbase.com/v2/prices/<pair>/spot`
  - Key files: `workers/nitro-worker/src/oracle/providers.js`

**Authentication & Identity:**

- Web3Auth — Social/login wallet auth for the web app
  - SDK/Client: Client-side integration via `NEXT_PUBLIC_WEB3AUTH_CLIENT_ID` and `WEB3AUTH_CLIENT_SECRET`
  - Network: `NEXT_PUBLIC_WEB3AUTH_NETWORK` (default `sapphire_mainnet`)
  - JWKS endpoint: `https://api-auth.web3auth.io/.well-known/jwks.json`
  - Key files: `apps/web/lib/provider-catalog.ts`, `apps/web/components/launchpad/Launchpad.tsx`

- Custom admin/runtime auth — API keys and bearer tokens for admin and runtime-to-runtime calls
  - Env vars: `MORPHEUS_RUNTIME_TOKEN`, `MORPHEUS_PROVIDER_CONFIG_API_KEY`, `MORPHEUS_RELAYER_ADMIN_API_KEY`, `MORPHEUS_SIGNING_ADMIN_API_KEY`, `MORPHEUS_RELAY_ADMIN_API_KEY`, `MORPHEUS_OPERATOR_API_KEY`, `ADMIN_CONSOLE_API_KEY`, `CRON_SECRET`
  - Key files: `apps/web/lib/server-supabase.ts`, `deploy/cloudflare/morpheus-edge-gateway/worker.mjs`, `deploy/cloudflare/morpheus-control-plane/worker.mjs`

**Cloud / Edge:**

- Cloudflare Workers — Edge gateway and control plane
  - SDK/Client: Cloudflare Workers runtime APIs (`fetch`, `crypto`, Queues, Cache, Durable Objects/Workflows where available)
  - Auth: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_DNS_API_TOKEN`
  - Services: Queues (`morpheus-oracle-request`, `morpheus-feed-tick`), Workflows (`callback_broadcast`, `automation_execute`), Turnstile, DNS
  - Key files: `deploy/cloudflare/morpheus-edge-gateway/worker.mjs`, `deploy/cloudflare/morpheus-control-plane/worker.mjs`, `deploy/cloudflare/morpheus-control-plane/lib/workflows.js`

- Cloudflare Turnstile — Bot protection for public lanes
  - Endpoint: `https://challenges.cloudflare.com/turnstile/v0/siteverify`
  - Env vars: `TURNSTILE_SITE_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_WORKER_SECRET`
  - Protected paths: `/paymaster/authorize`, `/relay/transaction`, `/compute/execute`, `/vrf/random`
  - Key files: `deploy/cloudflare/morpheus-edge-gateway/worker.mjs`

**AWS:**

- AWS Nitro Enclaves — Confidential VM runtime
  - Helper: `deploy/nitro/nsm-attest/` (Go + `github.com/hf/nsm`)
  - Key files: `deploy/nitro/Dockerfile.enclave`, `deploy/nitro/enclave-server.mjs`, `deploy/nitro/nsm-attest/main.go`

- AWS KMS — Key material inside the enclave (optional Phase-D EVM feed-sign path)
  - SDK/Client: `github.com/aws/aws-sdk-go-v2/service/kms` in `nsm-attest`
  - Key files: `deploy/nitro/nsm-attest/go.mod`, `deploy/nitro/KMS-ATTESTATION-DESIGN.md`

- AWS Secrets Manager — Secrets retrieval inside the Nitro worker
  - SDK/Client: `@aws-sdk/client-secrets-manager` 3.0.0
  - Key files: `workers/nitro-worker/src/platform/script-source.js`, `workers/nitro-worker/package.json`

**Email (Optional):**

- Resend — Transactional email (not actively wired in the current code paths, but provisioned)
  - Auth: `RESEND_API_KEY` env var
  - Key files: `.env.example`, `.env.production.example`

## Data Storage

**Databases:**

- PostgreSQL on Supabase — Primary durable store for jobs, requests, automation, feed snapshots, operation logs, provider configs, and project registry
  - Connection: `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (server), `NEXT_PUBLIC_SUPABASE_ANON_KEY` (client)
  - Client: `@supabase/supabase-js` 2.89.0; direct REST/PostgREST calls also used in `workers/nitro-worker/src/platform/core.js`
  - Migrations: `supabase/migrations/0001_morpheus_schema.sql` through `0015_harden_operational_table_rls.sql`
  - Key files: `apps/web/lib/server-supabase.ts`, `workers/nitro-worker/src/oracle/providers.js`, `supabase/README.md`

**File Storage:**

- Not detected. No S3/Supabase Storage usage observed for user uploads.

**Caching:**

- Upstash Redis (REST) — Rate limiting, idempotency locks, and short-lived caching
  - Connection: `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` env vars
  - Client: Direct HTTPS REST calls (no Redis node client)
  - Key files: `apps/web/lib/upstash.ts`, `apps/web/lib/rate-limit.ts`, `workers/nitro-worker/src/platform/upstash.js`, `packages/shared/src/rate-limit.js`

- In-memory caches — Bounded Maps in the Nitro worker for provider configs, provider responses, and feed state
  - Key files: `workers/nitro-worker/src/oracle/providers.js`, `workers/nitro-worker/src/oracle/feeds/feed-state.js`

- Cloudflare Cache API — Edge caching for safe GET routes
  - Key files: `deploy/cloudflare/morpheus-edge-gateway/worker.mjs`

## Authentication & Identity

**Auth Provider:**

- Web3Auth (sapphire_mainnet) — Wallet/social sign-in for the web app
  - Token storage: JWT verified server-side against Web3Auth JWKS
  - Key files: `apps/web/lib/provider-catalog.ts`, `apps/web/components/launchpad/Launchpad.tsx`

- Custom API-key auth — For admin endpoints and runtime-to-runtime trust
  - Headers: `x-admin-api-key`, `authorization: Bearer <token>`, `x-morpheus-runtime-token`
  - Key files: `apps/web/lib/server-supabase.ts`, `deploy/cloudflare/morpheus-edge-gateway/worker.mjs`

**OAuth Integrations:**

- Not detected beyond Web3Auth's embedded OAuth providers (Google, Twitter, etc.) configured in the Web3Auth dashboard.

## Monitoring & Observability

**Error Tracking:**

- Sentry — Next.js app errors and performance
  - DSN/org/project via: `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` env vars
  - Key files: `apps/web/next.config.mjs`, `apps/web/sentry.server.config.ts`, `apps/web/sentry.edge.config.ts`, `apps/web/instrumentation.ts`

**Analytics / Telemetry:**

- Better Stack — Uptime heartbeats, monitors, log ingestion, and telemetry
  - Tokens: `BETTERSTACK_UPTIME_API_TOKEN`, `BETTERSTACK_TELEMETRY_TOKEN`, `MORPHEUS_BETTERSTACK_LOG_INGESTING_HOST`, `MORPHEUS_BETTERSTACK_LOG_SOURCE_TOKEN`
  - Heartbeats: many `MORPHEUS_BETTERSTACK_*_HEARTBEAT_URL` / `*_FAILURE_URL` env vars
  - Key files: `workers/morpheus-relayer/src/betterstack-log-sink.js`, `workers/morpheus-relayer/src/logger.js`, `scripts/betterstack-*.mjs`

- Checkly — Synthetic API and browser checks
  - Auth: `CHECKLY_API_KEY`, `CHECKLY_ACCOUNT_ID`, `CHECKLY_PROJECT_NAME`
  - Key files: `scripts/checkly-list-checks.mjs`, `scripts/checkly-sync-api-checks.mjs`, `scripts/checkly-sync-browser-checks.mjs`, `monitoring/checkly/README.md`

**Metrics:**

- Prometheus (self-scrape) — Relayer exposes `/metrics` on `MORPHEUS_RELAYER_METRICS_HOST`/`PORT`
  - Key files: `workers/morpheus-relayer/src/prometheus.js`, `workers/morpheus-relayer/src/metrics-server.js`, `workers/morpheus-relayer/src/cli.js`

- Grafana Cloud (optional secondary) — Remote-write Prometheus metrics
  - Env vars: `GRAFANA_CLOUD_PROMETHEUS_PUSH_URL`, `GRAFANA_CLOUD_PROMETHEUS_USERNAME`, `GRAFANA_CLOUD_PROMETHEUS_API_KEY`
  - Key files: `monitoring/grafana/README.md`, `monitoring/grafana/alloy.relayer.example.alloy`, `deploy/systemd/grafana-alloy.service`

**Logs:**

- Better Stack log sink — Batched JSON logs from the relayer
- stdout/stderr — Default log streams for all Node services; Cloudflare Workers use `console.log`/`console.error`

## CI/CD & Deployment

**Hosting:**

- Vercel — Next.js web app (`apps/web`)
  - Deployment: `deploy-web.yml` workflow on push to `main` or manual dispatch
  - Secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`
  - Key files: `.github/workflows/deploy-web.yml`, `apps/web/next.config.mjs`

- Cloudflare Workers — Edge gateway and control plane
  - Deployment: Manual via Wrangler (`wrangler.meshmini.toml`); not currently automated in GitHub Actions
  - Key files: `deploy/cloudflare/morpheus-edge-gateway/wrangler.meshmini.toml`, `deploy/cloudflare/morpheus-control-plane/wrangler.meshmini.toml`

- AWS Nitro / EC2 — Confidential execution plane
  - Deployment: `deploy/nitro/` scripts, Docker Compose, and EIF build scripts
  - Key files: `deploy/nitro/provision-enclave-compute.sh`, `deploy/nitro/build-enclave-eif.sh`, `deploy/nitro/docker-compose.yml`

**CI Pipeline:**

- GitHub Actions — `ci.yml`, `deploy-web.yml`, `publish-images.yml`
  - Node 22, npm ci, format/lint checks, web/worker/ops/control-plane tests, Neo contract build, .NET tests
  - Secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `GITHUB_TOKEN` (for ghcr.io)
  - Key files: `.github/workflows/ci.yml`, `.github/workflows/publish-images.yml`

**Container Registry:**

- GitHub Container Registry (`ghcr.io`)
  - Images: `neo-morpheus-oracle-nitro-worker`, `neo-morpheus-oracle-relayer`
  - Key files: `.github/workflows/publish-images.yml`, `workers/nitro-worker/Dockerfile`, `workers/morpheus-relayer/Dockerfile`

## Environment Configuration

**Development:**

- Required env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEO_RPC_URL`, `NEO_NETWORK_MAGIC`, `MORPHEUS_RUNTIME_TOKEN`, `TWELVEDATA_API_KEY`
- Secrets location: `.env.local` (gitignored), `.env.development.example`
- Mock/stub services: local Supabase (`http://127.0.0.1:54321`), testnet Neo RPC, testnet Web3Auth, disabled Upstash by default

**Staging:**

- Not a separate environment file; staging is typically a separate Supabase project and testnet configuration
- Uses testnet RPCs and testnet contracts

**Production:**

- Secrets management: Vercel dashboard, Cloudflare Workers secrets, and enclave environment variables
- Mainnet RPCs and mainnet contract hashes (see `.env.production.example`)
- Failover/redundancy: multiple Neo N3 RPCs configured in `deploy/feed-pusher/feed-pusher.mjs`; Cloudflare Workers edge distribution

## Webhooks & Callbacks

**Incoming:**

- Cloudflare Workers `fetch` handler — Control-plane job ingress and edge gateway routing
- Cloudflare Queue consumer — `processExecutionJob`, `processFeedTickJob`, `processDeadLetterJob` in `deploy/cloudflare/morpheus-control-plane/worker.mjs`
- Cloudflare Scheduled trigger — `scheduled` recovery job re-queues stuck jobs
- Vercel cron / Next.js API routes — Cron-auth protected routes (`CRON_SECRET`)

**Outgoing:**

- On-chain callbacks — Relayer delivers oracle fulfillments to `MorpheusOracle` / `OracleCallbackConsumer` on Neo N3 and `MorpheusOracleEVM` on Neo X
- Better Stack heartbeat pings — Many `MORPHEUS_BETTERSTACK_*_HEARTBEAT_URL` env vars trigger periodic GET heartbeats
- Better Stack log ingestion — `POST https://<ingesting-host>` from `workers/morpheus-relayer/src/betterstack-log-sink.js`
- Web3Auth JWKS fetch — `GET https://api-auth.web3auth.io/.well-known/jwks.json`

---

_Integration audit: 2026-07-04_
_Update when adding/removing external services_
