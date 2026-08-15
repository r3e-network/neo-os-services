# scripts/ops — operator runbooks-as-code

Manual ops scripts archived from `scripts/` root (2026-07-18 cleanup). They are
NOT wired into package.json or CI on purpose — operators run them by hand.
Each has zero references from live code (verified by grep at archive time).

- `fix-mainnet-morpheus-runtime.mjs` — mainnet runtime fix runbook
- `recover-and-rotate-admin.mjs` — admin recovery/rotation (DANGER: documented as "would break if executed" in docs/reports/claudedocs/refactoring-roadmap-2026-06-24-round2.md)
- `call-oracle-admin.mjs` — oracle admin calls; defaults to no-broadcast dry-run and requires
  explicit network, contract, admin, token, and rotation targets. `--apply` is mandatory for
  broadcast and enforces HTTPS endpoints.
- `fund-accounts.mjs` — account funding helper
- `quarantine-stale-relayer-jobs.mjs` — relayer job quarantine
- `generate-workspace-context-values.mjs` — superseded by `scripts/lib-workspace-validation-context.mjs`
- `backup-system-state.mjs` — DEPRECATED (targets the legacy Phala CVM; the `backup:system` npm alias was removed at archive time)
