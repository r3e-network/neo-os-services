import { createCustodyStateAuthority, normalizeConfig } from './authority.mjs';
import { createDynamoRepository } from './dynamo-repository.mjs';
import { createReceiptSigner } from './receipt-signer.mjs';
import { createSnapshotStore } from './snapshot-store.mjs';
import { verifyNitroAttestation as productionAttestationVerifier } from './attestation.mjs';

let authorityPromise;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function positiveInteger(name) {
  const raw = required(name);
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} exceeds the safe integer range`);
  return value;
}

async function buildAuthority() {
  // Capture and validate all admission settings before the first await.
  const config = normalizeConfig({
    challengeTtlSeconds: positiveInteger('CHALLENGE_TTL_SECONDS'),
    sessionTtlSeconds: positiveInteger('SESSION_TTL_SECONDS'),
    requestProofMaxSkewSeconds: positiveInteger('REQUEST_PROOF_MAX_SKEW_SECONDS'),
    leaseDurationSeconds: positiveInteger('LEASE_DURATION_SECONDS'),
    uploadUrlTtlSeconds: positiveInteger('UPLOAD_URL_TTL_SECONDS'),
    maxSnapshotBytes: positiveInteger('MAX_SNAPSHOT_BYTES'),
    expectedScope: {
      network: process.env.EXPECTED_NETWORK,
      vaultId: required('EXPECTED_VAULT_ID'),
      profileId: required('EXPECTED_PROFILE_ID'),
      networkId: required('EXPECTED_NETWORK_ID'),
      rootCommitment: required('EXPECTED_ROOT_COMMITMENT'),
    },
    expectedPcrs: {
      pcr0: required('EXPECTED_PCR0'),
      pcr1: required('EXPECTED_PCR1'),
      pcr2: required('EXPECTED_PCR2'),
    },
  });
  const resources = Object.freeze({
    tableName: required('AUTHORITY_TABLE_NAME'),
    bucketName: required('SNAPSHOT_BUCKET_NAME'),
    encryptionKeyArn: required('SNAPSHOT_KMS_KEY_ARN'),
    retentionDays: positiveInteger('SNAPSHOT_RETENTION_DAYS'),
    keyId: required('RECEIPT_SIGNING_KEY_ARN'),
    logicalKeyId: required('RECEIPT_KEY_ID'),
  });
  const [dynamo, s3, kms, presigner] = await Promise.all([
    import('@aws-sdk/client-dynamodb'),
    import('@aws-sdk/client-s3'),
    import('@aws-sdk/client-kms'),
    import('@aws-sdk/s3-request-presigner'),
  ]);
  const dynamoClient = new dynamo.DynamoDBClient({});
  const s3Client = new s3.S3Client({});
  const kmsClient = new kms.KMSClient({});
  const repository = createDynamoRepository({
    client: dynamoClient,
    tableName: resources.tableName,
    commands: dynamo,
    network: config.expectedScope.network,
  });
  const snapshotStore = createSnapshotStore({
    client: s3Client,
    bucketName: resources.bucketName,
    encryptionKeyArn: resources.encryptionKeyArn,
    retentionDays: resources.retentionDays,
    PutObjectCommand: s3.PutObjectCommand,
    HeadObjectCommand: s3.HeadObjectCommand,
    GetObjectCommand: s3.GetObjectCommand,
    ListObjectVersionsCommand: s3.ListObjectVersionsCommand,
    getSignedUrl: presigner.getSignedUrl,
  });
  const receiptSigner = createReceiptSigner({
    client: kmsClient,
    keyId: resources.keyId,
    logicalKeyId: resources.logicalKeyId,
    SignCommand: kms.SignCommand,
  });
  return createCustodyStateAuthority({
    repository,
    snapshotStore,
    receiptSigner,
    verifyAttestation: productionAttestationVerifier,
    config,
  });
}

export function getAuthority() {
  authorityPromise ??= buildAuthority();
  return authorityPromise;
}

export function __resetRuntimeForTests() {
  authorityPromise = undefined;
}
