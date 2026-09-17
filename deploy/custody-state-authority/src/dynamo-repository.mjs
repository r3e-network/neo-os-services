import { ENTITY } from './constants.mjs';
import { ConditionalConflictError, isConditionalAwsError } from './errors.mjs';

const S = (value) => ({ S: value });
const N = (value) => ({ N: String(value) });

const key = (pk, sk) => ({ pk: S(pk), sk: S(sk) });
const challengeKey = (challengeId) => key(`CHALLENGE#${challengeId}`, 'META');
const sessionKey = (tokenHash) => key(`SESSION#${tokenHash}`, 'META');
const sessionProofKey = (tokenHash, nonceHex) => key(`PROOF#${tokenHash}#${nonceHex}`, 'META');
const scopeKey = ({ vaultId, profileId, networkId, rootCommitment }) =>
  `${vaultId}#${profileId}#${networkId}#${rootCommitment}`;
const stateKey = (scope) => key(`STATE#${scopeKey(scope)}`, 'HEAD');
const claimKey = (scope, commitId) => key(`COMMIT#${scopeKey(scope)}#${commitId}`, 'CLAIM');
const commitKey = (scope, commitId) => key(`COMMIT#${scopeKey(scope)}#${commitId}`, 'RECORD');

function stringValue(item, name, required = true) {
  const value = item?.[name]?.S;
  if (typeof value === 'string') return value;
  if (!required) return undefined;
  throw new Error(`DynamoDB item is missing string field ${name}`);
}

function numberString(item, name) {
  const value = item?.[name]?.N;
  if (typeof value !== 'string') throw new Error(`DynamoDB item is missing number field ${name}`);
  return value;
}

function safeNumber(item, name) {
  const value = Number(numberString(item, name));
  if (!Number.isSafeInteger(value)) throw new Error(`DynamoDB field ${name} is not a safe integer`);
  return value;
}

function challengeFrom(item) {
  if (!item) return null;
  return {
    challengeId: stringValue(item, 'challenge_id'),
    nonceHex: stringValue(item, 'nonce_hex'),
    userDataSha256: stringValue(item, 'user_data_sha256'),
    network: stringValue(item, 'network'),
    vaultId: stringValue(item, 'vault_id'),
    profileId: stringValue(item, 'profile_id'),
    networkId: stringValue(item, 'network_id'),
    rootCommitment: stringValue(item, 'root_commitment'),
    ownerId: stringValue(item, 'owner_id'),
    createdAt: stringValue(item, 'created_at'),
    expiresAt: safeNumber(item, 'expires_at'),
    consumedAt: item.consumed_at ? safeNumber(item, 'consumed_at') : undefined,
  };
}

function sessionFrom(item) {
  if (!item) return null;
  return {
    tokenHash: stringValue(item, 'token_hash'),
    network: stringValue(item, 'network'),
    vaultId: stringValue(item, 'vault_id'),
    profileId: stringValue(item, 'profile_id'),
    networkId: stringValue(item, 'network_id'),
    rootCommitment: stringValue(item, 'root_commitment'),
    ownerId: stringValue(item, 'owner_id'),
    moduleId: stringValue(item, 'module_id'),
    publicKeySha256: stringValue(item, 'public_key_sha256'),
    publicKeyDerBase64: stringValue(item, 'public_key_der_base64', false),
    pcrs: {
      pcr0: stringValue(item, 'pcr0'),
      pcr1: stringValue(item, 'pcr1'),
      pcr2: stringValue(item, 'pcr2'),
    },
    createdAt: stringValue(item, 'created_at'),
    expiresAt: safeNumber(item, 'expires_at'),
  };
}

function headFrom(item) {
  if (!item) return null;
  return {
    vaultId: stringValue(item, 'vault_id'),
    profileId: stringValue(item, 'profile_id'),
    networkId: stringValue(item, 'network_id'),
    rootCommitment: stringValue(item, 'root_commitment'),
    ownerId: stringValue(item, 'owner_id'),
    epoch: numberString(item, 'epoch'),
    snapshotFence: numberString(item, 'snapshot_fence'),
    generation: numberString(item, 'generation'),
    previousHash: stringValue(item, 'previous_hash'),
    headHash: stringValue(item, 'head_hash'),
    headFingerprint: stringValue(item, 'head_fingerprint'),
    leaseExpiresAtMs: safeNumber(item, 'lease_expires_at_ms'),
    commitId: stringValue(item, 'commit_id', false),
    snapshotBucket: stringValue(item, 'snapshot_bucket', false),
    snapshotKey: stringValue(item, 'snapshot_key', false),
    snapshotVersionId: stringValue(item, 'snapshot_version_id', false),
    snapshotSha256: stringValue(item, 'snapshot_sha256', false),
    snapshotSizeBytes: item.snapshot_size_bytes
      ? safeNumber(item, 'snapshot_size_bytes')
      : undefined,
    updatedAt: stringValue(item, 'updated_at'),
  };
}

function claimFrom(item) {
  if (!item) return null;
  return {
    requestFingerprint: stringValue(item, 'request_fingerprint'),
    network: stringValue(item, 'network'),
    vaultId: stringValue(item, 'vault_id'),
    profileId: stringValue(item, 'profile_id'),
    networkId: stringValue(item, 'network_id'),
    rootCommitment: stringValue(item, 'root_commitment'),
    ownerId: stringValue(item, 'owner_id'),
    epoch: numberString(item, 'epoch'),
    snapshotFence: numberString(item, 'snapshot_fence'),
    generation: numberString(item, 'generation'),
    previousGeneration: numberString(item, 'previous_generation'),
    previousSnapshotFence: numberString(item, 'previous_snapshot_fence'),
    previousHash: stringValue(item, 'previous_hash'),
    commitId: stringValue(item, 'commit_id'),
    snapshotBucket: stringValue(item, 'snapshot_bucket'),
    snapshotKey: stringValue(item, 'snapshot_key'),
    snapshotSha256: stringValue(item, 'snapshot_sha256'),
    snapshotSizeBytes: safeNumber(item, 'snapshot_size_bytes'),
    mutationDigest: stringValue(item, 'mutation_digest'),
    headFingerprint: stringValue(item, 'head_fingerprint'),
    createdAt: stringValue(item, 'created_at'),
  };
}

function commitFrom(item) {
  if (!item) return null;
  const head = headFrom(item);
  return {
    requestFingerprint: stringValue(item, 'request_fingerprint'),
    claimFingerprint: stringValue(item, 'claim_fingerprint'),
    network: stringValue(item, 'network'),
    vaultId: head.vaultId,
    profileId: head.profileId,
    networkId: head.networkId,
    rootCommitment: head.rootCommitment,
    ownerId: head.ownerId,
    epoch: head.epoch,
    snapshotFence: head.snapshotFence,
    generation: head.generation,
    previousGeneration: numberString(item, 'previous_generation'),
    previousSnapshotFence: numberString(item, 'previous_snapshot_fence'),
    previousHash: stringValue(item, 'previous_hash'),
    mutationDigest: stringValue(item, 'mutation_digest'),
    operationDigest: stringValue(item, 'operation_digest'),
    commitId: head.commitId,
    headHash: head.headHash,
    snapshotBucket: head.snapshotBucket,
    snapshotKey: head.snapshotKey,
    snapshotVersionId: head.snapshotVersionId,
    snapshotSha256: head.snapshotSha256,
    snapshotSizeBytes: head.snapshotSizeBytes,
    committedAt: stringValue(item, 'committed_at'),
    receipt: JSON.parse(stringValue(item, 'receipt_json')),
    head,
  };
}

function challengeItem(challenge) {
  return {
    ...challengeKey(challenge.challengeId),
    entity_type: S(ENTITY.challenge),
    challenge_id: S(challenge.challengeId),
    nonce_hex: S(challenge.nonceHex),
    user_data_sha256: S(challenge.userDataSha256),
    network: S(challenge.network),
    vault_id: S(challenge.vaultId),
    profile_id: S(challenge.profileId),
    network_id: S(challenge.networkId),
    root_commitment: S(challenge.rootCommitment),
    owner_id: S(challenge.ownerId),
    created_at: S(challenge.createdAt),
    expires_at: N(challenge.expiresAt),
  };
}

function sessionItem(session) {
  return {
    ...sessionKey(session.tokenHash),
    entity_type: S(ENTITY.session),
    token_hash: S(session.tokenHash),
    network: S(session.network),
    vault_id: S(session.vaultId),
    profile_id: S(session.profileId),
    network_id: S(session.networkId),
    root_commitment: S(session.rootCommitment),
    owner_id: S(session.ownerId),
    module_id: S(session.moduleId),
    public_key_sha256: S(session.publicKeySha256),
    public_key_der_base64: S(session.publicKeyDerBase64),
    pcr0: S(session.pcrs.pcr0),
    pcr1: S(session.pcrs.pcr1),
    pcr2: S(session.pcrs.pcr2),
    created_at: S(session.createdAt),
    expires_at: N(session.expiresAt),
  };
}

function headItem(head) {
  const item = {
    ...stateKey(head),
    entity_type: S(ENTITY.head),
    network: S('testnet'),
    vault_id: S(head.vaultId),
    profile_id: S(head.profileId),
    network_id: S(head.networkId),
    root_commitment: S(head.rootCommitment),
    owner_id: S(head.ownerId),
    epoch: N(head.epoch),
    snapshot_fence: N(head.snapshotFence),
    generation: N(head.generation),
    previous_hash: S(head.previousHash),
    head_hash: S(head.headHash),
    head_fingerprint: S(head.headFingerprint),
    lease_expires_at_ms: N(head.leaseExpiresAtMs),
    updated_at: S(head.updatedAt),
  };
  if (head.commitId) item.commit_id = S(head.commitId);
  if (head.snapshotBucket) item.snapshot_bucket = S(head.snapshotBucket);
  if (head.snapshotKey) item.snapshot_key = S(head.snapshotKey);
  if (head.snapshotVersionId) item.snapshot_version_id = S(head.snapshotVersionId);
  if (head.snapshotSha256) item.snapshot_sha256 = S(head.snapshotSha256);
  if (head.snapshotSizeBytes) item.snapshot_size_bytes = N(head.snapshotSizeBytes);
  return item;
}

function claimItem(claim) {
  return {
    ...claimKey(claim, claim.commitId),
    entity_type: S(ENTITY.claim),
    request_fingerprint: S(claim.requestFingerprint),
    network: S(claim.network),
    vault_id: S(claim.vaultId),
    profile_id: S(claim.profileId),
    network_id: S(claim.networkId),
    root_commitment: S(claim.rootCommitment),
    owner_id: S(claim.ownerId),
    epoch: N(claim.epoch),
    snapshot_fence: N(claim.snapshotFence),
    generation: N(claim.generation),
    previous_generation: N(claim.previousGeneration),
    previous_snapshot_fence: N(claim.previousSnapshotFence),
    previous_hash: S(claim.previousHash),
    commit_id: S(claim.commitId),
    snapshot_bucket: S(claim.snapshotBucket),
    snapshot_key: S(claim.snapshotKey),
    snapshot_sha256: S(claim.snapshotSha256),
    snapshot_size_bytes: N(claim.snapshotSizeBytes),
    mutation_digest: S(claim.mutationDigest),
    head_fingerprint: S(claim.headFingerprint),
    created_at: S(claim.createdAt),
  };
}

function commitItem(record) {
  return {
    ...commitKey(record, record.commitId),
    entity_type: S(ENTITY.commit),
    request_fingerprint: S(record.requestFingerprint),
    claim_fingerprint: S(record.claimFingerprint),
    network: S(record.network),
    vault_id: S(record.vaultId),
    profile_id: S(record.profileId),
    network_id: S(record.networkId),
    root_commitment: S(record.rootCommitment),
    owner_id: S(record.ownerId),
    epoch: N(record.epoch),
    snapshot_fence: N(record.snapshotFence),
    generation: N(record.generation),
    previous_generation: N(record.previousGeneration),
    previous_snapshot_fence: N(record.previousSnapshotFence),
    previous_hash: S(record.previousHash),
    mutation_digest: S(record.mutationDigest),
    operation_digest: S(record.operationDigest),
    head_hash: S(record.headHash),
    head_fingerprint: S(record.head.headFingerprint),
    commit_id: S(record.commitId),
    snapshot_bucket: S(record.snapshotBucket),
    snapshot_key: S(record.snapshotKey),
    snapshot_version_id: S(record.snapshotVersionId),
    snapshot_sha256: S(record.snapshotSha256),
    snapshot_size_bytes: N(record.snapshotSizeBytes),
    lease_expires_at_ms: N(record.head.leaseExpiresAtMs),
    committed_at: S(record.committedAt),
    updated_at: S(record.committedAt),
    receipt_json: S(JSON.stringify(record.receipt)),
  };
}

const HEAD_NAMES = Object.freeze({
  '#entity': 'entity_type',
  '#network': 'network',
  '#vault': 'vault_id',
  '#profile': 'profile_id',
  '#networkId': 'network_id',
  '#root': 'root_commitment',
  '#owner': 'owner_id',
  '#epoch': 'epoch',
  '#snapshotFence': 'snapshot_fence',
  '#generation': 'generation',
  '#hash': 'head_hash',
  '#headFingerprint': 'head_fingerprint',
  '#lease': 'lease_expires_at_ms',
});

function headValues(binding, nowMs) {
  return {
    ':head': S(ENTITY.head),
    ':network': S('testnet'),
    ':vault': S(binding.vaultId),
    ':profile': S(binding.profileId),
    ':networkId': S(binding.networkId),
    ':root': S(binding.rootCommitment),
    ':owner': S(binding.ownerId),
    ':epoch': N(binding.epoch),
    ':snapshotFence': N(binding.snapshotFence),
    ':generation': N(binding.generation),
    ':hash': S(binding.headHash),
    ':headFingerprint': S(binding.headFingerprint),
    ':now': N(nowMs),
  };
}

const LIVE_HEAD_CONDITION =
  '#entity = :head AND #network = :network AND #vault = :vault AND #profile = :profile AND #networkId = :networkId AND #root = :root AND #owner = :owner AND #epoch = :epoch AND #snapshotFence = :snapshotFence AND #generation = :generation AND #hash = :hash AND #headFingerprint = :headFingerprint AND #lease > :now';

const LIVE_PREDECESSOR_CONDITION =
  '#entity = :head AND #network = :network AND #vault = :vault AND #profile = :profile AND #networkId = :networkId AND #root = :root AND #owner = :owner AND #epoch = :epoch AND #snapshotFence = :snapshotFence AND #generation = :generation AND #hash = :hash AND #lease > :now';

const PREDECESSOR_HEAD_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(HEAD_NAMES).filter(([name]) => name !== '#headFingerprint'))
);

function predecessorValues(binding, nowMs) {
  const values = headValues(binding, nowMs);
  delete values[':headFingerprint'];
  return values;
}

export function createDynamoRepository({ client, tableName, commands }) {
  if (!client || !tableName || !commands) {
    throw new TypeError('client, tableName and DynamoDB command constructors are required');
  }

  const send = (name, input) => client.send(new commands[name](input));
  const conditional = async (operation) => {
    try {
      return await operation();
    } catch (error) {
      if (isConditionalAwsError(error)) throw new ConditionalConflictError(undefined, error);
      throw error;
    }
  };
  const consistentGet = async (Key) => {
    const result = await send('GetItemCommand', {
      TableName: tableName,
      Key,
      ConsistentRead: true,
    });
    return result.Item ?? null;
  };

  async function putChallenge(challenge) {
    return conditional(() =>
      send('PutItemCommand', {
        TableName: tableName,
        Item: challengeItem(challenge),
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      })
    );
  }

  async function getChallenge(challengeId) {
    return challengeFrom(await consistentGet(challengeKey(challengeId)));
  }

  async function consumeChallengeAndCreateSession(challenge, session, nowSeconds) {
    const names = {
      '#entity': 'entity_type',
      '#network': 'network',
      '#challenge': 'challenge_id',
      '#vault': 'vault_id',
      '#profile': 'profile_id',
      '#networkId': 'network_id',
      '#root': 'root_commitment',
      '#networkId': 'network_id',
      '#root': 'root_commitment',
      '#owner': 'owner_id',
      '#nonce': 'nonce_hex',
      '#binding': 'user_data_sha256',
      '#expires': 'expires_at',
      '#consumed': 'consumed_at',
    };
    const values = {
      ':entity': S(ENTITY.challenge),
      ':network': S('testnet'),
      ':challenge': S(challenge.challengeId),
      ':vault': S(challenge.vaultId),
      ':profile': S(challenge.profileId),
      ':networkId': S(challenge.networkId),
      ':root': S(challenge.rootCommitment),
      ':owner': S(challenge.ownerId),
      ':nonce': S(challenge.nonceHex),
      ':binding': S(challenge.userDataSha256),
      ':now': N(nowSeconds),
    };
    return conditional(() =>
      send('TransactWriteItemsCommand', {
        ClientRequestToken: session.tokenHash.slice(0, 36),
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: challengeKey(challenge.challengeId),
              UpdateExpression: 'SET #consumed = :now',
              ConditionExpression:
                '#entity = :entity AND #network = :network AND #challenge = :challenge AND #vault = :vault AND #profile = :profile AND #networkId = :networkId AND #root = :root AND #owner = :owner AND #nonce = :nonce AND #binding = :binding AND #expires > :now AND attribute_not_exists(#consumed)',
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: sessionItem(session),
              ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
            },
          },
        ],
      })
    );
  }

  async function getSession(tokenHash) {
    return sessionFrom(await consistentGet(sessionKey(tokenHash)));
  }

  async function consumeSessionProof(session, proof, nowSeconds) {
    if (session.expiresAt <= nowSeconds) throw new ConditionalConflictError();
    return conditional(() =>
      send('PutItemCommand', {
        TableName: tableName,
        Item: {
          ...sessionProofKey(session.tokenHash, proof.nonceHex),
          entity_type: S(ENTITY.sessionProof),
          token_hash: S(session.tokenHash),
          public_key_sha256: S(session.publicKeySha256),
          nonce: S(proof.nonceHex),
          request_digest: S(proof.requestDigest),
          method: S(proof.method),
          path: S(proof.path),
          body_sha256: S(proof.bodySha256),
          timestamp_ms: N(proof.timestampMs),
          created_at: S(new Date(Number(proof.timestampMs)).toISOString()),
          expires_at: N(session.expiresAt),
        },
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      })
    );
  }

  async function getHead(scope) {
    return headFrom(await consistentGet(stateKey(scope)));
  }

  async function takeover({ previous, next, nowMs, genesis }) {
    const operation = genesis
      ? {
          Put: {
            TableName: tableName,
            Item: headItem(next),
            ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
          },
        }
      : {
          Update: {
            TableName: tableName,
            Key: stateKey(previous),
            UpdateExpression:
              'SET #owner = :nextOwner, #epoch = :nextEpoch, #lease = :nextLease, #updated = :updated, #headFingerprint = :nextHeadFingerprint',
            ConditionExpression:
              '#entity = :head AND #network = :network AND #vault = :vault AND #profile = :profile AND #networkId = :networkId AND #root = :root AND #owner = :owner AND #epoch = :epoch AND #snapshotFence = :snapshotFence AND #generation = :generation AND #hash = :hash AND #headFingerprint = :headFingerprint AND #lease <= :now',
            ExpressionAttributeNames: {
              ...HEAD_NAMES,
              '#updated': 'updated_at',
            },
            ExpressionAttributeValues: {
              ...headValues(previous, nowMs),
              ':nextOwner': S(next.ownerId),
              ':nextEpoch': N(next.epoch),
              ':nextLease': N(next.leaseExpiresAtMs),
              ':updated': S(next.updatedAt),
              ':nextHeadFingerprint': S(next.headFingerprint),
            },
          },
        };
    await conditional(() =>
      send('TransactWriteItemsCommand', {
        TransactItems: [operation],
      })
    );
    return getHead(next);
  }

  async function renew({ binding, nowMs, next }) {
    const result = await conditional(() =>
      send('UpdateItemCommand', {
        TableName: tableName,
        Key: stateKey(binding),
        UpdateExpression:
          'SET #lease = :nextLease, #updated = :updated, #headFingerprint = :nextHeadFingerprint',
        ConditionExpression: LIVE_HEAD_CONDITION,
        ExpressionAttributeNames: { ...HEAD_NAMES, '#updated': 'updated_at' },
        ExpressionAttributeValues: {
          ...headValues(binding, nowMs),
          ':nextLease': N(next.leaseExpiresAtMs),
          ':updated': S(next.updatedAt),
          ':nextHeadFingerprint': S(next.headFingerprint),
        },
        ReturnValues: 'ALL_NEW',
      })
    );
    return headFrom(result.Attributes);
  }

  async function claimUpload(claim, nowMs) {
    const binding = {
      vaultId: claim.vaultId,
      profileId: claim.profileId,
      networkId: claim.networkId,
      rootCommitment: claim.rootCommitment,
      ownerId: claim.ownerId,
      epoch: claim.epoch,
      snapshotFence: claim.previousSnapshotFence,
      generation: claim.previousGeneration,
      headHash: claim.previousHash,
      headFingerprint: claim.headFingerprint,
    };
    return conditional(() =>
      send('TransactWriteItemsCommand', {
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName,
              Key: stateKey(binding),
              ConditionExpression: LIVE_HEAD_CONDITION,
              ExpressionAttributeNames: HEAD_NAMES,
              ExpressionAttributeValues: headValues(binding, nowMs),
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: claimItem(claim),
              ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
            },
          },
        ],
      })
    );
  }

  async function assertHeadBinding(claim, nowMs) {
    const binding = {
      vaultId: claim.vaultId,
      profileId: claim.profileId,
      networkId: claim.networkId,
      rootCommitment: claim.rootCommitment,
      ownerId: claim.ownerId,
      epoch: claim.epoch,
      snapshotFence: claim.previousSnapshotFence,
      generation: claim.previousGeneration,
      headHash: claim.previousHash,
      headFingerprint: claim.headFingerprint,
    };
    return conditional(() =>
      send('TransactWriteItemsCommand', {
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName,
              Key: stateKey(binding),
              ConditionExpression: LIVE_PREDECESSOR_CONDITION,
              ExpressionAttributeNames: PREDECESSOR_HEAD_NAMES,
              ExpressionAttributeValues: predecessorValues(binding, nowMs),
            },
          },
        ],
      })
    );
  }

  async function getClaim(scope, commitId) {
    return claimFrom(await consistentGet(claimKey(scope, commitId)));
  }

  async function getCommit(scope, commitId) {
    return commitFrom(await consistentGet(commitKey(scope, commitId)));
  }

  async function commit({ claim, record, nowMs }) {
    const binding = {
      vaultId: claim.vaultId,
      profileId: claim.profileId,
      networkId: claim.networkId,
      rootCommitment: claim.rootCommitment,
      ownerId: claim.ownerId,
      epoch: claim.epoch,
      snapshotFence: claim.previousSnapshotFence,
      generation: claim.previousGeneration,
      headHash: claim.previousHash,
      headFingerprint: claim.headFingerprint,
    };
    const claimNames = {
      '#entity': 'entity_type',
      '#network': 'network',
      '#fingerprint': 'request_fingerprint',
      '#vault': 'vault_id',
      '#profile': 'profile_id',
      '#networkId': 'network_id',
      '#root': 'root_commitment',
      '#owner': 'owner_id',
      '#epoch': 'epoch',
      '#snapshotFence': 'snapshot_fence',
      '#generation': 'generation',
      '#previousGeneration': 'previous_generation',
      '#previousSnapshotFence': 'previous_snapshot_fence',
      '#previousHash': 'previous_hash',
      '#commit': 'commit_id',
      '#bucket': 'snapshot_bucket',
      '#key': 'snapshot_key',
      '#sha': 'snapshot_sha256',
      '#size': 'snapshot_size_bytes',
      '#mutation': 'mutation_digest',
      '#headFingerprint': 'head_fingerprint',
    };
    const claimValues = {
      ':claim': S(ENTITY.claim),
      ':network': S('testnet'),
      ':fingerprint': S(claim.requestFingerprint),
      ':vault': S(claim.vaultId),
      ':profile': S(claim.profileId),
      ':networkId': S(claim.networkId),
      ':root': S(claim.rootCommitment),
      ':owner': S(claim.ownerId),
      ':epoch': N(claim.epoch),
      ':snapshotFence': N(claim.snapshotFence),
      ':generation': N(claim.generation),
      ':previousGeneration': N(claim.previousGeneration),
      ':previousSnapshotFence': N(claim.previousSnapshotFence),
      ':previousHash': S(claim.previousHash),
      ':commit': S(claim.commitId),
      ':bucket': S(claim.snapshotBucket),
      ':key': S(claim.snapshotKey),
      ':sha': S(claim.snapshotSha256),
      ':size': N(claim.snapshotSizeBytes),
      ':mutation': S(claim.mutationDigest),
      ':headFingerprint': S(claim.headFingerprint),
    };
    const updateNames = {
      ...HEAD_NAMES,
      '#commit': 'commit_id',
      '#bucket': 'snapshot_bucket',
      '#key': 'snapshot_key',
      '#version': 'snapshot_version_id',
      '#sha': 'snapshot_sha256',
      '#size': 'snapshot_size_bytes',
      '#updated': 'updated_at',
      '#previousHash': 'previous_hash',
    };
    const updateValues = {
      ...predecessorValues(binding, nowMs),
      ':nextGeneration': N(record.generation),
      ':nextSnapshotFence': N(record.snapshotFence),
      ':nextHash': S(record.headHash),
      ':nextPreviousHash': S(record.previousHash),
      ':nextHeadFingerprint': S(record.head.headFingerprint),
      ':nextLease': N(record.head.leaseExpiresAtMs),
      ':commit': S(record.commitId),
      ':bucket': S(record.snapshotBucket),
      ':key': S(record.snapshotKey),
      ':version': S(record.snapshotVersionId),
      ':sha': S(record.snapshotSha256),
      ':size': N(record.snapshotSizeBytes),
      ':updated': S(record.committedAt),
    };
    await conditional(() =>
      send('TransactWriteItemsCommand', {
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName,
              Key: claimKey(claim, claim.commitId),
              ConditionExpression:
                '#entity = :claim AND #network = :network AND #fingerprint = :fingerprint AND #vault = :vault AND #profile = :profile AND #networkId = :networkId AND #root = :root AND #owner = :owner AND #epoch = :epoch AND #snapshotFence = :snapshotFence AND #generation = :generation AND #previousGeneration = :previousGeneration AND #previousSnapshotFence = :previousSnapshotFence AND #previousHash = :previousHash AND #commit = :commit AND #bucket = :bucket AND #key = :key AND #sha = :sha AND #size = :size AND #mutation = :mutation AND #headFingerprint = :headFingerprint',
              ExpressionAttributeNames: claimNames,
              ExpressionAttributeValues: claimValues,
            },
          },
          {
            Update: {
              TableName: tableName,
              Key: stateKey(binding),
              UpdateExpression:
                'SET #generation = :nextGeneration, #snapshotFence = :nextSnapshotFence, #previousHash = :nextPreviousHash, #hash = :nextHash, #headFingerprint = :nextHeadFingerprint, #lease = :nextLease, #commit = :commit, #bucket = :bucket, #key = :key, #version = :version, #sha = :sha, #size = :size, #updated = :updated',
              ConditionExpression: LIVE_PREDECESSOR_CONDITION,
              ExpressionAttributeNames: updateNames,
              ExpressionAttributeValues: updateValues,
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: commitItem(record),
              ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
            },
          },
        ],
      })
    );
    return record.head;
  }

  return Object.freeze({
    putChallenge,
    getChallenge,
    consumeChallengeAndCreateSession,
    getSession,
    consumeSessionProof,
    getHead,
    takeover,
    renew,
    claimUpload,
    assertHeadBinding,
    getClaim,
    getCommit,
    commit,
  });
}

export const __keysForTests = Object.freeze({
  challengeKey,
  sessionKey,
  sessionProofKey,
  stateKey,
  claimKey,
  commitKey,
});
