// GENERATED from neo-os-minigames/apps/pet-potion/src/logic/pet-engine.ts by scripts/sync-miniapp-game-engines.mjs — DO NOT EDIT.
// Source sha256: a2f79f18782e0cee5339c09cf29f8f51e545e293433724037cb76eb502b5749d. After a reviewed upstream change, re-run this sync and the parity goldens.
// apps/pet-potion/src/logic/pet-engine.ts
var ACTIONS = ["feed", "play", "pet", "rest"];
var ACTION_INDEX = {
  feed: 0,
  play: 1,
  pet: 2,
  rest: 3
};
var MIN_ACTION_GAP_MS = 1500;
var START = { happiness: 20, hunger: 40, energy: 60 };
function clamp(value) {
  return Math.max(0, Math.min(100, value));
}
function newPet() {
  return { ...START };
}
function stageOf(happiness) {
  if (happiness >= 60) return 2;
  if (happiness >= 30) return 1;
  return 0;
}
function stepPet(state, action) {
  const name = typeof action === "number" ? ACTIONS[action] : action;
  const next = { ...state };
  switch (name) {
    case "feed": {
      const hungerGap = 100 - next.hunger;
      next.happiness = clamp(next.happiness + Math.min(8, Math.round(hungerGap / 8)));
      next.hunger = clamp(next.hunger + 30);
      break;
    }
    case "play": {
      const canPlay = Math.min(next.hunger, next.energy);
      const gain = canPlay >= 20 ? 12 : Math.round(canPlay / 4);
      next.happiness = clamp(next.happiness + gain);
      next.hunger = clamp(next.hunger - 20);
      next.energy = clamp(next.energy - 20);
      break;
    }
    case "pet":
      next.happiness = clamp(next.happiness + 4);
      next.energy = clamp(next.energy - 3);
      break;
    case "rest":
      next.energy = clamp(next.energy + 30);
      next.happiness = clamp(next.happiness + 2);
      next.hunger = clamp(next.hunger - 10);
      break;
    default:
      throw new Error("unknown pet action");
  }
  return next;
}
function replayPet(actions) {
  let state = newPet();
  let peak = state.happiness;
  for (const action of actions) {
    state = stepPet(state, action);
    peak = Math.max(peak, state.happiness);
  }
  return { happiness: state.happiness, peak, state };
}
function petAnswer(peak, actions) {
  const encoded = actions.map((action) => typeof action === "number" ? action : ACTION_INDEX[action]).join("");
  return `pet:${peak}:${encoded}`;
}
export {
  ACTIONS,
  ACTION_INDEX,
  MIN_ACTION_GAP_MS,
  newPet,
  petAnswer,
  replayPet,
  stageOf,
  stepPet
};
