// Architectural guard: the generic session host must contain ZERO per-game code.
// It must not reference any concrete game appId string literal, must not import
// any named engine, and must not branch on an appId — the whole point of the
// generic oracle is that each game is DATA (an engine loaded by hash), never an
// `if appId === X` branch in the host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registeredAppIds } from './registry.js';

const HOST_PATH = fileURLToPath(new URL('./session.js', import.meta.url));
const HOST_SRC = readFileSync(HOST_PATH, 'utf8');

test('the generic host references NO concrete game appId literal', () => {
  for (const appId of registeredAppIds()) {
    assert.equal(
      HOST_SRC.includes(appId),
      false,
      `session.js must not hardcode the game appId "${appId}" — games are DATA, not host branches`
    );
    // Also reject the un-prefixed slug (e.g. "sudoku", "flappy") appearing as a
    // per-game identifier in the host.
    const slug = appId.replace(/^miniapp-/, '');
    assert.equal(
      new RegExp(`\\b${slug.replace(/-/g, '[-_]?')}\\b`, 'i').test(HOST_SRC),
      false,
      `session.js must not reference the "${slug}" game by name`
    );
  }
});

test('the generic host imports NO named engine or wrapper module', () => {
  // Only the registry (+ abi) may be imported from the game layer; never a
  // concrete engine or wrapper.
  assert.equal(
    /from ['"]\.\/engines\//.test(HOST_SRC),
    false,
    'host must not import an engine core'
  );
  assert.equal(/from ['"]\.\/wrappers\//.test(HOST_SRC), false, 'host must not import a wrapper');
});

test('the generic host contains NO appId equality branch', () => {
  // Reject the classic anti-pattern the migration removes.
  assert.equal(
    /appId\s*===\s*['"]/.test(HOST_SRC),
    false,
    'host must not branch on `appId === "..."`'
  );
  // And the legacy APP_* constant family must be gone.
  assert.equal(/\bAPP_[A-Z0-9]+\b/.test(HOST_SRC), false, 'host must not define APP_* constants');
  assert.equal(/GAME_APP_IDS/.test(HOST_SRC), false, 'host must not enumerate a game-id set');
  assert.equal(/GAME_LIMITS/.test(HOST_SRC), false, 'host must not hardcode per-game limits');
});
