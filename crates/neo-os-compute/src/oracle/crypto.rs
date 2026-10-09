//! Port of `workers/nitro-worker/src/oracle/crypto.js` — the oracle
//! confidential-payload lane: X25519-HKDF-SHA256-AES-256-GCM envelope
//! unsealing, sealed-keystore resolution, and the key-material decision tree
//! (configured env → Secrets-Manager sealed keystore → keystore file →
//! ephemeral). The wrap key is injected (the enclave host derives it through
//! nitro-attest/KMS), the keystore file reader is injected, and the egress
//! half (`loadEncryptedCiphertextByRef` / `claimEncryptedRef`, Supabase REST)
//! lands with the 5b-3 fetch port.
//!
//! Divergence: JS `resolveEncryptedPayload` reads `encrypted_inputs` with a
//! loose `typeof === 'object'` check that would throw on `null`/arrays; every
//! resolver here uses the plain-object gate the other JS resolvers use.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit};
use curve25519_dalek::constants::X25519_BASEPOINT;
use curve25519_dalek::montgomery::MontgomeryPoint;
use hkdf::Hkdf;
use serde_json::{json, Value as Json};
use sha2::Sha256;
use url::Url;

use crate::core::{
    buffer_from_base64, decode_base64, normalize_boolean, normalize_morpheus_network_strict,
    read_env, resolve_payload_network_strict, EnvReader,
};
use crate::js::{js_first_truthy, js_stringify, js_to_number, js_trim_string, js_truthy};
use crate::transport::{HttpRequest, HttpResponse, HttpTransport};

pub const ORACLE_ENVELOPE_VERSION: i64 = 2;
pub const ORACLE_ENVELOPE_ALGORITHM: &str = "X25519-HKDF-SHA256-AES-256-GCM";
pub const ORACLE_ENVELOPE_INFO: &[u8] = b"morpheus-confidential-payload-v2";
pub const AES_GCM_IV_LENGTH_BYTES: usize = 12;
pub const AES_GCM_TAG_LENGTH_BYTES: usize = 16;
pub const PLAINTEXT_ORACLE_KEY_PRODUCTION_ERROR: &str =
    "plaintext configured oracle private key material is forbidden in production";

/// `AbortSignal.timeout(15_000)` on the encrypted-ref GET/CLAIM requests.
pub const REF_CLAIM_TIMEOUT_MS: u64 = 15_000;

/// Default keystore path when neither `NITRO_ORACLE_KEYSTORE_PATH` nor
/// `MORPHEUS_ORACLE_KEYSTORE_PATH` is set.
pub const DEFAULT_ORACLE_KEYSTORE_PATH: &str = "/data/morpheus/oracle-key.json";

/// WebCrypto's fixed PKCS#8 encoding for X25519 private keys: the DER shell
/// is constant and the trailing 32 bytes are the raw scalar.
const X25519_PKCS8_PREFIX: [u8; 16] = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
];

/// `isPlainObject(value)` — truthy, object, not an array. (JSON has no
/// `undefined`; `null` fails the truthiness check.)
pub fn is_plain_object(value: &Json) -> bool {
    matches!(value, Json::Object(_))
}

/// `normalizeHash160(value)` — trimmed, `0x`-stripped lowercase hex that must
/// be exactly 40 digits, re-rendered with the `0x` prefix.
pub fn normalize_hash160(value: &Json) -> String {
    let raw = js_trim_string(Some(value));
    let stripped = match raw.get(..2) {
        Some(prefix) if prefix.eq_ignore_ascii_case("0x") => raw[2..].to_lowercase(),
        _ => raw.to_lowercase(),
    };
    if stripped.len() == 40 && stripped.bytes().all(|b| b.is_ascii_hexdigit()) {
        format!("0x{stripped}")
    } else {
        String::new()
    }
}

/// `mergeConfidentialValue(baseValue, patchValue)` — plain-object deep merge;
/// anything that is not a plain object on either side is replaced outright.
pub fn merge_confidential_value(base: &Json, patch: &Json) -> Json {
    let (Json::Object(base_map), Json::Object(patch_map)) = (base, patch) else {
        return patch.clone();
    };
    let mut merged = base_map.clone();
    for (key, value) in patch_map {
        let base_value = base_map.get(key).cloned().unwrap_or(Json::Null);
        merged.insert(key.clone(), merge_confidential_value(&base_value, value));
    }
    Json::Object(merged)
}

fn env_or_empty(env: crate::core::EnvReader<'_>, names: &[&str]) -> String {
    read_env(env, names)
}

/// `resolveAllowEphemeralOracleKey()` — explicit opt-in, refused outside
/// non-production environments.
pub fn resolve_allow_ephemeral_oracle_key(env: crate::core::EnvReader<'_>) -> bool {
    let requested = normalize_boolean(
        env("MORPHEUS_ALLOW_EPHEMERAL_KEY")
            .map(Json::String)
            .as_ref(),
        false,
    );
    if !requested {
        return false;
    }
    env("NODE_ENV").map(|s| s.to_lowercase()) != Some("production".to_string())
}

/// `assertEphemeralKeyPolicy()` — the production guard that backs the opt-in.
pub fn assert_ephemeral_key_policy(env: crate::core::EnvReader<'_>) -> Result<(), String> {
    let requested = normalize_boolean(
        env("MORPHEUS_ALLOW_EPHEMERAL_KEY")
            .map(Json::String)
            .as_ref(),
        false,
    );
    let node_env_production =
        env("NODE_ENV").map(|s| s.to_lowercase()) == Some("production".to_string());
    if requested && node_env_production {
        return Err(
            "MORPHEUS_ALLOW_EPHEMERAL_KEY is not allowed when NODE_ENV=production".to_string(),
        );
    }
    Ok(())
}

/// `formatKeyMaterial` — carries the algorithm/format tags the JS object
/// includes; `public_key_raw` is the base64 rendering of the raw public key.
pub fn format_key_material(
    public_key_raw_bytes: Vec<u8>,
    private_key_pkcs8_bytes: Vec<u8>,
    source: &'static str,
) -> OracleKeyMaterial {
    use base64::Engine as _;
    OracleKeyMaterial {
        algorithm: ORACLE_ENVELOPE_ALGORITHM.to_string(),
        source,
        key_format: "raw".to_string(),
        public_key_raw: base64::engine::general_purpose::STANDARD.encode(&public_key_raw_bytes),
        public_key_raw_bytes,
        private_key_pkcs8_bytes,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OracleKeyMaterial {
    pub algorithm: String,
    pub source: &'static str,
    pub key_format: String,
    pub public_key_raw: String,
    pub public_key_raw_bytes: Vec<u8>,
    pub private_key_pkcs8_bytes: Vec<u8>,
}

fn base64_field(value: &str) -> Vec<u8> {
    buffer_from_base64(value)
}

fn required_b64_string_field(parsed: &Json, keys: &[&str]) -> String {
    js_first_truthy(parsed, keys)
        .map(js_stringify)
        .map(|s| js_trim_string(Some(&Json::String(s))))
        .unwrap_or_default()
}

/// `parseConfiguredOracleKeyMaterial()` — the plain env key-material sources:
/// a JSON blob, a base64 JSON blob, or the two explicit base64 keys. Returns
/// `Ok(None)` when nothing is configured.
pub fn parse_configured_oracle_key_material(
    env: crate::core::EnvReader<'_>,
) -> Result<Option<OracleKeyMaterial>, String> {
    let raw_json = env_or_empty(env, &["MORPHEUS_ORACLE_KEY_MATERIAL_JSON"]);
    let raw_base64 = env_or_empty(env, &["MORPHEUS_ORACLE_KEY_MATERIAL_BASE64"]);
    let explicit_public_key = env_or_empty(env, &["MORPHEUS_ORACLE_PUBLIC_KEY_RAW"]);
    let explicit_private_key = env_or_empty(env, &["MORPHEUS_ORACLE_PRIVATE_KEY_PKCS8"]);

    let parsed: Json = if !raw_json.is_empty() {
        serde_json::from_str(&raw_json)
            .map_err(|_| "MORPHEUS_ORACLE_KEY_MATERIAL_JSON is not valid JSON".to_string())?
    } else if !raw_base64.is_empty() {
        let decoded = buffer_from_base64(&raw_base64);
        let text = String::from_utf8_lossy(&decoded).into_owned();
        serde_json::from_str(&text).map_err(|_| {
            "MORPHEUS_ORACLE_KEY_MATERIAL_BASE64 is not valid base64 JSON".to_string()
        })?
    } else if !explicit_public_key.is_empty() && !explicit_private_key.is_empty() {
        serde_json::json!({
            "public_key_raw": explicit_public_key,
            "private_key_pkcs8": explicit_private_key,
        })
    } else {
        return Ok(None);
    };

    let public_key_raw =
        required_b64_string_field(&parsed, &["public_key_raw", "publicKeyRaw", "public_key"]);
    let private_key_pkcs8 = required_b64_string_field(
        &parsed,
        &["private_key_pkcs8", "privateKeyPkcs8", "private_key"],
    );
    if public_key_raw.is_empty() || private_key_pkcs8.is_empty() {
        return Err(
            "configured oracle key material requires public_key_raw and private_key_pkcs8"
                .to_string(),
        );
    }

    let source = if env("MORPHEUS_ORACLE_KEY_SOURCE").as_deref() == Some("nitro-recipient-kms") {
        "nitro-recipient-kms"
    } else {
        if env("NODE_ENV").is_some_and(|value| value.trim().eq_ignore_ascii_case("production")) {
            return Err(PLAINTEXT_ORACLE_KEY_PRODUCTION_ERROR.to_string());
        }
        "configured-env"
    };
    Ok(Some(format_key_material(
        base64_field(&public_key_raw),
        base64_field(&private_key_pkcs8),
        source,
    )))
}

/// Validate a complete X25519 pair before a KMS-released envelope is installed.
pub fn validate_oracle_key_material(material: &OracleKeyMaterial) -> Result<(), String> {
    if material.public_key_raw_bytes.len() != 32 {
        return Err("oracle X25519 public key must be 32 bytes".to_string());
    }
    let scalar = parse_x25519_pkcs8(&material.private_key_pkcs8_bytes)?;
    let expected_public = X25519_BASEPOINT.mul_clamped(scalar);
    if expected_public.as_bytes() != material.public_key_raw_bytes.as_slice() {
        return Err("oracle X25519 public and private keys do not match".to_string());
    }
    Ok(())
}

/// `parseSealedKeystoreFromEnv()` — the RC2 no-host-unseal path: only the
/// ciphertext keystore crosses the enclave boundary.
pub fn parse_sealed_keystore_from_env(
    env: crate::core::EnvReader<'_>,
) -> Result<Option<Json>, String> {
    let raw_json = env_or_empty(env, &["MORPHEUS_ORACLE_SEALED_KEYSTORE_JSON"]);
    let raw_base64 = env_or_empty(env, &["MORPHEUS_ORACLE_SEALED_KEYSTORE_BASE64"]);
    let parsed: Json = if !raw_json.is_empty() {
        serde_json::from_str(&raw_json)
            .map_err(|_| "MORPHEUS_ORACLE_SEALED_KEYSTORE_JSON is not valid JSON".to_string())?
    } else if !raw_base64.is_empty() {
        let decoded = buffer_from_base64(&raw_base64);
        let text = String::from_utf8_lossy(&decoded).into_owned();
        serde_json::from_str(&text).map_err(|_| {
            "MORPHEUS_ORACLE_SEALED_KEYSTORE_BASE64 is not valid base64 JSON".to_string()
        })?
    } else {
        return Ok(None);
    };

    let public_key_raw = required_b64_string_field(&parsed, &["public_key_raw", "publicKeyRaw"]);
    let sealed_private_key = parsed
        .get("sealed_private_key")
        .or_else(|| parsed.get("sealedPrivateKey"))
        .filter(|value| !value.is_null())
        .cloned();
    if public_key_raw.is_empty() || sealed_private_key.is_none() {
        return Err(
            "sealed oracle keystore requires public_key_raw and sealed_private_key".to_string(),
        );
    }
    Ok(Some(serde_json::json!({
        "public_key_raw": public_key_raw,
        "sealed_private_key": sealed_private_key,
    })))
}

/// `decryptPrivateKey(sealed, wrapKey)` — AES-256-GCM with the three base64
/// components kept as separate fields.
pub fn decrypt_private_key(sealed: &Json, wrap_key: &[u8]) -> Result<Vec<u8>, String> {
    let field = |name: &str| -> Result<Vec<u8>, String> {
        match sealed.get(name) {
            Some(Json::String(value)) => Ok(buffer_from_base64(value)),
            _ => Err(format!(
                "sealed private key {name} is missing or not a string"
            )),
        }
    };
    let iv = field("iv")?;
    let ciphertext = field("ciphertext")?;
    let tag = field("tag")?;

    let cipher = Aes256Gcm::new_from_slice(wrap_key)
        .map_err(|_| "oracle wrap key must be 32 bytes".to_string())?;
    let mut sealed_ct = ciphertext;
    sealed_ct.extend_from_slice(&tag);
    cipher
        .decrypt(iv.as_slice().into(), sealed_ct.as_slice())
        .map_err(|_| "sealed private key authentication failed".to_string())
}

/// `getOracleKeyStorePath()` — trimmed env value or the default absolute path.
pub fn get_oracle_keystore_path(env: crate::core::EnvReader<'_>) -> String {
    let from_env = read_env(
        env,
        &[
            "NITRO_ORACLE_KEYSTORE_PATH",
            "MORPHEUS_ORACLE_KEYSTORE_PATH",
        ],
    );
    if from_env.is_empty() {
        DEFAULT_ORACLE_KEYSTORE_PATH.to_string()
    } else {
        from_env
    }
}

/// `resolveAbsoluteKeystorePath(filePath)` — absolute on POSIX (`/...`) or
/// Windows (`C:\...`, `\\server\...`); anything else resolves under the repo
/// root the host provides.
pub fn resolve_absolute_keystore_path(file_path: &str, repo_root: &str) -> String {
    let absolute = file_path.starts_with('/')
        || file_path.starts_with('\\')
        || (file_path.as_bytes().get(1) == Some(&b':')
            && matches!(file_path.as_bytes().get(2), Some(b'\\') | Some(b'/') | None));
    if absolute {
        file_path.to_string()
    } else {
        format!("{repo_root}/{file_path}")
    }
}

/// `deriveOracleWrapKey()` with the Secrets-Manager derivation injected: the
/// host derives `deriveKeyBytes(keyPath, 'oracle-encryption-wrap')`.
pub type WrapKeyDeriver<'a> = &'a dyn Fn(&str, &str) -> Result<Vec<u8>, String>;

pub fn derive_oracle_wrap_key(
    env: crate::core::EnvReader<'_>,
    deriver: WrapKeyDeriver<'_>,
) -> Result<Vec<u8>, String> {
    let from_env = read_env(
        env,
        &[
            "NITRO_DSTACK_ORACLE_ENCRYPTION_KEY_PATH",
            "MORPHEUS_ORACLE_ENCRYPTION_KEY_PATH",
        ],
    );
    let key_path = if from_env.is_empty() {
        "morpheus/oracle/encryption/wrap/v1".to_string()
    } else {
        from_env
    };
    let bytes = deriver(&key_path, "oracle-encryption-wrap")?;
    if bytes.len() < 32 {
        return Err(format!(
            "oracle wrap key derivation produced {} bytes, expected at least 32",
            bytes.len()
        ));
    }
    Ok(bytes[..32].to_vec())
}

/// The keystore file reader is injected; `KeystoreReadError` preserves the
/// JS error-class split (ENOENT → optional, SyntaxError → descriptive,
/// anything else rethrown).
#[derive(Debug, Clone, PartialEq)]
pub enum KeystoreReadError {
    NotFound,
    InvalidJson(String),
    Other(String),
}

pub type KeystoreReader<'a> = &'a dyn Fn(&str) -> Result<String, KeystoreReadError>;

/// `loadStableOracleKeyMaterial()` — sealed env keystore first, then the
/// keystore file. `Ok(None)` is the expected cold-start sentinel.
pub fn load_stable_oracle_key_material(
    env: crate::core::EnvReader<'_>,
    deriver: WrapKeyDeriver<'_>,
    reader: KeystoreReader<'_>,
    repo_root: &str,
) -> Result<Option<OracleKeyMaterial>, String> {
    let wrap_key = derive_oracle_wrap_key(env, deriver)?;

    if let Some(sealed) = parse_sealed_keystore_from_env(env)? {
        let public_key_raw_bytes = {
            let encoded = sealed
                .get("public_key_raw")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            buffer_from_base64(encoded)
        };
        let sealed_private_key = sealed
            .get("sealed_private_key")
            .cloned()
            .unwrap_or(Json::Null);
        let private_key_pkcs8_bytes = decrypt_private_key(&sealed_private_key, &wrap_key)?;
        return Ok(Some(format_key_material(
            public_key_raw_bytes,
            private_key_pkcs8_bytes,
            "nitro-sealed-env",
        )));
    }

    let keystore_path = resolve_absolute_keystore_path(&get_oracle_keystore_path(env), repo_root);
    let raw = match reader(&keystore_path) {
        Ok(raw) => raw,
        Err(KeystoreReadError::NotFound) => return Ok(None),
        Err(KeystoreReadError::InvalidJson(message)) => {
            return Err(format!(
                "keystore at {keystore_path} contains invalid JSON: {message}"
            ));
        }
        Err(KeystoreReadError::Other(message)) => return Err(message),
    };
    let parsed: Json = serde_json::from_str(&raw)
        .map_err(|error| format!("keystore at {keystore_path} contains invalid JSON: {error}"))?;

    let public_key_raw = required_b64_string_field(&parsed, &["public_key_raw"]);
    let sealed_private_key = parsed.get("sealed_private_key").cloned();
    if public_key_raw.is_empty() || sealed_private_key.is_none() {
        return Err("legacy or malformed X25519 keystore".to_string());
    }
    let private_key_pkcs8_bytes = decrypt_private_key(&sealed_private_key.unwrap(), &wrap_key)?;
    Ok(Some(format_key_material(
        buffer_from_base64(&public_key_raw),
        private_key_pkcs8_bytes,
        "nitro-sealed",
    )))
}

/// `generateX25519KeyMaterial()` with the randomness injected: RFC 7748
/// clamping plus the constant PKCS#8 shell WebCrypto exports.
pub fn generate_x25519_key_material(rng: &mut dyn FnMut(&mut [u8])) -> OracleKeyMaterial {
    let mut scalar = [0u8; 32];
    rng(&mut scalar);
    scalar[0] &= 248;
    scalar[31] &= 127;
    scalar[31] |= 64;
    let public = X25519_BASEPOINT.mul_clamped(scalar);
    let mut pkcs8 = Vec::with_capacity(48);
    pkcs8.extend_from_slice(&X25519_PKCS8_PREFIX);
    pkcs8.extend_from_slice(&scalar);
    format_key_material(public.as_bytes().to_vec(), pkcs8, "ephemeral-memory")
}

/// `parseX25519Envelope(ciphertext)` — base64 → UTF-8 JSON → version and
/// algorithm gate → the four required fields. `None` for anything that is not
/// a v2 envelope (the caller then reports the unsupported-format error).
pub fn parse_x25519_envelope(ciphertext: &str) -> Option<X25519Envelope> {
    let decoded = decode_base64(ciphertext);
    let text = String::from_utf8_lossy(&decoded);
    let parsed: Json = serde_json::from_str(&text).ok()?;
    if !is_plain_object(&parsed) {
        return None;
    }
    let version = parsed
        .get("v")
        .filter(|value| !value.is_null())
        .or_else(|| parsed.get("version").filter(|value| !value.is_null()));
    let version = js_to_number(version?);
    if version != ORACLE_ENVELOPE_VERSION as f64 {
        return None;
    }
    let algorithm = js_trim_string(
        parsed
            .get("alg")
            .filter(|value| !value.is_null())
            .or_else(|| parsed.get("algorithm").filter(|value| !value.is_null())),
    );
    if algorithm != ORACLE_ENVELOPE_ALGORITHM {
        return None;
    }
    let field = |name: &str| -> Option<String> {
        let value = parsed.get(name)?;
        let rendered = js_stringify(value);
        if js_trim_string(Some(&Json::String(rendered.clone()))).is_empty() {
            None
        } else {
            Some(rendered)
        }
    };
    Some(X25519Envelope {
        epk: field("epk")?,
        iv: field("iv")?,
        ct: field("ct")?,
        tag: field("tag")?,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct X25519Envelope {
    pub epk: String,
    pub iv: String,
    pub ct: String,
    pub tag: String,
}

/// `importX25519PrivateKey` — WebCrypto refuses anything that is not the
/// constant 48-byte PKCS#8 shell; so does the port.
pub fn parse_x25519_pkcs8(bytes: &[u8]) -> Result<[u8; 32], String> {
    if bytes.len() != 48 || bytes[..16] != X25519_PKCS8_PREFIX {
        return Err("invalid X25519 private key pkcs8 encoding".to_string());
    }
    let mut scalar = [0u8; 32];
    scalar.copy_from_slice(&bytes[16..48]);
    Ok(scalar)
}

/// `deriveAesKey` + `decryptX25519Envelope` — ECDH over the sender's public
/// key, HKDF-SHA256 (salt = recipient public key, info = envelope info ‖
/// sender ‖ recipient), AES-256-GCM over `ct ‖ tag`.
pub fn decrypt_x25519_envelope(
    envelope: &X25519Envelope,
    key_material: &OracleKeyMaterial,
) -> Result<String, String> {
    let sender_public_key_bytes = decode_base64(&envelope.epk);
    if sender_public_key_bytes.len() != 32 {
        return Err("invalid X25519 envelope public key length".to_string());
    }
    let iv = decode_base64(&envelope.iv);
    if iv.len() != AES_GCM_IV_LENGTH_BYTES {
        return Err("invalid X25519 envelope iv length".to_string());
    }
    let tag = decode_base64(&envelope.tag);
    if tag.len() != AES_GCM_TAG_LENGTH_BYTES {
        return Err("invalid X25519 envelope tag length".to_string());
    }

    let scalar = parse_x25519_pkcs8(&key_material.private_key_pkcs8_bytes)?;
    let mut sender_point = [0u8; 32];
    sender_point.copy_from_slice(&sender_public_key_bytes);
    let shared = MontgomeryPoint(sender_point).mul_clamped(scalar);
    if shared.as_bytes() == &[0u8; 32] {
        return Err("x25519 deriveBits rejected the all-zero shared secret".to_string());
    }

    let recipient_public_key_bytes = &key_material.public_key_raw_bytes;
    let mut info =
        Vec::with_capacity(ORACLE_ENVELOPE_INFO.len() + 32 + recipient_public_key_bytes.len());
    info.extend_from_slice(ORACLE_ENVELOPE_INFO);
    info.extend_from_slice(&sender_public_key_bytes);
    info.extend_from_slice(recipient_public_key_bytes);
    let hkdf = Hkdf::<Sha256>::new(Some(recipient_public_key_bytes), shared.as_bytes());
    let mut aes_key = [0u8; 32];
    hkdf.expand(&info, &mut aes_key)
        .map_err(|_| "hkdf expand failed".to_string())?;

    let cipher = Aes256Gcm::new_from_slice(&aes_key)
        .map_err(|_| "derived aes key must be 32 bytes".to_string())?;
    let mut sealed_ct = decode_base64(&envelope.ct);
    sealed_ct.extend_from_slice(&tag);
    let plaintext = cipher
        .decrypt(iv.as_slice().into(), sealed_ct.as_slice())
        .map_err(|_| "aes-gcm decryption failed".to_string())?;
    Ok(String::from_utf8_lossy(&plaintext).into_owned())
}

/// `decryptEncryptedToken(ciphertext, payload)` without the payload: key
/// resolution is the caller's decision (the JS singleton cache is a runtime
/// concern the host owns).
pub fn decrypt_encrypted_token(
    ciphertext: &str,
    key_material: &OracleKeyMaterial,
) -> Result<Option<String>, String> {
    if ciphertext.is_empty() {
        return Ok(None);
    }
    let envelope = parse_x25519_envelope(ciphertext).ok_or_else(|| {
        format!("unsupported confidential payload format; expected {ORACLE_ENVELOPE_ALGORITHM}")
    })?;
    Ok(Some(decrypt_x25519_envelope(&envelope, key_material)?))
}

/// `ensureOracleKeyMaterial` decision tree without the promise singleton:
/// configured env → stable (sealed env, keystore file) → ephemeral, with the
/// same warning events and the same refusal outside development. The JS
/// singleton deliberately does not cache a rejected resolution — that policy
/// is the host's retry loop, not a pure-lane concern.
///
/// The ephemeral branch mints a NEW key on every call, this one included. That
/// is only correct for a caller whose single lane both mints and consumes the
/// key. A host that advertises the key on one route and decrypts with it on
/// another must serve ONE key from both, or the advertised material decrypts
/// nothing; such a caller uses [`resolve_oracle_key_material_with_ephemeral`]
/// and supplies the process-lifetime key it also serves.
pub fn resolve_oracle_key_material(
    env: crate::core::EnvReader<'_>,
    deriver: WrapKeyDeriver<'_>,
    reader: KeystoreReader<'_>,
    repo_root: &str,
    warn_log: &dyn Fn(&str, &str, &str),
    rng: &mut dyn FnMut(&mut [u8]),
) -> Result<OracleKeyMaterial, String> {
    resolve_oracle_key_material_with_ephemeral(
        env,
        deriver,
        reader,
        repo_root,
        warn_log,
        &mut || generate_x25519_key_material(rng),
    )
}

/// [`resolve_oracle_key_material`] with the ephemeral key owned by the caller:
/// the decision tree, the warning events and the development-only policy are
/// identical, and only the last step differs — `ephemeral()` returns the key
/// to serve instead of a freshly generated one. The caller is responsible for
/// the lifetime of what it returns, and for returning the SAME key to every
/// lane that must interoperate with it.
pub fn resolve_oracle_key_material_with_ephemeral(
    env: crate::core::EnvReader<'_>,
    deriver: WrapKeyDeriver<'_>,
    reader: KeystoreReader<'_>,
    repo_root: &str,
    warn_log: &dyn Fn(&str, &str, &str),
    ephemeral: &mut dyn FnMut() -> OracleKeyMaterial,
) -> Result<OracleKeyMaterial, String> {
    assert_ephemeral_key_policy(env)?;
    match parse_configured_oracle_key_material(env) {
        Ok(Some(material)) => return Ok(material),
        Ok(None) => {}
        Err(error) if error == PLAINTEXT_ORACLE_KEY_PRODUCTION_ERROR => return Err(error),
        Err(error) => warn_log(
            "oracle.key_material.configured_source_failed",
            &error,
            "stable-keystore",
        ),
    }
    match load_stable_oracle_key_material(env, deriver, reader, repo_root) {
        Ok(Some(material)) => return Ok(material),
        Ok(None) => {}
        Err(error) => warn_log(
            "oracle.key_material.stable_source_failed",
            &error,
            "ephemeral-memory",
        ),
    }
    if !resolve_allow_ephemeral_oracle_key(env) {
        return Err("oracle key material unavailable: no configured key, Secrets Manager sealed keystore, or ephemeral key not allowed".to_string());
    }
    Ok(ephemeral())
}

/// `resolveEncryptedPayload(payload)` — the token-ciphertext truthy chain.
pub fn resolve_encrypted_payload(payload: &Json) -> String {
    let encrypted_inputs = payload.get("encrypted_inputs");
    let mut candidates: Vec<&Json> = vec![
        payload.get("encrypted_payload").unwrap_or(&Json::Null),
        payload.get("encrypted_token").unwrap_or(&Json::Null),
    ];
    if let Some(inputs) = encrypted_inputs {
        for key in ["payload", "api_token", "token"] {
            candidates.push(inputs.get(key).unwrap_or(&Json::Null));
        }
    }
    candidates
        .into_iter()
        .find(|value| crate::js::js_truthy(value))
        .map(|value| js_trim_string(Some(value)))
        .unwrap_or_default()
}

/// `resolveEncryptedTokenRef(payload)`.
pub fn resolve_encrypted_token_ref(payload: &Json) -> String {
    ref_chain(
        payload,
        &[
            ("payload", "encrypted_token_ref"),
            ("encrypted_inputs", "api_token_ref"),
            ("encrypted_inputs", "token_ref"),
        ],
    )
}

/// `resolveEncryptedConfidentialPayload(payload)` — params/input take
/// precedence over the payload alias.
pub fn resolve_encrypted_confidential_payload(payload: &Json) -> String {
    let mut candidates: Vec<(&str, &str)> = vec![
        ("payload", "encrypted_params"),
        ("payload", "encrypted_input"),
        ("encrypted_inputs", "params"),
        ("encrypted_inputs", "input"),
        ("payload", "encrypted_payload"),
        ("encrypted_inputs", "payload"),
    ];
    confidential_chain(payload, &mut candidates)
}

/// `resolveEncryptedConfidentialRef(payload)`.
pub fn resolve_encrypted_confidential_ref(payload: &Json) -> String {
    ref_chain(
        payload,
        &[
            ("payload", "encrypted_params_ref"),
            ("payload", "encrypted_input_ref"),
            ("payload", "encrypted_payload_ref"),
            ("encrypted_inputs", "params_ref"),
            ("encrypted_inputs", "input_ref"),
            ("encrypted_inputs", "payload_ref"),
        ],
    )
}

/// `resolveConfidentialPayload(payload)` (crypto.js:643) — inline ciphertext
/// first, then the encrypted-ref claim, then decrypt + JSON.parse and merge
/// the plaintext into a spread copy of the payload with the consumed envelope
/// fields dropped. Key material is the caller's decision (see
/// [`decrypt_encrypted_token`]); every non-decryptable step degrades to the
/// original payload exactly like the JS early returns, while a decrypt THROW
/// (unsupported envelope format, bad ciphertext) propagates as `Err`.
pub fn resolve_confidential_payload(
    payload: &Json,
    env: EnvReader<'_>,
    transport: HttpTransport<'_>,
    key_material: &OracleKeyMaterial,
) -> Result<Json, String> {
    let mut ciphertext = resolve_encrypted_confidential_payload(payload);
    let encrypted_ref = resolve_encrypted_confidential_ref(payload);
    if ciphertext.is_empty() && !encrypted_ref.is_empty() {
        ciphertext = load_encrypted_ciphertext_by_ref(&encrypted_ref, payload, env, transport)?;
    }
    if ciphertext.is_empty() {
        return Ok(payload.clone());
    }
    let Some(plaintext) = decrypt_encrypted_token(&ciphertext, key_material)? else {
        return Ok(payload.clone());
    };
    // JS `if (!plaintext) return payload` — an empty plaintext is falsy.
    if plaintext.is_empty() {
        return Ok(payload.clone());
    }
    let parsed = match serde_json::from_str::<Json>(&plaintext) {
        Ok(parsed) => parsed,
        Err(_) => return Ok(payload.clone()),
    };
    if !is_plain_object(&parsed) {
        return Ok(payload.clone());
    }

    let mut merged = crate::js::js_object_spread(payload);
    merged.shift_remove("encrypted_params");
    merged.shift_remove("encrypted_input");
    if merged.get("encrypted_payload").and_then(Json::as_str) == Some(ciphertext.as_str()) {
        merged.shift_remove("encrypted_payload");
    }
    if is_plain_object(merged.get("encrypted_inputs").unwrap_or(&Json::Null)) {
        let mut inputs = crate::js::js_object_spread(merged.get("encrypted_inputs").unwrap());
        for key in ["params", "input", "payload"] {
            if inputs.get(key).and_then(Json::as_str) == Some(ciphertext.as_str()) {
                inputs.shift_remove(key);
            }
        }
        if inputs.is_empty() {
            merged.shift_remove("encrypted_inputs");
        } else {
            merged.insert("encrypted_inputs".to_string(), Json::Object(inputs));
        }
    }
    Ok(merge_confidential_value(&Json::Object(merged), &parsed))
}

fn ref_chain(payload: &Json, chain: &[(&str, &str)]) -> String {
    let encrypted_inputs =
        if is_plain_object(payload.get("encrypted_inputs").unwrap_or(&Json::Null)) {
            payload.get("encrypted_inputs").unwrap()
        } else {
            &Json::Null
        };
    for (container, key) in chain.iter().copied() {
        let source = match container {
            "payload" => payload,
            _ => encrypted_inputs,
        };
        if let Some(value) = source.get(key) {
            if crate::js::js_truthy(value) {
                return js_trim_string(Some(value));
            }
        }
    }
    String::new()
}

fn confidential_chain(payload: &Json, chain: &mut [(&str, &str)]) -> String {
    let encrypted_inputs =
        if is_plain_object(payload.get("encrypted_inputs").unwrap_or(&Json::Null)) {
            payload.get("encrypted_inputs").unwrap()
        } else {
            &Json::Null
        };
    for (container, key) in chain.iter().copied() {
        let source = match container {
            "payload" => payload,
            _ => encrypted_inputs,
        };
        if let Some(value) = source.get(key) {
            if crate::js::js_truthy(value) {
                return js_trim_string(Some(value));
            }
        }
    }
    String::new()
}

/// `resolveEncryptedRefRequestId(payload)`.
pub fn resolve_encrypted_ref_request_id(payload: &Json) -> String {
    js_first_truthy(payload, &["request_id", "requestId"])
        .map(|value| js_trim_string(Some(value)))
        .unwrap_or_default()
}

/// `readEncryptedRefConsumedRequestId(row)`.
pub fn read_encrypted_ref_consumed_request_id(row: &Json) -> String {
    let metadata = match row.get("metadata") {
        Some(value) if is_plain_object(value) => value,
        _ => &Json::Null,
    };
    let candidates = [
        row.get("consumed_request_id").unwrap_or(&Json::Null),
        metadata.get("_consumed_request_id").unwrap_or(&Json::Null),
    ];
    for value in candidates {
        if crate::js::js_truthy(value) {
            return js_trim_string(Some(value));
        }
    }
    String::new()
}

/// The refusal an expired stored ciphertext gets. Deliberately distinct from
/// the not-found message: "expired" is an operator-actionable state (rotate
/// the credential upstream), "not found" is a caller mistake, and collapsing
/// the two is how a TTL stops being diagnosable.
pub const ENCRYPTED_REF_EXPIRED_REFUSAL: &str = "encrypted ref expired";

/// Seconds since the Unix epoch, for the use-time expiry comparison.
pub fn now_unix_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs() as i64)
        .unwrap_or(0)
}

/// `expires_at` is a Postgres `timestamptz` rendered by PostgREST as an
/// ISO-8601 string. Parse the fixed prefix (`YYYY-MM-DDTHH:MM:SS`) into an
/// epoch second; anything that does not have that shape yields `None`.
///
/// A row whose `expires_at` is absent, null, empty or unparseable is treated
/// as "no TTL" — the same reading the schema gives a NULL column and the same
/// reading the listing API's `expires_at.is.null` branch gives it. An
/// unparseable non-empty value is the one debatable case; it is refused
/// below rather than silently accepted, because a TTL nobody can read is not
/// a TTL that has passed the check.
pub fn parse_expires_at_seconds(value: Option<&Json>) -> Option<Result<i64, ()>> {
    let text = js_trim_string(value);
    if text.is_empty() {
        return None;
    }
    let bytes = text.as_bytes();
    if bytes.len() < 19 {
        return Some(Err(()));
    }
    let number = |from: usize, to: usize| -> Option<i64> { text[from..to].parse::<i64>().ok() };
    let (Some(year), Some(month), Some(day)) = (number(0, 4), number(5, 7), number(8, 10)) else {
        return Some(Err(()));
    };
    let (Some(hour), Some(minute), Some(second)) = (number(11, 13), number(14, 16), number(17, 19))
    else {
        return Some(Err(()));
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Some(Err(()));
    }
    let days = days_from_civil(year, month as u32, day as u32);
    Some(Ok(days * 86_400 + hour * 3_600 + minute * 60 + second))
}

/// `assertEncryptedRefNotExpired(row, nowSeconds)` — CL-21's "expiry is
/// enforced at USE time inside the enclave, not only by a cleanup job". There
/// is no cleanup job in this repository, so before this check an expired row
/// lived and was spendable forever.
pub fn assert_encrypted_ref_not_expired(row: &Json, now_seconds: i64) -> Result<(), String> {
    match parse_expires_at_seconds(row.get("expires_at")) {
        None => Ok(()),
        Some(Err(())) => Err(format!(
            "{ENCRYPTED_REF_EXPIRED_REFUSAL}: expires_at is not a readable timestamp"
        )),
        Some(Ok(expires_at)) if now_seconds >= expires_at => {
            Err(ENCRYPTED_REF_EXPIRED_REFUSAL.to_string())
        }
        Some(Ok(_)) => Ok(()),
    }
}

/// Days since the Unix epoch for a proleptic-Gregorian date — the inverse of
/// [`civil_from_days`], which this module already carries for the claim
/// stamps (Howard Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month = month as i64;
    let day = day as i64;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// `assertEncryptedRefScope(row, payload)` — metadata bindings must match the
/// requester/callback context the request carries.
pub fn assert_encrypted_ref_scope(row: &Json, payload: &Json) -> Result<(), String> {
    let metadata = match row.get("metadata") {
        Some(value) if is_plain_object(value) => value,
        _ => &Json::Null,
    };
    let bound_requester = normalize_hash160(
        &js_first_truthy(metadata, &["bound_requester", "requester"])
            .cloned()
            .unwrap_or(Json::Null),
    );
    let bound_callback_contract = normalize_hash160(
        &js_first_truthy(metadata, &["bound_callback_contract", "callback_contract"])
            .cloned()
            .unwrap_or(Json::Null),
    );
    let expected_requester = normalize_hash160(
        &js_first_truthy(payload, &["requester", "requester_script_hash"])
            .cloned()
            .unwrap_or(Json::Null),
    );
    let expected_callback_contract = normalize_hash160(
        &js_first_truthy(payload, &["callback_contract", "callbackContract"])
            .cloned()
            .unwrap_or(Json::Null),
    );

    if !bound_requester.is_empty() {
        if expected_requester.is_empty() {
            return Err(
                "encrypted ref requester binding present but requester context is missing"
                    .to_string(),
            );
        }
        if bound_requester != expected_requester {
            return Err("encrypted ref requester mismatch".to_string());
        }
    }

    if !bound_callback_contract.is_empty() {
        if expected_callback_contract.is_empty() {
            return Err(
                "encrypted ref callback binding present but callback context is missing"
                    .to_string(),
            );
        }
        if bound_callback_contract != expected_callback_contract {
            return Err("encrypted ref callback mismatch".to_string());
        }
    }
    Ok(())
}

/// `resolveEncryptedTokenCiphertext(payload)` (crypto.js:279) — the direct
/// ciphertext wins; otherwise the encrypted-token ref resolves through the
/// encrypted-secrets REST table.
pub fn resolve_encrypted_token_ciphertext(
    payload: &Json,
    env: EnvReader<'_>,
    transport: HttpTransport<'_>,
) -> Result<String, String> {
    let direct_ciphertext = resolve_encrypted_payload(payload);
    if !direct_ciphertext.is_empty() {
        return Ok(direct_ciphertext);
    }
    let encrypted_token_ref = resolve_encrypted_token_ref(payload);
    if encrypted_token_ref.is_empty() {
        return Ok(String::new());
    }
    load_encrypted_ciphertext_by_ref(&encrypted_token_ref, payload, env, transport)
}

/// `resolvePayloadNetwork(payload, normalizeMorpheusNetwork(env(...)))` — the
/// network the encrypted-secrets row is scoped to.
fn resolve_ref_network(payload: &Json, env: EnvReader<'_>) -> Result<String, String> {
    let scoped = normalize_morpheus_network_strict(
        &read_env(env, &["MORPHEUS_NETWORK", "NEXT_PUBLIC_MORPHEUS_NETWORK"]),
        "testnet",
    )?;
    resolve_payload_network_strict(payload, &scoped)
}

fn supabase_headers(api_key: &str, extra: &[(&str, &str)]) -> Vec<(String, String)> {
    let mut headers = vec![
        ("apikey".to_string(), api_key.to_string()),
        ("authorization".to_string(), format!("Bearer {api_key}")),
        ("accept".to_string(), "application/json".to_string()),
    ];
    for (name, value) in extra {
        headers.push((name.to_string(), value.to_string()));
    }
    headers
}

fn transport_error_message(response: &HttpResponse) -> String {
    String::from_utf8_lossy(&response.body).into_owned()
}

/// `loadEncryptedCiphertextByRef(ref, payload)` (crypto.js:313) — look the ref
/// up in `morpheus_encrypted_secrets` scoped to the request's network, assert
/// the requester/callback bindings, then claim it (single-consumption CAS via
/// the `_consumed_request_id` metadata filter + PATCH).
pub fn load_encrypted_ciphertext_by_ref(
    encrypted_ref: &str,
    payload: &Json,
    env: EnvReader<'_>,
    transport: HttpTransport<'_>,
) -> Result<String, String> {
    let request_id = resolve_encrypted_ref_request_id(payload);
    if request_id.is_empty() {
        return Err("request_id is required when resolving an encrypted ref".to_string());
    }
    let Some(rest_config) = crate::core::get_supabase_rest_config(env) else {
        return Err(
            "SUPABASE_URL and a Supabase secret or service-role key are required for encrypted ref resolution"
                .to_string(),
        );
    };
    let network = resolve_ref_network(payload, env)?;

    let mut url = Url::parse(&format!(
        "{}/morpheus_encrypted_secrets",
        rest_config.rest_url
    ))
    .map_err(|_| "Invalid URL".to_string())?;
    {
        let mut pairs = url.query_pairs_mut();
        // `expires_at` is selected so an expired row can be refused with its
        // own diagnosable error rather than looking like "not found"
        // (SVC-C-4, CL-21).
        pairs.append_pair("select", "id,ciphertext,network,metadata,expires_at");
        pairs.append_pair("id", &format!("eq.{encrypted_ref}"));
        pairs.append_pair("network", &format!("eq.{network}"));
        pairs.append_pair("limit", "1");
    }

    let request = HttpRequest {
        url: url.to_string(),
        method: "GET".to_string(),
        headers: supabase_headers(&rest_config.api_key, &[]),
        body: None,
        timeout_ms: REF_CLAIM_TIMEOUT_MS,
        follow_redirects: true,
    };
    let response = transport(&request)?;
    if !(200..300).contains(&response.status) {
        let text = transport_error_message(&response);
        return Err(
            format!("encrypted ref lookup failed: {} {}", response.status, text)
                .trim()
                .to_string(),
        );
    }
    let rows: Json = serde_json::from_slice(&response.body).unwrap_or(Json::Array(Vec::new()));
    let row = match &rows {
        Json::Array(items) => items.first().cloned().unwrap_or(Json::Null),
        _ => Json::Null,
    };
    assert_encrypted_ref_scope(&row, payload)?;
    // Expiry is enforced HERE, at use time, before the row is claimed and the
    // credential is spent. The operator-facing list already hid expired rows
    // (`apps/web/app/api/registry/secrets/route.ts`), so without this the TTL
    // was a UI filter presented as a security control: a developer who set
    // `expires_at` to bound a leaked-ciphertext window saw the secret vanish
    // from the console while the enclave kept decrypting and spending it.
    assert_encrypted_ref_not_expired(&row, now_unix_seconds())?;
    let claimed_row = claim_encrypted_ref(&row, payload, &rest_config, &network, transport)?;
    let effective_row = if claimed_row.is_null() {
        &row
    } else {
        &claimed_row
    };
    let ciphertext = js_trim_string(effective_row.get("ciphertext"));
    if ciphertext.is_empty() {
        return Err(format!("encrypted ref not found: {encrypted_ref}"));
    }
    Ok(ciphertext)
}

/// `buildEncryptedRefClaimUrl(restUrl, ref, network, payload)` — the PATCH
/// filter: an unclaimed row bound to this requester/callback.
fn build_encrypted_ref_claim_url(
    rest_url: &str,
    encrypted_ref: &str,
    network: &str,
    payload: &Json,
) -> Result<Url, String> {
    let mut url = Url::parse(&format!("{rest_url}/morpheus_encrypted_secrets"))
        .map_err(|_| "Invalid URL".to_string())?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("select", "id,ciphertext,metadata,expires_at");
        pairs.append_pair("id", &format!("eq.{encrypted_ref}"));
        pairs.append_pair("network", &format!("eq.{network}"));
        pairs.append_pair("metadata->>_consumed_request_id", "is.null");
        // Belt and braces for the use-time check above: this filter is
        // evaluated by the database against the SAME clock `expires_at` was
        // written against, so a skewed enclave clock cannot claim an expired
        // row. The partial index from migration 0018 already covers it.
        pairs.append_pair("or", "(expires_at.is.null,expires_at.gt.now())");

        let metadata = payload
            .get("metadata")
            .filter(|value| is_plain_object(value))
            .cloned()
            .unwrap_or_else(|| json!({}));
        let bound_requester = normalize_hash160(
            &js_first_truthy(&metadata, &["bound_requester"])
                .cloned()
                .or_else(|| js_first_truthy(payload, &["requester"]).cloned())
                .or_else(|| js_first_truthy(payload, &["requester_script_hash"]).cloned())
                .unwrap_or(Json::Null),
        );
        let bound_callback_contract = normalize_hash160(
            &js_first_truthy(&metadata, &["bound_callback_contract"])
                .cloned()
                .or_else(|| js_first_truthy(payload, &["callback_contract"]).cloned())
                .or_else(|| js_first_truthy(payload, &["callbackContract"]).cloned())
                .unwrap_or(Json::Null),
        );
        if !bound_requester.is_empty() {
            pairs.append_pair(
                "metadata->>bound_requester",
                &format!("eq.{bound_requester}"),
            );
        }
        if !bound_callback_contract.is_empty() {
            pairs.append_pair(
                "metadata->>bound_callback_contract",
                &format!("eq.{bound_callback_contract}"),
            );
        }
    }
    Ok(url)
}

/// `claimEncryptedRef(row, payload, restConfig, network)` — re-reads through
/// the claim filter; an already-consumed row for the SAME request id is a
/// idempotent success, anything else is a conflict.
pub fn claim_encrypted_ref(
    row: &Json,
    payload: &Json,
    rest_config: &crate::core::SupabaseRestConfig,
    network: &str,
    transport: HttpTransport<'_>,
) -> Result<Json, String> {
    if !is_plain_object(row) {
        return Ok(row.clone());
    }

    let request_id = resolve_encrypted_ref_request_id(payload);
    let consumed_request_id = read_encrypted_ref_consumed_request_id(row);
    if request_id.is_empty() {
        return Err("request_id is required when resolving an encrypted ref".to_string());
    }
    if !consumed_request_id.is_empty() {
        if consumed_request_id == request_id {
            return Ok(row.clone());
        }
        return Err("encrypted ref already consumed by another request".to_string());
    }

    let encrypted_ref = js_trim_string(row.get("id"));
    if encrypted_ref.is_empty() {
        return Ok(row.clone());
    }
    let claim_url =
        build_encrypted_ref_claim_url(&rest_config.rest_url, &encrypted_ref, network, payload)?;
    let metadata = row
        .get("metadata")
        .filter(|value| is_plain_object(value))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut claim_metadata = metadata.clone();
    claim_metadata["_consumed_request_id"] = Json::String(request_id.clone());
    claim_metadata["_consumed_at"] = Json::String(now_iso8601());
    let body = json!({
        "metadata": claim_metadata,
        "updated_at": now_iso8601(),
    });
    let request = HttpRequest {
        url: claim_url.to_string(),
        method: "PATCH".to_string(),
        headers: supabase_headers(
            &rest_config.api_key,
            &[
                ("content-type", "application/json"),
                ("prefer", "return=representation"),
            ],
        ),
        body: Some(body.to_string().into_bytes()),
        timeout_ms: REF_CLAIM_TIMEOUT_MS,
        follow_redirects: true,
    };
    let response = transport(&request)?;
    if !(200..300).contains(&response.status) {
        let text = transport_error_message(&response);
        return Err(
            format!("encrypted ref claim failed: {} {}", response.status, text)
                .trim()
                .to_string(),
        );
    }

    let claimed_rows: Json =
        serde_json::from_slice(&response.body).unwrap_or(Json::Array(Vec::new()));
    let claimed_row = match &claimed_rows {
        Json::Array(items) => items.first().cloned().unwrap_or(Json::Null),
        _ => Json::Null,
    };
    if claimed_row.is_null() {
        return Err("encrypted ref already consumed by another request".to_string());
    }
    Ok(claimed_row)
}

/// `new Date().toISOString()` for the claim stamps.
pub fn now_iso8601() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| {
            let total_seconds = since.as_secs();
            let millis = since.subsec_millis();
            let days = total_seconds / 86_400;
            let seconds_of_day = total_seconds % 86_400;
            let (year, month, day) = civil_from_days(days as i64);
            format!(
                "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
                seconds_of_day / 3600,
                (seconds_of_day % 3600) / 60,
                seconds_of_day % 60
            )
        })
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_string())
}

/// Howard Hinnant's civil-from-days algorithm for the ISO stamps above.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// `decryptEncryptedToken(ciphertext, payload)` with the full key-resolution
/// decision tree — the shape the message-reveal handler and the decrypt lane
/// use once the transport-agnostic port is wired.
#[allow(clippy::too_many_arguments)]
pub fn decrypt_encrypted_token_resolved(
    ciphertext: &Json,
    env: EnvReader<'_>,
    deriver: WrapKeyDeriver<'_>,
    reader: KeystoreReader<'_>,
    repo_root: &str,
    warn_log: &dyn Fn(&str, &str, &str),
    ephemeral: &mut dyn FnMut() -> OracleKeyMaterial,
) -> Result<Option<String>, String> {
    // `decryptEncryptedToken(ciphertext)`: `if (!ciphertext) return null` is a
    // truthiness gate on the raw value, before any string handling.
    if !js_truthy(ciphertext) {
        return Ok(None);
    }
    let key_material = resolve_oracle_key_material_with_ephemeral(
        env, deriver, reader, repo_root, warn_log, ephemeral,
    )?;
    decrypt_encrypted_token(&js_stringify(ciphertext), &key_material)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;
    use serde_json::json;
    use std::collections::HashMap;

    fn env_from(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn encrypted_ref_network_rejects_unknown_explicit_labels() {
        let env = env_from(&[("MORPHEUS_NETWORK", "mainnet")]);
        assert_eq!(
            resolve_ref_network(&json!({ "network": "testnet" }), &env).unwrap(),
            "testnet"
        );
        assert!(resolve_ref_network(&json!({ "network": "staging" }), &env).is_err());
    }

    // Golden vectors harvested from Node webcrypto (the same subtle
    // generateKey/deriveBits/deriveKey calls crypto.js makes): recipient
    // keypair, sender ephemeral public key, and the exact envelope bytes.
    const GOLDEN_PUBLIC_KEY_RAW_B64: &str = "vAB/ripK5xzT1PT+KGbSvEEPfGQoxQliNWjSFjDfuhU=";
    const GOLDEN_PRIVATE_KEY_PKCS8_B64: &str =
        "MC4CAQAwBQYDK2VuBCIEIEgdmKz6RqTG40pP8SVY+7XPGOUXAIbmI4alIH3uMYZ8";
    const GOLDEN_ENVELOPE_JSON: &str = r#"{"v":2,"alg":"X25519-HKDF-SHA256-AES-256-GCM","epk":"1C44axNdzHDw2XVn2U7/uPmX+BfTgq9H4CltjiCRGWQ=","iv":"SOSWOZ3iY82CUNz6","ct":"x4/R3xIpzySVd55wSZFWh1HnCh7nmtYIAEhT","tag":"OUAJuhSWkVm/A0rWJSkFHQ=="}"#;
    const GOLDEN_PLAINTEXT: &str = r#"{"token":"golden-vector-1"}"#;

    fn golden_key_material_with_source(source: &'static str) -> OracleKeyMaterial {
        format_key_material(
            buffer_from_base64(GOLDEN_PUBLIC_KEY_RAW_B64),
            buffer_from_base64(GOLDEN_PRIVATE_KEY_PKCS8_B64),
            source,
        )
    }

    fn envelope_ciphertext(envelope_json: &str) -> String {
        STANDARD.encode(envelope_json.as_bytes())
    }

    #[test]
    fn envelope_golden_vector_from_node_webcrypto_decrypts() {
        let ciphertext = envelope_ciphertext(GOLDEN_ENVELOPE_JSON);
        let plaintext =
            decrypt_encrypted_token(&ciphertext, &golden_key_material_with_source("golden"))
                .expect("decrypts");
        assert_eq!(plaintext.as_deref(), Some(GOLDEN_PLAINTEXT));
    }

    #[test]
    fn canonical_client_fixture_decrypts_in_the_rust_owner() {
        let vector: Json = serde_json::from_str(include_str!(
            "../../tests/vectors/confidential-envelope-v2-client.json"
        ))
        .expect("shared client fixture");
        let material = format_key_material(
            buffer_from_base64(vector["public_key_raw"].as_str().expect("public key")),
            buffer_from_base64(vector["private_key_pkcs8"].as_str().expect("private key")),
            "shared-client-vector",
        );
        let plaintext =
            decrypt_encrypted_token(vector["envelope"].as_str().expect("envelope"), &material)
                .expect("client envelope decrypts");

        assert_eq!(
            plaintext.as_deref(),
            vector["plaintext"].as_str(),
            "the client encoder and measured Rust decryptor must share one wire contract"
        );
    }

    #[test]
    fn parse_x25519_envelope_rejects_non_envelopes() {
        assert!(parse_x25519_envelope(&envelope_ciphertext("{}")).is_none());
        assert!(parse_x25519_envelope(&envelope_ciphertext("[]")).is_none());
        assert!(parse_x25519_envelope(&envelope_ciphertext("not json")).is_none());
        let wrong_version = r#"{"v":1,"alg":"X25519-HKDF-SHA256-AES-256-GCM","epk":"a","iv":"a","ct":"a","tag":"a"}"#;
        assert!(parse_x25519_envelope(&envelope_ciphertext(wrong_version)).is_none());
        let string_version = r#"{"v":"2","alg":"X25519-HKDF-SHA256-AES-256-GCM","epk":"a","iv":"a","ct":"a","tag":"a"}"#;
        assert!(parse_x25519_envelope(&envelope_ciphertext(string_version)).is_some());
        let wrong_alg = r#"{"v":2,"alg":"other","epk":"a","iv":"a","ct":"a","tag":"a"}"#;
        assert!(parse_x25519_envelope(&envelope_ciphertext(wrong_alg)).is_none());
        let missing_tag =
            r#"{"v":2,"alg":"X25519-HKDF-SHA256-AES-256-GCM","epk":"a","iv":"a","ct":"a"}"#;
        assert!(parse_x25519_envelope(&envelope_ciphertext(missing_tag)).is_none());
        let null_alg = r#"{"v":2,"alg":null,"algorithm":"X25519-HKDF-SHA256-AES-256-GCM","epk":"a","iv":"a","ct":"a","tag":"a"}"#;
        assert!(parse_x25519_envelope(&envelope_ciphertext(null_alg)).is_some());
    }

    #[test]
    fn decrypt_rejects_field_length_mismatches_with_the_js_messages() {
        let swap_field = |field: &str, value: &str| {
            let mut parsed: Json = serde_json::from_str(GOLDEN_ENVELOPE_JSON).unwrap();
            parsed[field] = json!(value);
            envelope_ciphertext(&parsed.to_string())
        };
        let short_epk = swap_field("epk", &STANDARD.encode([1u8; 31]));
        assert_eq!(
            decrypt_encrypted_token(&short_epk, &golden_key_material_with_source("golden"))
                .unwrap_err(),
            "invalid X25519 envelope public key length"
        );
        let short_iv = swap_field("iv", &STANDARD.encode([1u8; 11]));
        assert_eq!(
            decrypt_encrypted_token(&short_iv, &golden_key_material_with_source("golden"))
                .unwrap_err(),
            "invalid X25519 envelope iv length"
        );
        let short_tag = swap_field("tag", &STANDARD.encode([1u8; 15]));
        assert_eq!(
            decrypt_encrypted_token(&short_tag, &golden_key_material_with_source("golden"))
                .unwrap_err(),
            "invalid X25519 envelope tag length"
        );
    }

    #[test]
    fn decrypt_rejects_a_wrong_recipient_key_and_empty_ciphertext() {
        let mut scalar = [0u8; 32];
        scalar[..30].copy_from_slice(&[9u8; 30]);
        scalar[0] &= 248;
        scalar[31] &= 127;
        scalar[31] |= 64;
        let public = X25519_BASEPOINT.mul_clamped(scalar);
        let mut pkcs8 = X25519_PKCS8_PREFIX.to_vec();
        pkcs8.extend_from_slice(&scalar);
        let stranger = format_key_material(public.as_bytes().to_vec(), pkcs8, "stranger");
        let ciphertext = envelope_ciphertext(GOLDEN_ENVELOPE_JSON);
        assert_eq!(
            decrypt_encrypted_token(&ciphertext, &stranger).unwrap_err(),
            "aes-gcm decryption failed"
        );
        let empty =
            decrypt_encrypted_token("", &golden_key_material_with_source("golden")).unwrap();
        assert!(empty.is_none());
    }

    #[test]
    fn configured_key_material_accepts_json_base64_and_explicit_keys() {
        let key_json = json!({
            "public_key_raw": GOLDEN_PUBLIC_KEY_RAW_B64,
            "private_key_pkcs8": GOLDEN_PRIVATE_KEY_PKCS8_B64,
        })
        .to_string();
        let from_json = parse_configured_oracle_key_material(&env_from(&[(
            "MORPHEUS_ORACLE_KEY_MATERIAL_JSON",
            key_json.as_str(),
        )]))
        .unwrap()
        .unwrap();
        assert_eq!(from_json, golden_key_material_with_source("configured-env"));

        let blob = json!({
            "publicKeyRaw": GOLDEN_PUBLIC_KEY_RAW_B64,
            "privateKeyPkcs8": GOLDEN_PRIVATE_KEY_PKCS8_B64,
        })
        .to_string();
        let encoded_blob = STANDARD.encode(blob.as_bytes());
        let from_base64 = parse_configured_oracle_key_material(&env_from(&[(
            "MORPHEUS_ORACLE_KEY_MATERIAL_BASE64",
            encoded_blob.as_str(),
        )]))
        .unwrap()
        .unwrap();
        assert_eq!(
            from_base64,
            golden_key_material_with_source("configured-env")
        );

        let from_explicit = parse_configured_oracle_key_material(&env_from(&[
            ("MORPHEUS_ORACLE_PUBLIC_KEY_RAW", GOLDEN_PUBLIC_KEY_RAW_B64),
            (
                "MORPHEUS_ORACLE_PRIVATE_KEY_PKCS8",
                GOLDEN_PRIVATE_KEY_PKCS8_B64,
            ),
        ]))
        .unwrap()
        .unwrap();
        assert_eq!(
            from_explicit,
            golden_key_material_with_source("configured-env")
        );

        let nothing = parse_configured_oracle_key_material(&env_from(&[])).unwrap();
        assert!(nothing.is_none());

        let invalid = parse_configured_oracle_key_material(&env_from(&[(
            "MORPHEUS_ORACLE_KEY_MATERIAL_JSON",
            "{ nope",
        )]))
        .unwrap_err();
        assert_eq!(
            invalid,
            "MORPHEUS_ORACLE_KEY_MATERIAL_JSON is not valid JSON"
        );

        let missing_fields = parse_configured_oracle_key_material(&env_from(&[(
            "MORPHEUS_ORACLE_KEY_MATERIAL_JSON",
            "{}",
        )]))
        .unwrap_err();
        assert_eq!(
            missing_fields,
            "configured oracle key material requires public_key_raw and private_key_pkcs8"
        );
    }

    fn deterministic_wrap_deriver(key_path: &str, context: &str) -> Result<Vec<u8>, String> {
        assert_eq!(key_path, "morpheus/oracle/encryption/wrap/v1");
        assert_eq!(context, "oracle-encryption-wrap");
        Ok(vec![7u8; 48])
    }

    fn no_file_reader(_path: &str) -> Result<String, KeystoreReadError> {
        Err(KeystoreReadError::Other("must not read files".to_string()))
    }

    #[test]
    fn sealed_keystore_from_env_unseals_in_tee() {
        let wrap_key = vec![7u8; 32];
        let pkcs8 = buffer_from_base64(GOLDEN_PRIVATE_KEY_PKCS8_B64);
        let cipher = Aes256Gcm::new_from_slice(&wrap_key).unwrap();
        let iv = [3u8; 12];
        let sealed = cipher
            .encrypt(iv.as_slice().into(), pkcs8.as_slice())
            .unwrap();
        let (ct, tag) = sealed.split_at(sealed.len() - 16);
        let keystore = json!({
            "algorithm": "x25519-hkdf-sha256-aes-256-gcm",
            "version": 2,
            "public_key_raw": GOLDEN_PUBLIC_KEY_RAW_B64,
            "sealed_private_key": {
                "iv": STANDARD.encode(iv),
                "ciphertext": STANDARD.encode(ct),
                "tag": STANDARD.encode(tag),
            },
        })
        .to_string();
        let encoded_keystore = STANDARD.encode(keystore.as_bytes());
        let env = env_from(&[(
            "MORPHEUS_ORACLE_SEALED_KEYSTORE_BASE64",
            encoded_keystore.as_str(),
        )]);
        let material =
            load_stable_oracle_key_material(&env, &deterministic_wrap_deriver, &no_file_reader, "")
                .unwrap()
                .expect("sealed keystore resolves");
        assert_eq!(material.source, "nitro-sealed-env");
        assert_eq!(
            material,
            golden_key_material_with_source("nitro-sealed-env")
        );
    }

    #[test]
    fn sealed_keystore_env_errors_match_the_js_messages() {
        let invalid = parse_sealed_keystore_from_env(&env_from(&[(
            "MORPHEUS_ORACLE_SEALED_KEYSTORE_JSON",
            "{ nope",
        )]))
        .unwrap_err();
        assert_eq!(
            invalid,
            "MORPHEUS_ORACLE_SEALED_KEYSTORE_JSON is not valid JSON"
        );
        let missing = parse_sealed_keystore_from_env(&env_from(&[(
            "MORPHEUS_ORACLE_SEALED_KEYSTORE_JSON",
            r#"{"public_key_raw":"x"}"#,
        )]))
        .unwrap_err();
        assert_eq!(
            missing,
            "sealed oracle keystore requires public_key_raw and sealed_private_key"
        );
        let absent = parse_sealed_keystore_from_env(&env_from(&[])).unwrap();
        assert!(absent.is_none());
    }

    fn keystore_file_env(path: &str) -> impl Fn(&str) -> Option<String> {
        env_from(&[("NITRO_ORACLE_KEYSTORE_PATH", path)])
    }

    #[test]
    fn stable_keystore_file_missing_is_a_none_sentinel() {
        let material = load_stable_oracle_key_material(
            &keystore_file_env("/data/morpheus/oracle-key.json"),
            &deterministic_wrap_deriver,
            &|_| Err(KeystoreReadError::NotFound),
            "",
        )
        .unwrap();
        assert!(material.is_none());
    }

    #[test]
    fn stable_keystore_corrupt_json_is_descriptive_and_other_errors_rethrow() {
        let corrupt = load_stable_oracle_key_material(
            &keystore_file_env("/data/morpheus/oracle-key.json"),
            &deterministic_wrap_deriver,
            &|_| Ok("this is not valid json {".to_string()),
            "",
        )
        .unwrap_err();
        assert!(
            corrupt
                .starts_with("keystore at /data/morpheus/oracle-key.json contains invalid JSON:"),
            "unexpected: {corrupt}"
        );

        let denied = load_stable_oracle_key_material(
            &keystore_file_env("/data/morpheus/oracle-key.json"),
            &deterministic_wrap_deriver,
            &|_| {
                Err(KeystoreReadError::Other(
                    "EACCES: permission denied".to_string(),
                ))
            },
            "",
        )
        .unwrap_err();
        assert_eq!(denied, "EACCES: permission denied");

        let malformed = load_stable_oracle_key_material(
            &keystore_file_env("/data/morpheus/oracle-key.json"),
            &deterministic_wrap_deriver,
            &|_| Ok(r#"{"public_key_raw":"x"}"#.to_string()),
            "",
        )
        .unwrap_err();
        assert_eq!(malformed, "legacy or malformed X25519 keystore");
    }

    #[test]
    fn wrap_key_derivation_length_is_validated() {
        let short = load_stable_oracle_key_material(
            &keystore_file_env("/data/morpheus/oracle-key.json"),
            &|_, _| Ok(vec![7u8; 31]),
            &|_| Err(KeystoreReadError::NotFound),
            "",
        )
        .unwrap_err();
        assert_eq!(
            short,
            "oracle wrap key derivation produced 31 bytes, expected at least 32"
        );
    }

    #[test]
    fn key_material_falls_back_to_ephemeral_with_logged_warnings() {
        let warnings: std::sync::Arc<std::sync::Mutex<Vec<String>>> = Default::default();
        let sink = warnings.clone();
        let log = move |event: &str, error: &str, fallback: &str| {
            sink.lock()
                .unwrap()
                .push(format!("{event}|{error}|{fallback}"));
        };
        let material = resolve_oracle_key_material(
            &env_from(&[
                (
                    "NITRO_ORACLE_KEYSTORE_PATH",
                    "/data/morpheus/oracle-key.json",
                ),
                ("MORPHEUS_ALLOW_EPHEMERAL_KEY", "true"),
            ]),
            &deterministic_wrap_deriver,
            &|_| Ok("not-json".to_string()),
            "",
            &log,
            &mut |buf| buf.fill(0x11),
        )
        .unwrap();
        assert_eq!(material.source, "ephemeral-memory");
        let logged = warnings.lock().unwrap();
        assert_eq!(logged.len(), 1);
        assert!(
            logged[0].starts_with("oracle.key_material.stable_source_failed|"),
            "unexpected: {}",
            logged[0]
        );
        assert!(logged[0].contains("invalid JSON"));
        assert!(logged[0].ends_with("|ephemeral-memory"));

        let refused = resolve_oracle_key_material(
            &keystore_file_env("/data/morpheus/oracle-key.json"),
            &deterministic_wrap_deriver,
            &|_| Ok("not-json".to_string()),
            "",
            &|_, _, _| {},
            &mut |buf| buf.fill(0x11),
        )
        .unwrap_err();
        assert_eq!(
            refused,
            "oracle key material unavailable: no configured key, Secrets Manager sealed keystore, or ephemeral key not allowed"
        );
    }

    #[test]
    fn ephemeral_opt_in_refused_in_production() {
        let refused = resolve_oracle_key_material(
            &env_from(&[
                ("MORPHEUS_ALLOW_EPHEMERAL_KEY", "true"),
                ("NODE_ENV", "production"),
            ]),
            &deterministic_wrap_deriver,
            &|_| Err(KeystoreReadError::NotFound),
            "",
            &|_, _, _| {},
            &mut |buf| buf.fill(0x11),
        )
        .unwrap_err();
        assert_eq!(
            refused,
            "MORPHEUS_ALLOW_EPHEMERAL_KEY is not allowed when NODE_ENV=production"
        );

        let env = env_from(&[
            ("MORPHEUS_ALLOW_EPHEMERAL_KEY", "1"),
            ("NODE_ENV", "Production"),
        ]);
        assert!(!resolve_allow_ephemeral_oracle_key(&env));
        let env = env_from(&[
            ("MORPHEUS_ALLOW_EPHEMERAL_KEY", "true"),
            ("NODE_ENV", "staging"),
        ]);
        assert!(resolve_allow_ephemeral_oracle_key(&env));
        assert!(!resolve_allow_ephemeral_oracle_key(&env_from(&[])));
    }

    #[test]
    fn ephemeral_generation_produces_clamped_scalar_and_matching_public() {
        let mut counter = 0u8;
        let material = generate_x25519_key_material(&mut |buf| {
            for byte in buf.iter_mut() {
                *byte = counter;
                counter = counter.wrapping_add(1);
            }
        });
        assert_eq!(material.source, "ephemeral-memory");
        assert_eq!(material.private_key_pkcs8_bytes.len(), 48);
        assert_eq!(
            &material.private_key_pkcs8_bytes[..16],
            &X25519_PKCS8_PREFIX[..]
        );
        let scalar = parse_x25519_pkcs8(&material.private_key_pkcs8_bytes).unwrap();
        assert_eq!(scalar[0] & 248, scalar[0]);
        assert_eq!(scalar[31] & 128, 0);
        assert_eq!(scalar[31] & 64, 64);
        assert_eq!(
            material.public_key_raw_bytes,
            X25519_BASEPOINT.mul_clamped(scalar).as_bytes().to_vec()
        );
    }

    #[test]
    fn hash160_normalization_and_ref_scope_assertions() {
        assert_eq!(
            normalize_hash160(&json!("0xAABBCCDDEEFF00112233445566778899AABBCCDD")),
            "0xaabbccddeeff00112233445566778899aabbccdd"
        );
        assert_eq!(
            normalize_hash160(&json!("aabbccddeeff00112233445566778899aabbccdd")),
            "0xaabbccddeeff00112233445566778899aabbccdd"
        );
        assert_eq!(normalize_hash160(&json!("aabB")), "");
        assert_eq!(normalize_hash160(&json!("")), "");
        assert_eq!(normalize_hash160(&json!(null)), "");

        let requester = "0xaabbccddeeff00112233445566778899aabbccdd";
        let row = json!({ "id": "ref", "metadata": { "bound_requester": requester } });
        let matching = json!({ "requester": requester });
        assert!(assert_encrypted_ref_scope(&row, &matching).is_ok());

        let mismatched = json!({ "requester": "0xcccccccccccccccccccccccccccccccccccccccc" });
        assert_eq!(
            assert_encrypted_ref_scope(&row, &mismatched).unwrap_err(),
            "encrypted ref requester mismatch"
        );
        let no_context = json!({});
        assert_eq!(
            assert_encrypted_ref_scope(&row, &no_context).unwrap_err(),
            "encrypted ref requester binding present but requester context is missing"
        );

        let callback_row = json!({ "metadata": { "bound_callback_contract": requester } });
        let callback_payload = json!({ "callbackContract": requester });
        assert!(assert_encrypted_ref_scope(&callback_row, &callback_payload).is_ok());
        let callback_mismatch =
            json!({ "callback_contract": "0xdddddddddddddddddddddddddddddddddddddddd" });
        assert_eq!(
            assert_encrypted_ref_scope(&callback_row, &callback_mismatch).unwrap_err(),
            "encrypted ref callback mismatch"
        );
    }

    #[test]
    fn encrypted_payload_resolvers_follow_the_truthy_chains() {
        let payload = json!({
            "encrypted_payload": " top-payload ",
            "encrypted_inputs": {
                "payload": "nested",
                "token_ref": "ref-9",
            },
            "encrypted_params": "params-cipher",
        });
        assert_eq!(resolve_encrypted_payload(&payload), "top-payload");
        assert_eq!(
            resolve_encrypted_confidential_payload(&payload),
            "params-cipher"
        );
        assert_eq!(resolve_encrypted_token_ref(&payload), "ref-9");
        assert_eq!(resolve_encrypted_confidential_ref(&payload), "");

        let ref_only = json!({ "encrypted_token_ref": "ref-1", "request_id": "req-1" });
        assert_eq!(resolve_encrypted_token_ref(&ref_only), "ref-1");
        assert_eq!(resolve_encrypted_ref_request_id(&ref_only), "req-1");
        assert_eq!(resolve_encrypted_ref_request_id(&json!({})), "");

        let consumed = json!({
            "consumed_request_id": "",
            "metadata": { "_consumed_request_id": "req-9" },
        });
        assert_eq!(read_encrypted_ref_consumed_request_id(&consumed), "req-9");
        assert_eq!(read_encrypted_ref_consumed_request_id(&json!({})), "");
    }

    #[test]
    fn merge_confidential_value_deep_merges_plain_objects() {
        let base = json!({ "a": 1, "nested": { "x": 1, "keep": true }, "list": [1, 2] });
        let patch = json!({ "nested": { "x": 2, "added": "y" }, "list": [3], "b": 2 });
        let merged = merge_confidential_value(&base, &patch);
        assert_eq!(
            merged,
            json!({ "a": 1, "nested": { "x": 2, "keep": true, "added": "y" }, "list": [3], "b": 2 })
        );
        assert_eq!(
            merge_confidential_value(&json!({ "a": 1 }), &json!(5)),
            json!(5)
        );
        assert_eq!(
            merge_confidential_value(&json!([1]), &json!({ "a": 1 })),
            json!({ "a": 1 })
        );
    }

    // ---- 5b-3: the encrypted-ref REST lane over the injected transport ----

    use crate::transport::{HttpRequest, HttpResponse};

    const REQUESTER: &str = "0xaabbccddeeff00112233445566778899aabbccdd";

    fn supabase_env() -> impl Fn(&str) -> Option<String> {
        env_from(&[
            ("SUPABASE_URL", "https://sb.example"),
            ("SUPABASE_SECRET_KEY", "sk-test"),
        ])
    }

    fn json_response(status: u16, body: Json) -> Result<HttpResponse, String> {
        Ok(HttpResponse {
            status,
            headers: Vec::new(),
            body: serde_json::to_vec(&body).unwrap(),
        })
    }

    fn text_response(status: u16, body: &str) -> Result<HttpResponse, String> {
        Ok(HttpResponse {
            status,
            headers: Vec::new(),
            body: body.as_bytes().to_vec(),
        })
    }

    fn query_pairs(url: &str) -> Vec<(String, String)> {
        url::Url::parse(url)
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect()
    }

    fn assert_supabase_auth(headers: &[(String, String)]) {
        assert_eq!(headers[0], ("apikey".to_string(), "sk-test".to_string()));
        assert_eq!(
            headers[1],
            ("authorization".to_string(), "Bearer sk-test".to_string())
        );
        assert_eq!(
            headers[2],
            ("accept".to_string(), "application/json".to_string())
        );
    }

    fn ref_payload() -> Json {
        json!({
            "encrypted_token_ref": "ref-7",
            "request_id": "req-1",
            "requester": REQUESTER,
        })
    }

    fn stored_row() -> Json {
        json!({
            "id": "ref-7",
            "ciphertext": "CT-CIPHER",
            "network": "testnet",
            "metadata": { "bound_requester": REQUESTER },
        })
    }

    #[test]
    fn resolve_encrypted_token_ciphertext_direct_wins_and_gates_the_ref_lane() {
        let refusing = |_request: &HttpRequest| -> Result<HttpResponse, String> {
            panic!("network must not be reached");
        };
        // direct ciphertext wins without any network access
        assert_eq!(
            resolve_encrypted_token_ciphertext(
                &json!({ "encrypted_payload": " direct ", "encrypted_token_ref": "ref-7" }),
                &supabase_env(),
                &refusing,
            )
            .unwrap(),
            "direct"
        );
        // neither direct nor ref → empty without network
        assert_eq!(
            resolve_encrypted_token_ciphertext(&json!({}), &supabase_env(), &refusing).unwrap(),
            ""
        );
        // a ref without request_id fails before any network access
        assert_eq!(
            resolve_encrypted_token_ciphertext(
                &json!({ "encrypted_token_ref": "ref-7" }),
                &supabase_env(),
                &refusing,
            )
            .unwrap_err(),
            "request_id is required when resolving an encrypted ref"
        );
        // the ref lane needs the Supabase REST configuration
        assert_eq!(
            resolve_encrypted_token_ciphertext(
                &ref_payload(),
                &env_from(&[]),
                &refusing,
            )
            .unwrap_err(),
            "SUPABASE_URL and a Supabase secret or service-role key are required for encrypted ref resolution"
        );
    }

    #[test]
    fn resolve_encrypted_token_ciphertext_looks_up_claims_and_returns_the_claimed_ciphertext() {
        let transport = |request: &HttpRequest| -> Result<HttpResponse, String> {
            assert_eq!(request.timeout_ms, REF_CLAIM_TIMEOUT_MS);
            assert!(request.follow_redirects);
            if request.method == "GET" {
                assert_eq!(
                    request.url,
                    "https://sb.example/rest/v1/morpheus_encrypted_secrets?select=id%2Cciphertext%2Cnetwork%2Cmetadata%2Cexpires_at&id=eq.ref-7&network=eq.testnet&limit=1"
                );
                assert_supabase_auth(&request.headers);
                assert_eq!(request.body, None);
                return json_response(200, json!([stored_row()]));
            }
            assert_eq!(request.method, "PATCH");
            let sent: Json = serde_json::from_slice(request.body.as_deref().unwrap()).unwrap();
            assert_eq!(sent["metadata"]["_consumed_request_id"], json!("req-1"));
            assert_eq!(sent["metadata"]["bound_requester"], json!(REQUESTER));
            assert!(sent["metadata"]["_consumed_at"].is_string());
            assert!(sent["updated_at"].is_string());
            json_response(
                200,
                json!([{
                    "id": "ref-7",
                    "ciphertext": "CT-CIPHER-CLAIMED",
                    "metadata": {
                        "bound_requester": REQUESTER,
                        "_consumed_request_id": "req-1",
                    },
                }]),
            )
        };
        assert_eq!(
            resolve_encrypted_token_ciphertext(&ref_payload(), &supabase_env(), &transport)
                .unwrap(),
            "CT-CIPHER-CLAIMED"
        );
    }

    /// SVC-C-4 (CL-21). The enclave is what actually releases and spends the
    /// stored credential, so the TTL has to bind here. Before the fix the
    /// lookup neither selected nor filtered `expires_at`, so an expired ref
    /// kept decrypting indefinitely while the operator console
    /// (`apps/web/app/api/registry/secrets/route.ts`, which does apply
    /// `expires_at.gt.now`) showed it as gone.
    #[test]
    fn an_expired_ref_is_refused_at_use_time_not_merely_hidden_from_the_listing() {
        let expired = json!({ "expires_at": "2020-01-02T03:04:05.000Z" });
        assert_eq!(
            assert_encrypted_ref_not_expired(&expired, now_unix_seconds()).unwrap_err(),
            ENCRYPTED_REF_EXPIRED_REFUSAL,
        );
        // The refusal is its own message, never the not-found message — an
        // expired credential is an operator action, not a caller mistake.
        assert_ne!(ENCRYPTED_REF_EXPIRED_REFUSAL, "encrypted ref not found");

        // A future expiry and an absent/null/blank one are all usable.
        let future = json!({ "expires_at": "2999-12-31T23:59:59.000Z" });
        assert!(assert_encrypted_ref_not_expired(&future, now_unix_seconds()).is_ok());
        for usable in [json!({}), json!({ "expires_at": Json::Null })] {
            assert!(assert_encrypted_ref_not_expired(&usable, now_unix_seconds()).is_ok());
        }

        // Exactly at the boundary is expired: `expires_at.gt.now()` is the
        // database filter this mirrors, and it is strict.
        let boundary = json!({ "expires_at": "1970-01-01T00:00:10.000Z" });
        assert!(assert_encrypted_ref_not_expired(&boundary, 10).is_err());
        assert!(assert_encrypted_ref_not_expired(&boundary, 9).is_ok());

        // An unreadable timestamp fails closed rather than counting as "no TTL".
        let garbage = json!({ "expires_at": "whenever" });
        assert!(
            assert_encrypted_ref_not_expired(&garbage, now_unix_seconds())
                .unwrap_err()
                .starts_with(ENCRYPTED_REF_EXPIRED_REFUSAL)
        );

        // The epoch parse agrees with a known value.
        assert_eq!(
            parse_expires_at_seconds(Some(&json!("2020-01-02T03:04:05.000Z"))),
            Some(Ok(1_577_934_245)),
        );
    }

    /// The end-to-end shape: an expired row is refused BEFORE the claim PATCH
    /// runs, so the credential is never consumed, and the claim URL itself
    /// carries the database-side expiry filter as a second barrier against a
    /// skewed enclave clock.
    #[test]
    fn an_expired_row_is_never_claimed_and_the_claim_url_filters_expiry() {
        let calls = std::cell::RefCell::new(Vec::new());
        let transport = |request: &HttpRequest| -> Result<HttpResponse, String> {
            calls.borrow_mut().push(request.method.clone());
            assert_eq!(
                request.method, "GET",
                "an expired row must never be PATCHed"
            );
            let mut row = stored_row();
            row["expires_at"] = json!("2020-01-02T03:04:05.000Z");
            json_response(200, json!([row]))
        };
        assert_eq!(
            load_encrypted_ciphertext_by_ref("ref-7", &ref_payload(), &supabase_env(), &transport)
                .unwrap_err(),
            ENCRYPTED_REF_EXPIRED_REFUSAL,
        );
        assert_eq!(calls.borrow().as_slice(), ["GET"]);

        let claim_url = build_encrypted_ref_claim_url(
            "https://sb.example/rest/v1",
            "ref-7",
            "testnet",
            &ref_payload(),
        )
        .unwrap();
        assert!(
            claim_url
                .query()
                .unwrap_or_default()
                .contains("or=%28expires_at.is.null%2Cexpires_at.gt.now%28%29%29"),
            "claim URL must filter expiry database-side: {claim_url}"
        );
    }

    #[test]
    fn load_encrypted_ciphertext_by_ref_shapes_errors_and_not_found() {
        let base = json!({ "encrypted_token_ref": "ref-7", "request_id": "req-1" });
        let transport = |request: &HttpRequest| -> Result<HttpResponse, String> {
            match request.url.as_str() {
                u if u.contains("id=eq.ref-7") && request.method == "GET" => {
                    match request.url.contains("boom.example") {
                        true => text_response(503, "boom"),
                        false => json_response(200, json!([])),
                    }
                }
                _ => panic!("unexpected request {}", request.url),
            }
        };
        let env = supabase_env();
        let lookup = |payload: &Json, rest_url: &str| -> Result<String, String> {
            let env_with_url = env_from(&[
                ("SUPABASE_URL", rest_url),
                ("SUPABASE_SECRET_KEY", "sk-test"),
            ]);
            load_encrypted_ciphertext_by_ref(
                &resolve_encrypted_token_ref(payload),
                payload,
                &env_with_url,
                &transport,
            )
        };
        // non-2xx lookup → status + body text, trimmed
        assert_eq!(
            lookup(&base, "https://boom.example").unwrap_err(),
            "encrypted ref lookup failed: 503 boom"
        );
        // an empty row list falls through to the not-found error
        assert_eq!(
            lookup(&base, "https://sb.example").unwrap_err(),
            "encrypted ref not found: ref-7"
        );

        let broken = |_request: &HttpRequest| -> Result<HttpResponse, String> {
            Err("connection refused".to_string())
        };
        assert_eq!(
            load_encrypted_ciphertext_by_ref("ref-7", &base, &env, &broken).unwrap_err(),
            "connection refused"
        );
    }

    #[test]
    fn claim_encrypted_ref_cas_shape_idempotency_and_conflicts() {
        let unclaimed_row = stored_row();
        let refusing = |_request: &HttpRequest| -> Result<HttpResponse, String> {
            panic!("network must not be reached");
        };
        let rest_config = crate::core::get_supabase_rest_config(&supabase_env()).unwrap();

        // non-object rows pass through untouched
        assert_eq!(
            claim_encrypted_ref(
                &Json::Null,
                &ref_payload(),
                &rest_config,
                "testnet",
                &refusing
            )
            .unwrap(),
            Json::Null
        );
        // same request id → idempotent success without network
        let consumed_same = json!({
            "id": "ref-7",
            "metadata": { "_consumed_request_id": "req-1" },
        });
        assert_eq!(
            claim_encrypted_ref(
                &consumed_same,
                &ref_payload(),
                &rest_config,
                "testnet",
                &refusing,
            )
            .unwrap(),
            consumed_same
        );
        // a different request id → conflict, no network
        let consumed_other = json!({
            "id": "ref-7",
            "consumed_request_id": "req-0",
        });
        assert_eq!(
            claim_encrypted_ref(
                &consumed_other,
                &ref_payload(),
                &rest_config,
                "testnet",
                &refusing,
            )
            .unwrap_err(),
            "encrypted ref already consumed by another request"
        );
        // a row without an id has nothing to claim
        assert_eq!(
            claim_encrypted_ref(
                &json!({"ciphertext": "CT"}),
                &ref_payload(),
                &rest_config,
                "testnet",
                &refusing
            )
            .unwrap(),
            json!({"ciphertext": "CT"})
        );

        // the CAS PATCH: filter shape, headers, and the merged claim metadata
        let transport = |request: &HttpRequest| -> Result<HttpResponse, String> {
            assert_eq!(request.method, "PATCH");
            assert_eq!(request.timeout_ms, REF_CLAIM_TIMEOUT_MS);
            assert_supabase_auth(&request.headers);
            assert_eq!(
                request.headers[3],
                ("content-type".to_string(), "application/json".to_string())
            );
            assert_eq!(
                request.headers[4],
                ("prefer".to_string(), "return=representation".to_string())
            );
            assert_eq!(
                query_pairs(&request.url),
                vec![
                    (
                        "select".to_string(),
                        "id,ciphertext,metadata,expires_at".to_string()
                    ),
                    ("id".to_string(), "eq.ref-7".to_string()),
                    ("network".to_string(), "eq.testnet".to_string()),
                    (
                        "metadata->>_consumed_request_id".to_string(),
                        "is.null".to_string()
                    ),
                    // SVC-C-4: the CAS that consumes the credential also
                    // refuses an expired row, evaluated against the database
                    // clock rather than the enclave's.
                    (
                        "or".to_string(),
                        "(expires_at.is.null,expires_at.gt.now())".to_string()
                    ),
                    (
                        "metadata->>bound_requester".to_string(),
                        format!("eq.{REQUESTER}")
                    ),
                ]
            );
            let sent: Json = serde_json::from_slice(request.body.as_deref().unwrap()).unwrap();
            assert_eq!(sent["metadata"]["_consumed_request_id"], json!("req-1"));
            assert!(sent["metadata"]["_consumed_at"].is_string());
            assert!(sent["updated_at"].is_string());
            json_response(
                200,
                json!([{
                    "id": "ref-7",
                    "ciphertext": "CT-CIPHER",
                    "metadata": { "_consumed_request_id": "req-1" },
                }]),
            )
        };
        let payload = json!({ "request_id": "req-1", "requester": REQUESTER });
        let claimed = claim_encrypted_ref(
            &unclaimed_row,
            &payload,
            &rest_config,
            "testnet",
            &transport,
        )
        .unwrap();
        assert_eq!(claimed["ciphertext"], json!("CT-CIPHER"));

        // an empty representation means the row was claimed concurrently
        let empty = |_request: &HttpRequest| json_response(200, json!([]));
        assert_eq!(
            claim_encrypted_ref(&unclaimed_row, &payload, &rest_config, "testnet", &empty)
                .unwrap_err(),
            "encrypted ref already consumed by another request"
        );
        // a failed PATCH surfaces status + body text
        let failing = |_request: &HttpRequest| text_response(409, "duplicate key");
        assert_eq!(
            claim_encrypted_ref(&unclaimed_row, &payload, &rest_config, "testnet", &failing)
                .unwrap_err(),
            "encrypted ref claim failed: 409 duplicate key"
        );
    }

    #[test]
    fn now_iso8601_matches_the_js_shape() {
        let stamp = now_iso8601();
        let bytes = stamp.as_bytes();
        assert_eq!(stamp.len(), 24);
        assert_eq!(&stamp[..4].bytes().all(|b| b.is_ascii_digit()), &true);
        assert_eq!(bytes[4], b'-');
        assert_eq!(bytes[7], b'-');
        assert_eq!(bytes[10], b'T');
        assert_eq!(bytes[13], b':');
        assert_eq!(bytes[16], b':');
        assert!(stamp.ends_with('Z'));
        assert!(bytes[..23]
            .iter()
            .enumerate()
            .all(|(i, b)| { [4, 7, 10, 13, 16, 19].contains(&i) || b.is_ascii_digit() }));
    }

    fn unreachable_transport() -> HttpTransport<'static> {
        &|_request: &HttpRequest| unreachable!("composer must not touch the network here")
    }

    #[test]
    fn confidential_composer_merges_plaintext_and_drops_the_envelope_fields() {
        let ciphertext = envelope_ciphertext(GOLDEN_ENVELOPE_JSON);
        let payload = json!({
            "request_id": "req-1",
            "keep": "yes",
            "encrypted_params": ciphertext,
            "encrypted_input": ciphertext,
            "encrypted_payload": "different-envelope",
            "encrypted_inputs": {
                "params": ciphertext,
                "payload": ciphertext,
                "other": ciphertext,
            },
        });
        // encrypted_payload (payload alias) is the LAST inline candidate, so it
        // never reaches decrypt here; params/input win and are consumed.
        let resolved = resolve_confidential_payload(
            &payload,
            &env_from(&[]),
            unreachable_transport(),
            &golden_key_material_with_source("composer"),
        )
        .expect("golden envelope decrypts");
        let map = resolved.as_object().expect("merged object");
        assert_eq!(resolved["token"], "golden-vector-1");
        assert_eq!(resolved["keep"], "yes");
        assert!(!map.contains_key("encrypted_params"));
        assert!(!map.contains_key("encrypted_input"));
        // encrypted_payload did not match the consumed ciphertext → kept.
        assert_eq!(resolved["encrypted_payload"], "different-envelope");
        let inputs = resolved["encrypted_inputs"].as_object().expect("inputs");
        assert!(!inputs.contains_key("params"));
        // The payload alias holds the exact consumed ciphertext, so JS clears
        // it too; entries that differ (like "other") survive untouched.
        assert!(!inputs.contains_key("payload"));
        assert_eq!(
            inputs.get("other").and_then(Json::as_str),
            Some(ciphertext.as_str())
        );
    }

    #[test]
    fn confidential_composer_degrades_to_the_payload_like_js() {
        let payload = json!({ "request_id": "req-1", "keep": true });
        // No encrypted fields at all → the payload passes through untouched.
        assert_eq!(
            resolve_confidential_payload(
                &payload,
                &env_from(&[]),
                unreachable_transport(),
                &golden_key_material_with_source("composer")
            )
            .expect("no encrypted fields"),
            payload
        );
        // Unsupported ciphertext is a JS THROW, not a degradation.
        let broken = json!({ "encrypted_input": "not-an-envelope" });
        let error = resolve_confidential_payload(
            &broken,
            &env_from(&[]),
            unreachable_transport(),
            &golden_key_material_with_source("composer"),
        )
        .expect_err("unsupported envelope throws");
        assert!(error.contains("unsupported confidential payload format"));
    }
}
