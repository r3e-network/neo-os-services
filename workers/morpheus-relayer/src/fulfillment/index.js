// Fulfillment module barrel.
//
// The original workers/morpheus-relayer/src/fulfillment.js has been split into
// focused sub-modules:
//   - classifier.js   : error classification helpers
//   - signer.js       : local signer and digest context binding
//   - enclave.js      : compute-in-enclave fulfillment path
//   - delivery.js     : prepared fulfillment records and on-chain delivery
//   - dispatch.js     : retry / delivery coordination helpers
//   - executor.js     : lane selection, worker invocation, prepare/deliver entry points
//   - coordinator.js  : processEvent dispatcher
//
// This file re-exports the full public API so existing importers can continue
// to resolve symbols from ./fulfillment/index.js (or the compatibility barrel
// at ../fulfillment.js).

export {
  buildTransientWorkerError,
  classifyError,
  isAlreadyFulfilledError,
  isTerminalConfigurationError,
  isTransientWorkerStatus,
  trimOnchainErrorMessage,
} from './classifier.js';

export {
  buildDecryptBindingRequest,
  buildPreparedFulfillmentRetryMeta,
  enrichAutomationExecutionPayload,
  findWhitespaceIdentifier,
  finalizeFailedRequest,
  isQueuedAutomationExecutionPayload,
  processOracleRequest,
  resolveEventFulfillmentContext,
  resolveExpectedPcr0,
  resolveFulfillmentSigningContext,
  resolveNitroRootCertPem,
  signFulfillmentPayload,
  verifyEnclaveAttestation,
  verifyEnclaveSignatureAgainstPinnedVerifier,
} from './executor.js';

export { processEvent, resolveCallbackRetryCeiling } from './coordinator.js';

// Re-exported from the canonical implementation in ../lib/retry.js so consumers
// that historically resolved computeRetryDelayMs from the fulfillment barrel
// keep working.
export { computeRetryDelayMs } from '../lib/retry.js';

// Re-exported from the canonical implementation in ../feed-sync.js for consumers
// that historically resolved normalizeErrorMessage from the fulfillment barrel.
export { normalizeErrorMessage } from '../feed-sync.js';
