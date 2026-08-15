# Codebase Concerns

**Analysis Date:** 2026-07-04

## Tech Debt

**Loose typing in core server abstractions:**

- Issue: `ServerSupabaseClient` is exported as `any` in the main server-side data module, and several Supabase queries are cast with `as any`.
- Files: `apps/web/lib/server-supabase.ts:4`, `apps/web/lib/server-supabase.ts:168`, `apps/web/lib/operation-logs.ts:361`, `apps/web/lib/operation-logs.ts:387`, `apps/web/lib/neo-control-plane.ts:206`, `apps/web/app/api/confidential/store/route.ts:127`
- Why: Likely used to bypass strict Supabase-generated-types churn during rapid iteration.
- Impact: Loses compile-time guarantees on every query using the server client; schema drift will surface at runtime instead of build time.
- Fix approach: Generate or hand-write typed Supabase client schemas and replace `any` casts with the generated types.

**Broad `any` typing in dashboard components:**

- Issue: Dashboard components propagate `any` for oracle state, key metadata, providers, and response payloads.
- Files: `apps/web/components/dashboard/OracleTab.tsx:31`, `apps/web/components/dashboard/OracleTab.tsx:64-65`, `apps/web/components/dashboard/ComputeTab.tsx:73`, `apps/web/components/dashboard/ProvidersTab.tsx:14`, `apps/web/components/dashboard/OracleResponseViewer.tsx:14`, `apps/web/components/starter/StarterStudio.tsx:125`, `apps/web/components/starter/KeyMetaPanels.tsx:6`
- Why: Oracle/chain state shapes are complex and vary by network.
- Impact: Refactoring state shapes is risky; TypeScript cannot catch broken prop passing or field renames.
- Fix approach: Introduce shared `OracleState`, `OracleKeyMeta`, and `ProviderConfig` types in `packages/shared` or `apps/web/lib/types` and apply them across components.

**Monolithic worker/relayer modules:**

- Issue: The fulfillment pipeline, Neo N3 chain integration, and feed aggregation are each concentrated in single very large files.
- Files: `workers/morpheus-relayer/src/fulfillment.js` (~1968 lines), `workers/morpheus-relayer/src/neo-n3.js` (~1280 lines), `workers/nitro-worker/src/oracle/feeds.js` (~990 lines), `workers/morpheus-relayer/src/automation.js` (~867 lines)
- Why: Business logic evolved in place; refactoring has been deferred.
- Impact: High cognitive load, difficult to unit-test in isolation, and easy to introduce regressions when changing error-classification or signing paths.
- Fix approach: Decompose into smaller modules by concern (e.g., `feed-submit.js` already extracted; do the same for `fulfillment.js` and `neo-n3.js`).

**In-memory rate limiter as primary backend:**

- Issue: `apps/web/lib/rate-limit.ts` uses a process-local `Map` when Upstash is not configured.
- Files: `apps/web/lib/rate-limit.ts:30-62`, `apps/web/lib/rate-limit.ts:100-179`
- Why: Upstash is an optional integration; local fallback avoids a hard dependency.
- Impact: Rate limits do not coordinate across multiple serverless instances; an attacker can distribute requests across instances and bypass limits. Cleanup also scans the whole map.
- Fix approach: Make Upstash mandatory in production, or add a Redis-backed shared store, and remove the local fallback in production builds.

**Console logging in production code paths:**

- Issue: Several API routes and components write errors and diagnostics to `console` instead of a structured log sink.
- Files: `apps/web/app/api/cron/feed/route.ts:70`, `apps/web/components/dashboard/OracleTab.tsx:210`, `apps/web/components/dashboard/OracleTab.tsx:239`, `apps/web/components/dashboard/ComputeTab.tsx:158`, `apps/web/components/dashboard/ProvidersTab.tsx:32`, `apps/web/lib/provider-configs.ts:138`, `workers/nitro-worker/src/oracle/feeds.js:317`, `workers/nitro-worker/src/oracle/feeds.js:330`, `workers/morpheus-relayer/src/logger.js:104`
- Why: Convenience during development; Sentry is present but not used uniformly.
- Impact: Logs are lost in serverless environments, and some diagnostics may leak request metadata.
- Fix approach: Route all diagnostics through the structured logger/operation-log system; use `console` only in tests or local dev.

## Known Bugs

**Swallowed keystore-read error in Nitro worker:**

- Symptoms: If the oracle keystore file exists but is malformed, the worker silently falls through to generating a new key instead of surfacing the error.
- Trigger: Deploy with `NITRO_ORACLE_KEYSTORE_PATH` pointing to an existing but invalid JSON file.
- File: `workers/nitro-worker/src/oracle/crypto.js:228-238`
- Workaround: Validate keystore file contents before deployment; monitor for unexpected key regeneration.
- Root cause: The `try` block reading the legacy keystore ends with an empty `catch {}`.
- Fix: Distinguish ENOENT from malformed data; throw on malformed data and only generate a new key when the file is missing.

## Security Considerations

**Client-side HTML injection via syntax highlighting:**

- Risk: `CodeBlock.tsx` renders highlighted markup with `dangerouslySetInnerHTML`.
- File: `apps/web/components/ui/CodeBlock.tsx:296`
- Current mitigation: `highlight.js` is used for tokenization; the input content is assumed to be trusted documentation or user-supplied code (not arbitrary HTML).
- Recommendations: Ensure the highlighter runs in a sanitizer pipeline, or switch to a React syntax-highlighter that constructs a virtual DOM. Add a test that verifies `<script>` payloads are not executed.

**Public API routes without authentication:**

- Risk: `/api/workflows`, `/api/policies`, `/api/networks`, and `/api/neodid/resolve` are exposed without any API-key or session check.
- Files: `apps/web/app/api/workflows/route.ts`, `apps/web/app/api/policies/route.ts`, `apps/web/app/api/networks/route.ts`, `apps/web/app/api/neodid/resolve/route.ts`
- Current mitigation: The data returned is intentionally public (catalogs, registry), and `/api/networks` records operation logs.
- Recommendations: Confirm these are intentionally public; add lightweight rate-limiting wrappers to all public endpoints to prevent enumeration and DoS.

**npm-auditable dependency vulnerabilities:**

- Risk: Multiple packages with known advisories are present in the lockfile.
- Direct dependency: `@sentry/nextjs` (moderate, via `@sentry/node` and OpenTelemetry), `@cityofzion/neon-core` (high, via `elliptic` and `lodash`), `brace-expansion` (moderate, DoS), `@babel/core` (low, arbitrary file read).
- Files: `package-lock.json`, `apps/web/package.json`, `package.json`
- Current mitigation: `overrides` pin some transitive versions (e.g., `lodash`, `postcss`), but not all affected packages.
- Recommendations: Run `npm audit fix` and update `@sentry/nextjs` to a non-vulnerable version; keep an audit gate in CI.

**Script/WASM execution child-process permissions are configurable:**

- Risk: The Nitro worker forks Node.js child processes for user-supplied scripts and WASM, and the permission model is toggled by environment variables.
- Files: `workers/nitro-worker/src/platform/script-runner.js:19-55`, `workers/nitro-worker/src/platform/wasm-runner.js:19-53`
- Current mitigation: Defaults enable `--permission`, `--disable-proto=throw`, and `--frozen-intrinsics`; filesystem and network access are restricted by env vars.
- Recommendations: Treat `SCRIPT_CHILD_ENABLE_PERMISSION_MODEL=false` as a development-only setting; add a startup guard that refuses to run with the permission model disabled in production. Validate that `SCRIPT_CHILD_ALLOW_NET` never includes `0.0.0.0/0` or wildcards.

**Supabase operational table RLS was historically incomplete:**

- Risk: `supabase/migrations/0015_harden_operational_table_rls.sql` documents that `morpheus_system_backups` had RLS disabled until the hardening migration.
- File: `supabase/migrations/0015_harden_operational_table_rls.sql:1-26`
- Current mitigation: Migration now enables RLS on the table with no policies, restricting access to the service role.
- Recommendations: Audit all remaining Supabase tables for RLS; verify no future migrations disable or weaken RLS without a documented exception.

**Cron diagnostics may leak environment key names:**

- Risk: The unauthorized-cron path returns which secret environment variables are configured and header lengths, which can aid reconnaissance.
- File: `apps/web/app/api/cron/feed/route.ts:24-46` and `apps/web/app/api/cron/feed/route.ts:68-78`
- Current mitigation: The actual secret values are not returned; only presence/absence and lengths are exposed.
- Recommendations: Reduce diagnostic detail in production; return a generic `unauthorized` response and log the details server-side only.

## Performance Bottlenecks

**In-memory rate-limit map scan:**

- Problem: Every request triggers `cleanupStaleEntries`, which scans the entire `rateLimitMap`.
- File: `apps/web/lib/rate-limit.ts:53-62`
- Measurement: Map is unbounded per instance; worst-case cleanup is O(n) for every request.
- Cause: Single shared map with no sharding or TTL index.
- Improvement path: Use a time-bucketed structure, or rely on Upstash/Redis exclusively for production.

**Large synchronous string matching in error classifier:**

- Problem: `classifyError` in the relayer performs multiple regex tests and substring searches on every error.
- File: `workers/morpheus-relayer/src/fulfillment.js:161-200`
- Measurement: Not instrumented, but the function is in the hot path for every failed fulfillment.
- Cause: Error taxonomy is encoded with string/regex heuristics rather than typed error codes from workers/contracts.
- Improvement path: Replace string matching with structured error codes returned by the worker and contract clients; keep the classifier as a fallback only.

**Dashboard serial on-chain reads:**

- Problem: Dashboard tabs issue multiple independent on-chain RPC calls from the client.
- Files: `apps/web/components/dashboard/OracleTab.tsx:210-283`, `apps/web/components/dashboard/ComputeTab.tsx:158-271`
- Cause: Each piece of state is fetched separately from the browser.
- Improvement path: Add a server-side aggregate endpoint that fetches all oracle state in one request and caches it with a short TTL.

## Fragile Areas

**Error classification and retry logic in relayer:**

- Why fragile: `classifyError` decides whether a failed request is retried, finalized, or dead-lettered based on substrings and regexes in the error message.
- Files: `workers/morpheus-relayer/src/fulfillment.js:82-200`, `workers/morpheus-relayer/src/lib/retry.js`
- Common failures: A new contract or upstream error message that does not match the heuristic can be mis-classified, causing infinite retry or premature finalization.
- Safe modification: Add characterization tests for every new error message before changing the classifier; prefer typed error codes over text matching.
- Test coverage: There are tests (`relayer.test.mjs`, `fulfillment.test.mjs`), but the classifier relies on strings that may not cover all live error paths.

**Neo N3 RPC URL promotion heuristic:**

- Why fragile: `promoteNeoN3RpcUrl` mutates the shared config object with last-write-wins ordering across concurrent calls.
- File: `workers/morpheus-relayer/src/neo-n3.js:69-74`
- Common failures: Concurrent successful RPC calls can race and produce a transient sub-optimal URL order; in rare cases this could affect failover behavior.
- Safe modification: Snapshot the URL list at call start and avoid mutating shared config during request handling.
- Test coverage: The function is documented as best-effort but has no explicit concurrency test.

**Nitro attestation verification chain:**

- Why fragile: The attestation verification path is large, pinned to specific PCR0/PCR1/PCR2 values, and depends on a root certificate and COSE/CBOR parsing.
- File: `apps/web/lib/nitro-attestation.ts` (~951 lines), `workers/morpheus-relayer/src/attestation.js`
- Common failures: A root certificate rotation, AWS PCR changes, or a parsing edge case will break verification.
- Safe modification: Keep pinned PCR values and root certs in env/config separate from code; add tests that exercise rotated certs and malformed attestation docs.
- Test coverage: `apps/web/lib/nitro-attestation.test.ts` exists but must be kept in sync with live AWS root releases.

**Chain cursor checkpoint validation:**

- Why fragile: `resolveChainFromBlock` silently resets invalid checkpoints to the start block, which can cause re-processing of a large range.
- File: `workers/morpheus-relayer/src/chain-cursor.js:16-54`
- Common failures: A corrupted state store or a reorg that pushes the confirmed tip below the checkpoint will reset the cursor.
- Safe modification: Add alarms when checkpoints are reset; require explicit operator confirmation for resets that span many blocks.
- Test coverage: Unit tests exist but do not cover all edge cases (e.g., `lastBlock > confirmedTip` with negative `configuredStart`).

## Scaling Limits

**Rate-limit state per serverless instance:**

- Current capacity: Unbounded per instance, but state is not shared.
- Limit: A horizontally scaled deployment effectively multiplies the rate-limit budget by the number of active instances.
- Symptoms at limit: Bursts of requests bypass limits when load-balanced across instances.
- Scaling path: Enforce Redis/Upstash as the shared backend and disable the in-memory fallback in production.

**Supabase lookup cache is process-local:**

- Current capacity: TTL is configurable (default 30 seconds) but per-instance.
- Limit: Cache hit rate is lower under load, and every instance independently queries Supabase.
- Symptoms at limit: Increased Supabase API load and latency under horizontal scaling.
- Scaling path: Move the project/provider-config lookup cache to a shared Redis store.

## Dependencies at Risk

**@sentry/nextjs:**

- Risk: Moderate-severity audit advisories via `@sentry/node` and OpenTelemetry dependencies.
- Impact: Potential unbounded memory allocation in W3C Baggage propagation; observability gaps or crashes.
- Migration plan: Upgrade to `@sentry/nextjs` >= 11 or the version recommended by `npm audit fix`.

**@cityofzion/neon-core:**

- Risk: High-severity audit advisories via `elliptic` and `lodash`.
- Impact: Cryptographic or prototype-pollution issues in Neo N3 transaction/signing paths.
- Migration plan: Pin/override the vulnerable transitive versions, or update `neon-js` once a patched release is available.

**solc 0.8.24:**

- Risk: Solidity compiler is pinned to a specific older point release.
- Impact: Missing optimizer and security fixes in newer Solidity versions; potential incompatibility with future tooling.
- Migration plan: Evaluate and upgrade to the latest 0.8.x release after running the EVM contract test suite.

## Missing Critical Features

**Centralized structured logging for all components:**

- Problem: Web app, workers, and scripts use a mix of `console`, Sentry, and BetterStack, with no uniform log schema.
- Current workaround: Operation logs are written for some routes, but not all; worker logs go to stdout.
- Blocks: Reliable production alerting, unified debugging, and audit trails.
- Implementation complexity: Medium (define a shared logger interface and adopt it across `apps/web`, `workers`, and `scripts`).

**Schema validation on public API inputs:**

- Problem: Several API routes parse query parameters and JSON bodies without a strict validation/schema layer.
- Files: `apps/web/app/api/neodid/resolve/route.ts`, `apps/web/app/api/cron/feed/route.ts`, `apps/web/app/api/runtime/catalog/route.ts`
- Current workaround: Manual parsing and ad-hoc checks.
- Blocks: Confident API evolution and protection against malformed payloads.
- Implementation complexity: Low-Medium (adopt Zod or a similar validator in `apps/web/lib/validators`).

**Type-safe Supabase client schemas:**

- Problem: The server Supabase client and many queries are untyped.
- Files: `apps/web/lib/server-supabase.ts`, `apps/web/lib/neo-control-plane.ts`, `apps/web/lib/operation-logs.ts`
- Current workaround: Runtime validation and manual casts.
- Blocks: Build-time catching of schema drift and safer refactoring.
- Implementation complexity: Medium (generate types from migrations or maintain a hand-written type package).

## Test Coverage Gaps

**Dashboard component behavior:**

- What's not tested: Most dashboard components (`OracleTab`, `ComputeTab`, `ProvidersTab`, `StarterStudio`) are not covered by unit tests and rely on manual integration checks.
- Risk: UI regressions in oracle request creation, provider selection, and state display go unnoticed.
- Priority: Medium
- Difficulty to test: Components depend on wallet state and on-chain data; requires mocking Neo RPC and browser providers.

**CodeBlock HTML rendering safety:**

- What's not tested: No visible test verifies that `dangerouslySetInnerHTML` in `CodeBlock.tsx` cannot be abused with malicious input.
- Risk: A future change in the highlighter or input source could introduce XSS.
- Priority: Medium
- Difficulty to test: Low (render with a malicious payload and assert no script execution).

**Relayer error-classification heuristics:**

- What's not tested: Not all upstream and contract error strings are covered by `classifyError` tests.
- Risk: New error messages cause mis-routing to retry or finalize paths.
- Priority: High
- Difficulty to test: Medium (collect representative error messages from staging/mainnet logs and add characterization tests).

**Child-process sandbox permissions:**

- What's not tested: The script/WASM child-process permission model is not covered by tests that verify restricted filesystem/network access.
- Risk: A misconfiguration or regression enables unauthorized access inside the worker sandbox.
- Priority: High
- Difficulty to test: Medium (fork the child process with test payloads and assert permission denials).

---

_Concerns audit: 2026-07-04_
_Update as issues are fixed or new ones discovered_
