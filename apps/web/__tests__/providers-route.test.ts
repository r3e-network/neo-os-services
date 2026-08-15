import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('providers route', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('MORPHEUS_NETWORK', 'mainnet');
    vi.stubEnv('MORPHEUS_RUNTIME_URL_TESTNET', 'https://testnet-runtime.example');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('serves the static built-in provider catalog without proxying the runtime', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('../app/api/providers/route');
    const response = await GET(new Request('https://example.test/api/providers?network=testnet'));

    expect(response.status).toBe(200);
    // Re-homed: no runtime proxy — the list is served statically.
    expect(fetchMock).not.toHaveBeenCalled();
    const body = await response.json();
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers.map((p: { id: string }) => p.id)).toEqual([
      'twelvedata',
      'binance-spot',
      'coinbase-spot',
    ]);
  });

  it('rejects unknown network query params with 400 before proxying upstream', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('../app/api/providers/route');
    const response = await GET(new Request('https://example.test/api/providers?network=banana'));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('unknown network');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
