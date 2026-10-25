//! Generic confidential game-session state machine.
//!
//! This is the keyless Rust port of `workers/nitro-worker/src/game/session.js`
//! after the 2026-09 game-engine audit. It owns protocol validation, the
//! player-bound identity, HMAC-authenticated resume records, bounded
//! ephemeral state, sequencing, behavioural gates, the single replay-based
//! scoring path and the 111-byte result codec (v2). Secret release,
//! randomness and result signing remain host responsibilities: callers pass
//! a 32-byte HMAC key used for nothing else (the enclave host passes the
//! game-session subkey of its attested KMS root, never the root itself),
//! fresh OS entropy for new session tokens, and add the custody envelope only
//! after a successful kernel-lane [`SessionStore::finalize`].
//!
//! Trust model (what changed and why):
//!
//! * **Player-bound sessions.** `start` requires a `player_witness`: the
//!   wallet's secp256r1 signature (NEP dAPI `signMessage` framing) over
//!   `neoos-game-session/v1|<canonical>`, whose public key must hash to the
//!   session's `player`. The session token is 32 random bytes minted at
//!   creation and returned only to a witnessed caller — it is no longer an
//!   HMAC of public chain data that anyone could re-derive.
//! * **Authenticated resume record.** The `replay_proof` HMAC now covers the
//!   session token, the ORIGINAL `started_at_ms` and every accepted op's
//!   server-assigned elapsed time. A rebuild restores all of them, so an
//!   evicted session cannot reset its clock and the median-interval anti-bot
//!   gate applies to resumed sessions exactly as to live ones.
//! * **Replay is the only scoring path.** `finalize` re-deals from the
//!   problem secret and replays the authenticated op-log with its recorded
//!   timing through the engine ABI, then scores that state — never the cached
//!   `engine_state`. The kernel lane (the on-chain settlement request) and
//!   the direct preview lane share this path; only their failure semantics
//!   differ (see [`FinalizeLane`]).
//! * **Results are bound to the on-chain game.** Codec v2 appends
//!   `sha256(domain ‖ sha256(appId) ‖ uint256_be(gameId) ‖ player)` to the
//!   v1 fields ([`result_binding`]). PlatformGame recomputes it from its own
//!   game record and refuses any other value (audit: one solved run used to
//!   settle every game of every player in every RewardGame app).
//! * **One chain request settles a session.** The kernel lane requires the
//!   chain requester of its request to be the session player. Its first
//!   successful finalize consumes the session: a retry of the same request
//!   recomputes the same bytes, any other request is refused, the HMAC resume
//!   record cannot rebuild it, and no session older than
//!   [`MAX_SETTLE_AGE_MS`] can settle or be rebuilt at all.

use std::cmp::Ordering;
use std::collections::HashMap;

use base64::Engine as _;
use hmac::{Hmac, Mac};
use num_bigint::BigUint;
use p256::ecdsa::signature::hazmat::PrehashVerifier;
use p256::ecdsa::{Signature, VerifyingKey};
use serde_json::{Map, Value as Json};
use sha2::{Digest, Sha256};

use super::abi::{OpMeta, OpOutcome, ScoreExtra};
use super::registry::{registered_app_ids, resolve_engine, resolve_engine_by_hash, EngineHandle};

type HmacSha256 = Hmac<Sha256>;

pub const MAX_SESSIONS: usize = 4_096;
/// Live sessions one `(network, player)` may hold. A witnessed player cannot
/// flood the map with junk identities to evict everyone else (audit: 4096
/// unauthenticated starts evicted every live session).
pub const MAX_SESSIONS_PER_PLAYER: usize = 16;
pub const SESSION_TTL_MS: f64 = 3.0 * 60.0 * 60.0 * 1_000.0;
/// Codec v2 tag. v1 was `0x02` with 79 bytes and no binding; PlatformGame
/// refuses it.
pub const RESULT_FINALIZE_TAG: u8 = 0x03;
pub const RESULT_BYTES_LENGTH: usize = 111;
/// The `callback_encoding` that carries codec v2 to the fulfillment builders.
pub const RESULT_CALLBACK_ENCODING: &str = "game_result_v2";
/// Domain separator of the result binding (see [`result_binding`]).
pub const RESULT_BINDING_DOMAIN: &str = "neoos-game-result-binding/v1";
/// The oldest session that may still settle or be rebuilt. PlatformGame
/// bounds `limitMs` at 1 h and `settleGraceMs` at 24 h, so no RewardGame is
/// settleable more than 25 h after it starts; the extra hour covers relayer
/// latency. Settled-session records are kept exactly this long.
pub const MAX_SETTLE_AGE_MS: f64 = 26.0 * 60.0 * 60.0 * 1_000.0;
/// Settled-session records kept after their live session is evicted. When
/// full, the oldest record goes first; the on-chain binding still refuses any
/// result for a game other than the one the session was played for.
pub const MAX_SETTLED_SESSIONS: usize = 65_536;
/// The exact string the wallet signs (prefix + canonical identity).
pub const WITNESS_MESSAGE_PREFIX: &str = "neoos-game-session/v1|";
/// The sealed finalize payload kind the devpack client produces.
pub const SEALED_FINALIZE_KIND: &str = "miniapp.game.session.finalize.v2";

/// The chain side of a kernel-lane finalize: the Morpheus request id and the
/// account that submitted the request. Both are read from the on-chain
/// request by the relayer, never from the payload the player sealed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelRequest {
    pub request_id: String,
    pub requester: String,
}

/// Which caller is finalizing. The DIRECT lane is the player's optimistic
/// preview (`/session/finalize` over the public proxy): a run that does not
/// qualify is reported as the matching 4xx so the UI can explain it, and the
/// reply is unsigned (audit: the public proxy used to hand out custody-key
/// signatures for free). The KERNEL lane is the on-chain settlement request:
/// a deterministic disqualification (target missed, gate tripped, window
/// violated) is a LOSS result the contract settles with payout 0, not a
/// failed fulfillment — otherwise every lost run would refund its entry and
/// skill games would be free to retry. It settles one [`KernelRequest`] per
/// session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FinalizeLane {
    Direct,
    Kernel(KernelRequest),
}

/// A protocol-level response. Unlike host runtime failures, session validation
/// errors intentionally have the Node-compatible `{ "error": ... }` body.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionReply {
    pub status: u16,
    pub body: Json,
}

impl SessionReply {
    fn ok(body: Json) -> Self {
        Self { status: 200, body }
    }

    fn error(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            body: serde_json::json!({ "error": message.into() }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionIdentity {
    pub app_id: String,
    pub network: String,
    pub contract_hash: String,
    pub player: String,
    pub game_id: String,
    pub difficulty: u8,
    pub canonical: String,
}

impl SessionIdentity {
    /// The `(network, player)` quota key.
    fn player_key(&self) -> String {
        format!("{}|{}", self.network, self.player)
    }
}

#[derive(Debug, Clone)]
struct Session {
    app_id: String,
    engine_hash: String,
    difficulty: u8,
    player_key: String,
    problem_secret: [u8; 32],
    /// Random per-session bearer token (lowercase hex of 32 bytes).
    session_token: String,
    started_at_ms: f64,
    last_touched_ms: f64,
    last_seq: f64,
    undos: u64,
    resumed: bool,
    /// Elapsed time frozen by a successful DIRECT finalize; the kernel lane
    /// reuses it when the session is still cached.
    finalized_elapsed_ms: Option<f64>,
    /// The kernel request that consumed this session, if any. Kept on the
    /// live session as well as in [`SessionStore::settled`], so evicting the
    /// record never makes a live session settleable again.
    settled_by: Option<Settlement>,
    /// Absolute enclave clock of every accepted op (parallel to `op_log`).
    op_timestamps: Vec<f64>,
    op_log: Vec<Json>,
    engine_state: Json,
    last_view: Json,
    generation: u64,
}

/// What consumed a session: the kernel request and the digest of the result
/// it settled. A retry of that request must reproduce the same bytes.
#[derive(Debug, Clone, PartialEq)]
struct Settlement {
    request_id: String,
    result_digest: [u8; 32],
    started_at_ms: f64,
    generation: u64,
}

impl Session {
    fn op_elapsed_ms(&self) -> Vec<f64> {
        self.op_timestamps
            .iter()
            .map(|timestamp| (timestamp - self.started_at_ms).trunc().max(0.0))
            .collect()
    }

    fn replay_record(&self) -> Json {
        serde_json::json!({
            "started_at_ms": crate::js::js_number_value(self.started_at_ms),
            "op_elapsed_ms": self
                .op_elapsed_ms()
                .into_iter()
                .map(crate::js::js_number_value)
                .collect::<Vec<_>>(),
        })
    }

    fn last_op_elapsed_ms(&self) -> f64 {
        self.op_elapsed_ms().last().copied().unwrap_or(0.0)
    }
}

/// Process-local cache matching the Node Map. It is intentionally injectable
/// and resettable: persistence authority comes from the HMAC-authenticated
/// resume record, never from trusting client-provided replay operations.
/// Settled-session records outlive the live sessions they describe (they are
/// what stops a resume record from rebuilding a consumed session) but not
/// the process: a restart forgets them, and from then on only the
/// [`MAX_SETTLE_AGE_MS`] limit and the on-chain binding apply.
#[derive(Debug)]
pub struct SessionStore {
    sessions: HashMap<String, Session>,
    /// Keyed by `sha256(canonical identity)`.
    settled: HashMap<[u8; 32], Settlement>,
    settled_capacity: usize,
    generation: u64,
    target_overrides: HashMap<String, [f64; 3]>,
}

impl Default for SessionStore {
    fn default() -> Self {
        Self {
            sessions: HashMap::new(),
            settled: HashMap::new(),
            settled_capacity: MAX_SETTLED_SESSIONS,
            generation: 0,
            target_overrides: HashMap::new(),
        }
    }
}

impl SessionStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Evict every live session. Settled-session records stay: an eviction
    /// must not let a resume record rebuild a consumed session.
    pub fn clear(&mut self) {
        self.sessions.clear();
    }

    /// Test/operator seam mirroring the Node port. Removing the override
    /// restores the descriptor targets.
    pub fn set_target_override(&mut self, app_id: &str, targets: Option<[f64; 3]>) {
        match targets {
            Some(targets) => {
                self.target_overrides.insert(app_id.to_string(), targets);
            }
            None => {
                self.target_overrides.remove(app_id);
            }
        }
    }

    /// Open (or idempotently re-open) a session. `fresh_token` is host-supplied
    /// OS entropy consumed only when a NEW session is created; a rebuild
    /// request (`replay` + `replay_record` + `replay_proof` + `session_token`)
    /// restores an evicted session under its original token instead.
    pub fn start(
        &mut self,
        payload: &Json,
        secret_root: &[u8; 32],
        public_key: &str,
        now_ms: f64,
        fresh_token: &[u8; 32],
    ) -> SessionReply {
        let (identity, engine) = match load_identity_and_engine(payload) {
            Ok(value) => value,
            Err(message) => return SessionReply::error(400, message),
        };
        let credential = payload
            .get("player_credential")
            .or_else(|| payload.get("player_witness"));
        if payload.get("player_credential").is_some() {
            let before = credential
                .and_then(|v| v.get("not_before_ms"))
                .map(crate::js::js_to_number);
            let after = credential
                .and_then(|v| v.get("not_after_ms"))
                .map(crate::js::js_to_number);
            if !before.is_some_and(|v| v.is_finite()) || !after.is_some_and(|v| v.is_finite()) {
                return SessionReply::error(401, "player credential expired");
            }
            let (before, after) = (before.unwrap(), after.unwrap());
            if after < before || after - before > 86_400_000.0 || now_ms < before || now_ms > after
            {
                return SessionReply::error(401, "player credential expired");
            }
        }
        if let Err(message) = verify_player_witness(&identity, credential) {
            return SessionReply::error(401, message);
        }
        if self.settlement_of(&identity.canonical, now_ms).is_some() {
            return SessionReply::error(409, "session already settled");
        }
        let problem_secret = problem_secret_for(secret_root, &identity.canonical);
        let commitment = commitment_for(&identity.canonical, &problem_secret);

        if !self.sessions.contains_key(&identity.canonical) {
            if payload.get("replay_proof").is_some() {
                if let Err((status, message)) = self.rebuild_session(
                    &identity,
                    engine,
                    problem_secret,
                    payload,
                    secret_root,
                    now_ms,
                ) {
                    return SessionReply::error(status, message);
                }
            } else {
                if let Err(message) = self.enforce_player_quota(&identity, now_ms) {
                    return SessionReply::error(429, message);
                }
                let session = self.create_session(
                    &identity,
                    engine,
                    problem_secret,
                    now_ms,
                    super::hex_encode(fresh_token),
                    false,
                );
                self.sessions.insert(identity.canonical.clone(), session);
            }
        }

        // A repeated start cannot reset either the authoritative timer or
        // state, but its public deal remains the pure spec view.
        let (_, start_view) = (engine.deal)(&problem_secret, identity.difficulty);
        let session = self
            .sessions
            .get(&identity.canonical)
            .expect("session was inserted or already existed");
        debug_assert_eq!(session.app_id, identity.app_id);
        debug_assert_eq!(session.engine_hash, engine.engine_hash);

        let window = engine.descriptor.time_window;
        let targets = self.effective_targets(engine);
        let mut config = Map::new();
        config.insert("app_id".into(), Json::String(identity.app_id.clone()));
        config.insert(
            "engine_hash".into(),
            Json::String(engine.engine_hash.into()),
        );
        config.insert("network".into(), Json::String(identity.network.clone()));
        config.insert("game_id".into(), Json::String(identity.game_id.clone()));
        config.insert("difficulty".into(), Json::from(identity.difficulty));
        config.insert(
            "limit_ms".into(),
            crate::js::js_number_value(window.limit_ms[identity.difficulty as usize]),
        );
        config.insert(
            "min_solve_ms".into(),
            crate::js::js_number_value(window.min_solve_ms[identity.difficulty as usize]),
        );
        config.insert("max_undos".into(), Json::from(engine.descriptor.max_undos));
        config.insert(
            "reveal_policy".into(),
            Json::String(engine.descriptor.reveal_policy.as_str().into()),
        );
        if let Some(key) = engine.descriptor.start_config_key {
            config.insert(
                key.to_string(),
                crate::js::js_number_value(targets[identity.difficulty as usize]),
            );
        }

        SessionReply::ok(serde_json::json!({
            "commitment": super::hex_encode(&commitment),
            "public_key": public_key,
            "view": start_view,
            "current_view": session.last_view,
            "op_count": session.op_log.len(),
            "session_token": session.session_token,
            "replay_proof": replay_proof_for_session(secret_root, &identity.canonical, session),
            "replay_record": session.replay_record(),
            "resumed": session.resumed,
            "config": Json::Object(config),
        }))
    }

    pub fn step(&mut self, payload: &Json, secret_root: &[u8; 32], now_ms: f64) -> SessionReply {
        let (identity, engine) = match load_identity_and_engine(payload) {
            Ok(value) => value,
            Err(message) => return SessionReply::error(400, message),
        };

        let seq = payload
            .get("seq")
            .map(crate::js::js_to_number)
            .unwrap_or(f64::NAN);
        if !seq.is_finite() || seq.fract() != 0.0 || seq < 0.0 {
            return SessionReply::error(400, "seq must be a non-negative integer");
        }
        if self.settlement_of(&identity.canonical, now_ms).is_some() {
            return SessionReply::error(409, "session already settled");
        }

        let problem_secret = problem_secret_for(secret_root, &identity.canonical);
        let resumed_now = match self.resolve_session(
            &identity,
            engine,
            problem_secret,
            payload,
            secret_root,
            now_ms,
        ) {
            Ok(resumed) => resumed,
            Err((status, message)) => return SessionReply::error(status, message),
        };

        let session = self
            .sessions
            .get_mut(&identity.canonical)
            .expect("live or rebuilt session");
        if session.finalized_elapsed_ms.is_some() {
            return SessionReply::error(409, "session already finalized");
        }
        if seq <= session.last_seq {
            return SessionReply {
                status: 409,
                body: serde_json::json!({
                    "error": "stale seq",
                    "expected_min": crate::js::js_number_value(session.last_seq + 1.0),
                }),
            };
        }

        let outcome = match apply_session_op(session, engine, payload.get("op"), now_ms) {
            Ok(view) => view,
            Err((status, message)) => return SessionReply::error(status, message),
        };
        session.last_seq = seq;
        session.last_touched_ms = now_ms;

        let mut body = Map::new();
        body.insert("seq".into(), crate::js::js_number_value(seq));
        body.insert("op_count".into(), Json::from(session.op_log.len()));
        if resumed_now {
            body.insert("resumed".into(), Json::Bool(true));
        }
        body.insert(
            "replay_proof".into(),
            Json::String(replay_proof_for_session(
                secret_root,
                &identity.canonical,
                session,
            )),
        );
        body.insert("replay_record".into(), session.replay_record());
        if let Json::Object(view) = outcome {
            for (key, value) in view {
                body.insert(key, value);
            }
        }
        SessionReply::ok(Json::Object(body))
    }

    /// Produce the unsigned, human-readable result plus the 111-byte codec in
    /// base64 by REPLAYING the authenticated op-log with its recorded timing
    /// through the engine. For the kernel lane the host signs stable JSON
    /// `{ "result_bytes_base64": ... }` through its worker custody role; the
    /// direct lane returns a `finalize_proof` the client seals into the
    /// on-chain finalize payload so the kernel lane settles the same elapsed
    /// time the player saw. The kernel lane settles one chain request per
    /// session: its requester must be the session player, its first success
    /// consumes the session, and only a retry of that request is answered
    /// again, with the same bytes.
    pub fn finalize(
        &mut self,
        payload: &Json,
        secret_root: &[u8; 32],
        now_ms: f64,
        lane: FinalizeLane,
    ) -> SessionReply {
        let (identity, engine) = match load_identity_and_engine(payload) {
            Ok(value) => value,
            Err(message) => return SessionReply::error(400, message),
        };
        let kernel_request_id = match &lane {
            FinalizeLane::Direct => None,
            FinalizeLane::Kernel(request) => match bind_kernel_request(&identity, request) {
                Ok(request_id) => Some(request_id),
                Err((status, message)) => return SessionReply::error(status, message),
            },
        };
        let kernel = kernel_request_id.is_some();
        let settled = self.settlement_of(&identity.canonical, now_ms);
        if let Some(settled) = &settled {
            if kernel_request_id.as_deref() != Some(settled.request_id.as_str()) {
                return SessionReply::error(
                    409,
                    format!(
                        "session already settled by kernel request {}",
                        settled.request_id
                    ),
                );
            }
        }
        let problem_secret = problem_secret_for(secret_root, &identity.canonical);
        if let Err((status, message)) = self.resolve_session(
            &identity,
            engine,
            problem_secret,
            payload,
            secret_root,
            now_ms,
        ) {
            return SessionReply::error(status, message);
        }

        let targets = self.effective_targets(engine);
        let session = self
            .sessions
            .get_mut(&identity.canonical)
            .expect("live or rebuilt session");
        if kernel && now_ms - session.started_at_ms > MAX_SETTLE_AGE_MS {
            return SessionReply::error(410, "session is too old to settle");
        }

        // A cached/rebuilt frozen result must not bypass validation of a
        // caller-supplied timing claim. Validate before selecting cached time.
        if kernel
            && (payload.get("elapsed_ms").is_some() || payload.get("finalize_proof").is_some())
        {
            let claimed = payload.get("elapsed_ms").map(crate::js::js_to_number);
            let valid = claimed.is_some_and(|claimed| {
                claimed.is_finite()
                    && claimed >= 0.0
                    && claimed.fract() == 0.0
                    && session
                        .finalized_elapsed_ms
                        .is_none_or(|frozen| frozen == claimed)
                    && verify_finalize_proof(
                        secret_root,
                        &identity.canonical,
                        session,
                        claimed,
                        payload.get("finalize_proof"),
                    )
            });
            if !valid {
                return SessionReply::error(401, "invalid finalize proof");
            }
        }

        let elapsed_ms = if !kernel {
            session
                .finalized_elapsed_ms
                .unwrap_or_else(|| (now_ms - session.started_at_ms).trunc().max(0.0))
        } else {
            match session.finalized_elapsed_ms {
                Some(frozen) => frozen,
                None => {
                    let claimed = payload.get("elapsed_ms").map(crate::js::js_to_number);
                    match claimed {
                        Some(claimed) if claimed.is_finite() => {
                            if !verify_finalize_proof(
                                secret_root,
                                &identity.canonical,
                                session,
                                claimed,
                                payload.get("finalize_proof"),
                            ) {
                                return SessionReply::error(401, "invalid finalize proof");
                            }
                            claimed.trunc().max(0.0)
                        }
                        // No previewed elapsed time: the last accepted op is
                        // the latest moment the enclave can vouch for.
                        _ => session.last_op_elapsed_ms(),
                    }
                }
            }
        };
        session.last_touched_ms = now_ms;

        let window = engine.descriptor.time_window;
        let mut disqualified: Option<(u16, String)> = None;
        if elapsed_ms < window.min_solve_ms[identity.difficulty as usize] {
            disqualified = Some((403, "solved too fast".into()));
        } else if elapsed_ms > window.limit_ms[identity.difficulty as usize] {
            disqualified = Some((403, "time limit exceeded".into()));
        } else if let Some(message) = behavioral_gate_error(session, engine) {
            disqualified = Some((403, message.into()));
        }

        let commitment = commitment_for(&identity.canonical, &problem_secret);
        let scored = if let Some(reason) = disqualified {
            Err(reason)
        } else {
            match replay_for_score(engine, session) {
                Err(message) => {
                    // The recorded ops were accepted live; a divergent replay
                    // is an engine determinism bug, never a player outcome.
                    return SessionReply::error(500, format!("replay diverged: {message}"));
                }
                Ok(state) => (engine.score)(
                    &state,
                    identity.difficulty,
                    &ScoreExtra {
                        answer: payload.get("answer").cloned(),
                        elapsed_ms: Some(elapsed_ms),
                        started_at_ms: Some(session.started_at_ms),
                        now_ms: Some(now_ms),
                        target_override: Some(targets[identity.difficulty as usize]),
                    },
                )
                .map_err(|rejection| (rejection.status, rejection.message)),
            }
        };

        let (answer_hash, score, score_field, solved, rejection) = match scored {
            Ok(outcome) => (
                outcome.answer_hash,
                outcome.score,
                outcome.score_field,
                true,
                None,
            ),
            Err((status, message)) if !kernel => return SessionReply::error(status, message),
            Err((403, message)) => (loss_answer_hash(session), 0, None, false, Some(message)),
            // Malformed input / engine bug: the run cannot be judged, so the
            // fulfillment fails and the contract refunds the entry.
            Err((status, message)) => return SessionReply::error(status, message),
        };

        let binding = match result_binding(&identity.app_id, &identity.game_id, &identity.player) {
            Ok(binding) => binding,
            Err(message) => return SessionReply::error(500, message),
        };
        let result_bytes = match build_result_bytes(
            &commitment,
            &answer_hash,
            elapsed_ms,
            session.undos,
            score,
            identity.difficulty,
            &binding,
        ) {
            Ok(bytes) => bytes,
            Err(message) => return SessionReply::error(500, message),
        };

        // Consume the session for this kernel request. A retry of the same
        // request must reproduce the settled bytes exactly.
        let mut settlement = None;
        if let Some(request_id) = kernel_request_id {
            let result_digest = super::sha256_digest(&result_bytes);
            if let Some(settled) = &settled {
                if settled.result_digest != result_digest {
                    return SessionReply::error(
                        409,
                        format!(
                            "kernel request {} already settled a different result",
                            settled.request_id
                        ),
                    );
                }
            }
            self.generation = self.generation.wrapping_add(1);
            let record = Settlement {
                request_id,
                result_digest,
                started_at_ms: session.started_at_ms,
                generation: self.generation,
            };
            session.settled_by = Some(record.clone());
            settlement = Some(record);
        }
        let result_bytes_base64 = base64::engine::general_purpose::STANDARD.encode(result_bytes);

        let mut body = Map::new();
        body.insert(
            "result_bytes_base64".into(),
            Json::String(result_bytes_base64),
        );
        body.insert(
            "callback_encoding".into(),
            Json::String(RESULT_CALLBACK_ENCODING.into()),
        );
        body.insert(
            "problem_hash".into(),
            Json::String(super::hex_encode(&commitment)),
        );
        body.insert(
            "answer_hash".into(),
            Json::String(super::hex_encode(&answer_hash)),
        );
        body.insert("binding".into(), Json::String(super::hex_encode(&binding)));
        body.insert("elapsed_ms".into(), crate::js::js_number_value(elapsed_ms));
        body.insert("undos".into(), Json::from(session.undos));
        body.insert("score".into(), Json::from(score));
        body.insert("difficulty".into(), Json::from(identity.difficulty));
        body.insert("solved".into(), Json::Bool(solved));
        body.insert("op_count".into(), Json::from(session.op_log.len()));
        if let Some(message) = rejection {
            body.insert("rejection".into(), Json::String(message));
        }
        if let Some(Json::Object(score_field)) = score_field {
            for (key, value) in score_field {
                body.insert(key, value);
            }
        }
        if !kernel {
            // Freeze the run: later steps are refused and the kernel lane
            // settles exactly this elapsed time.
            session.finalized_elapsed_ms = Some(elapsed_ms);
            body.insert(
                "finalize_proof".into(),
                Json::String(finalize_proof_for(
                    secret_root,
                    &identity.canonical,
                    session,
                    elapsed_ms,
                )),
            );
            body.insert(
                "replay_proof".into(),
                Json::String(replay_proof_for_session(
                    secret_root,
                    &identity.canonical,
                    session,
                )),
            );
            body.insert("replay_record".into(), session.replay_record());
        }
        if let Some(record) = settlement {
            self.record_settlement(&identity.canonical, record, now_ms);
        }
        SessionReply::ok(Json::Object(body))
    }

    /// The kernel request that consumed this identity's session, if any —
    /// from the live session first, then from the settled-session records.
    /// A record past `MAX_SETTLE_AGE_MS` is spent: its session can neither
    /// settle nor be rebuilt any more, so it no longer answers.
    fn settlement_of(&mut self, canonical: &str, now_ms: f64) -> Option<Settlement> {
        if let Some(settled) = self
            .sessions
            .get(canonical)
            .and_then(|session| session.settled_by.clone())
        {
            return Some(settled);
        }
        let key = settled_key(canonical);
        let settled = self.settled.get(&key)?;
        if now_ms - settled.started_at_ms > MAX_SETTLE_AGE_MS {
            self.settled.remove(&key);
            return None;
        }
        Some(settled.clone())
    }

    fn record_settlement(&mut self, canonical: &str, record: Settlement, now_ms: f64) {
        self.prune_settled(now_ms);
        let key = settled_key(canonical);
        while !self.settled.contains_key(&key) && self.settled.len() >= self.settled_capacity {
            let Some(oldest) = self
                .settled
                .iter()
                .min_by_key(|(_, settled)| settled.generation)
                .map(|(key, _)| *key)
            else {
                break;
            };
            self.settled.remove(&oldest);
        }
        self.settled.insert(key, record);
    }

    /// Drop spent records (see [`Self::settlement_of`]). Runs only when a
    /// record is added, so lookups stay constant-time.
    fn prune_settled(&mut self, now_ms: f64) {
        self.settled
            .retain(|_, settled| now_ms - settled.started_at_ms <= MAX_SETTLE_AGE_MS);
    }

    fn effective_targets(&self, engine: &'static EngineHandle) -> [f64; 3] {
        self.target_overrides
            .get(engine.app_id)
            .copied()
            .unwrap_or_else(|| engine.descriptor.targets.map(|target| target as f64))
    }

    /// Live session: verify the bearer token. Missing session: rebuild from the
    /// authenticated resume record. Returns whether a rebuild happened.
    fn resolve_session(
        &mut self,
        identity: &SessionIdentity,
        engine: &'static EngineHandle,
        problem_secret: [u8; 32],
        payload: &Json,
        secret_root: &[u8; 32],
        now_ms: f64,
    ) -> Result<bool, (u16, String)> {
        if let Some(session) = self.sessions.get(&identity.canonical) {
            if !verify_session_token(session, payload.get("session_token")) {
                return Err((401, "invalid session token".into()));
            }
            return Ok(false);
        }
        if payload.get("replay_proof").is_none() {
            return Err((
                404,
                "unknown session — an authenticated replay record is required to resume".into(),
            ));
        }
        self.rebuild_session(
            identity,
            engine,
            problem_secret,
            payload,
            secret_root,
            now_ms,
        )?;
        Ok(true)
    }

    fn enforce_player_quota(
        &mut self,
        identity: &SessionIdentity,
        now_ms: f64,
    ) -> Result<(), String> {
        self.prune_sessions(now_ms);
        let key = identity.player_key();
        let live = self
            .sessions
            .values()
            .filter(|session| session.player_key == key)
            .count();
        if live >= MAX_SESSIONS_PER_PLAYER {
            return Err(format!(
                "too many live sessions for this player (max {MAX_SESSIONS_PER_PLAYER})"
            ));
        }
        Ok(())
    }

    fn create_session(
        &mut self,
        identity: &SessionIdentity,
        engine: &'static EngineHandle,
        problem_secret: [u8; 32],
        started_at_ms: f64,
        session_token: String,
        resumed: bool,
    ) -> Session {
        self.prune_sessions(started_at_ms.max(0.0));
        let (engine_state, start_view) = (engine.deal)(&problem_secret, identity.difficulty);
        self.generation = self.generation.wrapping_add(1);
        Session {
            app_id: identity.app_id.clone(),
            engine_hash: engine.engine_hash.to_string(),
            difficulty: identity.difficulty,
            player_key: identity.player_key(),
            problem_secret,
            session_token,
            started_at_ms,
            last_touched_ms: started_at_ms,
            last_seq: -1.0,
            undos: 0,
            resumed,
            finalized_elapsed_ms: None,
            settled_by: None,
            op_timestamps: Vec::new(),
            op_log: Vec::new(),
            engine_state,
            last_view: start_view,
            generation: self.generation,
        }
    }

    /// Rebuild an evicted session from `replay` (ops), `replay_record`
    /// (`started_at_ms` + per-op elapsed), `session_token` and the
    /// `replay_proof` HMAC that binds all three. Every op is re-applied with
    /// its recorded timing, so timing-sensitive engines (flappy frames, pet
    /// action spacing) and the finalize gates see the original run.
    fn rebuild_session(
        &mut self,
        identity: &SessionIdentity,
        engine: &'static EngineHandle,
        problem_secret: [u8; 32],
        payload: &Json,
        secret_root: &[u8; 32],
        now_ms: f64,
    ) -> Result<(), (u16, String)> {
        let empty = Vec::new();
        let ops = payload
            .get("replay")
            .and_then(Json::as_array)
            .unwrap_or(&empty);
        if ops.len() as u64 > engine.descriptor.max_ops {
            return Err((400, "replay log too long".into()));
        }
        let record = payload.get("replay_record");
        let started_at_ms = record
            .and_then(|record| record.get("started_at_ms"))
            .map(crate::js::js_to_number)
            .unwrap_or(f64::NAN);
        let elapsed: Vec<f64> = record
            .and_then(|record| record.get("op_elapsed_ms"))
            .and_then(Json::as_array)
            .map(|items| items.iter().map(crate::js::js_to_number).collect())
            .unwrap_or_default();
        let token = crate::js::js_trim_string(payload.get("session_token")).to_lowercase();
        if !is_hex_of_length(&token, 64) {
            return Err((401, "invalid or missing session token".into()));
        }
        if !verify_replay_proof(
            secret_root,
            &identity.canonical,
            &token,
            started_at_ms,
            ops,
            &elapsed,
            payload.get("replay_proof"),
        ) {
            return Err((401, "invalid or missing authenticated replay proof".into()));
        }
        // The proof authenticates the record; these are integrity checks on
        // the host's own earlier output, not on the player.
        if !started_at_ms.is_finite() || started_at_ms < 0.0 || started_at_ms > now_ms {
            return Err((400, "replay record start time is out of range".into()));
        }
        // No session older than this can settle, and a consumed one is only
        // remembered this long: past it the record must not rebuild anything.
        if now_ms - started_at_ms > MAX_SETTLE_AGE_MS {
            return Err((410, "session is too old to resume".into()));
        }
        if elapsed.len() != ops.len() {
            return Err((400, "replay record does not match the replay log".into()));
        }
        let mut previous = 0.0;
        for value in &elapsed {
            if !value.is_finite() || *value < previous || started_at_ms + *value > now_ms {
                return Err((400, "replay record timing is not monotonic".into()));
            }
            previous = *value;
        }

        let mut session =
            self.create_session(identity, engine, problem_secret, started_at_ms, token, true);
        session.last_touched_ms = now_ms;
        for (index, op) in ops.iter().enumerate() {
            let at_ms = started_at_ms + elapsed[index];
            match apply_session_op(&mut session, engine, Some(op), at_ms) {
                Ok(view) if view.get("ok").and_then(Json::as_bool) != Some(false) => {}
                Ok(_) | Err(_) => {
                    return Err((400, format!("invalid replay op at index {index}")));
                }
            }
        }
        self.sessions.insert(identity.canonical.clone(), session);
        Ok(())
    }

    fn prune_sessions(&mut self, now_ms: f64) {
        self.sessions
            .retain(|_, session| now_ms - session.last_touched_ms <= SESSION_TTL_MS);
        while self.sessions.len() >= MAX_SESSIONS {
            let Some(oldest) = self
                .sessions
                .iter()
                .min_by_key(|(_, session)| session.generation)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.sessions.remove(&oldest);
        }
    }
}

pub fn parse_identity(payload: &Json) -> Result<SessionIdentity, String> {
    let app_id = crate::js::js_trim_string(payload.get("app_id")).to_lowercase();
    if !super::registry::is_registered_app(&app_id) {
        return Err(format!(
            "app_id must be one of: {}",
            registered_app_ids().join(", ")
        ));
    }
    let network = crate::js::js_trim_string(payload.get("network")).to_lowercase();
    if network != "mainnet" && network != "testnet" {
        return Err("network must be mainnet or testnet".into());
    }
    let contract_hash = normalize_hash160(payload.get("contract_hash"), "contract_hash")?;
    let player_value = payload
        .get("player")
        .filter(|value| !value.is_null())
        .or_else(|| payload.get("player_hash160_hex"));
    let player = normalize_hash160(player_value, "player")?;

    let game_id_raw = crate::js::js_trim_string(payload.get("game_id"));
    if game_id_raw.is_empty()
        || game_id_raw.len() > 78
        || !game_id_raw.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("game_id must be a decimal string".into());
    }
    let game_id = BigUint::parse_bytes(game_id_raw.as_bytes(), 10)
        .ok_or_else(|| "game_id must be a decimal string".to_string())?;
    if game_id.bits() > 256 {
        return Err("game_id overflows uint256".into());
    }
    let game_id = game_id.to_str_radix(10);

    let difficulty = payload
        .get("difficulty")
        .map(crate::js::js_to_number)
        .unwrap_or(f64::NAN);
    if !difficulty.is_finite() || difficulty.fract() != 0.0 || !(0.0..=2.0).contains(&difficulty) {
        return Err("difficulty must be an integer 0..2".into());
    }
    let difficulty = difficulty as u8;
    let canonical = format!("{app_id}|{network}|{contract_hash}|{game_id}|{player}|{difficulty}");
    Ok(SessionIdentity {
        app_id,
        network,
        contract_hash,
        player,
        game_id,
        difficulty,
        canonical,
    })
}

fn load_identity_and_engine(
    payload: &Json,
) -> Result<(SessionIdentity, &'static EngineHandle), String> {
    let identity = parse_identity(payload)?;
    let engine = resolve_engine(&identity.app_id)?;
    let engine_hash = crate::js::js_trim_string(payload.get("engine_hash"));
    resolve_engine_by_hash(engine, Some(&engine_hash))?;
    Ok((identity, engine))
}

/// Validate both the canonical identity and the mandatory engine pin without
/// touching session state. Hosts use this before attempting confidential key
/// material release so malformed requests retain their protocol-level 400.
pub fn validate_identity_and_engine(payload: &Json) -> Result<SessionIdentity, String> {
    load_identity_and_engine(payload).map(|(identity, _)| identity)
}

/// `0x` + 40 lowercase hex, or the same 20 bytes in the opposite byte order
/// (both spellings of one script hash circulate in the fleet).
pub fn hash160_matches(expected: &str, candidate: &str) -> bool {
    let normalize = |value: &str| {
        value
            .trim()
            .to_lowercase()
            .trim_start_matches("0x")
            .to_string()
    };
    let expected = normalize(expected);
    let candidate = normalize(candidate);
    if expected.len() != 40 || candidate.len() != 40 {
        return false;
    }
    if expected == candidate {
        return true;
    }
    let reversed: String = (0..20)
        .rev()
        .map(|index| &candidate[index * 2..index * 2 + 2])
        .collect();
    expected == reversed
}

fn normalize_hash160(value: Option<&Json>, field_name: &str) -> Result<String, String> {
    let raw = crate::js::js_trim_string(value);
    let valid = raw.len() == 42
        && raw.starts_with("0x")
        && raw[2..].bytes().all(|byte| byte.is_ascii_hexdigit());
    if !valid {
        return Err(format!("{field_name} must be 0x-prefixed 40-char hex"));
    }
    Ok(raw.to_lowercase())
}

/// Bind a kernel-lane finalize to its chain request. The requester must BE
/// the session player in the same `0x` display spelling: unlike the witness
/// check, the reversed spelling is refused, because the result binding (and
/// the contract's record) is computed from exactly this spelling. Returns the
/// request id in canonical decimal form.
fn bind_kernel_request(
    identity: &SessionIdentity,
    request: &KernelRequest,
) -> Result<String, (u16, String)> {
    let request_id = request.request_id.trim();
    if request_id.is_empty()
        || request_id.len() > 78
        || !request_id.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err((400, "kernel request_id must be a decimal string".into()));
    }
    let request_id = BigUint::parse_bytes(request_id.as_bytes(), 10)
        .map(|id| id.to_str_radix(10))
        .ok_or_else(|| {
            (
                400,
                "kernel request_id must be a decimal string".to_string(),
            )
        })?;
    let requester = request.requester.trim().to_lowercase();
    let requester = requester.strip_prefix("0x").unwrap_or(&requester);
    if !is_hex_of_length(requester, 40) {
        return Err((400, "kernel requester must be a 20-byte script hash".into()));
    }
    if identity.player.strip_prefix("0x") != Some(requester) {
        return Err((403, "kernel requester is not the session player".into()));
    }
    Ok(request_id)
}

/// Settled-session records are keyed by a digest, not the canonical text,
/// to bound their memory.
fn settled_key(canonical: &str) -> [u8; 32] {
    super::sha256_digest(canonical.as_bytes())
}

// ---------------------------------------------------------------------------
// Player witness — the wallet's signMessage over the session canonical
// ---------------------------------------------------------------------------

/// The message the wallet signs for a session identity.
pub fn witness_message_for(canonical: &str) -> String {
    format!("{WITNESS_MESSAGE_PREFIX}{canonical}")
}

/// NEP dAPI `signMessage` framing: the wallet signs
/// `sha256(0x01 0x00 0x01 0xf0 ‖ varbytes(utf8(salt ‖ message)) ‖ 0x00 0x00)`
/// with its secp256r1 account key. Salt-less wallets sign with an empty salt.
pub fn witness_digest(salt: &str, message: &str) -> [u8; 32] {
    let mut body = Vec::with_capacity(salt.len() + message.len());
    body.extend_from_slice(salt.as_bytes());
    body.extend_from_slice(message.as_bytes());
    let mut framed = vec![0x01, 0x00, 0x01, 0xf0];
    push_var_bytes(&mut framed, &body);
    framed.extend_from_slice(&[0x00, 0x00]);
    super::sha256_digest(&framed)
}

fn push_var_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    let length = bytes.len();
    if length < 0xfd {
        out.push(length as u8);
    } else if length <= 0xffff {
        out.push(0xfd);
        out.extend_from_slice(&(length as u16).to_le_bytes());
    } else {
        out.push(0xfe);
        out.extend_from_slice(&(length as u32).to_le_bytes());
    }
    out.extend_from_slice(bytes);
}

/// Verify `player_witness = { public_key, signature, salt? }` against the
/// identity: valid secp256r1 signature over the witness digest AND the public
/// key hashes to `identity.player`.
pub fn verify_player_witness(
    identity: &SessionIdentity,
    witness: Option<&Json>,
) -> Result<(), String> {
    let Some(witness) = witness.filter(|value| value.is_object()) else {
        return Err("player_witness is required".into());
    };
    let public_key_hex = crate::js::js_trim_string(witness.get("public_key")).to_lowercase();
    let signature_hex = crate::js::js_trim_string(
        witness
            .get("signature")
            .filter(|value| !value.is_null())
            .or_else(|| witness.get("data")),
    )
    .to_lowercase();
    let salt = crate::js::js_trim_string(witness.get("salt"));
    let public_key = hex_decode(&public_key_hex)
        .filter(|bytes| bytes.len() == 33 && matches!(bytes[0], 0x02 | 0x03))
        .ok_or_else(|| {
            "player_witness.public_key must be a compressed secp256r1 key".to_string()
        })?;
    let signature = hex_decode(&signature_hex)
        .filter(|bytes| bytes.len() == 64)
        .ok_or_else(|| "player_witness.signature must be 64 bytes of hex".to_string())?;

    let script_hash = neo_os_core::n3_tx::script_hash_from_public_key(&public_key)
        .ok_or_else(|| "player_witness.public_key is not a valid Neo account key".to_string())?;
    if !hash160_matches(&identity.player, &super::hex_encode(&script_hash)) {
        return Err("player_witness does not belong to the session player".into());
    }

    let verifying_key = VerifyingKey::from_sec1_bytes(&public_key)
        .map_err(|_| "player_witness.public_key is not on secp256r1".to_string())?;
    let signature = Signature::from_slice(&signature)
        .map_err(|_| "player_witness.signature is malformed".to_string())?;
    let digest = witness_digest(&salt, &witness_message_for(&identity.canonical));
    verifying_key
        .verify_prehash(&digest, &signature)
        .map_err(|_| "player_witness signature does not verify".to_string())
}

fn hex_decode(text: &str) -> Option<Vec<u8>> {
    let text = text.trim().trim_start_matches("0x");
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).ok())
        .collect()
}

fn is_hex_of_length(text: &str, length: usize) -> bool {
    text.len() == length && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

// ---------------------------------------------------------------------------
// HMAC-bound secrets and proofs
// ---------------------------------------------------------------------------

pub fn problem_secret_for(secret_root: &[u8; 32], canonical: &str) -> [u8; 32] {
    hmac_bytes(secret_root, canonical.as_bytes())
}

pub fn commitment_for(canonical: &str, problem_secret: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    hasher.update(b"|");
    hasher.update(problem_secret);
    hasher.finalize().into()
}

fn stable_digest(value: &Json) -> String {
    super::sha256_hex(
        neo_os_core::stable_stringify::stable_stringify(
            &neo_os_core::js_value::JsValue::from_json(value),
        )
        .as_bytes(),
    )
}

fn ops_digest(ops: &[Json]) -> String {
    stable_digest(&Json::Array(ops.to_vec()))
}

fn elapsed_digest(elapsed: &[f64]) -> String {
    stable_digest(&Json::Array(
        elapsed
            .iter()
            .map(|value| crate::js::js_number_value(value.trunc().max(0.0)))
            .collect(),
    ))
}

/// The resume-record proof: binds the session token, the original start time
/// and every accepted op with its server-assigned elapsed time.
pub fn replay_proof_for(
    secret_root: &[u8; 32],
    canonical: &str,
    session_token: &str,
    started_at_ms: f64,
    replay_ops: &[Json],
    op_elapsed_ms: &[f64],
) -> String {
    let label = format!(
        "replay|{canonical}|{session_token}|{}|{}|{}",
        crate::js::js_number_value(started_at_ms.trunc()),
        ops_digest(replay_ops),
        elapsed_digest(op_elapsed_ms)
    );
    super::hex_encode(&hmac_bytes(secret_root, label.as_bytes()))
}

fn replay_proof_for_session(secret_root: &[u8; 32], canonical: &str, session: &Session) -> String {
    replay_proof_for(
        secret_root,
        canonical,
        &session.session_token,
        session.started_at_ms,
        &session.op_log,
        &session.op_elapsed_ms(),
    )
}

#[allow(clippy::too_many_arguments)]
fn verify_replay_proof(
    secret_root: &[u8; 32],
    canonical: &str,
    session_token: &str,
    started_at_ms: f64,
    replay_ops: &[Json],
    op_elapsed_ms: &[f64],
    supplied: Option<&Json>,
) -> bool {
    if !started_at_ms.is_finite() || op_elapsed_ms.iter().any(|value| !value.is_finite()) {
        return false;
    }
    constant_time_equal(
        replay_proof_for(
            secret_root,
            canonical,
            session_token,
            started_at_ms,
            replay_ops,
            op_elapsed_ms,
        )
        .as_bytes(),
        crate::js::js_trim_string(supplied)
            .to_lowercase()
            .as_bytes(),
    )
}

/// The direct-lane finalize proof: the elapsed time the enclave froze for this
/// exact op-log, presented back through the sealed kernel payload.
fn finalize_proof_for(
    secret_root: &[u8; 32],
    canonical: &str,
    session: &Session,
    elapsed_ms: f64,
) -> String {
    finalize_proof_raw(
        secret_root,
        canonical,
        &session.session_token,
        elapsed_ms,
        &session.op_log,
        &session.op_elapsed_ms(),
    )
}

fn finalize_proof_raw(
    secret_root: &[u8; 32],
    canonical: &str,
    session_token: &str,
    elapsed_ms: f64,
    replay_ops: &[Json],
    op_elapsed_ms: &[f64],
) -> String {
    let label = format!(
        "final|{canonical}|{session_token}|{}|{}|{}",
        crate::js::js_number_value(elapsed_ms.trunc().max(0.0)),
        ops_digest(replay_ops),
        elapsed_digest(op_elapsed_ms)
    );
    super::hex_encode(&hmac_bytes(secret_root, label.as_bytes()))
}

fn verify_finalize_proof(
    secret_root: &[u8; 32],
    canonical: &str,
    session: &Session,
    elapsed_ms: f64,
    supplied: Option<&Json>,
) -> bool {
    constant_time_equal(
        finalize_proof_for(secret_root, canonical, session, elapsed_ms).as_bytes(),
        crate::js::js_trim_string(supplied)
            .to_lowercase()
            .as_bytes(),
    )
}

fn verify_session_token(session: &Session, supplied: Option<&Json>) -> bool {
    constant_time_equal(
        session.session_token.as_bytes(),
        crate::js::js_trim_string(supplied)
            .to_lowercase()
            .as_bytes(),
    )
}

fn loss_answer_hash(session: &Session) -> [u8; 32] {
    super::sha256_digest(format!("loss|{}", ops_digest(&session.op_log)).as_bytes())
}

fn hmac_bytes(secret_root: &[u8; 32], input: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(secret_root).expect("HMAC accepts any key length");
    mac.update(input);
    mac.finalize().into_bytes().into()
}

fn constant_time_equal(expected: &[u8], supplied: &[u8]) -> bool {
    if expected.len() != supplied.len() {
        return false;
    }
    expected
        .iter()
        .zip(supplied)
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

// ---------------------------------------------------------------------------
// Op application and replay-based scoring
// ---------------------------------------------------------------------------

fn op_meta_at(session: &Session, at_ms: f64) -> OpMeta {
    OpMeta {
        problem_secret: session.problem_secret,
        difficulty: session.difficulty,
        now_ms: Some(at_ms),
        started_at_ms: Some(session.started_at_ms),
        elapsed_ms: Some((at_ms - session.started_at_ms).max(0.0)),
        resumed: false,
        op_index: session.op_log.len(),
    }
}

/// Apply one op at enclave time `at_ms`, recording it (and its timestamp) when
/// the engine accepts it. Live steps pass `now_ms`; rebuilds pass the
/// authenticated recorded time so the engine sees the original run.
fn apply_session_op(
    session: &mut Session,
    engine: &'static EngineHandle,
    op: Option<&Json>,
    at_ms: f64,
) -> Result<Json, (u16, String)> {
    let Some(Json::Object(_)) = op else {
        return Err((400, "op object required".into()));
    };
    let op = op.expect("object checked above");
    let op_type = crate::js::js_trim_string(op.get("type"));
    let meta = op_meta_at(session, at_ms);

    if op_type == "undo" {
        if session.undos >= engine.descriptor.max_undos {
            return Err((409, "undo limit reached".into()));
        }
        let outcome = (engine.apply_undo)(&mut session.engine_state, &meta);
        let view = outcome_view(outcome)?;
        session.undos += 1;
        session.op_log.push(serde_json::json!({ "type": "undo" }));
        session.op_timestamps.push(at_ms);
        let mut view = match view {
            Json::Object(view) => view,
            _ => Map::new(),
        };
        view.insert("undos".into(), Json::from(session.undos));
        session.last_view = Json::Object(view.clone());
        return Ok(Json::Object(view));
    }

    if session.op_log.len() as u64 >= engine.descriptor.max_ops {
        return Err((409, "op log limit reached".into()));
    }
    let outcome = (engine.apply_op)(&mut session.engine_state, op, &meta);
    let view = outcome_view(outcome)?;
    if view.get("ok").and_then(Json::as_bool) != Some(false) {
        session.op_log.push(op.clone());
        session.op_timestamps.push(at_ms);
    }
    session.last_view = view.clone();
    Ok(view)
}

fn outcome_view(outcome: OpOutcome) -> Result<Json, (u16, String)> {
    match outcome {
        OpOutcome::Rejected { message, status } => Err((status, message)),
        OpOutcome::View(view) => Ok(view),
    }
}

/// The single scoring path: re-deal from the problem secret and replay the
/// authenticated op-log with its recorded timing through the engine ABI. The
/// result is a fresh state derived solely from `(secret, ops, timings)` — the
/// cached `engine_state` is never scored.
fn replay_for_score(engine: &'static EngineHandle, session: &Session) -> Result<Json, String> {
    let (mut state, _) = (engine.deal)(&session.problem_secret, session.difficulty);
    if session.op_log.len() != session.op_timestamps.len() {
        return Err("op log and timing record diverge".into());
    }
    for (index, (op, at_ms)) in session
        .op_log
        .iter()
        .zip(session.op_timestamps.iter())
        .enumerate()
    {
        let meta = OpMeta {
            problem_secret: session.problem_secret,
            difficulty: session.difficulty,
            now_ms: Some(*at_ms),
            started_at_ms: Some(session.started_at_ms),
            elapsed_ms: Some((at_ms - session.started_at_ms).max(0.0)),
            resumed: false,
            op_index: index,
        };
        let outcome = if crate::js::js_trim_string(op.get("type")) == "undo" {
            (engine.apply_undo)(&mut state, &meta)
        } else {
            (engine.apply_op)(&mut state, op, &meta)
        };
        if outcome.is_rejected() || outcome.view_ok_false() {
            return Err(format!("invalid replay op at index {index}"));
        }
    }
    Ok(state)
}

fn behavioral_gate_error(session: &Session, engine: &'static EngineHandle) -> Option<&'static str> {
    let timestamps = &session.op_timestamps;
    let min_median = engine.descriptor.gates.min_median_interval_ms;
    if min_median.is_finite() && timestamps.len() >= 2 {
        let mut intervals = timestamps
            .windows(2)
            .map(|pair| pair[1] - pair[0])
            .collect::<Vec<_>>();
        intervals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
        let m = intervals.len() / 2;
        let median = if intervals.len() % 2 == 1 {
            intervals[m]
        } else {
            (intervals[m - 1] + intervals[m]) / 2.0
        };
        if median < min_median {
            return Some("median inter-op interval below the human floor");
        }
    }
    let max_burst = engine.descriptor.gates.max_burst_ops_per_sec;
    if max_burst.is_finite() {
        let mut low = 0usize;
        for high in 0..timestamps.len() {
            while timestamps[high] - timestamps[low] > 1_000.0 {
                low += 1;
            }
            if (high - low + 1) as f64 > max_burst {
                return Some("sustained op burst exceeds the human rate cap");
            }
        }
    }
    // The median floor applies to resumed sessions too: the rebuild restored
    // the original op timing from the authenticated resume record.
    let min_median = engine.descriptor.gates.min_median_interval_ms;
    if min_median.is_finite() && timestamps.len() >= 2 {
        let mut intervals = timestamps
            .windows(2)
            .map(|pair| pair[1] - pair[0])
            .collect::<Vec<_>>();
        intervals.sort_by(|left, right| left.partial_cmp(right).unwrap_or(Ordering::Equal));
        let middle = intervals.len() / 2;
        let median = if intervals.len() % 2 == 1 {
            intervals[middle]
        } else {
            (intervals[middle - 1] + intervals[middle]) / 2.0
        };
        if median < min_median {
            return Some("median inter-op interval below the human floor");
        }
    }
    None
}

/// The result binding: `sha256(domain ‖ sha256(utf8(app_id)) ‖
/// uint256_be(game_id) ‖ player)`, where `player` is the 20-byte UInt160 in
/// the order PlatformGame stores it (the `0x` display hex, byte-reversed).
/// The contract recomputes it from its own game record, so a result settles
/// only the game it was played for. `game_id` is the canonical decimal of
/// [`SessionIdentity::game_id`].
pub fn result_binding(app_id: &str, game_id: &str, player: &str) -> Result<[u8; 32], String> {
    let game_id = BigUint::parse_bytes(game_id.as_bytes(), 10)
        .ok_or_else(|| "game_id must be a decimal string".to_string())?
        .to_bytes_be();
    if game_id.len() > 32 {
        return Err("game_id overflows uint256".into());
    }
    let mut game = [0u8; 32];
    game[32 - game_id.len()..].copy_from_slice(&game_id);
    let player = player.trim().to_lowercase();
    let mut player = hex_decode(&player)
        .filter(|bytes| bytes.len() == 20)
        .ok_or_else(|| "player must be a 20-byte script hash".to_string())?;
    player.reverse();

    let mut hasher = Sha256::new();
    hasher.update(RESULT_BINDING_DOMAIN.as_bytes());
    hasher.update(super::sha256_digest(app_id.as_bytes()));
    hasher.update(game);
    hasher.update(&player);
    Ok(hasher.finalize().into())
}

/// Encode the contract's fixed, big-endian result, codec v2: the v1 fields
/// under tag `0x03`, followed by the 32-byte [`result_binding`].
pub fn build_result_bytes(
    commitment: &[u8],
    answer_hash: &[u8],
    elapsed_ms: f64,
    undos: u64,
    score: i64,
    difficulty: u8,
    binding: &[u8],
) -> Result<[u8; RESULT_BYTES_LENGTH], String> {
    let commitment: &[u8; 32] = commitment
        .try_into()
        .map_err(|_| "commitment must be 32 bytes".to_string())?;
    let answer_hash: &[u8; 32] = answer_hash
        .try_into()
        .map_err(|_| "answerHash must be 32 bytes".to_string())?;
    let binding: &[u8; 32] = binding
        .try_into()
        .map_err(|_| "binding must be 32 bytes".to_string())?;
    let elapsed_ms = elapsed_ms.trunc().max(0.0);
    if !elapsed_ms.is_finite() || elapsed_ms >= (u64::MAX as f64) + 1.0 {
        return Err("elapsedMs overflows uint64".into());
    }
    if undos > u8::MAX as u64 {
        return Err("undos out of range".into());
    }
    if !(0..=u32::MAX as i64).contains(&score) {
        return Err("score overflows uint32".into());
    }

    let mut out = [0u8; RESULT_BYTES_LENGTH];
    out[0] = RESULT_FINALIZE_TAG;
    out[1..33].copy_from_slice(commitment);
    out[33..65].copy_from_slice(answer_hash);
    out[65..73].copy_from_slice(&(elapsed_ms as u64).to_be_bytes());
    out[73] = undos as u8;
    out[74..78].copy_from_slice(&(score as u32).to_be_bytes());
    out[78] = difficulty;
    out[79..111].copy_from_slice(binding);
    Ok(out)
}

#[cfg(test)]
pub(crate) mod test_support {
    //! Deterministic player keys + witnesses for the session tests (and the
    //! enclave host's route tests, which include this module by path).
    use p256::ecdsa::signature::hazmat::PrehashSigner;
    use p256::ecdsa::SigningKey;
    use serde_json::Value as Json;

    pub struct TestPlayer {
        pub signing_key: SigningKey,
        pub public_key_hex: String,
        pub player_hex: String,
    }

    pub fn test_player(seed: u8) -> TestPlayer {
        let mut scalar = [seed; 32];
        scalar[0] = 0x11;
        let signing_key = SigningKey::from_slice(&scalar).expect("valid scalar");
        let public_key = signing_key.verifying_key().to_sec1_point(true);
        let public_key_hex = crate::hex_encode(public_key.as_bytes());
        let script_hash = neo_os_core::n3_tx::script_hash_from_public_key(public_key.as_bytes())
            .expect("script hash");
        TestPlayer {
            signing_key,
            public_key_hex,
            player_hex: format!("0x{}", crate::hex_encode(&script_hash)),
        }
    }

    pub fn witness_for(player: &TestPlayer, canonical: &str, salt: &str) -> Json {
        let digest = super::witness_digest(salt, &super::witness_message_for(canonical));
        let signature: p256::ecdsa::Signature =
            player.signing_key.sign_prehash(&digest).expect("sign");
        serde_json::json!({
            "public_key": player.public_key_hex,
            "signature": crate::hex_encode(&signature.to_bytes()),
            "salt": salt,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{test_player, witness_for, TestPlayer};
    use super::*;

    const ROOT: [u8; 32] = [9u8; 32];
    const TOKEN_A: [u8; 32] = [0xa1; 32];
    const TOKEN_B: [u8; 32] = [0xb2; 32];

    fn engine_hash(app_id: &str) -> &'static str {
        resolve_engine(app_id).expect("registered").engine_hash
    }

    fn identity_payload(app_id: &str, game_id: &str, player: &TestPlayer) -> Json {
        serde_json::json!({
            "app_id": app_id,
            "engine_hash": engine_hash(&app_id.trim().to_lowercase()),
            "network": "TESTNET",
            "contract_hash": "0xAABBCCDDEEFF0011223344556677889900AABBCC",
            "player": player.player_hex,
            "game_id": game_id,
            "difficulty": 0,
        })
    }

    fn witnessed(app_id: &str, game_id: &str, player: &TestPlayer) -> Json {
        let mut payload = identity_payload(app_id, game_id, player);
        let canonical = parse_identity(&payload).expect("identity").canonical;
        payload["player_witness"] = witness_for(player, &canonical, "salt-1");
        payload
    }

    fn open_cells(start: &SessionReply) -> Vec<usize> {
        start.body["view"]["clues"]
            .as_str()
            .expect("sudoku clues")
            .bytes()
            .enumerate()
            .filter_map(|(index, value)| (value == b'0').then_some(index))
            .collect()
    }

    /// The shared vectors, byte-identical to neo-os-contracts
    /// `contracts/__tests__/fixtures/game-result-v2.vectors.json`, which the
    /// PlatformGame suites feed to the contract.
    fn shared_vectors() -> Json {
        serde_json::from_str(include_str!("../tests/vectors/game-result-v2.vectors.json"))
            .expect("game-result-v2 vectors parse")
    }

    fn vector(name: &str) -> Json {
        shared_vectors()["vectors"]
            .as_array()
            .expect("vectors array")
            .iter()
            .find(|vector| vector["name"] == name)
            .unwrap_or_else(|| panic!("vector {name}"))
            .clone()
    }

    fn unhex(value: &Json) -> Vec<u8> {
        hex_decode(value.as_str().expect("hex string")).expect("valid hex")
    }

    fn kernel(request_id: &str, requester: &str) -> FinalizeLane {
        FinalizeLane::Kernel(KernelRequest {
            request_id: request_id.into(),
            requester: requester.into(),
        })
    }

    #[test]
    fn game_result_v2_vectors_encode_byte_identically() {
        let vectors = shared_vectors();
        assert_eq!(vectors["layout"]["length"], RESULT_BYTES_LENGTH);
        assert_eq!(vectors["binding"]["domain"], RESULT_BINDING_DOMAIN);
        let cases = vectors["vectors"].as_array().expect("vectors");
        assert_eq!(cases.len(), 4);
        for case in cases {
            let name = case["name"].as_str().expect("name");
            let binding = result_binding(
                case["appId"].as_str().expect("appId"),
                case["gameId"].as_str().expect("gameId"),
                case["player"].as_str().expect("player"),
            )
            .expect(name);
            assert_eq!(binding.to_vec(), unhex(&case["binding"]), "{name} binding");
            let bytes = build_result_bytes(
                &unhex(&case["commitment"]),
                &unhex(&case["answerHash"]),
                case["elapsedMs"].as_u64().expect("elapsedMs") as f64,
                case["undos"].as_u64().expect("undos"),
                case["score"].as_i64().expect("score"),
                case["difficulty"].as_u64().expect("difficulty") as u8,
                &binding,
            )
            .expect(name);
            assert_eq!(bytes.to_vec(), unhex(&case["result"]), "{name} bytes");
            assert_eq!(
                super::super::sha256_hex(&bytes),
                case["resultSha256"].as_str().expect("sha256"),
                "{name} digest"
            );
            assert_eq!(bytes[0], RESULT_FINALIZE_TAG);
        }
        // What the contract refuses is not something this crate can emit.
        for rejected in vectors["rejected"].as_array().expect("rejected") {
            let bytes = unhex(&rejected["result"]);
            assert!(
                bytes.len() != RESULT_BYTES_LENGTH || bytes[0] != RESULT_FINALIZE_TAG,
                "{}",
                rejected["name"]
            );
        }
        // A game id is a uint256; a player is exactly 20 bytes.
        let too_wide = (BigUint::from(1u8) << 256usize).to_string();
        assert_eq!(
            result_binding(
                "miniapp-sudoku",
                &too_wide,
                "0x63cd4ee2b08e54d2df1b5080db56e961df25ceca"
            )
            .unwrap_err(),
            "game_id overflows uint256"
        );
        assert!(result_binding("miniapp-sudoku", "1", "0x63cd").is_err());
        assert!(build_result_bytes(&[0; 32], &[0; 32], 0.0, 0, 0, 0, &[0; 31]).is_err());
    }

    #[test]
    fn identity_is_canonical_and_rejects_ambiguous_bounds() {
        let player = test_player(1);
        let parsed = parse_identity(&identity_payload(" MINIAPP-SUDOKU ", "00042", &player))
            .expect("valid identity");
        assert_eq!(parsed.game_id, "42");
        assert_eq!(parsed.network, "testnet");
        assert_eq!(
            parsed.contract_hash,
            "0xaabbccddeeff0011223344556677889900aabbcc"
        );
        assert_eq!(
            parsed.canonical,
            format!(
                "miniapp-sudoku|testnet|0xaabbccddeeff0011223344556677889900aabbcc|42|{}|0",
                player.player_hex
            )
        );

        let mut overflow = identity_payload(
            "miniapp-sudoku",
            &((BigUint::from(1u8)) << 256usize).to_string(),
            &player,
        );
        assert_eq!(
            parse_identity(&overflow).unwrap_err(),
            "game_id overflows uint256"
        );
        overflow["game_id"] = Json::String("9".repeat(79));
        assert_eq!(
            parse_identity(&overflow).unwrap_err(),
            "game_id must be a decimal string"
        );
        overflow["game_id"] = Json::String("1".into());
        overflow["difficulty"] = Json::from(1.5);
        assert_eq!(
            parse_identity(&overflow).unwrap_err(),
            "difficulty must be an integer 0..2"
        );
    }

    #[test]
    fn engine_hash_pin_is_mandatory() {
        let player = test_player(1);
        let mut payload = witnessed("miniapp-sudoku", "5", &player);
        payload["engine_hash"] = Json::String(String::new());
        let mut store = SessionStore::new();
        let reply = store.start(&payload, &ROOT, "03worker", 1_000.0, &TOKEN_A);
        assert_eq!(reply.status, 400);
        assert!(reply.body["error"]
            .as_str()
            .unwrap()
            .starts_with("engine_hash is required"));
        payload["engine_hash"] = Json::String("ff".repeat(32));
        let reply = store.start(&payload, &ROOT, "03worker", 1_000.0, &TOKEN_A);
        assert_eq!(reply.status, 400);
        assert!(reply.body["error"]
            .as_str()
            .unwrap()
            .contains("engine_hash mismatch"));
    }

    #[test]
    fn start_requires_a_witness_from_the_session_player() {
        let player = test_player(1);
        let other = test_player(2);
        let mut store = SessionStore::new();

        let unwitnessed = identity_payload("miniapp-sudoku", "7", &player);
        let reply = store.start(&unwitnessed, &ROOT, "03worker", 1_000.0, &TOKEN_A);
        assert_eq!(reply.status, 401);
        assert_eq!(reply.body["error"], "player_witness is required");

        // A valid signature from a different account is not the player.
        let mut forged = unwitnessed.clone();
        let canonical = parse_identity(&forged).expect("identity").canonical;
        forged["player_witness"] = witness_for(&other, &canonical, "");
        let reply = store.start(&forged, &ROOT, "03worker", 1_000.0, &TOKEN_A);
        assert_eq!(reply.status, 401);
        assert_eq!(
            reply.body["error"],
            "player_witness does not belong to the session player"
        );

        // The player's signature over a DIFFERENT canonical does not transfer.
        let mut replayed = unwitnessed.clone();
        replayed["player_witness"] = witness_for(&player, &format!("{canonical}x"), "");
        let reply = store.start(&replayed, &ROOT, "03worker", 1_000.0, &TOKEN_A);
        assert_eq!(reply.status, 401);
        assert_eq!(
            reply.body["error"],
            "player_witness signature does not verify"
        );

        // Salt-less wallets sign with an empty salt; salted ones carry it.
        for salt in ["", "0123456789abcdef"] {
            let mut good = unwitnessed.clone();
            good["player_witness"] = witness_for(&player, &canonical, salt);
            let reply = store.start(&good, &ROOT, "03worker", 1_000.0, &TOKEN_A);
            assert_eq!(reply.status, 200, "{}", reply.body);
        }
    }

    #[test]
    fn all_registered_engines_start_and_repeated_start_preserves_authoritative_state() {
        let player = test_player(3);
        let mut store = SessionStore::new();
        let mut tokens = std::collections::HashSet::new();
        for (index, app_id) in registered_app_ids().into_iter().enumerate() {
            let payload = witnessed(app_id, &(index + 1).to_string(), &player);
            let fresh = [index as u8 + 1; 32];
            let first = store.start(&payload, &ROOT, "03worker", 1_000.0, &fresh);
            assert_eq!(first.status, 200, "{app_id}: {}", first.body);
            assert!(first.body["commitment"]
                .as_str()
                .is_some_and(|v| v.len() == 64));
            assert_eq!(
                first.body["session_token"].as_str().unwrap(),
                super::super::hex_encode(&fresh)
            );
            assert!(tokens.insert(first.body["session_token"].clone()));
            assert_eq!(first.body["public_key"], "03worker");
            assert_eq!(first.body["config"]["app_id"], app_id);
            assert_eq!(first.body["replay_record"]["started_at_ms"], 1_000);

            // A repeated start keeps the token and the clock; the host's fresh
            // entropy for this call is discarded.
            let repeated = store.start(&payload, &ROOT, "03worker", 9_999.0, &TOKEN_B);
            assert_eq!(repeated.status, 200);
            assert_eq!(repeated.body["commitment"], first.body["commitment"]);
            assert_eq!(repeated.body["session_token"], first.body["session_token"]);
            assert_eq!(repeated.body["replay_record"]["started_at_ms"], 1_000);
            assert_eq!(repeated.body["op_count"], 0);
        }
    }

    #[test]
    fn per_player_live_session_quota_is_enforced() {
        let player = test_player(4);
        let mut store = SessionStore::new();
        for game in 1..=MAX_SESSIONS_PER_PLAYER {
            let payload = witnessed("miniapp-flappy-dash", &game.to_string(), &player);
            assert_eq!(
                store
                    .start(&payload, &ROOT, "03w", 1_000.0, &TOKEN_A)
                    .status,
                200
            );
        }
        let overflow = witnessed("miniapp-flappy-dash", "999", &player);
        let reply = store.start(&overflow, &ROOT, "03w", 1_000.0, &TOKEN_A);
        assert_eq!(reply.status, 429, "{}", reply.body);
        // Another player is unaffected.
        let other = witnessed("miniapp-flappy-dash", "1000", &test_player(5));
        assert_eq!(
            store.start(&other, &ROOT, "03w", 1_000.0, &TOKEN_B).status,
            200
        );
    }

    #[test]
    fn token_sequence_and_authenticated_resume_fail_closed() {
        let player = test_player(6);
        let payload = witnessed("miniapp-sudoku", "77", &player);
        let mut store = SessionStore::new();
        let start = store.start(&payload, &ROOT, "03worker", 10_000.0, &TOKEN_A);
        assert_eq!(start.status, 200, "{}", start.body);
        let token = start.body["session_token"].clone();
        let cells = open_cells(&start);

        // The old derivable token (HMAC of the canonical) is worthless now.
        let mut bad = payload.clone();
        bad["session_token"] = Json::String("00".repeat(32));
        bad["seq"] = Json::from(0);
        bad["op"] = serde_json::json!({ "type": "place", "cell": cells[0], "digit": 1 });
        assert_eq!(store.step(&bad, &ROOT, 11_000.0).status, 401);

        let mut step = bad;
        step["session_token"] = token.clone();
        // An engine rejection must not consume the sequence.
        step["op"] = Json::Null;
        assert_eq!(store.step(&step, &ROOT, 11_000.0).status, 400);
        step["op"] = serde_json::json!({ "type": "place", "cell": cells[0], "digit": 1 });
        let accepted = store.step(&step, &ROOT, 11_500.0);
        assert_eq!(accepted.status, 200, "{}", accepted.body);
        assert_eq!(
            accepted.body["replay_record"]["op_elapsed_ms"],
            serde_json::json!([1_500])
        );
        let stale = store.step(&step, &ROOT, 12_000.0);
        assert_eq!(stale.status, 409);
        assert_eq!(stale.body["error"], "stale seq");
        let proof = accepted.body["replay_proof"].clone();
        let record = accepted.body["replay_record"].clone();

        // Eviction: a step without the resume record is unknown, with a
        // tampered record it is unauthenticated, with the real one it resumes
        // under the ORIGINAL clock.
        store.clear();
        let mut resume = payload.clone();
        resume["session_token"] = token.clone();
        resume["seq"] = Json::from(1);
        resume["op"] = serde_json::json!({ "type": "place", "cell": cells[1], "digit": 2 });
        assert_eq!(store.step(&resume, &ROOT, 20_000.0).status, 404);

        resume["replay"] = serde_json::json!([{ "type": "place", "cell": cells[0], "digit": 1 }]);
        resume["replay_record"] =
            serde_json::json!({ "started_at_ms": 19_000, "op_elapsed_ms": [1_500] });
        resume["replay_proof"] = proof.clone();
        assert_eq!(store.step(&resume, &ROOT, 20_000.0).status, 401);

        resume["replay_record"] = record;
        let resumed = store.step(&resume, &ROOT, 20_000.0);
        assert_eq!(resumed.status, 200, "{}", resumed.body);
        assert_eq!(resumed.body["resumed"], true);
        assert_eq!(resumed.body["replay_record"]["started_at_ms"], 10_000);
        assert_eq!(
            resumed.body["replay_record"]["op_elapsed_ms"],
            serde_json::json!([1_500, 10_000])
        );

        // Proof for one log cannot authenticate a different log.
        store.clear();
        resume["replay"] = serde_json::json!([{ "type": "forged" }]);
        assert_eq!(store.step(&resume, &ROOT, 21_000.0).status, 401);
    }

    fn solve_sudoku(
        store: &mut SessionStore,
        payload: &Json,
        token: &Json,
        start: &SessionReply,
        spacing_ms: f64,
    ) -> (Json, f64) {
        let identity = parse_identity(payload).expect("identity");
        let secret = problem_secret_for(&ROOT, &identity.canonical);
        let engine = resolve_engine("miniapp-sudoku").expect("engine");
        let (state, _) = (engine.deal)(&secret, 0);
        let solution = state["solution"].as_str().unwrap().to_string();
        let mut last = Json::Null;
        let mut now = 10_000.0;
        for (seq, cell) in open_cells(start).into_iter().enumerate() {
            now += spacing_ms;
            let mut step = payload.clone();
            step["session_token"] = token.clone();
            step["seq"] = Json::from(seq);
            step["op"] = serde_json::json!({
                "type": "place",
                "cell": cell,
                "digit": (solution.as_bytes()[cell] - b'0') as u64,
            });
            let reply = store.step(&step, &ROOT, now);
            assert_eq!(reply.status, 200, "{}", reply.body);
            last = reply.body;
        }
        (last, now)
    }

    /// The op-log `solve_sudoku` placed, in order.
    fn solved_ops(payload: &Json, start: &SessionReply) -> Vec<Json> {
        let identity = parse_identity(payload).unwrap();
        let secret = problem_secret_for(&ROOT, &identity.canonical);
        let engine = resolve_engine("miniapp-sudoku").unwrap();
        let (state, _) = (engine.deal)(&secret, 0);
        let solution = state["solution"].as_str().unwrap().to_string();
        open_cells(start)
            .into_iter()
            .map(|cell| serde_json::json!({ "type": "place", "cell": cell, "digit": (solution.as_bytes()[cell] - b'0') as u64 }))
            .collect()
    }

    /// The resume fields a sealed payload carries after eviction.
    fn resume_payload(payload: &Json, token: &Json, ops: Vec<Json>, proven: &Json) -> Json {
        let mut resume = payload.clone();
        resume["session_token"] = token.clone();
        resume["replay"] = Json::Array(ops);
        resume["replay_record"] = proven["replay_record"].clone();
        resume["replay_proof"] = proven["replay_proof"].clone();
        resume
    }

    #[test]
    fn finalize_scores_the_replayed_run_and_kernel_lane_settles_the_previewed_time() {
        let player = test_player(7);
        let payload = witnessed("miniapp-sudoku", "88", &player);
        let mut store = SessionStore::new();
        let start = store.start(&payload, &ROOT, "03worker", 10_000.0, &TOKEN_A);
        let token = start.body["session_token"].clone();
        let (_, now) = solve_sudoku(&mut store, &payload, &token, &start, 1_000.0);

        // Direct lane: the board derives from the placements (no answer),
        // the reply is a preview with a finalize proof, and the run freezes.
        let mut finalize = payload.clone();
        finalize["session_token"] = token.clone();
        let at = 10_000.0 + 95_000.0_f64.max(now - 10_000.0 + 1.0);
        let direct = store.finalize(&finalize, &ROOT, at, FinalizeLane::Direct);
        assert_eq!(direct.status, 200, "{}", direct.body);
        assert_eq!(direct.body["solved"], true);
        assert_eq!(direct.body["score"], 1);
        assert_eq!(
            direct.body["elapsed_ms"],
            crate::js::js_number_value(at - 10_000.0)
        );
        assert!(direct.body["finalize_proof"]
            .as_str()
            .is_some_and(|p| p.len() == 64));
        assert!(direct.body["signature"].is_null());
        let mut late = payload.clone();
        late["session_token"] = token.clone();
        late["seq"] = Json::from(999);
        late["op"] = serde_json::json!({ "type": "undo" });
        assert_eq!(store.step(&late, &ROOT, at + 1.0).status, 409);

        // Kernel lane after eviction: the sealed payload carries the resume
        // record + finalize proof and settles the SAME elapsed time.
        let mut sealed =
            resume_payload(&payload, &token, solved_ops(&payload, &start), &direct.body);
        sealed["elapsed_ms"] = direct.body["elapsed_ms"].clone();
        sealed["finalize_proof"] = direct.body["finalize_proof"].clone();

        // A forged elapsed time is rejected outright and consumes nothing.
        store.clear();
        let mut forged = sealed.clone();
        forged["elapsed_ms"] = Json::from(95_001);
        assert_eq!(
            store
                .finalize(
                    &forged,
                    &ROOT,
                    at + 600_000.0,
                    kernel("40", &player.player_hex)
                )
                .status,
            401
        );

        store.clear();
        let settled = store.finalize(
            &sealed,
            &ROOT,
            at + 600_000.0,
            kernel("41", &player.player_hex),
        );
        assert_eq!(settled.status, 200, "{}", settled.body);
        assert_eq!(settled.body["solved"], true);
        assert_eq!(settled.body["elapsed_ms"], direct.body["elapsed_ms"]);
        assert_eq!(
            settled.body["result_bytes_base64"],
            direct.body["result_bytes_base64"]
        );
        assert_eq!(settled.body["callback_encoding"], RESULT_CALLBACK_ENCODING);
        assert_eq!(
            settled.body["binding"],
            super::super::hex_encode(
                &result_binding("miniapp-sudoku", "88", &player.player_hex).unwrap()
            )
        );
    }

    #[test]
    fn kernel_lane_without_a_preview_settles_a_loss() {
        let player = test_player(7);
        let payload = witnessed("miniapp-sudoku", "87", &player);
        let mut store = SessionStore::new();
        let start = store.start(&payload, &ROOT, "03worker", 10_000.0, &TOKEN_A);
        let token = start.body["session_token"].clone();
        // Placements 1 s apart: the last one lands well under the 90 s floor.
        let (last_step, _) = solve_sudoku(&mut store, &payload, &token, &start, 1_000.0);
        let unpreviewed =
            resume_payload(&payload, &token, solved_ops(&payload, &start), &last_step);
        let at = 10_000.0 + 95_000.0;

        // The direct lane measures the enclave clock at finalize, not the last
        // op, so the same op-log is scored as a solve (200, solved), not
        // disqualified.
        store.clear();
        let direct = store.finalize(&unpreviewed, &ROOT, at, FinalizeLane::Direct);
        assert_eq!(direct.status, 200, "{}", direct.body);
        assert_eq!(direct.body["solved"], true);

        // Kernel lane without a preview: the last recorded op bounds the
        // elapsed time; it is below the floor, so the run is a LOSS result
        // (the contract settles it with payout 0), not a failed fulfillment.
        store.clear();
        let loss = store.finalize(&unpreviewed, &ROOT, at, kernel("51", &player.player_hex));
        assert_eq!(loss.status, 200, "{}", loss.body);
        assert_eq!(loss.body["solved"], false);
        assert_eq!(loss.body["score"], 0);
        assert_eq!(loss.body["rejection"], "solved too fast");
        assert_eq!(
            loss.body["elapsed_ms"],
            last_step["replay_record"]["op_elapsed_ms"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()
                .clone()
        );

        // Settled: the preview lane is closed too.
        let after = store.finalize(&unpreviewed, &ROOT, at, FinalizeLane::Direct);
        assert_eq!(after.status, 409, "{}", after.body);
    }

    /// Sudoku game 1 for test_player(7): 41 placements 500 ms apart ending at
    /// +41 000 ms, finalized at 60 000 ms without a preview.
    fn play_the_shared_loss(store: &mut SessionStore) -> (TestPlayer, Json) {
        let player = test_player(7);
        let payload = witnessed("miniapp-sudoku", "1", &player);
        let start = store.start(&payload, &ROOT, "03worker", 10_000.0, &TOKEN_A);
        assert_eq!(start.status, 200, "{}", start.body);
        let token = start.body["session_token"].clone();
        let ops = solved_ops(&payload, &start);
        assert_eq!(ops.len(), 41);
        for (seq, op) in ops.iter().enumerate() {
            let mut step = payload.clone();
            step["session_token"] = token.clone();
            step["seq"] = Json::from(seq);
            step["op"] = op.clone();
            let at = 51_000.0 - ((40 - seq) as f64) * 500.0;
            assert_eq!(store.step(&step, &ROOT, at).status, 200);
        }
        let mut finalize = payload.clone();
        finalize["session_token"] = token;
        (player, finalize)
    }

    #[test]
    fn kernel_lane_loss_matches_the_shared_vector() {
        let expected = vector("session-loss-sudoku");
        let mut store = SessionStore::new();
        let (player, finalize) = play_the_shared_loss(&mut store);
        assert_eq!(player.player_hex, expected["player"]);
        let loss = store.finalize(&finalize, &ROOT, 60_000.0, kernel("1", &player.player_hex));
        assert_eq!(loss.status, 200, "{}", loss.body);
        assert_eq!(loss.body["rejection"], "solved too fast");
        assert_eq!(loss.body["elapsed_ms"], expected["elapsedMs"]);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(loss.body["result_bytes_base64"].as_str().unwrap())
            .unwrap();
        assert_eq!(bytes, unhex(&expected["result"]));
        assert_eq!(loss.body["binding"], expected["binding"]);
    }

    #[test]
    fn kernel_requests_bind_to_the_session_player() {
        let mut store = SessionStore::new();
        let (player, finalize) = play_the_shared_loss(&mut store);
        let other = test_player(8);
        let reversed: String = (0..20)
            .rev()
            .map(|index| &player.player_hex[2 + index * 2..4 + index * 2])
            .collect();
        for (lane, status, message) in [
            (
                kernel("1", &other.player_hex),
                403,
                "kernel requester is not the session player",
            ),
            (
                kernel("1", &format!("0x{reversed}")),
                403,
                "kernel requester is not the session player",
            ),
            (
                kernel("1", ""),
                400,
                "kernel requester must be a 20-byte script hash",
            ),
            (
                kernel("1", "0x1234"),
                400,
                "kernel requester must be a 20-byte script hash",
            ),
            (
                kernel("", &player.player_hex),
                400,
                "kernel request_id must be a decimal string",
            ),
            (
                kernel("0x1", &player.player_hex),
                400,
                "kernel request_id must be a decimal string",
            ),
            (
                kernel(&"9".repeat(79), &player.player_hex),
                400,
                "kernel request_id must be a decimal string",
            ),
        ] {
            let reply = store.finalize(&finalize, &ROOT, 60_000.0, lane);
            assert_eq!(reply.status, status, "{}", reply.body);
            assert_eq!(reply.body["error"], message);
        }
        // None of the refusals consumed the session; the bare and upper-case
        // spellings of the player's own hash are the same account.
        let bare = player.player_hex.trim_start_matches("0x").to_uppercase();
        let settled = store.finalize(&finalize, &ROOT, 60_000.0, kernel("0001", &bare));
        assert_eq!(settled.status, 200, "{}", settled.body);
        // "0001" and "1" are the same kernel request.
        let retry = store.finalize(&finalize, &ROOT, 60_000.0, kernel("1", &player.player_hex));
        assert_eq!(retry.status, 200, "{}", retry.body);
        assert_eq!(retry.body, settled.body);
    }

    #[test]
    fn a_kernel_settlement_consumes_the_session() {
        let player = test_player(7);
        let payload = witnessed("miniapp-sudoku", "86", &player);
        let mut store = SessionStore::new();
        let start = store.start(&payload, &ROOT, "03worker", 10_000.0, &TOKEN_A);
        let token = start.body["session_token"].clone();
        let (last_step, now) = solve_sudoku(&mut store, &payload, &token, &start, 1_000.0);
        let resume = resume_payload(&payload, &token, solved_ops(&payload, &start), &last_step);
        let at = now + 1_000.0;

        let first = store.finalize(&resume, &ROOT, at, kernel("11", &player.player_hex));
        assert_eq!(first.status, 200, "{}", first.body);

        // A retry of the same request answers the same bytes; any other
        // request, a step, a restart and the preview lane are refused.
        let retry = store.finalize(&resume, &ROOT, at + 5.0, kernel("11", &player.player_hex));
        assert_eq!(retry.status, 200, "{}", retry.body);
        assert_eq!(
            retry.body["result_bytes_base64"],
            first.body["result_bytes_base64"]
        );
        let other = store.finalize(&resume, &ROOT, at, kernel("12", &player.player_hex));
        assert_eq!(other.status, 409, "{}", other.body);
        assert_eq!(
            other.body["error"],
            "session already settled by kernel request 11"
        );
        let mut step = resume.clone();
        step["seq"] = Json::from(999);
        step["op"] = serde_json::json!({ "type": "undo" });
        assert_eq!(store.step(&step, &ROOT, at).status, 409);
        assert_eq!(
            store
                .start(&payload, &ROOT, "03worker", at, &TOKEN_B)
                .status,
            409
        );
        assert_eq!(
            store
                .finalize(&resume, &ROOT, at, FinalizeLane::Direct)
                .status,
            409
        );

        // Eviction: the resume record cannot rebuild it for another request...
        store.clear();
        let rebuilt = store.finalize(&resume, &ROOT, at, kernel("12", &player.player_hex));
        assert_eq!(rebuilt.status, 409, "{}", rebuilt.body);
        assert_eq!(store.step(&step, &ROOT, at).status, 409);
        // ...but still answers a retry of the request that consumed it.
        let rebuilt = store.finalize(&resume, &ROOT, at, kernel("11", &player.player_hex));
        assert_eq!(rebuilt.status, 200, "{}", rebuilt.body);
        assert_eq!(
            rebuilt.body["result_bytes_base64"],
            first.body["result_bytes_base64"]
        );
    }

    #[test]
    fn a_retry_that_would_settle_different_bytes_is_refused() {
        let player = test_player(7);
        let payload = witnessed("miniapp-sudoku", "83", &player);
        let mut store = SessionStore::new();
        let start = store.start(&payload, &ROOT, "03worker", 10_000.0, &TOKEN_A);
        let token = start.body["session_token"].clone();
        let (last_step, now) = solve_sudoku(&mut store, &payload, &token, &start, 1_000.0);
        let resume = resume_payload(&payload, &token, solved_ops(&payload, &start), &last_step);

        // A preview proves a later elapsed time (a solve)...
        let at = 10_000.0 + 95_000.0_f64.max(now - 10_000.0 + 1.0);
        let preview = store.finalize(&resume, &ROOT, at, FinalizeLane::Direct);
        assert_eq!(preview.status, 200, "{}", preview.body);
        assert_eq!(preview.body["solved"], true);

        // ...but the request settles without it: a LOSS at the last op.
        store.clear();
        let loss = store.finalize(&resume, &ROOT, at, kernel("61", &player.player_hex));
        assert_eq!(loss.status, 200, "{}", loss.body);
        assert_eq!(loss.body["solved"], false);

        // The same request presented again with the proven preview would
        // settle different bytes (a win): refused.
        store.clear();
        let mut previewed = resume.clone();
        previewed["elapsed_ms"] = preview.body["elapsed_ms"].clone();
        previewed["finalize_proof"] = preview.body["finalize_proof"].clone();
        let win = store.finalize(&previewed, &ROOT, at, kernel("61", &player.player_hex));
        assert_eq!(win.status, 409, "{}", win.body);
        assert_eq!(
            win.body["error"],
            "kernel request 61 already settled a different result"
        );
    }

    #[test]
    fn nothing_older_than_the_settle_age_settles_or_rebuilds() {
        let player = test_player(7);
        let payload = witnessed("miniapp-sudoku", "85", &player);
        let mut store = SessionStore::new();
        let start = store.start(&payload, &ROOT, "03worker", 10_000.0, &TOKEN_A);
        let token = start.body["session_token"].clone();
        let (last_step, now) = solve_sudoku(&mut store, &payload, &token, &start, 1_000.0);
        let resume = resume_payload(&payload, &token, solved_ops(&payload, &start), &last_step);
        let settled = store.finalize(&resume, &ROOT, now + 1.0, kernel("21", &player.player_hex));
        assert_eq!(settled.status, 200, "{}", settled.body);

        // Evicted, just inside the settle age: the record refuses request 22.
        store.clear();
        let inside = 10_000.0 + MAX_SETTLE_AGE_MS;
        assert_eq!(
            store
                .finalize(&resume, &ROOT, inside, kernel("22", &player.player_hex))
                .status,
            409
        );
        // Past it the record is gone, and the resume record rebuilds nothing,
        // for any request, 30 days later or after a restart.
        let month = 10_000.0 + 30.0 * 86_400_000.0;
        for store in [&mut store, &mut SessionStore::new()] {
            for request in ["21", "22"] {
                let reply =
                    store.finalize(&resume, &ROOT, month, kernel(request, &player.player_hex));
                assert_eq!(reply.status, 410, "{}", reply.body);
                assert_eq!(reply.body["error"], "session is too old to resume");
            }
            let mut step = resume.clone();
            step["seq"] = Json::from(999);
            step["op"] = serde_json::json!({ "type": "undo" });
            assert_eq!(store.step(&step, &ROOT, month).status, 410);
            assert_eq!(
                store
                    .finalize(&resume, &ROOT, month, FinalizeLane::Direct)
                    .status,
                410
            );
        }

        // A live session kept past the settle age cannot settle either.
        let live = witnessed("miniapp-sudoku", "84", &player);
        let mut store = SessionStore::new();
        let start = store.start(&live, &ROOT, "03worker", 10_000.0, &TOKEN_A);
        let mut finalize = live.clone();
        finalize["session_token"] = start.body["session_token"].clone();
        let late = store.finalize(
            &finalize,
            &ROOT,
            10_000.0 + MAX_SETTLE_AGE_MS + 1.0,
            kernel("31", &player.player_hex),
        );
        assert_eq!(late.status, 410, "{}", late.body);
        assert_eq!(late.body["error"], "session is too old to settle");
    }

    #[test]
    fn settled_records_are_bounded_and_evict_the_oldest() {
        let player = test_player(7);
        let mut store = SessionStore::new();
        store.settled_capacity = 2;
        let mut resumes = Vec::new();
        for (index, game) in ["71", "72", "73"].into_iter().enumerate() {
            let payload = witnessed("miniapp-sudoku", game, &player);
            let start = store.start(&payload, &ROOT, "03worker", 10_000.0, &TOKEN_A);
            let token = start.body["session_token"].clone();
            let (last_step, now) = solve_sudoku(&mut store, &payload, &token, &start, 1_000.0);
            let resume = resume_payload(&payload, &token, solved_ops(&payload, &start), &last_step);
            let request = format!("{}", 100 + index);
            let settled = store.finalize(
                &resume,
                &ROOT,
                now + 1.0,
                kernel(&request, &player.player_hex),
            );
            assert_eq!(settled.status, 200, "{}", settled.body);
            resumes.push(resume);
        }
        assert_eq!(store.settled.len(), 2);

        // Live sessions still carry their settlement; after eviction the two
        // newest records refuse another request and the oldest is forgotten
        // (the on-chain binding is what refuses that result for another game).
        assert_eq!(
            store
                .finalize(
                    &resumes[0],
                    &ROOT,
                    200_000.0,
                    kernel("999", &player.player_hex)
                )
                .status,
            409
        );
        store.clear();
        for resume in &resumes[1..] {
            assert_eq!(
                store
                    .finalize(resume, &ROOT, 200_000.0, kernel("999", &player.player_hex))
                    .status,
                409
            );
        }
        assert_eq!(
            store
                .finalize(
                    &resumes[0],
                    &ROOT,
                    200_000.0,
                    kernel("999", &player.player_hex)
                )
                .status,
            200
        );
    }

    #[test]
    fn median_gate_applies_to_resumed_sessions() {
        let player = test_player(8);
        let payload = witnessed("miniapp-sudoku", "89", &player);
        let mut store = SessionStore::new();
        let start = store.start(&payload, &ROOT, "03worker", 10_000.0, &TOKEN_A);
        let token = start.body["session_token"].clone();
        // Bot-speed placements: 10 ms apart (floor is 120 ms).
        let (last_step, _) = solve_sudoku(&mut store, &payload, &token, &start, 10.0);

        store.clear();
        let identity = parse_identity(&payload).unwrap();
        let secret = problem_secret_for(&ROOT, &identity.canonical);
        let engine = resolve_engine("miniapp-sudoku").unwrap();
        let (state, _) = (engine.deal)(&secret, 0);
        let solution = state["solution"].as_str().unwrap();
        let mut resume = payload.clone();
        resume["session_token"] = token;
        resume["replay"] = Json::Array(
            open_cells(&start)
                .into_iter()
                .map(|cell| serde_json::json!({ "type": "place", "cell": cell, "digit": (solution.as_bytes()[cell] - b'0') as u64 }))
                .collect(),
        );
        resume["replay_record"] = last_step["replay_record"].clone();
        resume["replay_proof"] = last_step["replay_proof"].clone();
        let reply = store.finalize(&resume, &ROOT, 10_000.0 + 100_000.0, FinalizeLane::Direct);
        assert_eq!(reply.status, 403, "{}", reply.body);
        assert_eq!(
            reply.body["error"],
            "median inter-op interval below the human floor"
        );
        // ...and the resumed clock is the original one, not the resume time.
        assert!(store
            .sessions
            .values()
            .all(|session| session.started_at_ms == 10_000.0));
    }

    #[test]
    fn flappy_replay_reproduces_live_frame_timing() {
        let player = test_player(9);
        let payload = witnessed("miniapp-flappy-dash", "90", &player);
        let mut store = SessionStore::new();
        let start = store.start(&payload, &ROOT, "03worker", 1_000.0, &TOKEN_A);
        let token = start.body["session_token"].clone();
        let mut last = Json::Null;
        for seq in 0..5 {
            let mut step = payload.clone();
            step["session_token"] = token.clone();
            step["seq"] = Json::from(seq);
            step["op"] = serde_json::json!({ "type": "flap" });
            let reply = store.step(&step, &ROOT, 1_000.0 + (seq as f64 + 1.0) * 700.0);
            assert_eq!(reply.status, 200, "{}", reply.body);
            last = reply.body;
        }
        let live_frames =
            store.sessions.values().next().unwrap().engine_state["flapFrames"].clone();

        store.clear();
        let mut resume = payload.clone();
        resume["session_token"] = token;
        resume["replay"] = serde_json::json!([{"type":"flap"},{"type":"flap"},{"type":"flap"},{"type":"flap"},{"type":"flap"}]);
        resume["replay_record"] = last["replay_record"].clone();
        resume["replay_proof"] = last["replay_proof"].clone();
        resume["seq"] = Json::from(5);
        resume["op"] = serde_json::json!({ "type": "flap" });
        let reply = store.step(&resume, &ROOT, 1_000.0 + 6.0 * 700.0);
        assert_eq!(reply.status, 200, "{}", reply.body);
        let rebuilt = store.sessions.values().next().unwrap().engine_state["flapFrames"]
            .as_array()
            .unwrap()
            .clone();
        // The first five frames are the live ones (elapsed / FRAME_MS), not a
        // synthetic 12-frame cadence.
        assert_eq!(&rebuilt[..5], live_frames.as_array().unwrap().as_slice());
        assert_eq!(rebuilt[0], Json::from(42));
    }
}
