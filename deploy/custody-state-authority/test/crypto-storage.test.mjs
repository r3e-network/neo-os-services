import assert from 'node:assert/strict';
import { constants as cryptoConstants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import test from 'node:test';
import { createReceiptSigner } from '../src/receipt-signer.mjs';
import { __snapshotInternalsForTests, createSnapshotStore } from '../src/snapshot-store.mjs';
import { RECEIPT_SCHEMA } from '../src/constants.mjs';
import { sha256Hex } from '../src/codec.mjs';
import { sealSessionToken } from '../src/session-sealer.mjs';

class PutObjectCommand {
  constructor(input) {
    this.input = input;
  }
}

class HeadObjectCommand {
  constructor(input) {
    this.input = input;
  }
}

class GetObjectCommand {
  constructor(input) {
    this.input = input;
  }
}

class ListObjectVersionsCommand {
  constructor(input) {
    this.input = input;
  }
}

class SignCommand {
  constructor(input) {
    this.input = input;
  }
}

const now = 1_800_000_000_000;
const encryptionKeyArn = 'arn:aws:kms:us-east-1:111122223333:key/snapshot';
const claim = {
  requestFingerprint: '61'.repeat(32),
  network: 'testnet',
  vaultId: '10'.repeat(32),
  profileId: '20'.repeat(32),
  networkId: '30'.repeat(32),
  rootCommitment: '40'.repeat(32),
  ownerId: `nitro-${'a1'.repeat(32)}`,
  epoch: '1',
  snapshotFence: '1',
  previousSnapshotFence: '0',
  generation: '1',
  previousGeneration: '0',
  previousHash: '00'.repeat(32),
  commitId: 'commit-1',
  snapshotKey: `snapshots/v2/${'10'.repeat(32)}/${'20'.repeat(32)}/1/commit-1/hash.bin`,
  snapshotSha256: '11'.repeat(32),
  snapshotSizeBytes: 2048,
  mutationDigest: '51'.repeat(32),
  headFingerprint: '71'.repeat(32),
};

test('upload ticket signs checksum, KMS, object lock, metadata and no-overwrite headers', async () => {
  let signedCommand;
  const store = createSnapshotStore({
    client: { send: async () => ({}) },
    bucketName: 'bucket',
    encryptionKeyArn,
    retentionDays: 3650,
    PutObjectCommand,
    HeadObjectCommand,
    GetObjectCommand,
    ListObjectVersionsCommand,
    clock: () => now,
    async getSignedUrl(_client, command, options) {
      signedCommand = command;
      assert.equal(options.expiresIn, 60);
      assert.equal(options.signingDate.toISOString(), new Date(now).toISOString());
      assert.equal(options.signableHeaders.has('if-none-match'), true);
      assert.equal(options.unhoistableHeaders.has('x-amz-object-lock-mode'), true);
      assert.equal(options.unhoistableHeaders.has('x-amz-meta-commit-id'), true);
      return 'https://unit.invalid/presigned';
    },
  });
  const ticket = await store.createUploadTicket(claim, 120, now + 60_000);
  assert.equal(ticket.expires_at, new Date(now + 60_000).toISOString());
  assert.equal(signedCommand.input.IfNoneMatch, '*');
  assert.equal(signedCommand.input.ServerSideEncryption, 'aws:kms');
  assert.equal(signedCommand.input.SSEKMSKeyId, encryptionKeyArn);
  assert.equal(signedCommand.input.ObjectLockMode, 'COMPLIANCE');
  assert.equal(signedCommand.input.BucketKeyEnabled, true);
  assert.equal(ticket.required_headers['if-none-match'], '*');
  assert.equal(ticket.required_headers['x-amz-meta-epoch'], '1');
  assert.equal(ticket.required_headers['x-amz-meta-previous-snapshot-fence'], '0');
  assert.equal(ticket.required_headers['x-amz-meta-claim-fingerprint'], claim.requestFingerprint);
  assert.equal(
    ticket.required_headers['x-amz-checksum-sha256'],
    Buffer.from('11'.repeat(32), 'hex').toString('base64')
  );
});

test('commit-side object check requires the exact immutable encrypted S3 version', async () => {
  const metadata = __snapshotInternalsForTests.metadataFor(claim);
  let object = {
    VersionId: 'version-1',
    ContentLength: 2048,
    ContentType: 'application/octet-stream',
    ChecksumSHA256: Buffer.from('11'.repeat(32), 'hex').toString('base64'),
    ServerSideEncryption: 'aws:kms',
    SSEKMSKeyId: encryptionKeyArn,
    BucketKeyEnabled: true,
    ObjectLockMode: 'COMPLIANCE',
    ObjectLockRetainUntilDate: new Date(now + 86_400_000),
    Metadata: metadata,
  };
  const store = createSnapshotStore({
    client: { send: async () => object },
    bucketName: 'bucket',
    encryptionKeyArn,
    retentionDays: 3650,
    PutObjectCommand,
    HeadObjectCommand,
    GetObjectCommand,
    ListObjectVersionsCommand,
    getSignedUrl: async () => 'unused',
    clock: () => now,
  });
  assert.equal(await store.assertUploadedObject(claim, 'version-1'), true);
  object = { ...object, SSEKMSKeyId: 'wrong-key' };
  await assert.rejects(store.assertUploadedObject(claim, 'version-1'), (error) => {
    assert.equal(error.code, 'snapshot_object_mismatch');
    return true;
  });
});

test('ambiguous PUT recovery accepts only one exact immutable S3 version', async () => {
  const metadata = __snapshotInternalsForTests.metadataFor(claim);
  const object = {
    VersionId: 'version-1',
    ContentLength: 2048,
    ContentType: 'application/octet-stream',
    ChecksumSHA256: Buffer.from('11'.repeat(32), 'hex').toString('base64'),
    ServerSideEncryption: 'aws:kms',
    SSEKMSKeyId: encryptionKeyArn,
    BucketKeyEnabled: true,
    ObjectLockMode: 'COMPLIANCE',
    ObjectLockRetainUntilDate: new Date(now + 86_400_000),
    Metadata: metadata,
  };
  let listing = {
    IsTruncated: false,
    Versions: [{ Key: claim.snapshotKey, VersionId: 'version-1' }],
    DeleteMarkers: [],
  };
  const client = {
    async send(command) {
      return command instanceof ListObjectVersionsCommand ? listing : object;
    },
  };
  const store = createSnapshotStore({
    client,
    bucketName: 'bucket',
    encryptionKeyArn,
    retentionDays: 3650,
    PutObjectCommand,
    HeadObjectCommand,
    GetObjectCommand,
    ListObjectVersionsCommand,
    getSignedUrl: async () => 'unused',
    clock: () => now,
  });
  assert.equal(await store.resolveUploadedVersion(claim), 'version-1');

  listing = {
    ...listing,
    Versions: [
      { Key: claim.snapshotKey, VersionId: 'version-1' },
      { Key: claim.snapshotKey, VersionId: 'version-2' },
    ],
  };
  await assert.rejects(
    store.resolveUploadedVersion(claim),
    (error) => error.code === 'snapshot_version_ambiguous'
  );
  listing = { IsTruncated: false, Versions: [], DeleteMarkers: [] };
  await assert.rejects(
    store.resolveUploadedVersion(claim),
    (error) => error.code === 'snapshot_not_uploaded'
  );
});

test('download ticket is pinned to the committed bucket, key and S3 version', async () => {
  let signedCommand;
  const store = createSnapshotStore({
    client: { send: async () => ({}) },
    bucketName: 'bucket',
    encryptionKeyArn,
    retentionDays: 3650,
    PutObjectCommand,
    HeadObjectCommand,
    GetObjectCommand,
    ListObjectVersionsCommand,
    async getSignedUrl(_client, command, options) {
      signedCommand = command;
      assert.equal(options.expiresIn, 60);
      assert.equal(options.signingDate.toISOString(), new Date(now).toISOString());
      return 'https://unit.invalid/download';
    },
    clock: () => now,
  });
  const ticket = await store.createDownloadTicket(
    {
      snapshotBucket: 'bucket',
      snapshotKey: claim.snapshotKey,
      snapshotVersionId: 'version-1',
      snapshotSha256: claim.snapshotSha256,
      snapshotSizeBytes: claim.snapshotSizeBytes,
    },
    120,
    now + 60_000
  );
  assert.deepEqual(signedCommand.input, {
    Bucket: 'bucket',
    Key: claim.snapshotKey,
    VersionId: 'version-1',
    ChecksumMode: 'ENABLED',
  });
  assert.deepEqual(ticket.snapshot, {
    bucket: 'bucket',
    key: claim.snapshotKey,
    version_id: 'version-1',
    sha256: claim.snapshotSha256,
    size_bytes: claim.snapshotSizeBytes,
  });
});

test('ticket lifetime can never exceed the absolute lease deadline', () => {
  const window = __snapshotInternalsForTests.ticketWindow(now, 120, now + 15_999);
  assert.equal(window.expiresIn, 15);
  assert.equal(window.signingDate.toISOString(), new Date(now).toISOString());
  assert.equal(window.expiresAt.toISOString(), new Date(now + 15_000).toISOString());
  assert.throws(
    () => __snapshotInternalsForTests.ticketWindow(now, 120, now + 999),
    (error) => error.code === 'ticket_window_expired'
  );
});

test('receipt signer asks an asymmetric KMS key to sign canonical bytes', async () => {
  let command;
  const signer = createReceiptSigner({
    client: {
      async send(value) {
        command = value;
        return {
          Signature: Buffer.from('signature'),
          KeyId: 'arn:unit:key',
          SigningAlgorithm: 'ECDSA_SHA_256',
        };
      },
    },
    keyId: 'arn:unit:key',
    logicalKeyId: 'testnet-receipt-v1',
    SignCommand,
  });
  const receipt = await signer.sign({
    schema: RECEIPT_SCHEMA,
    network: 'testnet',
    vault_id: claim.vaultId,
    profile_id: claim.profileId,
    network_id: claim.networkId,
    root_commitment: claim.rootCommitment,
    commit_id: claim.commitId,
    operation_digest: '81'.repeat(32),
    mutation_digest: claim.mutationDigest,
    previous_generation: claim.previousGeneration,
    previous_snapshot_fence: claim.previousSnapshotFence,
    previous_snapshot_sha256: claim.previousHash,
    generation: claim.generation,
    snapshot_sha256: claim.snapshotSha256,
    epoch: claim.epoch,
    snapshot_fence: claim.snapshotFence,
    owner_id: claim.ownerId,
    snapshot_bucket: 'bucket',
    snapshot_key: claim.snapshotKey,
    snapshot_version_id: 'version-1',
    snapshot_size_bytes: claim.snapshotSizeBytes,
    lease_expires_at_ms: '1800000060000',
    committed_at_ms: String(now),
    receipt_key_id: 'testnet-receipt-v1',
  });
  assert.equal(command.input.MessageType, 'RAW');
  assert.equal(command.input.SigningAlgorithm, 'ECDSA_SHA_256');
  assert.ok(Buffer.from(command.input.Message).length > 500);
  assert.equal(receipt.receipt_key_id, 'testnet-receipt-v1');
  assert.equal(receipt.kms_key_arn, 'arn:unit:key');
  assert.equal(
    Buffer.from(receipt.payload_base64, 'base64').toString(),
    Buffer.from(command.input.Message).toString()
  );
});

test('session token is sealed to the attested RSA-3072 public key', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const der = publicKey.export({ format: 'der', type: 'spki' });
  const token = 'T'.repeat(43);
  const sealed = await sealSessionToken(token, {
    publicKeyDerBase64: der.toString('base64'),
    publicKeySha256: sha256Hex(der),
  });
  const plaintext = privateDecrypt(
    {
      key: privateKey,
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(sealed.ciphertextBase64, 'base64')
  );
  assert.equal(sealed.algorithm, 'RSA-OAEP-256');
  assert.equal(plaintext.toString('ascii'), token);
});
