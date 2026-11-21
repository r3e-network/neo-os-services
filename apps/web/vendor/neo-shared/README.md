# neo-shared (vendored)

Vendored copy of the monorepo `packages/shared` package
(`@r3e-network/neo-os-services-shared`), pinned inside `apps/web` so the
Vercel build is self-contained.

## Why this exists

Vercel's Git-deployment file materialization for this monorepo now only
downloads the `apps/web` subtree (293 files on the 2026-11-01 build, versus
2289 whole-repo files on the 2026-10-24 build). The previous dependency
`file:../../packages/shared` resolved to a sibling directory that is no
longer materialized in the build container, so every subpath import
(`utils`, `node-runtime`, `public-runtime`, `automation-supervisor`, ...)
failed with `Module not found`.

## How it is wired

- `apps/web/package.json` depends on `file:vendor/neo-shared`.
- `apps/web/tsconfig.json` maps `@r3e-network/neo-os-services-shared(/*)` to
  `./vendor/neo-shared/src(/*)`.
- `apps/web/next.config.mjs` adds the same webpack alias and sets
  `outputFileTracingRoot` to the app root.
- `apps/web/vitest.config.ts` mirrors the alias for tests.

## Related vendored snapshots

`apps/web/vendor/monorepo/` additionally contains the two other monorepo
files the web app imports at build time: `config/networks/*.json` (used by
`lib/networks.ts`) and `deploy/nitro/measurements/*.json` (used by
`lib/nitro-measurements.ts`). Re-sync those together with this package.

## Keeping it fresh

This copy must be re-synced whenever `packages/shared` changes:

```bash
rm -rf apps/web/vendor/neo-shared
cp -R packages/shared apps/web/vendor/neo-shared
find apps/web/vendor/neo-shared -name "*.test.mjs" -delete
```

A stale copy will compile against outdated shared sources; if a subpath
import added in `packages/shared` fails here, re-run the sync above.
