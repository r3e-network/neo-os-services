import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function b64(text: string) {
  return Buffer.from(text, 'utf8').toString('base64');
}

// A getAllFeedRecords stack: one NEO-USD record (6dp price = 2.287).
function recordsStack() {
  return {
    type: 'Array',
    value: [
      {
        type: 'Struct',
        value: [
          { type: 'ByteString', value: b64('TWELVEDATA:NEO-USD') },
          { type: 'Integer', value: '42' },
          { type: 'Integer', value: '2287000' },
          { type: 'Integer', value: '1781523281' },
          { type: 'ByteString', value: b64('') },
          { type: 'Integer', value: '0' },
        ],
      },
    ],
  };
}

// Mock the Neo RPC: getAllFeedRecords returns the record array; other reads (fees,
// keys, etc.) return a benign integer the route ignores.
function neoRpcMock() {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    const method = body?.params?.[1];
    const stack =
      method === 'getAllFeedRecords' ? [recordsStack()] : [{ type: 'Integer', value: '0' }];
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { state: 'HALT', stack } }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }
    );
  });
}

describe('feed price route (on-chain re-home)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('MORPHEUS_NETWORK', 'mainnet');
    vi.stubEnv('MORPHEUS_FEED_PROVIDER', 'twelvedata');
    vi.stubEnv('MORPHEUS_FEED_PROJECT_SLUG', 'morpheus');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('serves the live price from the on-chain datafeed', async () => {
    vi.stubGlobal('fetch', neoRpcMock());

    const { GET } = await import('../app/api/feeds/[symbol]/route');
    const response = await GET(new Request('https://example.test/api/feeds/TWELVEDATA%3ANEO-USD'), {
      params: Promise.resolve({ symbol: 'TWELVEDATA:NEO-USD' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      symbol: 'TWELVEDATA:NEO-USD',
      source: 'onchain',
      chain: 'neo_n3',
      price: 2.287,
      provider: 'twelvedata',
    });
  });

  it('serves a degraded 200 envelope when every RPC candidate fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'bad gateway' }), { status: 502 }))
    );

    const { GET } = await import('../app/api/feeds/[symbol]/route');
    const response = await GET(new Request('https://example.test/api/feeds/TWELVEDATA%3ANEO-USD'), {
      params: Promise.resolve({ symbol: 'TWELVEDATA:NEO-USD' }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-morpheus-upstream-status')).toBe('503');
    await expect(response.json()).resolves.toMatchObject({
      status: 'unavailable',
      degraded: true,
      symbol: 'TWELVEDATA:NEO-USD',
      provider: 'twelvedata',
      error: 'feed_quote_unavailable',
    });
  });

  it('serves a degraded 200 envelope for a symbol absent from the datafeed', async () => {
    vi.stubGlobal('fetch', neoRpcMock());

    const { GET } = await import('../app/api/feeds/[symbol]/route');
    const response = await GET(
      new Request('https://example.test/api/feeds/TWELVEDATA%3ADOGE-USD'),
      {
        params: Promise.resolve({ symbol: 'TWELVEDATA:DOGE-USD' }),
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'unavailable',
      degraded: true,
      symbol: 'TWELVEDATA:DOGE-USD',
      error: 'feed_quote_unavailable',
    });
  });
});
