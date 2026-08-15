import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isChildProcessPermissionModelEnabled,
  parseAllowNet,
  validateChildProcessPermissions,
} from './permission-guard.js';

describe('parseAllowNet', () => {
  it('accepts specific hostnames', () => {
    const { entries, invalid } = parseAllowNet('api.example.com,localhost');
    assert.deepEqual(entries, ['api.example.com', 'localhost']);
    assert.deepEqual(invalid, []);
  });

  it('accepts hostnames with ports', () => {
    const { entries, invalid } = parseAllowNet('api.example.com:443');
    assert.deepEqual(entries, ['api.example.com:443']);
    assert.deepEqual(invalid, []);
  });

  it('accepts IPv4 addresses', () => {
    const { entries, invalid } = parseAllowNet('1.2.3.4,192.168.1.1:8080');
    assert.deepEqual(entries, ['1.2.3.4', '192.168.1.1:8080']);
    assert.deepEqual(invalid, []);
  });

  it('rejects wildcard entries', () => {
    const { invalid } = parseAllowNet('*,*.example.com,0.0.0.0/0,::/0');
    assert.deepEqual(invalid.sort(), ['*', '*.example.com', '0.0.0.0/0', '::/0'].sort());
  });

  it('rejects CIDR notation', () => {
    const { invalid } = parseAllowNet('10.0.0.0/8');
    assert.deepEqual(invalid, ['10.0.0.0/8']);
  });

  it('rejects malformed entries with spaces or empty labels', () => {
    const { invalid } = parseAllowNet('example..com, bad host');
    assert.deepEqual(invalid, ['example..com', 'bad host']);
  });
});

describe('isChildProcessPermissionModelEnabled', () => {
  const originalEnv = { ...process.env };

  function resetEnv() {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  }

  it('is enabled by default when nothing is set', () => {
    delete process.env.NODE_ENV;
    delete process.env.MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN;
    assert.equal(isChildProcessPermissionModelEnabled(), true);
    resetEnv();
  });

  it('is enabled by default in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN;
    assert.equal(isChildProcessPermissionModelEnabled(), true);
    resetEnv();
  });

  it('can be disabled by the explicit dev override when NOT production', () => {
    delete process.env.NODE_ENV;
    process.env.MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN = '1';
    assert.equal(isChildProcessPermissionModelEnabled(), false);
    resetEnv();
  });

  it('treats all truthy override values as disabled when NOT production', () => {
    delete process.env.NODE_ENV;
    for (const value of ['1', 'true', 'yes']) {
      process.env.MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN = value;
      assert.equal(isChildProcessPermissionModelEnabled(), false, `override=${value}`);
    }
    resetEnv();
  });

  it('stays enabled for non-truthy override values', () => {
    delete process.env.NODE_ENV;
    process.env.MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN = '0';
    assert.equal(isChildProcessPermissionModelEnabled(), true);
    resetEnv();
  });

  it('IGNORES the dev override when NODE_ENV=production (fail closed)', () => {
    process.env.NODE_ENV = 'production';
    process.env.MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN = '1';
    assert.equal(isChildProcessPermissionModelEnabled(), true);
    resetEnv();
  });
});

describe('validateChildProcessPermissions', () => {
  const originalEnv = { ...process.env };

  function resetEnv() {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  }

  it('throws when allow-net is a wildcard', () => {
    delete process.env.NODE_ENV;
    delete process.env.MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN;
    process.env.SCRIPT_CHILD_ALLOW_NET = '0.0.0.0/0';
    assert.throws(() => validateChildProcessPermissions(), /disallowed entries/);
    resetEnv();
  });

  it('throws when allow-net is a wildcard in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN;
    process.env.SCRIPT_CHILD_ALLOW_NET = '0.0.0.0/0';
    assert.throws(() => validateChildProcessPermissions(), /disallowed entries/);
    resetEnv();
  });

  it('allows valid allow-net', () => {
    delete process.env.NODE_ENV;
    delete process.env.MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN;
    process.env.SCRIPT_CHILD_ALLOW_NET = 'api.example.com';
    assert.doesNotThrow(() => validateChildProcessPermissions());
    resetEnv();
  });

  it('does not throw when the dev override disables the permission model outside production', () => {
    delete process.env.NODE_ENV;
    process.env.MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN = '1';
    delete process.env.SCRIPT_CHILD_ALLOW_NET;
    assert.doesNotThrow(() => validateChildProcessPermissions());
    resetEnv();
  });

  it('does not throw in production when the dev override is set (override is ignored, fail closed)', () => {
    process.env.NODE_ENV = 'production';
    process.env.MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN = '1';
    delete process.env.SCRIPT_CHILD_ALLOW_NET;
    assert.doesNotThrow(() => validateChildProcessPermissions());
    resetEnv();
  });

  it('no longer honors the retired SCRIPT_CHILD_ENABLE_PERMISSION_MODEL toggle', () => {
    // The old toggle cannot disable the permission model anymore: only the
    // explicit MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN dev override can.
    delete process.env.NODE_ENV;
    delete process.env.MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN;
    process.env.SCRIPT_CHILD_ENABLE_PERMISSION_MODEL = 'false';
    assert.equal(isChildProcessPermissionModelEnabled(), true);
    assert.doesNotThrow(() => validateChildProcessPermissions());
    resetEnv();
  });
});
