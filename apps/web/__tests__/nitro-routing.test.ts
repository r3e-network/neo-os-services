import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appConfig: {
    selectedNetworkKey: 'testnet',
    nitroApiUrl: 'https://confidential.test',
    nitroApiUrls: ['https://confidential.test'],
    publicNitroApiUrls: [
      'https://confidential.test',
      'https://oracle.meshmini.app/testnet',
      'https://edge.meshmini.app/testnet',
    ],
    nitroToken: 'runtime-token',
  },
  recordOperationLog: vi.fn(),
}));

vi.mock('../lib/config', () => ({ appConfig: mocks.appConfig }));
vi.mock('../lib/operation-logs', () => ({ recordOperationLog: mocks.recordOperationLog }));

import { proxyToNitro } from '../lib/nitro';

describe('production Nitro routing', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    mocks.recordOperationLog.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('tries only the explicit primary for confidential requests', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('primary unavailable'));
    vi.stubGlobal('fetch', fetchMock);

    const response = await proxyToNitro(
      '/oracle/query',
      { method: 'POST', body: '{}' },
      { route: '/api/oracle/query', category: 'oracle' }
    );

    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://confidential.test/oracle/query');
  });

  it('retains explicit fallback for a non-confidential catalog request', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('primary unavailable'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ functions: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const response = await proxyToNitro(
      '/compute/functions',
      {
        headers: {
          authorization: 'Bearer inbound-token',
          'x-nitro-token': 'inbound-token',
        },
      },
      {
        route: '/api/compute/functions',
        category: 'compute',
        confidential: false,
      }
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://confidential.test/compute/functions',
      'https://oracle.meshmini.app/testnet/compute/functions',
    ]);
    const primaryHeaders = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(primaryHeaders.get('authorization')).toBe('Bearer runtime-token');
    expect(primaryHeaders.get('x-nitro-token')).toBe('runtime-token');
    const fallbackHeaders = new Headers(fetchMock.mock.calls[1][1]?.headers);
    expect(fallbackHeaders.get('authorization')).toBeNull();
    expect(fallbackHeaders.get('x-nitro-token')).toBeNull();
  });
});
