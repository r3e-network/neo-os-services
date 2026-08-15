# Summary: 01-04 TEE Child Process & Cron Diagnostic Hardening

## What Was Built

Hardened the Nitro worker child-process sandbox and reduced diagnostic leakage
from the cron feed endpoint. Production workers now refuse to spawn untrusted
script/WASM children without the Node.js permission model, and wildcard network
allowlists are rejected. The `/api/cron/feed` route returns a generic
`{ error: 'Unauthorized' }` response to unauthenticated callers.

## Tasks Completed

| Task | What We Did                                                           | Commit  | Status   |
| ---- | --------------------------------------------------------------------- | ------- | -------- |
| 1    | Added production guard for child-process permission model             | b05fd0f | Complete |
| 2    | Added `validateChildProcessPermissions` and `parseAllowNet` validator | b05fd0f | Complete |
| 3    | Reduced cron diagnostic leakage and simplified server logs            | 32f236f | Complete |
| 4    | Documented hardening policy in `docs/SECURITY_AUDIT.md`               | 32f236f | Complete |
| 5    | Added tests for guard and cron generic response                       | 1606c3c | Complete |

## Deviations from Plan

- The plan called for a `validateAllowNet()` helper; we named it `parseAllowNet()` to
  clearly indicate it returns both accepted entries and invalid entries. The behavior
  matches the plan requirements.
- The original plan referenced `apps/web/app/api/cron/feed/route.ts:24-46` and
  `:68-78` as returning diagnostics. In practice the response body already returned
  only `{ error: 'unauthorized' }`; the remaining leakage risk was in the server-side
  logs and the diagnostic helper collecting env-var names. We simplified the helper
  and server-side log to remove env-var-name indicators while keeping request metadata
  for troubleshooting.

## Decisions Made

- Wildcards rejected: `*`, `*.example.com`, `0.0.0.0/0`, `::/0`, and CIDR notation.
- Valid `SCRIPT_CHILD_ALLOW_NET` entries are hostnames, bracketed IPv6, or IPv4 literals
  with optional ports.
- The guard is invoked inside `buildPermissionExecArgv()` in both runners, so it runs
  at request time before forking. This avoids top-level side effects and makes tests
  easier to isolate.
- The cron route now returns `{ error: 'Unauthorized' }` (capitalized) to match the plan.

## must_haves Status

- [x] Production mode refuses to run with disabled child permission model
- [x] Wildcard / `0.0.0.0/0` network allowlists are rejected
- [x] Unauthorized cron access returns generic error only
- [x] Diagnostic details remain server-side
- [x] Tests cover the new guards and the generic response

**Status:** PASS (5/5 must_haves delivered)

## Files Modified

- `workers/nitro-worker/src/platform/permission-guard.js` (new)
- `workers/nitro-worker/src/platform/permission-guard.test.mjs` (new)
- `workers/nitro-worker/src/platform/script-runner.js`
- `workers/nitro-worker/src/platform/wasm-runner.js`
- `apps/web/app/api/cron/feed/route.ts`
- `apps/web/app/api/cron/feed/route.test.ts` (new)
- `docs/SECURITY_AUDIT.md`

## Verification

- `npm --prefix workers/nitro-worker test -- permission-guard.test.mjs`: 412 pass, 0 fail
- `npm --prefix apps/web run test:run -- app/api/cron/feed/route.test.ts`: 1 passed
- `npm --prefix apps/web run test:run`: 165 passed
- `npm run lint`: passed

## Next Steps

- Consider extending `parseAllowNet` to support a deployment-provided allowlist file if
  the env-var string becomes too long.
- Once a structured logger is in place (Phase 3), route the cron diagnostic metadata
  through it instead of `console.warn`.
