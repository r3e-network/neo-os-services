# Testnet Runbook

## 1. Install dependencies

```bash
npm install
```

## 2. Prepare env

```bash
cp .env.development.example .env.local
```

Fill in at least:

- `MORPHEUS_RUNTIME_URL`
- `MORPHEUS_RUNTIME_TOKEN`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SECRET_KEY`
- optional `MORPHEUS_PROVIDER_CONFIG_API_KEY` or `ADMIN_CONSOLE_API_KEY`
- optional scoped admin keys:
  - `MORPHEUS_RELAYER_ADMIN_API_KEY`
  - `MORPHEUS_SIGNING_ADMIN_API_KEY`
  - `MORPHEUS_RELAY_ADMIN_API_KEY`
  - `MORPHEUS_OPERATOR_API_KEY`
- optional `MORPHEUS_FEED_PROJECT_SLUG` and `MORPHEUS_FEED_PROVIDER`
- `NEO_N3_WIF`
- `MORPHEUS_WORKER_NEO_N3_WIF` or `MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY`
- optional `TWELVEDATA_API_KEY`

## 3. Apply Supabase schema

Run:

- `supabase/migrations/0001_morpheus_schema.sql`
- `supabase/migrations/0002_morpheus_policies_and_seeds.sql`
- `supabase/migrations/0003_provider_configs.sql`
- `supabase/migrations/0004_relayer_ops.sql`
- `supabase/migrations/0005_operation_logs.sql`
- `supabase/migrations/0006_automation.sql`
- optional `supabase/seed.sql`

## 4. Build contracts

```bash
cd contracts
./build.sh
```

## 5. Deploy contracts

### Neo N3

```bash
node scripts/deploy-service-gateway.mjs
node scripts/deploy-callback-consumer.mjs
```

Write deployed addresses into:

- `CONTRACT_MORPHEUS_ORACLE_HASH`
- `CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH`
- `CONTRACT_MORPHEUS_DATAFEED_HASH`

## 6. Configure contracts

```bash
node scripts/setup-morpheus.mjs
npm run publish:oracle-key
npm run write:addresses
```

## 7. Validate worker, relayer, and web

```bash
npm --prefix workers/nitro-worker test
npm --prefix workers/morpheus-relayer test
npm --prefix apps/web run build
```

## 8. Launch local relayer and web

```bash
npm --prefix workers/morpheus-relayer run once
npm --prefix workers/morpheus-relayer run metrics
npm --prefix apps/web run dev
```

## 9. Smoke checks

- `GET /api/health`
- `GET /api/oracle/public-key`
- `GET /api/compute/functions`
- `GET /api/feeds/NEO-USD`
- `GET /api/provider-configs?project_slug=morpheus` with `x-admin-api-key` if configured
- `GET /api/relayer/metrics` with `x-admin-api-key` if configured
- run one `compute` builtin call
- run one `oracle smart-fetch` call with encrypted payload
