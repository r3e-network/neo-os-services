// GENERATED from neo-os-minigames/apps/jump-rush/src/logic/jump-engine.ts by scripts/sync-miniapp-game-engines.mjs — DO NOT EDIT.
// Source sha256: f8a792cf1dddf6b5854c6fede1656e2fd04219648147fa9822ef7b526fe1dc43. After a reviewed upstream change, re-run this sync and the parity goldens.
// apps/jump-rush/src/logic/jump-engine.ts
function hexToBytes(hex) {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error(`invalid hex seed: ${hex}`);
  }
  if (clean.length !== 64) {
    throw new Error("seed must be 32 bytes");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
function streamOf(seed) {
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  let cursor = 0;
  return {
    next: () => {
      const byte = seed[cursor % 32] ?? 0;
      cursor += 1;
      return byte;
    }
  };
}
function generatePlatforms(seed, difficulty) {
  const stream = streamOf(seed);
  const configs = {
    0: { minWidth: 100, maxWidth: 140, minGap: 60, maxGap: 120, count: 15 },
    // Easy: wide, short gaps
    1: { minWidth: 85, maxWidth: 115, minGap: 100, maxGap: 180, count: 25 },
    // Medium
    2: { minWidth: 70, maxWidth: 100, minGap: 140, maxGap: 260, count: 35 }
    // Hard: narrow, long gaps
  };
  const fallbackConfig = configs[0];
  const config = configs[difficulty] ?? fallbackConfig;
  const platforms = [];
  platforms.push({ x: 60, width: 120, gap: 0 });
  for (let i = 1; i <= config.count; i += 1) {
    const widthRange = config.maxWidth - config.minWidth;
    const gapRange = config.maxGap - config.minGap;
    const width = config.minWidth + stream.next() % (widthRange + 1);
    const gap = config.minGap + stream.next() % (gapRange + 1);
    const prev = platforms[platforms.length - 1];
    if (!prev) continue;
    const x = prev.x + prev.width + gap;
    platforms.push({ x, width, gap });
  }
  return platforms;
}
function powerForGap(gap) {
  const raw = Math.sqrt(Math.max(0, gap) / 50) * 100;
  return Math.min(1e3, Math.round(raw));
}
function landingOffset(chargeMs, gap) {
  const ideal = powerForGap(gap);
  const jumpDistance = chargeMs / Math.max(1, ideal) * gap;
  return jumpDistance - gap;
}
function isPerfectLanding(offset, platformWidth) {
  const centerStart = platformWidth * 0.35;
  const centerEnd = platformWidth * 0.65;
  return offset >= centerStart && offset <= centerEnd;
}
function evaluateJumpLevel(chargeLevel, gap, platformWidth) {
  const safeGap = Math.max(0, Number(gap) || 0);
  const safeWidth = Math.max(1, Number(platformWidth) || 1);
  const validCharge = Number.isFinite(chargeLevel) && chargeLevel >= 0 && chargeLevel <= 100;
  const landingOffset2 = validCharge ? chargeLevel / 100 * (safeGap + safeWidth) - safeGap : Number.NaN;
  const landed = validCharge && landingOffset2 >= 0 && landingOffset2 <= safeWidth;
  return {
    landingOffset: landingOffset2,
    landed,
    perfect: landed && isPerfectLanding(landingOffset2, safeWidth),
    idealCharge: Math.min(100, Math.max(0, 50 + safeGap / 4))
  };
}
function jumpScore(perfect, combo) {
  const base = 1;
  const perfectBonus = perfect ? 1 : 0;
  const comboMultiplier = 1 + (combo > 0 ? combo * 0.5 : 0);
  return Math.round((base + perfectBonus) * comboMultiplier);
}
export {
  evaluateJumpLevel,
  generatePlatforms,
  hexToBytes,
  isPerfectLanding,
  jumpScore,
  landingOffset,
  powerForGap
};
