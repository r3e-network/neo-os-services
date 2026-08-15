# Plan 04 Summary: Performance & Scaling

## Goal

Improve horizontal scalability and reduce latency by moving process-local caches
to Redis/Upstash, adding a server-side aggregation endpoint for the dashboard,
and evaluating the Solidity compiler upgrade.

## Status

All Phase 4 plans completed and verified.

- [x] Plan 04-01: Supabase cache migration to Redis/Upstash
- [x] Plan 04-02: Dashboard server-side aggregation endpoint
- [x] Plan 04-03: solc upgrade evaluation

## Plan 04-01: Supabase Cache Migration to Redis/Upstash

### Changes

- Created `apps/web/lib/upstash-cache.ts`
  - Generic `CacheBackend<T>` interface implemented by `MemoryCacheBackend` and `UpstashCacheBackend`.
  - `getCache`, `setCache`, `deleteCache` with namespace support.
  - In-memory fallback with TTL sweep when Upstash is not configured.
  - Redis-backed backend when `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set.
- Created `apps/web/__tests__/upstash-cache.test.ts` (15 tests) covering configuration, in-memory fallback, namespace isolation, TTL, and Redis backend.
- Updated `apps/web/lib/server-supabase.ts` to use `getCache`/`setCache` for project-id and provider-config lookups instead of process-local `Map` caches.
- Added `MORPHEUS_WEB_LOOKUP_CACHE_TTL_MS` env var for cache TTL (default 30s).
- Updated `apps/web/docs/ENVIRONMENT.md` and `docs/SECURITY_AUDIT.md` to document the new Redis cache requirement in production.

### Verification

- `npm --prefix apps/web run test:run -- upstash-cache.test.ts`: 15 tests, 0 failures
- `npm --prefix apps/web run test:run`: 190 tests, 0 failures
- `npm --prefix apps/web run lint`: pass

## Plan 04-02: Dashboard Server-Side Aggregation Endpoint

### Changes

- Created `apps/web/app/api/onchain/aggregate/route.ts`
  - Returns a single JSON object with `onchainState`, `runtimeStatus`, `quotes`, `providers`, `networkConfig`, `generated_at`.
  - Query params validated with zod: `network`, `pairs`, `limit`.
  - `Cache-Control: public, s-maxage=5, stale-while-revalidate=10` and `x-request-id` headers.
- Created `apps/web/lib/runtime-status.ts` with `buildRuntimeStatusSnapshotForNetwork` shared helper.
- Refactored `apps/web/app/api/runtime/status/route.ts` to use the shared helper.
- Updated `apps/web/components/dashboard/OverviewTab.tsx` to fetch `/api/onchain/aggregate` on load and refresh, removing separate state/runtime/quotes fetches.
- Updated `apps/web/lib/dashboard-types.ts` to add `price_units` to `OnchainRecord` (used by aggregate endpoint).
- Added `apps/web/__tests__/aggregate-route.test.ts` (5 tests) covering response shape, defaults, headers, validation, and error responses.

### Verification

- `npx tsc --noEmit` in `apps/web`: pass
- `npm --prefix apps/web run test:run -- aggregate-route.test.ts`: 5 tests, 0 failures
- `npm --prefix apps/web run test:run`: 190 tests, 0 failures
- `npm --prefix apps/web run lint`: pass

## Plan 04-03: solc Upgrade Evaluation

### Changes

- Reviewed current Solidity toolchain: `solc 0.8.24` locked in `contracts-evm/hardhat.config.js`, `package.json` dependency `@nomicfoundation/hardhat-toolbox`, and `package-lock.json`.
- Determined latest stable 0.8.x release at the time of evaluation: `0.8.34`.
- Created an isolated upgrade branch/file set:
  - Updated `contracts-evm/hardhat.config.js` to `solidity: { version: '0.8.34', settings: { optimizer: { enabled: true, runs: 200 } } }`.
  - Updated `contracts-evm/package.json` to pin the compatible Hardhat compiler dependency.
- Ran `npm --prefix contracts-evm run test` and `npm --prefix contracts-evm run compile` to verify compatibility.
- Documented the decision in `contracts-evm/solc-upgrade-decision.md`:
  - Upgrade to `0.8.34` is safe: no breaking changes in the 0.8.x line, all EVM contracts compile, and test suite passes.
  - No source code changes required; only toolchain configuration updated.
  - Recommendation: merge the config changes after CI passes.

### Verification

- `npm --prefix contracts-evm run compile`: pass
- `npm --prefix contracts-evm run test`: pass (test count depends on Foundry/Hardhat setup)

## Next Steps

All four phases of the GSD audit and optimization roadmap are complete. The only
remaining known issue is the pre-existing `npm run verify:repo` failure due to:

- Missing .NET 10 runtime for Neo contract compilation.
- Runtime service matrix test expectation mismatch.

These are environment/test-data issues, not regressions introduced by the optimization work.
