import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY_B64 = 'kQvtpPekS1fzHFhaU2XFyKVobY0pii/KrVZSEOD/xx4=';
const ALGORITHM = 'X25519-HKDF-SHA256-AES-256-GCM';

// A Neo N3 invokefunction stack item whose ByteString value is the base64 of the
// stored bytes (the kernel stores the base64 key TEXT, so parseNeoStackItem decodes
// it back to the base64 string the browser X25519 helper consumes).
function byteString(text: string) {
  return { type: 'ByteString', value: Buffer.from(text, 'utf8').toString('base64') };
}

// Mock the Neo RPC: respond per invokefunction method name (params[1]).
function neoRpcMock(responder: (method: string) => unknown) {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    const method = body?.params?.[1];
    const item = responder(method);
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { state: 'HALT', stack: item ? [item] : [] },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });
}

describe('oracle public key route (on-chain re-home)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('MORPHEUS_NETWORK', 'testnet');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('serves the encryption key read trustlessly from the on-chain kernel', async () => {
    const fetchMock = neoRpcMock((method) => {
      if (method === 'oracleEncryptionPublicKey') return byteString(KEY_B64);
      if (method === 'oracleEncryptionAlgorithm') return byteString(ALGORITHM);
      if (method === 'oracleEncryptionKeyVersion') return { type: 'Integer', value: '7' };
      if (method === 'oracleVerificationPublicKey') return byteString('verifier-stub');
      return null;
    });
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('../app/api/oracle/public-key/route');
    const response = await GET(
      new Request('https://example.test/api/oracle/public-key?network=testnet')
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      available: true,
      degraded: false,
      public_key: KEY_B64,
      algorithm: ALGORITHM,
      key_version: '7',
      key_source: 'neo_n3_contract',
    });
    expect(body.source.chain).toBe('neo_n3');
    // No runtime token is ever attached for this trustless read.
    for (const call of fetchMock.mock.calls) {
      const headers = (call?.[1]?.headers || {}) as Record<string, string>;
      expect(headers.authorization).toBeUndefined();
    }
  });

  it('degrades to 200 when the kernel has no encryption key published (Any/null)', async () => {
    const fetchMock = neoRpcMock((method) => {
      if (method === 'oracleEncryptionKeyVersion') return { type: 'Integer', value: '0' };
      // oracleEncryptionPublicKey + others return Any/null (unpublished).
      return { type: 'Any' };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('../app/api/oracle/public-key/route');
    const response = await GET(new Request('https://example.test/api/oracle/public-key'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      available: false,
      degraded: true,
      public_key: null,
      key_source: 'onchain-unset',
      error: 'oracle_public_key_unavailable',
    });
  });

  it('degrades to 200 when every RPC candidate fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad gateway', { status: 521 }))
    );

    const { GET } = await import('../app/api/oracle/public-key/route');
    const response = await GET(new Request('https://example.test/api/oracle/public-key'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      available: false,
      degraded: true,
      public_key: null,
      key_source: 'unavailable',
    });
  });

  it('rejects an unknown network query param with 400', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { GET } = await import('../app/api/oracle/public-key/route');
    const response = await GET(
      new Request('https://example.test/api/oracle/public-key?network=banana')
    );
    expect(response.status).toBe(400);
  });
});
