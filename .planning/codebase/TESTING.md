# Testing Patterns

**Analysis Date:** 2026-07-04

## Test Framework

**Runners by subsystem:**

| Subsystem                  | Runner                    | Assertion Library                   | Config                                                          |
| -------------------------- | ------------------------- | ----------------------------------- | --------------------------------------------------------------- |
| `apps/web`                 | Vitest `^4.1.4`           | Vitest built-in `expect`            | Default config, no `vitest.config.*` file                       |
| `workers/nitro-worker`     | Node.js built-in `--test` | `node:assert/strict`                | `package.json` `test` script                                    |
| `workers/morpheus-relayer` | Node.js built-in `--test` | `node:assert/strict`                | `package.json` `test` script                                    |
| `packages/shared`          | Node.js built-in `--test` | `node:assert/strict`                | `package.json` `test` script                                    |
| `scripts/`                 | Node.js built-in `--test` | `node:assert/strict`                | Invoked via `npm run test:scripts`                              |
| `deploy/`                  | Node.js built-in `--test` | `node:assert/strict`                | Invoked via `npm run test:ops` and `npm run test:control-plane` |
| `contracts/`               | xUnit via `dotnet test`   | `Xunit.Assert`                      | `contracts/__tests__/NeoContracts.Tests.csproj`                 |
| `contracts-evm/`           | Foundry                   | Solidity `assert*` + custom helpers | `contracts-evm/foundry.toml`                                    |

**Run Commands:**

```bash
# Web (Vitest)
npm --prefix apps/web test              # watch mode
npm --prefix apps/web run test:run      # CI single run

# Workers / shared / scripts (Node --test)
npm --prefix packages/shared test
npm --prefix workers/nitro-worker test
npm --prefix workers/morpheus-relayer test
npm run test:scripts                    # scripts/*.test.mjs
npm run test:ops                        # deploy/feed-pusher, deploy/nitro, deploy/evm tests
npm run test:control-plane              # deploy/cloudflare/morpheus-control-plane/worker.test.mjs

# Contracts
bash contracts/build.sh                 # compile Neo contracts first
dotnet test contracts/__tests__/NeoContracts.Tests.csproj
forge test                              # EVM contracts (Foundry)
```

## Test File Organization

**Location:**

- `apps/web`: tests live in `apps/web/__tests__/` or alongside source in `apps/web/lib/`
  - Example: `apps/web/__tests__/server-supabase.test.ts`, `apps/web/lib/nep21.test.ts`
- `workers/*`: `*.test.mjs` collocated next to source
  - Example: `workers/nitro-worker/src/platform/circuit-breaker.test.mjs`
- `packages/shared`: `*.test.mjs` collocated in `packages/shared/src/`
  - Example: `packages/shared/src/workflow-catalog.test.mjs`
- `scripts/`: `*.test.mjs` collocated in `scripts/`
  - Example: `scripts/contract-build-regressions.test.mjs`
- `deploy/`: `*.test.mjs` collocated in deploy subdirectories
  - Example: `deploy/nitro/nitro-signer-server.test.mjs`
- `contracts/`: C# tests in `contracts/__tests__/`
  - Example: `contracts/__tests__/MorpheusOracleTest.cs`
- `contracts-evm/`: Foundry tests in `contracts-evm/test/`
  - Example: `contracts-evm/test/MorpheusOracleEVM.t.sol`

**Naming:**

- Unit/regression tests: `*.test.ts`, `*.test.tsx`, `*.test.mjs`, `*.test.cs`
- Shared-worker isolation tests: `*.shared-worker.test.mjs`
- C# test classes: `*Test.cs` or `*Tests.cs`
- Foundry tests: `*.t.sol`

**Structure:**

```
apps/web/
  __tests__/
    server-supabase.test.ts
  lib/
    nep21.test.ts
workers/nitro-worker/src/
  platform/
    circuit-breaker.js
    circuit-breaker.test.mjs
  oracle/
    aggregation.test.mjs
packages/shared/src/
  index.js
  stable-stringify.test.mjs
scripts/
  lib-env.mjs
  lib-env.test.mjs
contracts/
  MorpheusOracle/
    MorpheusOracle.cs
  __tests__/
    MorpheusOracleTest.cs
contracts-evm/
  MorpheusOracleEVM.sol
  test/
    MorpheusOracleEVM.t.sol
```

## Test Structure

**Vitest (`apps/web`):**

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('server supabase lookup caches', () => {
  beforeEach(() => {
    __resetServerSupabaseCachesForTests();
  });

  it('caches project id lookups', async () => {
    // arrange
    const { client, counts } = createFakeSupabase();

    // act
    await resolveProjectIdBySlug(client, 'demo');
    await resolveProjectIdBySlug(client, 'demo');

    // assert
    expect(counts.projectLookups).toBe(1);
  });
});
```

Source: `apps/web/__tests__/server-supabase.test.ts`

**Node.js built-in test runner:**

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from './circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('starts closed with zero failures', () => {
    const cb = new CircuitBreaker('test');
    assert.equal(cb.getState().state, 'closed');
    assert.equal(cb.getState().failures, 0);
    assert.ok(cb.allow());
  });
});
```

Source: `workers/nitro-worker/src/platform/circuit-breaker.test.mjs`

**C# xUnit:**

```csharp
using Xunit;

namespace MorpheusOracle.Contracts.Tests
{
    public class MorpheusDataFeedTest
    {
        [Fact]
        public void MorpheusDataFeedExposesExpectedApi()
        {
            string code = ContractSourceAssertions.ReadSource(
                "contracts", "MorpheusDataFeed", "MorpheusDataFeed.cs");

            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "UpdateFeed");
            Assert.Contains("FeedUpdated", code);
        }
    }
}
```

Source: `contracts/__tests__/MorpheusDataFeedTest.cs`

**Foundry Solidity:**

```solidity
contract MorpheusOracleEVMTest is TestBase {
    MorpheusOracleEVM oracle;

    function setUp() public {
        verifier = vm.addr(VERIFIER_KEY);
        oracle = new MorpheusOracleEVM(updater, verifier);
        oracle.registerModule(MODULE);
    }

    function test_callbackUniqueness_rejectsHijack() public {
        address cb = address(0xCB);
        _registerApp("appA", address(this), cb);

        vm.expectRevert(MorpheusOracleEVM.CallbackAlreadyRegistered.selector);
        oracle.registerMiniApp("appB", address(this), cb);
    }
}
```

Source: `contracts-evm/test/MorpheusOracleEVM.t.sol`

**Patterns:**

- Use `beforeEach` / `afterEach` for per-test isolation; avoid shared mutable state
- Restore environment variables in `afterEach` or `test.afterEach`
- Name tests with snake_case descriptive sentences: `test_callbackUniqueness_rejectsHijack`, `starts closed with zero failures`
- C# source-assertion tests verify public API surface by parsing source rather than executing compiled contracts

## Mocking

**Framework:**

- Vitest: built-in `vi` mocks (used sparingly in web tests)
- Node.js tests: manual object factories and `child_process` spawning; no external mock library
- C# tests: source-code regex assertions; no runtime mocking of Neo contracts
- Foundry: native cheatcodes (`vm.addr`, `vm.deal`, `vm.expectRevert`) via `TestBase.sol`

**Patterns:**

Manual dependency factory in web tests:

```typescript
function createFakeSupabase({ projectId = 'project-1' } = {}) {
  return {
    client: {
      from(table: string) {
        return buildQuery(table);
      },
    },
  };
}
```

Source: `apps/web/__tests__/server-supabase.test.ts`

Spawn external process for black-box tests:

```javascript
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, [SERVER, '--stdio'], {
  env: { ...process.env, NITRO_SIGNER_TOKEN: TOKEN },
});
```

Source: `deploy/nitro/nitro-signer-server.test.mjs`

Isolate module state with a unique import query:

```javascript
const { relayNeoN3Invocation } = await import(`./neo-n3.js?shared-worker=${Date.now()}`);
```

Source: `workers/nitro-worker/src/chain/neo-n3.shared-worker.test.mjs`

Environment restoration:

```javascript
const ORIGINALS = { CONTRACT_MORPHEUS_ORACLE_HASH: process.env.CONTRACT_MORPHEUS_ORACLE_HASH, ... };
test.afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINALS)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
```

Source: `workers/nitro-worker/src/chain/neo-n3.shared-worker.test.mjs`

**What to Mock:**

- External HTTP clients (manual Supabase client facades)
- `child_process` executions in regression tests
- Environment variables for network-specific config
- Time-dependent behavior by manipulating object fields (e.g., `cb.lastFailureAt = 0`)

**What NOT to Mock:**

- Pure utility functions (stable-stringify, env parsers)
- Internal business logic unless required for isolation

## Fixtures and Factories

**Test Data:**

- Factory functions defined inline in test files
  - Example: `createFakeSupabase({ projectId, providerConfig })` in `apps/web/__tests__/server-supabase.test.ts`
- Hard-coded fixtures for contract addresses and keys
  - Example: `const VERIFIER_KEY = 0xA11CE;` in `contracts-evm/test/MorpheusOracleEVM.t.sol`
- No shared `tests/fixtures/` directory; each test owns its data

## Coverage

**Requirements:**

- No enforced coverage target
- Coverage directory is gitignored (`coverage/`)
- CI runs all suites but does not gate on coverage percentage

**Run coverage (Vitest only):**

```bash
npm --prefix apps/web run test:run -- --coverage
```

## Test Types

**Unit Tests:**

- Test a single module in isolation
- Examples:
  - `workers/nitro-worker/src/platform/circuit-breaker.test.mjs`
  - `packages/shared/src/stable-stringify.test.mjs`
  - `scripts/lib-env.test.mjs`

**Source-Assertion / API Contract Tests:**

- C# tests in `contracts/__tests__/` parse source to verify public methods, events, and storage comments
- Example: `contracts/__tests__/MorpheusOracleTest.cs` asserts the MiniApp kernel API surface

**Build Regression Tests:**

- `scripts/contract-build-regressions.test.mjs` runs `contracts/build.sh` and verifies no hidden compiler errors
- `scripts/dependency-audit-regressions.test.mjs` and `scripts/example-contract-artifacts.test.mjs` guard build artifacts

**Integration / Black-Box Tests:**

- `deploy/nitro/nitro-signer-server.test.mjs` spawns the signer server and sends raw HTTP over stdio
- `apps/web/__tests__/control-plane.test.ts` tests Next.js route handlers with mocked Supabase

**Foundry Contract Tests:**

- `contracts-evm/test/MorpheusOracleEVM.t.sol` tests EVM contract behavior locally with cheatcodes
- No fork tests detected in the current test tree

## Common Patterns

**Async Testing:**

```javascript
it('handles async operation', async () => {
  const result = await asyncFunction();
  assert.equal(result.status, 200);
});
```

**Error Testing:**

```javascript
assert.throws(() => functionCall(), /error message/);
await assert.rejects(asyncCall(), /error message/);
```

```solidity
vm.expectRevert(MorpheusOracleEVM.CallbackAlreadyRegistered.selector);
oracle.registerMiniApp("appB", address(this), cb);
```

**State Reset:**

- Expose `__reset*ForTests` helpers for module-level caches
  - Example: `__resetServerSupabaseCachesForTests()` in `apps/web/lib/server-supabase.ts`

**Skipping Tests:**

- Node test runner supports `t.skip('reason')` when external tooling is unavailable
  - Example: `scripts/contract-build-regressions.test.mjs` skips when `nccs` or `dotnet` is missing

**Snapshot Testing:**

- Not used in this codebase
- Prefer explicit assertions and golden files where deterministic output must be verified

---

_Testing analysis: 2026-07-04_
_Update when test patterns change_
