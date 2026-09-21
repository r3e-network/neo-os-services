import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatchToControlPlane: vi.fn(),
  recordOperationLog: vi.fn(),
}));

vi.mock('@/lib/control-plane', () => ({
  dispatchToControlPlane: mocks.dispatchToControlPlane,
  shouldDispatchToControlPlane: () => true,
}));

vi.mock('@/lib/nitro', () => ({
  proxyToNitro: vi.fn(),
}));

// The limiter itself is covered by rate-limit.test.ts; here the handler runs
// bare so the auth decision is the only thing under test.
vi.mock('@/lib/rate-limit', () => ({
  createRateLimitedHandler:
    (handler: (request: Request) => Promise<Response>) => (request: Request) =>
      handler(request),
}));

vi.mock('@/lib/provider-configs', () => ({
  resolveProviderAwarePayload: async (payload: unknown) => ({ payload }),
}));

vi.mock('@/lib/operation-logs', () => ({
  recordOperationLog: mocks.recordOperationLog,
}));

import { POST as oracleQuery } from '../app/api/oracle/query/route';

function queryRequest(headers: Record<string, string> = {}) {
  return new Request('https://app.test/api/oracle/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ symbol: 'TWELVEDATA:NEO-USD', target_chain: 'neo_n3' }),
  });
}

describe('POST /api/oracle/query shared-secret gate (N-web-2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.dispatchToControlPlane.mockResolvedValue(
      Response.json({ ok: true }, { status: 200 })
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stays open when MORPHEUS_ORACLE_QUERY_API_KEY is not configured', async () => {
    vi.stubEnv('MORPHEUS_ORACLE_QUERY_API_KEY', '');
    const response = await oracleQuery(queryRequest());
    expect(response.status).toBe(200);
    expect(mocks.dispatchToControlPlane).toHaveBeenCalledTimes(1);
  });

  it('rejects an anonymous caller with 401 once the secret is configured', async () => {
    vi.stubEnv('MORPHEUS_ORACLE_QUERY_API_KEY', 'oracle-query-secret');
    const response = await oracleQuery(queryRequest());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error_code: 'UNAUTHORIZED' });
    // The refusal happens before any server-held credential is spent.
    expect(mocks.dispatchToControlPlane).not.toHaveBeenCalled();
    expect(mocks.recordOperationLog).not.toHaveBeenCalled();
  });

  it('rejects a wrong secret and accepts the configured one via bearer or admin header', async () => {
    vi.stubEnv('MORPHEUS_ORACLE_QUERY_API_KEY', 'oracle-query-secret');

    const wrong = await oracleQuery(
      queryRequest({ authorization: 'Bearer oracle-query-secrex' })
    );
    expect(wrong.status).toBe(401);

    const bearer = await oracleQuery(
      queryRequest({ authorization: 'Bearer oracle-query-secret' })
    );
    expect(bearer.status).toBe(200);

    const adminHeader = await oracleQuery(
      queryRequest({ 'x-admin-api-key': 'oracle-query-secret' })
    );
    expect(adminHeader.status).toBe(200);
    expect(mocks.dispatchToControlPlane).toHaveBeenCalledTimes(2);
  });
});
