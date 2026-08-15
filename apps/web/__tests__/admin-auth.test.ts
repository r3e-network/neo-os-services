import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAuthorizedAdminRequest } from '../lib/server-supabase';

/**
 * A3/E2 — admin/edge token checks must use constant-time comparison and still
 * accept the correct key via both header and bearer forms across every
 * configured scope.
 */

const ENV_KEYS = [
  'MORPHEUS_PROVIDER_CONFIG_API_KEY',
  'ADMIN_CONSOLE_API_KEY',
  'MORPHEUS_RELAYER_ADMIN_API_KEY',
  'MORPHEUS_OPERATOR_API_KEY',
  'MORPHEUS_SIGNING_ADMIN_API_KEY',
  'MORPHEUS_RELAY_ADMIN_API_KEY',
];

const saved: Record<string, string | undefined> = {};

function makeRequest(headers: Record<string, string>) {
  return new Request('https://example.test/api/admin', { headers });
}

describe('isAuthorizedAdminRequest constant-time auth', () => {
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

  it('rejects when no admin keys are configured', () => {
    expect(isAuthorizedAdminRequest(makeRequest({ 'x-admin-api-key': 'anything' }))).toBe(false);
  });

  it('accepts the correct key via x-admin-api-key header', () => {
    process.env.MORPHEUS_PROVIDER_CONFIG_API_KEY = 'correct-secret-value';
    expect(
      isAuthorizedAdminRequest(makeRequest({ 'x-admin-api-key': 'correct-secret-value' }))
    ).toBe(true);
  });

  it('accepts the correct key via Authorization Bearer header', () => {
    process.env.MORPHEUS_PROVIDER_CONFIG_API_KEY = 'correct-secret-value';
    expect(
      isAuthorizedAdminRequest(makeRequest({ authorization: 'Bearer correct-secret-value' }))
    ).toBe(true);
  });

  it('rejects an equal-length but mismatched key (no early-out leak)', () => {
    process.env.MORPHEUS_PROVIDER_CONFIG_API_KEY = 'correct-secret-value';
    // Same length as the configured key, differs only in the last character.
    expect(
      isAuthorizedAdminRequest(makeRequest({ 'x-admin-api-key': 'correct-secret-valuX' }))
    ).toBe(false);
  });

  it('rejects a wrong-length key', () => {
    process.env.MORPHEUS_PROVIDER_CONFIG_API_KEY = 'correct-secret-value';
    expect(isAuthorizedAdminRequest(makeRequest({ 'x-admin-api-key': 'short' }))).toBe(false);
  });

  it('honors per-scope key resolution', () => {
    process.env.MORPHEUS_SIGNING_ADMIN_API_KEY = 'signing-scope-key';
    // The signing key must not authorize the provider_config scope.
    expect(
      isAuthorizedAdminRequest(
        makeRequest({ 'x-admin-api-key': 'signing-scope-key' }),
        'provider_config'
      )
    ).toBe(false);
    // But it must authorize the sign_payload scope.
    expect(
      isAuthorizedAdminRequest(
        makeRequest({ 'x-admin-api-key': 'signing-scope-key' }),
        'sign_payload'
      )
    ).toBe(true);
  });
});
