import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const dynamoModule = import.meta.resolve('@aws-sdk/client-dynamodb');
const runtime = new URL('../src/runtime.mjs', import.meta.url).href;
const environment = {
  AUTHORITY_TABLE_NAME: 'unit-table',
  SNAPSHOT_BUCKET_NAME: 'unit-snapshots',
  SNAPSHOT_KMS_KEY_ARN: 'unit-snapshot-key',
  SNAPSHOT_RETENTION_DAYS: '1',
  RECEIPT_SIGNING_KEY_ARN: 'unit-receipt-key',
  RECEIPT_KEY_ID: 'unit-receipt',
  CHALLENGE_TTL_SECONDS: '120',
  SESSION_TTL_SECONDS: '300',
  REQUEST_PROOF_MAX_SKEW_SECONDS: '30',
  LEASE_DURATION_SECONDS: '60',
  UPLOAD_URL_TTL_SECONDS: '120',
  MAX_SNAPSHOT_BYTES: '67109024',
  EXPECTED_VAULT_ID: '10'.repeat(32),
  EXPECTED_PROFILE_ID: '20'.repeat(32),
  EXPECTED_NETWORK_ID: '30'.repeat(32),
  EXPECTED_ROOT_COMMITMENT: '40'.repeat(32),
  EXPECTED_PCR0: '01'.repeat(48),
  EXPECTED_PCR1: '02'.repeat(48),
  EXPECTED_PCR2: '03'.repeat(48),
  AWS_EC2_METADATA_DISABLED: 'true',
  AWS_REGION: 'us-east-1',
};

test('runtime rejects missing and noncanonical admission before constructing authority', () => {
  for (const network of [undefined, '', 'MainNet', 'private', ' mainnet', 'testnet ']) {
    const env = { ...environment };
    if (network !== undefined) env.EXPECTED_NETWORK = network;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import { getAuthority } from ${JSON.stringify(runtime)};
      await assert.rejects(getAuthority(), /network/);
    `,
      ],
      { env, encoding: 'utf8', timeout: 15000 }
    );
    assert.equal(result.status, 0, `${network}: ${result.stderr}`);
  }
});

test('runtime captures startup network before await and never switches a cached authority', () => {
  for (const network of ['mainnet', 'testnet']) {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import { getAuthority } from ${JSON.stringify(runtime)};
      const { DynamoDBClient } = await import(${JSON.stringify(dynamoModule)});
      const calls = [];
      DynamoDBClient.prototype.send = async (command) => { calls.push(command.input); return {}; };
      const first = getAuthority();
      process.env.EXPECTED_NETWORK = 'invalid';
      process.env.EXPECTED_NETWORK_ID = 'invalid';
      for (const key of ['AUTHORITY_TABLE_NAME', 'SNAPSHOT_BUCKET_NAME', 'SNAPSHOT_KMS_KEY_ARN', 'SNAPSHOT_RETENTION_DAYS', 'RECEIPT_SIGNING_KEY_ARN', 'RECEIPT_KEY_ID']) process.env[key] = '';
      const authority = await first;
      assert.equal(await getAuthority(), authority);
      await assert.rejects(authority.createChallenge({
        vault_id: '${'ff'.repeat(32)}', profile_id: '${environment.EXPECTED_PROFILE_ID}',
        network_id: '${environment.EXPECTED_NETWORK_ID}', root_commitment: '${environment.EXPECTED_ROOT_COMMITMENT}',
        owner_id: 'unit-owner'
      }), { code: 'scope_not_authorized' });
      const challenge = await authority.createChallenge({
        vault_id: '${environment.EXPECTED_VAULT_ID}', profile_id: '${environment.EXPECTED_PROFILE_ID}',
        network_id: '${environment.EXPECTED_NETWORK_ID}', root_commitment: '${environment.EXPECTED_ROOT_COMMITMENT}',
        owner_id: 'unit-owner'
      });
      assert.equal(challenge.network, '${network}');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].TableName, 'unit-table');
      assert.equal(calls[0].Item.network.S, '${network}');
      assert.equal(calls[0].Item.pk.S.startsWith('mainnet#'), ${network === 'mainnet'});
    `,
      ],
      { env: { ...environment, EXPECTED_NETWORK: network }, encoding: 'utf8', timeout: 15000 }
    );
    assert.equal(result.status, 0, `${network}: ${result.stderr}`);
  }
});
