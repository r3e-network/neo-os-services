import { MCP_HEADER_TIMEOUT_MS, proxyToOrigin } from '../lib/fixed-origin-proxy.mjs';

const ORIGIN = 'https://mcp.n3index.dev';

export default {
  async fetch(request) {
    return proxyToOrigin(request, ORIGIN, { headerTimeoutMs: MCP_HEADER_TIMEOUT_MS });
  },
};
