import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAuthorizedControlPlaneRequest } from '../lib/control-plane-auth';

/**
 * Audit finding 19/20/30/31/37 — the low-privilege provider-config key must NOT
 * authorize control-plane execution (callback-broadcast, feed-tick, automation,
 * job reads). Only the relayer_ops scope (relayer/operator/admin-console keys)
 * and the MORPHEUS_* runtime token are accepted.
 */

const ENV_KEYS = [
  'MORPHEUS_PROVIDER_CONFIG_API_KEY',
  'ADMIN_CONSOLE_API_KEY',
  'MORPHEUS_RELAYER_ADMIN_API_KEY',
  'MORPHEUS_OPERATOR_API_KEY',
  'MORPHEUS_RUNTIME_TOKEN',
];

const saved: Record<string, string | undefined> = {};

function makeRequest(headers: Record<string, string>) {
  return new Request('https://example.test/api/control-plane/callbacks/broadcast', { headers });
}

describe('isAuthorizedControlPlaneRequest scope separation', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('rejects a provider-config-only key (no longer grants control-plane authority)', () => {
    process.env.MORPHEUS_PROVIDER_CONFIG_API_KEY = 'provider-config-secret';
    expect(
      isAuthorizedControlPlaneRequest(makeRequest({ 'x-admin-api-key': 'provider-config-secret' }))
    ).toBe(false);
    expect(
      isAuthorizedControlPlaneRequest(
        makeRequest({ authorization: 'Bearer provider-config-secret' })
      )
    ).toBe(false);
  });

  it('accepts relayer_ops keys (relayer / operator / admin-console)', () => {
    process.env.MORPHEUS_OPERATOR_API_KEY = 'operator-secret';
    expect(
      isAuthorizedControlPlaneRequest(makeRequest({ 'x-admin-api-key': 'operator-secret' }))
    ).toBe(true);

    delete process.env.MORPHEUS_OPERATOR_API_KEY;
    process.env.ADMIN_CONSOLE_API_KEY = 'admin-console-secret';
    expect(
      isAuthorizedControlPlaneRequest(makeRequest({ authorization: 'Bearer admin-console-secret' }))
    ).toBe(true);

    delete process.env.ADMIN_CONSOLE_API_KEY;
    process.env.MORPHEUS_RELAYER_ADMIN_API_KEY = 'relayer-admin-secret';
    expect(
      isAuthorizedControlPlaneRequest(makeRequest({ 'x-admin-api-key': 'relayer-admin-secret' }))
    ).toBe(true);
  });

  it('accepts the MORPHEUS_* runtime token', () => {
    process.env.MORPHEUS_RUNTIME_TOKEN = 'runtime-token-secret';
    expect(
      isAuthorizedControlPlaneRequest(makeRequest({ authorization: 'Bearer runtime-token-secret' }))
    ).toBe(true);
    expect(
      isAuthorizedControlPlaneRequest(makeRequest({ 'x-admin-api-key': 'runtime-token-secret' }))
    ).toBe(true);
  });

  it('rejects when nothing is configured', () => {
    expect(isAuthorizedControlPlaneRequest(makeRequest({ 'x-admin-api-key': 'anything' }))).toBe(
      false
    );
  });
});
