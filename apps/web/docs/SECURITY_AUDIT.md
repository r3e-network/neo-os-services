# `apps/web` Security Audit Notes

This document tracks `apps/web`-specific security hardening that complements the repository-level `docs/SECURITY_AUDIT.md`.

## Server-Side Cache Backend

`apps/web/lib/upstash-cache.ts` provides the cache implementation used by Supabase lookup helpers in `apps/web/lib/server-supabase.ts`. The cache backend is selected automatically based on environment variables:

- **Upstash Redis**: used when both `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are configured.
- **Transactional Supabase fallback**: used for production rate limiting when Redis is absent. The service-role-only `morpheus_consume_rate_limit` RPC atomically updates a fixed-window counter and remains shared across serverless instances.
- **In-memory fallback**: used for lookup caching, and for rate limiting only outside production. Entries are expired lazily on read using a TTL sweep.

### Production Requirement

In production, Redis is recommended for the Supabase lookup caches. The in-memory cache fallback is process-local and causes cache misses and repeated Supabase queries on serverless cold starts. Rate limiting never uses that local fallback in production: it uses Redis first and the transactional Supabase RPC second, and returns 503 if the configured shared backend is unavailable.

### Key Namespacing

Redis keys are prefixed by namespace to avoid collisions:

- Project-id lookups use `morpheus:project-id:`.
- Provider-config lookups use `morpheus:provider-config:`.

These namespaces are internal implementation details and should not be changed without updating the corresponding cache consumers.

## Automated Tests

- `apps/web/__tests__/upstash-cache.test.ts` covers the in-memory fallback, Upstash backend mocking, TTL expiration, and namespace isolation.
- `apps/web/__tests__/server-supabase.test.ts` covers the Supabase lookup caches and should continue to pass with either backend.
