import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCredentialDomainsDistinct,
  findCredentialDomainCollisions,
  formatCredentialDomainCollisions,
} from './credential-separation.js';

test('aliases inside one domain may share a value', () => {
  const collisions = findCredentialDomainCollisions({
    MORPHEUS_RUNTIME_TOKEN: 'same-runtime',
    NITRO_API_TOKEN: 'same-runtime',
    MORPHEUS_CONTROL_PLANE_API_KEY: 'operator-only',
  });
  assert.deepEqual(collisions, []);
});

test('a value reused across trust domains is reported', () => {
  const collisions = findCredentialDomainCollisions({
    MORPHEUS_RUNTIME_TOKEN: 'shared',
    MORPHEUS_CONTROL_PLANE_API_KEY: 'shared',
    MORPHEUS_RELAYER_API_KEY: 'relayer',
  });
  assert.equal(collisions.length, 1);
  assert.deepEqual(collisions[0].domains, ['operator', 'runtime']);
  assert.deepEqual(collisions[0].names, [
    'MORPHEUS_CONTROL_PLANE_API_KEY',
    'MORPHEUS_RUNTIME_TOKEN',
  ]);
});

test('assertCredentialDomainsDistinct fails closed on collision', () => {
  assert.throws(
    () =>
      assertCredentialDomainsDistinct({
        MORPHEUS_RUNTIME_TOKEN: 'x',
        SIGNER_SERVICE_TOKEN: 'x',
      }),
    /pairwise distinct|SIGNER_SERVICE_TOKEN|MORPHEUS_RUNTIME_TOKEN/
  );
});

test('formatCredentialDomainCollisions joins colliding names', () => {
  const text = formatCredentialDomainCollisions([
    { domains: ['a', 'b'], names: ['A', 'B'] },
    { domains: ['c', 'd'], names: ['C', 'D'] },
  ]);
  assert.equal(text, 'A, B; C, D');
});
