// Jump Rush engine — HANDWRITTEN adapter over the GENERATED rule core in
// engines/jump.js (bundled from neo-os-minigames jump-engine.ts by
// scripts/sync-miniapp-game-engines.mjs — never edit that file).
//
// The shared rules (deterministic platform generation, jump landing/perfect
// evaluation, ideal charge) come from the generated core. The enclave's
// hex-or-bytes secret normalization, the per-platform evaluation shape and the
// op-log replay stay here. This module preserves the historical
// engines/jump.js export surface.
import { generatePlatforms as generatePlatformsFromSeed, evaluateJumpLevel } from './jump.js';

// Normalize the problem secret to a 32-byte Uint8Array. Accepts the host's
// raw bytes form (Uint8Array/Buffer of exactly 32 bytes) or the legacy
// 64-char hex string form. Both forms yield identical byte streams.
function toSeedBytes(secret) {
  if (secret instanceof Uint8Array) {
    if (secret.length !== 32) throw new Error('seed must be exactly 32 bytes (64 hex chars)');
    return new Uint8Array(secret.buffer, secret.byteOffset, 32);
  }
  const clean = String(secret).trim().toLowerCase().replace(/^0x/, '');
  if (clean.length !== 64) throw new Error('seed must be exactly 32 bytes (64 hex chars)');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Generate deterministic platform layout from a problem secret
 * (32-byte Uint8Array/Buffer, or legacy 64-char hex string).
 * Returns array of { x, width, gap } — the generated core's layout.
 */
export function generatePlatforms(problemSecret, difficulty) {
  return generatePlatformsFromSeed(toSeedBytes(problemSecret), difficulty);
}

/**
 * Determine how many platforms exist for a given difficulty. Derived from the
 * generated generator (the count is seed-independent) so the difficulty table
 * stays single-source upstream.
 */
export function platformCount(difficulty) {
  return generatePlatformsFromSeed(new Uint8Array(32), difficulty).length;
}

/**
 * Evaluate a single jump: chargeLevel (0–100) maps to jump distance. The
 * landing decision (landed / centre-30% perfect / ideal charge) comes from the
 * generated evaluateJumpLevel; the returned shape matches the historical
 * engine surface ({ ok, perfect, landingX, idealCharge, chargeError }).
 */
export function evaluateJump(platforms, platformIndex, chargeLevel) {
  const from = platforms[platformIndex];
  const to = platforms[platformIndex + 1];
  if (!from || !to) return { ok: false, perfect: false, reason: 'no next platform' };

  const evaluation = evaluateJumpLevel(chargeLevel, to.gap, to.width);
  // Historical landingX formula (identical arithmetic to the old port).
  const landingX = from.x + from.width + (chargeLevel / 100) * (to.gap + to.width);

  return {
    ok: evaluation.landed,
    perfect: evaluation.perfect,
    landingX,
    idealCharge: evaluation.idealCharge,
    chargeError: Math.abs(chargeLevel - evaluation.idealCharge),
  };
}

/**
 * Full deterministic replay from problemSecret + op log.
 * Returns { platformIndex, jumps, perfects, failed, completed }.
 */
export function replayJump(problemSecret, difficulty, opLog) {
  const platforms = generatePlatforms(problemSecret, difficulty);
  let platformIndex = 0;
  let jumps = 0;
  let perfects = 0;
  let failed = false;

  for (let i = 0; i < opLog.length; i++) {
    const op = opLog[i];
    const type = typeof op?.type === 'string' ? op.type.trim() : '';
    if (type !== 'jump') throw new Error(`unknown op type '${type}' at index ${i}`);

    const chargeLevel = Number(op.chargeLevel);
    if (!Number.isFinite(chargeLevel) || chargeLevel < 0 || chargeLevel > 100) {
      throw new Error(`invalid chargeLevel at index ${i}`);
    }

    const result = evaluateJump(platforms, platformIndex, chargeLevel);
    jumps++;
    if (!result.ok) {
      failed = true;
      break;
    }
    if (result.perfect) perfects++;
    platformIndex++;
    if (platformIndex >= platforms.length - 1) break;
  }

  const completed = !failed && platformIndex >= platforms.length - 1;
  return { platformIndex, jumps, perfects, failed, completed, totalPlatforms: platforms.length };
}
