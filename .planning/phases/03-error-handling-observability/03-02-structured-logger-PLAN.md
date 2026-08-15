---
wave: 1
depends_on: ['03-01-error-codes-PLAN.md']
files_modified: []
autonomous: true
---

# Plan 03-02: Unified Structured Logger

## Goal

Replace ad-hoc `console.log`/`console.error` usage in critical paths with a structured logger that emits JSON lines compatible with Better Stack, and update the relayer to use it consistently.

## Context

- The project mixes `console`, Sentry, Better Stack, and some custom log sinks.
- `workers/morpheus-relayer/src/logger.js` already exists and may be a suitable foundation or target.
- `packages/shared` is the natural home for a shared logger interface.

## Tasks

<task id="1" name="Design shared logger interface">
Create or extend `packages/shared/src/logger.js` (or `logger.ts`) with:
- Log levels: `trace`, `debug`, `info`, `warn`, `error`, `fatal`.
- Factory `createLogger(namespace)` returning a bound logger.
- Structured log entry shape: `{ timestamp, namespace, level, message, ...fields }`.
- Two built-in transports:
  - `json` (default) — outputs JSON lines to `console`.
  - `pretty` — human-readable, controlled by env var `LOG_PRETTY=1`.
- Helper `logger.child(fields)` for adding constant context.
- Optional: redaction helper for known sensitive fields.

<verify>
- Logger exports `createLogger` and level constants.
- `logger.info('msg', { foo: 'bar' })` outputs JSON with `message`, `foo`, and `namespace`.
- `LOG_PRETTY=1` switches to human-readable format.
- Unit tests exist in `packages/shared/src/logger.test.*`.
</verify>
</task>

<task id="2" name="Replace console in relayer critical paths">
In `workers/morpheus-relayer/src/`, replace direct `console.log`/`console.error`/`console.warn` calls with the structured logger. Start with:
- `request-processor.js`
- `chain-cursor.js`
- `state.js`
- `queue.js`
- `feed-sync.js`
- `healthcheck.js`

Keep `logger.debug` for verbose paths and `logger.warn`/`logger.error` for failures. Do not change logging semantics (what is logged at what level) — only the output format and the object passed for context.

<verify>
- `grep -rn "console\." workers/morpheus-relayer/src` returns no matches outside tests or intentionally allowed spots (e.g., CLI startup).
- `npm --prefix workers/morpheus-relayer test` passes.
- `npm --prefix workers/morpheus-relayer run check` passes.
- Spot-check that key log lines (e.g., discovery failure warnings) still appear in JSON tests.
</verify>
</task>

<task id="3" name="Replace console in web critical paths">
In `apps/web/app/api/` routes and `apps/web/lib/`, replace direct `console` usage with the structured logger. This is lower priority than the relayer, but focus on:
- Cron and public API routes
- Server-side error handlers
- Server Supabase helper

<verify>
- `grep -rn "console\." apps/web/app/api apps/web/lib` returns no matches outside tests.
- `npm --prefix apps/web run test:run` passes.
- `npm --prefix apps/web run lint` passes.
</verify>
</task>

## must_haves

- [ ] Shared logger exists in `packages/shared` with JSON and pretty transports.
- [ ] Relayer no longer uses `console.*` in production paths.
- [ ] Web API routes no longer use `console.*` in production paths.
- [ ] All existing tests pass.
- [ ] Logger output is JSON by default and includes `namespace`, `level`, `message`, and arbitrary fields.
