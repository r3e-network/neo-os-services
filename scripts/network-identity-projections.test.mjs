import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  renderCSharpNetworkIdentities,
  projectProtocolNetwork,
} from './lib/network-identity-projections.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = (mainnet = 860833102, testnet = 894710606) => ({
  schemaVersion: 1,
  networks: { mainnet: { magic: mainnet }, testnet: { magic: testnet } },
});

test('C# projection keeps fixed namespace, uint constants and reviewed values', () => {
  const source = renderCSharpNetworkIdentities(catalog());
  assert.match(source, /namespace NeoOS\.Networks;/);
  assert.match(source, /public static class NeoN3NetworkIdentity/);
  assert.match(source, /public const uint MainnetMagic = 860833102u;/);
  assert.match(source, /public const uint TestnetMagic = 894710606u;/);
  assert.match(renderCSharpNetworkIdentities(catalog(17, 19)), /MainnetMagic = 17u;/);
  assert.doesNotMatch(source, /HttpClient|System\.Net|NeoOS\.App|NeoOS\.Tools/);
});

test('C# renderer and protocol projection refuse invalid or injectable magic', () => {
  for (const bad of [
    0,
    -1,
    1.5,
    4294967296,
    '860833102',
    Infinity,
    NaN,
    null,
    undefined,
    '1; invalid',
  ]) {
    const invalid = catalog();
    invalid.networks.mainnet.magic = bad;
    assert.throws(() => renderCSharpNetworkIdentities(invalid));
    assert.throws(() => projectProtocolNetwork('{"ProtocolConfiguration":{"Network":1}}', bad));
  }
});

test('protocol projection replaces only the decimal token and preserves all other bytes', () => {
  const before =
    '{\r\n  "ProtocolConfiguration" : { "Network" : 7, "InitialGasDistribution":900719925474099312345, "Label":"测试\\n文本", "SeedList":["a","b"] }\r\n}\r\n';
  const after = projectProtocolNetwork(before, 860833102);
  assert.equal(after, before.replace('"Network" : 7', '"Network" : 860833102'));
  assert.equal(projectProtocolNetwork(after, 860833102), after);
});

test('uncertain protocol shapes, duplicate or escaped duplicate keys are rejected', () => {
  const invalid = [
    '[]',
    '{}',
    '{"ProtocolConfiguration":{}}',
    '{"Network":7}',
    '{"ProtocolConfiguration":{"Network":"7"}}',
    '{"ProtocolConfiguration":{"Network":-7}}',
    '{"ProtocolConfiguration":{"Network":7.0}}',
    '{"ProtocolConfiguration":{"Network":7e0}}',
    '{"ProtocolConfiguration":{"Network":7,"Network":8}}',
    '{"ProtocolConfiguration":{"Network":7,"Netw\\u006frk":8}}',
    '{"ProtocolConfiguration":{"Network":7},"Other":{"Network":8}}',
    '{"ProtocolConfiguration":{"Network":7},"ProtocolConfiguration":{"Network":8}}',
    '{"ProtocolConfiguration":{"Network":7,"X":1,"X":2}}',
    '{"ProtocolConfiguration":{"Network":7},}',
  ];
  for (const source of invalid)
    assert.throws(() => projectProtocolNetwork(source, 860833102), source);
});

test('protocol parser distinguishes Network text in strings from the unique property', () => {
  const source = String.raw`{"ProtocolConfiguration":{"Network":7,"Note":"a key named \"Network\":9"}}`;
  assert.equal(projectProtocolNetwork(source, 11), source.replace('"Network":7', '"Network":11'));
});

test('generator validates Native input before any --write output mutation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neoos-identity-generator-'));
  try {
    const service = path.join(dir, 'neo-os-services');
    for (const repo of ['neo-os-fura', 'neo-os-devpack', 'neo-os-web'])
      fs.mkdirSync(path.join(dir, repo));
    const write = (relative, text) => {
      const target = path.join(dir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    };
    for (const relative of [
      'scripts/export-network-identities.mjs',
      'scripts/lib/network-identity-projections.mjs',
    ])
      write('neo-os-services/' + relative, fs.readFileSync(path.join(root, relative)));
    for (const name of ['mainnet', 'testnet'])
      write(
        'neo-os-services/config/networks/' + name + '.json',
        JSON.stringify({
          network: name,
          neo_n3: {
            network_magic: name === 'mainnet' ? 860833102 : 894710606,
            genesis_hash: '0x' + 'a'.repeat(64),
            genesis_source: 'reviewed-fixture',
          },
        })
      );
    write(
      'neo-os-app/NeoOS.App/Resources/Raw/protocol.json',
      '{"ProtocolConfiguration":{"Network":7,"Network":8}}'
    );
    write('neo-os-services/config/generated/network-identities.v1.json', 'untouched');
    const run = spawnSync(
      process.execPath,
      [path.join(service, 'scripts/export-network-identities.mjs'), '--write'],
      { encoding: 'utf8' }
    );
    assert.notEqual(run.status, 0);
    assert.equal(
      fs.readFileSync(path.join(service, 'config/generated/network-identities.v1.json'), 'utf8'),
      'untouched'
    );
    assert.equal(
      fs.existsSync(path.join(dir, 'neo-os-app/Shared/Generated/NeoN3NetworkIdentity.g.cs')),
      false
    );
    const valid =
      '{\r\n "ProtocolConfiguration" : {"Network":7,"SeedList":["local"],"Note":"原生字段"}\r\n}\r\n';
    write('neo-os-app/NeoOS.App/Resources/Raw/protocol.json', valid);
    const execute = (mode) =>
      spawnSync(
        process.execPath,
        [path.join(service, 'scripts/export-network-identities.mjs'), mode],
        { encoding: 'utf8' }
      );
    assert.equal(execute('--write').status, 0);
    const protocol = path.join(dir, 'neo-os-app/NeoOS.App/Resources/Raw/protocol.json');
    assert.equal(
      fs.readFileSync(protocol, 'utf8'),
      valid.replace('"Network":7', '"Network":860833102')
    );
    assert.equal(
      fs.readFileSync(path.join(service, 'config/generated/NeoN3NetworkIdentity.g.cs'), 'utf8'),
      fs.readFileSync(
        path.join(dir, 'neo-os-app/Shared/Generated/NeoN3NetworkIdentity.g.cs'),
        'utf8'
      )
    );
    assert.equal(execute('--check').status, 0);
    fs.writeFileSync(protocol, valid);
    assert.notEqual(execute('--check').status, 0);
    assert.equal(fs.readFileSync(protocol, 'utf8'), valid, '--check must not repair or write');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function generatorFixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neoos-identity-review-'));
  const write = (relative, text) => {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  try {
    for (const repo of ['neo-os-fura', 'neo-os-devpack', 'neo-os-web'])
      fs.mkdirSync(path.join(dir, repo));
    for (const relative of [
      'scripts/export-network-identities.mjs',
      'scripts/lib/network-identity-projections.mjs',
    ])
      write('neo-os-services/' + relative, fs.readFileSync(path.join(root, relative)));
    for (const name of ['mainnet', 'testnet'])
      write(
        'neo-os-services/config/networks/' + name + '.json',
        JSON.stringify({
          network: name,
          neo_n3: {
            network_magic: name === 'mainnet' ? 860833102 : 894710606,
            genesis_hash: '0x' + 'a'.repeat(64),
            genesis_source: 'reviewed-fixture',
          },
        })
      );
    write(
      'neo-os-app/NeoOS.App/Resources/Raw/protocol.json',
      '{"ProtocolConfiguration":{"Network":860833102}}'
    );
    write('neo-os-services/config/generated/network-identities.v1.json', 'untouched');
    const execute = (mode) =>
      spawnSync(
        process.execPath,
        [path.join(dir, 'neo-os-services/scripts/export-network-identities.mjs'), mode],
        { encoding: 'utf8' }
      );
    run({ dir, write, execute });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('generator refuses all-zero genesis before writing any consumer', () => {
  generatorFixture(({ dir, write, execute }) => {
    write(
      'neo-os-services/config/networks/mainnet.json',
      JSON.stringify({
        network: 'mainnet',
        neo_n3: {
          network_magic: 860833102,
          genesis_hash: '0x' + '0'.repeat(64),
          genesis_source: 'reviewed-fixture',
        },
      })
    );
    const result = execute('--write');
    assert.notEqual(result.status, 0, 'zero genesis must not be exported');
    assert.match(result.stderr, /identity|genesis/i);
    assert.equal(
      fs.readFileSync(
        path.join(dir, 'neo-os-services/config/generated/network-identities.v1.json'),
        'utf8'
      ),
      'untouched'
    );
  });
});

test('missing or non-directory consumer roots fail before any output mutation', () => {
  for (const repo of ['neo-os-fura', 'neo-os-devpack', 'neo-os-web'])
    for (const shape of ['missing', 'file'])
      generatorFixture(({ dir, write, execute }) => {
        fs.rmdirSync(path.join(dir, repo));
        if (shape === 'file') write(repo, 'not a directory');
        const result = execute('--write');
        assert.notEqual(result.status, 0, repo + ' ' + shape + ' must fail');
        assert.equal(
          fs.readFileSync(
            path.join(dir, 'neo-os-services/config/generated/network-identities.v1.json'),
            'utf8'
          ),
          'untouched'
        );
        assert.equal(fs.existsSync(path.join(dir, 'neo-os-app/Shared')), false);
        if (shape === 'missing')
          assert.equal(fs.existsSync(path.join(dir, repo)), false, 'must not invent a repository');
      });
});

test('symlink consumer roots or descendant outputs cannot escape the declared repository', () => {
  for (const position of ['root', 'parent', 'output', 'native-resource-parent'])
    generatorFixture(({ dir, write, execute }) => {
      const outside = path.join(dir, 'outside');
      fs.mkdirSync(outside);
      if (position === 'root') {
        fs.rmdirSync(path.join(dir, 'neo-os-devpack'));
        fs.symlinkSync(outside, path.join(dir, 'neo-os-devpack'), 'dir');
      } else if (position === 'parent') {
        fs.symlinkSync(outside, path.join(dir, 'neo-os-devpack/shared'), 'dir');
      } else if (position === 'output') {
        write('outside/data.json', 'untouched-outside');
        fs.mkdirSync(path.join(dir, 'neo-os-devpack/shared/constants'), { recursive: true });
        fs.symlinkSync(
          path.join(outside, 'data.json'),
          path.join(dir, 'neo-os-devpack/shared/constants/generated-network-identities.json')
        );
      } else {
        const resource = path.join(dir, 'neo-os-app/NeoOS.App/Resources/Raw');
        fs.renameSync(resource, path.join(outside, 'Raw'));
        fs.symlinkSync(path.join(outside, 'Raw'), resource, 'dir');
      }
      const before = fs.readdirSync(outside);
      assert.notEqual(execute('--write').status, 0, position + ' escape must fail');
      assert.equal(
        fs.readFileSync(
          path.join(dir, 'neo-os-services/config/generated/network-identities.v1.json'),
          'utf8'
        ),
        'untouched'
      );
      assert.deepEqual(fs.readdirSync(outside), before);
      if (position === 'output')
        assert.equal(fs.readFileSync(path.join(outside, 'data.json'), 'utf8'), 'untouched-outside');
    });
});
