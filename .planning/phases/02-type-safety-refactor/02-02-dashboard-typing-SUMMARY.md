# Plan 02-02 Summary: Dashboard Component Typing

## Goal

Introduce shared TypeScript types for the dashboard data model and remove `any` from
all dashboard components and related helpers.

## Status

All must_haves are complete. TypeScript check, lint, and all tests pass.

## Files Changed

- `apps/web/lib/dashboard-types.ts` (new)
  - Shared types: `OracleKeyMeta`, `OracleState`, `OnchainRecord`, `OnchainStateBody`,
    `ProviderSummary`, `NetworkConfig`, `GeneratedRequestPackage`, `LiveQuote`,
    `DstackInfo`, `WalletSubmitResult`.
  - Helper: `parseOracleKeyMeta(body)` for safely parsing the public-key API response.
- `apps/web/lib/dashboard-types.test.ts` (new)
  - Tests for `parseOracleKeyMeta`, `readOracleStateFromBody`, and
    `getDashboardNetworkConfig`.
- `apps/web/components/dashboard/oracleReadiness.ts`
  - Imports `OracleState` and `OnchainStateBody` from `dashboard-types`.
  - Replaced `any` with `OnchainStateBody` / `Record<string, unknown>` and typed guards
    for message/error fields.
- `apps/web/components/dashboard/networkSelection.ts`
  - Added explicit `NetworkConfig` return type to `getDashboardNetworkConfig`.
- `apps/web/components/dashboard.tsx`
  - Replaced local `ProviderSummary` with the shared type from `dashboard-types`.
- `apps/web/components/dashboard/OracleTab.tsx`
  - Typed `providers`, `oracleKeyMeta`, `oracleState`, `generatedRequest`, and
    `result` from `invokeMorpheusOracleRequest`.
  - Replaced `any` error catches with `unknown` narrowing.
  - Uses `parseOracleKeyMeta` for public-key responses.
- `apps/web/components/dashboard/ComputeTab.tsx`
  - Imported `OracleState` from `dashboard-types`; typed wallet submission result.
- `apps/web/components/dashboard/ProvidersTab.tsx`
  - Typed `providers` as `ProviderSummary[]`.
- `apps/web/components/dashboard/OracleRequestForm.tsx`
  - Typed `oracleKeyMeta` prop.
- `apps/web/components/dashboard/OracleResponseViewer.tsx`
  - Typed `oracleState` prop.
- `apps/web/components/dashboard/OracleEncryptionPanel.tsx`
  - Typed `oracleKeyMeta` prop.
- `apps/web/components/dashboard/OverviewStats.tsx`
  - Typed `oracleState` and `dstack` props.
- `apps/web/components/dashboard/OverviewNetwork.tsx`
  - Typed `liveQuote` prop.
- `apps/web/components/dashboard/OverviewTab.tsx`
  - Removed local `OnchainRecord`; typed `setOutput`, `onchainState`, `liveQuote`,
    `dstack`, and `stateBody`.
- `apps/web/components/starter/StarterStudio.tsx`
  - Imported `OracleKeyMeta` and `OracleState` from `dashboard-types`; removed `any`.

## Verification

- `npx tsc --noEmit` in `apps/web` passes with no errors.
- `npm --prefix apps/web run lint` passes.
- `npm --prefix apps/web run test:run` passes (170 tests across 35 files).
- `grep -rn ": any\|as any" apps/web/components/dashboard` returns no matches.

## must_haves

- [x] Shared dashboard types exist in `apps/web/lib/dashboard-types.ts`
- [x] All dashboard tabs use the shared types (no `any` props/state)
- [x] Dashboard data fetch helpers have typed return values
- [x] TypeScript check passes
- [x] New tests pass
