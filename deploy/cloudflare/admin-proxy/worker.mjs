import { proxyToOrigin } from '../lib/fixed-origin-proxy.mjs';

const ORIGIN = 'https://admin.neomini.app';

export default {
  async fetch(request) {
    const response = await proxyToOrigin(request, ORIGIN);
    const headers = new Headers(response.headers);
    // Preserve separate Set-Cookie fields, including Expires commas. The app
    // owns canonical OIDC URLs; nested external redirect parameters are opaque.
    const cookies = headers.getSetCookie();
    if (cookies.length) {
      headers.delete('set-cookie');
      for (const cookie of cookies) {
        headers.append(
          'set-cookie',
          cookie.replace(/;\s*domain=\.?admin\.neomini\.app(?=;|$)/gi, '')
        );
      }
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
