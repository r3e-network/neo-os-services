# Summary: 02-01 Supabase Client Typing

## What Was Built

Replaced the loosely typed `ServerSupabaseClient = any` with a generated
`SupabaseClient<Database>` type derived from the schema migrations. The
`resolveProjectIdBySlug` query no longer uses an explicit `any` cast, and the
cache helpers are typed against real table rows.

## Tasks Completed

| Task | What We Did                                                           | Commit  | Status   |
| ---- | --------------------------------------------------------------------- | ------- | -------- |
| 1    | Generated `apps/web/lib/supabase-types.ts` from all 15 migrations     | 7e00a9d | Complete |
| 2    | Typed `ServerSupabaseClient` as `SupabaseClient<Database>`            | 7e00a9d | Complete |
| 3    | Removed `as any` cast in `resolveProjectIdBySlug`                     | 7e00a9d | Complete |
| 4    | Added regression-safe env-var handling in tests (`vi.stubEnv`)        | 7e00a9d | Complete |
| 5    | Added `scripts/generate-supabase-types.mjs` and `docs/DEVELOPMENT.md` | 7e00a9d | Complete |

## Deviations from Plan

- The plan suggested running `supabase gen types typescript` or creating a manual
  file. The Supabase CLI requires Docker even for `--db-url`, so we instead used
  a temporary local PostgreSQL cluster and a small Node.js script that queries
  `information_schema` to produce a Supabase-compatible `Database` interface.
- We did not add a dedicated type-level unit test; the TypeScript compiler check
  (`tsc --noEmit`) and the existing `server-supabase.test.ts` serve as the
  regression guard.

## Decisions Made

- `Json` is kept as a recursive union to match Supabase's generated style.
- All `morpheus_*` tables in `public` are included so future routes can use the
  same type file without regeneration.
- `unknown` is used for user-defined types not natively mapped by the generator;
  these can be tightened later when the actual enum/domain definitions are needed.
- The generator script accepts `SUPABASE_TYPES_DB_URL` and an output path for
  reuse in CI or local workflows.

## must_haves Status

- [x] `ServerSupabaseClient` is no longer `any`
- [x] Core tables used by `apps/web` have typed shapes
- [x] `apps/web/lib/server-supabase.ts` no longer casts Supabase rows to `any`
- [x] TypeScript check passes
- [x] Existing tests pass
- [x] Regeneration workflow is documented

**Status:** PASS (6/6 must_haves delivered)

## Files Modified

- `apps/web/lib/supabase-types.ts` (new)
- `apps/web/lib/server-supabase.ts`
- `apps/web/lib/rate-limit.ts` (export `RateLimitOptions`)
- `apps/web/__tests__/rate-limit.test.ts`
- `apps/web/app/api/cron/feed/route.test.ts`
- `scripts/generate-supabase-types.mjs` (new)
- `docs/DEVELOPMENT.md` (new)

## Verification

- `cd apps/web && npx tsc --noEmit`: passed
- `npm --prefix apps/web run test:run`: 165 passed
- `npm run lint`: passed

## Next Steps

- Plan 02-02 will build on these types to remove `any` from Dashboard components.
- Tighten `unknown` columns once their domain/enum definitions are needed.
