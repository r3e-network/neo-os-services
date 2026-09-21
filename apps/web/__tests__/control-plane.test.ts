import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('control-plane fail-closed behavior', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('MORPHEUS_CONTROL_PLANE_URL', 'https://control.meshmini.app');
    vi.stubEnv('MORPHEUS_NETWORK', 'mainnet');
    // NEXT_PUBLIC_MORPHEUS_NETWORK outranks MORPHEUS_NETWORK in lib/networks,
    // so pin it too or an exported value silently reselects the network.
    vi.stubEnv('NEXT_PUBLIC_MORPHEUS_NETWORK', 'mainnet');
    vi.stubEnv('MORPHEUS_CONTROL_PLANE_API_KEY', 'control-plane-key');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('returns Cloudflare 1027 responses without authorizing a fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('error code: 1027', {
            status: 429,
            headers: { 'content-type': 'text/html; charset=UTF-8' },
          })
      )
    );

    const { dispatchToControlPlane } = await import('../lib/control-plane');
    const response = await dispatchToControlPlane('/oracle/query', {
      method: 'POST',
      body: JSON.stringify({ symbol: 'TWELVEDATA:NEO-USD' }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('x-morpheus-control-plane-fail-open')).toBeNull();
    expect(response.headers.get('x-morpheus-control-plane-url')).toBeNull();
    expect(await response.text()).toBe('error code: 1027');
  });

  it('maps fetch exceptions to a closed 503 without exposing transport details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hang up');
      })
    );

    const { dispatchToControlPlane } = await import('../lib/control-plane');
    const response = await dispatchToControlPlane('/compute/execute', {
      method: 'POST',
      body: JSON.stringify({ script: 'return 1;' }),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('x-morpheus-control-plane-fail-open')).toBeNull();
    expect(await response.json()).toEqual({ error: 'control_plane_unavailable' });
  });

  it('maps control-plane timeouts to a closed 503', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation timed out', 'TimeoutError');
      })
    );

    const { dispatchToControlPlane } = await import('../lib/control-plane');
    const response = await dispatchToControlPlane('/oracle/query', {
      method: 'POST',
      body: JSON.stringify({ symbol: 'TWELVEDATA:NEO-USD' }),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('x-morpheus-control-plane-fail-open')).toBeNull();
    expect(await response.json()).toEqual({ error: 'control_plane_unavailable' });
  });

  it('passes through control-plane 5xx responses without authorizing a fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html>cloudflare unavailable</html>', {
            status: 502,
            headers: { 'content-type': 'text/html; charset=UTF-8' },
          })
      )
    );

    const { dispatchToControlPlane } = await import('../lib/control-plane');
    const response = await dispatchToControlPlane('/compute/execute', {
      method: 'POST',
      body: JSON.stringify({ script: 'return 1;' }),
    });

    expect(response.status).toBe(502);
    expect(response.headers.get('x-morpheus-control-plane-fail-open')).toBeNull();
    expect(await response.text()).toBe('<html>cloudflare unavailable</html>');
  });

  it('maps dispatchable routes to workflow runtime metadata', async () => {
    const { getControlPlaneDispatchMetadata } = await import('../lib/control-plane');

    expect(getControlPlaneDispatchMetadata('/automation/execute')).toEqual({
      workflowId: 'automation.upkeep',
      workflowVersion: 1,
      envelopeVersion: '2026-04-tee-v1',
    });
    expect(getControlPlaneDispatchMetadata('/not-a-real-route')).toBeNull();
  });

  it('does not fail-open healthy control-plane responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id: 'job-1', status: 'dispatched' }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          })
      )
    );

    const { dispatchToControlPlane } = await import('../lib/control-plane');
    const response = await dispatchToControlPlane('/oracle/smart-fetch', {
      method: 'POST',
      body: JSON.stringify({ symbol: 'TWELVEDATA:NEO-USD' }),
    });

    expect(response.status).toBe(202);
    expect(response.headers.get('x-morpheus-control-plane-fail-open')).toBeNull();
    expect(await response.json()).toEqual({ id: 'job-1', status: 'dispatched' });
  });
});
