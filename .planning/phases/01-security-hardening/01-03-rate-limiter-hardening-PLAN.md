---
wave: 1
depends_on: []
files_modified: []
autonomous: true
---

# Plan 03: Production Rate Limiter Hardening

## Goal

Remove the in-memory rate-limit fallback in production so that rate limits are
coordinated across all serverless instances and cannot be bypassed by horizontal
scaling.

## Context

- `apps/web/lib/rate-limit.ts:30-62` and `apps/web/lib/rate-limit.ts:100-179` use a
  process-local `Map` when Upstash is not configured.
- `cleanupStaleEntries` scans the entire map on every request (O(n)).
- The fallback is useful for local development but dangerous in production.

## Tasks

<task id="1" name="Add environment guard">
In `apps/web/lib/rate-limit.ts`, introduce a check: if `NODE_ENV === 'production'`
and Upstash credentials are missing, throw an error at module load or first request
instead of falling back to the in-memory Map.

<verify>
A test or script with `NODE_ENV=production` and missing Upstash env vars fails to
initialize the rate limiter.
</verify>
</task>

<task id="2" name="Improve local fallback behavior">
Keep the in-memory Map for local development only, but cap its size and add a TTL
index to avoid O(n) cleanup. Use a simple LRU eviction policy.

<verify>
`cleanupStaleEntries` no longer scans all entries; eviction is bounded by size.
Existing `rate-limit.ts` tests still pass.
</verify>
</task>

<task id="3" name="Add production startup checks">
In `apps/web/instrumentation.ts` or a new `apps/web/lib/startup-checks.ts`, add a
startup check that logs/fails if rate-limiting backend is missing in production.

<verify>
Production build start-up with missing Upstash env reports an explicit error and
exits (or logs a critical error if graceful degradation is preferred).
</verify>
</task>

<task id="4" name="Update docs and env examples">
Add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` to required production env
vars in `.env.production.example` and `docs/ENVIRONMENT.md`.

<verify>
Env example and docs mention Upstash as required for production rate limiting.
</verify>
</task>

## must_haves

- [ ] Production builds cannot fall back to in-memory rate limiting
- [ ] Local development still works without Upstash
- [ ] In-memory map has bounded size and efficient cleanup
- [ ] Missing Upstash credentials fail loudly in production
- [ ] Docs and env examples are updated
