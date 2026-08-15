import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRateLimitMap } from '@/lib/rate-limit';

vi.mock('server-only', () => ({}));

const mockGetServerSupabaseClient = vi.fn();
const mockResolveRequestUser = vi.fn();

vi.mock('@/lib/server-supabase', () => ({
  getServerSupabaseClient: (...args: unknown[]) => mockGetServerSupabaseClient(...args),
  resolveSupabaseNetwork: (v?: string | null) =>
    String(v || '').trim() === 'mainnet' ? 'mainnet' : 'testnet',
}));

vi.mock('@/lib/user-auth', () => ({
  resolveRequestUser: (...args: unknown[]) => mockResolveRequestUser(...args),
  resolveOwnedProjectId: vi.fn(async () => 'project-1'),
  unauthorized: () =>
    Response.json(
      { error: 'unauthorized', error_code: 'UNAUTHORIZED' },
      { status: 401, headers: { 'cache-control': 'no-store' } }
    ),
}));

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

function makeOwnerSupabase(
  workflowRow: unknown,
  updateResult: unknown = null,
  projectResult: unknown = { id: 'project-1' }
) {
  const wfBuilder: any = {
    select: vi.fn(() => wfBuilder),
    eq: vi.fn(() => wfBuilder),
    maybeSingle: vi.fn(() => Promise.resolve({ data: workflowRow, error: null })),
    update: vi.fn(() => wfBuilder),
    single: vi.fn(() => Promise.resolve(updateResult ?? { data: null, error: null })),
  };
  const projBuilder: any = {
    select: vi.fn(() => projBuilder),
    eq: vi.fn(() => projBuilder),
    maybeSingle: vi.fn(() => Promise.resolve({ data: projectResult, error: null })),
  };
  const client: any = {
    from: vi.fn((table: string) =>
      table === 'morpheus_workflow_registry' ? wfBuilder : projBuilder
    ),
    auth: { getUser: vi.fn() },
  };
  return { client, wfBuilder };
}

function patchContext(workflowId: string) {
  return { params: Promise.resolve({ workflowId }) };
}

describe('workflow registry PATCH/DELETE authz & state machine', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetRateLimitMap();
    mockGetServerSupabaseClient.mockReturnValue(makeOwnerSupabase(WORKFLOW_ROW).client);
    mockResolveRequestUser.mockResolvedValue({ id: 'user-1', email: null });
  });

  it('PATCH rejects without a JWT with 401', async () => {
    mockResolveRequestUser.mockResolvedValue(null);
    const { PATCH } = await import('./[workflowId]/route');
    const response = await PATCH(
      new Request('http://localhost/api/workflows/x', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'active' }),
      }),
      patchContext('user.mainnet.acme.price-watcher')
    );
    expect(response.status).toBe(401);
  });

  it('PATCH rejects platform workflow ids with 403', async () => {
    const { PATCH } = await import('./[workflowId]/route');
    const response = await PATCH(
      new Request('http://localhost/api/workflows/x', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'active' }),
      }),
      patchContext('oracle.query')
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ error_code: 'PLATFORM_WORKFLOW_IMMUTABLE' })
    );
  });

  it('PATCH returns 404 for a non-owned workflow', async () => {
    mockGetServerSupabaseClient.mockReturnValue(makeOwnerSupabase(null).client);
    const { PATCH } = await import('./[workflowId]/route');
    const response = await PATCH(
      new Request('http://localhost/api/workflows/x', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'active' }),
      }),
      patchContext('user.mainnet.acme.price-watcher')
    );
    expect(response.status).toBe(404);
  });

  it('PATCH returns 404 when the row exists but its project belongs to another user', async () => {
    // Row exists, but the project ownership check (owner_user_id) fails → null.
    mockGetServerSupabaseClient.mockReturnValue(makeOwnerSupabase(WORKFLOW_ROW, null, null).client);
    const { PATCH } = await import('./[workflowId]/route');
    const response = await PATCH(
      new Request('http://localhost/api/workflows/x', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'active' }),
      }),
      patchContext('user.mainnet.acme.price-watcher')
    );
    expect(response.status).toBe(404);
  });

  it('PATCH rejects an illegal state transition with 400', async () => {
    // draft -> paused is not allowed (draft can only go to active/deleted).
    const { PATCH } = await import('./[workflowId]/route');
    const response = await PATCH(
      new Request('http://localhost/api/workflows/x', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'paused' }),
      }),
      patchContext('user.mainnet.acme.price-watcher')
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ error_code: 'INVALID_STATUS_TRANSITION' })
    );
  });

  it('PATCH activates an owned workflow with 200 and bumps version', async () => {
    const updated = { ...WORKFLOW_ROW, status: 'active', version: 2 };
    mockGetServerSupabaseClient.mockReturnValue(
      makeOwnerSupabase(WORKFLOW_ROW, { data: updated, error: null }).client
    );
    const { PATCH } = await import('./[workflowId]/route');
    const response = await PATCH(
      new Request('http://localhost/api/workflows/x', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'active' }),
      }),
      patchContext('user.mainnet.acme.price-watcher')
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('active');
    expect(body.version).toBe(2);
  });

  it('DELETE rejects without a JWT with 401', async () => {
    mockResolveRequestUser.mockResolvedValue(null);
    const { DELETE } = await import('./[workflowId]/route');
    const response = await DELETE(
      new Request('http://localhost/api/workflows/x', { method: 'DELETE' }),
      patchContext('user.mainnet.acme.price-watcher')
    );
    expect(response.status).toBe(401);
  });

  it('DELETE soft-deletes an owned workflow with 200', async () => {
    const { DELETE } = await import('./[workflowId]/route');
    const response = await DELETE(
      new Request('http://localhost/api/workflows/x', { method: 'DELETE' }),
      patchContext('user.mainnet.acme.price-watcher')
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workflow_id: 'user.mainnet.acme.price-watcher',
      status: 'deleted',
    });
  });
});
