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
    const signature = await maybeSignNeoN3Bytes(bytes, payload);
    if (!signature) {
      return json(400, { error: 'Neo N3 signing key is not configured' });
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
