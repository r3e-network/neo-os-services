//! Generic confidential game-session state machine.
//!
//! This is the keyless Rust port of `workers/nitro-worker/src/game/session.js`.
//! It owns protocol validation, HMAC-bound identity/replay, bounded ephemeral
//! state, sequencing, behavioural gates and the 79-byte result codec. Secret
//! release and result signing remain host responsibilities: callers pass an
//! already-attested 32-byte HMAC root and add the custody envelope only after
//! a successful [`SessionStore::finalize`].

use std::cmp::Ordering;
use std::collections::HashMap;

use base64::Engine as _;
use hmac::{Hmac, Mac};
use num_bigint::BigUint;
use serde_json::{Map, Value as Json};
use sha2::{Digest, Sha256};

use super::abi::{OpMeta, OpOutcome, ScoreExtra};
use super::registry::{registered_app_ids, resolve_engine, resolve_engine_by_hash, EngineHandle};

type HmacSha256 = Hmac<Sha256>;

pub const MAX_SESSIONS: usize = 4_096;
pub const SESSION_TTL_MS: f64 = 3.0 * 60.0 * 60.0 * 1_000.0;
pub const RESULT_FINALIZE_TAG: u8 = 0x02;
pub const RESULT_BYTES_LENGTH: usize = 79;

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

#[derive(Debug, Clone)]
struct Session {
    app_id: String,
    engine_hash: String,
    difficulty: u8,
    problem_secret: [u8; 32],
    started_at_ms: f64,
    last_touched_ms: f64,
    last_seq: f64,
    undos: u64,
    resumed: bool,
    op_timestamps: Vec<f64>,
    op_log: Vec<Json>,
    engine_state: Json,
    last_view: Json,
    generation: u64,
}

/// Process-local cache matching the Node Map. It is intentionally injectable
/// and resettable: persistence authority comes from the HMAC-authenticated
/// replay proof, never from trusting client-provided replay operations.
#[derive(Debug, Default)]
pub struct SessionStore {
    sessions: HashMap<String, Session>,
    generation: u64,
    target_overrides: HashMap<String, [f64; 3]>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self::default()
    }

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

    pub fn start(
        &mut self,
        payload: &Json,
        secret_root: &[u8; 32],
        public_key: &str,
        now_ms: f64,
    ) -> SessionReply {
        let (identity, engine) = match load_identity_and_engine(payload) {
            Ok(value) => value,
            Err(message) => return SessionReply::error(400, message),
        };
        let problem_secret = problem_secret_for(secret_root, &identity.canonical);
        let commitment = commitment_for(&identity.canonical, &problem_secret);

        if !self.sessions.contains_key(&identity.canonical) {
            let session = self.create_session(&identity, engine, problem_secret, now_ms, false);
            self.sessions.insert(identity.canonical.clone(), session);
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
            "session_token": session_token_for(secret_root, &identity.canonical),
            "replay_proof": replay_proof_for(secret_root, &identity.canonical, &session.op_log),
            "config": Json::Object(config),
        }))
    }

    pub fn step(&mut self, payload: &Json, secret_root: &[u8; 32], now_ms: f64) -> SessionReply {
        let (identity, engine) = match load_identity_and_engine(payload) {
            Ok(value) => value,
            Err(message) => return SessionReply::error(400, message),
        };
        if !verify_session_token(
            secret_root,
            &identity.canonical,
            payload.get("session_token"),
        ) {
            return SessionReply::error(401, "invalid session token");
        }

        let seq = payload
            .get("seq")
            .map(crate::js::js_to_number)
            .unwrap_or(f64::NAN);
        if !seq.is_finite() || seq.fract() != 0.0 || seq < 0.0 {
            return SessionReply::error(400, "seq must be a non-negative integer");
        }

        let problem_secret = problem_secret_for(secret_root, &identity.canonical);
        let mut resumed_now = false;
        if !self.sessions.contains_key(&identity.canonical) {
            if !verify_replay_proof(
                secret_root,
                &identity.canonical,
                payload.get("replay"),
                payload.get("replay_proof"),
            ) {
                return SessionReply::error(401, "invalid or missing authenticated replay proof");
            }
            if let Err(message) = self.rebuild_session(
                &identity,
                engine,
                problem_secret,
                payload.get("replay"),
                now_ms,
            ) {
                return SessionReply::error(400, message);
            }
            resumed_now = true;
        }

        let session = self
            .sessions
            .get_mut(&identity.canonical)
            .expect("live or rebuilt session");
        session.problem_secret = problem_secret;
        if seq <= session.last_seq {
            return SessionReply {
                status: 409,
                body: serde_json::json!({
                    "error": "stale seq",
                    "expected_min": crate::js::js_number_value(session.last_seq + 1.0),
                }),
            };
        }

        let outcome = match apply_session_op(session, engine, payload.get("op"), now_ms, true) {
            Ok(view) => view,
            Err((status, message)) => return SessionReply::error(status, message),
        };
        session.last_seq = seq;
        if outcome.get("ok").and_then(Json::as_bool) != Some(false) {
            session.op_timestamps.push(now_ms);
        }
        session.last_touched_ms = now_ms;

        let mut body = Map::new();
        body.insert("seq".into(), crate::js::js_number_value(seq));
        body.insert("op_count".into(), Json::from(session.op_log.len()));
        if resumed_now {
            body.insert("resumed".into(), Json::Bool(true));
        }
        body.insert(
            "replay_proof".into(),
            Json::String(replay_proof_for(
                secret_root,
                &identity.canonical,
                &session.op_log,
            )),
        );
        if let Json::Object(view) = outcome {
            for (key, value) in view {
                body.insert(key, value);
            }
        }
        SessionReply::ok(Json::Object(body))
    }

    /// Produce the unsigned, human-readable result plus the 79-byte codec in
    /// base64. The host must still sign stable JSON
    /// `{ "result_bytes_base64": ... }` through its worker custody role.
    pub fn finalize(
        &mut self,
        payload: &Json,
        secret_root: &[u8; 32],
        now_ms: f64,
    ) -> SessionReply {
        let (identity, engine) = match load_identity_and_engine(payload) {
            Ok(value) => value,
            Err(message) => return SessionReply::error(400, message),
        };
        if !verify_session_token(
            secret_root,
            &identity.canonical,
            payload.get("session_token"),
        ) {
            return SessionReply::error(401, "invalid session token");
        }

        let problem_secret = problem_secret_for(secret_root, &identity.canonical);
        if !self.sessions.contains_key(&identity.canonical) {
            if !payload.get("replay").is_some_and(Json::is_array) {
                return SessionReply::error(
                    404,
                    "unknown session — authenticated replay is required to finalize",
                );
            }
            if !verify_replay_proof(
                secret_root,
                &identity.canonical,
                payload.get("replay"),
                payload.get("replay_proof"),
            ) {
                return SessionReply::error(401, "invalid or missing authenticated replay proof");
            }
            if let Err(message) = self.rebuild_session(
                &identity,
                engine,
                problem_secret,
                payload.get("replay"),
                now_ms,
            ) {
                return SessionReply::error(400, message);
            }
        }

        let targets = self.effective_targets(engine);
        let session = self
            .sessions
            .get_mut(&identity.canonical)
            .expect("live or rebuilt session");
        session.problem_secret = problem_secret;
        let elapsed_ms = (now_ms - session.started_at_ms).trunc().max(0.0);
        let window = engine.descriptor.time_window;
        if elapsed_ms < window.min_solve_ms[identity.difficulty as usize] {
            return SessionReply::error(403, "solved too fast");
        }
        if elapsed_ms > window.limit_ms[identity.difficulty as usize] {
            return SessionReply::error(403, "time limit exceeded");
        }
        if let Some(message) = behavioral_gate_error(session, engine) {
            return SessionReply::error(403, message);
        }

        let scored = match (engine.score)(
            &session.engine_state,
            identity.difficulty,
            &ScoreExtra {
                answer: payload.get("answer").cloned(),
                elapsed_ms: Some(elapsed_ms),
                started_at_ms: Some(session.started_at_ms),
                now_ms: Some(now_ms),
                target_override: Some(targets[identity.difficulty as usize]),
            },
        ) {
            Ok(scored) => scored,
            Err(rejection) => return SessionReply::error(rejection.status, rejection.message),
        };
        let commitment = commitment_for(&identity.canonical, &problem_secret);
        let result_bytes = match build_result_bytes(
            &commitment,
            &scored.answer_hash,
            elapsed_ms,
            session.undos,
            scored.score,
            identity.difficulty,
        ) {
            Ok(bytes) => bytes,
            Err(message) => return SessionReply::error(500, message),
        };
        let result_bytes_base64 = base64::engine::general_purpose::STANDARD.encode(result_bytes);

        let mut body = Map::new();
        body.insert(
            "result_bytes_base64".into(),
            Json::String(result_bytes_base64),
        );
        body.insert(
            "callback_encoding".into(),
            Json::String("game_result_v1".into()),
        );
        body.insert(
            "problem_hash".into(),
            Json::String(super::hex_encode(&commitment)),
        );
        body.insert(
            "answer_hash".into(),
            Json::String(super::hex_encode(&scored.answer_hash)),
        );
        body.insert("elapsed_ms".into(), crate::js::js_number_value(elapsed_ms));
        body.insert("undos".into(), Json::from(session.undos));
        body.insert("score".into(), Json::from(scored.score));
        body.insert("difficulty".into(), Json::from(identity.difficulty));
        if let Some(Json::Object(score_field)) = scored.score_field {
            for (key, value) in score_field {
                body.insert(key, value);
            }
        }
        SessionReply::ok(Json::Object(body))
    }

    fn effective_targets(&self, engine: &'static EngineHandle) -> [f64; 3] {
        self.target_overrides
            .get(engine.app_id)
            .copied()
            .unwrap_or_else(|| engine.descriptor.targets.map(|target| target as f64))
    }

    fn create_session(
        &mut self,
        identity: &SessionIdentity,
        engine: &'static EngineHandle,
        problem_secret: [u8; 32],
        now_ms: f64,
        resumed: bool,
    ) -> Session {
        self.prune_sessions(now_ms);
        let (engine_state, start_view) = (engine.deal)(&problem_secret, identity.difficulty);
        self.generation = self.generation.wrapping_add(1);
        Session {
            app_id: identity.app_id.clone(),
            engine_hash: engine.engine_hash.to_string(),
            difficulty: identity.difficulty,
            problem_secret,
            started_at_ms: now_ms,
            last_touched_ms: now_ms,
            last_seq: -1.0,
            undos: 0,
            resumed,
            op_timestamps: Vec::new(),
            op_log: Vec::new(),
            engine_state,
            last_view: start_view,
            generation: self.generation,
        }
    }

    fn rebuild_session(
        &mut self,
        identity: &SessionIdentity,
        engine: &'static EngineHandle,
        problem_secret: [u8; 32],
        replay: Option<&Json>,
        now_ms: f64,
    ) -> Result<(), String> {
        let empty = Vec::new();
        let ops = replay.and_then(Json::as_array).unwrap_or(&empty);
        if ops.len() as u64 > engine.descriptor.max_ops {
            return Err("replay log too long".into());
        }
        let mut session = self.create_session(identity, engine, problem_secret, now_ms, true);
        for (index, op) in ops.iter().enumerate() {
            match apply_session_op(&mut session, engine, Some(op), now_ms, true) {
                Ok(view) if view.get("ok").and_then(Json::as_bool) != Some(false) => {}
                Ok(_) | Err(_) => return Err(format!("invalid replay op at index {index}")),
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

/// Validate both the canonical identity and the optional engine pin without
/// touching session state. Hosts use this before attempting confidential key
/// material release so malformed requests retain their protocol-level 400.
pub fn validate_identity_and_engine(payload: &Json) -> Result<SessionIdentity, String> {
    load_identity_and_engine(payload).map(|(identity, _)| identity)
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

pub fn session_token_for(secret_root: &[u8; 32], canonical: &str) -> String {
    let label = format!("token|{canonical}");
    super::hex_encode(&hmac_bytes(secret_root, label.as_bytes()))
}

pub fn replay_proof_for(secret_root: &[u8; 32], canonical: &str, replay_ops: &[Json]) -> String {
    let replay_digest = super::sha256_hex(
        neo_os_core::stable_stringify::stable_stringify(
            &neo_os_core::js_value::JsValue::from_json(&Json::Array(replay_ops.to_vec())),
        )
        .as_bytes(),
    );
    let label = format!("replay|{canonical}|{replay_digest}");
    super::hex_encode(&hmac_bytes(secret_root, label.as_bytes()))
}

fn replay_proof_for_value(
    secret_root: &[u8; 32],
    canonical: &str,
    replay: Option<&Json>,
) -> String {
    let empty = Vec::new();
    replay_proof_for(
        secret_root,
        canonical,
        replay.and_then(Json::as_array).unwrap_or(&empty),
    )
}

fn verify_session_token(secret_root: &[u8; 32], canonical: &str, supplied: Option<&Json>) -> bool {
    constant_time_equal(
        session_token_for(secret_root, canonical).as_bytes(),
        crate::js::js_trim_string(supplied).as_bytes(),
    )
}

fn verify_replay_proof(
    secret_root: &[u8; 32],
    canonical: &str,
    replay: Option<&Json>,
    supplied: Option<&Json>,
) -> bool {
    constant_time_equal(
        replay_proof_for_value(secret_root, canonical, replay).as_bytes(),
        crate::js::js_trim_string(supplied).as_bytes(),
    )
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

fn apply_session_op(
    session: &mut Session,
    engine: &'static EngineHandle,
    op: Option<&Json>,
    now_ms: f64,
    record: bool,
) -> Result<Json, (u16, String)> {
    let Some(Json::Object(_)) = op else {
        return Err((400, "op object required".into()));
    };
    let op = op.expect("object checked above");
    let op_type = crate::js::js_trim_string(op.get("type"));
    let meta = OpMeta {
        problem_secret: session.problem_secret,
        difficulty: session.difficulty,
        now_ms: Some(now_ms),
        started_at_ms: Some(session.started_at_ms),
        elapsed_ms: Some((now_ms - session.started_at_ms).max(0.0)),
        resumed: session.resumed,
        op_index: session.op_log.len(),
    };

    if op_type == "undo" {
        if session.undos >= engine.descriptor.max_undos {
            return Err((409, "undo limit reached".into()));
        }
        let outcome = (engine.apply_undo)(&mut session.engine_state, &meta);
        let view = outcome_view(outcome)?;
        session.undos += 1;
        if record {
            session.op_log.push(serde_json::json!({ "type": "undo" }));
        }
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
    if view.get("ok").and_then(Json::as_bool) != Some(false) && record {
        session.op_log.push(op.clone());
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

fn behavioral_gate_error(session: &Session, engine: &'static EngineHandle) -> Option<&'static str> {
    let timestamps = &session.op_timestamps;
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
    let min_median = engine.descriptor.gates.min_median_interval_ms;
    if !session.resumed && min_median.is_finite() && timestamps.len() >= 2 {
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

/// Encode the contract's fixed, big-endian `game_result_v1` payload.
pub fn build_result_bytes(
    commitment: &[u8],
    answer_hash: &[u8],
    elapsed_ms: f64,
    undos: u64,
    score: i64,
    difficulty: u8,
) -> Result<[u8; RESULT_BYTES_LENGTH], String> {
    let commitment: &[u8; 32] = commitment
        .try_into()
        .map_err(|_| "commitment must be 32 bytes".to_string())?;
    let answer_hash: &[u8; 32] = answer_hash
        .try_into()
        .map_err(|_| "answerHash must be 32 bytes".to_string())?;
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
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity_payload(app_id: &str, game_id: &str) -> Json {
        serde_json::json!({
            "app_id": app_id,
            "network": "TESTNET",
            "contract_hash": "0xAABBCCDDEEFF0011223344556677889900AABBCC",
            "player": "0x00112233445566778899AABBCCDDEEFF00112233",
            "game_id": game_id,
            "difficulty": 0,
        })
    }

    #[test]
    fn result_codec_matches_the_node_golden_vector() {
        let bytes = build_result_bytes(&[0xab; 32], &[0xcd; 32], 123_456.0, 2, 20, 1)
            .expect("valid vector");
        let expected = format!(
            "02{}{}000000000001e240020000001401",
            "ab".repeat(32),
            "cd".repeat(32)
        );
        assert_eq!(super::super::hex_encode(&bytes), expected);
        assert_eq!(
            super::super::sha256_hex(&bytes),
            "f8ddd711f6ece1740fd322f71e9cc7407e6820656227bb8c4d0716e7970c2488"
        );
        assert_eq!(bytes.len(), RESULT_BYTES_LENGTH);
    }

    #[test]
    fn identity_is_canonical_and_rejects_ambiguous_bounds() {
        let parsed =
            parse_identity(&identity_payload(" MINIAPP-SUDOKU ", "00042")).expect("valid identity");
        assert_eq!(parsed.game_id, "42");
        assert_eq!(parsed.network, "testnet");
        assert_eq!(
            parsed.contract_hash,
            "0xaabbccddeeff0011223344556677889900aabbcc"
        );
        assert_eq!(
            parsed.canonical,
            "miniapp-sudoku|testnet|0xaabbccddeeff0011223344556677889900aabbcc|42|0x00112233445566778899aabbccddeeff00112233|0"
        );

        let mut overflow = identity_payload(
            "miniapp-sudoku",
            &((BigUint::from(1u8)) << 256usize).to_string(),
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
    fn all_registered_engines_start_and_repeated_start_preserves_authoritative_state() {
        let root = [7u8; 32];
        let mut store = SessionStore::new();
        for (index, app_id) in registered_app_ids().into_iter().enumerate() {
            let payload = identity_payload(app_id, &(index + 1).to_string());
            let first = store.start(&payload, &root, "03worker", 1_000.0);
            assert_eq!(first.status, 200, "{app_id}: {}", first.body);
            assert!(first.body["commitment"]
                .as_str()
                .is_some_and(|v| v.len() == 64));
            assert!(first.body["session_token"]
                .as_str()
                .is_some_and(|v| v.len() == 64));
            assert_eq!(first.body["public_key"], "03worker");
            assert_eq!(first.body["config"]["app_id"], app_id);

            let repeated = store.start(&payload, &root, "03worker", 9_999.0);
            assert_eq!(repeated.status, 200);
            assert_eq!(repeated.body["commitment"], first.body["commitment"]);
            assert_eq!(repeated.body["session_token"], first.body["session_token"]);
            assert_eq!(repeated.body["op_count"], 0);
        }
    }

    #[test]
    fn token_sequence_and_authenticated_replay_fail_closed() {
        let root = [9u8; 32];
        let payload = identity_payload("miniapp-sudoku", "77");
        let mut store = SessionStore::new();
        let start = store.start(&payload, &root, "03worker", 10_000.0);
        let token = start.body["session_token"].clone();

        let mut bad = payload.clone();
        bad["session_token"] = Json::String("00".repeat(32));
        bad["seq"] = Json::from(0);
        let open_cells = start.body["view"]["clues"]
            .as_str()
            .expect("sudoku clues")
            .bytes()
            .enumerate()
            .filter_map(|(index, value)| (value == b'0').then_some(index))
            .collect::<Vec<_>>();
        bad["op"] = serde_json::json!({ "type": "place", "cell": open_cells[0], "digit": 1 });
        assert_eq!(store.step(&bad, &root, 11_000.0).status, 401);

        let mut step = bad;
        step["session_token"] = token.clone();
        // An engine rejection must not consume the sequence.
        step["op"] = Json::Null;
        assert_eq!(store.step(&step, &root, 11_000.0).status, 400);
        step["op"] = serde_json::json!({ "type": "place", "cell": open_cells[0], "digit": 1 });
        let accepted = store.step(&step, &root, 11_500.0);
        assert!(matches!(accepted.status, 200 | 409), "{}", accepted.body);
        if accepted.status == 200 {
            let stale = store.step(&step, &root, 12_000.0);
            assert_eq!(stale.status, 409);
            assert_eq!(stale.body["error"], "stale seq");
        }

        let parsed = parse_identity(&payload).expect("identity");
        store.clear();
        let mut replay = payload.clone();
        replay["session_token"] = token;
        replay["seq"] = Json::from(1);
        replay["op"] = serde_json::json!({ "type": "place", "cell": open_cells[1], "digit": 2 });
        replay["replay"] = serde_json::json!([]);
        replay["replay_proof"] = Json::String(replay_proof_for(&root, &parsed.canonical, &[]));
        let resumed = store.step(&replay, &root, 20_000.0);
        assert_ne!(resumed.status, 401, "{}", resumed.body);
        if resumed.status == 200 {
            assert_eq!(resumed.body["resumed"], true);
        }

        store.clear();
        replay["replay"] = serde_json::json!([{ "type": "forged" }]);
        // Proof for [] cannot authenticate a different log.
        assert_eq!(store.step(&replay, &root, 21_000.0).status, 401);
    }
}
