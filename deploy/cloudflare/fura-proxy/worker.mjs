import { proxyToOrigin } from '../lib/fixed-origin-proxy.mjs';

const ORIGIN = 'https://api.n3index.dev';

export default {
  async fetch(request) {
    return proxyToOrigin(request, ORIGIN);
  },
};
