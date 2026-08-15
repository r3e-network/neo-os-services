// Engine parity goldens — the behavioral safety net of the miniapp game-engine
// single-source pipeline. Re-runs every engine's scripted vectors through its
// PRODUCTION wrapper ABI and asserts the live tree reproduces the frozen
// goldens (engine-parity.goldens.json) exactly: initial-state hashes, per-op
// state/view hashes, replay hashes and canonical score outcomes.
//
// The goldens were captured from the reviewed hand ports BEFORE any engine was
// swapped to its generated TS twin (scripts/capture-miniapp-engine-goldens.mjs).
// A regeneration that changes behavior, a hand edit to a generated file, or an
// upstream rule change mirrored into the TS twin flips a hash here and names
// the engine/vector/op that moved. When a rule change is REVIEWED, re-capture
// the goldens in the same commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadWrappers, runAllVectors } from './parity-vectors.mjs';

const goldens = JSON.parse(
  fs.readFileSync(new URL('./engine-parity.goldens.json', import.meta.url), 'utf8')
);

const wrappers = await loadWrappers();
const results = runAllVectors(wrappers);

for (const [appId, expected] of Object.entries(goldens.engines)) {
  test(`${appId} reproduces its parity goldens`, () => {
    assert.ok(results[appId], `engine ${appId} did not run`);
    // deepStrictEqual pinpoints the first differing field/op in the failure diff.
    assert.deepStrictEqual(results[appId], expected);
  });
}

test('every live engine has goldens recorded', () => {
  assert.deepStrictEqual(Object.keys(results).sort(), Object.keys(goldens.engines).sort());
});
