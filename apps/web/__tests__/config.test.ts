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
    vi.stubEnv('MORPHEUS_WORKFLOW_API_KEY', '');
    vi.stubEnv('MORPHEUS_APP_BACKEND_TOKEN', '');
    vi.stubEnv('MORPHEUS_CONTROL_PLANE_API_KEY', '');
    vi.stubEnv('MORPHEUS_OPERATOR_API_KEY', '');
    vi.stubEnv('ADMIN_CONSOLE_API_KEY', '');
    vi.stubEnv('MORPHEUS_RELAYER_API_KEY', '');
    vi.stubEnv('MORPHEUS_RELAYER_ADMIN_API_KEY', '');
    vi.stubEnv('MORPHEUS_SIGNING_ADMIN_API_KEY', '');
    vi.stubEnv('MORPHEUS_RELAY_ADMIN_API_KEY', '');
    vi.stubEnv('SIGNER_SERVICE_TOKEN', '');
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

  it('does not grant control-plane authority to the runtime token', async () => {
    vi.stubEnv('MORPHEUS_RUNTIME_TOKEN', 'runtime-only-token');
    vi.stubEnv('MORPHEUS_CONTROL_PLANE_API_KEY', 'runtime-only-token');
    vi.stubEnv('MORPHEUS_OPERATOR_API_KEY', '');

    const { appConfig } = await import('../lib/config');

    expect(appConfig.nitroToken).toBe('runtime-only-token');
    expect(appConfig.controlPlaneApiKey).toBe('');
  });

  it('fails closed in production when credentials collide across trust domains', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MORPHEUS_RUNTIME_URL_TESTNET', 'https://confidential.example.test');
    vi.stubEnv('MORPHEUS_RUNTIME_TOKEN', 'shared-secret');
    vi.stubEnv('MORPHEUS_CONTROL_PLANE_API_KEY', 'shared-secret');
    vi.stubEnv('MORPHEUS_OPERATOR_API_KEY', '');

    await expect(import('../lib/config')).rejects.toThrow(/pairwise distinct/i);
  });

  it('does not append public Nitro fallbacks in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MORPHEUS_RUNTIME_URL', '');
    vi.stubEnv('MORPHEUS_RUNTIME_URL_TESTNET', '');
    vi.stubEnv('MORPHEUS_TESTNET_RUNTIME_URL', 'https://confidential.example.test');
    vi.stubEnv('NEXT_PUBLIC_MORPHEUS_RUNTIME_URL', '');
    vi.stubEnv('NEXT_PUBLIC_MORPHEUS_RUNTIME_URL_TESTNET', '');

    const { appConfig } = await import('../lib/config');

    expect(appConfig.nitroApiUrls).toEqual(['https://confidential.example.test']);
    expect(appConfig.nitroApiUrls).not.toContain('https://oracle.meshmini.app/testnet');
    expect(appConfig.nitroApiUrls).not.toContain('https://edge.meshmini.app/testnet');
  });

  it('does not promote a NEXT_PUBLIC URL into the production confidential route', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MORPHEUS_RUNTIME_URL', '');
    vi.stubEnv('MORPHEUS_RUNTIME_URL_TESTNET', '');
    vi.stubEnv('MORPHEUS_TESTNET_RUNTIME_URL', '');
    vi.stubEnv('NEXT_PUBLIC_MORPHEUS_RUNTIME_URL', 'https://oracle.meshmini.app/testnet');
    vi.stubEnv('NEXT_PUBLIC_MORPHEUS_RUNTIME_URL_TESTNET', '');

    const { appConfig } = await import('../lib/config');

    expect(appConfig.nitroApiUrl).toBe('');
    expect(appConfig.nitroApiUrls).toEqual([]);
    expect(appConfig.publicNitroApiUrls).toContain('https://oracle.meshmini.app/testnet');
  });

  it('rejects host signer material in the production web process', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MORPHEUS_RELAYER_NEO_N3_WIF', 'test-host-key');

    await expect(import('../lib/config')).rejects.toThrow(
      /host signing key configuration.*forbidden/i
    );
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
