---
wave: 1
depends_on: []
files_modified: []
autonomous: true
---

# Plan 01: Dependency Audit & CI Gate

## Goal

Eliminate known npm audit vulnerabilities and add a CI gate to prevent future
high/moderate severity advisories from being merged.

## Context

- `@cityofzion/neon-core` (high via `elliptic`/`lodash`)
- `@sentry/nextjs` (moderate via `@sentry/node` and OpenTelemetry)
- `brace-expansion` (moderate DoS)
- `@babel/core` (low arbitrary file read)
- Files: `package-lock.json`, `apps/web/package.json`, `package.json`

## Tasks

<task id="1" name="Run baseline audit">
Run `npm audit` in the project root and capture the full report.

<verify>
The audit report is saved or summarized, with exact affected packages and severity levels.
</verify>
</task>

<task id="2" name="Fix vulnerabilities">
Apply `npm audit fix` where safe. For breaking changes (e.g., `@sentry/nextjs` major
version), evaluate the migration path and pin/override transitive versions where an
upgrade is not yet feasible. Update `package.json` and `package-lock.json`.

<verify>
`npm audit --audit-level=moderate` returns 0 moderate/high/critical advisories.
If a vulnerability must remain, document the exception with a `//` comment in
`package.json` and a brief note in `.planning/phases/01-security-hardening/01-exception-notes.md`.
</verify>
</task>

<task id="3" name="Add CI audit gate">
Edit `.github/workflows/ci.yml` to add an `npm audit --audit-level=moderate` step
after `npm ci`. Make the step fail the workflow on new advisories.

<verify>
CI YAML is valid and contains an audit step that runs on every PR/push.
A simulated `npm audit --audit-level=moderate` exit code 0 is observed locally.
</verify>
</task>

<task id="4" name="Update workspace package locks">
Run `npm install --package-lock-only` and ensure all workspace package-lock files are
consistent. CI lockfile diff check (`git diff --exit-code`) must pass.

<verify>
`git diff --exit-code` on lockfiles returns 0 after `npm install --package-lock-only`.
</verify>
</task>

## must_haves

- [ ] `npm audit --audit-level=moderate` returns 0
- [ ] CI has a failing audit gate
- [ ] All lockfiles are in sync
- [ ] Any remaining exceptions are documented
