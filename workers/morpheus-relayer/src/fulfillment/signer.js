import { callNitro } from '../nitro.js';
import { buildFulfillmentDigestBytes } from '../router.js';
import { signNeoXFulfillment } from '../neox.js';
import { reportPinnedNeoN3Role, resolvePinnedNeoN3VerifierPublicKey } from '../lib/neo-signers.js';
import { wallet as neonWallet } from '@cityofzion/neon-js';
import { trimString } from '@r3e-network/neo-os-services-shared/utils';
import { normalizePublicKey } from '../attestation.js';

/**
 * Fulfillment signing helpers: local Neo N3 verifier derivation, digest context
 * binding, and the top-level signFulfillmentPayload dispatcher.
 */

/**
 * Resolve the canonical signing context for a fulfillment. Identifiers are
 * passed through verbatim because the on-chain digest hashes the stored bytes
 * exactly as written.
 *
 * @param {string} chain Target chain id.
 * @param {object} fulfillment Fulfillment envelope fields.
 * @returns {{chain:string,appId:string,moduleId:string,operation:string}}
 */
export function resolveFulfillmentSigningContext(chain, fulfillment = {}) {
  const normalizedChain = trimString(chain || '') || 'neo_n3';
  const appId = String(fulfillment.appId ?? '');
  const moduleId = String(fulfillment.moduleId ?? '');
  const operation = String(fulfillment.operation ?? '');

  // Legacy Neo N3 requests do not carry appId and still verify against the
  // legacy digest domain.
  if (normalizedChain === 'neo_n3' && !appId) {
    return { chain: 'legacy', appId: '', moduleId: '', operation: '' };
  }

  return {
    chain: normalizedChain,
    appId,
    moduleId,
    operation,
  };
}

/**
 * Resolve the fulfillment context for an event, falling back to the kernel-intent
 * mapping only for genuinely absent identifier fields.
 *
 * @param {object} event On-chain request event.
 * @param {object} kernelIntent Resolved kernel intent.
 * @returns {{appId:string,moduleId:string,operation:string}}
 */
export function resolveEventFulfillmentContext(event = {}, kernelIntent = {}) {
  return {
    appId: String(event.appId ?? ''),
    moduleId: String(event.moduleId ?? '') || String(kernelIntent.moduleId ?? ''),
    operation: String(event.operation ?? '') || String(kernelIntent.operation ?? ''),
  };
}

/**
 * Resolve the digest-binding context fed to buildFulfillmentDigestBytes. Single
 * source of truth so the signing and independent recomputation paths agree
 * byte-for-byte. Binds Neo N3 digests to contractScriptHash + networkMagic for
 * cross-deployment/replay defense.
 *
 * @param {object} config Relayer configuration.
 * @param {string} chain Target chain id.
 * @param {object} fulfillment Fulfillment envelope fields.
 * @returns {object} Digest context.
 */
export function resolveDigestBinding(config, chain, fulfillment) {
  const digestContext = resolveFulfillmentSigningContext(chain, fulfillment);
  if (chain === 'neo_n3') {
    digestContext.contractScriptHash = config?.neo_n3?.oracleContract || '';
    digestContext.networkMagic = config?.neo_n3?.networkMagic;
  }
  return digestContext;
}

function buildLocalNeoN3Account(keyMaterial = '') {
  const raw = trimString(keyMaterial);
  if (!raw) return null;
  try {
    return new neonWallet.Account(raw);
  } catch {
    return null;
  }
}

const localVerifierAccountCache = new Map();

function resolveLocalVerifierAccount(config) {
  const expectedPublicKey = normalizePublicKey(
    resolvePinnedNeoN3VerifierPublicKey(config.network, process.env)
  );
  const cacheKey = `${config.network || ''}:${expectedPublicKey}`;
  const cached = localVerifierAccountCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const candidates = [];

  const explicitVerifier = reportPinnedNeoN3Role(config.network, 'oracle_verifier', {
    env: process.env,
    allowMissing: true,
  }).materialized;
  if (explicitVerifier?.private_key)
    candidates.push(buildLocalNeoN3Account(explicitVerifier.private_key));
  if (explicitVerifier?.wif) candidates.push(buildLocalNeoN3Account(explicitVerifier.wif));
  if (config?.neo_n3?.updaterPrivateKey)
    candidates.push(buildLocalNeoN3Account(config.neo_n3.updaterPrivateKey));
  if (config?.neo_n3?.updaterWif) candidates.push(buildLocalNeoN3Account(config.neo_n3.updaterWif));

  const workerSigner = reportPinnedNeoN3Role(config.network, 'worker', {
    env: process.env,
    allowMissing: true,
  }).materialized;
  if (workerSigner?.private_key) candidates.push(buildLocalNeoN3Account(workerSigner.private_key));
  if (workerSigner?.wif) candidates.push(buildLocalNeoN3Account(workerSigner.wif));

  const resolved =
    candidates.find(
      (account) => account && normalizePublicKey(account.publicKey) === expectedPublicKey
    ) || null;
  localVerifierAccountCache.set(cacheKey, resolved);
  return resolved;
}

/**
 * Test-only: clear the local-verifier memo so tests that vary env/config.network
 * get a fresh resolution.
 */
export function resetLocalVerifierCacheForTests() {
  localVerifierAccountCache.clear();
}

/**
 * Test-only: expose the resolver so the memoization contract can be asserted
 * directly.
 *
 * @param {object} config Relayer configuration.
 * @returns {object|null}
 */
export function resolveLocalVerifierAccountForTests(config) {
  return resolveLocalVerifierAccount(config);
}

/**
 * Sign a fulfillment payload. For Neo X this delegates to the EVM signer; for
 * Neo N3 it first tries a local verifier account and falls back to the Nitro
 * enclave signing endpoint.
 *
 * @param {object} config Relayer configuration.
 * @param {string} chain Target chain id.
 * @param {object} fulfillment Fulfillment envelope fields.
 * @returns {Promise<object>} Signature verification object.
 */
export async function signFulfillmentPayload(config, chain, fulfillment) {
  // Neo X (EVM): keccak digest + secp256k1 EIP-191 signature (ecrecover on-chain).
  if (chain === 'neox') {
    return signNeoXFulfillment(config, fulfillment);
  }
  // Bind the digest to the exact deployed contract + network so the signature
  // cannot be replayed across deployments/networks.
  const digestContext = resolveDigestBinding(config, chain, fulfillment);
  const digestBytes = buildFulfillmentDigestBytes(
    fulfillment.requestId,
    fulfillment.requestType,
    fulfillment.success,
    fulfillment.result,
    fulfillment.error,
    fulfillment.result_bytes_base64 || '',
    digestContext
  );
  if (chain === 'neo_n3') {
    const localVerifier = resolveLocalVerifierAccount(config);
    if (localVerifier) {
      return {
        signature: neonWallet.sign(digestBytes.toString('hex'), localVerifier.privateKey),
        public_key: localVerifier.publicKey,
        address: localVerifier.address,
        script_hash: `0x${localVerifier.scriptHash}`,
        source: 'relayer_local',
      };
    }
  }
  const response = await callNitro(
    config,
    '/sign/payload',
    {
      target_chain: chain,
      key_role: 'oracle_verifier',
      data_hex: digestBytes.toString('hex'),
    },
    { baseUrl: config.nitro.signerUrl }
  );
  if (!response.ok || typeof response.body?.signature !== 'string' || !response.body.signature) {
    throw new Error(
      typeof response.body?.error === 'string'
        ? response.body.error
        : `worker signing failed with status ${response.status}`
    );
  }
  return response.body;
}

// Build + sign the canonical fulfillment envelope for an encoded result.
export function signEncodedFulfillment(config, event, fulfillmentContext, fulfillment) {
  return signFulfillmentPayload(config, event.chain, {
    requestId: event.requestId,
    requestType: event.requestType,
    ...fulfillmentContext,
    success: fulfillment.success,
    result: fulfillment.result || '',
    result_bytes_base64: fulfillment.result_bytes_base64 || '',
    error: fulfillment.error || '',
  });
}
