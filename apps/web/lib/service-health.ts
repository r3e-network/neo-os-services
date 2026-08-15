// Body-level health inspection for the status page. Several API routes answer
// HTTP 200 while carrying an explicit failure payload (ok:false, error
// strings, chain-read failures, degraded flags), so response.ok alone
// overstates service health.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function getServiceProblemDetail(body: unknown): string | null {
  if (!isPlainObject(body)) {
    return null;
  }

  const nestedChainError = isPlainObject(body.neo_n3) ? readString(body.neo_n3.error) : null;
  const error = readString(body.error) || nestedChainError;
  if (body.ok === false) {
    return error || 'service reported ok: false';
  }
  if (error) {
    return error;
  }
  if (body.degraded === true) {
    return readString(body.reason) || 'service reported degraded: true';
  }
  const status = (readString(body.status) || '').toLowerCase();
  if (['error', 'failed', 'down', 'unhealthy'].includes(status)) {
    return `service status: ${status}`;
  }
  return null;
}
