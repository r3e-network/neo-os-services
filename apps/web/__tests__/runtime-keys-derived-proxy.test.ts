import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isAuthorizedRuntimeRequest: vi.fn(),
  proxyToNitro: vi.fn(),
  createRateLimitedHandler: vi.fn((handler: unknown) => handler),
}));

vi.mock('@/lib/control-plane-auth', () => ({
  isAuthorizedRuntimeRequest: mocks.isAuthorizedRuntimeRequest,
}));
vi.mock('@/lib/nitro', () => ({ proxyToNitro: mocks.proxyToNitro }));
vi.mock('@/lib/rate-limit', () => ({
  createRateLimitedHandler: mocks.createRateLimitedHandler,
}));

// `/api/runtime/keys/derived` was the one baselined dead proxy that was a
// method mismatch rather than a missing route: the host serves `/keys/derived`
// for POST only — `classify` falls through to `Target::NotFound` on a method
// mismatch — and this proxy sent GET, so an authorised caller got the host 404.
// Repair is the proxy's method, not a host change.
//
// The host also reads `role` from the JSON body (`handle_keys_derived` looks at
// `role` / `key_role` / `dstack_key_role`) and never at the query string, so the
// proxy has to carry the role in the body or the documented `?role=` selection
// would be silently dropped on the way through.
describe('/api/runtime/keys/derived', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.isAuthorizedRuntimeRequest.mockReset();
    mocks.proxyToNitro.mockReset();
    mocks.createRateLimitedHandler.mockImplementation((handler: unknown) => handler);
    mocks.isAuthorizedRuntimeRequest.mockReturnValue(true);
    mocks.proxyToNitro.mockResolvedValue(new Response('{}', { status: 200 }));
  });

  it('sends POST /keys/derived with the role in the body', async () => {
    const { GET } = await import('../app/api/runtime/keys/derived/route');
    await GET(new Request('https://neoos.test/api/runtime/keys/derived?role=oracle_verifier'));

    expect(mocks.proxyToNitro).toHaveBeenCalledTimes(1);
    const [target, init] = mocks.proxyToNitro.mock.calls[0];
    expect(target).toBe('/keys/derived');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ role: 'oracle_verifier' });
  });

  it('defaults the role to worker and never sends GET', async () => {
    const { GET } = await import('../app/api/runtime/keys/derived/route');
    await GET(new Request('https://neoos.test/api/runtime/keys/derived'));

    const [target, init] = mocks.proxyToNitro.mock.calls[0];
    expect(target).toBe('/keys/derived');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ role: 'worker' });
  });

  it('still refuses an unauthenticated caller before proxying', async () => {
    mocks.isAuthorizedRuntimeRequest.mockReturnValue(false);
    const { GET } = await import('../app/api/runtime/keys/derived/route');
    const response = await GET(
      new Request('https://neoos.test/api/runtime/keys/derived?role=worker')
    );

    expect(response.status).toBe(401);
    expect(mocks.proxyToNitro).not.toHaveBeenCalled();
  });
});
