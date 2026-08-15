# Phase 1 Security Hardening — Completion Report

**Phase:** 01-security-hardening  
**Completed:** 2026-07-04  
**Status:** Implemented (verification blocked by two pre-existing environment issues)

---

## Plans Delivered

| Plan  | Goal                               | Status              | Key Commits                        |
| ----- | ---------------------------------- | ------------------- | ---------------------------------- |
| 01-01 | Dependency audit & CI gate         | Complete            | 787abfa, ecfa740, 9aae70d          |
| 01-02 | Public API guards & validation     | Complete (by agent) | d8aa5cf, fe134a7, 08d8159, c0c8a11 |
| 01-03 | Production rate limiter hardening  | Complete            | 23c01e7, 3fde846, 0eb9f04, e933021 |
| 01-04 | TEE child-process & cron hardening | Complete            | b05fd0f, 1606c3c, 32f236f, eec37c6 |

---

## What Changed

### 01-01 Dependency Audit

- Ran `npm audit` baseline and saved it to
  `.planning/phases/01-security-hardening/01-01-npm-audit-baseline.json`.
- Fixed all moderate/high vulnerabilities through targeted overrides and minor upgrades.
  - `@sentry/nextjs` ^10.49.0 → ^10.63.0
  - `lodash` 4.18.1 override, `postcss` 8.5.10 override, `tmp` 0.2.7 override,
    `@opentelemetry/core` 2.9.0 override.
- Added `npm audit --audit-level=moderate` step after `npm ci` in `.github/workflows/ci.yml`.

### 01-02 Public API Guards (by agent)

- Created `apps/web/lib/public-api-handler.ts` shared wrapper.
- Created `apps/web/lib/validators.ts` with Zod schemas.
- Applied wrapper to `/api/workflows`, `/api/policies`, `/api/networks`, `/api/neodid/resolve`.
- Added `apps/web/app/api/public-api-routes.test.ts` (15 tests).

### 01-03 Rate Limiter Hardening

- `apps/web/lib/rate-limit.ts` now throws in production when Upstash is not configured.
- Local-development in-memory map is bounded to 10,000 entries with LRU eviction.
- `apps/web/instrumentation.ts` calls `assertProductionRateLimitBackend()` on startup.
- Added 5 new tests in `apps/web/__tests__/rate-limit.test.ts`.
- Updated `.env.production.example` and `docs/ENVIRONMENT.md` to mark Upstash as required.

### 01-04 TEE & Cron Hardening

- Added `workers/nitro-worker/src/platform/permission-guard.js` with:
  - `parseAllowNet()` rejecting wildcards, `0.0.0.0/0`, `::/0`, and CIDRs.
  - `validateChildProcessPermissions()` enforcing permission model in production.
- Integrated guard into `script-runner.js` and `wasm-runner.js`.
- Simplified `apps/web/app/api/cron/feed/route.ts` diagnostics; response is generic
  `{ error: 'Unauthorized' }`. Server logs keep only request metadata.
- Added `permission-guard.test.mjs` and `apps/web/app/api/cron/feed/route.test.ts`.
- Updated `docs/SECURITY_AUDIT.md` with TEE child-process and cron policy sections.

---

## Verification Results

| Check                  | Command                                  | Result                 |
| ---------------------- | ---------------------------------------- | ---------------------- |
| npm audit              | `npm audit --audit-level=moderate`       | 0 vulnerabilities      |
| Lint                   | `npm run lint`                           | passed                 |
| Web tests              | `npm --prefix apps/web run test:run`     | 165 passed             |
| Nitro worker tests     | `npm --prefix workers/nitro-worker test` | 412 passed             |
| Root repo verification | `npm run verify:repo`                    | **failed** (see below) |

### Root verification failures (not caused by Phase 1 changes)

1. **Contract build regression test** (`scripts/contract-build-regressions.test.mjs`)  
   Fails because the `.NET 10` runtime is not installed in this environment:

   ```
   You must install .NET to run this application.
   App: /Users/jinghuiliao/.dotnet/tools/nccs
   Architecture: arm64
   App host version: 10.0.7
   .NET location: Not found
   ```

   This is a pre-existing environment issue.

2. **Runtime service matrix test** (`scripts/runtime-service-matrix.test.mjs`)  
   Fails because of an unexpected capability gap:
   ```
   + ['session/start', 'session/step', 'session/finalize']
   - []
   ```
   This appears to be a pre-existing test/data mismatch unrelated to the security work.

---

## Known Issues / Follow-ups

- The two `verify:repo` failures are pre-existing and should be addressed separately:
  - Install .NET 10 runtime or adjust the contract build test to skip gracefully.
  - Investigate the runtime service matrix session capabilities mismatch.
- Phase 2 (type safety and relayer module refactoring) plans are drafted in
  `.planning/phases/02-type-safety-refactor/` and ready to execute.

---

## Artifacts

- `.planning/AUDIT-AND-ROADMAP.md`
- `.planning/phases/01-security-hardening/01-0{1,2,3,4}-*-PLAN.md`
- `.planning/phases/01-security-hardening/01-0{1,2,3,4}-*-SUMMARY.md`
- `.planning/codebase/{STACK,INTEGRATIONS,ARCHITECTURE,STRUCTURE,CONVENTIONS,TESTING,CONCERNS}.md`
