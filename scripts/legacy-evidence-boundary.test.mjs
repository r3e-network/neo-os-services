import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';

const root = new URL('../', import.meta.url);

test('unsupported Cypress draft is preserved outside executable discovery', async () => {
  await assert.rejects(access(new URL('tests/cypress/e2e/neoswap-v2.cy.js', root)), {
    code: 'ENOENT',
  });
  const original = await readFile(new URL('docs/legacy-unverified/neoswap-v2.cy.js.txt', root));
  assert.equal(
    createHash('sha256').update(original).digest('hex'),
    'ab062fe812123a55f48f2c49a7fd5242ad6af057120655cf376fd05e1aa21787'
  );
});

test('signer OpenAPI preserves the raw-signing warning as a YAML scalar', async () => {
  const api = yaml.load(await readFile(new URL('docs/api/neo-signer-openapi.yaml', root), 'utf8'));
  assert.equal(
    api.components.schemas.PolicyBody.properties.allow_raw.description,
    'WARNING: Allows blind signing of raw bytes'
  );
});
