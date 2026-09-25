import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const networkConfig = (network) =>
  JSON.parse(fs.readFileSync(path.join(root, 'config', 'networks', `${network}.json`), 'utf8'))
    .neo_n3;

function assertSectionMagic(source, startMarker, endMarker, expectedMagic, relative) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${relative} is missing ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  assert.ok(end === -1 || end > start, `${relative} has an invalid section boundary`);
  const section = source.slice(start, end === -1 ? source.length : end);
  assert.match(section, new RegExp(`NEO_NETWORK_MAGIC=(?:\\\"|)${expectedMagic}`), relative);
}

test('deployment documents use the canonical network magic registry', () => {
  const testnetMagic = String(networkConfig('testnet').network_magic);
  const mainnetMagic = String(networkConfig('mainnet').network_magic);
  const documents = ['docs/DEPLOYMENT_CHECKLIST.md', 'docs/DEPLOYMENT_README.md'].map(
    (relative) => ({
      relative,
      source: fs.readFileSync(path.join(root, relative), 'utf8'),
    })
  );

  for (const { relative, source } of documents) {
    if (relative.endsWith('DEPLOYMENT_CHECKLIST.md')) {
      assertSectionMagic(
        source,
        '#### Testnet Deployment Checklist',
        '#### Mainnet Deployment Checklist',
        testnetMagic,
        relative
      );
      assertSectionMagic(source, '#### Mainnet Deployment Checklist', null, mainnetMagic, relative);
    } else {
      assertSectionMagic(
        source,
        '### Scenario 1: Testnet Development',
        '### Scenario 2:',
        testnetMagic,
        relative
      );
      assertSectionMagic(
        source,
        '### Scenario 2: Mainnet Production',
        '### Scenario 3:',
        mainnetMagic,
        relative
      );
    }
    assert.doesNotMatch(
      source,
      /1268474290|860834051/,
      `${relative} contains a retired network magic`
    );
  }
});
