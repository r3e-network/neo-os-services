# Security Audit Notes

This document tracks the current security hardening baseline for NeoOS Services and the checks that must pass before release.

## Current Automated Coverage

- Root dependency audit is guarded by `scripts/check-root-audit-allowlist.mjs` so known CityOfZion baseline findings stay explicit instead of silently expanding.
- Repository verification runs script tests, control-plane tests, worker checks/tests, relayer checks/tests, web consistency checks, web unit tests, and web production build.
- Web security headers are defined in `apps/web/next.config.mjs` and covered by `apps/web/__tests__/security-headers.test.ts`.
- Documentation navigation is covered by `apps/web/__tests__/docs-navigation.test.ts`, including static docs routes and extended Markdown-backed `/docs/r/*` pages.
- Contract artifact generation is validated by `scripts/contract-build-regressions.test.mjs` when `dotnet` and the pinned `nccs` compiler are available.

## Manual Release Checklist

Before a production release, verify:

1. `npm run verify:repo` passes in a clean checkout.
2. The contract CI job installs the pinned Neo C# compiler and runs `contracts/build.sh` successfully.
3. No secrets, private keys, service-role keys, tokens, or connection strings are committed or printed in logs.
4. Production environment variables are scoped by network and deployment target.
5. Callback, relayer, paymaster, and txproxy allowlists are reviewed against the intended deployment contracts.
6. Any live smoke tests use dedicated testnet funds/accounts and do not reuse production signer material.

## Public API Route Policy

The following `apps/web` routes are intentionally public and are hardened against
enumeration and DoS abuse. They are rate-limited by `apps/web/lib/rate-limit.ts`
(Upstash-backed when configured, in-memory otherwise) and enforce Zod input
validation via `apps/web/lib/validators.ts`.

| Route                 | Authentication               | Rate limit | Validation                  |
| --------------------- | ---------------------------- | ---------- | --------------------------- |
| `/api/workflows`      | Runtime/admin token required | 60 req/min | No unexpected query params  |
| `/api/policies`       | Runtime/admin token required | 60 req/min | No unexpected query params  |
| `/api/networks`       | Public (no token)            | 60 req/min | No unexpected query params  |
| `/api/neodid/resolve` | Runtime/admin token required | 30 req/min | `did` and optional `format` |

Authentication uses the shared runtime-token check in
`apps/web/lib/control-plane-auth.ts` (`MORPHEUS_RUNTIME_TOKEN`,
`NITRO_API_TOKEN`, or `NITRO_SHARED_SECRET` presented as a Bearer token or
`x-morpheus-runtime-token` header). Unauthenticated requests to protected routes
receive `401 { error: 'unauthorized' }`; malformed inputs receive
`400 { error: 'invalid query parameters' }`; rate-limited requests receive
`429 { error: 'Too many requests', retryAfter }`. Responses include
`X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers.

## Known Environment Caveat

Local developer machines that do not have `dotnet` and `~/.dotnet/tools/nccs` installed will skip the contract compilation regression test. CI must still enforce contract compilation using the pinned compiler before release.

## TEE Child Process Hardening

The Nitro worker spawns untrusted scripts and WASM modules in child processes. In production the following settings must be enforced:

- The Node.js permission model is ON by default for script/WASM child processes. It can only be disabled by the explicit dev override `MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN=1`, and that override is IGNORED when `NODE_ENV=production` (fail closed). The retired `SCRIPT_CHILD_ENABLE_PERMISSION_MODEL` toggle no longer has any effect.
- `SCRIPT_CHILD_ALLOW_NET` must contain specific hostnames or IP addresses. Wildcards (`*`), `0.0.0.0/0`, `::/0`, and CIDR blocks are rejected at startup.
- `SCRIPT_CHILD_ALLOW_FS_READ` and `SCRIPT_CHILD_ALLOW_FS_WRITE` should be limited to the paths required by the workload.
- The Node.js permission model is applied automatically via `buildPermissionExecArgv` in `workers/nitro-worker/src/platform/script-runner.js` and `wasm-runner.js`.

## Cron Diagnostic Policy

The `/api/cron/feed` endpoint returns a generic `401 { error: 'Unauthorized' }` response to unauthenticated callers. Diagnostic details (header presence, request metadata, and configuration checks) are logged server-side only and never included in the response body.
