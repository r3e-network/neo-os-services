import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isAuthorizedRuntimeRequest: vi.fn(),
  proxyToNitro: vi.fn(),
}));

vi.mock('@/lib/control-plane-auth', () => ({
  isAuthorizedRuntimeRequest: mocks.isAuthorizedRuntimeRequest,
}));
vi.mock('@/lib/nitro', () => ({ proxyToNitro: mocks.proxyToNitro }));
vi.mock('@/lib/rate-limit', () => ({
  createRateLimitedHandler:
    (handler: (request: Request) => Promise<Response>) => (request: Request) =>
      handler(request),
}));

import { POST as start } from '../app/api/game/start/route';
import { POST as move } from '../app/api/game/move/route';
import { POST as finalize } from '../app/api/game/finalize/route';

describe.each([
  ['start', start],
  ['move', move],
  ['finalize', finalize],
] as const)('game %s route', (_name, post) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAuthorizedRuntimeRequest.mockReturnValue(false);
  });

  it('rejects an ordinary public caller before proxying player-controlled data', async () => {
    const response = await post(
      new Request('https://neoos.test/api/game/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          player: '0x0102030405060708090a0b0c0d0e0f1011121314',
          game_id: '42',
        }),
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
    expect(mocks.proxyToNitro).not.toHaveBeenCalled();
  });
});
