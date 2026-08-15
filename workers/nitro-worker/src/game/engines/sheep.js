// GENERATED from neo-os-minigames/apps/sheep-solitaire/src/logic/tee-engine-v1.ts by scripts/sync-miniapp-game-engines.mjs — DO NOT EDIT.
// Source sha256: dc864a6531a3213960ed5d6a6a16eb476b6ef8ede158edf0dcc7c98f8bdc7810. After a reviewed upstream change, re-run this sync and the parity goldens.
// apps/sheep-solitaire/src/logic/tee-engine-v1.ts
var CARD_TYPES = 15;
function mulberry32(seed) {
  let state = seed | 0;
  return () => {
    state = state + 1831565813 | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
function shuffle(items, random) {
  const result = items.slice();
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = result[index];
    result[index] = result[swapIndex];
    result[swapIndex] = current;
  }
  return result;
}
function seedFromProblemSecret(problemSecret) {
  const hex = String(problemSecret).replace(/^0x/, "").slice(0, 8);
  return parseInt(hex, 16) >>> 1;
}
function generateLayout(problemSecret, cardTypes) {
  const types = Math.min(Math.max(Number(cardTypes) || 8, 1), CARD_TYPES);
  const random = mulberry32(seedFromProblemSecret(problemSecret));
  const layer0Symbols = [];
  const layer1Symbols = [];
  const layer2Symbols = [];
  for (let symbol = 0; symbol < types; symbol += 1) {
    layer0Symbols.push(symbol);
    layer1Symbols.push(symbol);
    layer2Symbols.push(symbol);
  }
  const shuffledLayer0 = shuffle(layer0Symbols, random);
  const shuffledLayer1 = shuffle(layer1Symbols, random);
  const shuffledLayer2 = shuffle(layer2Symbols, random);
  const configs = [
    { cols: 4, layer: 0 },
    { cols: 5, layer: 1 },
    { cols: 6, layer: 2 }
  ];
  const cards = [];
  let id = 0;
  for (let layerIndex = 2; layerIndex >= 0; layerIndex -= 1) {
    const config = configs[layerIndex];
    const symbols = layerIndex === 2 ? shuffledLayer2 : layerIndex === 1 ? shuffledLayer1 : shuffledLayer0;
    for (let index = 0; index < types && index < symbols.length; index += 1) {
      cards.push({
        id: id++,
        symbol: symbols[index],
        layer: config.layer,
        col: index % config.cols,
        row: Math.floor(index / config.cols)
      });
    }
  }
  return { cards, totalCards: cards.length, cardTypes: types };
}
function computeExposed(cards, pickedIds) {
  const picked = new Set(pickedIds);
  const unpicked = cards.filter((card) => !picked.has(card.id));
  const exposed = new Array(cards.length).fill(false);
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    if (picked.has(card.id)) continue;
    const blocker = unpicked.find((other) => {
      if (other.layer >= card.layer) return false;
      return Math.abs(other.col - card.col) <= 1 && Math.abs(other.row - card.row) <= 1;
    });
    exposed[index] = !blocker;
  }
  return exposed;
}
function buildCardViews(cards, pickedIds) {
  const picked = new Set(pickedIds);
  const exposed = computeExposed(cards, pickedIds);
  return cards.map((card, index) => ({
    id: card.id,
    symbol: card.symbol,
    layer: card.layer,
    exposed: exposed[index],
    picked: picked.has(card.id)
  }));
}
function applyPick(cards, pickedIds, slot, cardId) {
  const card = cards.find((candidate) => candidate.id === cardId);
  if (!card) return { error: "card not found" };
  const exposed = computeExposed(cards, pickedIds);
  const cardIndex = cards.findIndex((candidate) => candidate.id === cardId);
  if (!exposed[cardIndex]) return { error: "card is not exposed" };
  if (pickedIds.includes(cardId)) return { error: "card already picked" };
  const newPickedIds = [...pickedIds, cardId];
  const newSlot = [...slot, cardId];
  const slotWithSymbol = newSlot.map((id) => {
    const matchingCard = cards.find((candidate) => candidate.id === id);
    return { id, symbol: matchingCard ? matchingCard.symbol : -1 };
  });
  const symbolCount = {};
  for (const entry of slotWithSymbol) {
    symbolCount[entry.symbol] = (symbolCount[entry.symbol] || 0) + 1;
  }
  let matched = false;
  let eliminatedSymbol = -1;
  for (const [symbol, count] of Object.entries(symbolCount)) {
    if (count >= 3) {
      matched = true;
      eliminatedSymbol = Number(symbol);
      break;
    }
  }
  let finalSlot = newSlot;
  if (matched) {
    let removed = 0;
    finalSlot = newSlot.filter((id) => {
      const matchingCard = cards.find((candidate) => candidate.id === id);
      if (removed < 3 && matchingCard && matchingCard.symbol === eliminatedSymbol) {
        removed += 1;
        return false;
      }
      return true;
    });
  }
  const remainingCards = cards.filter((candidate) => !newPickedIds.includes(candidate.id));
  const won = remainingCards.length === 0;
  const gameOver = !won && finalSlot.length >= 7 && !canMatch(cards, newPickedIds, finalSlot);
  return { pickedIds: newPickedIds, slot: finalSlot, matched, won, gameOver };
}
function canMatch(cards, pickedIds, slot) {
  const symbolCount = {};
  for (const id of slot) {
    const card = cards.find((candidate) => candidate.id === id);
    if (card) symbolCount[card.symbol] = (symbolCount[card.symbol] || 0) + 1;
  }
  return Object.values(symbolCount).some((count) => count >= 3);
}
function replaySheep(problemSecret, difficulty, opLog) {
  const cardTypes = [8, 12, 15][difficulty] ?? 8;
  const { cards } = generateLayout(problemSecret, cardTypes);
  let pickedIds = [];
  let slot = [];
  let won = false;
  let gameOver = false;
  let shuffleLeft = 1;
  let remove3Left = 1;
  for (let index = 0; index < opLog.length; index += 1) {
    const operation = opLog[index];
    const type = typeof operation?.type === "string" ? operation.type.trim() : "";
    if (type === "pick") {
      const result = applyPick(cards, pickedIds, slot, Number(operation?.cardId));
      if ("error" in result) throw new Error(`invalid pick op at index ${index}: ${result.error}`);
      ({ pickedIds, slot, won, gameOver } = result);
    } else if (type === "shuffle") {
      if (shuffleLeft <= 0) throw new Error(`shuffle exhausted at index ${index}`);
      shuffleLeft -= 1;
    } else if (type === "remove3") {
      if (remove3Left <= 0) throw new Error(`remove3 exhausted at index ${index}`);
      remove3Left -= 1;
      slot = slot.slice(3);
    } else if (type === "undo") {
      if (pickedIds.length > 0) {
        pickedIds = pickedIds.slice(0, -1);
        const rebuilt = rebuildSlotFromPicks(cards, pickedIds);
        slot = rebuilt.slot;
      }
    } else {
      throw new Error(`unknown op type '${type}' at index ${index}`);
    }
    if (won || gameOver) break;
  }
  return { pickedIds, slot, won, gameOver, shuffleLeft, remove3Left };
}
function rebuildSlotFromPicks(cards, pickedIds) {
  let slot = [];
  for (const cardId of pickedIds) {
    const newSlot = [...slot, cardId];
    const symbolCount = {};
    for (const id of newSlot) {
      const card = cards.find((candidate) => candidate.id === id);
      if (card) symbolCount[card.symbol] = (symbolCount[card.symbol] || 0) + 1;
    }
    let matched = false;
    for (const [symbol, count] of Object.entries(symbolCount)) {
      if (count >= 3) {
        matched = true;
        let removed = 0;
        slot = newSlot.filter((id) => {
          const card = cards.find((candidate) => candidate.id === id);
          if (removed < 3 && card && card.symbol === Number(symbol)) {
            removed += 1;
            return false;
          }
          return true;
        });
        break;
      }
    }
    if (!matched) slot = newSlot;
  }
  return { slot };
}
export {
  applyPick,
  buildCardViews,
  computeExposed,
  generateLayout,
  replaySheep
};
