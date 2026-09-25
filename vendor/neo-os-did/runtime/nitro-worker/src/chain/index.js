import { json, normalizeTargetChain, sha256Hex } from '../platform/core.js';
import { resolveSigningBytes, maybeSignNeoN3Bytes } from './signing.js';
import {
  relayNeoN3Invocation,
  sponsorNeoN3Transaction,
  broadcastNeoN3RawTransaction,
} from './neo-n3.js';

export {
  buildSignedResultEnvelope,
  buildVerificationEnvelope,
  buildLaneSignedEnvelope,
  custodySignBytes,
  rejectCallerSuppliedSigningKey,
} from './signing.js';
export {
  loadNeoN3Context,
  relayNeoN3Invocation,
  sponsorNeoN3Transaction,
  broadcastNeoN3RawTransaction,
} from './neo-n3.js';
export { normalizeNeoHash160, isConfiguredHash160 } from '../platform/allowlist.js';

export async function handleSignPayload(payload) {
  const targetChain = normalizeTargetChain(payload.target_chain);
  if (targetChain === 'neo_n3') {
    const { bytes, source } = resolveSigningBytes(payload);
    let signature;
    try {
      signature = await maybeSignNeoN3Bytes(bytes, payload);
    } catch (error) {
      // The lane is custody-only (no local key fallback), so provisioning gaps
      // and enclave refusals surface as their mapped status, not a 500.
      if (Number(error?.status) > 0) {
        return json(Number(error.status), { error: String(error?.message || error) });
      }
      throw error;
    }
    return json(200, {
      target_chain: 'neo_n3',
      source,
      payload_hash: sha256Hex(bytes),
      signature: signature.signature,
      public_key: signature.public_key,
      address: signature.address,
      script_hash: signature.script_hash,
    });
  }

  return json(400, { error: 'unsupported target_chain' });
}

export async function handleRelayTransaction(payload) {
  const targetChain = normalizeTargetChain(payload.target_chain);
  if (targetChain !== 'neo_n3') return json(400, { error: 'unsupported target_chain' });

  if ((payload.tx_base64 || payload.txBase64) && (payload.user_address || payload.userAddress)) {
    return json(200, await sponsorNeoN3Transaction(payload));
  }

  if (
    payload.raw_transaction ||
    payload.raw_tx ||
    payload.signed_tx ||
    payload.tx_base64 ||
    payload.tx_hex
  ) {
    return json(200, await broadcastNeoN3RawTransaction(payload));
  }

  const invokeResult = await relayNeoN3Invocation(payload);
  return json(invokeResult.status, invokeResult.body);
}

export async function handleTxProxyInvoke(payload) {
  const invokeResult = await relayNeoN3Invocation(payload);
  return json(invokeResult.status, invokeResult.body);
}
