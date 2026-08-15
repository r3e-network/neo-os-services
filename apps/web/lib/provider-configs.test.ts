import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getServerSupabaseClient: vi.fn(),
  loadProjectProviderConfig: vi.fn(),
  resolveSupabaseNetwork: vi.fn(),
}));

vi.mock('./server-supabase', () => ({
  getServerSupabaseClient: mocks.getServerSupabaseClient,
  loadProjectProviderConfig: mocks.loadProjectProviderConfig,
  resolveSupabaseNetwork: mocks.resolveSupabaseNetwork,
}));

import { resolveProviderAwarePayload } from './provider-configs';

describe('resolveProviderAwarePayload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getServerSupabaseClient.mockReturnValue({ from: vi.fn() });
    mocks.resolveSupabaseNetwork.mockReturnValue('mainnet');
    mocks.loadProjectProviderConfig.mockResolvedValue({
      provider_id: 'twelvedata',
      enabled: true,
      config: { require_attestation: false, endpoint: 'managed' },
    });
  });

  it('does not require provider storage without a project and provider pair', async () => {
    const payload = { url: 'https://example.test/data' };

    const result = await resolveProviderAwarePayload(payload);

    expect(result.payload).toBe(payload);
    expect(mocks.getServerSupabaseClient).not.toHaveBeenCalled();
  });

  it('does not let a caller disable an administrator-required attestation', async () => {
    mocks.loadProjectProviderConfig.mockResolvedValueOnce({
      provider_id: 'twelvedata',
      enabled: true,
      config: { require_attestation: true, endpoint: 'managed' },
    });

    const result = await resolveProviderAwarePayload({
      project_slug: 'demo',
      provider: 'twelvedata',
      require_attestation: false,
    });

    expect(result.payload.require_attestation).toBe(true);
    expect(result.payload).toHaveProperty('policy_decision');
    const policyDecision = (result.payload as Record<string, unknown>).policy_decision;
    expect((policyDecision as Record<string, unknown>).require_attestation).toBe(true);
  });

  it('allows a caller to strengthen an optional attestation policy', async () => {
    const result = await resolveProviderAwarePayload({
      project_slug: 'demo',
      provider: 'twelvedata',
      require_attestation: true,
    });

    expect(result.payload.require_attestation).toBe(true);
  });

  it('fails closed when provider storage is unavailable', async () => {
    mocks.getServerSupabaseClient.mockReturnValueOnce(null);

    await expect(
      resolveProviderAwarePayload({ project_slug: 'demo', provider: 'twelvedata' })
    ).rejects.toThrow('provider policy storage is unavailable');
  });

  it('fails closed when the provider lookup errors', async () => {
    mocks.loadProjectProviderConfig.mockRejectedValueOnce(new Error('database offline'));

    await expect(
      resolveProviderAwarePayload({ project_slug: 'demo', provider: 'twelvedata' })
    ).rejects.toThrow('provider policy lookup failed');
  });

  it('fails closed when the project has no provider policy', async () => {
    mocks.loadProjectProviderConfig.mockResolvedValueOnce(null);

    await expect(
      resolveProviderAwarePayload({ project_slug: 'demo', provider: 'twelvedata' })
    ).rejects.toThrow('provider twelvedata is not configured for project demo');
  });

  it('rejects unsupported and cross-deployment networks', async () => {
    await expect(
      resolveProviderAwarePayload({
        project_slug: 'demo',
        provider: 'twelvedata',
        network: 'devnet',
      })
    ).rejects.toThrow('network must be mainnet or testnet');

    await expect(
      resolveProviderAwarePayload({
        project_slug: 'demo',
        provider: 'twelvedata',
        network: 'testnet',
      })
    ).rejects.toThrow('provider policy network testnet does not match deployment network mainnet');
  });
});
