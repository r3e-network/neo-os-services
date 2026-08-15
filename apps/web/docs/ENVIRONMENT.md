# `apps/web` Environment Guide

This document covers environment variables that are specific to the Next.js web application (`apps/web`). For the project-wide environment reference, see `docs/ENVIRONMENT.md`.

## Caching

### `UPSTASH_REDIS_REST_URL`

The Upstash Redis REST endpoint. When both this variable and `UPSTASH_REDIS_REST_TOKEN` are set, `apps/web` uses Upstash Redis as the backend for server-side Supabase lookup caches (`lib/upstash-cache.ts`).

- **Required in production** if you want lookup caches to be shared across serverless instances.
- If omitted, the app falls back to an in-memory `Map` with TTL sweep. The in-memory fallback is fine for local development but is not shared across instances.

### `UPSTASH_REDIS_REST_TOKEN`

The Upstash Redis REST bearer token. Must be set alongside `UPSTASH_REDIS_REST_URL` to enable the Redis cache backend.

### `MORPHEUS_WEB_LOOKUP_CACHE_TTL_MS`

TTL for server-side Supabase lookup caches (project-id and provider-config lookups) in milliseconds. Defaults to `30000` (30 seconds). When the Redis backend is enabled, the TTL is rounded up to the nearest second and passed to Redis `EX`.

## Existing Upstash-Powered Guards

`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are also used by `apps/web/lib/rate-limit.ts` and `apps/web/lib/upstash.ts` for production rate limiting and request guards. See `docs/ENVIRONMENT.md` for the complete hardening guide.

When Redis is unavailable, production rate limiting uses the transactional
`morpheus_consume_rate_limit` Supabase RPC with the configured server-side
service key. This fallback remains shared across serverless instances and fails
closed if the database call is unavailable. Redis remains preferred for lower
latency and to keep request-counter writes off the primary database.

## Runtime Health

Set `MORPHEUS_BOX_HEALTH_URL_MAINNET` and `MORPHEUS_BOX_HEALTH_URL_TESTNET` to the
health endpoint for the corresponding attested runtime. The status and health
routes pass the selected network through and reject a box response that reports
the other network. `MORPHEUS_BOX_HEALTH_URL` remains a development fallback only.
