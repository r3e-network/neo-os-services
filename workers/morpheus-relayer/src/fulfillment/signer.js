import { buildFulfillmentDigestBytes, resolveKernelIntent } from '../router.js';
import { signNeoXFulfillment } from '../neox.js';
import { resolvePinnedNeoN3VerifierPublicKey } from '../lib/neo-signers.js';
import { custodyKeyId, custodySignRaw } from '../custody.js';
import { trimString } from '@r3e-network/neo-os-services-shared/utils';
import { normalizePublicKey } from '../attestation.js';
import {
  decodeJsonObjectPayload,
  requireRawPayloadHex,
  resolveEventPayload,
} from '../lib/payload.js';

/**
 * Fulfillment signing helpers: digest context binding, and the top-level
 * signFulfillmentPayload dispatcher. The relayer holds no key material — the
 * Neo N3 verification signature is produced by the custody signer service.
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
  const payloadFields = {
    ...(Object.prototype.hasOwnProperty.call(fulfillment, 'payloadText')
      ? { payloadText: String(fulfillment.payloadText ?? '') }
      : {}),
    ...(fulfillment.payloadHex !== undefined ? { payloadHex: fulfillment.payloadHex } : {}),
  };

  // Legacy Neo N3 requests do not carry appId and still verify against the
  // legacy digest domain.
  if (normalizedChain === 'neo_n3' && !appId) {
    return { chain: 'legacy', appId: '', moduleId: '', operation: '', ...payloadFields };
  }

  return {
    chain: normalizedChain,
    appId,
    moduleId,
    operation,
    ...payloadFields,
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

/**
 * Sign a fulfillment payload. For Neo X this delegates to the EVM signer; for
 * Neo N3 the digest is signed by the custody signer service under the
 * allow_raw oracle_verifier key, and the returned public key is checked
 * against the pinned verifier identity before the result is trusted.
 *
 * @param {object} config Relayer configuration.
 * @param {string} chain Target chain id.
 * @param {object} fulfillment Fulfillment envelope fields.
 * @returns {Promise<object>} Signature verification object.
 */
export async function signFulfillmentPayload(config, chain, fulfillment) {
  requireRawPayloadHex(fulfillment);
  decodeJsonObjectPayload(fulfillment.payloadText ?? '', {
    allowNonObject:
      resolveKernelIntent(fulfillment.requestType).moduleId === 'confidential.decrypt',
  });
  // Neo X (EVM): keccak digest + secp256k1 EIP-191 signature (ecrecover on-chain).
  if (chain === 'neox') {
    return signNeoXFulfillment(config, fulfillment);
  }
  if (chain !== 'neo_n3') {
    throw new Error(`unsupported fulfillment chain for signing: ${chain}`);
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
  const keyId = custodyKeyId(config, 'oracle_verifier');
  const expectedPublicKey = normalizePublicKey(
    resolvePinnedNeoN3VerifierPublicKey(config.network, process.env)
  );
  const signed = await custodySignRaw(config, keyId, digestBytes.toString('hex'));
  const publicKey = normalizePublicKey(signed.public_key || '');
  if (publicKey.toLowerCase() !== expectedPublicKey.toLowerCase()) {
    throw new Error(
      'custody signer returned a public key that does not match the pinned oracle_verifier'
    );
  }
  return {
    signature: signed.signature,
    public_key: publicKey,
    address: trimString(signed.address || ''),
    script_hash: trimString(signed.script_hash || ''),
    key_id: keyId,
    source: 'custody_signer',
  };
}

// Build + sign the canonical fulfillment envelope for an encoded result.
export function signEncodedFulfillment(config, event, fulfillmentContext, fulfillment) {
  return signFulfillmentPayload(config, event.chain, {
    requestId: event.requestId,
    requestType: event.requestType,
    ...fulfillmentContext,
    ...resolveEventPayload(event),
    success: fulfillment.success,
    result: fulfillment.result || '',
    result_bytes_base64: fulfillment.result_bytes_base64 || '',
    error: fulfillment.error || '',
  });
}
