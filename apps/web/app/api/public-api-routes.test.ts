import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRateLimitMap } from '@/lib/rate-limit';

// `server-only` throws in non-Next.js runtimes; Vitest needs it stubbed to
// exercise the routes that depend on server-only modules (e.g. neodid-did).
vi.mock('server-only', () => ({}));

const AUTH_TOKEN = 'test-runtime-token';

function authHeaders() {
  return { authorization: `Bearer ${AUTH_TOKEN}` };
}

function publicIpHeaders(ip: string) {
  return { 'x-forwarded-for': ip };
}

// The route/lib modules imported below reach lib/config, which resolves the
// Morpheus network at module-evaluation time. Pin it here instead of relying on
// the ambient shell so this file is hermetic: identical behaviour with no env
// at all (CI) and with MORPHEUS_NETWORK or NEXT_PUBLIC_MORPHEUS_NETWORK
// exported to either value. Assigned directly rather than via vi.stubEnv
// because this file's vi.unstubAllEnvs() would otherwise drop it before the
// dynamic imports run.
const originalNetworkEnv = {
  MORPHEUS_NETWORK: process.env.MORPHEUS_NETWORK,
  NEXT_PUBLIC_MORPHEUS_NETWORK: process.env.NEXT_PUBLIC_MORPHEUS_NETWORK,
};

describe('public API routes', () => {
  beforeAll(() => {
    process.env.MORPHEUS_NETWORK = 'testnet';
    process.env.NEXT_PUBLIC_MORPHEUS_NETWORK = 'testnet';
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(originalNetworkEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetRateLimitMap();
    vi.stubEnv('MORPHEUS_RUNTIME_TOKEN', AUTH_TOKEN);
  });

  describe('/api/workflows', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const { GET } = await import('./workflows/route');
      const response = await GET(new Request('http://localhost/api/workflows'));
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
    });

    it('rejects unexpected query parameters with 400', async () => {
      const { GET } = await import('./workflows/route');
      const response = await GET(
        new Request('http://localhost/api/workflows?foo=bar', { headers: authHeaders() })
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'invalid query parameters' });
    });

    it('returns the catalog for authenticated requests', async () => {
      const { GET } = await import('./workflows/route');
      const response = await GET(
        new Request('http://localhost/api/workflows', { headers: authHeaders() })
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty('envelope');
      expect(body).toHaveProperty('workflows');
    });

    it('includes rate-limit headers', async () => {
      const { GET } = await import('./workflows/route');
      const response = await GET(
        new Request('http://localhost/api/workflows', { headers: authHeaders() })
      );
      expect(response.headers.get('X-RateLimit-Limit')).toBe('60');
      expect(response.headers.get('X-RateLimit-Remaining')).not.toBeNull();
    });
  });

  describe('/api/policies', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const { GET } = await import('./policies/route');
      const response = await GET(new Request('http://localhost/api/policies'));
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
    });

    it('rejects unexpected query parameters with 400', async () => {
      const { GET } = await import('./policies/route');
      const response = await GET(
        new Request('http://localhost/api/policies?foo=bar', { headers: authHeaders() })
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'invalid query parameters' });
    });

    it('returns the policy catalog for authenticated requests', async () => {
      const { GET } = await import('./policies/route');
      const response = await GET(
        new Request('http://localhost/api/policies', { headers: authHeaders() })
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty('envelope');
      expect(body).toHaveProperty('policies');
    });
  });

  describe('/api/networks', () => {
    it('allows unauthenticated requests', async () => {
      const { GET } = await import('./networks/route');
      const response = await GET(new Request('http://localhost/api/networks'));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty('selected');
      expect(body).toHaveProperty('available');
    });

    it('rejects unexpected query parameters with 400', async () => {
      const { GET } = await import('./networks/route');
      const response = await GET(new Request('http://localhost/api/networks?foo=bar'));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'invalid query parameters' });
    });

    it('returns rate-limit headers even when public', async () => {
      const { GET } = await import('./networks/route');
      const response = await GET(new Request('http://localhost/api/networks'));
      expect(response.headers.get('X-RateLimit-Limit')).toBe('60');
    });
  });

  describe('/api/neodid/resolve', () => {
    beforeEach(() => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
      );
    });

    it('rejects unauthenticated requests with 401', async () => {
      const { GET } = await import('./neodid/resolve/route');
      const response = await GET(
        new Request('http://localhost/api/neodid/resolve?did=did:morpheus:neo_n3:service:neodid')
      );
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
    });

    it('rejects invalid DID format with 400', async () => {
      const { GET } = await import('./neodid/resolve/route');
      const response = await GET(
        new Request('http://localhost/api/neodid/resolve?did=not-a-did', { headers: authHeaders() })
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'invalid query parameters' });
    });

    it('rejects unsupported format value with 400', async () => {
      const { GET } = await import('./neodid/resolve/route');
      const response = await GET(
        new Request(
          'http://localhost/api/neodid/resolve?did=did:morpheus:neo_n3:service:neodid&format=xml',
          { headers: authHeaders() }
        )
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'invalid query parameters' });
    });

    it('resolves a valid service DID for authenticated requests', async () => {
      const { GET } = await import('./neodid/resolve/route');
      const response = await GET(
        new Request('http://localhost/api/neodid/resolve?did=did:morpheus:neo_n3:service:neodid', {
          headers: authHeaders(),
        })
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty('didResolutionMetadata');
      expect(body).toHaveProperty('didDocument');
    });
  });

  describe('rate limiting', () => {
    it('returns 429 after exceeding the per-route limit', async () => {
      const { GET } = await import('./workflows/route');
      const ip = '1.2.3.4';
      const url = 'http://localhost/api/workflows';
      const headers = { ...authHeaders(), ...publicIpHeaders(ip) };

      let lastResponse: Response | null = null;
      for (let i = 0; i < 61; i++) {
        lastResponse = await GET(new Request(url, { headers }));
      }
      expect(lastResponse).not.toBeNull();
      expect(lastResponse!.status).toBe(429);
      await expect(lastResponse!.json()).resolves.toEqual(
        expect.objectContaining({ error: 'Too many requests' })
      );
    });
  });
});
