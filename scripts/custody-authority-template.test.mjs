import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import yaml from 'js-yaml';
import {
  __keysForTests as keys,
  createDynamoRepository,
} from '../deploy/custody-state-authority/src/dynamo-repository.mjs';

const tags = ['Ref', 'GetAtt', 'Sub', 'If', 'Equals'].flatMap((name) =>
  ['scalar', 'sequence'].map(
    (kind) =>
      new yaml.Type(`!${name}`, {
        kind,
        construct: (value) => ({ [name === 'Ref' ? name : `Fn::${name}`]: value }),
      })
  )
);
const template = yaml.load(
  readFileSync(new URL('../deploy/custody-state-authority/template.yaml', import.meta.url), 'utf8'),
  { schema: yaml.Schema.create(yaml.DEFAULT_SCHEMA, tags) }
);
const vault = '10'.repeat(32);
const profile = '20'.repeat(32);
const bucket = 'arn:aws:s3:::template-bucket';
const list = (value) => (Array.isArray(value) ? value : [value]);
const matches = (pattern, value) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replaceAll('*', '.*')
      .replaceAll('?', '.')}$`
  ).test(value);

function resolveTemplate(network) {
  const refs = {
    ExpectedNetwork: network,
    ExpectedVaultId: vault,
    ExpectedProfileId: profile,
    'SnapshotBucket.Arn': bucket,
    'AWS::Partition': 'aws',
    'AWS::Region': 'us-east-1',
    'AWS::AccountId': '123456789012',
    'AWS::URLSuffix': 'amazonaws.com',
  };
  function resolve(value) {
    if (Array.isArray(value)) return value.map(resolve);
    if (!value || typeof value !== 'object') return value;
    if (value.Ref) return refs[value.Ref] ?? `ref:${value.Ref}`;
    if (value['Fn::GetAtt']) {
      const name = list(value['Fn::GetAtt']).join('.');
      return refs[name] ?? `attribute:${name}`;
    }
    if (value['Fn::Equals']) {
      const [a, b] = value['Fn::Equals'].map(resolve);
      return a === b;
    }
    if (value['Fn::If']) {
      const [condition, yes, no] = value['Fn::If'];
      assert.ok(Object.hasOwn(template.Conditions, condition), `unknown condition ${condition}`);
      return resolve(resolve(template.Conditions[condition]) ? yes : no);
    }
    if (value['Fn::Sub']) {
      const [text, variables] = Array.isArray(value['Fn::Sub'])
        ? value['Fn::Sub']
        : [value['Fn::Sub'], {}];
      const substitutions = { ...refs, ...resolve(variables) };
      return text.replace(/\$\{([^}]+)\}/g, (_, name) => substitutions[name] ?? `ref:${name}`);
    }
    assert.equal(
      Object.keys(value).some((key) => key.startsWith('Fn::')),
      false
    );
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
  }
  return resolve(template);
}

const expectedDynamo = {
  Challenge: [['PutItem', ['CHALLENGE']]],
  Session: [
    ['GetItem', ['CHALLENGE']],
    ['UpdateItem', ['CHALLENGE'], true],
    ['PutItem', ['SESSION'], true],
  ],
  Head: [
    ['GetItem', ['SESSION', 'STATE']],
    ['PutItem', ['PROOF']],
  ],
  UploadTicket: [
    ['GetItem', ['SESSION', 'COMMIT', 'STATE']],
    ['PutItem', ['PROOF']],
    ['ConditionCheckItem', ['STATE'], true],
    ['PutItem', ['COMMIT'], true],
  ],
  UploadStatus: [
    ['GetItem', ['SESSION', 'COMMIT', 'STATE']],
    ['PutItem', ['PROOF']],
    ['ConditionCheckItem', ['STATE'], true],
  ],
  DownloadTicket: [
    ['GetItem', ['SESSION', 'STATE']],
    ['PutItem', ['PROOF']],
  ],
  Commit: [
    ['GetItem', ['SESSION', 'COMMIT']],
    ['PutItem', ['PROOF']],
    ['ConditionCheckItem', ['COMMIT'], true],
    ['UpdateItem', ['STATE'], true],
    ['PutItem', ['COMMIT'], true],
  ],
  Takeover: [
    ['GetItem', ['SESSION', 'STATE']],
    ['PutItem', ['PROOF']],
    ['PutItem', ['STATE'], true],
    ['UpdateItem', ['STATE'], true],
  ],
  Renew: [
    ['GetItem', ['SESSION', 'STATE']],
    ['PutItem', ['PROOF']],
    ['UpdateItem', ['STATE']],
  ],
};
const storageActions = {
  UploadTicket: ['s3:PutObject', 's3:PutObjectRetention', 'kms:GenerateDataKey'],
  UploadStatus: [
    's3:ListBucketVersions',
    's3:GetObjectRetention',
    's3:GetObjectVersion',
    'kms:Decrypt',
    'kms:GenerateDataKey',
  ],
  DownloadTicket: ['s3:GetObject', 's3:GetObjectVersion', 'kms:Decrypt'],
  Commit: [
    's3:GetObject',
    's3:GetObjectRetention',
    's3:GetObjectVersion',
    'kms:Decrypt',
    'kms:GenerateDataKey',
    'kms:Sign',
  ],
};
function statements(document, role) {
  return document.Resources[`${role}FunctionRole`].Properties.Policies.flatMap(
    (policy) => policy.PolicyDocument.Statement
  );
}
function physicalKeys(network) {
  const scope = {
    network,
    vaultId: vault,
    profileId: profile,
    networkId: '30'.repeat(32),
    rootCommitment: '40'.repeat(32),
  };
  return {
    CHALLENGE: [keys.challengeKey('id', network).pk.S],
    SESSION: [keys.sessionKey('token', network).pk.S],
    PROOF: [keys.sessionProofKey('token', 'nonce', network).pk.S],
    STATE: [keys.stateKey(scope).pk.S],
    COMMIT: [keys.claimKey(scope, 'id').pk.S, keys.commitKey(scope, 'id').pk.S],
  };
}

test('authority scope and identity require explicit operator selection', () => {
  for (const name of ['ExpectedNetwork', 'ServiceName', 'ReceiptKeyId']) {
    assert.equal(template.Parameters[name]?.Type, 'String', name);
    assert.equal(Object.hasOwn(template.Parameters[name], 'Default'), false, name);
  }
  assert.deepEqual(template.Parameters.ExpectedNetwork.AllowedValues, ['testnet', 'mainnet']);
  assert.deepEqual(template.Globals.Function.Environment.Variables.EXPECTED_NETWORK, {
    Ref: 'ExpectedNetwork',
  });
  for (const value of ['', 'MainNet', ' mainnet', 'testnet ', 'private']) {
    assert.equal(template.Parameters.ExpectedNetwork.AllowedValues.includes(value), false);
  }
});

for (const network of ['testnet', 'mainnet']) {
  const document = resolveTemplate(network);
  const admitted = physicalKeys(network);
  const foreign = physicalKeys(network === 'testnet' ? 'mainnet' : 'testnet');
  test(`${network}: every route IAM key grant matches actual repository keys only`, () => {
    for (const [role, permissions] of Object.entries(expectedDynamo)) {
      const all = statements(document, role);
      assert.deepEqual(
        all.flatMap((statement) => list(statement.Action)).sort(),
        [
          ...permissions.map(([action]) => `dynamodb:${action}`),
          ...(storageActions[role] || []),
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ].sort(),
        `${role}: no additional actions or wildcard grants`
      );
      const grants = statements(document, role).filter((statement) =>
        list(statement.Action).some((action) => action.startsWith('dynamodb:'))
      );
      assert.equal(grants.length, permissions.length, role);
      for (const [action, entities, transactional = false] of permissions) {
        const grant = grants.find(
          (statement) =>
            statement.Action === `dynamodb:${action}` &&
            Boolean(
              statement.Condition?.['ForAnyValue:StringEquals']?.['dynamodb:EnclosingOperation']
            ) === transactional
        );
        assert.ok(grant, `${role}/${action}`);
        assert.equal(grant.Effect, 'Allow');
        assert.equal(grant.Resource, 'attribute:AuthorityTable.Arn');
        const patterns = grant.Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'];
        assert.deepEqual(
          patterns,
          entities.map((entity) => `${network === 'mainnet' ? 'mainnet#' : ''}${entity}#*`)
        );
        const enclosing =
          grant.Condition['ForAnyValue:StringEquals']?.['dynamodb:EnclosingOperation'];
        assert.deepEqual(enclosing, transactional ? ['TransactWriteItems'] : undefined);
        const accepts = (requested, operation = transactional ? 'TransactWriteItems' : undefined) =>
          (!enclosing || enclosing.includes(operation)) &&
          !(grant.Condition.Null?.['dynamodb:LeadingKeys'] === 'false' && requested.length === 0) &&
          requested.every((key) => patterns.some((pattern) => matches(pattern, key)));
        assert.equal(accepts([]), false, `${role}/${action}: absent key context`);
        if (transactional)
          assert.equal(
            accepts([admitted[entities[0]][0]], 'PutItem'),
            false,
            `${role}: standalone write`
          );
        for (const [entity, values] of Object.entries(admitted)) {
          for (const key of values)
            assert.equal(accepts([key]), entities.includes(entity), `${role}/${action}: ${key}`);
        }
        for (const key of Object.values(foreign).flat())
          assert.equal(accepts([key]), false, `${role}/${action}: foreign ${key}`);
        assert.equal(accepts([admitted[entities[0]][0], foreign[entities[0]][0]]), false);
      }
    }
  });

  test(`${network}: S3 object, version-list and KMS scopes match the admitted snapshot path`, () => {
    const prefix = `snapshots/v2/${network === 'mainnet' ? 'mainnet/' : ''}${vault}/${profile}/`;
    const other = `snapshots/v2/${network === 'mainnet' ? '' : 'mainnet/'}${vault}/${profile}/`;
    for (const role of ['UploadTicket', 'UploadStatus', 'DownloadTicket', 'Commit']) {
      const grants = statements(document, role);
      const objects = grants.filter((grant) =>
        list(grant.Action).some((action) => /^s3:(PutObject|GetObject)/.test(action))
      );
      assert.equal(objects.length, 1, role);
      const pattern = objects[0].Resource;
      assert.equal(pattern, `${bucket}/${prefix}*`, role);
      assert.equal(matches(pattern, `${bucket}/${prefix}1/hash/snapshot.bin`), true);
      for (const path of [
        other,
        prefix.replace(vault, 'ff'.repeat(32)),
        prefix.replace(profile, 'ee'.repeat(32)),
        'unrelated/',
      ]) {
        assert.equal(matches(pattern, `${bucket}/${path}1/hash/snapshot.bin`), false, role);
      }
      const kms = grants.find(
        (grant) =>
          list(grant.Action).includes('kms:Decrypt') ||
          list(grant.Action).includes('kms:GenerateDataKey')
      );
      assert.equal(kms.Condition.StringEquals['kms:ViaService'], 's3.us-east-1.amazonaws.com');
      assert.deepEqual(kms.Condition.StringLike['kms:EncryptionContext:aws:s3:arn'], [
        bucket,
        `${bucket}/${prefix}*`,
      ]);
    }
    const listing = statements(document, 'UploadStatus').find(
      (grant) => grant.Action === 's3:ListBucketVersions'
    );
    assert.equal(listing.Resource, bucket);
    assert.equal(listing.Condition.StringLike['s3:prefix'], `${prefix}*`);
    assert.equal(
      matches(listing.Condition.StringLike['s3:prefix'], `${other}1/hash/snapshot.bin`),
      false
    );
    const denials = document.Resources.SnapshotBucketPolicy.Properties.PolicyDocument.Statement;
    for (const sid of [
      'DenySnapshotDeletion',
      'DenyUnencryptedSnapshotWrites',
      'DenyWrongSnapshotEncryptionKey',
    ]) {
      const denial = denials.find((item) => item.Sid === sid);
      assert.equal(denial.Effect, 'Deny');
      assert.equal(matches(denial.Resource, `${bucket}/${prefix}1/hash/snapshot.bin`), true);
      assert.equal(matches(denial.Resource, `${bucket}/${other}1/hash/snapshot.bin`), true);
    }
  });

  test(`${network}: resource tags and inherited Lambda admission match operator scope`, () => {
    assert.equal(document.Globals.Function.Environment.Variables.EXPECTED_NETWORK, network);
    let tags = 0;
    for (const resource of Object.values(document.Resources)) {
      if (resource.Type === 'AWS::Serverless::Function')
        assert.equal(resource.Properties.Environment, undefined);
      if (Array.isArray(resource.Properties.Tags)) {
        for (const tag of resource.Properties.Tags)
          if (tag.Key === 'neoos:network') {
            tags++;
            assert.equal(tag.Value, network);
          }
      } else if (resource.Properties.Tags?.['neoos:network']) {
        tags++;
        assert.equal(resource.Properties.Tags['neoos:network'], network);
      }
    }
    assert.equal(tags, 7);
  });
}

for (const network of ['testnet', 'mainnet']) {
  test(`${network}: actual Dynamo transaction items have transaction-only IAM permissions`, async () => {
    const document = resolveTemplate(network);
    const calls = [];
    let role;
    const commands = Object.fromEntries(
      ['GetItemCommand', 'TransactWriteItemsCommand'].map((name) => [
        name,
        class {
          constructor(input) {
            this.input = input;
          }
        },
      ])
    );
    const repository = createDynamoRepository({
      network,
      tableName: 'table',
      commands,
      client: {
        async send(command) {
          calls.push({ role, input: command.input });
          return {};
        },
      },
    });
    const claim = {
      network,
      vaultId: vault,
      profileId: profile,
      networkId: '30'.repeat(32),
      rootCommitment: '40'.repeat(32),
      requestFingerprint: 'aa'.repeat(32),
      ownerId: 'review-owner',
      epoch: '7',
      snapshotFence: '7',
      generation: '12',
      previousGeneration: '11',
      previousSnapshotFence: '3',
      previousHash: 'bb'.repeat(32),
      commitId: 'commit-12',
      snapshotBucket: 'template-bucket',
      snapshotKey: 'snapshot-key',
      snapshotSha256: 'cc'.repeat(32),
      snapshotSizeBytes: 4096,
      mutationDigest: 'ee'.repeat(32),
      headFingerprint: 'ff'.repeat(32),
      createdAt: '2027-01-15T08:00:00.000Z',
    };
    const head = {
      ...claim,
      headHash: claim.snapshotSha256,
      leaseExpiresAtMs: 1800000060000,
      updatedAt: claim.createdAt,
    };
    const challenge = {
      ...claim,
      challengeId: 'challenge',
      nonceHex: 'aa'.repeat(32),
      userDataSha256: 'bb'.repeat(32),
      expiresAt: 1800000300,
    };
    const session = {
      ...claim,
      tokenHash: 'cc'.repeat(32),
      pcrs: { pcr0: '01', pcr1: '02', pcr2: '03' },
      expiresAt: 1800000300,
    };
    role = 'Session';
    await repository.consumeChallengeAndCreateSession(challenge, session, 1800000000);
    role = 'Takeover';
    await repository.takeover({ previous: head, next: head, nowMs: 1800000000000, genesis: true });
    await repository.takeover({ previous: head, next: head, nowMs: 1800000000000, genesis: false });
    role = 'UploadTicket';
    await repository.claimUpload(claim, 1800000000000);
    await repository.assertHeadBinding(claim, 1800000000000);
    role = 'UploadStatus';
    await repository.assertHeadBinding(claim, 1800000000000);
    role = 'Commit';
    await repository.commit({
      claim,
      record: { ...claim, head, receipt: { network }, committedAt: claim.createdAt },
      nowMs: 1800000000000,
    });
    let items = 0;
    for (const call of calls) {
      for (const transaction of call.input.TransactItems || []) {
        items++;
        const [operation, input] = Object.entries(transaction)[0];
        const action = `dynamodb:${{ Put: 'PutItem', Update: 'UpdateItem', ConditionCheck: 'ConditionCheckItem' }[operation]}`;
        const key = input.Item?.pk.S || input.Key.pk.S;
        const allows = (pk, enclosing) =>
          statements(document, call.role).some((grant) => {
            if (grant.Effect !== 'Allow' || !list(grant.Action).includes(action)) return false;
            const patterns = grant.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys'];
            const operations =
              grant.Condition?.['ForAnyValue:StringEquals']?.['dynamodb:EnclosingOperation'];
            return (
              patterns?.some((pattern) => matches(pattern, pk)) &&
              (!operations || operations.includes(enclosing))
            );
          });
        assert.equal(
          allows(key, 'TransactWriteItems'),
          true,
          `${call.role}/${operation}: missing IAM permission for actual transaction item`
        );
        assert.equal(allows(key, undefined), false, `${call.role}/${operation}: standalone access`);
        const foreign = network === 'mainnet' ? key.slice('mainnet#'.length) : `mainnet#${key}`;
        assert.equal(
          allows(foreign, 'TransactWriteItems'),
          false,
          `${call.role}/${operation}: foreign network`
        );
      }
    }
    assert.equal(items, 11);
  });
}
