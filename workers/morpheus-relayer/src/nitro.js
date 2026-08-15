function resolveCandidateApiUrls(apiUrl) {
  return String(apiUrl || '')
    .split(',')
    .map((entry) => entry.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

const DEFAULT_NITRO_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_NITRO_TIMEOUT_MS = 10_000;
const ABSOLUTE_MAX_NITRO_TIMEOUT_MS = 30_000;

function decorateWorkerPayload(config, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const derivedKeysEnabled = Boolean(config.nitro?.useDerivedKeys ?? config.useDerivedKeys);
  let nextPayload = payload;

  if (
    !(
      payload.network ||
      payload.morpheus_network ||
      payload.runtime_network ||
      payload.environment
    ) &&
    config.network
  ) {
    nextPayload = { ...nextPayload, network: config.network };
  }

  if (
    derivedKeysEnabled &&
    nextPayload.use_derived_keys === undefined &&
    nextPayload.useDerivedKeys === undefined
  ) {
    nextPayload = { ...nextPayload, use_derived_keys: true };
  }

  return nextPayload;
}

export async function callNitro(config, path, payload, options = {}) {
  // options.baseUrl lets callers target a specific endpoint (e.g. the enclave
  // signer URL for /sign/payload) instead of the worker apiUrl. Falls back to
  // the worker apiUrl so existing single-endpoint deployments are unchanged.
  const candidateApiUrls = resolveCandidateApiUrls(options.baseUrl || config.nitro.apiUrl);
  if (candidateApiUrls.length === 0) {
    throw new Error('MORPHEUS_RUNTIME_URL or NITRO_API_URL is not configured');
  }
  const headers = new Headers({ 'content-type': 'application/json' });
  if (config.nitro.token) {
    headers.set('authorization', `Bearer ${config.nitro.token}`);
    // The Nitro runtime authorizes via Bearer / x-nitro-token only.
    headers.set('x-nitro-token', config.nitro.token);
  }

  const requestPayload = decorateWorkerPayload(config, payload);
  const maxTimeoutMs = Math.max(
    Math.min(
      Number(options.maxTimeoutMs || DEFAULT_MAX_NITRO_TIMEOUT_MS),
      ABSOLUTE_MAX_NITRO_TIMEOUT_MS
    ),
    DEFAULT_MAX_NITRO_TIMEOUT_MS
  );
  const timeoutMs = Math.min(
    Math.max(Number(options.timeoutMs || config.nitro.timeoutMs || DEFAULT_NITRO_TIMEOUT_MS), 1000),
    maxTimeoutMs
  );
  let lastError = null;

  const allowFallback = options.allowFallback !== false;
  const apiUrls = allowFallback ? candidateApiUrls : candidateApiUrls.slice(0, 1);

  for (const apiBaseUrl of apiUrls) {
    const controller = new AbortController();
    let timer = null;
    const timeoutError = new Error(`nitro request timed out after ${timeoutMs}ms`);
    const operation = (async () => {
      const response = await fetch(`${apiBaseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
      });
      const text = await response.text();
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { raw: text };
      }
      return { ok: response.ok, status: response.status, body, api_url: apiBaseUrl };
    })();
    // When the timeout wins the race below, controller.abort() rejects this
    // still-live fetch promise. Nothing awaits it once the race has settled, so
    // without this no-op handler it surfaces as an unhandledRejection on every
    // nitro timeout. Promise.race still observes the original `operation`.
    operation.catch(() => {});
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
    });

    try {
      return await Promise.race([operation, timeoutPromise]);
    } catch (error) {
      lastError = error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
