import { proxyToOrigin } from '../lib/fixed-origin-proxy.mjs';
import { runtimeNetworkRefusal } from '../lib/runtime-network.mjs';

const ORIGIN = 'https://runtime.meshmini.app';

export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    return runtimeNetworkRefusal(incoming.pathname) ?? proxyToOrigin(request, ORIGIN);
  },
};
