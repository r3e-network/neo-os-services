---
wave: 1
depends_on: []
files_modified: []
autonomous: true
---

# Plan 02-02: Dashboard Component Typing

## Goal

Introduce shared TypeScript types for the dashboard data model and remove `any` from
all dashboard components (`OracleTab`, `ComputeTab`, `ProvidersTab`, etc.).

## Context

- `apps/web/app/dashboard/` contains several tabs with heavy `any` usage.
- Oracle state, provider configs, and network metadata are fetched from Supabase and
  on-chain sources but are not typed.
- The plan depends on 02-01 because typed Supabase data flows into the dashboard.

## Tasks

<task id="1" name="Define shared dashboard types">
Create `apps/web/lib/dashboard-types.ts` with types for:
- `OracleViewModel`: address, network, status, latest feeds, last heartbeat, latency stats
- `ProviderConfigViewModel`: provider id, network, endpoint, credentials shape
- `NetworkViewModel`: name, magic, rpc urls, block height
- `ComputeTabViewModel`: jobs, status, metrics

<verify>
`apps/web/lib/dashboard-types.ts` exists and exports all required types. No `any` is
used for the type definitions.
</verify>
</task>

<task id="2" name="Type dashboard tabs">
Update `apps/web/app/dashboard/oracle-tab.tsx`, `compute-tab.tsx`, `providers-tab.tsx`,
and related components to use the new shared types. Remove `any` from props and
state.

<verify>
`grep -rn "as any\|: any" apps/web/app/dashboard/` returns only unavoidable values
(such as `any` coming from a JSON.parse of untrusted data). TypeScript check passes.
</verify>
</task>

<task id="3" name="Type dashboard API helpers">
Update `apps/web/lib/dashboard.ts` or similar data-fetch helpers to return typed
objects instead of `any` / `Record<string, any>`.

<verify>
Dashboard data fetch helpers have explicit return types. TypeScript check passes.
</verify>
</task>

<task id="4" name="Add tests">
Add a minimal test in `apps/web/app/dashboard/dashboard-types.test.ts` that asserts
view-model helpers produce valid typed objects from sample data.

<verify>
`npm --prefix apps/web run test:run -- dashboard-types.test.ts` passes.
</verify>
</task>

## must_haves

- [ ] Shared dashboard types exist in `apps/web/lib/dashboard-types.ts`
- [ ] All dashboard tabs use the shared types (no `any` props/state)
- [ ] Dashboard data fetch helpers have typed return values
- [ ] TypeScript check passes
- [ ] New tests pass
