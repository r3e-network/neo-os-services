import { describe, expect, it, vi } from 'vitest';

import { resolveOwnedProjectId } from './user-auth';

function makeSupabase(result: { maybeSingle?: unknown } = {}) {
  const builder: any = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(() => Promise.resolve(result.maybeSingle ?? { data: null, error: null })),
  };
  const client: any = { from: vi.fn(() => builder) };
  return { client, builder };
}

describe('resolveOwnedProjectId', () => {
  it('returns the project id when the user owns it', async () => {
    const { client } = makeSupabase({
      maybeSingle: { data: { id: 'project-1' }, error: null },
    });
    await expect(resolveOwnedProjectId(client, 'user-1', 'acme', 'mainnet')).resolves.toBe(
      'project-1'
    );
  });

  it('returns null for a missing or non-owned project (no ownership leak)', async () => {
    const { client } = makeSupabase({ maybeSingle: { data: null, error: null } });
    await expect(
      resolveOwnedProjectId(client, 'user-1', 'someone-else', 'mainnet')
    ).resolves.toBeNull();
  });

  it('propagates a database error so callers can fail closed', async () => {
    const { client } = makeSupabase({
      maybeSingle: { data: null, error: new Error('db offline') },
    });
    await expect(resolveOwnedProjectId(client, 'user-1', 'acme', 'mainnet')).rejects.toThrow(
      'db offline'
    );
  });
});
