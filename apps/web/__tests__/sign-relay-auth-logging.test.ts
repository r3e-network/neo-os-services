import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isAuthorizedAdminRequest: vi.fn(),
  proxyToNitro: vi.fn(),
  recordOperationLog: vi.fn(),
}));

vi.mock('@/lib/server-supabase', () => ({
  isAuthorizedAdminRequest: mocks.isAuthorizedAdminRequest,
}));
vi.mock('@/lib/nitro', () => ({ proxyToNitro: mocks.proxyToNitro }));
vi.mock('@/lib/operation-logs', () => ({ recordOperationLog: mocks.recordOperationLog }));

describe.each([
  {
    name: 'sign payload',
    route: '/api/sign/payload',
    scope: 'sign_payload',
    load: () => import('../app/api/sign/payload/route'),
  },
  {
    name: 'relay transaction',
    route: '/api/relay/transaction',
    scope: 'relay_transaction',
    load: () => import('../app/api/relay/transaction/route'),
  },
])('$name authorization', ({ route, scope, load }) => {
  beforeEach(() => {
    vi.resetModules();
    mocks.isAuthorizedAdminRequest.mockReset();
    mocks.proxyToNitro.mockReset();
    mocks.recordOperationLog.mockReset();
  });

  it('rejects before logging an attacker-controlled payload with the service role', async () => {
    mocks.isAuthorizedAdminRequest.mockReturnValue(false);
    const { POST } = await load();
    const response = await POST(
      new Request(`https://neoos.test${route}`, {
        method: 'POST',
        body: JSON.stringify({
          target_chain: 'unsupported-chain',
          encrypted_inputs: { private_key: 'KxATTACKERcontrolled' },
        }),
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
    expect(mocks.isAuthorizedAdminRequest).toHaveBeenCalledWith(expect.any(Request), scope);
    expect(mocks.recordOperationLog).not.toHaveBeenCalled();
    expect(mocks.proxyToNitro).not.toHaveBeenCalled();
  });
});
