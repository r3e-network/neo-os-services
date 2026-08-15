---
wave: 1
depends_on: []
files_modified: []
autonomous: true
---

# Plan 03-03: Fix Nitro crypto.js Empty Catch

## Goal

Fix the silent empty catch in `workers/nitro-worker/src/oracle/crypto.js` so that key-store read errors are not swallowed. Distinguish between expected missing files (ENOENT) and real errors (JSON parse failures, permission errors, etc.).

## Context

- Lines 228-238 of `workers/nitro-worker/src/oracle/crypto.js` use an empty `catch {}` when reading the encrypted key store.
- This means a corrupted key file, permission error, or malformed JSON will silently return `undefined` or an empty object, making failures impossible to debug and potentially leading to key-derived operations using stale/empty keys.

## Tasks

<task id="1" name="Inspect current crypto.js key-store reads">
Read `workers/nitro-worker/src/oracle/crypto.js` around the encrypted key store loading logic. Identify:
- The exact `try { ... } catch {}` block.
- Which callers depend on the function returning `undefined` vs. a valid object.
- Whether a missing file is a normal cold-start path or an error path.

<verify>
- Document the exact file paths and line numbers.
- Confirm whether missing file is expected during initialization.
</verify>
</task>

<task id="2" name="Implement discriminated error handling">
Update the catch block to:
- Re-throw any error that is NOT `ENOENT` (or platform equivalent) or a `SyntaxError` from JSON parsing.
- For `ENOENT` only, return `undefined` or a sentinel value indicating the store is missing (preserving cold-start behavior).
- For JSON `SyntaxError` or other read errors, throw a descriptive error including the file path and error type.
- Add a FOOTGUN comment explaining why ENOENT is allowed and other errors are not.

<verify>
- New behavior is covered by unit tests:
  - Missing file returns `undefined`.
  - Corrupted JSON file throws.
  - Permission error throws (if testable on current platform, otherwise mocked).
</verify>
</task>

<task id="3" name="Update callers and tests">
Check callers of the affected function to ensure they handle the new thrown errors gracefully. Update existing tests if any relied on the silent swallow behavior for non-ENOENT cases.

<verify>
- `npm --prefix workers/nitro-worker test` passes.
- No caller crashes on the newly-thrown errors.
</verify>
</task>

## must_haves

- [ ] `crypto.js` empty catch is removed.
- [ ] ENOENT is handled explicitly and returns a safe sentinel value.
- [ ] Non-ENOENT errors (JSON parse, permission, etc.) are thrown.
- [ ] Unit tests cover missing file, corrupt JSON, and non-ENOENT errors.
- [ ] All nitro-worker tests pass.
