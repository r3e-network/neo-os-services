# Coding Conventions

**Analysis Date:** 2026-07-04

## Naming Patterns

**Files:**

- TypeScript/JavaScript source: `kebab-case.ts`, `kebab-case.tsx`, `kebab-case.js`, `kebab-case.mjs`
  - Examples: `apps/web/lib/server-supabase.ts`, `workers/nitro-worker/src/platform/circuit-breaker.js`
- Test files collocated with source: `*.test.ts`, `*.test.tsx`, `*.test.mjs`
  - Examples: `workers/nitro-worker/src/platform/circuit-breaker.test.mjs`, `apps/web/__tests__/server-supabase.test.ts`
- C# source files: match the primary class name (`PascalCase.cs`), often split by feature
  - Examples: `contracts/MorpheusOracle/MorpheusOracle.cs`, `contracts/MorpheusOracle/MorpheusOracle.Storage.cs`
- Solidity contracts: `PascalCase.sol`
  - Examples: `contracts-evm/MorpheusOracleEVM.sol`, `contracts-evm/test/TestBase.sol`
- SQL migrations: `####_snake_case_description.sql`
  - Examples: `supabase/migrations/0001_morpheus_schema.sql`

**Functions:**

- TypeScript/JavaScript: `camelCase` for all functions and methods
  - Example: `resolveLookupCacheTtlMs`, `getCachedValue`, `recordFailure`
- Private helpers in JS/TS: prefer `camelCase` without underscore prefix; internal-only functions are simply not exported
- C#: `PascalCase` for methods, properties, and events
  - Example: `AssertHasPublicStaticMethod`, `SetRuntimeEncryptionKey`
- Solidity: `camelCase` for functions, `PascalCase` for events is not used; the project uses explicit `Handler` delegate-style naming in C# and `event Name` in Solidity

**Variables:**

- `camelCase` for local variables and parameters
- `UPPER_SNAKE_CASE` for true constants and environment variable names
  - Examples: `LOOKUP_CACHE_TTL_MS`, `VERIFIER_KEY`, `APP`, `MODULE`
- Boolean variables often use predicate phrasing: `called`, `allowed`, `active`

**Types:**

- TypeScript: `PascalCase` for interfaces, type aliases, and enums; no `I` prefix on interfaces
  - Examples: `ServerSupabaseClient`, `ProjectProviderConfigRecord`, `MorpheusNetwork`
- C#: `PascalCase` for classes, structs, enums, and namespaces
  - Namespace: `MorpheusOracle.Contracts`
  - Enum values: `PascalCase` (e.g., `Pending`, `Succeeded`, `Failed` in `KernelRequestStatus`)
- Solidity: `PascalCase` for contracts, interfaces, libraries, and structs

## Code Style

**Formatting:**

- Prettier config in `.prettierrc`
  - `semi: true`
  - `singleQuote: true`
  - `tabWidth: 2`
  - `trailingComma: "es5"`
  - `printWidth: 100`
  - `bracketSpacing: true`
  - `arrowParens: "always"`
  - `endOfLine: "lf"`
- Run formatting across the repo:
  - `npm run format` — write
  - `npm run format:check` — check in CI

**Linting:**

- ESLint config in `.eslintrc.json`
  - Parser: `@typescript-eslint/parser`
  - ECMAScript 2022, source type module, JSX enabled
  - Plugins: `@typescript-eslint`
  - Core rule: `@typescript-eslint/no-unused-vars` with `argsIgnorePattern: "^_"` and `varsIgnorePattern: "^_"`
  - For plain `.js` / `.mjs` files, the override reverts to plain `no-unused-vars` with the same underscore ignore pattern
- Run lint:
  - `npm run lint`
  - `npm run lint:fix`
- ESLint ignores: `node_modules`, `.next`, `.vercel`, `coverage`, build artifacts, `contracts/**`, `supabase/**`, `examples/**`

**TypeScript:**

- `apps/web/tsconfig.json` enforces:
  - `strict: true`
  - `noEmit: true`
  - `isolatedModules: true`
  - `moduleResolution: "bundler"`
  - Path alias `@/*` maps to `./*`
- JS workers use JSDoc + `.d.ts` hand-written types rather than `.ts` compilation
  - Example: `packages/shared/src/index.js` with `packages/shared/src/index.ts` for types

**C# / Neo:**

- `Directory.Build.props` sets:
  - `TargetFramework`: `net10.0`
  - `Nullable`: `enable`
  - `Optimize`: `true`
  - All contract projects reference `Neo.SmartContract.Framework` `3.9.1`
- Compiler tool: Neo.Compiler.CSharp (nccs) `3.9.1`, invoked by `contracts/build.sh`

**Solidity:**

- `foundry.toml` pins:
  - `solc = "0.8.24"`
  - `evm_version = "paris"`
  - `optimizer = true`, `optimizer_runs = 200`
- Every source file starts with `// SPDX-License-Identifier: MIT` and `pragma solidity ^0.8.24;`

**SQL:**

- Lowercase keywords and `snake_case` identifiers
- Tables prefixed by subsystem: `morpheus_projects`, `morpheus_requests`, `morpheus_feed_snapshots`
- Use `if not exists` for idempotent migrations
- Add explicit `check` constraints for enum-like columns
- Index naming: `idx_<table>_<column>`

## Import Organization

**Order (TypeScript/JavaScript):**

1. Node built-ins
2. External packages
3. Workspace packages (`@neo-morpheus-oracle/*`)
4. Internal path aliases (`@/*` in `apps/web`)
5. Relative imports

**Grouping:**

- Blank lines separate groups
- Within a group, sort alphabetically where it does not hurt readability

**Path Aliases:**

- `apps/web`: `@/*` maps to project root (`./*`)
  - Example: `import { loadProjectProviderConfig } from '../lib/server-supabase';` (relative for same-directory siblings), but `@/` is available for root-relative imports
- Workspace packages: `@neo-morpheus-oracle/shared`, `@neo-morpheus-oracle/nitro-worker`, `@neo-morpheus-oracle/morpheus-relayer`
  - Example: `import { timingSafeCompare } from '@neo-morpheus-oracle/shared/utils';`

**ESM conventions:**

- Workers and `packages/shared` use `"type": "module"` and native ESM
- Imports omit `.js` / `.mjs` extensions when importing from sibling source files (Node ESM resolution relies on explicit extensions in the specifier, but the codebase uses extensionless imports resolved via package exports or `*.js` shims)
  - Example: `import { CircuitBreaker } from './circuit-breaker.js';`
- Top-level `package.json` is CommonJS by default (no `"type"` field), but scripts are often `.mjs`

## Error Handling

**Patterns:**

- HTTP boundaries return structured `{ error: string, ... }` objects rather than throwing
  - Example: `workers/nitro-worker/src/platform/circuit-breaker.js` returns state objects; HTTP handlers return error responses
- Utility and business logic throws `Error` for invariant violations
- Node.js tests use `assert.throws` / `assert.rejects` for error cases
- Solidity uses custom error selectors:
  - Example: `vm.expectRevert(MorpheusOracleEVM.CallbackAlreadyRegistered.selector);`

**Async errors:**

- Prefer `async/await` with `try/catch` at service boundaries
- Avoid bare `.catch()` chains in production code

## Logging

**Framework:**

- No structured logger library is used; the project relies on `console.log`, `console.warn`, and `console.error`
- `apps/web/next.config.mjs` strips `console.log`/`console.info` in production builds via `compiler.removeConsole`, leaving `warn` and `error`

**Patterns:**

- Log at service boundaries and state transitions
- Keep utility functions free of logging noise
- In scripts, print progress with `console.log` during execution

## Comments

**When to Comment:**

- Explain why, not what, especially around non-obvious storage layout or protocol decisions
- Use block-comment headers with `──` rules to separate logical sections
  - Example from `contracts/MorpheusOracle/Morpheus.cs`:
    ```csharp
    // ── Storage-key prefix allocation map (READ BEFORE ADDING A PREFIX) ──────────
    // FOOTGUN: the values below are HEXADECIMAL literals...
    ```
- Warn about dangerous behavior with `FOOTGUN:` labels

**XML documentation:**

- C# public APIs use `<summary>` and `<remarks>` blocks
  - Example: `MorpheusOracle.cs` documents the legacy deployment name and contract responsibilities

**TODO Comments:**

- Not heavily used; prefer inline explanatory comments or issue tracking over TODO markers

## Function Design

**Size:**

- Keep functions focused; extract helpers for complex logic
- C# contracts split large classes into partial files by concern (`MorpheusOracle.cs`, `MorpheusOracle.Storage.cs`, `MorpheusOracle.Requests.cs`, `MorpheusOracle.Fulfillment.cs`)

**Parameters:**

- Use options objects for configurable constructors
  - Example: `new CircuitBreaker('test', { failureThreshold: 3, resetTimeoutMs: 60_000 })`
- Destructure in parameter lists for test factories
  - Example: `function createFakeSupabase({ projectId = 'project-1', providerConfig = {} } = {})`

**Return Values:**

- Return early for guard clauses
- Prefer explicit return statements; avoid implicit `undefined`
- Status/results often returned as plain objects: `{ status: 200, data: ... }`, `{ state, failures }`

## Module Design

**Exports:**

- Named exports preferred in TypeScript/JavaScript
- Default exports are used for Next.js page/config files
  - Example: `export default withSentryConfig(nextConfig, ...)` in `apps/web/next.config.mjs`

**Barrel Files:**

- `packages/shared/src/index.js` re-exports the public API
- Internal helpers remain unexported from the barrel; import them from specific files when needed
- Example:
  ```js
  export { json, timingSafeCompare, ... } from './utils.js';
  export { applyUpstashRateLimit } from './rate-limit.js';
  ```

**Environment Configuration:**

- Environment variables are read via `process.env` and validated close to usage
- `.env.example`, `.env.development.example`, `.env.production.example` document required variables
- Helper `scripts/lib-env.mjs` provides `parseDotEnv` and `readMergedDotEnvFiles` for merging env files in scripts

---

_Convention analysis: 2026-07-04_
_Update when patterns change_
