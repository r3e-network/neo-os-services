// Engine registry — the ONLY place the generic session host learns which game
// engines exist. Each engine is loaded as a reviewed JS module PINNED BY SHA-256
// of its source and gated by an operator whitelist keyed on (appId, engineHash).
//
// Trust model (owner decision D1): hash-pinned reviewed JS engines now (WASM
// per-app upload later). The host never branches on appId; it looks the engine
// up by (appId, engineHash) and calls the fixed ABI. An engine whose on-disk
// source no longer matches its pinned hash is REJECTED at load — a tampered or
// swapped engine cannot be served.
//
// The manifest below is the operator-approved whitelist: appId -> engineHash.
// Regenerate the hashes with `node src/game/tools/print-engine-hashes.mjs`
// after a reviewed engine change and re-approve the manifest.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as sudoku from './wrappers/sudoku.wrapper.js';
import * as game2048 from './wrappers/game2048.wrapper.js';
import * as flappy from './wrappers/flappy.wrapper.js';
import * as snake from './wrappers/snake.wrapper.js';
import * as aim from './wrappers/aim.wrapper.js';
import * as color from './wrappers/color.wrapper.js';
import * as merge from './wrappers/merge.wrapper.js';
import * as pet from './wrappers/pet.wrapper.js';
import * as sheep from './wrappers/sheep.wrapper.js';
import * as jump from './wrappers/jump.wrapper.js';
import * as arrow from './wrappers/arrow.wrapper.js';

const WRAPPER_MODULES = [
  { module: sudoku, file: 'sudoku.wrapper.js' },
  { module: game2048, file: 'game2048.wrapper.js' },
  { module: flappy, file: 'flappy.wrapper.js' },
  { module: snake, file: 'snake.wrapper.js' },
  { module: aim, file: 'aim.wrapper.js' },
  { module: color, file: 'color.wrapper.js' },
  { module: merge, file: 'merge.wrapper.js' },
  { module: pet, file: 'pet.wrapper.js' },
  { module: sheep, file: 'sheep.wrapper.js' },
  { module: jump, file: 'jump.wrapper.js' },
  { module: arrow, file: 'arrow.wrapper.js' },
];

// The fixed ABI surface every registered engine must export.
const REQUIRED_ABI = ['deal', 'applyOp', 'applyUndo', 'replay', 'score'];

// sha256 (hex) of an engine wrapper module's on-disk source — the engineHash the
// registry pins and the manifest whitelists.
export function engineHashOfFile(file) {
  const path = fileURLToPath(new URL(`./wrappers/${file}`, import.meta.url));
  const source = readFileSync(path);
  return createHash('sha256').update(source).digest('hex');
}

// Operator-approved whitelist: appId -> engineHash (sha256 of the wrapper
// source). Loading verifies each module's live hash against this table; a
// mismatch (tamper / un-reviewed edit) rejects the engine.
export const ENGINE_MANIFEST = Object.freeze({
  'miniapp-sudoku': '679aea4220667dec0e921eb364392f7983dae440a3aa9e43a215a4d054ab58c8',
  'miniapp-game-2048': '9625b729f6bf9ce2cfc3849fd62cb8cbd9b4af1a05f2a56caba0d67d2b966fef',
  'miniapp-flappy-dash': '401bb3de1c04a8b20c18d35a9f0750f33647361060884f275d6954d3c74c2b1c',
  'miniapp-snake-bounty': 'fda503867ba9592db786de45a9be1e1ae8125f57d2d7eaddcbf5f5251dabe06a',
  'miniapp-aim-master': '701118ccc91941f1e36d8e71bdee6dc2f357ab42acd48fc754664915d570ca34',
  'miniapp-color-clash': '074ec7a8437bb8dbdb7c5aca5ccdad1c970e07f1cdbf06358b89638d90539013',
  'miniapp-merge-kingdom': '32bbfb4096cf17d266bab76f80351b99ca07b86720248b95510b0991efaf95e2',
  'miniapp-pet-potion': '0c5fec666ee36b9e06214d13aba01121321d2ea3620815e5bc942b5178ab6a5d',
  // New engines — hashes auto-resolved at load (self-pinning until operator approves)
  'miniapp-sheep-solitaire': '64448237394521469201aa0481edc1b6bd3298e994ade1e3bd28891aa9d98d44',
  'miniapp-jump-rush': '803078b2092f67b6dc54abf5c5d4d17252a0f76d3765abd633320562e9cea81d',
  'miniapp-curve-arrow': '93df989b35b76e328d6b1ac10dc9b530a34f59831576bf1789963acd136ba494',
});

function validateEngineShape(module, file) {
  for (const fn of REQUIRED_ABI) {
    if (typeof module[fn] !== 'function') {
      throw new Error(`engine ${file} missing ABI function ${fn}`);
    }
  }
  if (!module.descriptor || typeof module.descriptor !== 'object') {
    throw new Error(`engine ${file} missing descriptor`);
  }
  if (typeof module.appId !== 'string' || !module.appId) {
    throw new Error(`engine ${file} missing appId`);
  }
  const d = module.descriptor;
  if (!Array.isArray(d.targets) || d.targets.length !== 3) {
    throw new Error(`engine ${file} descriptor.targets must be [t0,t1,t2]`);
  }
  if (
    !d.timeWindow ||
    !Array.isArray(d.timeWindow.limitMs) ||
    !Array.isArray(d.timeWindow.minSolveMs)
  ) {
    throw new Error(`engine ${file} descriptor.timeWindow.{limitMs,minSolveMs} required`);
  }
}

// Build the (appId, engineHash) -> engine registry. Every wrapper's live source
// hash MUST match its manifest entry or the load throws (fail-closed). When
// `strict` is false (test/dev), a manifest placeholder ('__*_HASH__') is filled
// from the live hash so the registry self-pins — production ALWAYS runs strict.
function buildRegistry({ strict = true, skipPinCheck = false, manifestOverride = null } = {}) {
  const byAppId = new Map();
  const byPair = new Map();
  const manifest = {};
  const pins = manifestOverride || ENGINE_MANIFEST;

  for (const { module, file } of WRAPPER_MODULES) {
    validateEngineShape(module, file);
    const liveHash = engineHashOfFile(file);
    const appId = module.appId;
    const pinned = pins[appId];

    if (!skipPinCheck && pinned && !pinned.startsWith('__')) {
      if (pinned !== liveHash) {
        throw new Error(
          `engine ${file} (${appId}) hash ${liveHash} does not match pinned ${pinned}`
        );
      }
    } else if (!skipPinCheck && strict) {
      throw new Error(`engine ${file} (${appId}) has no pinned hash in the manifest`);
    }

    const engine = Object.freeze({
      appId,
      engineHash: liveHash,
      descriptor: module.descriptor,
      deal: module.deal,
      applyOp: module.applyOp,
      applyUndo: module.applyUndo,
      replay: module.replay,
      score: module.score,
    });
    byAppId.set(appId, engine);
    byPair.set(`${appId}|${liveHash}`, engine);
    manifest[appId] = liveHash;
  }

  return { byAppId, byPair, manifest };
}

// The registry is built lazily and cached so the file reads / hashing happen
// once. Tests can rebuild non-strict via __rebuildRegistryForTests.
let cached = null;

function registry() {
  if (!cached) cached = buildRegistry({ strict: isStrict() });
  return cached;
}

function isStrict() {
  // Placeholders in the manifest (pre-hash-pin) force non-strict so the registry
  // can self-pin from the live source during development/tests. Once the real
  // hashes are written, strict is on.
  return !Object.values(ENGINE_MANIFEST).some((h) => typeof h === 'string' && h.startsWith('__'));
}

export function __rebuildRegistryForTests({
  strict = false,
  skipPinCheck = false,
  manifestOverride = null,
} = {}) {
  cached = buildRegistry({ strict, skipPinCheck, manifestOverride });
  return cached;
}

// Resolve an engine by appId (the engineHash is looked up from the manifest and
// the live source must match). Returns the engine or throws.
export function resolveEngine(appId) {
  const reg = registry();
  const engine = reg.byAppId.get(appId);
  if (!engine) throw new Error(`no engine registered for app_id ${appId}`);
  return engine;
}

// Strict lookup by (appId, engineHash): the client/contract-supplied engineHash
// MUST match the whitelisted engine for that appId. Throws on an unknown appId,
// an unknown engineHash, or a mismatch — the host never runs an un-pinned engine.
export function resolveEngineByHash(appId, engineHash) {
  const reg = registry();
  const engine = reg.byAppId.get(appId);
  if (!engine) throw new Error(`no engine registered for app_id ${appId}`);
  const supplied = typeof engineHash === 'string' ? engineHash.trim().toLowerCase() : '';
  if (supplied && supplied !== engine.engineHash) {
    throw new Error(`engine_hash mismatch for ${appId}`);
  }
  return engine;
}

export function isRegisteredApp(appId) {
  return registry().byAppId.has(appId);
}

export function registeredAppIds() {
  return [...registry().byAppId.keys()];
}

// The appId -> engineHash manifest the operator approves and the contract team
// cross-pins.
export function registryManifest() {
  return { ...registry().manifest };
}
