import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

describe('GET /api/cron/feed', () => {
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
