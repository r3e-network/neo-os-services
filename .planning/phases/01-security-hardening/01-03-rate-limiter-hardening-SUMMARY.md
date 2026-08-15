# Summary: 01-03 Production Rate Limiter Hardening

## What Was Built

Hardened `apps/web/lib/rate-limit.ts` so that it refuses to operate in production
without a shared Upstash Redis backend, and improved the local-development fallback
so it is bounded and no longer performs O(n) cleanup scans.

## Tasks Completed

| Task | What We Did                                                 | Commit  | Status   |
| ---- | ----------------------------------------------------------- | ------- | -------- |
| 1    | Production guard in `rate-limit.ts`                         | 23c01e7 | Complete |
| 2    | Bounded LRU local map, removed O(n) cleanup                 | 23c01e7 | Complete |
| 3    | Startup check wired into `instrumentation.ts`               | 3fde846 | Complete |
| 4    | Tests for production guard, fallback, and eviction          | 3fde846 | Complete |
| 5    | Updated `.env.production.example` and `docs/ENVIRONMENT.md` | 0eb9f04 | Complete |

## Deviations from Plan

- The plan suggested adding a new `apps/web/lib/startup-checks.ts`. We instead used the
  existing `apps/web/instrumentation.ts` `register()` hook, which is the idiomatic
  Next.js startup entry point. The exported `assertProductionRateLimitBackend` helper
  remains available for any other startup path.
- The original `cleanupStaleEntries` function is no longer needed because the map is
  bounded by size rather than time; old records naturally age out through LRU eviction.

## Decisions Made

- `isProduction()` uses `process.env.NODE_ENV === 'production'` to align with Next.js.
- In production, both missing Upstash env vars and Upstash request failures throw a
  clear error rather than silently falling back to local state.
- Local development keeps the in-memory fallback, capped at 10,000 entries with LRU
  eviction when the limit is exceeded.
- `assertProductionRateLimitBackend` can be called independently for any production
  sanity checks.

## must_haves Status

- [x] Production builds cannot fall back to in-memory rate limiting
- [x] Local development still works without Upstash
- [x] In-memory map has bounded size and efficient cleanup
- [x] Missing Upstash credentials fail loudly in production
- [x] Docs and env examples are updated

**Status:** PASS (5/5 must_haves delivered)

## Files Modified

- `apps/web/lib/rate-limit.ts`
- `apps/web/instrumentation.ts`
- `apps/web/__tests__/rate-limit.test.ts`
- `.env.production.example`
- `docs/ENVIRONMENT.md`

## Verification

- `npm --prefix apps/web run test:run -- __tests__/rate-limit.test.ts`: 18 passed
- `npm --prefix apps/web run lint`: passed

## Next Steps

- Consider adding a runtime metrics counter for Upstash failures once a structured
  logger is in place (Phase 3).
- If rate-limit headers should be returned even on 429, verify CDN/proxy caching rules
  respect `Cache-Control: no-store`.
