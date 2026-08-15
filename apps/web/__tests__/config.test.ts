import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('appConfig security boundaries', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('MORPHEUS_NETWORK', 'testnet');
    // Pin every accepted token source so the assertions are deterministic
    // regardless of the developer shell environment.
    vi.stubEnv('MORPHEUS_RUNTIME_TOKEN', '');
    vi.stubEnv('NITRO_API_TOKEN', '');
    vi.stubEnv('NITRO_SHARED_SECRET', '');
    // PHALA_API_TOKEN / PHALA_SHARED_SECRET are no longer accepted as token
    // sources (revoked Phala credentials), so they are not stubbed here.
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('ignores NEXT_PUBLIC_MORPHEUS_RUNTIME_TOKEN as a bearer secret source', async () => {
    vi.stubEnv('NEXT_PUBLIC_MORPHEUS_RUNTIME_TOKEN', 'browser-inlined-token');

    const { appConfig } = await import('../lib/config');

    expect(appConfig.nitroToken).toBe('');
  });

  it('still reads the server-only runtime token env names', async () => {
    vi.stubEnv('MORPHEUS_RUNTIME_TOKEN', 'server-token');

    const { appConfig } = await import('../lib/config');

    expect(appConfig.nitroToken).toBe('server-token');
  });

  it('no longer accepts revoked Phala credentials as runtime/control-plane tokens', async () => {
    // Pin the other control-plane key sources empty so the only candidate
    // values are the revoked Phala credentials.
    vi.stubEnv('MORPHEUS_CONTROL_PLANE_API_KEY', '');
    vi.stubEnv('MORPHEUS_PROVIDER_CONFIG_API_KEY', '');
    vi.stubEnv('MORPHEUS_OPERATOR_API_KEY', '');
    vi.stubEnv('ADMIN_CONSOLE_API_KEY', '');
    vi.stubEnv('PHALA_API_TOKEN', 'revoked-phala-token');
    vi.stubEnv('PHALA_SHARED_SECRET', 'revoked-phala-secret');

    const { appConfig } = await import('../lib/config');

    expect(appConfig.nitroToken).toBe('');
    expect(appConfig.controlPlaneApiKey).toBe('');
  });

  it('refuses to load in a browser context', async () => {
    vi.stubGlobal('window', {});

    await expect(import('../lib/config')).rejects.toThrow(/server-only/);
  });

  it('exposes only browser-safe values from lib/public-config', async () => {
    const { publicConfig } = await import('../lib/public-config');

    expect(Object.keys(publicConfig).sort()).toEqual([
      'appUrl',
      'name',
      'supabaseAnonKey',
      'supabaseUrl',
    ]);
  });
});
