import { MCP_HEADER_TIMEOUT_MS, proxyToOrigin } from '../lib/fixed-origin-proxy.mjs';
import { runtimeNetworkRefusal } from '../lib/runtime-network.mjs';

const SERVICES = Object.freeze({
  fura: 'https://api.n3index.dev',
  mcp: 'https://mcp.n3index.dev',
  runtime: 'https://runtime.meshmini.app',
  control: 'https://control.neoos.network',
});

function catalog(origin) {
  return Response.json({
    service: 'neoos-services',
    status: 'ok',
    routes: Object.fromEntries(Object.keys(SERVICES).map(name => [name, `${origin}/${name}`])),
    policy: 'fixed-origin-prefix-routing',
  }, { headers: { 'cache-control': 'no-store' } });
}

export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    if (incoming.pathname === '/') return catalog(incoming.origin);
    const match = /^\/([^/]+)(\/.*)?$/.exec(incoming.pathname);
    const service = match?.[1] ?? '';
    const origin = Object.hasOwn(SERVICES, service) ? SERVICES[service] : null;
    if (!origin) {
      return Response.json({ error: 'unknown_service', service }, {
        status: 404,
        headers: { 'cache-control': 'no-store' },
      });
    }

    const pathname = match[2] || '/';
    const refusal = service === 'runtime' ? runtimeNetworkRefusal(pathname) : null;
    return refusal ?? proxyToOrigin(request, origin, {
      pathname, publicPrefix: `/${service}`,
      headerTimeoutMs: service === 'mcp' ? MCP_HEADER_TIMEOUT_MS : undefined,
    });
  },
};
