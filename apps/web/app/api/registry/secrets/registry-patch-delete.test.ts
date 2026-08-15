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

const SECRET_ROW = {
  id: '9f1b4c9e-0000-4000-8000-000000000001',
  project_id: 'project-1',
  name: 'twelvedata-key',
  target_chain: 'neo_n3',
  encryption_algorithm: 'client-supplied-ciphertext',
  key_version: 1,
  ciphertext: 'SEALED-OLD',
  metadata: {},
  network: 'mainnet',
  expires_at: null,
  created_at: '2026-08-13T00:00:00.000Z',
  updated_at: '2026-08-13T00:00:00.000Z',
};

function makeOwnerSupabase(secretRow: unknown, updateResult: unknown = null) {
  const secretBuilder: any = {
    select: vi.fn(() => secretBuilder),
    eq: vi.fn(() => secretBuilder),
    maybeSingle: vi.fn(() => Promise.resolve({ data: secretRow, error: null })),
    update: vi.fn(() => secretBuilder),
    delete: vi.fn(() => secretBuilder),
    single: vi.fn(() => Promise.resolve(updateResult ?? { data: null, error: null })),
  };
  const projBuilder: any = {
    select: vi.fn(() => projBuilder),
    eq: vi.fn(() => projBuilder),
    maybeSingle: vi.fn(() => Promise.resolve({ data: { id: 'project-1' }, error: null })),
  };
  const client: any = {
    from: vi.fn((table: string) =>
      table === 'morpheus_encrypted_secrets' ? secretBuilder : projBuilder
    ),
    auth: { getUser: vi.fn() },
  };
  return { client, secretBuilder };
}

function secretContext(secretId: string) {
  return { params: Promise.resolve({ secretId }) };
}

describe('secrets registry PATCH/DELETE authz & rotation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetRateLimitMap();
    mockGetServerSupabaseClient.mockReturnValue(makeOwnerSupabase(SECRET_ROW).client);
    mockResolveRequestUser.mockResolvedValue({ id: 'user-1', email: null });
  });

  it('PATCH rejects without a JWT with 401', async () => {
    mockResolveRequestUser.mockResolvedValue(null);
    const { PATCH } = await import('./[secretId]/route');
    const response = await PATCH(
      new Request('http://localhost/api/registry/secrets/x', {
        method: 'PATCH',
        body: JSON.stringify({ ciphertext: 'SEALED-NEW' }),
      }),
      secretContext('9f1b4c9e-0000-4000-8000-000000000001')
    );
    expect(response.status).toBe(401);
  });

  it('PATCH returns 404 for a non-owned secret', async () => {
    mockGetServerSupabaseClient.mockReturnValue(makeOwnerSupabase(null).client);
    const { PATCH } = await import('./[secretId]/route');
    const response = await PATCH(
      new Request('http://localhost/api/registry/secrets/x', {
        method: 'PATCH',
        body: JSON.stringify({ ciphertext: 'SEALED-NEW' }),
      }),
      secretContext('9f1b4c9e-0000-4000-8000-000000000001')
    );
    expect(response.status).toBe(404);
  });

  it('PATCH rotates ciphertext with 200, bumps key_version, never returns ciphertext', async () => {
    const rotated = { ...SECRET_ROW, ciphertext: 'SEALED-NEW', key_version: 2 };
    mockGetServerSupabaseClient.mockReturnValue(
      makeOwnerSupabase(SECRET_ROW, { data: rotated, error: null }).client
    );
    const { PATCH } = await import('./[secretId]/route');
    const response = await PATCH(
      new Request('http://localhost/api/registry/secrets/x', {
        method: 'PATCH',
        body: JSON.stringify({ ciphertext: 'SEALED-NEW' }),
      }),
      secretContext('9f1b4c9e-0000-4000-8000-000000000001')
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.key_version).toBe(2);
    expect(body).not.toHaveProperty('ciphertext');
  });

  it('DELETE rejects without a JWT with 401', async () => {
    mockResolveRequestUser.mockResolvedValue(null);
    const { DELETE } = await import('./[secretId]/route');
    const response = await DELETE(
      new Request('http://localhost/api/registry/secrets/x', { method: 'DELETE' }),
      secretContext('9f1b4c9e-0000-4000-8000-000000000001')
    );
    expect(response.status).toBe(401);
  });

  it('DELETE removes an owned secret with 200', async () => {
    const { DELETE } = await import('./[secretId]/route');
    const response = await DELETE(
      new Request('http://localhost/api/registry/secrets/x', { method: 'DELETE' }),
      secretContext('9f1b4c9e-0000-4000-8000-000000000001')
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      secret_ref: '9f1b4c9e-0000-4000-8000-000000000001',
      deleted: true,
    });
  });
});
