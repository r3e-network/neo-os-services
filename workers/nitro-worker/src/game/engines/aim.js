// GENERATED from neo-os-minigames/apps/aim-master/src/logic/tee-engine-v1.ts by scripts/sync-miniapp-game-engines.mjs — DO NOT EDIT.
// Source sha256: 6c347d621973ad5fe03c31c48a23e920a93beb8998aa55ca7db4b8d091d0ceef. After a reviewed upstream change, re-run this sync and the parity goldens.
// apps/aim-master/src/logic/tee-engine-v1.ts
var RING_POINTS = [10, 8, 6, 4, 2, 0];
var AIM_CONFIG = {
  width: 300,
  centre: 150,
  bullseyeRadius: 6,
  ringWidth: 24,
  maxSpeed: 6,
  tickMs: 16
};
var ACCURACY_RING = 2;
var PATTERN_TICKS = Math.ceil(5e3 / AIM_CONFIG.tickMs);
function generatePattern(problemSecret) {
  if (!(problemSecret instanceof Uint8Array) || problemSecret.length !== 32) {
    throw new Error("problemSecret must be 32 bytes");
  }
  let hash = 0;
  for (let index = 0; index < problemSecret.length; index += 1) {
    hash = (hash << 5) - hash + problemSecret[index] | 0;
  }
  let rngState = Math.abs(hash);
  const pseudoRand = () => {
    rngState = rngState * 1103515245 + 12345 & 2147483647;
    return rngState / 2147483647;
  };
  const positions = [];
  let position = AIM_CONFIG.centre;
  let direction = pseudoRand() < 0.5 ? 1 : -1;
  let speed = 1;
  let ticksUntilChange = 0;
  for (let tick = 0; tick < PATTERN_TICKS; tick += 1) {
    positions.push(position);
    if (ticksUntilChange <= 0) {
      direction = pseudoRand() < 0.5 ? 1 : -1;
      speed = 1 + Math.floor(pseudoRand() * (AIM_CONFIG.maxSpeed - 1));
      ticksUntilChange = 10 + Math.floor(pseudoRand() * 40);
    }
    ticksUntilChange -= 1;
    position += direction * speed;
    if (position < 0) {
      position = 0;
      direction = 1;
    } else if (position > AIM_CONFIG.width) {
      position = AIM_CONFIG.width;
      direction = -1;
    }
  }
  return positions;
}
function patternView(problemSecret) {
  return generatePattern(problemSecret).join(",");
}
function ringOf(stopPosition) {
  const offset = stopPosition - AIM_CONFIG.centre;
  const absoluteDistance = Math.abs(offset);
  if (absoluteDistance <= AIM_CONFIG.bullseyeRadius) return 0;
  return Math.min(
    5,
    Math.floor((absoluteDistance - AIM_CONFIG.bullseyeRadius) / AIM_CONFIG.ringWidth) + 1
  );
}
function isAccuracyHit(ring) {
  return ring <= ACCURACY_RING;
}
function positionAtTick(pattern, tick) {
  if (pattern.length === 0) return AIM_CONFIG.centre;
  const index = tick < 0 ? 0 : tick % pattern.length;
  return pattern[index];
}
function replayAim(pattern, ticks) {
  const rings = [];
  let accuracyHits = 0;
  for (const tick of ticks) {
    const position = positionAtTick(pattern, tick);
    const ring = ringOf(position);
    rings.push(ring);
    if (isAccuracyHit(ring)) accuracyHits += 1;
  }
  return { accuracyHits, rings };
}
function aimAnswer(accuracyHits, rings) {
  return `aim:${accuracyHits}:${rings.join("")}`;
}
export {
  AIM_CONFIG,
  PATTERN_TICKS,
  RING_POINTS,
  aimAnswer,
  generatePattern,
  isAccuracyHit,
  patternView,
  positionAtTick,
  replayAim,
  ringOf
};
