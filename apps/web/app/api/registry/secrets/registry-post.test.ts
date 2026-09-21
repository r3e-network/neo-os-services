import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRateLimitMap } from '@/lib/rate-limit';

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

function makeSupabaseClient(result: { single?: unknown } = {}) {
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
    maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
  };
  const client: any = { from: vi.fn(() => builder), auth: { getUser: vi.fn() } };
  return { client, builder };
}

const SECRET_ROW = {
  id: '9f1b4c9e-0000-4000-8000-000000000001',
  project_id: 'project-1',
  name: 'twelvedata-key',
  target_chain: 'neo_n3',
  encryption_algorithm: 'client-supplied-ciphertext',
  key_version: 1,
  metadata: {},
  network: 'mainnet',
  expires_at: null,
  created_at: '2026-08-13T00:00:00.000Z',
  updated_at: '2026-08-13T00:00:00.000Z',
};

function postBody(overrides: Record<string, unknown> = {}) {
  return {
    project_slug: 'acme',
    name: 'twelvedata-key',
    ciphertext: 'SEALED-CIPHERTEXT',
    target_chain: 'neo_n3',
    ...overrides,
  };
}

describe('secrets registry POST authz & validation', () => {
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
      new Request('http://localhost/api/registry/secrets', {
        method: 'POST',
        body: JSON.stringify(postBody()),
      })
    );
    expect(response.status).toBe(401);
  });

  it('rejects a missing ciphertext with 400', async () => {
    const { POST } = await import('./route');
    const response = await POST(
      new Request('http://localhost/api/registry/secrets', {
        method: 'POST',
        body: JSON.stringify(postBody({ ciphertext: '' })),
      })
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ error_code: 'INVALID_CIPHERTEXT' })
    );
  });

  it('rejects array metadata with 400', async () => {
    const { POST } = await import('./route');
    const response = await POST(
      new Request('http://localhost/api/registry/secrets', {
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
      new Request('http://localhost/api/registry/secrets', {
        method: 'POST',
        body: JSON.stringify(postBody()),
      })
    );
    expect(response.status).toBe(404);
  });

  it('stores a secret for an owner with 201 and never returns ciphertext', async () => {
    const { client } = makeSupabaseClient({ single: { data: SECRET_ROW, error: null } });
    mockGetServerSupabaseClient.mockReturnValue(client);
    const { POST } = await import('./route');
    const response = await POST(
      new Request('http://localhost/api/registry/secrets', {
        method: 'POST',
        body: JSON.stringify(postBody()),
      })
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.secret_ref).toBe(SECRET_ROW.id);
    expect(body).not.toHaveProperty('ciphertext');
    expect(body).not.toHaveProperty('project_id');
  });
});

// ===========================================================================
// SVC-C-5: this self-serve lane wrote every row unbound, so any leaked
// secret_ref was spendable from any requester/callback context.
// ===========================================================================

describe('secrets registry POST requester binding (SVC-C-5)', () => {
  const REQUESTER = `0x${'ab'.repeat(20)}`;
  const CALLBACK = `0x${'cd'.repeat(20)}`;

  function capturingClient() {
    const inserted: Record<string, unknown>[] = [];
    const builder: any = {
      insert: vi.fn((row: Record<string, unknown>) => {
        inserted.push(row);
        return builder;
      }),
      select: vi.fn(() => builder),
      single: vi.fn(() => Promise.resolve({ data: SECRET_ROW, error: null })),
    };
    return { client: { from: vi.fn(() => builder), auth: { getUser: vi.fn() } }, inserted };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    resetRateLimitMap();
    mockResolveRequestUser.mockResolvedValue({ id: 'user-1', email: null });
    mockResolveOwnedProjectId.mockResolvedValue('project-1');
  });

  async function post(body: Record<string, unknown>) {
    const { POST } = await import('./route');
    return POST(
      new Request('http://localhost/api/registry/secrets', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    );
  }

  it('records a normalized binding instead of writing an unbound row', async () => {
    const { client, inserted } = capturingClient();
    mockGetServerSupabaseClient.mockReturnValue(client);
    const response = await post(
      postBody({ network: 'mainnet', requester: REQUESTER.toUpperCase().replace('0X', '0x') })
    );
    expect(response.status).toBe(201);
    const metadata = inserted[0]?.metadata as Record<string, unknown>;
    expect(metadata.bound_requester).toBe(REQUESTER);
    expect(metadata.source).toBe('api.registry.secrets.post');
  });

  it('a caller metadata object cannot set the binding keys', async () => {
    const { client, inserted } = capturingClient();
    mockGetServerSupabaseClient.mockReturnValue(client);
    const response = await post(
      postBody({
        network: 'mainnet',
        callback_contract: CALLBACK,
        metadata: { bound_requester: REQUESTER, label: 'kept' },
      })
    );
    expect(response.status).toBe(201);
    const metadata = inserted[0]?.metadata as Record<string, unknown>;
    expect(metadata).not.toHaveProperty('bound_requester');
    expect(metadata.bound_callback_contract).toBe(CALLBACK);
    expect(metadata.label).toBe('kept');
  });

  it('rejects an unbound mainnet secret before it reaches Supabase', async () => {
    const { client, inserted } = capturingClient();
    mockGetServerSupabaseClient.mockReturnValue(client);
    const response = await post(postBody({ network: 'mainnet' }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ error_code: 'MISSING_SECRET_BINDING' })
    );
    expect(inserted).toHaveLength(0);
  });

  it('leaves the testnet development flow unbound and working', async () => {
    const { client, inserted } = capturingClient();
    mockGetServerSupabaseClient.mockReturnValue(client);
    const response = await post(postBody({ network: 'testnet' }));
    expect(response.status).toBe(201);
    expect(inserted[0]?.metadata).not.toHaveProperty('bound_requester');
  });
});
