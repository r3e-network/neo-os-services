import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatchToControlPlane: vi.fn(),
  proxyToNitro: vi.fn(),
  recordOperationLog: vi.fn(),
}));

vi.mock('@/lib/control-plane', () => ({
  dispatchToControlPlane: mocks.dispatchToControlPlane,
  shouldDispatchToControlPlane: () => true,
}));

vi.mock('@/lib/nitro', () => ({
  proxyToNitro: mocks.proxyToNitro,
}));

vi.mock('@/lib/rate-limit', () => ({
  createRateLimitedHandler:
    (handler: (request: Request) => Promise<Response>) => (request: Request) =>
      handler(request),
}));

vi.mock('@/lib/provider-configs', () => ({
  resolveProviderAwarePayload: async (payload: unknown) => ({ payload }),
}));

// compute/execute now requires a trusted runtime credential (S1); these tests
// exercise the control-plane failover path, so authorize the caller.
vi.mock('@/lib/control-plane-auth', () => ({
  isAuthorizedRuntimeRequest: () => true,
}));

vi.mock('@/lib/operation-logs', () => ({
  recordOperationLog: mocks.recordOperationLog,
}));

import { POST as oracleQuery } from '../app/api/oracle/query/route';
import { POST as oracleSmartFetch } from '../app/api/oracle/smart-fetch/route';
import { POST as computeExecute } from '../app/api/compute/execute/route';
import { POST as neodidBind } from '../app/api/neodid/bind/route';
import { POST as neodidActionTicket } from '../app/api/neodid/action-ticket/route';
import { POST as neodidRecoveryTicket } from '../app/api/neodid/recovery-ticket/route';
import { POST as neodidZkloginTicket } from '../app/api/neodid/zklogin-ticket/route';

const routes = [
  ['oracle query', oracleQuery],
  ['oracle smart fetch', oracleSmartFetch],
  ['compute execute', computeExecute],
  ['NeoDID bind', neodidBind],
  ['NeoDID action ticket', neodidActionTicket],
  ['NeoDID recovery ticket', neodidRecoveryTicket],
  ['NeoDID zkLogin ticket', neodidZkloginTicket],
] as const;

describe('public control-plane routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(routes)('%s does not proxy to Nitro after a control-plane 429', async (_name, post) => {
    mocks.dispatchToControlPlane.mockResolvedValueOnce(
      Response.json({ error: 'temporarily rate limited' }, { status: 429 })
    );

    const response = await post(
      new Request('https://example.test/api/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'TWELVEDATA:NEO-USD', script: 'return 1;' }),
      })
    );

    expect(response.status).toBe(429);
    expect(mocks.dispatchToControlPlane).toHaveBeenCalledTimes(1);
    expect(mocks.proxyToNitro).not.toHaveBeenCalled();
  });

  it.each(routes)('%s does not proxy to Nitro after a control-plane 5xx', async (_name, post) => {
    mocks.dispatchToControlPlane.mockResolvedValueOnce(
      Response.json({ error: 'control_plane_unavailable' }, { status: 503 })
    );

    const response = await post(
      new Request('https://example.test/api/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'TWELVEDATA:NEO-USD', script: 'return 1;' }),
      })
    );

    expect(response.status).toBe(503);
    expect(mocks.dispatchToControlPlane).toHaveBeenCalledTimes(1);
    expect(mocks.proxyToNitro).not.toHaveBeenCalled();
  });
});
