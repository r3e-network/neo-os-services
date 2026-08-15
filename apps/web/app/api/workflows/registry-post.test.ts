import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRateLimitMap } from '@/lib/rate-limit';

// `server-only` throws in non-Next.js runtimes; stub it (same as public-api-routes.test.ts).
vi.mock('server-only', () => ({}));

const mockGetServerSupabaseClient = vi.fn();
const mockResolveRequestUser = vi.fn();
const mockResolveOwnedProjectId = vi.fn();

vi.mock('@/lib/server-supabase', () => ({
  getServerSupabaseClient: (...args: unknown[]) => mockGetServerSupabaseClient(...args),
  resolveSupabaseNetwork: (v?: string | null) =>
    String(v || '').trim() === 'mainnet' ? 'mainnet' : 'testnet',
}));

vi.mock('@/lib/user-auth', () => ({
  resolveRequestUser: (...args: unknown[]) => mockResolveRequestUser(...args),
  resolveOwnedProjectId: (...args: unknown[]) => mockResolveOwnedProjectId(...args),
  unauthorized: () =>
    Response.json(
      { error: 'unauthorized', error_code: 'UNAUTHORIZED' },
      { status: 401, headers: { 'cache-control': 'no-store' } }
    ),
}));

function makeSupabaseClient(result: { single?: unknown; maybeSingle?: unknown } = {}) {
  const builder: any = {
    insert: vi.fn(() => builder),
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    neq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    update: vi.fn(() => builder),
    delete: vi.fn(() => builder),
    single: vi.fn(() => Promise.resolve(result.single ?? { data: null, error: null })),
    maybeSingle: vi.fn(() => Promise.resolve(result.maybeSingle ?? { data: null, error: null })),
  };
  const client: any = {
    from: vi.fn(() => builder),
    auth: { getUser: vi.fn() },
  };
  return { client, builder };
}

const WORKFLOW_ROW = {
  id: 'wf-uuid',
  project_id: 'project-1',
  workflow_id: 'user.mainnet.acme.price-watcher',
  name: 'Price Watcher',
  version: 1,
  status: 'draft',
  trigger_kind: 'cron',
  trigger_config: { interval_seconds: 300 },
  handler_source: null,
  target_chain: 'neo_n3',
  network: 'mainnet',
  metadata: {},
  created_at: '2026-08-13T00:00:00.000Z',
  updated_at: '2026-08-13T00:00:00.000Z',
};

function postBody(overrides: Record<string, unknown> = {}) {
  return {
    project_slug: 'acme',
    name: 'Price Watcher',
    trigger_kind: 'cron',
    trigger_config: { interval_seconds: 300 },
    target_chain: 'neo_n3',
    ...overrides,
  };
}

describe('workflow registry POST authz & validation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetRateLimitMap();
    mockGetServerSupabaseClient.mockReturnValue(makeSupabaseClient().client);
    mockResolveRequestUser.mockResolvedValue({ id: 'user-1', email: null });
    mockResolveOwnedProjectId.mockResolvedValue('project-1');
  });

  it('rejects requests without a user JWT with 401', async () => {
    mockResolveRequestUser.mockResolvedValue(null);
    const { POST } = await import('./route');
    const response = await POST(
      new Request('http://localhost/api/workflows', {
        method: 'POST',
        body: JSON.stringify(postBody()),
      })
    );
    expect(response.status).toBe(401);
  });

  it('rejects a name that sanitizes to empty with 400', async () => {
    const { POST } = await import('./route');
    const response = await POST(
      new Request('http://localhost/api/workflows', {
        method: 'POST',
        body: JSON.stringify(postBody({ name: '!!!' })),
      })
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ error_code: 'INVALID_NAME' })
    );
  });

  it('rejects an unknown trigger_kind with 400', async () => {
    const { POST } = await import('./route');
    const response = await POST(
      new Request('http://localhost/api/workflows', {
        method: 'POST',
        body: JSON.stringify(postBody({ trigger_kind: 'webhook' })),
      })
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ error_code: 'INVALID_TRIGGER_KIND' })
    );
  });

  it('rejects array metadata with 400', async () => {
    const { POST } = await import('./route');
    const response = await POST(
      new Request('http://localhost/api/workflows', {
        method: 'POST',
        body: JSON.stringify(postBody({ metadata: [1, 2, 3] })),
      })
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ error_code: 'INVALID_METADATA' })
    );
  });

  it('returns 404 for a project the user does not own', async () => {
    mockResolveOwnedProjectId.mockResolvedValue(null);
    const { POST } = await import('./route');
    const response = await POST(
      new Request('http://localhost/api/workflows', {
        method: 'POST',
        body: JSON.stringify(postBody()),
      })
    );
    expect(response.status).toBe(404);
  });

  it('creates a workflow for an owner with 201', async () => {
    const { client } = makeSupabaseClient({ single: { data: WORKFLOW_ROW, error: null } });
    mockGetServerSupabaseClient.mockReturnValue(client);
    const { POST } = await import('./route');
    const response = await POST(
      new Request('http://localhost/api/workflows', {
        method: 'POST',
        body: JSON.stringify(postBody()),
      })
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.id).toBe('user.mainnet.acme.price-watcher');
    expect(body.trigger.kind).toBe('cron');
    expect(body).not.toHaveProperty('handler_source');
  });
});
