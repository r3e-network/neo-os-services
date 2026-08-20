import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function b64(text: string) {
  return Buffer.from(text, 'utf8').toString('base64');
}

// A fixed "now" (a Wednesday, so no TradFi weekend widening applies) plus a
// record timestamp expressed relative to it. Before 2026-08 this file pinned an
// absolute, long-past timestamp and asserted `status: 'ok'` against it — the
// test itself encoded the missing freshness check, which is part of why the
// 19-day mainnet outage was invisible.
const NOW_MS = Date.UTC(2026, 7, 12, 12, 0, 0);
const NOW_SEC = Math.floor(NOW_MS / 1000);

// A getAllFeedRecords stack: one NEO-USD record (6dp price = 2.287).
function recordsStack(timestamp: number = NOW_SEC - 60) {
  return {
    type: 'Array',
    value: [
      {
        type: 'Struct',
        value: [
          { type: 'ByteString', value: b64('TWELVEDATA:NEO-USD') },
          { type: 'Integer', value: '42' },
          { type: 'Integer', value: '2287000' },
          { type: 'Integer', value: String(timestamp) },
          { type: 'ByteString', value: b64('') },
          { type: 'Integer', value: '0' },
        ],
      },
    ],
  };
}

// Mock the Neo RPC: getAllFeedRecords returns the record array; other reads (fees,
// keys, etc.) return a benign integer the route ignores.
function neoRpcMock(timestamp?: number) {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    const method = body?.params?.[1];
    const stack =
      method === 'getAllFeedRecords'
        ? [recordsStack(timestamp)]
        : [{ type: 'Integer', value: '0' }];
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
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
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
    expect(response.headers.get('x-morpheus-feed-stale')).toBe('0');
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      symbol: 'TWELVEDATA:NEO-USD',
      source: 'onchain',
      chain: 'neo_n3',
      price: 2.287,
      provider: 'twelvedata',
      stale: false,
      age_seconds: 60,
      stale_after_seconds: 2700,
    });
  });

  // The regression. On 2026-08-17 every mainnet pair was ~19 days old and this
  // route still answered `status:"ok"` with `cache-control: public, max-age=15`.
  it('refuses to serve a record past its staleness budget as ok', async () => {
    vi.stubGlobal('fetch', neoRpcMock(NOW_SEC - 1_652_577));

    const { GET } = await import('../app/api/feeds/[symbol]/route');
    const response = await GET(new Request('https://example.test/api/feeds/TWELVEDATA%3ANEO-USD'), {
      params: Promise.resolve({ symbol: 'TWELVEDATA:NEO-USD' }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-morpheus-upstream-status')).toBe('503');
    expect(response.headers.get('x-morpheus-feed-stale')).toBe('1');
    expect(response.headers.get('x-morpheus-feed-age-seconds')).toBe('1652577');

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: 'stale',
      degraded: true,
      error: 'feed_quote_stale',
      error_code: 'FEED_QUOTE_STALE',
      age_seconds: 1652577,
      stale_after_seconds: 2700,
    });
    // No top-level price: a consumer reading body.price without checking
    // body.status must NOT silently receive a 19-day-old quote.
    expect(body.price).toBeUndefined();
    expect((body.stale_record as Record<string, unknown>).price).toBe(2.287);
  });

  it('treats a record one second past the budget as stale and one at it as ok', async () => {
    vi.stubGlobal('fetch', neoRpcMock(NOW_SEC - 2701));
    const stale = await (
      await import('../app/api/feeds/[symbol]/route')
    ).GET(new Request('https://example.test/api/feeds/TWELVEDATA%3ANEO-USD'), {
      params: Promise.resolve({ symbol: 'TWELVEDATA:NEO-USD' }),
    });
    await expect(stale.json()).resolves.toMatchObject({ status: 'stale' });

    vi.resetModules();
    vi.stubGlobal('fetch', neoRpcMock(NOW_SEC - 2700));
    const ok = await (
      await import('../app/api/feeds/[symbol]/route')
    ).GET(new Request('https://example.test/api/feeds/TWELVEDATA%3ANEO-USD'), {
      params: Promise.resolve({ symbol: 'TWELVEDATA:NEO-USD' }),
    });
    await expect(ok.json()).resolves.toMatchObject({ status: 'ok' });
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
