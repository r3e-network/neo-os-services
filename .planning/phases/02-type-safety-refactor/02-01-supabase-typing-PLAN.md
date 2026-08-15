---
wave: 1
depends_on: []
files_modified: []
autonomous: true
---

# Plan 02-01: Supabase Client Typing

## Goal

Replace the loosely typed `ServerSupabaseClient` and `any` casts with generated or
hand-written Supabase types, so TypeScript can catch invalid queries at build time.

## Context

- `apps/web/lib/server-supabase.ts` exports `ServerSupabaseClient` as `any`.
- Multiple queries use `as any` to bypass the compiler, especially in
  `apps/web/app/dashboard/` and `apps/web/lib/`.
- Supabase CLI supports `supabase gen types typescript` against the project schema.
- Schema migrations live in `supabase/migrations/`.

## Tasks

<task id="1" name="Generate or hand-write Supabase types">
Run `supabase gen types typescript` (or create a manual `supabase.ts` file) to
produce typed helpers for `morpheus_projects`, `morpheus_requests`,
`morpheus_providers`, and other core tables. If the Supabase CLI is not available,
write a focused manual type file covering the columns used by `apps/web`.

<verify>
`apps/web/lib/supabase-types.ts` exists and contains a typed `Database` interface with
core tables, types, and enums used by the app. No `any` is used for table shapes.
</verify>
</task>

<task id="2" name="Type ServerSupabaseClient">
Replace the `any` export in `apps/web/lib/server-supabase.ts` with a typed client
based on the generated `Database` type. Update factory helpers and cache functions to
use the typed client.

<verify>
`apps/web/lib/server-supabase.ts` no longer exports `any`; `npm --prefix apps/web run
types` (or `tsc --noEmit`) passes without new type errors.
</verify>
</task>

<task id="3" name="Remove `as any` casts in dashboard and library code">
Identify `as any` casts in `apps/web/app/dashboard/` and `apps/web/lib/` related to
Supabase queries. Replace them with proper types or narrow casts. Fix any resulting
TypeScript errors by updating the underlying types or code.

<verify>
`grep -rn "as any" apps/web/app/dashboard/ apps/web/lib/` returns no Supabase-related
`as any` casts. TypeScript check passes.
</verify>
</task>

<task id="4" name="Add regression tests">
Add or update TypeScript tests in `apps/web/__tests__/server-supabase.test.ts` to
ensure the typed client still satisfies the expected query shapes and cache reset
helpers work.

<verify>
`npm --prefix apps/web run test:run -- server-supabase.test.ts` passes.
</verify>
</task>

<task id="5" name="Document typing workflow">
Add a short section to `docs/DEVELOPMENT.md` explaining how to regenerate Supabase
types when the schema changes.

<verify>
`docs/DEVELOPMENT.md` contains the regeneration command and target file path.
</verify>
</task>

## must_haves

- [ ] `ServerSupabaseClient` is no longer `any`
- [ ] Core tables used by `apps/web` have typed shapes
- [ ] `apps/web/app/dashboard/` and `apps/web/lib/` no longer cast Supabase rows to `any`
- [ ] TypeScript check passes
- [ ] Existing tests pass
- [ ] Regeneration workflow is documented
