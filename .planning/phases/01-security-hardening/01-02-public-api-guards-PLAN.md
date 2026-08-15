---
wave: 1
depends_on: []
files_modified: []
autonomous: true
---

# Plan 02: Public API Rate Limiting & Input Validation

## Goal

Add authentication/authorization and structured input validation to intentionally
public API routes so they cannot be abused for enumeration or DoS.

## Context

- Public routes: `/api/workflows`, `/api/policies`, `/api/networks`, `/api/neodid/resolve`
- Files: `apps/web/app/api/workflows/route.ts`, `apps/web/app/api/policies/route.ts`,
  `apps/web/app/api/networks/route.ts`, `apps/web/app/api/neodid/resolve/route.ts`
- Existing middleware/helpers: `apps/web/lib/rate-limit.ts`, `apps/web/lib/relayer-auth.ts`,
  `apps/web/lib/server-supabase.ts`
- Several routes parse query/JSON without schema validation.

## Tasks

<task id="1" name="Create shared public API wrapper">
Create `apps/web/lib/public-api-handler.ts` that wraps Route Handlers with:
- Turnstile or runtime token check (skip for `/api/networks` if it must remain fully public
  but keep rate limiting)
- Upstash/Redis rate limiting via `apps/web/lib/rate-limit.ts`
- Structured error response `{ error: string }` with generic messages

<verify>
File exists and exports a higher-order function with the required guards.
Existing tests for `rate-limit.ts` still pass.
</verify>
</task>

<task id="2" name="Add input validators">
Create `apps/web/lib/validators.ts` using Zod (if not present) with schemas for:
- Network name, DID string, pagination params, cron feed params
Apply the schemas to the four public routes above.

<verify>
Invalid payloads return 400 with `{ error: string }`. Valid payloads pass through.
Unit tests exercise malformed inputs for each route.
</verify>
</task>

<task id="3" name="Apply wrapper to public routes">
Update the four public routes to use the shared wrapper and validators. Preserve the
existing public data semantics (catalogs, registry, DID resolution). Add rate-limit
headers where appropriate.

<verify>
- Each route returns 401/429 when auth/rate-limit fails
- Each route returns 400 for invalid input
- Happy-path responses remain unchanged
- Existing tests pass; new tests cover guard failure paths
</verify>
</task>

<task id="4" name="Document public API policy">
Add a brief note in `docs/OPERATIONS.md` or `docs/SECURITY_AUDIT.md` describing which
routes are public, why, and how they are protected.

<verify>
Documentation file updated and contains the route list and protection mechanism.
</verify>
</task>

## must_haves

- [ ] All four public routes are rate-limited
- [ ] All four public routes validate inputs with Zod schemas
- [ ] Unauthenticated or rate-limited requests receive 401/429
- [ ] Existing happy-path behavior is preserved
- [ ] Tests cover invalid input and guard-failure paths
