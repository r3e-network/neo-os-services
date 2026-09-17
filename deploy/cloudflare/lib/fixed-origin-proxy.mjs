export const UPSTREAM_HEADER_TIMEOUT_MS = 15_000;
// The remote MCP contract permits 300-second requests before completion.
export const MCP_HEADER_TIMEOUT_MS = 310_000;

export async function proxyToOrigin(request, origin, { pathname, publicPrefix = '', headerTimeoutMs = UPSTREAM_HEADER_TIMEOUT_MS } = {}) {
  const incoming = new URL(request.url);
  const upstream = new URL(origin);
  upstream.pathname = pathname ?? incoming.pathname;
  upstream.search = incoming.search;
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('forwarded');
  headers.delete('x-forwarded-host');
  headers.delete('x-forwarded-proto');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), headerTimeoutMs);
  try {
    // Do not follow upstream redirects with a caller's bearer token or cookies.
    const response = await fetch(new Request(upstream, new Request(request, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.any([request.signal, controller.signal]),
    })));
    const responseHeaders = new Headers(response.headers);
    const location = responseHeaders.get('location');
    if (location) {
      const destination = new URL(location, upstream);
      if (destination.origin === upstream.origin) {
        destination.protocol = incoming.protocol;
        destination.host = incoming.host;
        destination.pathname = `${publicPrefix}${destination.pathname}`;
        responseHeaders.set('location', destination.href);
      }
    }
    return new Response(response.body, {
      status: response.status, statusText: response.statusText, headers: responseHeaders,
    });
  } catch {
    return Response.json({ error: controller.signal.aborted ? 'upstream_timeout' : 'upstream_unavailable' }, {
      status: controller.signal.aborted ? 504 : 502,
      headers: { 'cache-control': 'no-store' },
    });
  } finally {
    // Bound the wait for response headers without cutting off MCP SSE streams.
    clearTimeout(timeout);
  }
}
