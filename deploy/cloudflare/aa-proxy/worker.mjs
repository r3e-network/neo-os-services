import { proxyToOrigin } from '../lib/fixed-origin-proxy.mjs';

const ORIGIN = 'https://neoos-aa-frontend.vercel.app';

export default {
  async fetch(request) {
    return proxyToOrigin(request, ORIGIN);
  },
};
