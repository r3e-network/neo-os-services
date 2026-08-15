# SaaS Stack Integration

Morpheus is intentionally SaaS-heavy outside the TEE. The goal is to minimize self-managed control-plane code and reserve the confidential VMs for execution only.

## Current Managed Stack

1. **Cloudflare**
   - edge gateway
   - control plane
   - queues
   - workflows
   - DNS / routes
2. **Upstash Redis**
   - shared rate limiting
   - idempotency and replay suppression helpers
3. **Supabase**
   - durable job and application state
4. **Vercel**
   - web UI and backend routes
5. **Sentry**
   - browser and server error tracking
6. **Checkly**
   - API and browser synthetics
7. **Better Stack**
   - heartbeats, uptime, telemetry shipping
8. **Grafana Cloud**
   - optional deep relayer metrics only

## Ownership Boundaries

### Cloudflare

Cloudflare owns the first two layers of the production design:

- edge ingress
- control-plane auth and validation
- queue-backed execution lanes:
  - `oracle_request`
  - `feed_tick`
- workflow-backed orchestration lanes:
  - `callback_broadcast`
  - `automation_execute`

Key files:

- `deploy/cloudflare/morpheus-edge-gateway/worker.mjs`
- `deploy/cloudflare/morpheus-control-plane/worker.mjs`
- `deploy/cloudflare/morpheus-control-plane/workflow-runtime.mjs`

### Upstash Redis

Upstash is the shared external memory for:

- edge and backend rate limits
- replay-safe locks
- request-guard helpers

Key files:

- `workers/nitro-worker/src/platform/upstash.js`
- `workers/nitro-worker/src/platform/request-guards.js`
- `apps/web/lib/upstash.ts`
- `apps/web/lib/rate-limit.ts`

### Sentry

Sentry is the primary application error tracker for the Next.js surface.

Key files:

- `apps/web/instrumentation.ts`
- `apps/web/instrumentation-client.ts`
- `apps/web/sentry.server.config.ts`
- `apps/web/sentry.edge.config.ts`

### Checkly

Checkly owns active synthetic verification for:

- oracle web
- control plane
- edge gateway
- selected AA frontend surfaces

Key files:

- `monitoring/checkly/README.md`
- `scripts/checkly-sync-api-checks.mjs`
- `scripts/checkly-sync-browser-checks.mjs`

### Better Stack

Better Stack is the preferred operations layer for:

- cron heartbeats
- relayer heartbeats
- public uptime monitors
- log shipping / telemetry

Key files:

- `scripts/betterstack-sync-heartbeats.mjs`
- `scripts/betterstack-sync-monitors.mjs`
- `scripts/betterstack-sync-sources.mjs`
- `workers/morpheus-relayer/src/betterstack-log-sink.js`

### Grafana Cloud

Grafana Cloud is optional. It exists for deeper relayer metrics when Better Stack heartbeats and telemetry are not enough.

Key files:

- `workers/morpheus-relayer/src/prometheus.js`
- `workers/morpheus-relayer/src/metrics-server.js`
- `monitoring/grafana/README.md`

## Recommended Default Stack

For the current project size and operational goals:

- use **Sentry** for exceptions
- use **Checkly** for synthetic health
- use **Better Stack** for uptime, heartbeats, and telemetry
- keep **Grafana Cloud** disabled unless you need lower-level relayer metrics

That gives a simpler and cheaper default than running self-managed Prometheus infrastructure.

## Required Credentials By Service

### Cloudflare

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_ZONE_ID`

### Upstash

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

### Sentry

- `NEXT_PUBLIC_SENTRY_DSN`
- `SENTRY_DSN`
- recommended:
  - `SENTRY_ORG`
  - `SENTRY_PROJECT`
  - `SENTRY_AUTH_TOKEN`
  - `SENTRY_ENVIRONMENT`

### Checkly

- `CHECKLY_API_KEY`
- `CHECKLY_ACCOUNT_ID`
- `CHECKLY_PROJECT_NAME`

### Better Stack

- heartbeat URLs
- `MORPHEUS_BETTERSTACK_LOG_INGESTING_HOST`
- `MORPHEUS_BETTERSTACK_LOG_SOURCE_TOKEN`

### Grafana Cloud

- `GRAFANA_CLOUD_PROMETHEUS_PUSH_URL`
- `GRAFANA_CLOUD_PROMETHEUS_USERNAME`
- `GRAFANA_CLOUD_PROMETHEUS_API_KEY`

## Sync Commands

```bash
npm run sync:checkly
npm run sync:checkly:browser
npm run sync:betterstack
npm run sync:betterstack:monitors
npm run sync:betterstack:sources
npm run export:saas
```

## Rollout Order

1. Cloudflare
2. Upstash
3. Supabase
4. Sentry
5. Checkly
6. Better Stack
7. Grafana Cloud only if needed

## References

- Cloudflare Queues: https://developers.cloudflare.com/queues/
- Cloudflare Workflows: https://developers.cloudflare.com/workflows/
- Upstash Redis: https://upstash.com/docs/redis/overall/getstarted
- Sentry Next.js: https://docs.sentry.io/platforms/javascript/guides/nextjs/
- Checkly docs: https://www.checklyhq.com/docs/
- Better Stack Uptime: https://betterstack.com/docs/uptime/
- Grafana Cloud: https://grafana.com/docs/grafana-cloud/
