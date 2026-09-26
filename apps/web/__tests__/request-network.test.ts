import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * resolveSupabaseNetwork refuses a network label that is neither mainnet nor
 * testnet. A label taken from a request is the caller's mistake: every API
 * route that reads one answers 400 before it reaches Supabase, instead of the
 * unhandled 500 a throwing resolver produced (before authorization, in
 * provider-configs).
 */

const mocks = vi.hoisted(() => ({
  from: vi.fn(() => {
    throw new Error('Supabase must not be reached for a refused network');
  }),
  recordOperationLog: vi.fn(async () => {}),
}));

vi.mock('@/lib/server-supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server-supabase')>()),
  getServerSupabaseClient: vi.fn(() => ({ from: mocks.from })),
}));

vi.mock('@/lib/operation-logs', () => ({
  recordOperationLog: mocks.recordOperationLog,
}));

vi.mock('@/lib/rate-limit', () => ({
  createRateLimitedHandler:
    (handler: (request: Request) => Promise<Response>) => (request: Request) =>
      handler(request),
}));

const OPERATOR = { authorization: 'Bearer operator-token' };

function get(path: string, headers: Record<string, string> = {}) {
  return new Request(`https://web.test${path}`, { headers });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://web.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

type RouteCase = {
  name: string;
  call: () => Promise<Response>;
};

const routeCases: RouteCase[] = [
  {
    name: 'GET /api/provider-configs',
    call: async () =>
      (await import('../app/api/provider-configs/route')).GET(
        get('/api/provider-configs?project_slug=demo&network=staging')
      ),
  },
  {
    name: 'POST /api/provider-configs',
    call: async () =>
      (await import('../app/api/provider-configs/route')).POST(
        post('/api/provider-configs', { project_slug: 'demo', network: 'staging' })
      ),
  },
  {
    name: 'DELETE /api/provider-configs',
    call: async () =>
      (await import('../app/api/provider-configs/route')).DELETE(
        new Request('https://web.test/api/provider-configs?provider_id=p&network=staging', {
          method: 'DELETE',
        })
      ),
  },
  {
    name: 'GET /api/control-plane/jobs/[jobId]',
    call: async () =>
      (await import('../app/api/control-plane/jobs/[jobId]/route')).GET(
        get('/api/control-plane/jobs/job-1?network=staging', OPERATOR),
        { params: Promise.resolve({ jobId: 'job-1' }) }
      ),
  },
  {
    name: 'POST /api/control-plane/automation/execute',
    call: async () =>
      (await import('../app/api/control-plane/automation/execute/route')).POST(
        post('/api/control-plane/automation/execute', { network: 'staging' }, OPERATOR)
      ),
  },
  {
    name: 'POST /api/control-plane/callbacks/broadcast',
    call: async () =>
      (await import('../app/api/control-plane/callbacks/broadcast/route')).POST(
        post('/api/control-plane/callbacks/broadcast', { network: 'staging' }, OPERATOR)
      ),
  },
  {
    name: 'POST /api/internal/control-plane/automation-execute',
    call: async () =>
      (await import('../app/api/internal/control-plane/automation-execute/route')).POST(
        post(
          '/api/internal/control-plane/automation-execute',
          { automation_id: 'automation-1', network: 'staging' },
          OPERATOR
        )
      ),
  },
  {
    name: 'POST /api/internal/control-plane/callback-broadcast',
    call: async () =>
      (await import('../app/api/internal/control-plane/callback-broadcast/route')).POST(
        post('/api/internal/control-plane/callback-broadcast', { network: 'staging' }, OPERATOR)
      ),
  },
  {
    name: 'POST /api/internal/control-plane/feed-tick',
    call: async () =>
      (await import('../app/api/internal/control-plane/feed-tick/route')).POST(
        post('/api/internal/control-plane/feed-tick', { network: 'staging' }, OPERATOR)
      ),
  },
  {
    name: 'POST /api/confidential/store',
    call: async () =>
      (await import('../app/api/confidential/store/route')).POST(
        post('/api/confidential/store', {
          ciphertext: 'c2VhbGVk',
          project_slug: 'demo',
          network: 'staging',
        })
      ),
  },
  {
    name: 'GET /api/registry/secrets',
    call: async () =>
      (await import('../app/api/registry/secrets/route')).GET(
        get('/api/registry/secrets?project_slug=demo&network=staging')
      ),
  },
  {
    name: 'POST /api/registry/secrets',
    call: async () =>
      (await import('../app/api/registry/secrets/route')).POST(
        post('/api/registry/secrets', { project_slug: 'demo', network: 'staging' })
      ),
  },
  {
    name: 'GET /api/registry/workflows',
    call: async () =>
      (await import('../app/api/registry/workflows/route')).GET(
        get('/api/registry/workflows?project_slug=demo&network=staging')
      ),
  },
  {
    name: 'POST /api/workflows',
    call: async () =>
      (await import('../app/api/workflows/route')).POST(
        post('/api/workflows', { project_slug: 'demo', network: 'staging' })
      ),
  },
  {
    name: 'GET /api/relayer/jobs',
    call: async () =>
      (await import('../app/api/relayer/jobs/route')).GET(
        get('/api/relayer/jobs?network=staging', OPERATOR)
      ),
  },
  {
    name: 'GET /api/relayer/dead-letters',
    call: async () =>
      (await import('../app/api/relayer/dead-letters/route')).GET(
        get('/api/relayer/dead-letters?network=staging', OPERATOR)
      ),
  },
  {
    name: 'GET /api/relayer/metrics',
    call: async () =>
      (await import('../app/api/relayer/metrics/route')).GET(
        get('/api/relayer/metrics?network=staging', OPERATOR)
      ),
  },
  {
    name: 'POST /api/relayer/jobs/retry',
    call: async () =>
      (await import('../app/api/relayer/jobs/retry/route')).POST(
        post('/api/relayer/jobs/retry', { event_key: 'event-1', network: 'staging' }, OPERATOR)
      ),
  },
  {
    name: 'POST /api/relayer/jobs/replay',
    call: async () =>
      (await import('../app/api/relayer/jobs/replay/route')).POST(
        post('/api/relayer/jobs/replay', { event_key: 'event-1', network: 'staging' }, OPERATOR)
      ),
  },
];

describe('request network labels', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.from.mockClear();
    mocks.recordOperationLog.mockClear();
    vi.stubEnv('MORPHEUS_NETWORK', 'testnet');
    vi.stubEnv('NEXT_PUBLIC_MORPHEUS_NETWORK', 'testnet');
    vi.stubEnv('MORPHEUS_OPERATOR_API_KEY', 'operator-token');
    vi.stubEnv('MORPHEUS_MANUAL_ACTION_HMAC_SECRET', 'manual-action-secret');
    vi.stubEnv('MORPHEUS_CONTROL_PLANE_URL', 'https://control-plane.test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolveRequestNetwork keeps the deployment default and refuses an unknown label with 400', async () => {
    const { resolveRequestNetwork } = await import('../lib/request-network');
    expect(resolveRequestNetwork(null)).toEqual({ ok: true, network: 'testnet' });
    expect(resolveRequestNetwork('')).toEqual({ ok: true, network: 'testnet' });
    expect(resolveRequestNetwork('mainnet')).toEqual({ ok: true, network: 'mainnet' });

    const refused = resolveRequestNetwork('staging');
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.response.status).toBe(400);
    await expect(refused.response.json()).resolves.toEqual({
      error: 'unsupported Neo network: staging',
      error_code: 'UNSUPPORTED_NETWORK',
    });
  });

  it('resolveRequestNetwork still throws when the deployment network itself is invalid', async () => {
    vi.stubEnv('MORPHEUS_NETWORK', 'staging');
    const { resolveRequestNetwork } = await import('../lib/request-network');
    // The caller sent no label; the fault is the deployment's, not a 400.
    expect(() => resolveRequestNetwork('')).toThrow('unsupported Neo network: staging');
  });

  it.each(routeCases.map((routeCase) => [routeCase.name, routeCase] as const))(
    '%s answers an unsupported network label with 400 before Supabase',
    async (_name, routeCase) => {
      const response = await routeCase.call();
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toEqual({
        error: 'unsupported Neo network: staging',
        error_code: 'UNSUPPORTED_NETWORK',
      });
      expect(mocks.from).not.toHaveBeenCalled();
    }
  );

  it('provider-configs logs the refusal like its other refusals', async () => {
    const { GET } = await import('../app/api/provider-configs/route');
    await GET(get('/api/provider-configs?project_slug=demo&network=staging'));
    expect(mocks.recordOperationLog).toHaveBeenCalledWith(
      expect.objectContaining({
        route: '/api/provider-configs',
        method: 'GET',
        httpStatus: 400,
        error: 'unsupported Neo network: staging',
        requestPayload: { project_slug: 'demo', network: 'staging' },
      })
    );
  });

  it('provider-configs logs the label it resolved and the resolver message', async () => {
    const { POST } = await import('../app/api/provider-configs/route');
    const response = await POST(
      post('/api/provider-configs', {
        project_slug: 'demo',
        network: false,
        morpheus_network: 'staging',
      })
    );
    expect(response.status).toBe(400);
    expect(mocks.recordOperationLog).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        httpStatus: 400,
        error: 'unsupported Neo network: staging',
        requestPayload: { project_slug: 'demo', network: 'staging' },
      })
    );
  });

  it('the control-plane job route keeps its no-store header on the refusal', async () => {
    const { GET } = await import('../app/api/control-plane/jobs/[jobId]/route');
    const response = await GET(get('/api/control-plane/jobs/job-1?network=staging', OPERATOR), {
      params: Promise.resolve({ jobId: 'job-1' }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('authorization still comes first where the route checked it first', async () => {
    const { GET } = await import('../app/api/relayer/jobs/route');
    const response = await GET(get('/api/relayer/jobs?network=staging'));
    expect(response.status).toBe(401);
  });
});
