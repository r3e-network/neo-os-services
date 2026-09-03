import { isAlreadyFulfilledError } from '../workers/morpheus-relayer/src/fulfillment.js';

export function allowSyntheticOracleFallback(value) {
  return ['1', 'true', 'yes', 'on'].includes(
    String(value || '')
      .trim()
      .toLowerCase()
  );
}

export function hasReceivedCallback(stackItem) {
  if (!stackItem || stackItem.type !== 'Array' || !Array.isArray(stackItem.value)) return false;
  if (stackItem.value.length < 4) return false;

  // The current callback adapter returns an eight-field empty record for an
  // unknown request. Only a positive ReceivedAt value proves delivery.
  if (stackItem.value.length >= 8) {
    try {
      return BigInt(stackItem.value[7]?.value || '0') > 0n;
    } catch {
      return false;
    }
  }

  return true;
}

export async function resolveCallbackWithLocalFallback({
  callbackTimeoutMs,
  waitForCallback,
  beforeLocalFallback,
  fulfillRequestLocally,
  onTimeout,
}) {
  try {
    return await waitForCallback(callbackTimeoutMs);
  } catch (error) {
    onTimeout?.(error);
    await beforeLocalFallback?.();
    try {
      await fulfillRequestLocally();
    } catch (fallbackError) {
      if (!isAlreadyFulfilledError(fallbackError)) {
        throw fallbackError;
      }
    }
    return await waitForCallback(callbackTimeoutMs);
  }
}
