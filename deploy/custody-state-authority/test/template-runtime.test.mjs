import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const template = readFileSync(new URL('../template.yaml', import.meta.url), 'utf8');
const runtime = new URL('../src/runtime.mjs', import.meta.url).href;
const sdk = import.meta.resolve('@aws-sdk/client-dynamodb');

function templateEnvironment(network) {
  const values = {
    ExpectedNetwork: network,
    AuthorityTable: 'template-table',
    SnapshotBucket: 'template-bucket',
    'SnapshotEncryptionKey.Arn': 'template-snapshot-key',
    'ReceiptSigningKey.Arn': 'template-receipt-key',
    ReceiptKeyId: 'template-receipt',
    SnapshotRetentionDays: 3650,
    ChallengeTtlSeconds: 120,
    SessionTtlSeconds: 300,
    RequestProofMaxSkewSeconds: 30,
    LeaseDurationSeconds: 60,
    UploadUrlTtlSeconds: 120,
    ExpectedVaultId: '10'.repeat(32),
    ExpectedProfileId: '20'.repeat(32),
    ExpectedNetworkId: '30'.repeat(32),
    ExpectedRootCommitment: '40'.repeat(32),
    ExpectedPcr0: '01'.repeat(48),
    ExpectedPcr1: '02'.repeat(48),
    ExpectedPcr2: '03'.repeat(48),
  };
  // Deliberately support only the flat scalar/Ref/GetAtt environment used here.
  // A changed YAML shape must fail this probe, not silently fabricate a value.
  const block = template.match(/    Environment:\n      Variables:\n((?:        .+\n)+)/);
  assert.ok(block, 'missing Globals.Function.Environment.Variables');
  assert.equal((template.match(/^\s+Environment:/gm) || []).length, 1);
  const env = { AWS_REGION: 'us-east-1', AWS_EC2_METADATA_DISABLED: 'true' };
  for (const line of block[1].trimEnd().split('\n')) {
    const match = line.match(/^ {8}([A-Z0-9_]+): (.+)$/);
    assert.ok(match, `unsupported environment line: ${line}`);
    const [, name, expression] = match;
    const ref = expression.match(/^!(?:Ref|GetAtt) ([A-Za-z0-9.]+)$/);
    const literal = expression.match(/^'([0-9]+)'$/);
    assert.ok(ref || literal, `unsupported environment expression: ${expression}`);
    assert.equal(Object.hasOwn(env, name), false, `duplicate variable ${name}`);
    if (ref) {
      assert.ok(Object.hasOwn(values, ref[1]), `unresolved ${ref[1]}`);
      env[name] = String(values[ref[1]]);
    } else env[name] = literal[1];
  }
  return env;
}

for (const network of ['testnet', 'mainnet']) {
  test(`${network}: synthesized SAM environment initializes the real runtime`, () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import assert from 'node:assert/strict';
        import { getAuthority } from ${JSON.stringify(runtime)};
        const { DynamoDBClient } = await import(${JSON.stringify(sdk)});
        const calls = [];
        DynamoDBClient.prototype.send = async c => { calls.push(c.input); return {}; };
        const authority = await getAuthority();
        const challenge = await authority.createChallenge({
          vault_id: process.env.EXPECTED_VAULT_ID, profile_id: process.env.EXPECTED_PROFILE_ID,
          network_id: process.env.EXPECTED_NETWORK_ID,
          root_commitment: process.env.EXPECTED_ROOT_COMMITMENT, owner_id: 'template-owner'
        });
        assert.equal(challenge.network, ${JSON.stringify(network)});
        assert.equal(calls.length, 1);
        assert.equal(calls[0].TableName, 'template-table');
        assert.equal(calls[0].Item.network.S, ${JSON.stringify(network)});
        assert.equal(calls[0].Item.pk.S.startsWith('mainnet#'), ${network === 'mainnet'});`,
      ],
      { env: templateEnvironment(network), encoding: 'utf8', timeout: 15000 }
    );
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
  });
}
