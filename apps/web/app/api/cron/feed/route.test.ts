import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

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

describe('GET /api/cron/feed', () => {
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
    vi.stubEnv('NODE_ENV', ORIGINAL_NODE_ENV ?? '');
    vi.stubEnv('CRON_SECRET', '');
    vi.stubEnv('MORPHEUS_CRON_SECRET', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns generic Unauthorized response without env details', async () => {
    vi.stubEnv('NODE_ENV', '');
    vi.stubEnv('CRON_SECRET', '');
    vi.stubEnv('MORPHEUS_CRON_SECRET', '');

    const { GET } = await import('./route');
    const request = new Request('http://localhost/api/cron/feed', {
      headers: { 'user-agent': 'curl/8.0' },
    });

    const response = await GET(request);
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body).toEqual({ error: 'Unauthorized' });
    expect(Object.keys(body)).toEqual(['error']);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
