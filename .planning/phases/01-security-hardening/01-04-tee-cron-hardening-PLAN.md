---
wave: 1
depends_on: []
files_modified: []
autonomous: true
---

# Plan 04: TEE Child Process & Cron Diagnostic Hardening

## Goal

Harden the Nitro worker script/WASM sandbox and reduce cron diagnostic leakage so that
production configuration details are not exposed to unauthenticated callers.

## Context

- `workers/nitro-worker/src/platform/script-runner.js:19-55` and
  `workers/nitro-worker/src/platform/wasm-runner.js:19-53` use environment variables to
  toggle Node.js permission model and network allowlists.
- `apps/web/app/api/cron/feed/route.ts:24-46` and `apps/web/app/api/cron/feed/route.ts:68-78`
  return environment variable names and header lengths on unauthorized access.

## Tasks

<task id="1" name="Add production guard for child process permissions">
In `workers/nitro-worker/src/platform/script-runner.js` and `wasm-runner.js`, add a
startup guard that throws if:
- `NODE_ENV === 'production'` and `SCRIPT_CHILD_ENABLE_PERMISSION_MODEL=false`
- `SCRIPT_CHILD_ALLOW_NET` contains `0.0.0.0/0`, `*`, or empty allow-all patterns

<verify>
Unit tests spawn the runner with dangerous env vars and assert it refuses to start in
production mode. Safe defaults still work.
</verify>
</task>

<task id="2" name="Validate network allowlist">
Create a helper `validateAllowNet()` that parses `SCRIPT_CHILD_ALLOW_NET` and rejects
`0.0.0.0/0`, `*`, and malformed CIDRs. Use it in both runner modules before spawning.

<verify>
Test cases cover allowed hosts, blocked wildcards, and malformed entries.
</verify>
</task>

<task id="3" name="Reduce cron diagnostic leakage">
Edit `apps/web/app/api/cron/feed/route.ts` so that when the request is unauthorized,
it returns a generic `{ error: 'Unauthorized' }` response and logs the diagnostic
details (header names, lengths, missing secrets) server-side only.

<verify>
Unauthorized requests receive only `401 Unauthorized` with generic error; response body
contains no environment variable names or header lengths. Existing tests pass; new test
asserts generic response.
</verify>
</task>

<task id="4" name="Document hardened defaults">
Add production hardening checklist to `docs/SECURITY_AUDIT.md` or `docs/OPERATIONS.md`
listing required child-process permission settings and cron diagnostic policy.

<verify>
Documentation file updated with the settings and policy summary.
</verify>
</task>

## must_haves

- [ ] Production mode refuses to run with disabled child permission model
- [ ] Wildcard / `0.0.0.0/0` network allowlists are rejected
- [ ] Unauthorized cron access returns generic error only
- [ ] Diagnostic details remain server-side
- [ ] Tests cover the new guards and the generic response
