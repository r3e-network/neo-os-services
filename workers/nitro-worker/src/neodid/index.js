import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  neoNetworkMagicLe4,
  encodeUint256Word,
} from '@r3e-network/neo-os-services-shared/neo-encoding';
import {
  env,
  envForNetwork,
  json,
  requestLog,
  resolvePayloadNetwork,
  resolveReviewedNeoNetworkMagic,
  sha256Hex,
  strip0x,
  trimString,
} from '../platform/core.js';
import { resolveConfidentialPayload } from '../oracle/crypto.js';
import {
  buildVerificationEnvelope,
  buildSignedResultEnvelope,
  custodySignBytes,
  rejectCallerSuppliedSigningKey,
} from '../chain/index.js';
import { deriveKeyBytes, getDstackInfo } from '../platform/nitro-signer.js';

const NEODID_BINDING_DOMAIN = Buffer.from('neodid-binding-v1', 'utf8');
// Keep the private claim commitment domain separate from the on-chain binding
// digest domain. A secret commitment and a custody authorization must never
// become interchangeable merely because both are 32-byte hashes.
const NEODID_CLAIM_COMMITMENT_DOMAIN = Buffer.from('neodid-claim-secret-v1', 'utf8');
const NEODID_BINDING_COMMITMENT_DOMAIN = Buffer.from('neodid-claim-commitment-v1', 'utf8');
const NEODID_ACTION_DOMAIN = Buffer.from('neodid-action-v1', 'utf8');
const NEODID_RECOVERY_DOMAIN = Buffer.from('neodid-recovery-v1', 'utf8');
const NEODID_ZKLOGIN_DOMAIN = Buffer.from('neodid-zklogin-v1', 'utf8');

// `derives_provider_uid_in_tee` (E3): true means the worker derives the
// nullifier-binding provider_uid from a cryptographically-verified credential
// INSIDE the enclave (web3auth verifies a signed id_token), so the uid is not
// forgeable by the caller. false means the provider_uid is currently taken from
// the (untrusted) request body — a caller could forge a ticket bound to another
// user's identity. Tightening these to TEE-verified is a coordinated rollout
// (see MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID below).
const SUPPORTED_PROVIDERS = [
  {
    id: 'web3auth',
    category: 'identity',
    aliases: ['w3a'],
    auth_modes: ['aggregate_oauth', 'mfa'],
    claim_types: ['Web3Auth_PrimaryIdentity', 'Web3Auth_LinkedSocials', 'Web3Auth_VerifiedUser'],
    derives_provider_uid_in_tee: true,
  },
  {
    id: 'twitter',
    category: 'social',
    aliases: [],
    auth_modes: ['oauth'],
    claim_types: ['Twitter_VIP', 'Twitter_Verified', 'Twitter_Followers'],
    derives_provider_uid_in_tee: false,
  },
  {
    id: 'github',
    category: 'social',
    aliases: [],
    auth_modes: ['oauth'],
    claim_types: ['Github_Contributor', 'Github_OrgMember', 'Github_VerifiedUser'],
    derives_provider_uid_in_tee: false,
  },
  {
    id: 'google',
    category: 'social',
    aliases: ['gmail'],
    auth_modes: ['oauth'],
    claim_types: ['Google_Identity', 'Google_Workspace', 'Google_VerifiedEmail'],
    derives_provider_uid_in_tee: false,
  },
  {
    id: 'discord',
    category: 'social',
    aliases: [],
    auth_modes: ['oauth'],
    claim_types: ['Discord_Member'],
    derives_provider_uid_in_tee: false,
  },
  {
    id: 'telegram',
    category: 'social',
    aliases: [],
    auth_modes: ['oauth'],
    claim_types: ['Telegram_Member'],
    derives_provider_uid_in_tee: false,
  },
  {
    id: 'binance',
    category: 'exchange',
    aliases: [],
    auth_modes: ['api', 'oauth'],
    claim_types: ['Binance_KYC', 'Binance_VIP', 'Binance_AssetHolder'],
    derives_provider_uid_in_tee: false,
  },
  {
    id: 'okx',
    category: 'exchange',
    aliases: ['okex'],
    auth_modes: ['api', 'oauth'],
    claim_types: ['OKX_KYC', 'OKX_VIP', 'OKX_AssetHolder'],
    derives_provider_uid_in_tee: false,
  },
  {
    id: 'email',
    category: 'contact',
    aliases: ['mail'],
    auth_modes: ['otp', 'magic_link'],
    claim_types: ['Email_Verified'],
    derives_provider_uid_in_tee: false,
  },
  {
    id: 'generic_oauth',
    category: 'generic',
    aliases: [],
    auth_modes: ['oauth'],
    claim_types: ['Generic_Claim'],
    derives_provider_uid_in_tee: false,
  },
];

const PROVIDERS_WITH_TEE_UID = new Set(
  SUPPORTED_PROVIDERS.filter((provider) => provider.derives_provider_uid_in_tee).map(
    (provider) => provider.id
  )
);

// Default DENY (secure-by-default, audit finding 24/33): the worker rejects any
// bind/action ticket whose provider_uid was not TEE-verified, because for the
// non-web3auth providers the uid is taken straight from the caller, so allowing
// it lets anyone mint a ticket against an arbitrary identity. Operators who still
// need the legacy provider lanes (twitter/github/… where the uid is not derived
// in-TEE) opt back in explicitly with MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID=true —
// a deliberate, documented downgrade. This governs the low-assurance lanes
// (bind / action-ticket) only; the high-assurance recovery / zklogin lanes
// fail closed regardless (see isHighAssuranceUnverifiedProviderAllowed).
function allowUnverifiedProviderUid() {
  const raw = trimString(env('MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID')).toLowerCase();
  if (!raw) return false; // default: fail closed
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

// Lanes that mint account-control tickets (social recovery, zklogin AA actions)
// MUST bind to a provider_uid the enclave actually verified — otherwise a caller
// can forge a ticket against an arbitrary uid and seize/act on another user's
// account. These lanes therefore DEFAULT-DENY any provider that does not derive
// its provider_uid inside the TEE (fail closed). An operator can re-enable a
// specific provider for these lanes only via an explicit comma-separated
// allowlist (MORPHEUS_NEODID_RECOVERY_ALLOW_UNVERIFIED_PROVIDERS), e.g. while a
// dedicated credential verifier for that provider is being rolled out.
const HIGH_ASSURANCE_CONTEXTS = new Set(['recovery', 'zklogin']);

function highAssuranceUnverifiedProviderAllowlist() {
  return new Set(
    trimString(env('MORPHEUS_NEODID_RECOVERY_ALLOW_UNVERIFIED_PROVIDERS'))
      .toLowerCase()
      .split(',')
      .map((entry) => normalizeNeoDidProviderId(entry))
      .filter(Boolean)
  );
}

function isHighAssuranceUnverifiedProviderAllowed(provider) {
  return highAssuranceUnverifiedProviderAllowlist().has(provider);
}

const PROVIDER_ALIAS_MAP = Object.fromEntries(
  SUPPORTED_PROVIDERS.flatMap((provider) => [
    [provider.id, provider.id],
    ...(provider.aliases || []).map((alias) => [alias, provider.id]),
  ])
);

const WEB3AUTH_JWKS_CACHE = new Map();

function encodeLengthPrefixedAscii(value = '') {
  const text = String(value ?? '');
  const body = Buffer.from(text, 'utf8');
  if (body.length > 255) {
    throw new Error('segment too long');
  }
  return Buffer.concat([Buffer.from([body.length]), body]);
}

function normalizeNeoDidProviderId(value) {
  const normalized = trimString(value).toLowerCase();
  return PROVIDER_ALIAS_MAP[normalized] || normalized;
}

function getWeb3AuthJwks(url) {
  const normalized = trimString(url);
  if (!normalized) throw new Error('WEB3AUTH_JWKS_URL is required');
  if (!WEB3AUTH_JWKS_CACHE.has(normalized)) {
    WEB3AUTH_JWKS_CACHE.set(normalized, createRemoteJWKSet(new URL(normalized)));
  }
  return WEB3AUTH_JWKS_CACHE.get(normalized);
}

// The JWKS URL, client id (audience) and issuer are the JWT trust anchors. They
// MUST come only from server-side env: a caller who can choose the JWKS URL and
// audience can sign their own id_token for any victim's provider_uid and obtain
// a Morpheus-signed recovery/zklogin/bind ticket (account takeover). The request
// body never participates in resolving these — see resolveVerifiedProviderUid.
function resolveWeb3AuthJwksUrl() {
  return trimString(
    env('WEB3AUTH_JWKS_URL') || 'https://api-auth.web3auth.io/.well-known/jwks.json'
  );
}

function resolveWeb3AuthClientId() {
  return trimString(
    env('WEB3AUTH_CLIENT_ID', 'NEXT_PUBLIC_WEB3AUTH_CLIENT_ID', 'VITE_WEB3AUTH_CLIENT_ID') || ''
  );
}

function resolveWeb3AuthIssuer() {
  // Optional defense-in-depth: when set, jwtVerify also pins the token issuer.
  return trimString(env('WEB3AUTH_ISSUER') || '');
}

function buildStableWeb3AuthProviderUid(claims = {}) {
  const aggregateVerifier = trimString(claims.aggregateVerifier || '');
  const aggregateVerifierId = trimString(claims.aggregateVerifierId || '');
  if (aggregateVerifier && aggregateVerifierId) {
    return `web3auth:${aggregateVerifier}:${aggregateVerifierId}`;
  }

  const verifier = trimString(claims.verifier || '');
  const verifierId = trimString(claims.verifierId || claims.email || claims.sub || '');
  if (verifier && verifierId) {
    return `web3auth:${verifier}:${verifierId}`;
  }

  const fallback = trimString(claims.sub || claims.email || claims.name || '');
  return fallback ? `web3auth:user:${fallback}` : '';
}

function extractWeb3AuthIdToken(payload = {}) {
  return trimString(
    payload.id_token ||
      payload.idToken ||
      payload.web3auth_id_token ||
      payload.web3authIdToken ||
      ''
  );
}

async function resolveVerifiedProviderUid(provider, payload = {}, context = 'bind') {
  if (provider !== 'web3auth') {
    const highAssurance = HIGH_ASSURANCE_CONTEXTS.has(context);
    if (highAssurance && !isHighAssuranceUnverifiedProviderAllowed(provider)) {
      // Account-control lanes (recovery / zklogin) fail closed: a forgeable
      // provider_uid here lets a caller mint a ticket against an arbitrary uid
      // and seize/act on another user's account. Only an explicit per-provider
      // allowlist (MORPHEUS_NEODID_RECOVERY_ALLOW_UNVERIFIED_PROVIDERS) re-enables
      // an unverified provider for these lanes.
      throw new Error(
        `provider ${provider} provider_uid is not verified in the enclave; ` +
          `${context}-ticket requires a TEE-verified provider_uid ` +
          '(enable per-provider via MORPHEUS_NEODID_RECOVERY_ALLOW_UNVERIFIED_PROVIDERS)'
      );
    }
    // E3: these providers take the provider_uid from the (untrusted) request
    // body — it is not verified inside the enclave, so a ticket could be forged
    // against another user's identity. Default-allow (current behavior); when
    // MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID is disabled, reject hard. Either way,
    // log loudly so the trust posture is visible in the audit trail.
    if (!highAssurance && !allowUnverifiedProviderUid()) {
      throw new Error(
        `provider ${provider} provider_uid is not verified in the enclave; ` +
          'unverified provider_uid is disabled (MORPHEUS_NEODID_ALLOW_UNVERIFIED_UID=false)'
      );
    }
    const providerUid = resolveProviderUid(payload);
    requestLog('warn', 'neodid_unverified_provider_uid', {
      provider,
      context,
      high_assurance: highAssurance,
      derives_provider_uid_in_tee: false,
      provider_uid_hash: sha256Hex(`${provider}${providerUid}`).slice(0, 16),
      note: 'provider_uid taken from untrusted request body (not TEE-verified)',
    });
    return providerUid;
  }

  const idToken = extractWeb3AuthIdToken(payload);
  if (!idToken) {
    throw new Error('web3auth id_token is required');
  }

  const jwksUrl = resolveWeb3AuthJwksUrl();
  const clientId = resolveWeb3AuthClientId();
  if (!clientId) {
    throw new Error('WEB3AUTH_CLIENT_ID is required for web3auth verification');
  }
  const issuer = resolveWeb3AuthIssuer();
  const JWKS = getWeb3AuthJwks(jwksUrl);
  const { payload: claims } = await jwtVerify(idToken, JWKS, {
    audience: clientId,
    ...(issuer ? { issuer } : {}),
  });
  const derivedProviderUid = buildStableWeb3AuthProviderUid(claims);
  if (!derivedProviderUid) {
    throw new Error('unable to derive stable Web3Auth provider_uid');
  }

  const suppliedProviderUid = trimString(
    payload.provider_uid || payload.social_uid || payload.user_id || ''
  );
  if (suppliedProviderUid && suppliedProviderUid !== derivedProviderUid) {
    throw new Error('web3auth provider_uid does not match verified id_token');
  }

  return derivedProviderUid;
}

function requireSupportedProvider(value) {
  const providerId = normalizeNeoDidProviderId(value);
  if (!SUPPORTED_PROVIDERS.some((provider) => provider.id === providerId)) {
    throw new Error(`unsupported neodid provider: ${value}`);
  }
  return providerId;
}

async function resolveNeoDidSalt() {
  // The salt is the sole secret guaranteeing nullifier stability/uniqueness, so
  // it must be server-authoritative. A caller-supplied salt would let one
  // identity grind unlimited distinct master/action nullifiers (the on-chain
  // registry only rejects byte-identical repeats), defeating Sybil/uniqueness.
  // It is therefore resolved ONLY from env / the TEE-derived key, never payload.
  const explicit = trimString(env('NEODID_SECRET_SALT') || '');
  if (explicit) {
    return Buffer.from(sha256Hex(explicit), 'hex');
  }
  try {
    const configuredPath = trimString(env('NITRO_NEODID_SALT_PATH') || '');
    const keyPath = configuredPath || 'morpheus/neodid/nullifier/v1';
    const derived = await deriveKeyBytes(keyPath, 'neodid-nullifier-salt');
    // Match the explicit-env path EXACTLY to avoid silent nullifier drift:
    // NEODID_SECRET_SALT is provisioned as deriveKeyBytes(...).toString('hex'),
    // and the explicit branch above returns sha256(that hex text). Hash the
    // derived bytes' hex here too, so both paths yield the SAME nullifier for
    // the same master key (the env path stays authoritative and unchanged).
    return Buffer.from(sha256Hex(Buffer.from(derived).toString('hex')), 'hex');
  } catch {
    throw new Error(
      'NeoDID salt unavailable: set NEODID_SECRET_SALT env var or ensure dstack is available'
    );
  }
}

function computeMasterNullifier(provider, providerUid, saltBytes) {
  return createHash('sha256')
    .update(Buffer.from(String(provider || ''), 'utf8'))
    .update(Buffer.from([0x1f]))
    .update(Buffer.from(String(providerUid || ''), 'utf8'))
    .update(Buffer.from([0x1f]))
    .update(saltBytes)
    .digest('hex');
}

function computeClaimCommitment(provider, providerUid, claimType, claimValue, saltBytes) {
  return createHash('sha256')
    .update(NEODID_CLAIM_COMMITMENT_DOMAIN)
    .update(encodeLengthPrefixedAscii(provider))
    .update(encodeLengthPrefixedAscii(providerUid))
    .update(encodeLengthPrefixedAscii(claimType))
    .update(encodeLengthPrefixedAscii(claimValue || ''))
    .update(saltBytes)
    .digest('hex');
}

function computeActionNullifier(provider, providerUid, actionId, saltBytes) {
  return createHash('sha256')
    .update(Buffer.from(String(provider || ''), 'utf8'))
    .update(Buffer.from([0x1f]))
    .update(Buffer.from(String(providerUid || ''), 'utf8'))
    .update(Buffer.from([0x1f]))
    .update(Buffer.from(String(actionId || ''), 'utf8'))
    .update(Buffer.from([0x1f]))
    .update(saltBytes)
    .digest('hex');
}

function computeMetadataHash(metadata) {
  return sha256Hex(metadata ?? {});
}

function encodeHash160OrZero(value) {
  if (!value) return Buffer.alloc(20, 0);
  return Buffer.from(value.replace(/^0x/i, ''), 'hex');
}

// 4-byte little-endian network magic, matching NeoDIDRegistry.NetworkMagicLe4()
// (Runtime.GetNetwork()). The contract's ComputeBindingDigest/ComputeActionDigest
// append these bytes before the SHA256, so the off-chain signer MUST reproduce
// them or every binding/action ticket fails on-chain signature verification.
function neoN3NetworkMagicLe4(network) {
  const magic = resolveReviewedNeoNetworkMagic(
    network,
    envForNetwork(network, 'NEO_NETWORK_MAGIC')
  );
  return neoNetworkMagicLe4(magic);
}

function buildBindingDigestBytes(ticket) {
  return createHash('sha256')
    .update(
      Buffer.concat([
        NEODID_BINDING_DOMAIN,
        Buffer.from(ticket.vault_account.replace(/^0x/i, ''), 'hex'),
        encodeLengthPrefixedAscii(ticket.provider),
        encodeLengthPrefixedAscii(ticket.claim_type),
        encodeLengthPrefixedAscii(ticket.claim_value || ''),
        Buffer.from(ticket.master_nullifier, 'hex'),
        Buffer.from(ticket.metadata_hash, 'hex'),
        neoN3NetworkMagicLe4(ticket.network),
      ])
    )
    .digest();
}

function buildBindingCommitmentDigestBytes(ticket) {
  return createHash('sha256')
    .update(
      Buffer.concat([
        NEODID_BINDING_COMMITMENT_DOMAIN,
        Buffer.from(ticket.vault_account.replace(/^0x/i, ''), 'hex'),
        encodeLengthPrefixedAscii(ticket.provider),
        encodeLengthPrefixedAscii(ticket.claim_type),
        Buffer.from(ticket.claim_commitment, 'hex'),
        Buffer.from(ticket.master_nullifier, 'hex'),
        Buffer.from(ticket.metadata_hash, 'hex'),
        neoN3NetworkMagicLe4(ticket.network),
      ])
    )
    .digest();
}

function buildActionDigestBytes(ticket) {
  return createHash('sha256')
    .update(
      Buffer.concat([
        NEODID_ACTION_DOMAIN,
        Buffer.from(ticket.disposable_account.replace(/^0x/i, ''), 'hex'),
        encodeLengthPrefixedAscii(ticket.action_id),
        Buffer.from(ticket.action_nullifier, 'hex'),
        neoN3NetworkMagicLe4(ticket.network),
      ])
    )
    .digest();
}

function buildRecoveryDigestBytes(ticket) {
  return createHash('sha256')
    .update(
      Buffer.concat([
        NEODID_RECOVERY_DOMAIN,
        encodeLengthPrefixedAscii(ticket.network),
        Buffer.from(ticket.aa_contract.replace(/^0x/i, ''), 'hex'),
        encodeHash160OrZero(ticket.verifier_contract),
        encodeHash160OrZero(ticket.account_address),
        encodeLengthPrefixedAscii(ticket.account_id),
        Buffer.from(ticket.new_owner.replace(/^0x/i, ''), 'hex'),
        encodeLengthPrefixedAscii(ticket.recovery_nonce),
        encodeLengthPrefixedAscii(ticket.expires_at),
        encodeLengthPrefixedAscii(ticket.action_id),
        Buffer.from(ticket.master_nullifier, 'hex'),
        Buffer.from(ticket.action_nullifier, 'hex'),
      ])
    )
    .digest();
}

// Digest signatures are custody-side: the enclave signs sha256(digestBytes)
// under the worker role's allow_raw key, byte-identical to the neon-js
// `wallet.sign` path this replaces. There is no local, env-provided, derived,
// or pinned-registry key fallback — provisioning SIGNER_ROLE_WORKER_KEY_ID is
// required — and caller-supplied key material is rejected like on every other
// signing lane.
async function signDigestBytes(digestBytes, payload = {}) {
  rejectCallerSuppliedSigningKey(payload);
  const signed = await custodySignBytes('worker', Buffer.from(digestBytes));
  return {
    signature: signed.signature,
    public_key: signed.public_key,
    signer_address: signed.address,
    signer_script_hash: `0x${strip0x(signed.script_hash || '')}`,
  };
}

function resolveProviderUid(payload = {}) {
  const providerUid = trimString(
    payload.provider_uid || payload.social_uid || payload.user_id || payload.account_id || ''
  );
  if (!providerUid) throw new Error('provider_uid is required');
  return providerUid;
}

function resolveHash160(value, fieldName) {
  const normalized = trimString(value).replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) throw new Error(`${fieldName} must be a 20-byte hash160`);
  return `0x${normalized}`;
}

function resolveOptionalHash160(value, fieldName) {
  const text = trimString(value);
  if (!text) return null;
  return resolveHash160(text, fieldName);
}

function resolveHash32(value, fieldName) {
  const normalized = trimString(value).replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${fieldName} must be a 32-byte hash`);
  return `0x${normalized}`;
}

function resolveRequiredText(value, fieldName) {
  const text = trimString(value);
  if (!text) throw new Error(`${fieldName} is required`);
  if (Buffer.byteLength(text, 'utf8') > 255) throw new Error(`${fieldName} is too long`);
  return text;
}

function resolveUint256Text(value, fieldName) {
  const text = resolveRequiredText(value, fieldName);
  let parsed;
  try {
    parsed = BigInt(text);
  } catch {
    throw new Error(`${fieldName} must be a uint256 string`);
  }
  if (parsed < 0n) throw new Error(`${fieldName} must be >= 0`);
  return text;
}

function resolveRecoveryActionId(payload, network, aaContract, accountId, newOwner, recoveryNonce) {
  const explicit = trimString(
    payload.action_id || payload.recovery_action_id || payload.recovery_id || payload.intent || ''
  );
  if (explicit) return resolveRequiredText(explicit, 'action_id');
  const digest = sha256Hex(
    ['aa_recovery', network, aaContract, accountId, newOwner, recoveryNonce].join('\u001f')
  );
  return resolveRequiredText(`aa_recovery:${digest}`, 'action_id');
}

function resolveZkLoginActionId(
  payload,
  verifierContract,
  accountIdHash,
  targetContract,
  method,
  argsHash,
  nonce,
  deadline
) {
  const explicit = trimString(
    payload.action_id || payload.zklogin_action_id || payload.intent || ''
  );
  if (explicit) return resolveRequiredText(explicit, 'action_id');
  const digest = sha256Hex(
    [
      'aa_zklogin',
      verifierContract,
      accountIdHash,
      targetContract,
      method,
      argsHash,
      nonce,
      deadline,
    ].join('\u001f')
  );
  return resolveRequiredText(`aa_zklogin:${digest}`, 'action_id');
}

function buildZkLoginDigestBytes(ticket) {
  return createHash('sha256')
    .update(
      Buffer.concat([
        NEODID_ZKLOGIN_DOMAIN,
        encodeHash160OrZero(ticket.verifier_contract),
        Buffer.from(ticket.account_id_hash.replace(/^0x/i, ''), 'hex'),
        Buffer.from(ticket.target_contract.replace(/^0x/i, ''), 'hex'),
        encodeLengthPrefixedAscii(ticket.method),
        Buffer.from(ticket.args_hash.replace(/^0x/i, ''), 'hex'),
        encodeUint256Word(ticket.nonce, 'nonce'),
        encodeUint256Word(ticket.deadline, 'deadline'),
        encodeLengthPrefixedAscii(ticket.provider),
        Buffer.from(ticket.master_nullifier, 'hex'),
        Buffer.from(ticket.action_nullifier, 'hex'),
      ])
    )
    .digest();
}

async function buildNeoDidResponse(mode, result, payload) {
  const signed = await buildSignedResultEnvelope(result, payload);
  // signed.tee_attestation already binds signed.output_hash (sha256(stableStringify(result)))
  // computed once inside buildSignedResultEnvelope; reuse it instead of a second /attestation call.
  const teeAttestation = signed.tee_attestation;
  const callbackEncoding = trimString(payload.callback_encoding || payload.result_encoding || '');
  return json(200, {
    ...result,
    mode,
    callback_encoding: callbackEncoding || undefined,
    output_hash: signed.output_hash,
    attestation_hash: signed.attestation_hash,
    verification: buildVerificationEnvelope(signed),
    tee_attestation: teeAttestation,
  });
}

export function handleNeoDidProviders() {
  return json(200, { providers: SUPPORTED_PROVIDERS });
}

export async function handleNeoDidRuntime(payload = {}) {
  const info = await getDstackInfo({ required: false });
  const signer = await signDigestBytes(Buffer.from(sha256Hex('neodid-runtime'), 'hex'), payload);
  const web3authJwksUrl = resolveWeb3AuthJwksUrl();
  const web3authClientId = resolveWeb3AuthClientId();
  return json(200, {
    service: 'neodid',
    app_id: info?.app_id || null,
    instance_id: info?.instance_id || null,
    compose_hash: info?.compose_hash || null,
    verification_public_key: signer.public_key,
    verifier_curve: 'secp256r1',
    supported_routes: [
      '/neodid/providers',
      '/neodid/runtime',
      '/neodid/bind',
      '/neodid/action-ticket',
      '/neodid/recovery-ticket',
      '/neodid/zklogin-ticket',
    ],
    request_types: [
      'neodid_bind',
      'neodid_action_ticket',
      'neodid_recovery_ticket',
      'neodid_zklogin_ticket',
    ],
    web3auth: {
      jwks_url: web3authJwksUrl || null,
      audience_configured: Boolean(web3authClientId),
      derives_provider_uid_in_tee: true,
    },
    // E3 — surface the provider_uid trust posture so consumers can tell which
    // providers derive the nullifier-binding uid inside the enclave.
    provider_uid_verification: {
      tee_verified_providers: [...PROVIDERS_WITH_TEE_UID],
      unverified_provider_uid_allowed: allowUnverifiedProviderUid(),
    },
    providers: SUPPORTED_PROVIDERS,
  });
}

export async function handleNeoDidBind(payload = {}) {
  const resolvedPayload = await resolveConfidentialPayload(payload);
  const saltBytes = await resolveNeoDidSalt();
  const provider = requireSupportedProvider(resolvedPayload.provider || 'twitter');
  const providerUid = await resolveVerifiedProviderUid(provider, resolvedPayload);
  const ticket = {
    vault_account: resolveHash160(
      resolvedPayload.vault_account || resolvedPayload.vault_script_hash,
      'vault_account'
    ),
    provider,
    provider_uid: providerUid,
    claim_type: trimString(resolvedPayload.claim_type || 'Generic_Claim') || 'Generic_Claim',
    claim_value: trimString(resolvedPayload.claim_value || ''),
    metadata_hash: computeMetadataHash(resolvedPayload.metadata || {}),
    // Network the digest is signed for; bound into the digest so the signature
    // matches the on-chain NeoDIDRegistry verifier and cannot be cross-network replayed.
    network: resolvePayloadNetwork(resolvedPayload, 'testnet'),
  };
  ticket.master_nullifier = computeMasterNullifier(ticket.provider, ticket.provider_uid, saltBytes);
  ticket.claim_commitment = computeClaimCommitment(
    ticket.provider,
    ticket.provider_uid,
    ticket.claim_type,
    ticket.claim_value,
    saltBytes
  );
  const digestBytes = buildBindingDigestBytes(ticket);
  const signer = await signDigestBytes(digestBytes, resolvedPayload);
  const commitmentDigestBytes = buildBindingCommitmentDigestBytes(ticket);
  const commitmentSigner = await signDigestBytes(commitmentDigestBytes, resolvedPayload);
  const result = {
    binding_mode: 'commitment-v1',
    vault_account: ticket.vault_account,
    provider: ticket.provider,
    claim_type: ticket.claim_type,
    claim_value: ticket.claim_value,
    claim_commitment: `0x${ticket.claim_commitment}`,
    master_nullifier: `0x${ticket.master_nullifier}`,
    metadata_hash: `0x${ticket.metadata_hash}`,
    digest: `0x${Buffer.from(digestBytes).toString('hex')}`,
    commitment_digest: `0x${Buffer.from(commitmentDigestBytes).toString('hex')}`,
    commitment_signature: commitmentSigner.signature,
    commitment_public_key: commitmentSigner.public_key,
    ...signer,
  };
  return buildNeoDidResponse('neodid_bind', result, resolvedPayload);
}

export async function handleNeoDidActionTicket(payload = {}) {
  const resolvedPayload = await resolveConfidentialPayload(payload);
  const saltBytes = await resolveNeoDidSalt();
  const provider = requireSupportedProvider(resolvedPayload.provider || 'twitter');
  const providerUid = await resolveVerifiedProviderUid(provider, resolvedPayload);
  const actionId = trimString(resolvedPayload.action_id || resolvedPayload.intent || '');
  if (!actionId) throw new Error('action_id is required');
  const actionNullifier = computeActionNullifier(provider, providerUid, actionId, saltBytes);
  const ticket = {
    disposable_account: resolveHash160(
      resolvedPayload.disposable_account || resolvedPayload.disposable_script_hash,
      'disposable_account'
    ),
    action_id: actionId,
    action_nullifier: actionNullifier,
    // Bound into the digest to match the on-chain verifier (cross-network replay guard).
    network: resolvePayloadNetwork(resolvedPayload, 'testnet'),
  };
  const digestBytes = buildActionDigestBytes(ticket);
  const signer = await signDigestBytes(digestBytes, resolvedPayload);
  const result = {
    disposable_account: ticket.disposable_account,
    action_id: ticket.action_id,
    action_nullifier: `0x${ticket.action_nullifier}`,
    digest: `0x${Buffer.from(digestBytes).toString('hex')}`,
    ...signer,
  };
  return buildNeoDidResponse('neodid_action_ticket', result, resolvedPayload);
}

export async function handleNeoDidRecoveryTicket(payload = {}) {
  const resolvedPayload = await resolveConfidentialPayload(payload);
  const saltBytes = await resolveNeoDidSalt();
  const provider = requireSupportedProvider(resolvedPayload.provider || 'twitter');
  const providerUid = await resolveVerifiedProviderUid(provider, resolvedPayload, 'recovery');
  const network = resolveRequiredText(
    resolvedPayload.network || resolvedPayload.target_chain || 'neo_n3',
    'network'
  );
  const aaContract = resolveHash160(
    resolvedPayload.aa_contract ||
      resolvedPayload.account_contract ||
      resolvedPayload.wallet_contract,
    'aa_contract'
  );
  const verifierContract = resolveOptionalHash160(
    resolvedPayload.verifier_contract || resolvedPayload.recovery_verifier_contract,
    'verifier_contract'
  );
  const accountAddress = resolveOptionalHash160(
    resolvedPayload.account_address || resolvedPayload.aa_address || resolvedPayload.wallet_address,
    'account_address'
  );
  const accountId = resolveRequiredText(
    resolvedPayload.account_id || resolvedPayload.accountId || resolvedPayload.wallet_id,
    'account_id'
  );
  const newOwner = resolveHash160(
    resolvedPayload.new_owner || resolvedPayload.recovery_address || resolvedPayload.target_owner,
    'new_owner'
  );
  const recoveryNonce = resolveRequiredText(
    resolvedPayload.recovery_nonce || resolvedPayload.nonce,
    'recovery_nonce'
  );
  const expiresAt = resolveRequiredText(
    resolvedPayload.expires_at || resolvedPayload.expiry || resolvedPayload.ticket_expires_at,
    'expires_at'
  );
  const masterNullifier = computeMasterNullifier(provider, providerUid, saltBytes);
  const actionId = resolveRecoveryActionId(
    resolvedPayload,
    network,
    aaContract,
    accountId,
    newOwner,
    recoveryNonce
  );
  const actionNullifier = computeActionNullifier(provider, providerUid, actionId, saltBytes);

  const ticket = {
    network,
    aa_contract: aaContract,
    verifier_contract: verifierContract,
    account_address: accountAddress,
    account_id: accountId,
    new_owner: newOwner,
    recovery_nonce: recoveryNonce,
    expires_at: expiresAt,
    action_id: actionId,
    master_nullifier: masterNullifier,
    action_nullifier: actionNullifier,
  };
  const digestBytes = buildRecoveryDigestBytes(ticket);
  const signer = await signDigestBytes(digestBytes, resolvedPayload);
  const result = {
    network: ticket.network,
    aa_contract: ticket.aa_contract,
    verifier_contract: ticket.verifier_contract,
    account_address: ticket.account_address,
    account_id: ticket.account_id,
    new_owner: ticket.new_owner,
    recovery_nonce: ticket.recovery_nonce,
    expires_at: ticket.expires_at,
    provider,
    action_id: ticket.action_id,
    master_nullifier: `0x${ticket.master_nullifier}`,
    action_nullifier: `0x${ticket.action_nullifier}`,
    digest: `0x${Buffer.from(digestBytes).toString('hex')}`,
    ...signer,
  };
  return buildNeoDidResponse('neodid_recovery_ticket', result, resolvedPayload);
}

export async function handleNeoDidZkLoginTicket(payload = {}) {
  const resolvedPayload = await resolveConfidentialPayload(payload);
  const saltBytes = await resolveNeoDidSalt();
  const provider = requireSupportedProvider(resolvedPayload.provider || 'web3auth');
  if (provider !== 'web3auth') {
    throw new Error('zklogin-ticket currently requires provider=web3auth');
  }
  const providerUid = await resolveVerifiedProviderUid(provider, resolvedPayload, 'zklogin');
  const verifierContract = resolveHash160(
    resolvedPayload.verifier_contract || resolvedPayload.verifier || resolvedPayload.verifier_hash,
    'verifier_contract'
  );
  const accountIdHash = resolveHash160(
    resolvedPayload.account_id_hash || resolvedPayload.account_id || resolvedPayload.accountIdHash,
    'account_id_hash'
  );
  const targetContract = resolveHash160(
    resolvedPayload.target_contract || resolvedPayload.contract || resolvedPayload.target,
    'target_contract'
  );
  const method = resolveRequiredText(resolvedPayload.method, 'method');
  const argsHash = resolveHash32(
    resolvedPayload.args_hash || resolvedPayload.argsHash || resolvedPayload.payload_hash,
    'args_hash'
  );
  const nonce = resolveUint256Text(resolvedPayload.nonce, 'nonce');
  const deadline = resolveUint256Text(resolvedPayload.deadline, 'deadline');
  const actionId = resolveZkLoginActionId(
    resolvedPayload,
    verifierContract,
    accountIdHash,
    targetContract,
    method,
    argsHash,
    nonce,
    deadline
  );
  const masterNullifier = computeMasterNullifier(provider, providerUid, saltBytes);
  const actionNullifier = computeActionNullifier(provider, providerUid, actionId, saltBytes);

  const ticket = {
    verifier_contract: verifierContract,
    account_id_hash: accountIdHash,
    target_contract: targetContract,
    method,
    args_hash: argsHash,
    nonce,
    deadline,
    provider,
    action_id: actionId,
    master_nullifier: masterNullifier,
    action_nullifier: actionNullifier,
  };
  const digestBytes = buildZkLoginDigestBytes(ticket);
  const signer = await signDigestBytes(digestBytes, resolvedPayload);
  const result = {
    verifier_contract: ticket.verifier_contract,
    account_id_hash: ticket.account_id_hash,
    target_contract: ticket.target_contract,
    method: ticket.method,
    args_hash: ticket.args_hash,
    nonce: ticket.nonce,
    deadline: ticket.deadline,
    provider: ticket.provider,
    action_id: ticket.action_id,
    master_nullifier: `0x${ticket.master_nullifier}`,
    action_nullifier: `0x${ticket.action_nullifier}`,
    digest: `0x${Buffer.from(digestBytes).toString('hex')}`,
    ...signer,
  };
  return buildNeoDidResponse('neodid_zklogin_ticket', result, resolvedPayload);
}

export function __resetNeoDidStateForTests() {
  WEB3AUTH_JWKS_CACHE.clear();
}
