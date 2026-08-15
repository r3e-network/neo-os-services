import { wallet } from '@cityofzion/neon-js';
import { buildFulfillmentDigestBytes } from '../workers/morpheus-relayer/src/router.js';
import { trimString } from './lib-strings.mjs';

export function resolveFulfillmentSigningContext({ requestRecord, defaultChain = 'neo_n3' } = {}) {
  const record = requestRecord && typeof requestRecord === 'object' ? requestRecord : null;
  if (!record) {
    return { chain: defaultChain };
  }

  const appId = trimString(record?.app_id || record?.appId || '');
  const moduleId = trimString(record?.module_id || record?.moduleId || '');
  const operation = trimString(
    record?.operation || record?.request_type || record?.requestType || ''
  );

  if (appId || moduleId) {
    return {
      chain: defaultChain,
      appId,
      moduleId,
      operation,
    };
  }

  return { chain: 'legacy' };
}

export function buildFulfillmentDigestHex({
  requestId,
  requestType,
  success = true,
  resultText = '',
  errorText = '',
  resultBytesBase64 = '',
  chain = 'neo_n3',
  appId = '',
  moduleId = '',
  operation = '',
} = {}) {
  return buildFulfillmentDigestBytes(
    requestId,
    requestType,
    success,
    resultText,
    errorText,
    resultBytesBase64,
    {
      chain,
      appId,
      moduleId,
      operation,
    }
  ).toString('hex');
}

export function buildFulfillmentVerificationSignature({
  requestId,
  requestType,
  success = true,
  resultText = '',
  errorText = '',
  resultBytesBase64 = '',
  signerPrivateKey,
  chain = 'neo_n3',
  appId = '',
  moduleId = '',
  operation = '',
} = {}) {
  if (!signerPrivateKey) {
    throw new Error('signerPrivateKey is required');
  }
  const digestHex = buildFulfillmentDigestHex({
    requestId,
    requestType,
    success,
    resultText,
    errorText,
    resultBytesBase64,
    chain,
    appId,
    moduleId,
    operation,
  });
  return wallet.sign(digestHex, signerPrivateKey);
}
