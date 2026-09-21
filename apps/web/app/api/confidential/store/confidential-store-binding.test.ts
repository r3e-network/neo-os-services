import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRateLimitMap } from '@/lib/rate-limit';

vi.mock('server-only', () => ({}));

const mockAuthorizeProjectAccess = vi.fn();

vi.mock('@/lib/registry-access', () => ({
  authorizeProjectAccess: (...args: unknown[]) => mockAuthorizeProjectAccess(...args),
}));

vi.mock('@/lib/operation-logs', () => ({
  recordOperationLog: vi.fn(async () => undefined),
}));

vi.mock('@/lib/server-supabase', () => ({
  resolveSupabaseNetwork: (value?: string | null) =>
    String(value || '').trim() === 'mainnet' ? 'mainnet' : 'testnet',
}));

const INSERTED = {
  id: '9f1b4c9e-0000-4000-8000-000000000042',
  name: 'oracle-key',
  target_chain: 'neo_n3',
  encryption_algorithm: 'client-supplied-ciphertext',
  created_at: '2026-09-01T00:00:00.000Z',
};

/** Capture the row the handler actually hands to Supabase. */
function makeSupabase() {
  const inserted: Record<string, unknown>[] = [];
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    insert: vi.fn((row: Record<string, unknown>) => {
      inserted.push(row);
      return builder;
    }),
    select: vi.fn(() => builder),
    single: vi.fn(async () => ({ data: INSERTED, error: null })),
  });
  return { supabase: { from: vi.fn(() => builder) }, inserted };
}

const REQUESTER = `0x${'ab'.repeat(20)}`;
const CALLBACK = `0x${'cd'.repeat(20)}`;

function storeBody(overrides: Record<string, unknown> = {}) {
  return {
    project_slug: 'acme',
    ciphertext: 'SEALED-CIPHERTEXT',
    target_chain: 'neo_n3',
    network: 'mainnet',
    requester: REQUESTER,
    ...overrides,
  };
}

async function post(body: Record<string, unknown>) {
  const { POST } = await import('./route');
  return POST(
    new Request('http://localhost/api/confidential/store', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
}

describe('POST /api/confidential/store — requester binding (SVC-C-5)', () => {
  let inserted: Record<string, unknown>[];

  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimitMap();
    const store = makeSupabase();
    inserted = store.inserted;
    mockAuthorizeProjectAccess.mockResolvedValue({
      ok: true,
      projectId: 'project-1',
      supabase: store.supabase,
      via: 'owner',
    });
  });

  it('a caller metadata object cannot neuter the binding the server computed', async () => {
    const response = await post(
      storeBody({ metadata: { bound_requester: 'anything-non-hash160', note: 'kept' } })
    );
    expect(response.status).toBe(200);

    const metadata = inserted[0]?.metadata as Record<string, unknown>;
    // Before the fix the caller's object was spread LAST, so this read back
    // 'anything-non-hash160' — which normalizes to empty at read time, and the
    // enclave then skips the scope check entirely.
    expect(metadata.bound_requester).toBe(REQUESTER);
    expect(metadata.note).toBe('kept');
    expect(metadata.source).toBe('api.confidential.store');
  });

  it('a caller cannot forge a binding the server did not compute', async () => {
    const response = await post(
      storeBody({
        requester: undefined,
        callback_contract: CALLBACK,
        metadata: { bound_requester: REQUESTER },
      })
    );
    expect(response.status).toBe(200);
    const metadata = inserted[0]?.metadata as Record<string, unknown>;
    expect(metadata).not.toHaveProperty('bound_requester');
    expect(metadata.bound_callback_contract).toBe(CALLBACK);
  });

  it('rejects an unbound mainnet ciphertext', async () => {
    const response = await post(storeBody({ requester: undefined }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ error_code: 'MISSING_SECRET_BINDING' })
    );
    expect(inserted).toHaveLength(0);
  });

  it('still accepts an unbound testnet ciphertext', async () => {
    const response = await post(storeBody({ network: 'testnet', requester: undefined }));
    expect(response.status).toBe(200);
    const metadata = inserted[0]?.metadata as Record<string, unknown>;
    expect(metadata).not.toHaveProperty('bound_requester');
    expect(metadata.network).toBe('testnet');
  });

  it('keeps the binding out of the ciphertext path and echoes it to the caller', async () => {
    const response = await post(storeBody({ callback_contract: CALLBACK }));
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.bound_requester).toBe(REQUESTER);
    expect(body.bound_callback_contract).toBe(CALLBACK);
    expect(body).not.toHaveProperty('ciphertext');
  });
});
