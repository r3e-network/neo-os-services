import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The web control plane must not sign or hold Neo N3 key material: both on-chain
 * lanes (fulfillment, automation queueing) relay through the Nitro worker's
 * custody-signed /txproxy/invoke endpoint as the updater account. These tests
 * pin the wire contract — correct endpoint/headers, JSON contract params, the
 * `web-*` request-id namespace, and above all that no wif/private_key is ever
 * attached to the relay request.
 */

const resolveSupabaseNetwork = vi.fn(() => 'testnet');
const getServerSupabaseClient = vi.fn(() => null);

vi.mock('@/lib/server-supabase', () => ({
  getServerSupabaseClient,
  resolveSupabaseNetwork,
  isAuthorizedAdminRequest: vi.fn(() => false),
}));

const ORACLE_HASH = '0xf54d8584ef82315c1800373272ab08ae0db2d5ef';

function relayResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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

describe('control-plane custody relay wrappers', () => {
  let fetchCalls: { url: string; init: RequestInit }[];

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
    vi.resetModules();
    fetchCalls = [];
    vi.stubEnv('MORPHEUS_RUNTIME_TOKEN', 'runtime-token');
    vi.stubEnv('MORPHEUS_RUNTIME_URL', 'https://runtime.test');
    vi.stubEnv('CONTRACT_MORPHEUS_ORACLE_HASH', ORACLE_HASH);
    vi.stubEnv('NEO_RPC_URL', 'https://rpc.test');
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      fetchCalls.push({ url, init });
      return relayResponse({
        request_id: 'web-relay-1',
        tx_hash: '0x' + 'ab'.repeat(32),
        vm_state: 'HALT',
        exception: null,
      });
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('rejects a Neo N3 magic override that differs from the reviewed registry', async () => {
    vi.stubEnv('NEO_NETWORK_MAGIC', '42');
    const { resolveNeoN3Runtime } = await import('../lib/neo-control-plane');
    expect(() => resolveNeoN3Runtime('testnet')).toThrow(
      /configured Neo N3 network magic conflicts with reviewed testnet identity/
    );
  });

  it('fulfillNeoN3RequestViaBackend relays fulfillRequest without signer material', async () => {
    const { fulfillNeoN3RequestViaBackend } = await import('../lib/neo-control-plane');
    const result = await fulfillNeoN3RequestViaBackend({
      network: 'testnet',
      requestId: '42',
      success: true,
      result: 'ok',
      error: '',
      verificationSignature: '0x'.concat('cd'.repeat(64)),
    });

    expect(result).toEqual({
      tx_hash: '0x' + 'ab'.repeat(32),
      vm_state: 'HALT',
      exception: null,
      target_chain: 'neo_n3',
    });

    expect(fetchCalls).toHaveLength(1);
    const { url, init } = fetchCalls[0];
    expect(url).toBe('https://runtime.test/txproxy/invoke');
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get('authorization')).toBe('Bearer runtime-token');
    expect(headers.get('x-nitro-token')).toBe('runtime-token');

    const body = JSON.parse(String(init.body));
    expect(body.target_chain).toBe('neo_n3');
    expect(body.network).toBe('testnet');
    expect(body.contract_hash).toBe(ORACLE_HASH);
    expect(body.method).toBe('fulfillRequest');
    expect(body.request_id).toBe('web-fulfill-42');
    expect(body.wait).toBe(true);
    expect(body.params).toEqual([
      { type: 'integer', value: '42' },
      { type: 'boolean', value: true },
      { type: 'bytearray', value: Buffer.from('ok', 'utf8').toString('hex') },
      { type: 'string', value: '' },
      { type: 'bytearray', value: 'cd'.repeat(64) },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/"(wif|private_key|privateKey)"/);
  });

  it('queueNeoN3AutomationViaBackend relays queueAutomationRequest without signer material', async () => {
    const { queueNeoN3AutomationViaBackend } = await import('../lib/neo-control-plane');
    const payloadText = JSON.stringify({ raw_payload: 'ping' });
    const result = await queueNeoN3AutomationViaBackend({
      network: 'testnet',
      requester: '0x' + '11'.repeat(20),
      requestType: 'automation_cron',
      payloadText,
      callbackContract: '0x' + '22'.repeat(20),
      callbackMethod: 'onCallback',
      requestId: 'job-7-run-3',
    });

    expect(result).toEqual({
      tx_hash: '0x' + 'ab'.repeat(32),
      request_id: 'job-7-run-3',
      target_chain: 'neo_n3',
    });

    const body = JSON.parse(String(fetchCalls[0].init.body));
    expect(body.method).toBe('queueAutomationRequest');
    expect(body.request_id).toBe('web-queue-job-7-run-3');
    expect(body.wait).toBe(false);
    expect(body.params).toEqual([
      { type: 'hash160', value: '0x' + '11'.repeat(20) },
      { type: 'string', value: 'automation_cron' },
      { type: 'bytearray', value: Buffer.from(payloadText, 'utf8').toString('hex') },
      { type: 'hash160', value: '0x' + '22'.repeat(20) },
      { type: 'string', value: 'onCallback' },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/"(wif|private_key|privateKey)"/);
  });

  it('surfaces the worker refusal so duplicate queueing maps to already-queued', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        relayResponse({ error: 'request_id already used', request_id: 'web-queue-1' }, 409)
      )
    );
    const { queueNeoN3AutomationViaBackend } = await import('../lib/neo-control-plane');
    await expect(
      queueNeoN3AutomationViaBackend({
        network: 'testnet',
        requester: '0x' + '11'.repeat(20),
        requestType: 'automation_cron',
        payloadText: '{}',
        callbackContract: '0x' + '22'.repeat(20),
        callbackMethod: 'onCallback',
        requestId: '1',
      })
    ).rejects.toThrow(/request_id already used/);
  });

  it('fails over to the next runtime URL on a retryable status', async () => {
    vi.stubEnv('NEXT_PUBLIC_MORPHEUS_RUNTIME_URL', 'https://runtime-backup.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetchCalls.push({ url, init: {} });
        if (String(url).startsWith('https://runtime.test')) {
          return new Response('upstream unavailable', { status: 503 });
        }
        return relayResponse({ tx_hash: '0x' + 'ab'.repeat(32), vm_state: 'HALT' });
      })
    );
    const { fulfillNeoN3RequestViaBackend } = await import('../lib/neo-control-plane');
    const result = await fulfillNeoN3RequestViaBackend({
      network: 'testnet',
      requestId: '7',
      success: true,
      result: '',
      error: '',
      verificationSignature: 'ab',
    });
    expect(result.tx_hash).toBe('0x' + 'ab'.repeat(32));
    expect(fetchCalls.map((call) => call.url)).toEqual([
      'https://runtime.test/txproxy/invoke',
      'https://runtime-backup.test/txproxy/invoke',
    ]);
  });

  it('never fails over a custody relay in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_MORPHEUS_RUNTIME_URL', 'https://runtime-backup.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetchCalls.push({ url, init: {} });
        return new Response('upstream unavailable', { status: 503 });
      })
    );
    const { fulfillNeoN3RequestViaBackend } = await import('../lib/neo-control-plane');

    await expect(
      fulfillNeoN3RequestViaBackend({
        network: 'testnet',
        requestId: '8',
        success: true,
        result: '',
        error: '',
        verificationSignature: 'ab',
      })
    ).rejects.toThrow(/worker relay failed/i);
    expect(fetchCalls.map((call) => call.url)).toEqual(['https://runtime.test/txproxy/invoke']);
  });
});
