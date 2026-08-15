// Registry + hash-whitelist gating. The generic host resolves engines by
// (appId, engineHash) from an operator-approved manifest; these tests pin the
// gating behaviour:
//   - every wrapper's live source hash matches its pinned manifest entry
//     (fail-closed: an un-reviewed edit would break this),
//   - the manifest exposes the appId -> engineHash table for cross-pinning,
//   - resolveEngineByHash rejects an unknown appId, an unknown/mismatched hash,
//     and accepts an omitted hash (host derives it) or the correct hash,
//   - a strict build with a tampered manifest entry throws at load (a swapped or
//     tampered engine cannot be served).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ENGINE_MANIFEST,
  engineHashOfFile,
  isRegisteredApp,
  registeredAppIds,
  registryManifest,
  resolveEngine,
  resolveEngineByHash,
  __rebuildRegistryForTests,
} from './registry.js';

test.beforeEach(() => {
  __rebuildRegistryForTests({ strict: false });
});
test.afterEach(() => {
  // Restore a clean, self-consistent registry after any tampered-manifest test.
  __rebuildRegistryForTests({ strict: false });
});

const WRAPPER_FILES = {
  'miniapp-sudoku': 'sudoku.wrapper.js',
  'miniapp-game-2048': 'game2048.wrapper.js',
  'miniapp-flappy-dash': 'flappy.wrapper.js',
  'miniapp-snake-bounty': 'snake.wrapper.js',
  'miniapp-aim-master': 'aim.wrapper.js',
  'miniapp-color-clash': 'color.wrapper.js',
  'miniapp-merge-kingdom': 'merge.wrapper.js',
  'miniapp-pet-potion': 'pet.wrapper.js',
  'miniapp-sheep-solitaire': 'sheep.wrapper.js',
  'miniapp-jump-rush': 'jump.wrapper.js',
  'miniapp-curve-arrow': 'arrow.wrapper.js',
};

test('manifest pins the sha256 of each wrapper source exactly', () => {
  for (const [appId, file] of Object.entries(WRAPPER_FILES)) {
    const path = fileURLToPath(new URL(`./wrappers/${file}`, import.meta.url));
    const expected = createHash('sha256').update(readFileSync(path)).digest('hex');
    assert.equal(engineHashOfFile(file), expected, `${appId} engineHashOfFile drift`);
    assert.equal(ENGINE_MANIFEST[appId], expected, `${appId} manifest hash out of date`);
  }
});

test('registryManifest returns the appId -> engineHash whitelist for every registered game', () => {
  const manifest = registryManifest();
  assert.equal(Object.keys(manifest).length, Object.keys(WRAPPER_FILES).length);
  for (const appId of Object.keys(WRAPPER_FILES)) {
    assert.match(manifest[appId], /^[0-9a-f]{64}$/, `${appId} hash shape`);
    assert.equal(manifest[appId], ENGINE_MANIFEST[appId]);
  }
});

test('registeredAppIds / isRegisteredApp cover exactly the whitelisted games', () => {
  const ids = registeredAppIds().sort();
  assert.deepEqual(ids, Object.keys(WRAPPER_FILES).sort());
  assert.equal(isRegisteredApp('miniapp-sudoku'), true);
  assert.equal(isRegisteredApp('miniapp-not-a-game'), false);
});

test('resolveEngineByHash: correct hash resolves, omitted hash is host-derived', () => {
  const manifest = registryManifest();
  const engine = resolveEngineByHash('miniapp-snake-bounty', manifest['miniapp-snake-bounty']);
  assert.equal(engine.appId, 'miniapp-snake-bounty');
  assert.equal(engine.engineHash, manifest['miniapp-snake-bounty']);

  // An omitted engine_hash is allowed (the host derives it from the manifest).
  const derived = resolveEngineByHash('miniapp-snake-bounty', '');
  assert.equal(derived.engineHash, manifest['miniapp-snake-bounty']);

  // Case-insensitive supplied hash.
  const upper = resolveEngineByHash(
    'miniapp-snake-bounty',
    manifest['miniapp-snake-bounty'].toUpperCase()
  );
  assert.equal(upper.engineHash, manifest['miniapp-snake-bounty']);
});

test('resolveEngineByHash: an unknown appId is rejected', () => {
  assert.throws(() => resolveEngineByHash('miniapp-not-a-game', ''), /no engine registered/);
});

test('resolveEngineByHash: a mismatched engine_hash is rejected (whitelist gate)', () => {
  assert.throws(
    () => resolveEngineByHash('miniapp-sudoku', 'f'.repeat(64)),
    /engine_hash mismatch/
  );
});

test('resolveEngine returns a frozen engine exposing the full ABI', () => {
  const engine = resolveEngine('miniapp-aim-master');
  assert.ok(Object.isFrozen(engine));
  for (const fn of ['deal', 'applyOp', 'applyUndo', 'replay', 'score']) {
    assert.equal(typeof engine[fn], 'function');
  }
  assert.ok(engine.descriptor);
});

test('strict build with the real manifest succeeds (fail-open only when correct)', () => {
  assert.doesNotThrow(() => __rebuildRegistryForTests({ strict: true }));
});

test('a tampered manifest entry fails the build closed (swapped engine rejected)', () => {
  // Inject a manifest whose sudoku hash is wrong — the load MUST throw so a
  // tampered or swapped engine can never be served under a stale/forged hash.
  const tampered = { ...registryManifest(), 'miniapp-sudoku': 'a'.repeat(64) };
  assert.throws(
    () => __rebuildRegistryForTests({ strict: true, manifestOverride: tampered }),
    /does not match pinned/
  );
});

test('a manifest missing an engine fails the strict build closed', () => {
  const incomplete = { ...registryManifest() };
  delete incomplete['miniapp-pet-potion'];
  assert.throws(
    () => __rebuildRegistryForTests({ strict: true, manifestOverride: incomplete }),
    /no pinned hash/
  );
});
