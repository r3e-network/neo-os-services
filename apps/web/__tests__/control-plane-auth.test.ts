import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isAuthorizedControlPlaneRequest,
  isAuthorizedWorkflowRequest,
} from '../lib/control-plane-auth';

/**
 * Audit finding 19/20/30/31/37 — the low-privilege provider-config key must NOT
 * authorize control-plane execution (callback-broadcast, feed-tick, automation,
 * job reads). Only relayer/operator/admin-console credentials authorize these
 * routes. The runtime data-plane token does not.
 */

const ENV_KEYS = [
  'MORPHEUS_PROVIDER_CONFIG_API_KEY',
  'MORPHEUS_CONTROL_PLANE_API_KEY',
  'ADMIN_CONSOLE_API_KEY',
  'MORPHEUS_RELAYER_ADMIN_API_KEY',
  'MORPHEUS_RELAYER_API_KEY',
  'MORPHEUS_OPERATOR_API_KEY',
  'MORPHEUS_WORKFLOW_API_KEY',
  'MORPHEUS_APP_BACKEND_TOKEN',
  'MORPHEUS_CONTROL_PLANE_LEGACY_RUNTIME_TOKEN_COMPAT',
  'MORPHEUS_ALLOW_LEGACY_RUNTIME_CONTROL_PLANE',
  'MORPHEUS_RUNTIME_TOKEN',
  'NITRO_API_TOKEN',
  'NITRO_SHARED_SECRET',
  'NODE_ENV',
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

  it('rejects the runtime data-plane token on control-plane and workflow scopes', () => {
    process.env.MORPHEUS_RUNTIME_TOKEN = 'runtime-token-secret';
    expect(
      isAuthorizedControlPlaneRequest(makeRequest({ authorization: 'Bearer runtime-token-secret' }))
    ).toBe(false);
    expect(
      isAuthorizedWorkflowRequest(makeRequest({ 'x-admin-api-key': 'runtime-token-secret' }))
    ).toBe(false);
  });

  it('accepts an independent workflow credential', () => {
    process.env.MORPHEUS_WORKFLOW_API_KEY = 'workflow-secret';
    expect(
      isAuthorizedWorkflowRequest(makeRequest({ authorization: 'Bearer workflow-secret' }))
    ).toBe(true);
    expect(
      isAuthorizedControlPlaneRequest(makeRequest({ authorization: 'Bearer workflow-secret' }))
    ).toBe(false);
  });

  it('rejects a control-plane credential whose value reuses a runtime token', () => {
    process.env.MORPHEUS_RUNTIME_TOKEN = 'shared-secret';
    process.env.MORPHEUS_CONTROL_PLANE_API_KEY = 'shared-secret';
    process.env.MORPHEUS_WORKFLOW_API_KEY = 'shared-secret';

    expect(
      isAuthorizedControlPlaneRequest(makeRequest({ authorization: 'Bearer shared-secret' }))
    ).toBe(false);
    expect(
      isAuthorizedWorkflowRequest(makeRequest({ authorization: 'Bearer shared-secret' }))
    ).toBe(false);
  });

  it('allows explicit legacy runtime compatibility only outside production', () => {
    process.env.NODE_ENV = 'development';
    process.env.MORPHEUS_RUNTIME_TOKEN = 'runtime-token-secret';
    process.env.MORPHEUS_ALLOW_LEGACY_RUNTIME_CONTROL_PLANE = 'true';
    expect(
      isAuthorizedWorkflowRequest(makeRequest({ authorization: 'Bearer runtime-token-secret' }))
    ).toBe(true);

    process.env.NODE_ENV = 'production';
    expect(
      isAuthorizedWorkflowRequest(makeRequest({ authorization: 'Bearer runtime-token-secret' }))
    ).toBe(false);
  });

  it('rejects when nothing is configured', () => {
    expect(isAuthorizedControlPlaneRequest(makeRequest({ 'x-admin-api-key': 'anything' }))).toBe(
      false
    );
  });
});
