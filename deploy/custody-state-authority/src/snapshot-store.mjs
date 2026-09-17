import { SNAPSHOT_CONTENT_TYPE } from './constants.mjs';
import { ApiError } from './errors.mjs';

function checksumBase64(hex) {
  return Buffer.from(hex, 'hex').toString('base64');
}

function metadataFor(claim) {
  return {
    network: claim.network,
    'vault-id': claim.vaultId,
    'profile-id': claim.profileId,
    'network-id': claim.networkId,
    'root-commitment': claim.rootCommitment,
    'owner-id': claim.ownerId,
    epoch: claim.epoch,
    'snapshot-fence': claim.snapshotFence,
    generation: claim.generation,
    'previous-generation': claim.previousGeneration,
    'previous-snapshot-fence': claim.previousSnapshotFence,
    'previous-hash': claim.previousHash,
    'commit-id': claim.commitId,
    'claim-fingerprint': claim.requestFingerprint,
    'head-fingerprint': claim.headFingerprint,
    'mutation-digest': claim.mutationDigest,
    'snapshot-sha256': claim.snapshotSha256,
  };
}

function sameMetadata(actual = {}, expected) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    Object.entries(expected).every(([key, value]) => actual[key] === value)
  );
}

function ticketWindow(nowMs, requestedSeconds, notAfterMs) {
  if (
    !Number.isSafeInteger(requestedSeconds) ||
    requestedSeconds < 1 ||
    !Number.isSafeInteger(notAfterMs)
  ) {
    throw new TypeError('ticket lifetime and absolute lease deadline are required');
  }
  const expiresIn = Math.min(requestedSeconds, Math.floor((notAfterMs - nowMs) / 1000));
  if (expiresIn < 1) {
    throw new ApiError(
      409,
      'ticket_window_expired',
      'the authoritative lease cannot cover another full second of ticket lifetime'
    );
  }
  return {
    expiresIn,
    signingDate: new Date(nowMs),
    expiresAt: new Date(nowMs + expiresIn * 1000),
  };
}

export function createSnapshotStore({
  client,
  bucketName,
  encryptionKeyArn,
  retentionDays,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  getSignedUrl,
  clock = Date.now,
}) {
  if (
    !client ||
    !bucketName ||
    !encryptionKeyArn ||
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < 1 ||
    !PutObjectCommand ||
    !HeadObjectCommand ||
    !GetObjectCommand ||
    !ListObjectVersionsCommand ||
    !getSignedUrl
  ) {
    throw new TypeError('complete S3 snapshot-store configuration is required');
  }

  async function createUploadTicket(claim, expiresInSeconds, notAfterMs) {
    const now = clock();
    const window = ticketWindow(now, expiresInSeconds, notAfterMs);
    const retainUntil = new Date(now + retentionDays * 86_400_000);
    const metadata = metadataFor(claim);
    const headers = {
      'content-length': String(claim.snapshotSizeBytes),
      'content-type': SNAPSHOT_CONTENT_TYPE,
      'if-none-match': '*',
      'x-amz-checksum-sha256': checksumBase64(claim.snapshotSha256),
      'x-amz-server-side-encryption': 'aws:kms',
      'x-amz-server-side-encryption-aws-kms-key-id': encryptionKeyArn,
      'x-amz-server-side-encryption-bucket-key-enabled': 'true',
      'x-amz-object-lock-mode': 'COMPLIANCE',
      'x-amz-object-lock-retain-until-date': retainUntil.toISOString(),
      ...Object.fromEntries(
        Object.entries(metadata).map(([key, value]) => [`x-amz-meta-${key}`, value])
      ),
    };
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: claim.snapshotKey,
      ContentLength: claim.snapshotSizeBytes,
      ContentType: SNAPSHOT_CONTENT_TYPE,
      IfNoneMatch: '*',
      ChecksumSHA256: checksumBase64(claim.snapshotSha256),
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: encryptionKeyArn,
      BucketKeyEnabled: true,
      ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate: retainUntil,
      Metadata: metadata,
    });
    const metadataHeaders = Object.keys(metadata).map((key) => `x-amz-meta-${key}`);
    const url = await getSignedUrl(client, command, {
      expiresIn: window.expiresIn,
      signingDate: window.signingDate,
      signableHeaders: new Set(['content-length', 'content-type', 'if-none-match']),
      unhoistableHeaders: new Set([
        'x-amz-checksum-sha256',
        'x-amz-server-side-encryption',
        'x-amz-server-side-encryption-aws-kms-key-id',
        'x-amz-server-side-encryption-bucket-key-enabled',
        'x-amz-object-lock-mode',
        'x-amz-object-lock-retain-until-date',
        ...metadataHeaders,
      ]),
    });
    return {
      method: 'PUT',
      url,
      expires_at: window.expiresAt.toISOString(),
      required_headers: headers,
    };
  }

  async function assertUploadedObject(claim, versionId) {
    let object;
    try {
      object = await client.send(
        new HeadObjectCommand({
          Bucket: bucketName,
          Key: claim.snapshotKey,
          VersionId: versionId,
          ChecksumMode: 'ENABLED',
        })
      );
    } catch (error) {
      if (error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) {
        throw new ApiError(409, 'snapshot_not_found', 'the claimed immutable S3 version is absent');
      }
      throw error;
    }
    const expectedMetadata = metadataFor(claim);
    const retainUntil = object.ObjectLockRetainUntilDate
      ? new Date(object.ObjectLockRetainUntilDate).getTime()
      : Number.NaN;
    const matches =
      object.VersionId === versionId &&
      object.ContentLength === claim.snapshotSizeBytes &&
      object.ContentType === SNAPSHOT_CONTENT_TYPE &&
      object.ChecksumSHA256 === checksumBase64(claim.snapshotSha256) &&
      object.ServerSideEncryption === 'aws:kms' &&
      object.SSEKMSKeyId === encryptionKeyArn &&
      object.BucketKeyEnabled === true &&
      object.ObjectLockMode === 'COMPLIANCE' &&
      Number.isFinite(retainUntil) &&
      retainUntil > clock() &&
      sameMetadata(object.Metadata, expectedMetadata);
    if (!matches) {
      throw new ApiError(
        409,
        'snapshot_object_mismatch',
        'S3 version does not exactly match the permanent claim, checksum, encryption and retention controls'
      );
    }
    return true;
  }

  async function resolveUploadedVersion(claim) {
    const listing = await client.send(
      new ListObjectVersionsCommand({
        Bucket: bucketName,
        Prefix: claim.snapshotKey,
        MaxKeys: 3,
      })
    );
    const versions = (listing.Versions || []).filter(
      (version) => version.Key === claim.snapshotKey && typeof version.VersionId === 'string'
    );
    const deleteMarkers = (listing.DeleteMarkers || []).filter(
      (marker) => marker.Key === claim.snapshotKey
    );
    if (listing.IsTruncated || deleteMarkers.length || versions.length > 1) {
      throw new ApiError(
        409,
        'snapshot_version_ambiguous',
        'the immutable claim does not resolve to exactly one recoverable S3 version'
      );
    }
    if (versions.length === 0) {
      throw new ApiError(404, 'snapshot_not_uploaded', 'no S3 version exists for this upload claim');
    }
    const versionId = versions[0].VersionId;
    if (versionId.length === 0 || versionId.length > 1024 || /\p{Cc}/u.test(versionId)) {
      throw new ApiError(409, 'snapshot_version_ambiguous', 'S3 returned an invalid version id');
    }
    await assertUploadedObject(claim, versionId);
    return versionId;
  }

  async function createDownloadTicket(head, expiresInSeconds, notAfterMs) {
    if (
      !head.snapshotKey ||
      !head.snapshotVersionId ||
      head.snapshotBucket !== bucketName ||
      !head.snapshotSha256 ||
      !Number.isSafeInteger(head.snapshotSizeBytes) ||
      head.snapshotSizeBytes < 1
    ) {
      throw new ApiError(
        409,
        'head_snapshot_incomplete',
        'the authoritative HEAD does not bind one complete immutable snapshot version'
      );
    }
    const now = clock();
    const window = ticketWindow(now, expiresInSeconds, notAfterMs);
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: head.snapshotKey,
      VersionId: head.snapshotVersionId,
      ChecksumMode: 'ENABLED',
    });
    const url = await getSignedUrl(client, command, {
      expiresIn: window.expiresIn,
      signingDate: window.signingDate,
    });
    return {
      method: 'GET',
      url,
      expires_at: window.expiresAt.toISOString(),
      snapshot: {
        bucket: bucketName,
        key: head.snapshotKey,
        version_id: head.snapshotVersionId,
        sha256: head.snapshotSha256,
        size_bytes: head.snapshotSizeBytes,
      },
    };
  }

  return Object.freeze({
    bucketName,
    createUploadTicket,
    createDownloadTicket,
    assertUploadedObject,
    resolveUploadedVersion,
  });
}

export const __snapshotInternalsForTests = Object.freeze({
  checksumBase64,
  metadataFor,
  ticketWindow,
});
