# Development Guide

## Regenerating Supabase Types

The `apps/web/lib/supabase-types.ts` file is generated from the SQL migrations in
`db/services/migrations/`. When the schema changes, regenerate the types before
committing.

### Requirements

- PostgreSQL client tools (`initdb`, `pg_ctl`, `psql`, `createdb`)
- Node.js + `pg` npm package
- Supabase CLI (optional; local generation uses a throwaway Postgres cluster)

### Steps

1. Start a temporary Postgres cluster on a free port (example uses 5434):

```bash
TMPDIR=$(mktemp -d)
initdb -D "$TMPDIR/pgdata" --auth=trust --no-locale --encoding=UTF8 -U postgres
pg_ctl -D "$TMPDIR/pgdata" -o "-p 5434" -l "$TMPDIR/pg.log" start
sleep 2
createdb -h localhost -p 5434 -U postgres morpheus
```

2. Run all migrations:

```bash
for f in db/services/migrations/*.sql; do
  psql -h localhost -p 5434 -U postgres -d morpheus -f "$f"
done
```

3. Generate types (requires `pg` installed in the workspace):

```bash
node scripts/generate-supabase-types.mjs apps/web/lib/supabase-types.ts
```

4. Format the result:

```bash
npx prettier --write apps/web/lib/supabase-types.ts
```

5. Stop and clean up the temporary cluster:

```bash
pg_ctl -D "$TMPDIR/pgdata" stop
rm -rf "$TMPDIR"
```

### Validation

After regenerating, run:

```bash
cd apps/web && npx tsc --noEmit
npm --prefix apps/web run test:run
```

## Repository Formatting

### Overview

Prettier checks maintained JavaScript, TypeScript, JSON, Markdown, and workflow
files. Third-party vendored sources and generated golden-vector JSON are
excluded so the formatting gate never rewrites upstream or byte-derived
artifacts.

### API Reference

- `npm run format:check` verifies the maintained formatting scope without
  writing files.
- `npm run format` rewrites files in that scope.
- `.prettierignore` is the source of truth for generated and vendored
  exclusions; adding an exclusion requires a reason in that file.

### Usage Example

```bash
npx prettier --write path/to/changed-file.ts
npm run format:check
```

### Design Decision

Formatting generated vectors would create review noise that is overwritten by
their exporters, while formatting vendored Boa sources would fork upstream
bytes. Maintained adapters, tests, and documentation remain in scope.

### Test Coverage

CI runs `npm run format:check` before lint and tests. A formatting failure in a
maintained file blocks the build.

## Secret Scanning

### Overview

Gitleaks scans repository history and pending patches with the default rules
plus Neo key-material rules. Deterministic cryptographic golden vectors are
public test fixtures, but exemptions must remain path-and-line scoped so a real
credential elsewhere in the same module still fails the scan.

### API Reference

- `.gitleaks.toml` owns repository-specific, evidence-backed allowlists.
- `.gitleaksignore` may contain only exact fingerprints for immutable historical
  findings that cannot be removed without rewriting published Git history.
- `config/gitleaks/neo-rules.toml` owns the shared Neo WIF/private-key rules.
- CI pins Gitleaks `v8.30.1`; local scans should use the same version.

### Usage Example

```bash
gitleaks git --pre-commit --redact --no-banner .
gitleaks git --redact --no-banner .
```

### Design Decision and Test Coverage

An exemption must match both an exact fixture path and a stable marker such as
`GOLDEN_PLAINTEXT` or `KEY_MATERIAL_JSON`. Whole-file secret-rule suppression
is prohibited. Rejection-path tests must use non-importable placeholders, and
ordinary deterministic salts should use visibly test-only low-entropy values;
neither case justifies storing key-shaped material. The CI full-history scan
verifies the committed result, while the pre-commit scan verifies the pending
patch. Historical ignores must include the commit, path, rule ID, and line
number fingerprint; path-, variable-, or rule-wide historical suppression is
not acceptable.

The public client/Rust confidential-envelope fixture at
`crates/neo-os-compute/tests/vectors/confidential-envelope-v2-client.json`
necessarily contains one deterministic PKCS#8 private key. Its allowlist is
restricted to that exact path and the `private_key_pkcs8` JSON field; any other
secret-looking value in the same file or field elsewhere still fails scanning.
