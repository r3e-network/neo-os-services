import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression for the unauthenticated control-plane job-status disclosure.
 *
 * GET /api/control-plane/jobs/[jobId] used the service-role client to return the
 * full job row (payload/result/error/metadata, incl. metadata.client_ip) to
 * anyone who knew the opaque job UUID. It must now require operator control-plane
 * auth, matching the sibling control-plane routes.
 */

const maybeSingle = vi.fn(async () => ({
  data: {
    id: 'job-uuid-1',
    network: 'testnet',
    route: '/oracle/query',
    payload: { secret: 'do-not-leak' },
    result: { ok: true },
    metadata: { client_ip: '203.0.113.7' },
  },
  error: null,
}));
const eqNetwork = vi.fn(() => ({ maybeSingle }));
const eqId = vi.fn(() => ({ eq: eqNetwork }));
const select = vi.fn(() => ({ eq: eqId }));
const from = vi.fn(() => ({ select }));
const getServerSupabaseClient = vi.fn(() => ({ from }));
const resolveSupabaseNetwork = vi.fn(() => 'testnet');

vi.mock('@/lib/server-supabase', () => ({
  getServerSupabaseClient,
  resolveSupabaseNetwork,
  // isAuthorizedControlPlaneRequest -> isAuthorizedAdminRequest; keep it false so
  // the shared MORPHEUS_RUNTIME_TOKEN path is what authorizes (or rejects).
  isAuthorizedAdminRequest: vi.fn(() => false),
}));
vi.mock('@/lib/workflow-runtime', () => ({
  decorateControlPlaneJob: (row: Record<string, unknown>) => ({ ...row, decorated: true }),
}));

const params = Promise.resolve({ jobId: 'job-uuid-1' });

describe('control-plane job status route auth', () => {
  beforeEach(() => {
    vi.resetModules();
    from.mockClear();
    select.mockClear();
    maybeSingle.mockClear();
    getServerSupabaseClient.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects an unauthenticated request without querying the jobs table', async () => {
    vi.stubEnv('MORPHEUS_RUNTIME_TOKEN', 'cp-token');
    const { GET } = await import('../app/api/control-plane/jobs/[jobId]/route');
    const res = await GET(
      new Request('https://example.test/api/control-plane/jobs/job-uuid-1?network=testnet'),
      { params }
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
    await expect(res.json()).resolves.toEqual({ error: 'unauthorized' });
    // Must not reach the service-role read.
    expect(getServerSupabaseClient).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it('returns the decorated job row for an authorized operator request', async () => {
    vi.stubEnv('MORPHEUS_RUNTIME_TOKEN', 'cp-token');
    const { GET } = await import('../app/api/control-plane/jobs/[jobId]/route');
    const res = await GET(
      new Request('https://example.test/api/control-plane/jobs/job-uuid-1?network=testnet', {
        headers: { authorization: 'Bearer cp-token' },
      }),
      { params }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.id).toBe('job-uuid-1');
    expect(body.decorated).toBe(true);
    expect(from).toHaveBeenCalledWith('morpheus_control_plane_jobs');
  });
});
