import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchBoxHealth,
  resolveBoxHealthUrl,
  resolveRuntimeRequestNetwork,
} from './runtime-health';

const originalMainnetUrl = process.env.MORPHEUS_BOX_HEALTH_URL_MAINNET;
const originalTestnetUrl = process.env.MORPHEUS_BOX_HEALTH_URL_TESTNET;
const originalSharedUrl = process.env.MORPHEUS_BOX_HEALTH_URL;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalMainnetUrl === undefined) delete process.env.MORPHEUS_BOX_HEALTH_URL_MAINNET;
  else process.env.MORPHEUS_BOX_HEALTH_URL_MAINNET = originalMainnetUrl;
  if (originalTestnetUrl === undefined) delete process.env.MORPHEUS_BOX_HEALTH_URL_TESTNET;
  else process.env.MORPHEUS_BOX_HEALTH_URL_TESTNET = originalTestnetUrl;
  if (originalSharedUrl === undefined) delete process.env.MORPHEUS_BOX_HEALTH_URL;
  else process.env.MORPHEUS_BOX_HEALTH_URL = originalSharedUrl;
});

describe('runtime health network isolation', () => {
  it('keeps both default health probes on their explicit network paths', () => {
    delete process.env.MORPHEUS_BOX_HEALTH_URL;
    delete process.env.MORPHEUS_BOX_HEALTH_URL_MAINNET;
    delete process.env.MORPHEUS_BOX_HEALTH_URL_TESTNET;
    expect(resolveBoxHealthUrl('mainnet')).toBe('https://runtime.meshmini.app/mainnet/health');
    expect(resolveBoxHealthUrl('testnet')).toBe('https://runtime.meshmini.app/testnet/health');
  });

  it('substitutes a network template while scoped configuration remains authoritative', () => {
    process.env.MORPHEUS_BOX_HEALTH_URL = 'https://box.test/{network}/health';
    delete process.env.MORPHEUS_BOX_HEALTH_URL_MAINNET;
    process.env.MORPHEUS_BOX_HEALTH_URL_TESTNET = 'https://separate-testnet.test/health';
    expect(resolveBoxHealthUrl('mainnet')).toBe('https://box.test/mainnet/health');
    expect(resolveBoxHealthUrl('testnet')).toBe('https://separate-testnet.test/health');
  });
  it('prefers an explicit query network over the forwarded header', () => {
    const request = new Request('https://example.test/api/runtime/health?network=testnet', {
      headers: { 'x-morpheus-network': 'mainnet' },
    });

    expect(resolveRuntimeRequestNetwork(request)).toBe('testnet');
  });

  it('uses network-scoped box health endpoints', () => {
    process.env.MORPHEUS_BOX_HEALTH_URL_MAINNET = 'https://mainnet-box.test/health';
    process.env.MORPHEUS_BOX_HEALTH_URL_TESTNET = 'https://testnet-box.test/health';

    expect(resolveBoxHealthUrl('mainnet')).toBe('https://mainnet-box.test/health');
    expect(resolveBoxHealthUrl('testnet')).toBe('https://testnet-box.test/health');
  });

  it('fails closed when a box reports the wrong network', async () => {
    process.env.MORPHEUS_BOX_HEALTH_URL_TESTNET = 'https://testnet-box.test/health';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ status: 'ok', ready: true, network: 'mainnet' }, { status: 200 })
      )
    );

    const result = await fetchBoxHealth('testnet');

    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      error: 'runtime_network_mismatch',
      requested_network: 'testnet',
      actual_network: 'mainnet',
      ready: false,
    });
  });

  it.each([{}, { network: 'unknown' }, 'not JSON'])('refuses an HTTP 200 without verified network: %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)));
    const result = await fetchBoxHealth('testnet');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ error: 'runtime_network_unverified', ready: false });
  });

  it.each(['mainnet', 'testnet'])('accepts the matching %s runtime and refuses redirects', async (network) => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ network, status: 'ok', ready: true }));
    vi.stubGlobal('fetch', fetcher);
    const result = await fetchBoxHealth(network);
    expect(result.ok).toBe(true);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', cache: 'no-store' });
  });

  it.each([undefined, null, 'true', false, 1])('requires boolean ready=true, received %j', async (ready) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ network: 'testnet', status: 'ok', ready })));
    const result = await fetchBoxHealth('testnet');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ error: 'runtime_not_ready', ready: false });
  });

  it.each([[201, 'ok'], [503, 'ok'], [200, 'degraded'], [200, 'error'], [200, null]])('refuses contradictory HTTP/body status %j/%j', async (httpStatus, status) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ network: 'testnet', ready: true, status }, { status: httpStatus as number })));
    const result = await fetchBoxHealth('testnet');
    expect(result.ok).toBe(false);
    expect(result.body).toMatchObject({ ready: false });
  });

  it('cancels oversized UTF-8 bodies without reading or echoing the remainder', async () => {
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('密'.repeat(22000))); },
      cancel: cancelled,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream)));
    const result = await fetchBoxHealth('testnet');
    expect(result.ok).toBe(false);
    expect(result.body).toEqual({ error: 'runtime_health_unavailable', ready: false, requested_network: 'testnet' });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('does not expose malformed origin body strings', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private-key=secret')));
    const result = await fetchBoxHealth('testnet');
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.body).toMatchObject({ error: 'runtime_health_unavailable' });
  });

  it('bounds a hanging body read even when the mock stream ignores abort', async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"network":"testnet",')); },
      cancel: cancelled,
    });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(stream));
    vi.stubGlobal('fetch', fetcher);
    const pending = fetchBoxHealth('testnet');
    await vi.advanceTimersByTimeAsync(8000);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.body).toMatchObject({ error: 'runtime_health_unavailable', ready: false });
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('also bounds a hanging wait for response headers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const pending = fetchBoxHealth('testnet');
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toMatchObject({ ok: false, body: { error: 'runtime_health_unavailable', ready: false } });
  });

  it('keeps private origin details out of transport errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('https://user:secret@internal.test/private'); }));
    const result = await fetchBoxHealth('testnet');
    expect(result.body).toEqual({ error: 'runtime_health_unavailable', ready: false, requested_network: 'testnet' });
  });
});
