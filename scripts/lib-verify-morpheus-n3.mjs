import { trimString } from './lib-strings.mjs';
function firstNonEmpty(values) {
  for (const value of values) {
    const trimmed = trimString(value);
    if (trimmed) return trimmed;
  }
  return '';
}

export function snapshotEnv(keys, env = process.env) {
  const snapshot = {};
  for (const key of keys) {
    const value = trimString(env[key]);
    if (value) snapshot[key] = value;
  }
  return snapshot;
}

export function resolveNetworkScopedValue({
  network,
  explicitEnv = {},
  selectedEnv = {},
  loadedEnv = process.env,
  genericKey,
  mainnetKey,
  testnetKey,
  registryValue = '',
}) {
  const networkKey = network === 'mainnet' ? mainnetKey : testnetKey;
  return firstNonEmpty([
    explicitEnv[networkKey],
    explicitEnv[genericKey],
    selectedEnv[networkKey],
    selectedEnv[genericKey],
    registryValue,
    loadedEnv[networkKey],
    loadedEnv[genericKey],
  ]);
}

export function detectMorpheusOracleInterface(methods) {
  const methodSet = methods instanceof Set ? methods : new Set(methods || []);
  const supportsMiniAppRuntime =
    methodSet.has('submitMiniAppRequest/4') ||
    methodSet.has('submitMiniAppRequestFromIntegration/5') ||
    methodSet.has('getMiniAppCount/0');
  const supportsLegacyCallbackAllowlist =
    methodSet.has('isAllowedCallback/1') ||
    methodSet.has('addAllowedCallback/1') ||
    methodSet.has('removeAllowedCallback/1');

  if (supportsMiniAppRuntime) return 'miniapp_runtime';
  if (supportsLegacyCallbackAllowlist) return 'legacy_callback';
  return 'unknown';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Transient RPC failures (gateway/connectivity) that warrant a retry, vs a
// deterministic error that would fail the same way on every attempt. Private —
// only withRetries (below) consumes it; callers use withRetries directly.
function isTransientRpcError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP code 502|HTTP code 503|HTTP code 504|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i.test(
    message
  );
}

// Retry `task` up to `attempts` times on transient RPC errors with linear backoff.
export async function withRetries(label, task, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (!isTransientRpcError(error) || attempt === attempts) break;
      await sleep(1000 * attempt);
    }
  }
  throw new Error(
    `${label} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}
