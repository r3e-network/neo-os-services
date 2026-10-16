import assert from 'node:assert/strict';
import test from 'node:test';
import { __keysForTests, createDynamoRepository } from '../src/dynamo-repository.mjs';

function commandType(type) {
  return class {
    constructor(input) {
      this.type = type;
      this.input = input;
    }
  };
}

const commands = Object.freeze({
  GetItemCommand: commandType('GetItem'),
  PutItemCommand: commandType('PutItem'),
  UpdateItemCommand: commandType('UpdateItem'),
  TransactWriteItemsCommand: commandType('TransactWriteItems'),
});

function clientWith(handler = async () => ({})) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command);
      return handler(command);
    },
  };
}

function assertExpressionBindings(operation) {
  const expression = [
    operation.ConditionExpression,
    operation.UpdateExpression,
    operation.KeyConditionExpression,
    operation.FilterExpression,
    operation.ProjectionExpression,
  ]
    .filter(Boolean)
    .join(' ');
  const usedNames = [...new Set(expression.match(/#[A-Za-z0-9_]+/g) || [])].sort();
  const usedValues = [...new Set(expression.match(/:[A-Za-z0-9_]+/g) || [])].sort();
  assert.deepEqual(Object.keys(operation.ExpressionAttributeNames || {}).sort(), usedNames);
  assert.deepEqual(Object.keys(operation.ExpressionAttributeValues || {}).sort(), usedValues);
}

const scope = {
  network: 'testnet',
  vaultId: '10'.repeat(32),
  profileId: '20'.repeat(32),
  networkId: '30'.repeat(32),
  rootCommitment: '40'.repeat(32),
};
const physicalScope = [scope.vaultId, scope.profileId, scope.networkId, scope.rootCommitment].join(
  '#'
);
const claim = {
  requestFingerprint: 'aa'.repeat(32),
  network: 'testnet',
  ...scope,
  ownerId: `nitro-${'a1'.repeat(32)}`,
  epoch: '7',
  snapshotFence: '7',
  generation: '12',
  previousGeneration: '11',
  previousSnapshotFence: '3',
  previousHash: 'bb'.repeat(32),
  commitId: 'commit-12',
  snapshotBucket: 'snapshot-bucket',
  snapshotKey: `snapshots/v2/${scope.vaultId}/${scope.profileId}/12/commit-12/hash.bin`,
  snapshotSha256: 'cc'.repeat(32),
  snapshotSizeBytes: 4096,
  mutationDigest: 'ee'.repeat(32),
  headFingerprint: 'ff'.repeat(32),
  createdAt: '2027-01-15T08:00:00.000Z',
};

test('physical state and commit keys include the complete scope', () => {
  const otherScope = { ...scope, rootCommitment: '41'.repeat(32) };
  assert.notDeepEqual(__keysForTests.stateKey(scope), __keysForTests.stateKey(otherScope));
  assert.notDeepEqual(
    __keysForTests.claimKey(scope, claim.commitId),
    __keysForTests.claimKey(otherScope, claim.commitId)
  );
  assert.notDeepEqual(
    __keysForTests.commitKey(scope, claim.commitId),
    __keysForTests.commitKey(otherScope, claim.commitId)
  );
});

test('HEAD reads are explicitly strongly consistent', async () => {
  const client = clientWith(async () => ({
    Item: {
      pk: { S: `STATE#${physicalScope}` },
      sk: { S: 'HEAD' },
      network: { S: scope.network },
      vault_id: { S: scope.vaultId },
      profile_id: { S: scope.profileId },
      network_id: { S: scope.networkId },
      root_commitment: { S: scope.rootCommitment },
      owner_id: { S: claim.ownerId },
      epoch: { N: '7' },
      snapshot_fence: { N: '3' },
      generation: { N: '11' },
      previous_hash: { S: 'aa'.repeat(32) },
      head_hash: { S: 'bb'.repeat(32) },
      head_fingerprint: { S: claim.headFingerprint },
      lease_expires_at_ms: { N: '1800000060000' },
      updated_at: { S: '2027-01-15T08:00:00.000Z' },
    },
  }));
  const repository = createDynamoRepository({
    client,
    tableName: 'table',
    commands,
    network: 'testnet',
  });
  const head = await repository.getHead(scope);
  assert.equal(head.generation, '11');
  assert.equal(client.calls[0].type, 'GetItem');
  assert.equal(client.calls[0].input.ConsistentRead, true);
});

test('a request proof nonce is persisted once under the session and expires with it', async () => {
  const client = clientWith();
  const repository = createDynamoRepository({
    client,
    tableName: 'table',
    commands,
    network: 'testnet',
  });
  await repository.consumeSessionProof(
    {
      ...scope,
      tokenHash: '71'.repeat(32),
      publicKeySha256: '72'.repeat(32),
      expiresAt: 1_800_000_300,
    },
    {
      nonceHex: '73'.repeat(32),
      requestDigest: '74'.repeat(32),
      method: 'POST',
      path: '/v1/vaults/v/profiles/p/commits',
      bodySha256: '75'.repeat(32),
      timestampMs: '1800000000000',
    },
    1_800_000_000
  );
  const input = client.calls[0].input;
  assert.equal(input.Item.pk.S, `PROOF#${'71'.repeat(32)}#${'73'.repeat(32)}`);
  assert.equal(input.Item.sk.S, 'META');
  assert.equal(input.Item.entity_type.S, 'SESSION_PROOF');
  assert.equal(input.Item.expires_at.N, '1800000300');
  assert.equal(input.ConditionExpression, 'attribute_not_exists(pk) AND attribute_not_exists(sk)');
});

test('upload claim transaction fences every predecessor dimension', async () => {
  const client = clientWith();
  const repository = createDynamoRepository({
    client,
    tableName: 'table',
    commands,
    network: 'testnet',
  });
  await repository.claimUpload(claim, 1_800_000_000_000);
  const input = client.calls[0].input;
  assert.equal(input.ClientRequestToken, undefined);
  assert.equal(input.TransactItems.length, 2);
  input.TransactItems.forEach((item) => assertExpressionBindings(Object.values(item)[0]));
  const check = input.TransactItems[0].ConditionCheck;
  assert.match(check.ConditionExpression, /#vault = :vault/);
  assert.match(check.ConditionExpression, /#network = :network/);
  assert.match(check.ConditionExpression, /#profile = :profile/);
  assert.match(check.ConditionExpression, /#owner = :owner/);
  assert.match(check.ConditionExpression, /#epoch = :epoch/);
  assert.match(check.ConditionExpression, /#generation = :generation/);
  assert.match(check.ConditionExpression, /#hash = :hash/);
  assert.match(check.ConditionExpression, /#lease > :now/);
  assert.equal(check.ExpressionAttributeValues[':generation'].N, '11');
  assert.equal(check.ExpressionAttributeValues[':snapshotFence'].N, '3');
  assert.equal(check.ExpressionAttributeValues[':hash'].S, claim.previousHash);
  const put = input.TransactItems[1].Put;
  assert.equal(put.Item.pk.S, `COMMIT#${physicalScope}#commit-12`);
  assert.equal(put.Item.sk.S, 'CLAIM');
  assert.equal(put.Item.previous_snapshot_fence.N, '3');
  assert.match(put.ConditionExpression, /attribute_not_exists\(pk\)/);
  assert.equal(put.Item.expires_at, undefined);
});

test('commit atomically checks the immutable claim, CASes HEAD and inserts once', async () => {
  const client = clientWith();
  const repository = createDynamoRepository({
    client,
    tableName: 'table',
    commands,
    network: 'testnet',
  });
  const head = {
    ...scope,
    ownerId: claim.ownerId,
    epoch: claim.epoch,
    snapshotFence: claim.snapshotFence,
    generation: claim.generation,
    headHash: claim.snapshotSha256,
    leaseExpiresAtMs: 1_800_000_060_000,
    commitId: claim.commitId,
    snapshotBucket: claim.snapshotBucket,
    snapshotKey: claim.snapshotKey,
    snapshotVersionId: 'version-12',
    snapshotSha256: claim.snapshotSha256,
    snapshotSizeBytes: claim.snapshotSizeBytes,
    previousHash: claim.previousHash,
    headFingerprint: '13'.repeat(32),
    updatedAt: '2027-01-15T08:00:00.000Z',
  };
  const record = {
    requestFingerprint: 'dd'.repeat(32),
    claimFingerprint: claim.requestFingerprint,
    network: 'testnet',
    ...scope,
    ownerId: claim.ownerId,
    epoch: claim.epoch,
    snapshotFence: claim.snapshotFence,
    generation: claim.generation,
    previousGeneration: claim.previousGeneration,
    previousSnapshotFence: claim.previousSnapshotFence,
    previousHash: claim.previousHash,
    mutationDigest: claim.mutationDigest,
    operationDigest: '12'.repeat(32),
    commitId: claim.commitId,
    headHash: claim.snapshotSha256,
    snapshotBucket: claim.snapshotBucket,
    snapshotKey: claim.snapshotKey,
    snapshotVersionId: 'version-12',
    snapshotSha256: claim.snapshotSha256,
    snapshotSizeBytes: claim.snapshotSizeBytes,
    committedAt: head.updatedAt,
    receipt: { network: 'testnet', receipt_id: 'receipt-12' },
    head,
  };
  await repository.commit({ claim, record, nowMs: 1_800_000_000_000 });
  const input = client.calls[0].input;
  assert.equal(input.ClientRequestToken, undefined);
  const transaction = input.TransactItems;
  assert.equal(transaction.length, 3);
  transaction.forEach((item) => assertExpressionBindings(Object.values(item)[0]));
  assert.equal(transaction[0].ConditionCheck.Key.sk.S, 'CLAIM');
  assert.match(transaction[0].ConditionCheck.ConditionExpression, /#fingerprint = :fingerprint/);
  assert.match(transaction[0].ConditionCheck.ConditionExpression, /#previousHash = :previousHash/);
  assert.match(
    transaction[0].ConditionCheck.ConditionExpression,
    /#previousSnapshotFence = :previousSnapshotFence/
  );
  assert.match(transaction[1].Update.ConditionExpression, /#owner = :owner/);
  assert.match(transaction[1].Update.ConditionExpression, /#epoch = :epoch/);
  assert.match(transaction[1].Update.ConditionExpression, /#generation = :generation/);
  assert.match(transaction[1].Update.ConditionExpression, /#hash = :hash/);
  assert.doesNotMatch(transaction[1].Update.ConditionExpression, /:headFingerprint/);
  assert.equal(transaction[1].Update.ExpressionAttributeValues[':headFingerprint'], undefined);
  assert.equal(transaction[1].Update.ExpressionAttributeValues[':generation'].N, '11');
  assert.equal(transaction[1].Update.ExpressionAttributeValues[':snapshotFence'].N, '3');
  assert.equal(transaction[1].Update.ExpressionAttributeValues[':nextGeneration'].N, '12');
  assert.equal(transaction[1].Update.ExpressionAttributeValues[':nextSnapshotFence'].N, '7');
  assert.equal(transaction[2].Put.Item.sk.S, 'RECORD');
  assert.equal(transaction[2].Put.Item.previous_snapshot_fence.N, '3');
  assert.equal(transaction[2].Put.Item.head_fingerprint.S, head.headFingerprint);
  assert.match(transaction[2].Put.ConditionExpression, /attribute_not_exists\(pk\)/);
  assert.equal(transaction[2].Put.Item.expires_at, undefined);
});

test('AWS conditional failures are not mistaken for successful writes', async () => {
  const client = clientWith(async () => {
    const error = new Error('cancelled');
    error.name = 'TransactionCanceledException';
    throw error;
  });
  const repository = createDynamoRepository({
    client,
    tableName: 'table',
    commands,
    network: 'testnet',
  });
  await assert.rejects(repository.claimUpload(claim, 1_800_000_000_000), {
    name: 'ConditionalConflictError',
  });
});

for (const network of ['testnet', 'mainnet']) {
  test(`${network}: Dynamo writes and every conditional fence use admitted network`, async () => {
    const client = clientWith();
    const repository = createDynamoRepository({ client, tableName: 'table', commands, network });
    const bound = { ...claim, network };
    const head = {
      ...bound,
      headHash: bound.snapshotSha256,
      leaseExpiresAtMs: 1800000060000,
      updatedAt: bound.createdAt,
    };
    const challenge = {
      ...bound,
      challengeId: 'challenge',
      nonceHex: 'aa'.repeat(32),
      userDataSha256: 'bb'.repeat(32),
      expiresAt: 1800000300,
    };
    const session = {
      ...bound,
      tokenHash: 'cc'.repeat(32),
      pcrs: { pcr0: '01', pcr1: '02', pcr2: '03' },
      expiresAt: 1800000300,
    };
    await repository.putChallenge(challenge);
    await repository.consumeChallengeAndCreateSession(challenge, session, 1800000000);
    await repository.takeover({ previous: head, next: head, nowMs: 1800000000000, genesis: true });
    await repository.takeover({ previous: head, next: head, nowMs: 1800000000000, genesis: false });
    await repository.renew({ binding: head, next: head, nowMs: 1800000000000 });
    await repository.claimUpload(bound, 1800000000000);
    await repository.assertHeadBinding(bound, 1800000000000);
    await repository.commit({
      claim: bound,
      record: { ...bound, head, receipt: { network }, committedAt: bound.createdAt },
      nowMs: 1800000000000,
    });
    let conditions = 0;
    let writes = 0;
    for (const call of client.calls) {
      const operations = call.input.TransactItems?.map((entry) => Object.values(entry)[0]) || [
        call.input,
      ];
      for (const operation of operations) {
        assertExpressionBindings(operation);
        if (operation.Item?.network) {
          writes++;
          assert.equal(operation.Item.network.S, network);
        }
        if (operation.ExpressionAttributeValues?.[':network']) {
          conditions++;
          assert.equal(operation.ExpressionAttributeValues[':network'].S, network);
        }
        const pk = operation.Item?.pk.S || operation.Key?.pk.S;
        if (pk) assert.equal(pk.startsWith('mainnet#'), network === 'mainnet');
      }
    }
    assert.equal(writes, 5);
    assert.equal(conditions, 7);
  });

  test(`${network}: Dynamo refuses foreign input before I/O`, async () => {
    const client = clientWith();
    const repository = createDynamoRepository({ client, tableName: 'table', commands, network });
    const foreign = { ...claim, network: network === 'mainnet' ? 'testnet' : 'mainnet' };
    for (const invoke of [
      () => repository.putChallenge(foreign),
      () => repository.consumeChallengeAndCreateSession(foreign, foreign, 0),
      () => repository.consumeSessionProof(foreign, {}, 0),
      () => repository.getHead(foreign),
      () => repository.getClaim(foreign, 'commit'),
      () => repository.getCommit(foreign, 'commit'),
      () => repository.takeover({ previous: foreign, next: foreign, nowMs: 0, genesis: true }),
      () => repository.renew({ binding: foreign, next: foreign, nowMs: 0 }),
      () => repository.claimUpload(foreign, 0),
      () => repository.assertHeadBinding(foreign, 0),
      () => repository.commit({ claim: foreign, record: foreign, nowMs: 0 }),
    ])
      await assert.rejects(invoke, /network/);
    assert.equal(client.calls.length, 0);
  });
}

test('Dynamo admission requires a canonical public network', () => {
  for (const network of [undefined, '', 'private', 'MainNet', 'mainnet ', null]) {
    assert.throws(
      () => createDynamoRepository({ client: clientWith(), tableName: 'table', commands, network }),
      /network/
    );
  }
});

test('Dynamo HEAD read preserves its stored network and rejects foreign rows', async () => {
  for (const network of ['testnet', 'mainnet']) {
    const item = {
      network: { S: network },
      vault_id: { S: scope.vaultId },
      profile_id: { S: scope.profileId },
      network_id: { S: scope.networkId },
      root_commitment: { S: scope.rootCommitment },
      owner_id: { S: claim.ownerId },
      epoch: { N: '7' },
      snapshot_fence: { N: '3' },
      generation: { N: '11' },
      previous_hash: { S: claim.previousHash },
      head_hash: { S: claim.snapshotSha256 },
      head_fingerprint: { S: claim.headFingerprint },
      lease_expires_at_ms: { N: '1800000060000' },
      updated_at: { S: claim.createdAt },
    };
    const client = clientWith(async () => ({ Item: structuredClone(item) }));
    const repository = createDynamoRepository({ client, tableName: 'table', commands, network });
    assert.equal((await repository.getHead({ ...scope, network })).network, network);
    item.network.S = network === 'testnet' ? 'mainnet' : 'testnet';
    await assert.rejects(repository.getHead({ ...scope, network }), /network/);
    delete item.network;
    await assert.rejects(repository.getHead({ ...scope, network }), /network/);
  }
});

test('every durable record round-trips its network and rejects foreign stored state', async () => {
  for (const network of ['testnet', 'mainnet']) {
    const rows = new Map();
    const id = (key) => `${key.pk.S}/${key.sk.S}`;
    const client = clientWith(async ({ input }) => {
      if (input.Key) return { Item: structuredClone(rows.get(id(input.Key))) };
      const operations = input.TransactItems?.map((entry) => Object.values(entry)[0]) || [input];
      for (const operation of operations) {
        if (operation.Item) rows.set(id(operation.Item), structuredClone(operation.Item));
      }
      return {};
    });
    const repository = createDynamoRepository({ client, tableName: 'table', commands, network });
    const bound = { ...scope, network };
    const challenge = {
      ...bound,
      challengeId: 'round-trip',
      nonceHex: 'aa'.repeat(32),
      userDataSha256: 'bb'.repeat(32),
      ownerId: claim.ownerId,
      createdAt: claim.createdAt,
      expiresAt: 1800000300,
    };
    const session = {
      ...challenge,
      tokenHash: 'cc'.repeat(32),
      moduleId: 'unit-module',
      publicKeySha256: 'dd'.repeat(32),
      publicKeyDerBase64: 'dW5pdA==',
      pcrs: { pcr0: '01'.repeat(48), pcr1: '02'.repeat(48), pcr2: '03'.repeat(48) },
    };
    const upload = { ...claim, ...bound };
    const head = {
      ...upload,
      headHash: upload.snapshotSha256,
      snapshotVersionId: 'unit-version',
      leaseExpiresAtMs: 1800000060000,
      updatedAt: claim.createdAt,
    };
    const record = {
      ...head,
      claimFingerprint: upload.requestFingerprint,
      operationDigest: 'ee'.repeat(32),
      receipt: { network },
      committedAt: head.updatedAt,
      head,
    };
    await repository.putChallenge(challenge);
    await repository.consumeChallengeAndCreateSession(challenge, session, 1800000000);
    await repository.takeover({ previous: head, next: head, genesis: true, nowMs: 1800000000000 });
    await repository.claimUpload(upload, 1800000000000);
    await repository.commit({ claim: upload, record, nowMs: 1800000000000 });
    await repository.consumeSessionProof(
      session,
      {
        nonceHex: 'ef'.repeat(32),
        requestDigest: 'f0'.repeat(32),
        method: 'GET',
        path: '/unit',
        bodySha256: '00'.repeat(32),
        timestampMs: '1800000000000',
      },
      1800000000
    );
    assert.equal(rows.size, 6);
    for (const key of rows.keys()) assert.equal(key.startsWith('mainnet#'), network === 'mainnet');
    const reads = [
      ['CHALLENGE', () => repository.getChallenge(challenge.challengeId)],
      ['SESSION', () => repository.getSession(session.tokenHash)],
      ['HEAD', () => repository.getHead(bound)],
      ['COMMIT_CLAIM', () => repository.getClaim(bound, upload.commitId)],
      ['COMMIT', () => repository.getCommit(bound, record.commitId)],
    ];
    for (const [entity, read] of reads) {
      const stored = [...rows.values()].find((row) => row.entity_type.S === entity);
      assert.equal((await read()).network, network);
      stored.network.S = network === 'testnet' ? 'mainnet' : 'testnet';
      await assert.rejects(read, /network/);
      stored.network.S = network;
    }
  }
});
