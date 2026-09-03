// Sheep Solitaire engine — ABI wrapper over engines/sheep.js
// Implements the fixed ABI: deal, applyOp, applyUndo, replay, score.
import { ScoreRejection, answerHashOf, resolveTarget, DEFAULT_GATES } from '../abi.js';
import { generateLayout, buildCardViews, applyPick, replaySheep } from '../engines/sheep.js';

export const appId = 'miniapp-sheep-solitaire';

// cardTypes per difficulty: 8 / 12 / 15 symbols
const CARD_TYPES = [8, 12, 15];

function cardViewsForIds(cards, pickedIds, ids) {
  const byId = new Map(buildCardViews(cards, pickedIds).map((card) => [card.id, card]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function currentView(state, matched = false) {
  return {
    ok: true,
    cards: buildCardViews(state.cards, state.pickedIds),
    slots: cardViewsForIds(state.cards, state.pickedIds, state.slot),
    matched,
    won: state.won,
    gameOver: state.gameOver,
    shuffleLeft: state.shuffleLeft,
    remove3Left: state.remove3Left,
  };
}

export const descriptor = Object.freeze({
  opSchema: "pick: {type:'pick', cardId:number} | shuffle | remove3 | undo",
  targets: CARD_TYPES, // score target = all cards cleared (totalCards)
  timeWindow: {
    limitMs: [300_000, 480_000, 720_000], // 5 / 8 / 12 min
    minSolveMs: [30_000, 60_000, 90_000],
  },
  gates: { ...DEFAULT_GATES },
  revealPolicy: 'clues',
  maxOps: 5_000,
  maxUndos: 3,
  undoPenaltyPct: 30,
  logDeterministic: true,
  startConfigKey: 'card_types',
});

export function deal(problemSecret, difficulty) {
  const diff = Number(difficulty) || 0;
  const cardTypes = CARD_TYPES[diff] ?? 8;
  const { cards, totalCards } = generateLayout(problemSecret, cardTypes);
  const views = buildCardViews(cards, []);
  return {
    state: {
      problemSecret,
      difficulty: diff,
      cards, // full card data (server-side only)
      pickedIds: [],
      slot: [],
      shuffleLeft: 1,
      remove3Left: 1,
      won: false,
      gameOver: false,
      acceptedOps: [],
    },
    startView: {
      cards: views,
      slots: [],
      totalCards,
      cardTypes,
      shuffleLeft: 1,
      remove3Left: 1,
    },
  };
}

export function applyOp(state, op, _opMeta) {
  const type = typeof op?.type === 'string' ? op.type.trim() : '';

  if (type === 'pick') {
    const cardId = Number(op.cardId);
    if (!Number.isInteger(cardId) || cardId < 0) {
      return {
        state,
        reject: { message: 'op.cardId must be a non-negative integer', status: 400 },
      };
    }
    const result = applyPick(state.cards, state.pickedIds, state.slot, cardId);
    if (result.error) {
      return { state, reject: { message: result.error, status: 409 } };
    }
    state.pickedIds = result.pickedIds;
    state.slot = result.slot;
    state.won = result.won;
    state.gameOver = result.gameOver;
    state.acceptedOps.push({ type: 'pick', cardId });
    return {
      state,
      view: currentView(state, result.matched),
    };
  }

  if (type === 'shuffle') {
    if (state.shuffleLeft <= 0) {
      return { state, reject: { message: 'no shuffles remaining', status: 409 } };
    }
    state.shuffleLeft--;
    state.acceptedOps.push({ type: 'shuffle' });
    return {
      state,
      view: currentView(state),
    };
  }

  if (type === 'remove3') {
    if (state.remove3Left <= 0) {
      return { state, reject: { message: 'no remove3 uses remaining', status: 409 } };
    }
    if (state.slot.length < 3) {
      return { state, reject: { message: 'remove3 requires at least 3 tray cards', status: 409 } };
    }
    state.remove3Left--;
    // Remove first 3 items from the tray
    state.slot = state.slot.slice(3);
    state.gameOver = false;
    state.acceptedOps.push({ type: 'remove3' });
    return {
      state,
      view: currentView(state),
    };
  }

  return { state, reject: { message: `unknown op.type: ${type}`, status: 400 } };
}

export function applyUndo(state, _opMeta) {
  const pickIndex = state.acceptedOps.findLastIndex((op) => op.type === 'pick');
  if (pickIndex < 0) {
    return { state, reject: { message: 'nothing to undo', status: 409 } };
  }
  state.acceptedOps.splice(pickIndex, 1);
  const replayed = replaySheep(state.problemSecret, state.difficulty, state.acceptedOps);
  state.pickedIds = replayed.pickedIds;
  state.slot = replayed.slot;
  state.won = replayed.won;
  state.gameOver = replayed.gameOver;
  state.shuffleLeft = replayed.shuffleLeft;
  state.remove3Left = replayed.remove3Left;
  return {
    state,
    view: currentView(state),
  };
}

export function replay(problemSecret, opLog, difficulty = 0) {
  const { state } = deal(problemSecret, difficulty);
  for (let i = 0; i < opLog.length; i++) {
    const op = opLog[i];
    const type = typeof op?.type === 'string' ? op.type.trim() : '';
    const outcome = type === 'undo' ? applyUndo(state) : applyOp(state, op);
    if (outcome.reject)
      throw new Error(`invalid replay op at index ${i}: ${outcome.reject.message}`);
    if (state.won || state.gameOver) break;
  }
  return state;
}

export function score(state, difficulty, extra = {}) {
  // cardsCleared = cards cleared off the board (picked). Match-3-eliminated and
  // remove3-discarded cards are equally out of play; tray-resident picks are off
  // the board too. This is bit-for-bit the engine's own win condition: applyPick
  // sets won ⟺ every card is picked (pickedIds.length === cards.length), and an
  // undo both pops a pick and clears the flag — so gating on cardsCleared at the
  // default target (totalCards) is exactly the old state.won gate, while
  // honouring targetOverride like every other wrapper. Note descriptor.targets
  // holds CONFIG values (symbol counts via startConfigKey 'card_types'), NOT a
  // clearance threshold — the default score target is always totalCards.
  const totalCards = state.cards.length;
  const cardsCleared = state.pickedIds.length;
  const target = resolveTarget([totalCards, totalCards, totalCards], difficulty, extra);
  if (cardsCleared < target) {
    throw new ScoreRejection('game not won — all cards must be cleared');
  }
  const cardTypes = CARD_TYPES[Number(difficulty)] ?? 8;
  // The answer string is a pure deterministic function of the final state
  // (pickedIds is the ordered pick history, identical for live and replay).
  return {
    answerHash: answerHashOf(`sheep:${cardsCleared}:${state.pickedIds.join('.')}`),
    score: cardsCleared,
    scoreField: { card_types: cardTypes, cards_cleared: cardsCleared },
  };
}
