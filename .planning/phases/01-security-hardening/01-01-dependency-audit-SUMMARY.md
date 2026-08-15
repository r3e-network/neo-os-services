# Summary: 01-01 Dependency Audit & CI Gate

## What Was Built

Ran a full `npm audit` baseline for the workspace, fixed all moderate-and-above
advisories, added a CI gate that runs `npm audit --audit-level=moderate` after
`npm ci`, and verified lockfile consistency.

## Tasks Completed

| Task | What We Did                                                                            | Commit       | Status   |
| ---- | -------------------------------------------------------------------------------------- | ------------ | -------- |
| 1    | Ran baseline audit and saved the JSON report                                           | 787abfa      | Complete |
| 2    | Fixed vulnerabilities via overrides, targeted upgrades, and a lockfile pin             | ecfa740      | Complete |
| 3    | Added `npm audit --audit-level=moderate` step after `npm ci` in CI                     | 9aae70d      | Complete |
| 4    | Ran `npm install --package-lock-only`; `git diff --exit-code package-lock.json` passes | (no changes) | Complete |

## Deviations from Plan

### Auto-Added Critical / Workarounds

- **@sentry/nextjs upgrade**: The audit's `fixAvailable` suggested a breaking
  downgrade to `6.3.5`. Instead, we upgraded within the same major line
  (`^10.49.0` -> `^10.63.0`), which removed the vulnerable
  `@opentelemetry/instrumentation-http` chain. This is a minor-version bump
  and avoids a major downgrade.
- **next/postcss lockfile pin**: npm overrides did not apply to `next`'s
  exact dependency `postcss@8.4.31`. We manually updated the
  `node_modules/next/node_modules/postcss` entry in `package-lock.json` to
  `8.5.10` (the patched version) and reinstalled. `postcss` is semver
  backward-compatible within v8, so this is safe.
- **Additional overrides added**: `@opentelemetry/core 2.9.0`,
  `@opentelemetry/instrumentation-http` -> `@opentelemetry/core 2.9.0`,
  `tmp 0.2.7`, and updated `lodash 4.18.1` / `postcss 8.5.10` overrides at the
  root to ensure transitive deps stay patched.

### No Exceptions Remaining

All moderate/high/critical advisories have been resolved. No exception notes
file was needed.

## Decisions Made

- Used targeted version overrides and minor-version upgrades rather than
  accepting breaking-change `fixAvailable` suggestions.
- Chose to pin `next`'s transitive `postcss` to the patched `8.5.10` in the
  lockfile because npm overrides do not override exact transitive dependencies.
- Placed the audit gate in the `lint-and-format` job, immediately after
  `npm ci`, so new advisories fail the workflow before tests run.

## must_haves Status

Goal: Eliminate known npm audit vulnerabilities and add a CI gate to prevent
future high/moderate severity advisories from being merged.

- [x] `npm audit --audit-level=moderate` returns 0
- [x] CI has a failing audit gate (`npm audit --audit-level=moderate` after `npm ci`)
- [x] All lockfiles are in sync (`git diff --exit-code package-lock.json` passes)
- [x] Any remaining exceptions are documented (none remain)

**Status:** PASS (4/4 must_haves delivered)

## Files Modified

- `.planning/phases/01-security-hardening/01-01-npm-audit-baseline.json`
- `package.json`
- `apps/web/package.json`
- `package-lock.json`
- `.github/workflows/ci.yml`

## Next Steps

- Monitor future `npm audit` reports; the CI gate will now block PRs that
  introduce new moderate/high/critical advisories.
- If Next.js is upgraded to a release that already depends on `postcss >= 8.5.10`,
  the manual lockfile pin can be removed.
