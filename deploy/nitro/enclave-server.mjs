// Morpheus Oracle — compute-in-enclave server (LOCAL).
//
// A single Node process that does the oracle COMPUTE and the on-chain SIGN
// atomically: it computes the result IN-PROCESS by reusing the worker `handler`
// (no host hop between compute and signature) and signs the EXACT on-chain
// fulfillment digest the relayer produces — byte-for-byte — so the on-chain
// `fulfillRequest` verification is unchanged.
//
// CONSENSUS-CRITICAL: the digest, the result envelope and the compact callback
// bytes are NEVER re-derived here. We IMPORT the canonical builders from the
// relayer (`router.js` / `neox.js`) and feed them the same inputs the relayer's
// `prepareOracleFulfillment` feeds them, so the produced signature is identical
// to today's relayer-path signature. The only thing this server changes is WHERE
// the compute happens (in-process, inside the measured boundary) and that the
// signer never sees a caller-supplied `data_hex` for the attested tier.
//
// Scope:
//   - `POST /oracle/fulfill` — atomic compute+sign (the attested fulfillment tier).
//   - `POST /feed/sign`      — feed compute (price fetch + planFeedUpdate + scale)
//                              + sign of the SAME updateFeeds tx the feed-pusher
//                              signs today. Byte-identical to feed-pusher.mjs.
//   - `GET|POST /attestation`— nsm-attest passthrough, binding
//                              user_data = sha256(fulfillment_digest|tx_message),
//                              --public-key (signer pubkey), --nonce.
//   - `GET /health`          — compute + signer readiness.

import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Canonical compute reuse — the worker's default export `handler(Request)=>Response`.
import workerHandler from '../../workers/nitro-worker/src/worker.js';

// Canonical digest/result builders — IMPORTED, never re-derived.
//   - encodeFulfillmentResult wraps resolveCompactCallbackBytes + buildOnchainResultEnvelope
//     (resolveCompactCallbackBytes is NOT exported from router.js, so we use the
//     exported wrapper that the relayer itself uses to produce {success, result,
//     result_bytes_base64?, error}). See router.js:586 encodeFulfillmentResult.
//   - buildOnchainResultEnvelope is imported separately for the `verification` field
//     (it equals the JSON the relayer puts on-chain as `result`).
import {
  buildFulfillmentDigestBytes,
  buildWorkerPayload,
  buildOnchainResultEnvelope,
  encodeFulfillmentResult,
  resolveKernelIntent,
  resolveWorkerRoute,
} from '../../workers/morpheus-relayer/src/router.js';

// Canonical EVM digest + signer.
import {
  buildNeoXDigest,
  signNeoXFulfillment,
  resolveResultBytesHex,
} from '../../workers/morpheus-relayer/src/neox.js';

// Signer role/key resolution — the SAME resolution the enclave signer
// (nitro-signer-server.mjs) uses: reportPinnedNeoN3Role -> materialized key ->
// neon-js wallet.sign (secp256r1). Those functions are not exported from the
// signer server, so we reuse the shared resolver + sign inline with neon-js.
import { reportPinnedNeoN3Role, normalizeMorpheusNetwork } from '../../scripts/lib-neo-signers.mjs';
import { decodeCoseSign1Payload } from '../../packages/shared/src/cbor.js';
import neonPkg from '@cityofzion/neon-js';

const { wallet: neoWallet, sc, tx, u } = neonPkg;

// Canonical feed decision core — IMPORTED from the feed-pusher (the SAME function
// the host feed-pusher uses today), never re-implemented. td()/the tx builder are
// NOT exported by feed-pusher.mjs, so those are mirrored precisely below (the
// updateFeeds tx must be byte-identical to feed-pusher.mjs `pushNeoN3`).
//
// feed-pusher.mjs runs a live push cycle on import unless FEED_PUSHER_SKIP_MAIN=1.
// We pin it BEFORE the dynamic import so importing it here never touches a live
// RPC/TwelveData (mirrors the feed-pusher.test.mjs import guard).
if (process.env.FEED_PUSHER_SKIP_MAIN === undefined) {
  process.env.FEED_PUSHER_SKIP_MAIN = '1';
}
const { planFeedUpdate, toTwelveDataSymbol } = await import('../feed-pusher/feed-pusher.mjs');

const DEFAULT_PORT = 8787;

// The confidential execution-plane routes the Cloudflare control plane dispatches
// to an execution runtime (deploy/cloudflare/morpheus-control-plane/lib/execution
// -plane.js EXECUTION_PLANE_ROUTES). Serving exactly these from the in-TEE worker
// handler lets the enclave be that runtime (AA edge migration). Kept in sync with
// the control plane's set.
const EXECUTION_PLANE_PASSTHROUGH = [
  '/oracle/query',
  '/oracle/smart-fetch',
  '/compute/execute',
  // Confidential decrypt + Neo Message recipient/time-locked reveal: served by the
  // in-TEE worker (capabilities.js `oracle_decrypt` / `oracle_message_reveal`), which
  // re-derives the access decision IN the enclave. Forwarding them here lets the public
  // confidential apps complete the encrypt→reveal round-trip via the edge (the decrypt
  // uses the KMS-materialized X25519 key) instead of getting a 503.
  '/oracle/decrypt',
  '/oracle/message-reveal',
  '/neodid/bind',
  '/neodid/action-ticket',
  '/neodid/recovery-ticket',
];

// ── Neo N3 feed contract constants — MIRRORED EXACTLY from feed-pusher.mjs ──────
// These MUST stay identical to feed-pusher.mjs (pushNeoN3) or the signed
// updateFeeds message diverges from what the deployed MorpheusDataFeed verifies.
const FEED_N3_MAGIC = Number(process.env.FEED_MAGIC || 860833102);
const FEED_N3_CONTRACT = '03013f49c42a14546c8bbe58f9d434c3517fccab';
const FEED_N3_PAIR_PREFIX = 'TWELVEDATA:';
const FEED_PRICE_SCALE = 1e6; // px = Math.round(price * 1e6)  (feed-pusher.mjs:278/290)
const FEED_VALID_UNTIL_OFFSET = 500; // count + 500  (feed-pusher.mjs:315)
const FEED_TD_TIMEOUT_MS = Math.max(Number(process.env.FEED_TD_TIMEOUT_MS || 25000), 1000);
const MAX_BODY_BYTES = Math.max(Number(process.env.ENCLAVE_MAX_BODY_BYTES || 262144), 1024);
// Hard security ceilings, intentionally not runtime-configurable: the untrusted
// parent supplies preliminary fee estimates, but must not turn the updater into
// a GAS-draining signer. Neo N3 fees are fixed-8 integers (1 GAS = 1e8).
const FEED_N3_MAX_SYSTEM_FEE = 10 * 1e8;
const FEED_N3_MAX_NETWORK_FEE = 2 * 1e8;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// CBOR / COSE_Sign1 decoding (cborRead, decodeCoseSign1Payload) is single-sourced
// in @r3e-network/neo-os-services-shared/cbor (imported above), shared with the relayer
// that VERIFIES these documents, so producer and verifier agree on indefinite-
// length CBOR. A Nitro NSM attestation document is a COSE_Sign1 whose payload is a
// CBOR map with the measured pcrs / user_data / public_key / nonce; we decode just
// enough to read those committed fields.

function normalizeHex(value) {
  return trimString(value).replace(/^0x/i, '').toLowerCase();
}

function resolveNetwork() {
  return normalizeMorpheusNetwork(process.env.MORPHEUS_NETWORK || 'testnet');
}

// Worker auth: the worker `handler` requires an Authorization header matching one
// of its configured secrets (platform/auth.js requireAuth). We resolve the same
// secret from env and attach it to the in-process Request so the compute call is
// authorized exactly as a host->worker call would be.
function resolveWorkerAuthToken() {
  for (const name of ['MORPHEUS_RUNTIME_TOKEN', 'NITRO_API_TOKEN', 'NITRO_SHARED_SECRET']) {
    const value = trimString(process.env[name]);
    if (value) return value;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Runtime provisioning + auth — folds in the signer surface so this merged
// enclave is a strict SUPERSET of nitro-signer-server.mjs.
// ---------------------------------------------------------------------------
//
// A Nitro enclave boots with only the baked image ENV (no host env, no keys), so
// keys + network + the worker's runtime config arrive at runtime via POST
// /provision (exactly as the signer does). We write the provisioned values into
// process.env so the EXISTING reads (resolveNetwork(), reportPinnedNeoN3Role({env:
// process.env}), resolveWorkerAuthToken(), and the in-process worker handler's own
// config) all observe them with no further plumbing. Carrying /provision +
// /sign/payload + /keys/derived means the host start script and the flag-OFF
// relayer path (host-worker compute + a separate enclave /sign/payload) keep
// working byte-for-byte on this EIF — so swapping the signer EIF for this one is
// non-breaking, and flipping MORPHEUS_RELAYER_ENCLAVE_FULFILL later moves compute
// into the measured boundary.

const TOKEN_ENV_KEYS = [
  'NITRO_SIGNER_TOKEN',
  'MORPHEUS_RUNTIME_TOKEN',
  'NITRO_API_TOKEN',
  'NITRO_SHARED_SECRET',
];
const RUNTIME_TOKEN_KMS_CIPHERTEXT_ENV = 'MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64';
const RUNTIME_TOKEN_KMS_PURPOSE = 'neoos/nitro-runtime-auth/v1';
let runtimeTokenKmsVersion = 0;

// Plaintext signing-key env vars a host could otherwise inject via /provision to
// bypass the KMS-attested path (the materialize*FromKms() helpers no-op when one
// of these is already set, so a provisioned plaintext key would still be labelled
// 'enclave-attested'). The signer keys are KMS-sealed in-TEE, so plaintext
// provisioning is no longer needed; /provision always rejects these. The
// *_KMS_CIPHERTEXT_BASE64 variants are accepted because the host only ever holds
// ciphertext that KMS releases to an enclave with the pinned measurement.
const PLAINTEXT_KEY_ENV_KEYS = [
  // Neo N3 (secp256r1) WIFs / raw keys.
  'MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET',
  'MORPHEUS_ORACLE_VERIFIER_WIF_TESTNET',
  'MORPHEUS_ORACLE_VERIFIER_WIF',
  'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY_MAINNET',
  'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY_TESTNET',
  'MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET',
  'MORPHEUS_UPDATER_NEO_N3_WIF_TESTNET',
  'MORPHEUS_UPDATER_NEO_N3_WIF',
  'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_MAINNET',
  'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_TESTNET',
  // Neo X (EVM, secp256k1) keys.
  'MORPHEUS_NEOX_VERIFIER_PRIVATE_KEY',
  'MORPHEUS_NEOX_VERIFIER_KEY',
  'NEOX_VERIFIER_PK',
  'MORPHEUS_NEOX_UPDATER_PRIVATE_KEY',
  'NEOX_UPDATER_PK',
  'MORPHEUS_NEOX_FEED_PRIVATE_KEY',
  'NEOX_FEED_PK',
  'NEOX_FEED_PRIVATE_KEY',
  // X25519 oracle confidential-decrypt key material.
  'MORPHEUS_ORACLE_KEY_MATERIAL_JSON',
  'MORPHEUS_ORACLE_KEY_MATERIAL_BASE64',
  // NeoDID nullifier/ticket salt.
  'NEODID_SECRET_SALT',
];

// The set of accepted bearer tokens, derived live from process.env (so a
// /provision that adds a token takes effect immediately).
// Deployment hygiene (audit P2 fix): an operator copying an env example
// verbatim must not ship a public guess as the runtime auth token. These
// values are refused at token resolution — an empty trusted set stays
// fail-closed (401) rather than accepting a known placeholder.
const PLACEHOLDER_TOKEN_VALUES = new Set([
  'replace-me',
  'changeme',
  'change-me',
  'your-token-here',
  'your-morpheus-runtime-token',
  'nitro-shared-secret',
  'secret',
  'token',
]);

function isPlaceholderToken(value) {
  return PLACEHOLDER_TOKEN_VALUES.has(String(value).trim().toLowerCase());
}

function currentTrustedTokens() {
  const set = new Set();
  for (const key of TOKEN_ENV_KEYS) {
    const value = trimString(process.env[key]);
    if (!value) continue;
    if (isPlaceholderToken(value)) {
      console.error(
        `[enclave] refusing placeholder value for ${key}; set a real secret (the trusted-token set stays closed)`
      );
      continue;
    }
    set.add(value);
  }
  return set;
}

function timingSafeTokenMatch(candidate, trusted) {
  const a = Buffer.from(String(candidate), 'utf8');
  const b = Buffer.from(String(trusted), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Extract the presented bearer/x-*-token from a (lower-cased) header map.
function extractRequestToken(headers = {}) {
  const authorization = trimString(headers.authorization || headers.Authorization || '');
  const bearer = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice('bearer '.length).trim()
    : '';
  return bearer || trimString(headers['x-nitro-token'] || headers['x-runtime-token']);
}

// Throws 401 unless a trusted token is configured AND the request bears a match.
// An empty trusted-token set is always closed; /provision has a separate,
// payload-bound bootstrap path below.
function assertAuthorized(headers = {}) {
  const trusted = currentTrustedTokens();
  if (!trusted.size) {
    throw httpError(401, 'runtime authorization is not configured');
  }
  const token = extractRequestToken(headers);
  for (const trustedToken of trusted) {
    if (timingSafeTokenMatch(token, trustedToken)) return;
  }
  throw httpError(401, 'unauthorized');
}

function resolveProvisionEnv(payload) {
  return payload?.env && typeof payload.env === 'object' && !Array.isArray(payload.env)
    ? payload.env
    : {};
}

function kmsRunnerEnv(provisionEnv) {
  const childEnv = { ...process.env };
  for (const key of [
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'NITRO_AWS_REGION',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
  ]) {
    const value = trimString(provisionEnv[key]);
    if (value) childEnv[key] = value;
  }
  return childEnv;
}

function materializeProvisionRuntimeToken(payload = {}) {
  const env = resolveProvisionEnv(payload);
  const ciphertext = trimString(env[RUNTIME_TOKEN_KMS_CIPHERTEXT_ENV]);
  if (!ciphertext) {
    throw httpError(401, `first provision requires ${RUNTIME_TOKEN_KMS_CIPHERTEXT_ENV}`);
  }
  const region =
    trimString(env.AWS_REGION || env.NITRO_AWS_REGION) ||
    trimString(process.env.AWS_REGION || process.env.NITRO_AWS_REGION) ||
    'us-east-1';
  let parsed;
  try {
    parsed = activeAttestRunner(['kms-decrypt', '--region', region, '--ciphertext', ciphertext], {
      env: kmsRunnerEnv(env),
    });
  } catch {
    throw httpError(503, 'attestation-gated runtime authorization materialization failed');
  }
  if (!(parsed && parsed.ok && parsed.plaintext_b64)) {
    throw httpError(503, 'attestation-gated runtime authorization materialization failed');
  }
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(parsed.plaintext_b64, 'base64').toString('utf8'));
  } catch {
    throw httpError(401, 'runtime authorization KMS envelope is invalid');
  }
  const provisionNetwork = normalizeMorpheusNetwork(
    trimString(env.MORPHEUS_NETWORK) || resolveNetwork()
  );
  const token = trimString(envelope?.token);
  const version = Number(envelope?.version);
  if (
    envelope?.purpose !== RUNTIME_TOKEN_KMS_PURPOSE ||
    normalizeMorpheusNetwork(envelope?.network || '') !== provisionNetwork ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    token.length < 32 ||
    token.length > 512
  ) {
    throw httpError(401, 'runtime authorization KMS envelope context is invalid');
  }
  return { token, version };
}

function currentProvisionTokens() {
  if (runtimeTokenKmsVersion > 0) {
    const token = trimString(process.env.MORPHEUS_RUNTIME_TOKEN);
    return token ? new Set([token]) : new Set();
  }
  return currentTrustedTokens();
}

// Authorize /provision. First boot requires an operator-sealed runtime token that
// KMS releases only to the expected enclave measurement. The parent may relay the
// ciphertext and present the token, but it cannot install a token of its choice.
// Later rotation requires the current KMS-materialized token and a strictly newer
// versioned KMS envelope.
function assertProvisionAuthorized(headers = {}, payload = {}) {
  const trusted = currentProvisionTokens();
  if (trusted.size) {
    const token = extractRequestToken(headers);
    for (const trustedToken of trusted) {
      if (timingSafeTokenMatch(token, trustedToken)) return null;
    }
    throw httpError(401, 'unauthorized');
  }
  const materialized = materializeProvisionRuntimeToken(payload);
  if (timingSafeTokenMatch(extractRequestToken(headers), materialized.token)) {
    return materialized;
  }
  throw httpError(401, 'unauthorized');
}

export function __resetRuntimeProvisionStateForTests() {
  runtimeTokenKmsVersion = 0;
}

function normalizeSignerRole(value) {
  const role = trimString(value).toLowerCase();
  if (role === 'oracle_verifier' || role === 'verifier') return 'oracle_verifier';
  if (role === 'updater') return 'updater';
  if (role === 'relayer') return 'relayer';
  if (role === 'worker') return 'worker';
  return 'updater';
}

// Whether a KMS ciphertext is provisioned for a given signer role. When a key is
// materialized AND its ciphertext is present, the key is KMS-attested; a
// materialized key with NO ciphertext came from a host-provided plaintext env var.
function roleHasKmsCiphertext(role) {
  if (role === 'oracle_verifier') {
    return Boolean(trimString(process.env.MORPHEUS_ORACLE_VERIFIER_KMS_CIPHERTEXT_BASE64));
  }
  if (role === 'updater') {
    return Boolean(trimString(process.env.MORPHEUS_UPDATER_NEO_N3_KMS_CIPHERTEXT_BASE64));
  }
  return false;
}

// Classify how a (materialized) role key reached the enclave: 'kms_attested' when
// recovered in-TEE from a provisioned KMS ciphertext, else 'host_plaintext' (a
// directly-provided plaintext key — only possible when the plaintext-provision
// opt-in is on). 'none' when no key is materialized. Surfaced via /health so any
// reliance on a plaintext key is detectable.
function roleKeySource(role, materialized) {
  if (!materialized) return 'none';
  return roleHasKmsCiphertext(role) ? 'kms_attested' : 'host_plaintext';
}

// Pinned-role health for the two signing roles the enclave holds (matches the
// signer's signerHealth()). Used by /provision + folded into /health.
function signerRolesHealth() {
  const network = resolveNetwork();
  return ['updater', 'oracle_verifier'].map((role) => {
    const report = reportPinnedNeoN3Role(network, role, { env: process.env, allowMissing: false });
    const materialized = Boolean(report.materialized);
    return {
      role,
      ok: report.ok && materialized,
      identity: report.selected_identity || report.pinned || null,
      issues: report.issues,
      key_source: roleKeySource(role, materialized),
    };
  });
}

// POST /provision — inject keys + network + worker config at runtime. Mirrors the
// signer's handleProvision, but writes into process.env (the merged server reads
// process.env everywhere) instead of a separate overlay.
function handleProvision(payload, bootstrapRuntimeToken = null) {
  const env = resolveProvisionEnv(payload);
  // Plaintext key provisioning is not a runtime policy knob. A compromised host
  // must not be able to enable it in one request and inject a known signer or
  // decrypt key in the next request. Only attestation-gated KMS ciphertext enters
  // through this boundary.
  const rejected = Object.keys(env)
    .filter(
      (key) =>
        trimString(env[key]) &&
        (key === 'MORPHEUS_ALLOW_PLAINTEXT_KEY_PROVISION' ||
          TOKEN_ENV_KEYS.includes(key) ||
          PLAINTEXT_KEY_ENV_KEYS.includes(key))
    )
    .sort();
  if (rejected.length) {
    throw httpError(
      403,
      'plaintext key or runtime-token provisioning is permanently disabled; provide an attestation-gated ' +
        `*_KMS_CIPHERTEXT_BASE64 value instead. Rejected: ${rejected.join(', ')}`
    );
  }
  const nextRuntimeToken = trimString(env[RUNTIME_TOKEN_KMS_CIPHERTEXT_ENV])
    ? bootstrapRuntimeToken || materializeProvisionRuntimeToken(payload)
    : null;
  if (nextRuntimeToken && nextRuntimeToken.version <= runtimeTokenKmsVersion) {
    throw httpError(409, 'runtime authorization KMS envelope version must increase monotonically');
  }
  const applied = [];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Z0-9_]{1,96}$/.test(key)) continue;
    const text = trimString(value);
    if (text) {
      process.env[key] = text;
      applied.push(key);
    }
  }
  if (nextRuntimeToken) {
    process.env.MORPHEUS_RUNTIME_TOKEN = nextRuntimeToken.token;
    runtimeTokenKmsVersion = nextRuntimeToken.version;
  }
  // Provisioning may have rotated a signer env var — drop the materialized-signer cache so
  // the next sign call re-resolves against the new key material. (Round-2 R2-2.1.)
  if (applied.length > 0) clearResolvedSignerCache();
  // If a KMS-attested oracle-key ciphertext was provisioned, recover the key
  // material in-TEE now (before any decrypt request needs it) so the host never
  // injects plaintext. No-op when not configured or already materialized.
  materializeOracleKeyFromKms();
  materializeNeoDidSaltFromKms();
  // Same KMS-attestation path for the Neo X (EVM) verifier + feed keys, so EVM
  // oracle fulfillments and feed-update txs are signed in-TEE with no host-resident
  // secp256k1 key. No-op when not configured (e.g. EVM not yet enabled on this host).
  materializeNeoXVerifierKeyFromKms();
  materializeNeoXFeedKeyFromKms();
  // Neo N3 signer keys (oracle_verifier + updater) recovered in-TEE from KMS when sealed;
  // no-op until their ciphertexts are provisioned (plaintext WIF still works meanwhile).
  materializeNeoN3OracleVerifierKeyFromKms();
  materializeNeoN3UpdaterKeyFromKms();
  // Non-destructive probe of the attestation-gated KMS path (no-op unless a diag
  // ciphertext is provisioned); result surfaced via /health for diagnostics.
  runKmsDiag();
  const roles = signerRolesHealth();
  return {
    status: roles.every((entry) => entry.ok) ? 'ok' : 'degraded',
    runtime: 'morpheus-enclave-server',
    network: resolveNetwork(),
    provisioned: true,
    env_keys: applied.sort(),
    roles,
  };
}

// POST /sign/payload — sign caller-supplied data_hex with a pinned role key. This
// is the signer's blind-sign endpoint, carried so the flag-OFF relayer path keeps
// working during cutover. Once MORPHEUS_RELAYER_ENCLAVE_FULFILL is on the relayer
// uses /oracle/fulfill (attested compute+sign) and this path goes unused.
function handleSignPayload(payload) {
  const role = normalizeSignerRole(payload.key_role || payload.dstack_key_role || payload.role);
  const dataHex = normalizeHex(payload.data_hex || payload.message_hex || '');
  if (!/^[0-9a-f]+$/.test(dataHex) || dataHex.length % 2 !== 0) {
    throw httpError(400, 'data_hex is required');
  }
  const network = resolveNetwork();
  const report = reportPinnedNeoN3Role(network, role, { env: process.env, allowMissing: false });
  if (!report.ok || !report.materialized) {
    throw httpError(503, `${role} signer is not configured or does not match pinned identity`);
  }
  const secret = report.materialized.private_key || report.materialized.wif;
  const account = new neoWallet.Account(secret);
  const signature = neoWallet.sign(dataHex, account.privateKey);
  return {
    status: 'ok',
    network,
    role,
    signature,
    signature_hex: signature,
    public_key: account.publicKey,
    address: account.address,
    script_hash: `0x${account.scriptHash}`,
    key_source: 'nitro_explicit_pinned',
  };
}

// POST /keys/derived — report a pinned role's public Neo identity (no secret).
function handleKeysDerived(payload) {
  const role = normalizeSignerRole(payload.role || payload.key_role || payload.dstack_key_role);
  const network = resolveNetwork();
  const report = reportPinnedNeoN3Role(network, role, { env: process.env, allowMissing: false });
  if (!report.ok || !report.materialized) {
    throw httpError(503, `${role} signer is not configured or does not match pinned identity`);
  }
  const identity = report.selected_identity || report.pinned || {};
  const neo = {
    address: identity.address || null,
    script_hash: identity.script_hash || null,
    public_key: identity.public_key || report.public_key || null,
  };
  return {
    status: 'ok',
    network,
    role,
    derived: { neo_n3: neo },
    neo_n3: neo,
    key_source: 'nitro_explicit_pinned',
  };
}

// ---------------------------------------------------------------------------
// In-process compute (reuses worker `handler`) -> {ok, status, body}
// ---------------------------------------------------------------------------
// Mirrors callNitro's return shape (nitro.js: {ok, status, body}) so the imported
// encodeFulfillmentResult / buildOnchainResultEnvelope consume it unchanged.

// The active worker handler. Defaults to the REAL imported worker `handler`
// (so production computes in-process via the real worker). Tests override it via
// __setWorkerHandlerForTests to make compute deterministic WITHOUT touching the
// worker source — the test then asserts the digest/envelope/signature pipeline
// (the consensus-critical part) against a fixed result body.
let activeWorkerHandler = workerHandler;

export function __setWorkerHandlerForTests(fn) {
  activeWorkerHandler = typeof fn === 'function' ? fn : workerHandler;
}

export function __resetWorkerHandlerForTests() {
  activeWorkerHandler = workerHandler;
}

async function computeViaWorker(route, workerPayload) {
  const token = resolveWorkerAuthToken();
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token) {
    headers.set('authorization', `Bearer ${token}`);
    headers.set('x-nitro-token', token);
  }
  const request = new Request(`http://127.0.0.1${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(workerPayload),
  });
  const response = await activeWorkerHandler(request);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { ok: response.ok, status: response.status, body };
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

// Signer-key memoization (Round-2 R2-2.1). signNeoN3OracleVerifier / resolveUpdaterIdentity
// each call reportPinnedNeoN3Role, which materializes up to ~12 candidate neon.Account
// objects (WIF decode + secp256r1 pubkey + script-hash) per call — work that is identical
// across calls unless /provision (or a KMS materialization) writes a new signer env var.
// Cache the materialized account per (network, role) and clear the cache on every
// process.env key mutation in handleProvision + materialize*FromKms. signerRolesHealth and
// the /health handler stay UNCACHED (they must reflect live key material). The cache holds
// the neon account + the resolved report (so the second `new neoWallet.Account(secret)` in
// the signers is also eliminated — they reuse the cached account directly).
const resolvedSignerCache = new Map();
function clearResolvedSignerCache() {
  resolvedSignerCache.clear();
}
function resolvePinnedSigner(network, role) {
  const cacheKey = `${network}:${role}`;
  const cached = resolvedSignerCache.get(cacheKey);
  if (cached) return cached;
  const report = reportPinnedNeoN3Role(network, role, {
    env: process.env,
    allowMissing: false,
  });
  if (!report.ok || !report.materialized) {
    return null;
  }
  const secret = report.materialized.private_key || report.materialized.wif;
  const account = new neoWallet.Account(secret);
  const entry = { account, report };
  resolvedSignerCache.set(cacheKey, entry);
  return entry;
}

// Resolve + sign with the oracle_verifier secp256r1 (Neo N3) key, using the SAME
// role/key resolution the enclave signer uses (reportPinnedNeoN3Role) and the SAME
// signing primitive (neon-js wallet.sign over the digest hex). The materialized account
// is cached per (network, 'oracle_verifier') so the ~12-candidate secp256r1 derivation
// runs once per process unless /provision or KMS materialization rotates the key.
function signNeoN3OracleVerifier(digestBytes) {
  const resolved = resolvePinnedSigner(resolveNetwork(), 'oracle_verifier');
  if (!resolved) {
    throw new Error('oracle_verifier signer is not configured or does not match pinned identity');
  }
  const { account } = resolved;
  const digestHex = Buffer.isBuffer(digestBytes)
    ? digestBytes.toString('hex')
    : normalizeHex(digestBytes);
  const signature = neoWallet.sign(digestHex, account.privateKey);
  return {
    signature,
    public_key: account.publicKey,
    address: account.address,
    script_hash: `0x${account.scriptHash}`,
    source: 'enclave_oracle_verifier',
  };
}

// Build a config-shaped object for the EVM digest/sign builders from the request's
// fulfillment_context (chain_id + oracle_contract) + the verifier key from env.
function resolveNeoXConfig(fulfillmentContext) {
  const chainId = Number(fulfillmentContext.chain_id ?? fulfillmentContext.chainId);
  const oracleContract = trimString(
    fulfillmentContext.oracle_contract || fulfillmentContext.oracleContract || ''
  );
  const verifierPrivateKey = trimString(
    process.env.MORPHEUS_NEOX_VERIFIER_PRIVATE_KEY ||
      process.env.MORPHEUS_NEOX_VERIFIER_KEY ||
      process.env.NEOX_VERIFIER_PK ||
      ''
  );
  const updaterPrivateKey = trimString(
    process.env.MORPHEUS_NEOX_UPDATER_PRIVATE_KEY || process.env.NEOX_UPDATER_PK || ''
  );
  if (!Number.isFinite(chainId) || chainId <= 0) {
    throw new Error('neox fulfillment_context.chain_id is required');
  }
  if (!oracleContract) {
    throw new Error('neox fulfillment_context.oracle_contract is required');
  }
  if (!verifierPrivateKey && !updaterPrivateKey) {
    throw new Error('neox verifier private key is not configured');
  }
  return { neox: { chainId, oracleContract, verifierPrivateKey, updaterPrivateKey } };
}

// ---------------------------------------------------------------------------
// /oracle/fulfill — atomic compute + sign
// ---------------------------------------------------------------------------

function normalizeChain(value) {
  const chain = trimString(value).toLowerCase();
  if (chain === 'neox') return 'neox';
  if (chain === 'legacy') return 'legacy';
  return 'neo_n3';
}

// The arbitrary-URL fetch lane cannot be covered by the enclave egress allow-list,
// so it stays host-tier and is NOT signed in-enclave (Phase 0 returns a
// host-unattested marker without computing/signing). The smart-fetch route serves
// BOTH a named-provider lane (payload.symbol -> twelvedata/binance/coinbase, which
// IS allow-listable + attestable) and the arbitrary-URL lane (payload.url, which
// is NOT). Only the latter — an explicit arbitrary URL — is host-tier; a
// symbol/provider smart-fetch is treated as attested (it hits named providers).
// (Matches oracle/fetch.js: payload.url present == arbitrary URL fetch.)
function isHostUnattestedLane(kernelIntent, payload) {
  if (kernelIntent.workerRoute !== '/oracle/smart-fetch') return false;
  return Boolean(trimString(payload?.url || ''));
}

// Build the {ok, status, body} workerResponse for the request, computing in-process.
// Mirrors prepareOracleFulfillment's lane selection:
//   - confidential.decrypt -> /oracle/decrypt with {envelope: payloadText}
//   - everything else (incl. random.generate VRF) -> the kernel route with the
//     buildWorkerPayload-decorated payload (VRF computed in-enclave via /vrf/random,
//     which the relayer today short-circuits with crypto.randomBytes — moving it
//     in-enclave is the intended Phase >=0 behavior).
async function computeWorkerResponse(
  chain,
  requestType,
  payload,
  requestId,
  kernelIntent,
  context
) {
  if (kernelIntent.moduleId === 'confidential.decrypt') {
    const envelope = trimString(context.payloadText || payload?.envelope || '');
    return computeViaWorker('/oracle/decrypt', { ...payload, envelope });
  }
  const route = resolveWorkerRoute(requestType, payload);
  const workerPayload = buildWorkerPayload(chain, requestType, payload, requestId, {
    requester: context.requester,
    callbackContract: context.callbackContract,
    callbackMethod: context.callbackMethod,
  });
  return computeViaWorker(route, workerPayload);
}

export async function handleOracleFulfill(requestBody) {
  const chain = normalizeChain(requestBody?.chain);
  const requestType = trimString(requestBody?.request_type || requestBody?.requestType || '');
  const requestId = trimString(requestBody?.request_id ?? requestBody?.requestId ?? '');
  const payload =
    requestBody?.payload &&
    typeof requestBody.payload === 'object' &&
    !Array.isArray(requestBody.payload)
      ? requestBody.payload
      : {};
  const fulfillmentContext =
    requestBody?.fulfillment_context && typeof requestBody.fulfillment_context === 'object'
      ? requestBody.fulfillment_context
      : {};
  const nonce = normalizeHex(requestBody?.nonce || '');

  if (!requestType) throw httpError(400, 'request_type is required');
  if (!requestId) throw httpError(400, 'request_id is required');

  const kernelIntent = resolveKernelIntent(requestType);

  // Kernel envelope fields the digest binds (verbatim — matches the relayer's
  // resolveEventFulfillmentContext: prefer the on-chain identifiers, fall back to
  // the kernel-intent mapping only for genuinely absent fields).
  const appId = String(fulfillmentContext.app_id ?? fulfillmentContext.appId ?? '');
  const moduleId =
    String(fulfillmentContext.module_id ?? fulfillmentContext.moduleId ?? '') ||
    String(kernelIntent.moduleId ?? '');
  const operation =
    String(fulfillmentContext.operation ?? '') || String(kernelIntent.operation ?? '');

  // Host-unattested tier: arbitrary-URL fetch is not computed/signed in-enclave.
  if (isHostUnattestedLane(kernelIntent, payload)) {
    return {
      status: 'host-unattested',
      success: false,
      result: '',
      error: 'arbitrary-url fetch is host-tier (not attested in-enclave)',
      signature: null,
      public_key: null,
      fulfillment_digest_hex: null,
      verification: null,
      trust_tier: 'host-unattested',
    };
  }

  const context = {
    requester: trimString(payload.requester || ''),
    callbackContract: trimString(payload.callback_contract || ''),
    callbackMethod: trimString(payload.callback_method || ''),
    payloadText: requestBody?.payload_text ?? payload?.payload_text ?? payload?.envelope ?? '',
  };

  // (a)+(b) COMPUTE in-process.
  const workerResponse = await computeWorkerResponse(
    chain,
    requestType,
    payload,
    requestId,
    kernelIntent,
    context
  );

  // (c) Encode the on-chain fulfillment fields + result envelope via the CANONICAL
  // builders (identical to the relayer's prepareOracleFulfillment encoding).
  const fulfillment = encodeFulfillmentResult(requestType, workerResponse);
  const verification = buildOnchainResultEnvelope(requestType, workerResponse);

  const success = Boolean(fulfillment.success);
  const result = fulfillment.result || '';
  const resultBytesBase64 = fulfillment.result_bytes_base64 || '';
  const error = fulfillment.error || '';

  // (d)+(e) BUILD the digest with the imported canonical builder + SIGN atomically.
  let signed;
  let digestHex;
  if (chain === 'neox') {
    const neoxConfig = resolveNeoXConfig(fulfillmentContext);
    const evmFulfillment = {
      requestId,
      appId,
      moduleId,
      operation,
      success,
      result,
      result_bytes_base64: resultBytesBase64,
      error,
    };
    const resultBytesHex = resolveResultBytesHex(result, resultBytesBase64);
    digestHex = buildNeoXDigest(neoxConfig, evmFulfillment, resultBytesHex);
    signed = await signNeoXFulfillment(neoxConfig, evmFulfillment);
  } else {
    // Neo N3 / legacy: bind to the executing contract + network magic when supplied
    // (matches signFulfillmentPayload, which appends contractScriptHash + magic).
    const digestContext = {
      chain,
      appId,
      moduleId,
      operation,
      contractScriptHash: trimString(
        fulfillmentContext.contract_script_hash || fulfillmentContext.contractScriptHash || ''
      ),
      networkMagic: fulfillmentContext.network_magic ?? fulfillmentContext.networkMagic,
    };
    const digestBytes = buildFulfillmentDigestBytes(
      requestId,
      requestType,
      success,
      result,
      error,
      resultBytesBase64,
      digestContext
    );
    digestHex = digestBytes.toString('hex');
    signed = signNeoN3OracleVerifier(digestBytes);
  }

  // (f) Return the contract. result_bytes_base64 only present for compact lanes
  // (vrf/neodid). nonce echoed for the relayer/verifier freshness binding.
  const response = {
    status: 'ok',
    success,
    result,
    error,
    signature: signed.signature,
    public_key: signed.public_key,
    fulfillment_digest_hex: digestHex,
    verification,
    trust_tier: 'enclave-attested',
  };
  if (resultBytesBase64) response.result_bytes_base64 = resultBytesBase64;
  if (nonce) response.nonce = nonce;

  // (g) ENFORCING ATTESTATION (C1): in addition to the signature, bind a fresh NSM
  // attestation document to THIS result by committing user_data = sha256(the EXACT
  // fulfillment_digest bytes) and the oracle_verifier public key. The relayer
  // verifies the COSE_Sign1 (user_data == sha256(its own recomputed digest), PCR0
  // matches the pinned measurement) before submitting, turning the previously-
  // advisory trust_tier into an enclave-proven one. The signed digest bytes are NOT
  // changed — this is additive provenance. Best-effort: if the NSM binary is
  // unavailable (e.g. this lane runs outside a real enclave, or pre-cutover), the
  // signature path still returns; the relayer downgrades trust_tier when it cannot
  // prove attestation, so the lane keeps fulfilling. The freshness nonce (when
  // supplied) is echoed into the document's report_data.
  try {
    const attestation = await handleAttestation({
      fulfillment_digest_hex: digestHex,
      ...(nonce ? { nonce } : {}),
      role: 'oracle_verifier',
    });
    if (attestation && attestation.attestation_document) {
      response.attestation_doc_base64 = attestation.attestation_document;
      response.attestation_user_data_hex = attestation.user_data_hex || null;
      if (attestation.public_key) response.attestation_public_key = attestation.public_key;
      // handleAttestation already extracts pcrs from the COSE_Sign1 (enclave-server.mjs:1666);
      // reuse it directly instead of re-running extractAttestationPcrs on the same document
      // (a full second base64-decode + CBOR parse that is dead work on the success path).
      // (Round-2 R2-2.3.)
      if (attestation.pcrs && Object.keys(attestation.pcrs).length) {
        response.attestation_pcrs = attestation.pcrs;
      }
    }
  } catch (error) {
    // Attestation is best-effort here (the relayer enforces): record why it was
    // unavailable so ops can see the enforcing path is not yet active, without
    // failing the (already-signed) fulfillment.
    response.attestation_error = String((error && error.message) || error).slice(0, 300);
  }

  return response;
}

// Best-effort extraction of the PCR map from a base64 COSE_Sign1 attestation
// document so the enclave can surface the measured PCRs alongside the doc (the
// relayer also re-extracts + verifies them independently). Returns {} on any parse
// failure — the document itself remains the authoritative source for the verifier.
function extractAttestationPcrs(docBase64) {
  try {
    const payload = decodeCoseSign1Payload(Buffer.from(String(docBase64 || ''), 'base64'));
    const map = payload && payload.pcrs;
    if (!map || typeof map !== 'object') return {};
    const out = {};
    for (const [index, value] of Object.entries(map)) {
      const hex = Buffer.isBuffer(value) ? value.toString('hex') : normalizeHex(value);
      if (hex) out[`pcr${index}`] = hex;
    }
    return out;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// /feed/sign — feed COMPUTE (fetch + plan + scale) + SIGN the updateFeeds tx
// ---------------------------------------------------------------------------
//
// Moves the feed value+decision in-enclave. It MIRRORS feed-pusher.mjs precisely:
//   1. td(symbols)           -> per-symbol TwelveData price (drop non-positive)
//   2. planFeedUpdate(...)   -> IMPORTED from feed-pusher.mjs (the SAME decision)
//   3. px = Math.round(price * 1e6); AH = sha256(`${s}|${px}|${ts}`).slice(0,32)
//   4. build the SAME updateFeeds(P,R,PX,TS,AH,SS) tx and sign
//      txn.getMessageForSigning(N3_MAGIC) with the `updater` role.
// The signed message MUST be byte-identical to feed-pusher.mjs `pushNeoN3`.

// Price fetch — MIRRORS feed-pusher.mjs td() exactly (URL, parse, non-positive
// drop). Injectable seam (__setPriceFetcherForTests) so the route is unit-testable
// WITHOUT a live TwelveData call (mirrors the worker-handler test seam above).
async function defaultPriceFetcher(syms) {
  const apiKey = trimString(process.env.TD_KEY);
  const t = syms.map((s) => toTwelveDataSymbol(s));
  const response = await fetch(
    `https://api.twelvedata.com/price?symbol=${encodeURIComponent(t.join(','))}&apikey=${apiKey}`,
    { signal: AbortSignal.timeout(FEED_TD_TIMEOUT_MS) }
  );
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('TwelveData non-JSON (HTTP ' + response.status + ')');
  }
  const out = {};
  for (const s of syms) {
    const k = toTwelveDataSymbol(s);
    const entry = t.length === 1 ? parsed : parsed[k];
    const value = entry && entry.price;
    const n = Number(value);
    // Drop non-positive / non-finite quotes (a 0/negative reading is "missing").
    if (value != null && Number.isFinite(n) && n > 0) out[s] = n;
  }
  return out;
}

let activePriceFetcher = defaultPriceFetcher;

export function __setPriceFetcherForTests(fn) {
  activePriceFetcher = typeof fn === 'function' ? fn : defaultPriceFetcher;
}

export function __resetPriceFetcherForTests() {
  activePriceFetcher = defaultPriceFetcher;
}

// Network params that feed-pusher derives from live RPC (getblockcount,
// invokescript, calculatenetworkfee). Injectable so the test reproduces the EXACT
// tx; in production the enclave fills them via vsock-proxy RPC (Phase >=3).
let activeFeedTxParamsProvider = defaultFeedTxParamsProvider;

async function defaultFeedTxParamsProvider() {
  throw httpError(
    503,
    'feed tx network params (block_count/system_fee/network_fee) unavailable: ' +
      'supply tx_params in the request or configure an RPC provider'
  );
}

export function __setFeedTxParamsProviderForTests(fn) {
  activeFeedTxParamsProvider = typeof fn === 'function' ? fn : defaultFeedTxParamsProvider;
}

export function __resetFeedTxParamsProviderForTests() {
  activeFeedTxParamsProvider = defaultFeedTxParamsProvider;
}

// Build the EXACT updateFeeds transaction feed-pusher.mjs pushNeoN3 builds, and
// return its signing message. The construction mirrors pushNeoN3 (lines 300-336)
// field-for-field.
//
// IMPORTANT (consensus correctness): tx.Transaction assigns a RANDOM `nonce` when
// one is not supplied, which makes getMessageForSigning() non-deterministic. In
// the host feed-pusher today that is fine because it builds+signs+broadcasts the
// SAME tx instance. In the enclave model the enclave signs but the HOST
// broadcasts, so the host must rebuild the identical tx (same nonce) to attach
// the witness — therefore the nonce MUST be an explicit, returned input, not a
// per-instance random. We require it here so the message is reproducible and the
// broadcaster can reconstruct the exact tx (returned as `tx_nonce`).
//
// planned: { P:string[], R:number[], PX:number[], TS:number[], AH:string[], SS:number[] }
// txParams: { blockCount, systemFee, networkFee, nonce }  (nonce REQUIRED, uint32)
// updaterPublicKey: the updater's compressed pubkey hex (for the signer script hash)
export function buildUpdateFeedsTxMessage(planned, txParams, updaterPublicKey) {
  const { P, R, PX, TS, AH, SS } = planned;
  if (!Number.isInteger(txParams.nonce)) {
    throw httpError(500, 'updateFeeds tx nonce must be an integer (reproducibility invariant)');
  }
  const script = sc.createScript({
    scriptHash: FEED_N3_CONTRACT,
    operation: 'updateFeeds',
    args: [
      sc.ContractParam.array(...P.map((x) => sc.ContractParam.string(x))),
      sc.ContractParam.array(...R.map((x) => sc.ContractParam.integer(x))),
      sc.ContractParam.array(...PX.map((x) => sc.ContractParam.integer(x))),
      sc.ContractParam.array(...TS.map((x) => sc.ContractParam.integer(x))),
      sc.ContractParam.array(...AH.map((x) => sc.ContractParam.byteArray(x))),
      sc.ContractParam.array(...SS.map((x) => sc.ContractParam.integer(x))),
    ],
  });
  const updaterScriptHash = neoWallet.getScriptHashFromPublicKey(updaterPublicKey);
  const txn = new tx.Transaction({
    nonce: txParams.nonce,
    signers: [{ account: updaterScriptHash, scopes: tx.WitnessScope.CalledByEntry }],
    validUntilBlock: txParams.blockCount + FEED_VALID_UNTIL_OFFSET,
    script,
  });
  txn.systemFee = u.BigInteger.fromNumber(txParams.systemFee);
  txn.networkFee = u.BigInteger.fromNumber(txParams.networkFee);
  return { txn, script, message: txn.getMessageForSigning(FEED_N3_MAGIC) };
}

function validateFeedN3TxParams(value) {
  const blockCount = Number(value?.blockCount ?? value?.block_count);
  const systemFee = Number(value?.systemFee ?? value?.system_fee);
  const networkFee = Number(value?.networkFee ?? value?.network_fee);
  if (
    !Number.isSafeInteger(blockCount) ||
    blockCount < 0 ||
    blockCount > 0xffffffff - FEED_VALID_UNTIL_OFFSET
  ) {
    throw httpError(400, 'feed tx block_count is outside the supported Neo N3 range');
  }
  if (!Number.isSafeInteger(systemFee) || systemFee < 0 || systemFee > FEED_N3_MAX_SYSTEM_FEE) {
    throw httpError(400, 'feed tx system_fee exceeds the enclave safety ceiling');
  }
  if (!Number.isSafeInteger(networkFee) || networkFee < 0 || networkFee > FEED_N3_MAX_NETWORK_FEE) {
    throw httpError(400, 'feed tx network_fee exceeds the enclave safety ceiling');
  }
  return { blockCount, systemFee, networkFee };
}

// Resolve + sign with the updater secp256r1 (Neo N3) key — SAME role/key
// resolution + signing primitive the enclave signer uses for {role:'updater'}.
// Uses the cached account (resolvePinnedSigner) for the same per-process memoization as
// signNeoN3OracleVerifier.
function resolveUpdaterIdentity() {
  const resolved = resolvePinnedSigner(resolveNetwork(), 'updater');
  if (!resolved) {
    throw httpError(503, 'updater signer is not configured or does not match pinned identity');
  }
  return { account: resolved.account };
}

function signUpdaterMessage(messageHex) {
  const { account } = resolveUpdaterIdentity();
  const dataHex = normalizeHex(messageHex);
  const signature = neoWallet.sign(dataHex, account.privateKey);
  return {
    signature,
    public_key: account.publicKey,
    address: account.address,
    script_hash: `0x${account.scriptHash}`,
    source: 'enclave_updater',
  };
}

function randomUint32() {
  return randomBytes(4).readUInt32BE(0);
}

function normalizeOnchainState(rawState) {
  const state =
    rawState && typeof rawState === 'object' && !Array.isArray(rawState) ? rawState : {};
  const out = {};
  for (const [sym, value] of Object.entries(state)) {
    if (!value || typeof value !== 'object') continue;
    out[sym] = {
      round: Math.max(Number(value.round ?? 0) || 0, 0),
      price: Number(value.price ?? 0) || 0,
      ts: Math.max(Number(value.timestamp ?? value.ts ?? 0) || 0, 0),
    };
  }
  return out;
}

// Phase D — in-TEE EVM (Neo X) feed signing. `updateFeeds` is authorized by msg.sender
// (an EOA tx, no separable verifier signature), so the enclave fetches+plans+scales the
// SAME way feed-pusher pushNeoX does and signs the raw EIP-1559 updateFeeds tx with the
// KMS-materialized feed key. It returns the SIGNED serialized tx + the plan + the exact
// tx fields so the host can independently re-encode the calldata, assert the signed tx
// matches (to/nonce/chainId/from/data), and broadcast it. The feed key never leaves the
// enclave.
const NEOX_FEED_PAIR_PREFIX = 'TWELVEDATA:';
const NEOX_FEED_PRICE_SCALE = 1e6; // MorpheusPriceFeed stores 6-dp fixed-point prices
const NEOX_UPDATE_FEEDS_ABI =
  'function updateFeeds(string[] symbols, uint256[] prices, uint256[] timestamps, uint256[] roundIds) external';

async function handleNeoXFeedSign(requestBody) {
  const symbols = Array.isArray(requestBody?.symbols)
    ? requestBody.symbols.map((s) => trimString(s)).filter(Boolean)
    : [];
  if (!symbols.length) throw httpError(400, 'symbols[] is required');

  const feedKey = trimString(
    process.env.MORPHEUS_NEOX_FEED_PRIVATE_KEY ||
      process.env.NEOX_FEED_PK ||
      process.env.NEOX_FEED_PRIVATE_KEY ||
      ''
  );
  if (!feedKey) throw httpError(503, 'neox feed key is not configured');

  const txp =
    requestBody?.tx_params && typeof requestBody.tx_params === 'object'
      ? requestBody.tx_params
      : {};
  const to = trimString(txp.to || txp.contract || requestBody?.contract || '');
  const chainId = Number(txp.chain_id ?? txp.chainId);
  const nonce = Number(txp.nonce);
  const gasLimit = txp.gas_limit ?? txp.gasLimit;
  const maxFeePerGas = txp.max_fee_per_gas ?? txp.maxFeePerGas;
  const maxPriorityFeePerGas = txp.max_priority_fee_per_gas ?? txp.maxPriorityFeePerGas;
  if (!to) throw httpError(400, 'neox tx_params.to (feed contract) is required');
  if (!Number.isFinite(chainId) || chainId <= 0)
    throw httpError(400, 'neox tx_params.chain_id is required');
  if (!Number.isInteger(nonce) || nonce < 0)
    throw httpError(400, 'neox tx_params.nonce is required');
  if (gasLimit == null || maxFeePerGas == null || maxPriorityFeePerGas == null) {
    throw httpError(
      400,
      'neox tx_params.{gas_limit,max_fee_per_gas,max_priority_fee_per_gas} are required'
    );
  }

  const now = Number.isFinite(Number(requestBody?.now))
    ? Math.floor(Number(requestBody.now))
    : Math.floor(Date.now() / 1000);
  const onchainState = normalizeOnchainState(
    requestBody?.onchain_state || requestBody?.onchainState
  );

  // (1) COMPUTE prices in-enclave (mirrors feed-pusher td()).
  const prices = await activePriceFetcher(symbols);

  // (2)+(3) PLAN + SCALE — identical arrays to feed-pusher.mjs pushNeoX.
  const syms = [];
  const px = [];
  const ts = [];
  const rounds = [];
  const skipped = [];
  const missing = [];
  for (const s of symbols) {
    if (!(s in prices)) {
      missing.push(s);
      continue;
    }
    const cur = onchainState[s] || { round: 0, price: 0, ts: 0 };
    const plan = planFeedUpdate(cur, prices[s], now);
    if (!plan.push) {
      skipped.push({ symbol: s, reason: plan.rejected || 'unchanged_recent' });
      continue;
    }
    syms.push(NEOX_FEED_PAIR_PREFIX + s);
    px.push(BigInt(Math.round(prices[s] * NEOX_FEED_PRICE_SCALE)).toString());
    ts.push(BigInt(plan.ts).toString());
    rounds.push(BigInt(plan.round).toString());
  }

  if (!syms.length) {
    return {
      status: 'no-update',
      chain: 'neox',
      symbols: [],
      prices_scaled: [],
      timestamps: [],
      round_ids: [],
      signed_tx: null,
      from: null,
      trust_tier: 'enclave-attested',
      skipped,
      missing,
    };
  }

  // (4) BUILD the EXACT updateFeeds tx + SIGN it with the feed key (in-TEE).
  const { ethers } = await import('ethers');
  const iface = new ethers.Interface([NEOX_UPDATE_FEEDS_ABI]);
  const data = iface.encodeFunctionData('updateFeeds', [
    syms,
    px.map((x) => BigInt(x)),
    ts.map((x) => BigInt(x)),
    rounds.map((x) => BigInt(x)),
  ]);
  const wallet = new ethers.Wallet(feedKey);
  const signedTx = await wallet.signTransaction({
    type: 2,
    chainId,
    nonce,
    to,
    value: 0n,
    data,
    gasLimit: BigInt(gasLimit),
    maxFeePerGas: BigInt(maxFeePerGas),
    maxPriorityFeePerGas: BigInt(maxPriorityFeePerGas),
  });

  return {
    status: 'ok',
    chain: 'neox',
    signed_tx: signedTx,
    from: wallet.address,
    to,
    nonce,
    chain_id: chainId,
    data,
    symbols: syms,
    prices_scaled: px,
    timestamps: ts,
    round_ids: rounds,
    gas_limit: String(BigInt(gasLimit)),
    max_fee_per_gas: String(BigInt(maxFeePerGas)),
    max_priority_fee_per_gas: String(BigInt(maxPriorityFeePerGas)),
    trust_tier: 'enclave-attested',
    skipped,
    missing,
  };
}

export async function handleFeedSign(requestBody) {
  const chain = normalizeChain(requestBody?.chain);
  if (chain === 'neox') {
    return handleNeoXFeedSign(requestBody);
  }
  if (chain !== 'neo_n3' && chain !== 'legacy') {
    throw httpError(
      400,
      `unsupported feed chain: ${chain} (only neo_n3 and neox are enclave-signed)`
    );
  }

  const symbols = Array.isArray(requestBody?.symbols)
    ? requestBody.symbols.map((s) => trimString(s)).filter(Boolean)
    : [];
  if (!symbols.length) throw httpError(400, 'symbols[] is required');

  const onchainState = normalizeOnchainState(
    requestBody?.onchain_state || requestBody?.onchainState
  );
  const nonce = normalizeHex(requestBody?.nonce || '');
  const now = Number.isFinite(Number(requestBody?.now))
    ? Math.floor(Number(requestBody.now))
    : Math.floor(Date.now() / 1000);

  // (1) COMPUTE: fetch prices in-enclave (mirrors feed-pusher td()).
  const prices = await activePriceFetcher(symbols);

  // (2)+(3) PLAN + SCALE — identical arrays to feed-pusher.mjs pushNeoN3.
  const planned = { P: [], R: [], PX: [], TS: [], AH: [], SS: [] };
  const pairs = [];
  const rounds = [];
  const pricesScaled = [];
  const timestamps = [];
  const attestationHashes = [];
  const sourceSetIds = [];
  const skipped = [];
  const missing = [];

  for (const s of symbols) {
    if (!(s in prices)) {
      missing.push(s);
      continue;
    }
    const cur = onchainState[s] || { round: 0, price: 0, ts: 0 };
    const px = Math.round(prices[s] * FEED_PRICE_SCALE);
    const plan = planFeedUpdate(cur, prices[s], now);
    if (!plan.push) {
      skipped.push({ symbol: s, reason: plan.rejected || 'unchanged_recent' });
      continue;
    }
    const round = plan.round;
    const ts = plan.ts;
    const attestationHash = createHash('sha256')
      .update(`${s}|${px}|${ts}`)
      .digest('hex')
      .slice(0, 32);
    const pair = FEED_N3_PAIR_PREFIX + s;
    planned.P.push(pair);
    planned.R.push(round);
    planned.PX.push(px);
    planned.TS.push(ts);
    planned.AH.push(attestationHash);
    planned.SS.push(0);
    pairs.push(pair);
    rounds.push(round);
    pricesScaled.push(px);
    timestamps.push(ts);
    attestationHashes.push(attestationHash);
    sourceSetIds.push(0);
  }

  // No symbol cleared the push decision — nothing to sign (matches feed-pusher's
  // "no updates" branch; not an error).
  if (!planned.P.length) {
    return {
      status: 'no-update',
      chain: 'neo_n3',
      pairs: [],
      rounds: [],
      prices_scaled: [],
      timestamps: [],
      attestation_hashes: [],
      source_set_ids: [],
      tx_message_hex: null,
      signature: null,
      public_key: null,
      trust_tier: 'enclave-attested',
      skipped,
      missing,
      ...(nonce ? { nonce } : {}),
    };
  }

  // The updater pubkey drives the tx signer's verification script; resolve it
  // before building the tx so the message binds the SAME signer that signs it.
  const updater = resolveUpdaterIdentity();
  const updaterPublicKey = updater.account.publicKey;

  // RPC-derived tx params (block count + fees). Caller may supply them directly
  // (relayer/feed-pusher already read them on the host), else the configured
  // provider fetches via the enclave egress lane.
  const suppliedParams =
    requestBody?.tx_params && typeof requestBody.tx_params === 'object'
      ? requestBody.tx_params
      : null;
  let txParams;
  if (suppliedParams) {
    txParams = validateFeedN3TxParams(suppliedParams);
  } else {
    txParams = validateFeedN3TxParams(await activeFeedTxParamsProvider({ planned, script: null }));
  }

  // The tx nonce is the reproducibility key (see buildUpdateFeedsTxMessage). Honour
  // a caller-supplied nonce (so the host can pin one), else derive a deterministic
  // uint32 from the freshness nonce when present, else a fresh random uint32. It is
  // RETURNED so the broadcaster can rebuild the identical tx and attach the witness.
  let txNonce = Number(
    suppliedParams?.nonce ?? suppliedParams?.tx_nonce ?? requestBody?.tx_nonce ?? NaN
  );
  if (!Number.isInteger(txNonce) || txNonce < 0 || txNonce > 0xffffffff) {
    if (nonce) {
      // Deterministic uint32 from the freshness nonce: first 4 bytes of its sha256.
      txNonce = createHash('sha256').update(Buffer.from(nonce, 'hex')).digest().readUInt32BE(0);
    } else {
      txNonce = randomUint32();
    }
  }
  const fullTxParams = { ...txParams, nonce: txNonce };

  // (4) BUILD the EXACT updateFeeds tx + SIGN its message with the updater key.
  const { message } = buildUpdateFeedsTxMessage(planned, fullTxParams, updaterPublicKey);
  const signed = signUpdaterMessage(message);

  return {
    status: 'ok',
    chain: 'neo_n3',
    pairs,
    rounds,
    prices_scaled: pricesScaled,
    timestamps,
    attestation_hashes: attestationHashes,
    source_set_ids: sourceSetIds,
    tx_message_hex: message,
    tx_nonce: txNonce,
    valid_until_block: fullTxParams.blockCount + FEED_VALID_UNTIL_OFFSET,
    signature: signed.signature,
    public_key: signed.public_key,
    trust_tier: 'enclave-attested',
    skipped,
    missing,
    ...(nonce ? { nonce } : {}),
  };
}

// ---------------------------------------------------------------------------
// /attestation — nsm-attest passthrough (binds user_data + public-key + nonce)
// ---------------------------------------------------------------------------
//
// Mirrors nitro-signer-server.mjs handleAttestation: spawn the nsm-attest binary
// with --user-data/--nonce/--public-key and return the COSE_Sign1 doc. The key
// difference (the §5 binding fix) is user_data: for fulfill/feed it commits to a
// SINGLE 32-byte hash = sha256(fulfillment_digest | tx_message), not the signer's
// pinned-role list. The binary is run via an INJECTABLE seam so the route is
// unit-testable without a real enclave (mirrors the worker-handler test seam).

const DEFAULT_ATTEST_BIN = trimString(process.env.NITRO_ATTEST_BIN) || '/app/bin/nsm-attest';

// Runs the nsm-attest binary; returns its parsed JSON. Replaceable in tests.
function defaultAttestRunner(args, options = {}) {
  // kms-decrypt makes a network round-trip to KMS through the egress proxy; give
  // it more headroom than the local /dev/nsm attestation calls.
  const timeoutMs = Array.isArray(args) && args[0] === 'kms-decrypt' ? 25000 : 8000;
  try {
    const raw = execFileSync(DEFAULT_ATTEST_BIN, args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: options.env || process.env,
      // Capture stderr so a kms-decrypt failure (AccessDenied, egress, attestation
      // mismatch) is recoverable for diagnostics instead of vanishing to the
      // (host-invisible) enclave console.
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString('utf8');
    return JSON.parse(raw.trim().split('\n').filter(Boolean).pop());
  } catch (error) {
    // nsm-attest writes its {ok:false,error} JSON to STDOUT (emit/fail) and exits
    // non-zero; a timeout shows up as signal=SIGTERM with no output. Surface all of
    // it so the actual KMS failure (AccessDenied / attestation / hang) is recoverable.
    if (error && !error.__diagAttached) {
      const parts = [];
      if (error.signal) parts.push(`signal=${error.signal}`);
      if (error.status != null) parts.push(`status=${error.status}`);
      if (error.stdout) parts.push(`stdout=${error.stdout.toString().slice(0, 500)}`);
      if (error.stderr) parts.push(`stderr=${error.stderr.toString().slice(0, 300)}`);
      if (parts.length) error.message = `${error.message} :: ${parts.join(' ')}`;
      error.__diagAttached = true;
    }
    throw error;
  }
}

let activeAttestRunner = defaultAttestRunner;

export function __setAttestRunnerForTests(fn) {
  activeAttestRunner = typeof fn === 'function' ? fn : defaultAttestRunner;
}

export function __resetAttestRunnerForTests() {
  activeAttestRunner = defaultAttestRunner;
}

// Async attestation runner (Round-2 R2-2.2). The HOT path — handleAttestation, called by
// every /oracle/fulfill + /oracle/feed — used defaultAttestRunner, which calls execFileSync
// and BLOCKS the single-threaded Node event loop for the /dev/nsm ioctl (up to 8s). Two
// simultaneous fulfills serialized on it. This async variant uses node:child_process
// execFile (callback form) wrapped in a Promise, so the event loop serves other requests
// during the NSM round-trip. The produced bytes are IDENTICAL (same binary, same args,
// same stdio/timeout/diag-attachment) — only the blocking behavior changes.
//
// The KMS-materialization cold path (runKmsDiag / materialize*FromKms) stays on the SYNC
// defaultAttestRunner — it runs only at /provision (not concurrent), so the sync block is
// harmless there, and keeping it sync avoids a sweeping async cascade through those callers.
function defaultAsyncAttestRunner(args) {
  const timeoutMs = Array.isArray(args) && args[0] === 'kms-decrypt' ? 25000 : 8000;
  return new Promise((resolve, reject) => {
    execFile(
      DEFAULT_ATTEST_BIN,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
      (error, stdout, stderr) => {
        if (error) {
          if (!error.__diagAttached) {
            const parts = [];
            if (error.signal) parts.push(`signal=${error.signal}`);
            if (error.status != null) parts.push(`status=${error.status}`);
            if (stdout) parts.push(`stdout=${stdout.toString().slice(0, 500)}`);
            if (stderr) parts.push(`stderr=${stderr.toString().slice(0, 300)}`);
            if (parts.length) error.message = `${error.message} :: ${parts.join(' ')}`;
            error.__diagAttached = true;
          }
          reject(error);
          return;
        }
        try {
          resolve(JSON.parse(stdout.toString('utf8').trim().split('\n').filter(Boolean).pop()));
        } catch (parseError) {
          parseError.__diagAttached = true;
          reject(parseError);
        }
      }
    );
  });
}

let activeAsyncAttestRunner = defaultAsyncAttestRunner;

// Test seam for the async runner. Accepts either an async function or a sync function
// (wrapped in Promise.resolve) so existing sync test runners keep working unchanged.
export function __setAsyncAttestRunnerForTests(fn) {
  activeAsyncAttestRunner = typeof fn === 'function' ? fn : defaultAsyncAttestRunner;
}

export function __resetAsyncAttestRunnerForTests() {
  activeAsyncAttestRunner = defaultAsyncAttestRunner;
}

// Phase C (RC2): when a KMS-attested ciphertext of the oracle key material is
// provisioned (MORPHEUS_ORACLE_KMS_CIPHERTEXT_BASE64 — the host only ever holds
// this ciphertext, which is useless without the enclave's attestation), recover
// the plaintext key material IN-TEE via the attestation-gated `nsm-attest
// kms-decrypt` and expose it on the worker's configured-env JSON path. The
// plaintext key exists only inside the enclave process; the host never sees it.
// Non-destructive in-TEE KMS-path probe. kms-decrypts a DIAGNOSTIC ciphertext
// (MORPHEUS_ORACLE_KMS_DIAG_CIPHERTEXT) and records only the OUTCOME — never the
// plaintext — so ops can verify attestation-gated decrypt works without touching the
// live oracle key. Surfaces the exact failure (AccessDenied / egress / attestation
// mismatch) that otherwise vanishes to the host-invisible enclave console.
export let lastKmsDiag = { state: 'not_run' };
export function runKmsDiag() {
  const ct = trimString(process.env.MORPHEUS_ORACLE_KMS_DIAG_CIPHERTEXT);
  if (!ct) {
    lastKmsDiag = { state: 'no_diag_ciphertext' };
    return;
  }
  const region =
    trimString(process.env.AWS_REGION) || trimString(process.env.NITRO_AWS_REGION) || 'us-east-1';
  try {
    const parsed = activeAttestRunner(['kms-decrypt', '--region', region, '--ciphertext', ct]);
    lastKmsDiag =
      parsed && parsed.ok && parsed.plaintext_b64 ? { state: 'ok' } : { state: 'bad_output' };
  } catch (error) {
    lastKmsDiag = {
      state: 'error',
      message: String((error && error.message) || error).slice(0, 700),
    };
  }
}

export function materializeOracleKeyFromKms() {
  const ciphertext = trimString(process.env.MORPHEUS_ORACLE_KMS_CIPHERTEXT_BASE64);
  if (!ciphertext) return;
  // Already materialized — don't re-decrypt (and don't override a directly
  // provisioned key during a transition).
  if (
    trimString(process.env.MORPHEUS_ORACLE_KEY_MATERIAL_JSON) ||
    trimString(process.env.MORPHEUS_ORACLE_KEY_MATERIAL_BASE64)
  ) {
    return;
  }
  const region =
    trimString(process.env.AWS_REGION) || trimString(process.env.NITRO_AWS_REGION) || 'us-east-1';
  let parsed;
  try {
    parsed = activeAttestRunner(['kms-decrypt', '--region', region, '--ciphertext', ciphertext]);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'kms_oracle_key_materialize_failed',
        error: String((error && error.message) || error),
      })
    );
    return;
  }
  if (parsed && parsed.ok && parsed.plaintext_b64) {
    // The KMS plaintext is the oracle key-material JSON ({public_key_raw,
    // private_key_pkcs8}); expose it via the worker's configured-env JSON path.
    process.env.MORPHEUS_ORACLE_KEY_MATERIAL_JSON = Buffer.from(
      parsed.plaintext_b64,
      'base64'
    ).toString('utf8');
  } else {
    console.error(
      JSON.stringify({ level: 'error', event: 'kms_oracle_key_materialize_bad_output' })
    );
  }
}

// Phase D (RC1/RC2): recover a Neo X (EVM, secp256k1) key IN-TEE via the same
// attestation-gated `nsm-attest kms-decrypt` used for the X25519 oracle key. When the
// ciphertext env var is provisioned the host only ever holds the ciphertext (useless
// without the enclave's attestation); the plaintext key exists only inside the enclave
// and is exposed on the env var the EVM signer reads. The plaintext may be a raw
// 0x-hex key or a JSON envelope. No-op when not configured or the key is already set.
function materializeTextSecretFromKms({
  ciphertextEnvVar,
  alreadySetEnvVars,
  targetEnvVar,
  jsonFields,
  event,
}) {
  const ciphertext = trimString(process.env[ciphertextEnvVar]);
  if (!ciphertext) return;
  // Already materialized / directly provisioned — don't re-decrypt (transition-safe).
  if (alreadySetEnvVars.some((k) => trimString(process.env[k]))) return;
  const region =
    trimString(process.env.AWS_REGION) || trimString(process.env.NITRO_AWS_REGION) || 'us-east-1';
  let parsed;
  try {
    parsed = activeAttestRunner(['kms-decrypt', '--region', region, '--ciphertext', ciphertext]);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: `${event}_failed`,
        error: String((error && error.message) || error),
      })
    );
    return;
  }
  if (!(parsed && parsed.ok && parsed.plaintext_b64)) {
    console.error(JSON.stringify({ level: 'error', event: `${event}_bad_output` }));
    return;
  }
  const plaintext = Buffer.from(parsed.plaintext_b64, 'base64').toString('utf8').trim();
  let secret = plaintext;
  if (plaintext.startsWith('{')) {
    try {
      const obj = JSON.parse(plaintext);
      secret = '';
      for (const f of jsonFields) {
        const v = trimString(obj[f]);
        if (v) {
          secret = v;
          break;
        }
      }
    } catch {
      secret = '';
    }
  }
  if (!secret) {
    console.error(JSON.stringify({ level: 'error', event: `${event}_empty` }));
    return;
  }
  process.env[targetEnvVar] = secret;
  // KMS materialization may have written a signer env var — drop the cached signers so the
  // next sign call re-resolves. (Round-2 R2-2.1.)
  clearResolvedSignerCache();
}

// EVM oracle-fulfillment VERIFIER key (signs the attestation over oracle results) —
// exposed on the env var resolveNeoXConfig() reads, so EVM fulfillments are signed
// in-TEE with NO host-resident verifier key.
export function materializeNeoXVerifierKeyFromKms() {
  materializeTextSecretFromKms({
    ciphertextEnvVar: 'MORPHEUS_NEOX_VERIFIER_KMS_CIPHERTEXT_BASE64',
    alreadySetEnvVars: [
      'MORPHEUS_NEOX_VERIFIER_PRIVATE_KEY',
      'MORPHEUS_NEOX_VERIFIER_KEY',
      'NEOX_VERIFIER_PK',
    ],
    targetEnvVar: 'MORPHEUS_NEOX_VERIFIER_PRIVATE_KEY',
    jsonFields: ['neox_verifier_private_key', 'neoxVerifierPrivateKey', 'private_key'],
    event: 'kms_neox_verifier_key_materialize',
  });
}

// EVM FEED-updater key (signs the updateFeeds price-push tx; lower privilege than the
// verifier) — exposed on the env var handleNeoXFeedSign() reads.
export function materializeNeoXFeedKeyFromKms() {
  materializeTextSecretFromKms({
    ciphertextEnvVar: 'MORPHEUS_NEOX_FEED_KMS_CIPHERTEXT_BASE64',
    alreadySetEnvVars: ['MORPHEUS_NEOX_FEED_PRIVATE_KEY', 'NEOX_FEED_PK', 'NEOX_FEED_PRIVATE_KEY'],
    targetEnvVar: 'MORPHEUS_NEOX_FEED_PRIVATE_KEY',
    jsonFields: ['neox_feed_private_key', 'neoxFeedPrivateKey', 'private_key'],
    event: 'kms_neox_feed_key_materialize',
  });
}

// Neo N3 (secp256r1) signer keys — the oracle_verifier (signs fulfillments) and the
// updater (signs feed-update + on-chain admin txs). Same attestation-gated path as the
// EVM keys: when the KMS ciphertext is provisioned the host holds only the ciphertext,
// the plaintext WIF exists only inside the enclave on the env var the Neo N3 signer reads
// (`lib-neo-signers.mjs` resolves `MORPHEUS_*_WIF_MAINNET`). No-op until the ciphertext is
// provisioned or a plaintext WIF is already set (transition-safe).
export function materializeNeoN3OracleVerifierKeyFromKms() {
  materializeTextSecretFromKms({
    ciphertextEnvVar: 'MORPHEUS_ORACLE_VERIFIER_KMS_CIPHERTEXT_BASE64',
    alreadySetEnvVars: [
      'MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET',
      'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY_MAINNET',
      'MORPHEUS_ORACLE_VERIFIER_WIF',
    ],
    targetEnvVar: 'MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET',
    jsonFields: ['wif', 'oracle_verifier_wif', 'private_key'],
    event: 'kms_n3_oracle_verifier_key_materialize',
  });
}

export function materializeNeoN3UpdaterKeyFromKms() {
  materializeTextSecretFromKms({
    ciphertextEnvVar: 'MORPHEUS_UPDATER_NEO_N3_KMS_CIPHERTEXT_BASE64',
    alreadySetEnvVars: [
      'MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET',
      'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_MAINNET',
      'MORPHEUS_UPDATER_NEO_N3_WIF',
    ],
    targetEnvVar: 'MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET',
    jsonFields: ['wif', 'updater_wif', 'private_key'],
    event: 'kms_n3_updater_key_materialize',
  });
}

// NeoDID nullifier salt. The host provisions only a KMS CiphertextBlob; the
// salt is released into the measured enclave and never crosses the parent-host
// provisioning boundary in plaintext.
export function materializeNeoDidSaltFromKms() {
  materializeTextSecretFromKms({
    ciphertextEnvVar: 'MORPHEUS_NEODID_SALT_KMS_CIPHERTEXT_BASE64',
    alreadySetEnvVars: ['NEODID_SECRET_SALT'],
    targetEnvVar: 'NEODID_SECRET_SALT',
    jsonFields: ['neodid_secret_salt', 'secret_salt', 'salt'],
    event: 'kms_neodid_salt_materialize',
  });
}

// Resolve the public key to bind into the document for the requested role
// (default oracle_verifier — the fulfillment signer; updater for feed binding).
function resolveAttestationPublicKey(role) {
  const network = resolveNetwork();
  const normalized = trimString(role).toLowerCase() === 'updater' ? 'updater' : 'oracle_verifier';
  try {
    const report = reportPinnedNeoN3Role(network, normalized, {
      env: process.env,
      allowMissing: false,
    });
    return { role: normalized, publicKeyHex: normalizeHex(report.public_key || '') };
  } catch {
    return { role: normalized, publicKeyHex: '' };
  }
}

export async function handleAttestation(payload = {}) {
  // The binding commitment. Prefer an explicit digest/tx message; fall back to a
  // caller-supplied user_data hex. Either way user_data = sha256(<binding bytes>),
  // a single 32-byte commit (the §5 dead-binding fix).
  const digestSource = normalizeHex(
    payload.fulfillment_digest_hex ||
      payload.fulfillment_digest ||
      payload.tx_message_hex ||
      payload.tx_message ||
      payload.user_data ||
      payload.user_data_hex ||
      ''
  );
  const nonceHex = normalizeHex(
    payload.nonce || payload.report_data || payload.report_data_hex || ''
  );
  if (nonceHex && (!/^[0-9a-f]*$/.test(nonceHex) || nonceHex.length % 2 !== 0)) {
    throw httpError(400, 'nonce must be even-length hex');
  }
  if (digestSource && (!/^[0-9a-f]*$/.test(digestSource) || digestSource.length % 2 !== 0)) {
    throw httpError(400, 'binding (digest/tx_message/user_data) must be even-length hex');
  }

  // sha256 of the binding bytes -> 32-byte user_data commit. With no binding
  // supplied (a liveness probe) user_data is empty (matches a bare /attestation).
  const userDataHex = digestSource
    ? createHash('sha256').update(Buffer.from(digestSource, 'hex')).digest('hex')
    : '';

  const { role, publicKeyHex } = resolveAttestationPublicKey(payload.role || payload.key_role);

  const args = [];
  if (userDataHex) args.push('--user-data', userDataHex);
  if (nonceHex) args.push('--nonce', nonceHex);
  if (publicKeyHex) args.push('--public-key', publicKeyHex);

  let parsed;
  try {
    // Use the ASYNC attestation runner (R2-2.2) so the /dev/nsm ioctl does not block the
    // event loop — concurrent /oracle/fulfill requests can interleave during the NSM call.
    // The KMS cold path still uses the sync activeAttestRunner (only /provision, not hot).
    parsed = await activeAsyncAttestRunner(args);
  } catch (error) {
    const detail =
      error && error.stderr
        ? error.stderr.toString().slice(0, 300)
        : (error && error.message) || 'spawn failed';
    throw httpError(503, `nsm attestation helper failed: ${detail}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw httpError(503, 'nsm attestation helper returned invalid output');
  }
  if (!parsed.ok) {
    throw httpError(503, parsed.error || 'nsm attestation failed');
  }

  const attestationDocument = parsed.attestation_b64 || parsed.attestation_document || null;
  // Surface the measured PCRs (parsed from the COSE_Sign1) so callers that pin a
  // PCR0 can compare without re-parsing. Best-effort — the document stays
  // authoritative; an unparseable doc just omits the field.
  const pcrs = attestationDocument ? extractAttestationPcrs(attestationDocument) : {};
  return {
    status: 'ok',
    runtime: 'morpheus-enclave-server',
    network: resolveNetwork(),
    role,
    format: 'cose-sign1-cbor-base64',
    public_key: publicKeyHex || null,
    nonce: nonceHex || null,
    user_data_hex: userDataHex || null,
    document_len: parsed.document_len || null,
    attestation_document: attestationDocument,
    ...(pcrs && Object.keys(pcrs).length ? { pcrs } : {}),
    trust_tier: 'enclave-attested',
  };
}

// ---------------------------------------------------------------------------
// /health — compute + signer readiness
// ---------------------------------------------------------------------------

export function handleHealth() {
  const network = resolveNetwork();
  let signerOk = false;
  let signerError = null;
  let verifierPublicKey = null;
  let verifierMaterialized = false;
  let updaterMaterialized = false;
  try {
    const report = reportPinnedNeoN3Role(network, 'oracle_verifier', {
      env: process.env,
      allowMissing: false,
    });
    verifierMaterialized = Boolean(report.materialized);
    signerOk = report.ok && verifierMaterialized;
    verifierPublicKey = report.public_key || null;
    if (!signerOk && report.issues?.length) signerError = report.issues.join('; ');
  } catch (error) {
    signerError = error instanceof Error ? error.message : String(error);
  }
  try {
    const updaterReport = reportPinnedNeoN3Role(network, 'updater', {
      env: process.env,
      allowMissing: false,
    });
    updaterMaterialized = Boolean(updaterReport.materialized);
  } catch {
    updaterMaterialized = false;
  }
  const computeReady = typeof activeWorkerHandler === 'function';
  const ready = computeReady && signerOk;
  // key_source per signing role lets ops detect any reliance on a host-provided
  // plaintext key (vs the expected kms_attested path). 'host_plaintext' should
  // can only be image-baked legacy material; /provision cannot inject it.
  const keySource = {
    oracle_verifier: roleKeySource('oracle_verifier', verifierMaterialized),
    updater: roleKeySource('updater', updaterMaterialized),
  };
  return {
    status: ready ? 'ok' : 'degraded',
    ready,
    runtime: 'morpheus-enclave-server',
    network,
    checks: {
      compute: computeReady,
      signer: signerOk,
      ...(verifierPublicKey ? { oracle_verifier_public_key: verifierPublicKey } : {}),
    },
    key_source: keySource,
    plaintext_key_provision_allowed: false,
    // Outcome of the in-TEE KMS-path probe (no secrets) — lets ops confirm
    // attestation-gated decrypt works (the prerequisite for TEE-exclusive keys).
    kms_diag: lastKmsDiag,
    ...(signerError ? { signer_error: signerError } : {}),
  };
}

// ---------------------------------------------------------------------------
// dispatch — pure (no socket), unit-testable
// ---------------------------------------------------------------------------

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// Route matcher: accept the route exactly, OR with a SINGLE leading network/segment
// prefix (the control plane dispatches network-prefixed routes such as
// `/mainnet/oracle/public-key`). This is tighter than a bare path.endsWith(route),
// which would also match `/anything/<route>` (e.g. `/evil/health`). The prefix must
// be exactly one path segment.
function matchesRoute(path, route) {
  if (path === route) return true;
  const idx = path.indexOf(route);
  if (idx <= 0 || idx + route.length !== path.length) return false;
  const prefix = path.slice(0, idx); // e.g. "/mainnet"
  return /^\/[A-Za-z0-9._-]+$/.test(prefix);
}

/**
 * Pure request dispatcher. Returns { status, body } with body a plain object.
 *   method  — HTTP method
 *   rawUrl  — request URL (path; absolute or relative)
 *   headers — header map (object)
 *   body    — raw request body string (or already-parsed object)
 */
export async function dispatch(method, rawUrl, headers = {}, body = '') {
  const hostHeader = trimString(headers.host || headers.Host || '') || '127.0.0.1';
  const url = new URL(rawUrl || '/', `http://${hostHeader}`);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const httpMethod = trimString(method || 'GET').toUpperCase();

  try {
    // Open endpoints (no auth): liveness + attestation (the attestation is a
    // signed measurement, not a secret operation; matches the signer).
    if (httpMethod === 'GET' && matchesRoute(path, '/health')) {
      const health = handleHealth();
      return { status: health.ready ? 200 : 503, body: health };
    }

    if ((httpMethod === 'GET' || httpMethod === 'POST') && matchesRoute(path, '/attestation')) {
      // GET binds via query params; POST via JSON body.
      const payload = httpMethod === 'GET' ? Object.fromEntries(url.searchParams) : parseBody(body);
      const result = await handleAttestation(payload);
      return { status: 200, body: result };
    }

    // Provisioning: the first request must bind its bearer token to a runtime
    // token in the payload; subsequent requests require the current token.
    if (httpMethod === 'POST' && matchesRoute(path, '/provision')) {
      const payload = parseBody(body);
      const bootstrapRuntimeToken = assertProvisionAuthorized(headers, payload);
      const result = handleProvision(payload, bootstrapRuntimeToken);
      return { status: 200, body: result };
    }

    // Sensitive (signing) endpoints — require the provisioned bearer token.
    if (httpMethod === 'POST' && matchesRoute(path, '/oracle/fulfill')) {
      assertAuthorized(headers);
      const result = await handleOracleFulfill(parseBody(body));
      return { status: 200, body: result };
    }

    if (httpMethod === 'POST' && matchesRoute(path, '/feed/sign')) {
      assertAuthorized(headers);
      const result = await handleFeedSign(parseBody(body));
      return { status: 200, body: result };
    }

    if (httpMethod === 'POST' && matchesRoute(path, '/sign/payload')) {
      assertAuthorized(headers);
      return { status: 200, body: handleSignPayload(parseBody(body)) };
    }

    if (httpMethod === 'POST' && matchesRoute(path, '/keys/derived')) {
      assertAuthorized(headers);
      return { status: 200, body: handleKeysDerived(parseBody(body)) };
    }

    // Execution-plane passthrough (AA edge migration): the Cloudflare control
    // plane routes oracle compute + neodid jobs to these specific worker routes.
    // Serving them from the in-process worker handler makes the enclave a valid
    // confidential execution runtime (compute happens in-TEE), replacing the dead
    // Phala/placeholder runtimes. WHITELISTED — not a blanket catch-all — so the
    // public surface is exactly the control plane's EXECUTION_PLANE_ROUTES, and
    // auth-gated like every other sensitive route. NOTE (EGRESS-1): an
    // arbitrary-URL smart-fetch (payload.url) DOES reach the in-TEE worker via
    // this passthrough — it is NOT excluded here. Its outbound host is gated ONLY
    // by the egress allow-list (fail-closed); set ORACLE_HTTP_ALLOWLIST for an
    // app-layer defense-in-depth match.
    if (httpMethod === 'POST') {
      const passthrough = EXECUTION_PLANE_PASSTHROUGH.find((route) => matchesRoute(path, route));
      if (passthrough) {
        assertAuthorized(headers);
        const resp = await computeViaWorker(passthrough, parseBody(body));
        return { status: resp.status, body: resp.body };
      }
    }

    // Public X25519 oracle encryption key. NOT secret: clients encrypt confidential
    // payloads to it and the publish-oracle-public-key flow reads it to mirror it
    // on-chain. Served from the in-TEE worker (capabilities.js -> ensureOracleKeyMaterial)
    // so it reflects this enclave's ACTUAL materialized keypair — closing the gap where
    // a key sealed in-TEE had no published public half, leaving confidential decrypt
    // unusable. Ungated: it is a public key; the private half never leaves the enclave.
    if (
      (httpMethod === 'GET' || httpMethod === 'POST') &&
      matchesRoute(path, '/oracle/public-key')
    ) {
      const resp = await computeViaWorker(
        '/oracle/public-key',
        httpMethod === 'POST' ? parseBody(body) : {}
      );
      return { status: resp.status, body: resp.body };
    }

    return { status: 404, body: { error: 'not found', path } };
  } catch (error) {
    const status = Number(error?.status) || 500;
    return {
      status,
      body: {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        runtime: 'morpheus-enclave-server',
      },
    };
  }
}

function parseBody(body) {
  if (body && typeof body === 'object') return body;
  const text = trimString(body);
  if (!text) return {};
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// HTTP server (thin shim over dispatch)
// ---------------------------------------------------------------------------

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw httpError(413, 'request body too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createServer() {
  return http.createServer(async (req, res) => {
    let bodyText = '';
    try {
      bodyText = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req);
    } catch (error) {
      const status = Number(error?.status) || 400;
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ status: 'error', error: error.message }));
      return;
    }
    const result = await dispatch(req.method || 'GET', req.url || '/', req.headers || {}, bodyText);
    res.writeHead(result.status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(result.body));
  });
}

// Start the server only when run directly (never when imported by the test).
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  const port = Math.max(Number(process.env.PORT || process.env.ENCLAVE_PORT || DEFAULT_PORT), 1);
  // SECURITY (S15): bind loopback by default; expose externally only when
  // explicitly configured (ENCLAVE_HOST=0.0.0.0) behind a controlled network.
  const host = trimString(process.env.ENCLAVE_HOST || process.env.HOST || '127.0.0.1');
  createServer().listen(port, host, () => {
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'morpheus enclave-server listening',
        host,
        port,
        network: resolveNetwork(),
      })
    );
  });
}
