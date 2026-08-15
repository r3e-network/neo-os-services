import { isAlreadyFulfilledError } from '../workers/morpheus-relayer/src/fulfillment.js';

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
