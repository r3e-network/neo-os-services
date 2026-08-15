import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchBoxHealth,
  resolveBoxHealthUrl,
  resolveRuntimeRequestNetwork,
} from './runtime-health';

const originalMainnetUrl = process.env.MORPHEUS_BOX_HEALTH_URL_MAINNET;
const originalTestnetUrl = process.env.MORPHEUS_BOX_HEALTH_URL_TESTNET;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalMainnetUrl === undefined) delete process.env.MORPHEUS_BOX_HEALTH_URL_MAINNET;
  else process.env.MORPHEUS_BOX_HEALTH_URL_MAINNET = originalMainnetUrl;
  if (originalTestnetUrl === undefined) delete process.env.MORPHEUS_BOX_HEALTH_URL_TESTNET;
  else process.env.MORPHEUS_BOX_HEALTH_URL_TESTNET = originalTestnetUrl;
});

describe('runtime health network isolation', () => {
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
});
