// Generic confidential-session host — the worker side of the GENERIC oracle
// game integration. This file contains ZERO per-game code: it never imports a
// named engine, never branches on appId, and hardcodes no per-game constant.
//
// It keeps ONLY generic machinery:
//   - parseIdentity: canonical identity string (HMAC input + commitment prefix)
//   - problemSecretFor / commitmentFor / sessionTokenFor: enclave HMAC roots
//   - session store + prune, seq/op-timestamp recording
//   - behavioural gate (driven by engine.descriptor.gates)
//   - the 79-byte finalize RESULT CODEC + the shared-worker-key result envelope
//
// Everything game-specific — the deal, per-op reveal, undo rebuild,
// deterministic replay, score derivation and EVERY per-game constant — lives in
// an APP-DECLARED ENGINE loaded by (appId, engineHash) from the operator-
// whitelisted registry, called through the fixed ABI (see abi.js / registry.js).
//
// Keys (derived through the Nitro Secrets Manager master, see
// platform/nitro-signer.js):
//   - role 'game-settle'  -> secp256r1 signing key (public key returned so the
//     RESULT bytes / envelope can be verified). Default path
//     morpheus/neo-n3/game-settle/signing/v1.
//   - role 'game-secret'  -> the 32 bytes used ONLY as the HMAC-SHA256 root for
//     problemSecret / session-token derivation (never signs). Default path
//     morpheus/neo-n3/game-secret/signing/v1.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { wallet as neoWallet } from '@cityofzion/neon-js';
import { json, stableStringify, trimString } from '../platform/core.js';
import { deriveNeoN3PrivateKeyHex } from '../platform/nitro-signer.js';
import { buildSignedResultEnvelope } from '../chain/index.js';
import { ScoreRejection } from './abi.js';
import { isRegisteredApp, registeredAppIds, resolveEngineByHash } from './registry.js';

export const GAME_SETTLE_KEY_ROLE = 'game-settle';
export const GAME_SECRET_KEY_ROLE = 'game-secret';

const MAX_SESSIONS = 4_096;
const SESSION_TTL_MS = 3 * 60 * 60 * 1000; // > max limitMs + settle grace

const sessions = new Map(); // canonical -> session

// ---------------------------------------------------------------------------
// Test seams — deterministic clock, session-cache reset and per-app score-target
// overrides so finalize win paths are exercisable without grinding a real target.
// ---------------------------------------------------------------------------
let clockForTests = null;
const targetOverrides = {}; // appId -> [t0,t1,t2]

export function __setGameClockForTests(fn) {
  clockForTests = typeof fn === 'function' ? fn : null;
}
export function __setGameTargetForTests(appId, targets) {
  if (Array.isArray(targets) && targets.length === 3) targetOverrides[appId] = targets;
  else delete targetOverrides[appId];
}
export function __resetGameSessionsForTests() {
  sessions.clear();
}

function now() {
  return clockForTests ? clockForTests() : Date.now();
}

// Effective per-difficulty target: an engine descriptor's target, overridable
// in tests. The override drives BOTH the start-config surface and score() (the
// host passes the effective difficulty targets down to the engine's score()).
function effectiveTargets(engine) {
  return targetOverrides[engine.appId] || engine.descriptor.targets;
}

// ---------------------------------------------------------------------------
// Identity / key material
// ---------------------------------------------------------------------------

function normalizeHash160(value, fieldName) {
  const raw = trimString(value);
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new Error(`${fieldName} must be 0x-prefixed 40-char hex`);
  }
  return raw.toLowerCase();
}

// Canonical identity string — the HMAC input for problemSecret and the
// (canonical + '|') prefix of the commitment preimage. Every field is
// normalized first so casing/leading-zero variants cannot mint distinct
// commitments for the same logical game. The engine registry (not this parser)
// is the source of truth for which app_ids are valid.
function parseIdentity(payload = {}) {
  const appId = trimString(payload.app_id).toLowerCase();
  if (!isRegisteredApp(appId)) {
    throw new Error(`app_id must be one of: ${registeredAppIds().join(', ')}`);
  }
  const network = trimString(payload.network).toLowerCase();
  if (network !== 'mainnet' && network !== 'testnet') {
    throw new Error('network must be mainnet or testnet');
  }
  const contractHash = normalizeHash160(payload.contract_hash, 'contract_hash');
  const player = normalizeHash160(payload.player ?? payload.player_hash160_hex, 'player');
  const gameIdRaw = trimString(payload.game_id);
  if (!/^[0-9]+$/.test(gameIdRaw) || gameIdRaw.length > 78) {
    throw new Error('game_id must be a decimal string');
  }
  const gameId = BigInt(gameIdRaw);
  if (gameId >= 1n << 256n) throw new Error('game_id overflows uint256');
  const difficulty = Number(payload.difficulty);
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > 2) {
    throw new Error('difficulty must be an integer 0..2');
  }
  const gameIdCanonical = gameId.toString(10);
  const canonical = `${appId}|${network}|${contractHash}|${gameIdCanonical}|${player}|${difficulty}`;
  return { appId, network, contractHash, player, gameId: gameIdCanonical, difficulty, canonical };
}

// The authoritative Rust session lane verifies the secp256r1 signature and
// account binding. The compatibility worker must still refuse the historical
// unsigned shape so it cannot accidentally become a usable session endpoint.
// Keep this boundary structural here; cryptographic verification remains in the
// measured Rust host that is allowed to settle requests.
function requirePlayerWitness(payload = {}) {
  const witness = payload.player_witness;
  if (!witness || typeof witness !== 'object' || Array.isArray(witness)) {
    throw new Error('player_witness is required');
  }
  const publicKey = trimString(witness.public_key).replace(/^0x/i, '');
  const signature = trimString(witness.signature ?? witness.data).replace(/^0x/i, '');
  if (!/^(02|03)[0-9a-f]{64}$/i.test(publicKey)) {
    throw new Error('player_witness.public_key must be a compressed secp256r1 key');
  }
  if (!/^[0-9a-f]{128}$/i.test(signature)) {
    throw new Error('player_witness.signature must be 64 bytes of hex');
  }
  if (witness.salt !== undefined && typeof witness.salt !== 'string') {
    throw new Error('player_witness.salt must be a string');
  }
}

const signingAccountCache = new Map();

function accountFor(privateKeyHex) {
  let account = signingAccountCache.get(privateKeyHex);
  if (!account) {
    account = new neoWallet.Account(privateKeyHex);
    if (signingAccountCache.size >= 4) {
      signingAccountCache.delete(signingAccountCache.keys().next().value);
    }
    signingAccountCache.set(privateKeyHex, account);
  }
  return account;
}

async function gameKeyMaterial() {
  const [settleKeyHex, secretRootHex] = await Promise.all([
    deriveNeoN3PrivateKeyHex(GAME_SETTLE_KEY_ROLE),
    deriveNeoN3PrivateKeyHex(GAME_SECRET_KEY_ROLE),
  ]);
  return {
    account: accountFor(settleKeyHex),
    secretRoot: Buffer.from(secretRootHex, 'hex'),
  };
}

function problemSecretFor(secretRoot, canonical) {
  return createHmac('sha256', secretRoot).update(canonical, 'utf8').digest();
}

function commitmentFor(canonical, problemSecret) {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from(`${canonical}|`, 'utf8'), problemSecret]))
    .digest();
}

function sessionTokenFor(secretRoot, canonical) {
  return createHmac('sha256', secretRoot).update(`token|${canonical}`, 'utf8').digest('hex');
}

function verifySessionToken(secretRoot, canonical, provided) {
  const expected = Buffer.from(sessionTokenFor(secretRoot, canonical), 'utf8');
  const supplied = Buffer.from(trimString(provided), 'utf8');
  return supplied.length === expected.length && timingSafeEqual(expected, supplied);
}

function replayProofFor(secretRoot, canonical, replayOps) {
  const replayDigest = createHash('sha256')
    .update(stableStringify(Array.isArray(replayOps) ? replayOps : []), 'utf8')
    .digest('hex');
  return createHmac('sha256', secretRoot)
    .update(`replay|${canonical}|${replayDigest}`, 'utf8')
    .digest('hex');
}

function verifyReplayProof(secretRoot, canonical, replayOps, provided) {
  const expected = Buffer.from(replayProofFor(secretRoot, canonical, replayOps), 'utf8');
  const supplied = Buffer.from(trimString(provided), 'utf8');
  return supplied.length === expected.length && timingSafeEqual(expected, supplied);
}

// NOTE: there is no per-game SETTLE/BIND signature anymore. Owner decision D3
// drops the per-app secp256r1 signer: the on-chain trust root is the kernel's
// shared RUNTIME_VERIFIER, which re-signs the fulfillment digest over
// SHA256(result) in the relayer. The worker only builds + envelopes the RESULT
// CODEC (buildSignedResultEnvelope) for transport; the game-settle public key is
// surfaced as informational metadata, never as a settlement authority.

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

function pruneSessions(nowMs) {
  for (const [key, session] of sessions) {
    if (nowMs - session.lastTouchedMs > SESSION_TTL_MS) sessions.delete(key);
  }
  while (sessions.size >= MAX_SESSIONS) {
    sessions.delete(sessions.keys().next().value);
  }
}

function createSession(identity, engine, problemSecret, { resumed = false } = {}) {
  const nowMs = now();
  pruneSessions(nowMs);
  const { state, startView } = engine.deal(problemSecret, identity.difficulty);
  const session = {
    appId: identity.appId,
    engineHash: engine.engineHash,
    difficulty: identity.difficulty,
    problemSecret,
    startedAtMs: nowMs,
    lastTouchedMs: nowMs,
    lastSeq: -1,
    undos: 0,
    resumed,
    opTimestamps: [],
    opLog: [], // the accepted op log — feeds engine.replay for kernel re-derivation
    engineState: state,
    lastView: startView,
  };
  sessions.set(identity.canonical, session);
  return session;
}

// ---------------------------------------------------------------------------
// Generic op application — dispatches undo/gameplay to the engine ABI. Returns
// { view, resumed? } or { error, status }. Records the op into the op log and
// counts undos generically (bounded by descriptor.maxUndos / maxOps).
// ---------------------------------------------------------------------------

function opMetaFor(session, nowMs) {
  return {
    problemSecret: session.problemSecret,
    difficulty: session.difficulty,
    nowMs,
    startedAtMs: session.startedAtMs,
    elapsedMs: Math.max(0, nowMs - session.startedAtMs),
    resumed: session.resumed,
    opIndex: session.opLog.length,
  };
}

function applyOp(session, engine, op, nowMs, { record = true } = {}) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) {
    return { error: 'op object required', status: 400 };
  }
  const type = trimString(op.type);
  const meta = opMetaFor(session, nowMs);

  if (type === 'undo') {
    if (session.undos >= engine.descriptor.maxUndos) {
      return { error: 'undo limit reached', status: 409 };
    }
    const outcome = engine.applyUndo(session.engineState, meta);
    if (outcome.reject) return { error: outcome.reject.message, status: outcome.reject.status };
    session.engineState = outcome.state;
    session.undos += 1;
    if (record) session.opLog.push({ type: 'undo' });
    session.lastView = { ...outcome.view, undos: session.undos };
    return { view: session.lastView };
  }

  if (session.opLog.length >= engine.descriptor.maxOps) {
    return { error: 'op log limit reached', status: 409 };
  }

  const outcome = engine.applyOp(session.engineState, op, meta);
  if (outcome.reject) return { error: outcome.reject.message, status: outcome.reject.status };
  session.engineState = outcome.state;
  // An accepted-but-null op (view.ok === false) is not recorded — mirrors the
  // legacy "board did not change" no-op that consumed no move.
  if (outcome.view?.ok !== false && record) session.opLog.push(op);
  session.lastView = outcome.view;
  return { view: outcome.view };
}

// Deterministic rebuild after an enclave restart / cache eviction: replay the
// client's prior op log through the engine. Resumed sessions restart the elapsed
// clock and are marked resumed (the behavioural gate then restricts to burst).
function rebuildSession(identity, engine, problemSecret, replayOps) {
  const ops = Array.isArray(replayOps) ? replayOps : [];
  if (ops.length > engine.descriptor.maxOps) {
    throw new Error('replay log too long');
  }
  const session = createSession(identity, engine, problemSecret, { resumed: true });
  session.problemSecret = problemSecret;
  for (let i = 0; i < ops.length; i += 1) {
    const outcome = applyOp(session, engine, ops[i], now());
    if (outcome.error || outcome.view?.ok === false) {
      sessions.delete(identity.canonical);
      throw new Error(`invalid replay op at index ${i}`);
    }
  }
  return session;
}

// ---------------------------------------------------------------------------
// Behavioural gate — descriptor-driven (gates.minMedianIntervalMs /
// maxBurstOpsPerSec). Per-op gates (e.g. pet action spacing) are enforced inside
// the engine at op time; this is the finalize-time sustained-rate check.
// ---------------------------------------------------------------------------

function behavioralGateError(session, gates) {
  const ts = session.opTimestamps;
  const maxBurst = gates.maxBurstOpsPerSec;
  if (Number.isFinite(maxBurst)) {
    let lo = 0;
    for (let hi = 0; hi < ts.length; hi += 1) {
      while (ts[hi] - ts[lo] > 1000) lo += 1;
      if (hi - lo + 1 > maxBurst) {
        return 'sustained op burst exceeds the human rate cap';
      }
    }
  }
  const minMedian = gates.minMedianIntervalMs;
  if (!session.resumed && Number.isFinite(minMedian) && ts.length >= 2) {
    const intervals = [];
    for (let i = 1; i < ts.length; i += 1) intervals.push(ts[i] - ts[i - 1]);
    intervals.sort((a, b) => a - b);
    const mid = intervals.length >> 1;
    const median =
      intervals.length % 2 === 1 ? intervals[mid] : (intervals[mid - 1] + intervals[mid]) / 2;
    if (median < minMedian) {
      return 'median inter-op interval below the human floor';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// RESULT CODEC — the fixed 79-byte finalize result the contract parses by offset
// and the kernel hashes SHA256(result). Pinned byte-for-byte by the golden vector
// in result-codec.test.mjs. Big-endian, NOT StdLib.Serialize.
//
//   byte[0]        = 0x02                       // finalize tag
//   bytes[1..33]   = commitment (32)
//   bytes[33..65]  = answerHash (32)
//   bytes[65..73]  = elapsedMs  (uint64 BE, 8)
//   byte[73]       = undos      (uint8)
//   bytes[74..78]  = score      (uint32 BE, 4)
//   byte[78]       = difficulty (uint8)
//   total 79 bytes
// ---------------------------------------------------------------------------

export const RESULT_FINALIZE_TAG = 0x02;
export const RESULT_BYTES_LENGTH = 79;

export function buildResultBytes({ commitment, answerHash, elapsedMs, undos, score, difficulty }) {
  const commit = Buffer.isBuffer(commitment) ? commitment : Buffer.from(commitment, 'hex');
  const answer = Buffer.isBuffer(answerHash) ? answerHash : Buffer.from(answerHash, 'hex');
  if (commit.length !== 32) throw new Error('commitment must be 32 bytes');
  if (answer.length !== 32) throw new Error('answerHash must be 32 bytes');

  const elapsed = BigInt(Math.max(0, Math.trunc(Number(elapsedMs))));
  if (elapsed >= 1n << 64n) throw new Error('elapsedMs overflows uint64');
  const undosN = Number(undos);
  if (!Number.isInteger(undosN) || undosN < 0 || undosN > 255)
    throw new Error('undos out of range');
  const scoreN = Number(score);
  if (!Number.isInteger(scoreN) || scoreN < 0 || scoreN > 0xffffffff) {
    throw new Error('score overflows uint32');
  }
  const diffN = Number(difficulty);
  if (!Number.isInteger(diffN) || diffN < 0 || diffN > 255)
    throw new Error('difficulty out of range');

  const out = Buffer.alloc(RESULT_BYTES_LENGTH);
  out[0] = RESULT_FINALIZE_TAG;
  commit.copy(out, 1);
  answer.copy(out, 33);
  out.writeBigUInt64BE(elapsed, 65);
  out[73] = undosN;
  out.writeUInt32BE(scoreN, 74);
  out[78] = diffN;
  return out;
}

// ---------------------------------------------------------------------------
// Handlers — generic /session/{start,step,finalize}
// ---------------------------------------------------------------------------

async function loadIdentityAndEngine(payload) {
  const identity = parseIdentity(payload);
  requirePlayerWitness(payload);
  const engineHash = trimString(payload.engine_hash);
  const engine = resolveEngineByHash(identity.appId, engineHash);
  return { identity, engine };
}

export async function handleSessionStart(payload = {}) {
  let identity;
  let engine;
  try {
    ({ identity, engine } = await loadIdentityAndEngine(payload));
  } catch (error) {
    return json(400, { error: error.message });
  }
  let km;
  try {
    km = await gameKeyMaterial();
  } catch {
    return json(503, { error: 'game key material unavailable' });
  }

  const problemSecret = problemSecretFor(km.secretRoot, identity.canonical);
  const commitment = commitmentFor(identity.canonical, problemSecret);

  // Idempotent: an existing session (and its first-seen clock) is preserved so a
  // repeated start cannot reset the elapsed timer mid-game.
  let session = sessions.get(identity.canonical);
  if (!session) {
    session = createSession(identity, engine, problemSecret);
    session.problemSecret = problemSecret;
  }

  // The start view is a pure function of the problemSecret (a fresh deal), never
  // the live session state — so repeated starts always return the spec view.
  const { startView } = engine.deal(problemSecret, identity.difficulty);

  const targets = effectiveTargets(engine);
  const window = engine.descriptor.timeWindow;
  const config = {
    app_id: identity.appId,
    engine_hash: engine.engineHash,
    network: identity.network,
    game_id: identity.gameId,
    difficulty: identity.difficulty,
    limit_ms: window.limitMs[identity.difficulty],
    min_solve_ms: window.minSolveMs[identity.difficulty],
    max_undos: engine.descriptor.maxUndos,
    reveal_policy: engine.descriptor.revealPolicy,
  };
  if (engine.descriptor.startConfigKey) {
    config[engine.descriptor.startConfigKey] = targets[identity.difficulty];
  }

  return json(200, {
    commitment: commitment.toString('hex'),
    public_key: km.account.publicKey,
    view: startView,
    current_view: session.lastView,
    op_count: session.opLog.length,
    session_token: sessionTokenFor(km.secretRoot, identity.canonical),
    replay_proof: replayProofFor(km.secretRoot, identity.canonical, session.opLog),
    config,
  });
}

export async function handleSessionStep(payload = {}) {
  let identity;
  let engine;
  try {
    ({ identity, engine } = await loadIdentityAndEngine(payload));
  } catch (error) {
    return json(400, { error: error.message });
  }
  let km;
  try {
    km = await gameKeyMaterial();
  } catch {
    return json(503, { error: 'game key material unavailable' });
  }
  if (!verifySessionToken(km.secretRoot, identity.canonical, payload.session_token)) {
    return json(401, { error: 'invalid session token' });
  }

  const seq = Number(payload.seq);
  if (!Number.isInteger(seq) || seq < 0) {
    return json(400, { error: 'seq must be a non-negative integer' });
  }

  const problemSecret = problemSecretFor(km.secretRoot, identity.canonical);
  let session = sessions.get(identity.canonical);
  let resumedNow = false;
  if (!session) {
    if (
      !verifyReplayProof(km.secretRoot, identity.canonical, payload.replay, payload.replay_proof)
    ) {
      return json(401, { error: 'invalid or missing authenticated replay proof' });
    }
    try {
      session = rebuildSession(identity, engine, problemSecret, payload.replay);
      resumedNow = true;
    } catch (error) {
      return json(400, { error: error.message });
    }
  }
  session.problemSecret = problemSecret;

  if (seq <= session.lastSeq) {
    return json(409, { error: 'stale seq', expected_min: session.lastSeq + 1 });
  }

  const nowMs = now();
  const outcome = applyOp(session, engine, payload.op, nowMs);
  if (outcome.error) return json(outcome.status, { error: outcome.error });

  session.lastSeq = seq;
  // Only timestamp accepted, recorded ops (not null no-ops) for the gate.
  if (outcome.view?.ok !== false) session.opTimestamps.push(nowMs);
  session.lastTouchedMs = nowMs;

  return json(200, {
    seq,
    op_count: session.opLog.length,
    ...(resumedNow ? { resumed: true } : {}),
    replay_proof: replayProofFor(km.secretRoot, identity.canonical, session.opLog),
    ...outcome.view,
  });
}

export async function handleSessionFinalize(payload = {}) {
  let identity;
  let engine;
  try {
    ({ identity, engine } = await loadIdentityAndEngine(payload));
  } catch (error) {
    return json(400, { error: error.message });
  }
  let km;
  try {
    km = await gameKeyMaterial();
  } catch {
    return json(503, { error: 'game key material unavailable' });
  }
  if (!verifySessionToken(km.secretRoot, identity.canonical, payload.session_token)) {
    return json(401, { error: 'invalid session token' });
  }

  const problemSecret = problemSecretFor(km.secretRoot, identity.canonical);
  let session = sessions.get(identity.canonical);
  if (!session) {
    // Cache-loss recovery accepts only a replay log carrying an enclave HMAC
    // issued after the last accepted operation. Client-chosen replay data alone
    // is not authoritative and can never be used to mint a settlement.
    if (!Array.isArray(payload.replay)) {
      return json(404, {
        error: 'unknown session — authenticated replay is required to finalize',
      });
    }
    if (
      !verifyReplayProof(km.secretRoot, identity.canonical, payload.replay, payload.replay_proof)
    ) {
      return json(401, { error: 'invalid or missing authenticated replay proof' });
    }
    try {
      session = rebuildSession(identity, engine, problemSecret, payload.replay);
    } catch (error) {
      return json(400, { error: error.message });
    }
  }
  session.problemSecret = problemSecret;

  const window = engine.descriptor.timeWindow;
  const elapsedMs = Math.max(0, Math.trunc(now() - session.startedAtMs));
  if (elapsedMs < window.minSolveMs[identity.difficulty]) {
    return json(403, { error: 'solved too fast' });
  }
  if (elapsedMs > window.limitMs[identity.difficulty]) {
    return json(403, { error: 'time limit exceeded' });
  }

  const gateError = behavioralGateError(session, engine.descriptor.gates);
  if (gateError) return json(403, { error: gateError });

  const commitment = commitmentFor(identity.canonical, problemSecret);

  // Score against the EFFECTIVE difficulty target. A per-app test override (or a
  // future operator-tuned target) is passed to the engine as targetOverride; the
  // engine derives the authoritative answerHash/score from its own state and
  // compares against the override when present, else descriptor.targets.
  const targets = effectiveTargets(engine);
  let scored;
  try {
    scored = engine.score(session.engineState, identity.difficulty, {
      answer: payload.answer,
      elapsedMs,
      startedAtMs: session.startedAtMs,
      nowMs: now(),
      targetOverride: targets[identity.difficulty],
    });
  } catch (error) {
    if (error instanceof ScoreRejection) return json(error.status, { error: error.message });
    throw error;
  }

  const resultBytes = buildResultBytes({
    commitment,
    answerHash: scored.answerHash,
    elapsedMs,
    undos: session.undos,
    score: scored.score,
    difficulty: identity.difficulty,
  });

  // Sign the result via the shared enclave worker-key envelope path (the same
  // buildSignedResultEnvelope every fulfillment lane uses). The relayer forwards
  // result_bytes_base64 to the kernel, which hashes SHA256(result); tamper
  // breaks the FulfillRequest signature under the shared RUNTIME_VERIFIER.
  const resultBytesBase64 = resultBytes.toString('base64');
  const signed = await buildSignedResultEnvelope(
    { result_bytes_base64: resultBytesBase64 },
    payload
  );

  return json(200, {
    // The 79-byte RESULT CODEC — the relayer maps this to the compact callback.
    result_bytes_base64: resultBytesBase64,
    callback_encoding: 'game_result_v1',
    // Human-readable decode of the same bytes (never re-hashed on-chain).
    problem_hash: commitment.toString('hex'),
    answer_hash: scored.answerHash.toString('hex'),
    elapsed_ms: elapsedMs,
    undos: session.undos,
    score: scored.score,
    difficulty: identity.difficulty,
    ...(scored.scoreField || {}),
    // Enclave signature over the result bytes (worker key) — verification
    // metadata for the relayer's labeled envelope.
    public_key: km.account.publicKey,
    output_hash: signed.output_hash,
    signature: signed.signature,
    verification: {
      output_hash: signed.output_hash,
      attestation_hash: signed.attestation_hash,
      signature: signed.signature,
      public_key: signed.public_key,
      signer_address: signed.signer_address || null,
      signer_script_hash: signed.signer_script_hash || null,
      tee_attestation: signed.tee_attestation ?? null,
    },
  });
}
