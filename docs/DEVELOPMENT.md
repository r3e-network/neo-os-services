# Development Guide

## Regenerating Supabase Types

The `apps/web/lib/supabase-types.ts` file is generated from the SQL migrations in
`supabase/migrations/`. When the schema changes, regenerate the types before
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
for f in supabase/migrations/*.sql; do
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
