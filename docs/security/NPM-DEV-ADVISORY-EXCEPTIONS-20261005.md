# npm audit gate and dev-advisory exceptions

## Scope

`npm run check:npm-audit` (`scripts/check-npm-audit.mjs`) is the blocking npm audit of the
`lint-and-format` job in `.github/workflows/ci.yml`. It replaces the blanket
`npm audit --audit-level=moderate`, which failed on a dev-only advisory that has no upstream fix and,
because a job stops at its first red step, kept every later step of the job from running (register
finding SVC-V02).

The gate runs two audits of the root lock, which covers every workspace including `apps/web`:

- production scope, `npm audit --omit=dev --json`;
- the full tree, `npm audit --include=dev --json` (`--include=dev` is explicit because
  `NODE_ENV=production` makes a plain `npm audit` skip dev dependencies without saying so).

## Policy

| Rule | The gate fails when                                                                                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | production scope holds an advisory at or above `moderate` (`BLOCKING_SEVERITY`), exception or not                                                        |
| 2    | the full tree holds a dev-only advisory at or above `moderate` that has no entry in `config/npm-audit-exceptions.json`                                   |
| 3    | an exception is expired: `expiresOn` (YYYY-MM-DD, UTC) is the first day it no longer holds, the same convention as the production-topology exception     |
| 4    | an exception lacks `owner`, `expiresOn` (a real calendar date), `advisory` (a GHSA id), `package` or `reason`, or carries a field the gate does not know |
| 5    | an exception names an advisory that is in production scope, so it is not dev-only                                                                        |
| 6    | an exception matches no advisory in the current audit (stale): fixing the dependency forces the entry to be deleted                                      |
| 7    | an exception expires more than 90 days after today (`MAX_EXCEPTION_HORIZON_DAYS`), so a date such as `9999-12-31` cannot make rule 3 vacuous             |
| 8    | an audit did not produce a usable report (see below)                                                                                                     |

An exception covers one advisory on one package, matched by GHSA id (case-insensitive) and package
name. Packages that only inherit an advisory through a dependency chain need no entry of their own.
Advisories below `moderate` are printed as notes and do not block. Every accepted exception is
printed by name, with owner and days left, on every run, and the pass line is printed last.

### An audit that cannot produce a report

When the registry cannot be reached, `npm audit --json` exits 1, the same code as "vulnerabilities
found", and prints an error-shaped JSON (`message` and `error`, no `vulnerabilities`). The gate never
reads the exit code as a verdict: the report must be a version 2 audit report whose own total agrees
with its vulnerabilities, and every vulnerable package must trace to an advisory. An outage, a
non-JSON answer or an unusable report is retried up to three times (0.5 s and 1.5 s apart), then
fails the gate with the reason. A valid report is final, findings included, and is never retried.

## The exceptions file

`config/npm-audit-exceptions.json`:

```json
{
  "version": 1,
  "exceptions": [
    {
      "advisory": "GHSA-xxxx-xxxx-xxxx",
      "package": "the vulnerable package",
      "reason": "why it is dev-only, and why it cannot be fixed now",
      "owner": "who answers for it",
      "expiresOn": "YYYY-MM-DD"
    }
  ]
}
```

## Current exception

| Field         | Value                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `advisory`    | `GHSA-vfj7-8cjw-p6xm` (braces vulnerable to stack-exhaustion denial of service through deeply nested patterns; high; range `<=3.0.3`)                                                                                                |
| `package`     | `braces`                                                                                                                                                                                                                             |
| `owner`       | NeoOS program lead (delegated by the owner)                                                                                                                                                                                          |
| `expiresOn`   | 2026-11-05 (first day it no longer holds)                                                                                                                                                                                            |
| Why dev-only  | The only path is the `apps/web` devDependency `eslint-config-next` -> `@next/eslint-plugin-next` -> `fast-glob` -> `micromatch` -> `braces`; all five lock entries are `dev: true`; `npm audit --omit=dev` reports 0 vulnerabilities |
| Why not fixed | No patched `braces` exists (3.0.3 is the latest release and lies inside the vulnerable range); the only fix npm offers is the semver-major downgrade to `eslint-config-next` 14.2.35, and `apps/web` is on Next 15                   |

npm reports five vulnerable packages for this one advisory: `braces` carries it, and `micromatch`,
`fast-glob`, `@next/eslint-plugin-next` and `eslint-config-next` inherit it.

### Renewing or retiring it

- Retire: when a dependency change removes the advisory, delete the entry in the same change. Rule 6
  fails the gate until it is deleted.
- Renew: an owner decision. Move `expiresOn` forward by a reviewed date no more than 90 days out and
  update the pin in `scripts/check-npm-audit.test.mjs` ("the committed exception file ..."), which
  records the owner and the date on purpose so that neither changes silently.
- From 2026-11-05 the gate fails with an `expired on 2026-11-05` problem that names the advisory and its
  owner. Nothing renews the exception automatically.

## Running and testing

```sh
npm run check:npm-audit                      # needs registry access
node --test scripts/check-npm-audit.test.mjs # no network: a fake npm stands in for the registry
```

`check-npm-audit.test.mjs` has at least one test per rule, and every rule also runs through the CLI
exit path with a fake `npm` on `PATH`. It embeds the report that `npm audit --json` printed for this
lock, so the parser is exercised on npm's real shape.

## Known limits

- The gate reads live advisory data, so a newly published advisory can turn it red without a commit.
  Steps of a job run in order, so a red audit still skips the later steps of `lint-and-format`. The
  gate stays in that job instead of a new one so that no branch-protection or required-check
  configuration has to change.
- `npm run check:audit:root` (production audit with the excluded CityOfZion baseline, used by
  `npm run verify:repo`) is a separate script and is unchanged by this gate.
