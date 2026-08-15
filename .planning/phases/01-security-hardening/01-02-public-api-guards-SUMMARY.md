# Summary: Public API Rate Limiting & Input Validation

## What Was Built

Added a shared public-API guard wrapper, Zod validators, and route-level
protections to the four intentionally public `apps/web` API routes. The wrapper
combines rate limiting, runtime/admin-token authentication, and structured
input validation in one higher-order handler. All four routes now reject
malformed input with a generic `400 { error: 'invalid query parameters' }`,
return rate-limit headers on every response, and return `429` when the limit is
exceeded. Protected routes return `401` when no valid token is supplied;
`/api/networks` remains fully public as the plan allows.

## Tasks Completed

| Task | What We Did                                                                 | Commit  | Status   |
| ---- | --------------------------------------------------------------------------- | ------- | -------- |
| 1    | Created `apps/web/lib/public-api-handler.ts` shared wrapper                 | d8aa5cf | Complete |
| 2    | Created `apps/web/lib/validators.ts` with Zod schemas; added Zod dependency | fe134a7 | Complete |
| 3    | Applied wrapper and validators to all four public routes; added tests       | 08d8159 | Complete |
| 4    | Documented public API route policy in `docs/SECURITY_AUDIT.md`              | c0c8a11 | Complete |

## Deviations from Plan

### Blockers Fixed

- Task 2: `npm install zod` caused `server-only` to be dropped from the workspace
  tree, breaking the existing `apps/web/lib/neodid-did.ts` import and the new
  route tests. Added `server-only` explicitly to `apps/web/package.json` and
  reinstalled to restore the package.

### Auto-Added Critical

- Task 2/3: Added a `lint` script to `apps/web/package.json` because the
  verification command `npm --prefix apps/web run lint` did not exist; the
  script delegates to the same ESLint config used by the root workspace.

### Design Choices

- Task 1: The plan mentioned "Turnstile or runtime token check". Turnstile is
  only implemented in the Cloudflare edge gateway, not in `apps/web`. The
  wrapper therefore reuses the existing `isAuthorizedRuntimeRequest` check from
  `apps/web/lib/control-plane-auth.ts` (runtime/admin token). If a future
  Turnstile integration is added to the Next.js layer, the wrapper can be
  extended without changing the routes.
- Task 3: `/api/networks` keeps `requireAuth: false` per the plan's allowance for
  a fully public network registry route; the other three routes require a token.

## Decisions Made

- Authentication uses the shared runtime-token check (`MORPHEUS_RUNTIME_TOKEN`,
  `NITRO_API_TOKEN`, `NITRO_SHARED_SECRET`) via Bearer or
  `x-morpheus-runtime-token` headers, matching `control-plane-auth.ts`.
- Rate limits are enforced by the existing `apps/web/lib/rate-limit.ts` wrapper
  (Upstash when configured, in-memory fallback) and include
  `X-RateLimit-Limit/Remaining/Reset` headers.
- Public route limits chosen: 60 requests/minute for `/api/workflows`,
  `/api/policies`, and `/api/networks`; 30 requests/minute for
  `/api/neodid/resolve` because it performs upstream runtime work.
- Input validation rejects unexpected query params on the three catalog/registry
  routes and validates the `did`/`format` shape on `/api/neodid/resolve`.
- Error messages stay generic (`unauthorized`, `invalid query parameters`,
  `Too many requests`) to avoid leaking implementation details.

## must_haves Status

Goal: Add authentication/authorization and structured input validation to
intentionally public API routes so they cannot be abused for enumeration or DoS.

- [x] All four public routes are rate-limited.
- [x] All four public routes validate inputs with Zod schemas.
- [x] Unauthenticated or rate-limited requests receive 401/429 (protected routes
      return 401; all routes return 429 when exceeded; `/api/networks` remains
      public per plan).
- [x] Existing happy-path behavior is preserved (catalog/registry/DID resolution
      responses unchanged for authenticated/valid requests).
- [x] Tests cover invalid input and guard-failure paths.

**Status:** PASS (5/5 must_haves delivered)

## Files Modified

- `apps/web/lib/public-api-handler.ts` (new)
- `apps/web/lib/validators.ts` (new)
- `apps/web/app/api/workflows/route.ts`
- `apps/web/app/api/policies/route.ts`
- `apps/web/app/api/networks/route.ts`
- `apps/web/app/api/neodid/resolve/route.ts`
- `apps/web/app/api/public-api-routes.test.ts` (new)
- `apps/web/package.json`
- `package-lock.json`
- `docs/SECURITY_AUDIT.md`

## Next Steps

- Monitor `/api/networks` traffic; if abuse appears despite rate limiting, switch
  `requireAuth` to `true` or add a lighter token check.
- Consider adding a Turnstile check inside `publicApiHandler` if the Cloudflare
  edge gateway is not always in front of `apps/web`.
- Downstream plans that touch these routes should import/test through the
  wrapped `GET` handlers so guard behavior is exercised.
