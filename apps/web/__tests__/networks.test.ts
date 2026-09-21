import { afterEach, describe, expect, it, vi } from 'vitest';

// Every case below sets BOTH network variables explicitly. lib/networks reads
// NEXT_PUBLIC_MORPHEUS_NETWORK first and falls back to MORPHEUS_NETWORK, so a
// case that stubs only one of them silently inherits the other from the shell
// (or from a future default) and stops testing what it claims to. Keeping both
// pinned here is what lets the rest of the suite set a network of its own
// without weakening these assertions.
describe('network selection', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('lets explicit URL/network overrides win over env defaults', async () => {
    vi.stubEnv('NEXT_PUBLIC_MORPHEUS_NETWORK', '');
    vi.stubEnv('MORPHEUS_NETWORK', 'mainnet');
    const { getSelectedNetwork, getSelectedNetworkKey } = await import('../lib/networks');

    expect(getSelectedNetworkKey()).toBe('mainnet');
    expect(getSelectedNetworkKey('testnet')).toBe('testnet');
    expect(getSelectedNetwork('testnet').network).toBe('testnet');
  });

  it('normalizes network env values instead of treating casing as testnet', async () => {
    vi.stubEnv('NEXT_PUBLIC_MORPHEUS_NETWORK', '');
    vi.stubEnv('MORPHEUS_NETWORK', ' MAINNET ');
    const { getSelectedNetworkKey } = await import('../lib/networks');

    expect(getSelectedNetworkKey()).toBe('mainnet');
  });

  it('fails fast on an invalid MORPHEUS_NETWORK instead of silently selecting testnet', async () => {
    vi.stubEnv('NEXT_PUBLIC_MORPHEUS_NETWORK', '');
    vi.stubEnv('MORPHEUS_NETWORK', 'mainet');
    const { getSelectedNetworkKey } = await import('../lib/networks');

    expect(() => getSelectedNetworkKey()).toThrow(/Invalid MORPHEUS_NETWORK/);
  });

  it('fails closed when no network env is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_MORPHEUS_NETWORK', '');
    vi.stubEnv('MORPHEUS_NETWORK', '');
    const { getSelectedNetworkKey } = await import('../lib/networks');

    expect(() => getSelectedNetworkKey()).toThrow(/MORPHEUS_NETWORK/);
  });

  it('validates network query params via isKnownNetworkKey', async () => {
    const { isKnownNetworkKey, normalizeNetworkKey } = await import('../lib/networks');

    expect(isKnownNetworkKey('testnet')).toBe(true);
    expect(isKnownNetworkKey(' MainNet ')).toBe(true);
    expect(isKnownNetworkKey('banana')).toBe(false);
    expect(isKnownNetworkKey('')).toBe(false);
    expect(isKnownNetworkKey(null)).toBe(false);
    expect(normalizeNetworkKey('TESTNET')).toBe('testnet');
    expect(normalizeNetworkKey('mainet')).toBeNull();
  });
});
