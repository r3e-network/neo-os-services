import { randomBytes as nodeRandomBytes } from 'node:crypto';
import {
  CHALLENGE_ID_BYTES,
  CHALLENGE_NONCE_BYTES,
  CHALLENGE_SCHEMA,
  COMMIT_REQUEST_SCHEMA,
  HEAD_SCHEMA,
  admittedNetwork,
  OPERATION_SCHEMA,
  RECEIPT_SCHEMA,
  REQUEST_PROOF_ALGORITHM,
  REQUEST_PROOF_SCHEMA,
  SESSION_TOKEN_BYTES,
  SNAPSHOT_PREFIX,
  UPLOAD_CLAIM_SCHEMA,
  WIRE_SCHEMA,
  ZERO_HASH,
} from './constants.mjs';
import {
  boundedString,
  decrementU64,
  fingerprint,
  identifier,
  incrementU64,
  nullableIdentifier,
  positiveSize,
  randomBase64Url,
  randomHex,
  requireExactKeys,
  sessionToken,
  sha256,
  sha256Hex,
  u64,
} from './codec.mjs';
import { ApiError, ConditionalConflictError } from './errors.mjs';
import { verifyNitroAttestation as denyAttestation } from './attestation.mjs';
import { sealSessionToken as rsaSealSessionToken } from './session-sealer.mjs';
import { canonicalReceipt, operationDigest } from './protocol.mjs';
import { verifySessionRequestProof } from './request-proof.mjs';

const PCR_SHA384 = /^[0-9a-f]{96}$/;

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function normalizePcr(value, field) {
  if (typeof value !== 'string' || !PCR_SHA384.test(value) || /^0+$/.test(value)) {
    throw new TypeError(`${field} must be a nonzero lowercase SHA-384 hex string`);
  }
  return value;
}

function normalizeExpectedScope(scope) {
  return Object.freeze({
    network: admittedNetwork(scope?.network),
    vaultId: sha256(scope?.vaultId, 'expectedScope.vaultId'),
    profileId: sha256(scope?.profileId, 'expectedScope.profileId'),
    networkId: sha256(scope?.networkId, 'expectedScope.networkId'),
    rootCommitment: sha256(scope?.rootCommitment, 'expectedScope.rootCommitment'),
  });
}

export function normalizeConfig(config = {}) {
  return Object.freeze({
    challengeTtlSeconds: positiveInteger(config.challengeTtlSeconds, 'challengeTtlSeconds'),
    sessionTtlSeconds: positiveInteger(config.sessionTtlSeconds, 'sessionTtlSeconds'),
    requestProofMaxSkewSeconds: positiveInteger(
      config.requestProofMaxSkewSeconds,
      'requestProofMaxSkewSeconds'
    ),
    leaseDurationSeconds: positiveInteger(config.leaseDurationSeconds, 'leaseDurationSeconds'),
    uploadUrlTtlSeconds: positiveInteger(config.uploadUrlTtlSeconds, 'uploadUrlTtlSeconds'),
    maxSnapshotBytes: positiveInteger(config.maxSnapshotBytes, 'maxSnapshotBytes'),
    expectedScope: normalizeExpectedScope(config.expectedScope),
    expectedPcrs: Object.freeze({
      pcr0: normalizePcr(config.expectedPcrs?.pcr0, 'expectedPcrs.pcr0'),
      pcr1: normalizePcr(config.expectedPcrs?.pcr1, 'expectedPcrs.pcr1'),
      pcr2: normalizePcr(config.expectedPcrs?.pcr2, 'expectedPcrs.pcr2'),
    }),
  });
}

function epochSeconds(nowMs) {
  return Math.floor(nowMs / 1000);
}

function isoTime(nowMs) {
  return new Date(nowMs).toISOString();
}

function pathScope(vaultId, profileId) {
  return {
    vaultId: sha256(vaultId, 'vault_id'),
    profileId: sha256(profileId, 'profile_id'),
  };
}

function scopeFrom(vaultId, profileId, networkId, rootCommitment, network) {
  return {
    network,
    ...pathScope(vaultId, profileId),
    networkId: sha256(networkId, 'network_id'),
    rootCommitment: sha256(rootCommitment, 'root_commitment'),
  };
}

function scopeFromSession(session) {
  return scopeFrom(
    session.vaultId,
    session.profileId,
    session.networkId,
    session.rootCommitment,
    session.network
  );
}

function sameScope(record, scope) {
  return (
    record?.network === scope.network &&
    record?.vaultId === scope.vaultId &&
    record?.profileId === scope.profileId &&
    record?.networkId === scope.networkId &&
    record?.rootCommitment === scope.rootCommitment
  );
}

function livePredecessor(head, scope, claim, nowMs) {
  return (
    sameScope(head, scope) &&
    head.ownerId === claim.ownerId &&
    head.epoch === claim.epoch &&
    head.snapshotFence === claim.previousSnapshotFence &&
    head.generation === claim.previousGeneration &&
    head.headHash === claim.previousHash &&
    head.leaseExpiresAtMs > nowMs
  );
}

function headDescriptor(head) {
  return {
    schema: HEAD_SCHEMA,
    network: head.network,
    vault_id: head.vaultId,
    profile_id: head.profileId,
    network_id: head.networkId,
    root_commitment: head.rootCommitment,
    owner_id: head.ownerId,
    epoch: head.epoch,
    snapshot_fence: head.snapshotFence,
    generation: head.generation,
    previous_snapshot_sha256: head.previousHash,
    snapshot_sha256: head.headHash,
    lease_expires_at_ms: String(head.leaseExpiresAtMs),
    commit_id: head.commitId ?? null,
    snapshot_bucket: head.snapshotBucket ?? null,
    snapshot_key: head.snapshotKey ?? null,
    snapshot_version_id: head.snapshotVersionId ?? null,
    snapshot_size_bytes: head.snapshotSizeBytes ?? null,
    updated_at: head.updatedAt,
  };
}

function withHeadFingerprint(head) {
  const next = { ...head };
  next.headFingerprint = fingerprint(headDescriptor(next));
  return next;
}

function publicHead(head) {
  return {
    schema: WIRE_SCHEMA,
    network: head.network,
    vault_id: head.vaultId,
    profile_id: head.profileId,
    network_id: head.networkId,
    root_commitment: head.rootCommitment,
    owner_id: head.ownerId,
    epoch: head.epoch,
    snapshot_fence: head.snapshotFence,
    generation: head.generation,
    previous_snapshot_sha256: head.previousHash,
    snapshot_sha256: head.headHash,
    head_fingerprint: head.headFingerprint,
    lease_expires_at_ms: String(head.leaseExpiresAtMs),
    lease_expires_at: new Date(head.leaseExpiresAtMs).toISOString(),
    commit_id: head.commitId ?? null,
    snapshot:
      head.snapshotKey && head.snapshotVersionId
        ? {
            bucket: head.snapshotBucket,
            key: head.snapshotKey,
            version_id: head.snapshotVersionId,
            sha256: head.snapshotSha256,
            size_bytes: head.snapshotSizeBytes,
          }
        : null,
    updated_at: head.updatedAt,
  };
}

function conflict(code, message) {
  return new ApiError(409, code, message);
}

function ownerIdForPublicKey(publicKeySha256) {
  return `nitro-${publicKeySha256}`;
}

function requireOwner(body, ownerId) {
  const requestedOwner = identifier(body.owner_id, 'owner_id');
  if (requestedOwner !== ownerId) {
    throw new ApiError(403, 'session_scope_mismatch', 'owner_id does not match the session owner');
  }
  return requestedOwner;
}

function uploadDescriptor({
  scope,
  ownerId,
  epoch,
  previousSnapshotFence,
  generation,
  previousHash,
  commitId,
  sha,
  size,
  mutationDigest,
  headFingerprint,
}) {
  return {
    schema: UPLOAD_CLAIM_SCHEMA,
    network: scope.network,
    vault_id: scope.vaultId,
    profile_id: scope.profileId,
    network_id: scope.networkId,
    root_commitment: scope.rootCommitment,
    owner_id: ownerId,
    epoch,
    snapshot_fence: epoch,
    generation,
    previous_generation: decrementU64(generation, 'generation'),
    previous_snapshot_fence: previousSnapshotFence,
    previous_snapshot_sha256: previousHash,
    commit_id: commitId,
    snapshot_sha256: sha,
    snapshot_size_bytes: size,
    mutation_digest: mutationDigest,
    head_fingerprint: headFingerprint,
  };
}

function submissionDescriptor({ scope, ownerId, body }) {
  return {
    schema: COMMIT_REQUEST_SCHEMA,
    network: scope.network,
    vault_id: scope.vaultId,
    profile_id: scope.profileId,
    network_id: scope.networkId,
    root_commitment: scope.rootCommitment,
    owner_id: ownerId,
    epoch: body.epoch,
    snapshot_fence: body.snapshot_fence,
    generation: body.generation,
    previous_generation: decrementU64(body.generation, 'generation'),
    previous_snapshot_fence: body.previous_snapshot_fence,
    previous_snapshot_sha256: body.previous_snapshot_sha256,
    commit_id: body.commit_id,
    snapshot_key: body.snapshot_key,
    snapshot_version_id: body.snapshot_version_id,
    mutation_digest: body.mutation_digest,
  };
}

function exactClaim(claim, expected) {
  return (
    claim &&
    claim.requestFingerprint === fingerprint(expected) &&
    claim.network === expected.network &&
    claim.vaultId === expected.vault_id &&
    claim.profileId === expected.profile_id &&
    claim.networkId === expected.network_id &&
    claim.rootCommitment === expected.root_commitment &&
    claim.ownerId === expected.owner_id &&
    claim.epoch === expected.epoch &&
    claim.snapshotFence === expected.snapshot_fence &&
    claim.generation === expected.generation &&
    claim.previousGeneration === expected.previous_generation &&
    claim.previousSnapshotFence === expected.previous_snapshot_fence &&
    claim.previousHash === expected.previous_snapshot_sha256 &&
    claim.commitId === expected.commit_id &&
    claim.snapshotSha256 === expected.snapshot_sha256 &&
    claim.snapshotSizeBytes === expected.snapshot_size_bytes &&
    claim.mutationDigest === expected.mutation_digest &&
    claim.headFingerprint === expected.head_fingerprint
  );
}

function exactCommit(record, requestFingerprint, scope, ownerId) {
  return (
    record &&
    record.requestFingerprint === requestFingerprint &&
    sameScope(record, scope) &&
    sameScope(record.head, scope) &&
    sameReceiptScope(record.receipt, scope) &&
    record.ownerId === ownerId
  );
}

function sameReceiptScope(receipt, scope) {
  if (
    receipt?.network !== scope.network ||
    receipt?.vault_id !== scope.vaultId ||
    receipt?.profile_id !== scope.profileId ||
    receipt?.network_id !== scope.networkId ||
    receipt?.root_commitment !== scope.rootCommitment
  )
    return false;
  // Check the bytes the signer signs, not just the persisted JSON wrapper.
  // Signature verification remains mandatory in the custody client.
  try {
    const canonical = canonicalReceipt(receipt);
    return (
      receipt.payload_base64 === canonical.toString('base64') &&
      receipt.receipt_id === sha256Hex(canonical)
    );
  } catch {
    return false;
  }
}

function assertVerifiedClaims(verification, challenge, expectedPcrs) {
  if (!verification?.verified) {
    throw new ApiError(
      verification?.statusCode === 403 ? 403 : 503,
      verification?.code || 'attestation_rejected',
      verification?.message || 'Nitro attestation verification did not succeed'
    );
  }
  const claims = verification.claims;
  const valid =
    claims &&
    claims.nonceHex === challenge.nonceHex &&
    claims.userDataHex === challenge.userDataSha256 &&
    claims.pcrs?.pcr0 === expectedPcrs.pcr0 &&
    claims.pcrs?.pcr1 === expectedPcrs.pcr1 &&
    claims.pcrs?.pcr2 === expectedPcrs.pcr2 &&
    typeof claims.moduleId === 'string' &&
    claims.moduleId.length > 0 &&
    claims.moduleId.length <= 256 &&
    /^[0-9a-f]{64}$/.test(claims.publicKeySha256 || '') &&
    challenge.ownerId === ownerIdForPublicKey(claims.publicKeySha256) &&
    typeof claims.publicKeyDerBase64 === 'string' &&
    claims.publicKeyDerBase64.length > 0;
  if (!valid) {
    throw new ApiError(
      403,
      'attestation_claim_mismatch',
      'verified attestation claims do not exactly match the challenge and pinned measurements'
    );
  }
  return claims;
}

export function createCustodyStateAuthority({
  repository,
  snapshotStore,
  receiptSigner,
  verifyAttestation = denyAttestation,
  verifyRequestProof = verifySessionRequestProof,
  sealSessionToken = rsaSealSessionToken,
  randomBytes = nodeRandomBytes,
  clock = Date.now,
  config,
}) {
  if (!repository || !snapshotStore || !receiptSigner) {
    throw new TypeError('repository, snapshotStore and receiptSigner are required');
  }
  const settings = normalizeConfig(config);

  async function authenticate(token, requestedScope, proof, expectedMethod, expectedPath) {
    const normalizedToken = sessionToken(token);
    const tokenHash = sha256Hex(normalizedToken);
    const session = await repository.getSession(tokenHash);
    const now = clock();
    if (!session || session.expiresAt <= epochSeconds(now)) {
      throw new ApiError(401, 'session_expired_or_unknown', 'custody session is absent or expired');
    }
    if (
      !sameScope(session, settings.expectedScope) ||
      session.vaultId !== requestedScope.vaultId ||
      session.profileId !== requestedScope.profileId
    ) {
      throw new ApiError(
        403,
        'session_scope_mismatch',
        'session does not cover this vault/profile'
      );
    }
    if (!session.publicKeyDerBase64) {
      throw new ApiError(
        401,
        'session_reauthentication_required',
        'this pre-v3 session has no attested request-proof key; establish a new session'
      );
    }
    const verifiedProof = await verifyRequestProof({
      session,
      tokenHash,
      proof,
      nowMs: now,
      maximumClockSkewSeconds: settings.requestProofMaxSkewSeconds,
      expectedMethod,
      expectedPath,
    });
    if (!verifiedProof || typeof verifiedProof !== 'object') {
      throw new ApiError(401, 'invalid_request_proof', 'request proof verification failed closed');
    }
    try {
      await repository.consumeSessionProof(session, verifiedProof, epochSeconds(now));
    } catch (error) {
      if (error instanceof ConditionalConflictError) {
        throw new ApiError(
          401,
          'invalid_request_proof',
          'request proof is stale, replayed or no longer bound to a live session'
        );
      }
      throw error;
    }
    return { session, scope: scopeFromSession(session), now };
  }

  function protectedPath(vaultId, profileId, operation) {
    return `/v1/vaults/${vaultId}/profiles/${profileId}/${operation}`;
  }

  async function createChallenge(input) {
    const body = requireExactKeys(input, [
      'vault_id',
      'profile_id',
      'network_id',
      'root_commitment',
      'owner_id',
    ]);
    const scope = scopeFrom(
      body.vault_id,
      body.profile_id,
      body.network_id,
      body.root_commitment,
      settings.expectedScope.network
    );
    if (!sameScope(scope, settings.expectedScope)) {
      throw new ApiError(
        403,
        'scope_not_authorized',
        'vault/profile/network/root scope is not admitted by this authority deployment'
      );
    }
    const ownerId = identifier(body.owner_id, 'owner_id');
    const now = clock();
    const challengeId = randomBase64Url(randomBytes, CHALLENGE_ID_BYTES);
    const nonceHex = randomHex(randomBytes, CHALLENGE_NONCE_BYTES);
    const binding = {
      schema: CHALLENGE_SCHEMA,
      network: settings.expectedScope.network,
      challenge_id: challengeId,
      nonce_hex: nonceHex,
      vault_id: scope.vaultId,
      profile_id: scope.profileId,
      network_id: scope.networkId,
      root_commitment: scope.rootCommitment,
      owner_id: ownerId,
    };
    const challenge = {
      challengeId,
      nonceHex,
      userDataSha256: fingerprint(binding),
      network: settings.expectedScope.network,
      ...scope,
      ownerId,
      createdAt: isoTime(now),
      expiresAt: epochSeconds(now) + settings.challengeTtlSeconds,
    };
    try {
      await repository.putChallenge(challenge);
    } catch (error) {
      if (error instanceof ConditionalConflictError) {
        throw conflict(
          'challenge_collision',
          'challenge identifier collision; request a new challenge'
        );
      }
      throw error;
    }
    return {
      challenge_id: challengeId,
      network: settings.expectedScope.network,
      schema: WIRE_SCHEMA,
      vault_id: scope.vaultId,
      profile_id: scope.profileId,
      network_id: scope.networkId,
      root_commitment: scope.rootCommitment,
      expires_at: new Date(challenge.expiresAt * 1000).toISOString(),
      attestation: {
        nonce_hex: nonceHex,
        user_data_hex: challenge.userDataSha256,
        expected_pcrs: settings.expectedPcrs,
      },
    };
  }

  async function createSession(input) {
    const body = requireExactKeys(input, ['challenge_id', 'attestation_document']);
    const challengeId = boundedString(body.challenge_id, 'challenge_id', 128);
    const attestationDocument = boundedString(
      body.attestation_document,
      'attestation_document',
      196_608
    );
    const challenge = await repository.getChallenge(challengeId);
    const now = clock();
    if (!challenge || challenge.expiresAt <= epochSeconds(now) || challenge.consumedAt) {
      throw new ApiError(
        401,
        'challenge_expired_or_unknown',
        'challenge is absent, consumed or expired'
      );
    }
    if (!sameScope(challenge, settings.expectedScope)) {
      throw new ApiError(
        403,
        'scope_not_authorized',
        'challenge scope is not admitted by this authority'
      );
    }
    const verification = await verifyAttestation({
      attestationDocument,
      expected: {
        nonceHex: challenge.nonceHex,
        userDataHex: challenge.userDataSha256,
        pcrs: settings.expectedPcrs,
      },
      nowMs: now,
    });
    const claims = assertVerifiedClaims(verification, challenge, settings.expectedPcrs);
    const token = randomBase64Url(randomBytes, SESSION_TOKEN_BYTES);
    let sealedToken;
    try {
      sealedToken = await sealSessionToken(token, claims);
    } catch {
      throw new ApiError(
        403,
        'attested_session_key_rejected',
        'verified attestation does not carry an acceptable RSA-3072 session key'
      );
    }
    if (
      sealedToken?.algorithm !== 'RSA-OAEP-256' ||
      sealedToken.keySha256 !== claims.publicKeySha256 ||
      typeof sealedToken.ciphertextBase64 !== 'string' ||
      sealedToken.ciphertextBase64.length === 0
    ) {
      throw new ApiError(500, 'session_sealing_failed', 'session token sealing failed closed');
    }
    const issuedAt = clock();
    if (challenge.expiresAt <= epochSeconds(issuedAt)) {
      throw new ApiError(
        401,
        'challenge_expired_or_unknown',
        'challenge expired while its attestation was being verified'
      );
    }
    const session = {
      tokenHash: sha256Hex(token),
      network: settings.expectedScope.network,
      vaultId: challenge.vaultId,
      profileId: challenge.profileId,
      networkId: challenge.networkId,
      rootCommitment: challenge.rootCommitment,
      ownerId: challenge.ownerId,
      moduleId: claims.moduleId,
      publicKeySha256: claims.publicKeySha256,
      publicKeyDerBase64: claims.publicKeyDerBase64,
      pcrs: claims.pcrs,
      createdAt: isoTime(issuedAt),
      expiresAt: epochSeconds(issuedAt) + settings.sessionTtlSeconds,
    };
    try {
      await repository.consumeChallengeAndCreateSession(challenge, session, epochSeconds(issuedAt));
    } catch (error) {
      if (error instanceof ConditionalConflictError) {
        throw conflict('challenge_raced', 'challenge was consumed or changed concurrently');
      }
      throw error;
    }
    return {
      sealed_session_token: {
        algorithm: sealedToken.algorithm,
        key_sha256: sealedToken.keySha256,
        ciphertext_base64: sealedToken.ciphertextBase64,
      },
      request_header: 'x-custody-session',
      schema: WIRE_SCHEMA,
      network: settings.expectedScope.network,
      vault_id: session.vaultId,
      profile_id: session.profileId,
      network_id: session.networkId,
      root_commitment: session.rootCommitment,
      owner_id: session.ownerId,
      request_proof: {
        schema: REQUEST_PROOF_SCHEMA,
        algorithm: REQUEST_PROOF_ALGORITHM,
        timestamp_header: 'x-custody-pop-timestamp',
        nonce_header: 'x-custody-pop-nonce',
        signature_header: 'x-custody-pop-signature',
        max_clock_skew_seconds: settings.requestProofMaxSkewSeconds,
      },
      expires_at: new Date(session.expiresAt * 1000).toISOString(),
    };
  }

  async function getHead({ vaultId, profileId, token, proof }) {
    const requestedScope = pathScope(vaultId, profileId);
    const { scope } = await authenticate(
      token,
      requestedScope,
      proof,
      'GET',
      protectedPath(vaultId, profileId, 'head')
    );
    const head = await repository.getHead(scope);
    if (!sameScope(head, scope)) {
      throw new ApiError(404, 'head_not_initialized', 'no authoritative HEAD exists');
    }
    return publicHead(head);
  }

  async function takeover({ vaultId, profileId, token, input, proof }) {
    const requestedScope = pathScope(vaultId, profileId);
    const { session, scope } = await authenticate(
      token,
      requestedScope,
      proof,
      'POST',
      protectedPath(vaultId, profileId, 'takeover')
    );
    const body = requireExactKeys(input, [
      'owner_id',
      'previous_owner_id',
      'epoch',
      'snapshot_fence',
      'generation',
      'snapshot_sha256',
      'head_fingerprint',
    ]);
    const ownerId = requireOwner(body, session.ownerId);
    const previousOwnerId = nullableIdentifier(body.previous_owner_id, 'previous_owner_id');
    const epoch = u64(body.epoch, 'epoch');
    const snapshotFence = u64(body.snapshot_fence, 'snapshot_fence');
    const generation = u64(body.generation, 'generation');
    const previousHash = sha256(body.snapshot_sha256, 'snapshot_sha256');
    const previousFingerprint = sha256(body.head_fingerprint, 'head_fingerprint');
    const genesis =
      previousOwnerId === null &&
      epoch === '0' &&
      snapshotFence === '0' &&
      generation === '0' &&
      previousHash === ZERO_HASH &&
      previousFingerprint === ZERO_HASH;
    if (previousOwnerId === null && !genesis) {
      throw new ApiError(
        400,
        'invalid_genesis_binding',
        'a null previous_owner_id is valid only for the all-zero genesis predecessor'
      );
    }
    const current = await repository.getHead(scope);
    if (genesis ? current !== null : !sameScope(current, scope)) {
      throw conflict('takeover_precondition_failed', 'the authoritative HEAD existence changed');
    }
    if (
      current &&
      (!sameScope(current, scope) ||
        current.ownerId !== previousOwnerId ||
        current.epoch !== epoch ||
        current.snapshotFence !== snapshotFence ||
        current.generation !== generation ||
        current.headHash !== previousHash ||
        current.headFingerprint !== previousFingerprint)
    ) {
      throw conflict('takeover_precondition_failed', 'the prior HEAD binding is inexact');
    }
    const transitionNow = clock();
    const nextEpoch = incrementU64(epoch, 'epoch');
    const nextHead = withHeadFingerprint({
      ...(current || {
        ...scope,
        snapshotFence: '0',
        generation: '0',
        previousHash: ZERO_HASH,
        headHash: ZERO_HASH,
      }),
      ownerId,
      epoch: nextEpoch,
      leaseExpiresAtMs: transitionNow + settings.leaseDurationSeconds * 1000,
      updatedAt: isoTime(transitionNow),
    });
    try {
      const head = await repository.takeover({
        previous: {
          ...scope,
          ownerId: previousOwnerId,
          epoch,
          snapshotFence,
          generation,
          headHash: previousHash,
          headFingerprint: previousFingerprint,
        },
        next: nextHead,
        nowMs: transitionNow,
        genesis,
      });
      return publicHead(head);
    } catch (error) {
      if (error instanceof ConditionalConflictError) {
        throw conflict(
          'takeover_precondition_failed',
          'HEAD changed, the prior binding is inexact, or the existing lease is still live'
        );
      }
      throw error;
    }
  }

  async function renew({ vaultId, profileId, token, input, proof }) {
    const requestedScope = pathScope(vaultId, profileId);
    const { session, scope } = await authenticate(
      token,
      requestedScope,
      proof,
      'POST',
      protectedPath(vaultId, profileId, 'renew')
    );
    const body = requireExactKeys(input, [
      'owner_id',
      'epoch',
      'snapshot_fence',
      'generation',
      'snapshot_sha256',
      'head_fingerprint',
    ]);
    const ownerId = requireOwner(body, session.ownerId);
    const binding = {
      ...scope,
      ownerId,
      epoch: u64(body.epoch, 'epoch', { allowZero: false }),
      snapshotFence: u64(body.snapshot_fence, 'snapshot_fence'),
      generation: u64(body.generation, 'generation'),
      headHash: sha256(body.snapshot_sha256, 'snapshot_sha256'),
      headFingerprint: sha256(body.head_fingerprint, 'head_fingerprint'),
    };
    const current = await repository.getHead(scope);
    if (
      !current ||
      !sameScope(current, scope) ||
      current.ownerId !== binding.ownerId ||
      current.epoch !== binding.epoch ||
      current.snapshotFence !== binding.snapshotFence ||
      current.generation !== binding.generation ||
      current.headHash !== binding.headHash ||
      current.headFingerprint !== binding.headFingerprint
    ) {
      throw conflict('renew_precondition_failed', 'the prior HEAD binding is inexact');
    }
    const transitionNow = clock();
    const next = withHeadFingerprint({
      ...current,
      leaseExpiresAtMs: transitionNow + settings.leaseDurationSeconds * 1000,
      updatedAt: isoTime(transitionNow),
    });
    try {
      const head = await repository.renew({
        binding,
        nowMs: transitionNow,
        next,
      });
      return publicHead(head);
    } catch (error) {
      if (error instanceof ConditionalConflictError) {
        throw conflict(
          'renew_precondition_failed',
          'HEAD changed, owner/epoch is stale, or the lease has already expired'
        );
      }
      throw error;
    }
  }

  async function createUploadTicket({ vaultId, profileId, token, input, proof }) {
    const requestedScope = pathScope(vaultId, profileId);
    const { session, scope } = await authenticate(
      token,
      requestedScope,
      proof,
      'POST',
      protectedPath(vaultId, profileId, 'upload-tickets')
    );
    const body = requireExactKeys(input, [
      'commit_id',
      'owner_id',
      'epoch',
      'snapshot_fence',
      'previous_snapshot_fence',
      'generation',
      'previous_snapshot_sha256',
      'head_fingerprint',
      'mutation_digest',
      'snapshot_sha256',
      'snapshot_size_bytes',
    ]);
    const ownerId = requireOwner(body, session.ownerId);
    const expected = uploadDescriptor({
      scope,
      ownerId,
      epoch: u64(body.epoch, 'epoch', { allowZero: false }),
      previousSnapshotFence: u64(body.previous_snapshot_fence, 'previous_snapshot_fence'),
      generation: u64(body.generation, 'generation', { allowZero: false }),
      previousHash: sha256(body.previous_snapshot_sha256, 'previous_snapshot_sha256'),
      commitId: identifier(body.commit_id, 'commit_id'),
      sha: sha256(body.snapshot_sha256, 'snapshot_sha256'),
      size: positiveSize(
        body.snapshot_size_bytes,
        'snapshot_size_bytes',
        settings.maxSnapshotBytes
      ),
      mutationDigest: sha256(body.mutation_digest, 'mutation_digest'),
      headFingerprint: sha256(body.head_fingerprint, 'head_fingerprint'),
    });
    const requestedSnapshotFence = u64(body.snapshot_fence, 'snapshot_fence', {
      allowZero: false,
    });
    if (requestedSnapshotFence !== expected.epoch) {
      throw new ApiError(400, 'invalid_snapshot_fence', 'snapshot_fence must equal lease epoch');
    }
    const requestFingerprint = fingerprint(expected);
    const snapshotKey = [
      scope.network === 'testnet' ? SNAPSHOT_PREFIX : `${SNAPSHOT_PREFIX}/${scope.network}`,
      scope.vaultId,
      scope.profileId,
      expected.generation,
      sha256Hex(expected.commit_id),
      `${expected.snapshot_sha256}.bin`,
    ].join('/');
    const claimNow = clock();
    const claim = {
      requestFingerprint,
      network: settings.expectedScope.network,
      ...scope,
      ownerId,
      epoch: expected.epoch,
      snapshotFence: expected.snapshot_fence,
      previousSnapshotFence: expected.previous_snapshot_fence,
      generation: expected.generation,
      previousGeneration: expected.previous_generation,
      previousHash: expected.previous_snapshot_sha256,
      commitId: expected.commit_id,
      snapshotBucket: snapshotStore.bucketName,
      snapshotKey,
      snapshotSha256: expected.snapshot_sha256,
      snapshotSizeBytes: expected.snapshot_size_bytes,
      mutationDigest: expected.mutation_digest,
      headFingerprint: expected.head_fingerprint,
      createdAt: isoTime(claimNow),
    };
    let idempotent = false;
    try {
      await repository.claimUpload(claim, claimNow);
    } catch (error) {
      if (!(error instanceof ConditionalConflictError)) throw error;
      const existing = await repository.getClaim(scope, claim.commitId);
      if (!existing) {
        throw conflict(
          'upload_precondition_failed',
          'HEAD, owner, epoch, generation, predecessor hash or lease is not current'
        );
      }
      if (!exactClaim(existing, expected) || existing.snapshotKey !== snapshotKey) {
        throw conflict(
          'commit_id_conflict',
          'commit_id is permanently bound to a different upload claim'
        );
      }
      try {
        await repository.assertHeadBinding(claim, clock());
      } catch (headError) {
        if (headError instanceof ConditionalConflictError) {
          throw conflict(
            'upload_precondition_failed',
            'HEAD, owner, epoch, generation, predecessor hash or lease is no longer current'
          );
        }
        throw headError;
      }
      idempotent = true;
    }
    const ticketNow = clock();
    const current = await repository.getHead(scope);
    if (!livePredecessor(current, scope, claim, ticketNow)) {
      throw conflict(
        'upload_precondition_failed',
        'HEAD, owner, epoch, generation, predecessor fence/hash or lease is no longer current'
      );
    }
    const ticket = await snapshotStore.createUploadTicket(
      claim,
      settings.uploadUrlTtlSeconds,
      current.leaseExpiresAtMs
    );
    return {
      idempotent,
      schema: WIRE_SCHEMA,
      commit_id: claim.commitId,
      generation: claim.generation,
      previous_snapshot_sha256: claim.previousHash,
      snapshot_fence: claim.snapshotFence,
      previous_snapshot_fence: claim.previousSnapshotFence,
      mutation_digest: claim.mutationDigest,
      snapshot: {
        bucket: claim.snapshotBucket,
        key: claim.snapshotKey,
        sha256: claim.snapshotSha256,
        size_bytes: claim.snapshotSizeBytes,
      },
      upload: ticket,
    };
  }

  async function createDownloadTicket({ vaultId, profileId, token, input, proof }) {
    const requestedScope = pathScope(vaultId, profileId);
    const { session, scope } = await authenticate(
      token,
      requestedScope,
      proof,
      'POST',
      protectedPath(vaultId, profileId, 'download-tickets')
    );
    const body = requireExactKeys(input, [
      'owner_id',
      'epoch',
      'snapshot_fence',
      'generation',
      'snapshot_sha256',
      'head_fingerprint',
    ]);
    const expected = {
      ownerId: requireOwner(body, session.ownerId),
      epoch: u64(body.epoch, 'epoch', { allowZero: false }),
      snapshotFence: u64(body.snapshot_fence, 'snapshot_fence', { allowZero: false }),
      generation: u64(body.generation, 'generation', { allowZero: false }),
      headHash: sha256(body.snapshot_sha256, 'snapshot_sha256'),
      headFingerprint: sha256(body.head_fingerprint, 'head_fingerprint'),
    };
    const head = await repository.getHead(scope);
    const ticketNow = clock();
    if (
      !head ||
      !sameScope(head, scope) ||
      head.ownerId !== expected.ownerId ||
      head.epoch !== expected.epoch ||
      head.snapshotFence !== expected.snapshotFence ||
      head.generation !== expected.generation ||
      head.headHash !== expected.headHash ||
      head.headFingerprint !== expected.headFingerprint ||
      head.leaseExpiresAtMs <= ticketNow
    ) {
      throw conflict(
        'download_precondition_failed',
        'the requested immutable snapshot is not the exact authoritative HEAD'
      );
    }
    const download = await snapshotStore.createDownloadTicket(
      head,
      settings.uploadUrlTtlSeconds,
      head.leaseExpiresAtMs
    );
    return { schema: WIRE_SCHEMA, ...download };
  }

  async function resolveUpload({ vaultId, profileId, token, input, proof }) {
    const requestedScope = pathScope(vaultId, profileId);
    const { session, scope } = await authenticate(
      token,
      requestedScope,
      proof,
      'POST',
      protectedPath(vaultId, profileId, 'upload-status')
    );
    const body = requireExactKeys(input, ['commit_id', 'owner_id']);
    const commitId = identifier(body.commit_id, 'commit_id');
    const ownerId = requireOwner(body, session.ownerId);
    const claim = await repository.getClaim(scope, commitId);
    if (!claim || !sameScope(claim, scope) || claim.ownerId !== ownerId) {
      throw new ApiError(404, 'upload_claim_not_found', 'no exact upload claim exists');
    }
    let versionId;
    try {
      await repository.assertHeadBinding(claim, clock());
      versionId = await snapshotStore.resolveUploadedVersion(claim);
      await repository.assertHeadBinding(claim, clock());
    } catch (error) {
      if (error instanceof ConditionalConflictError) {
        throw conflict(
          'upload_status_precondition_failed',
          'the upload claim no longer belongs to the current owner and live predecessor HEAD'
        );
      }
      throw error;
    }
    return {
      schema: WIRE_SCHEMA,
      commit_id: claim.commitId,
      owner_id: claim.ownerId,
      snapshot: {
        bucket: claim.snapshotBucket,
        key: claim.snapshotKey,
        version_id: versionId,
        sha256: claim.snapshotSha256,
        size_bytes: claim.snapshotSizeBytes,
      },
    };
  }

  async function commit({ vaultId, profileId, token, input, proof }) {
    const requestedScope = pathScope(vaultId, profileId);
    const { session, scope } = await authenticate(
      token,
      requestedScope,
      proof,
      'POST',
      protectedPath(vaultId, profileId, 'commits')
    );
    const body = requireExactKeys(input, [
      'commit_id',
      'owner_id',
      'epoch',
      'snapshot_fence',
      'previous_snapshot_fence',
      'generation',
      'previous_snapshot_sha256',
      'mutation_digest',
      'snapshot_key',
      'snapshot_version_id',
    ]);
    const ownerId = requireOwner(body, session.ownerId);
    const normalized = {
      commit_id: identifier(body.commit_id, 'commit_id'),
      owner_id: ownerId,
      epoch: u64(body.epoch, 'epoch', { allowZero: false }),
      snapshot_fence: u64(body.snapshot_fence, 'snapshot_fence', { allowZero: false }),
      previous_snapshot_fence: u64(body.previous_snapshot_fence, 'previous_snapshot_fence'),
      generation: u64(body.generation, 'generation', { allowZero: false }),
      previous_snapshot_sha256: sha256(body.previous_snapshot_sha256, 'previous_snapshot_sha256'),
      mutation_digest: sha256(body.mutation_digest, 'mutation_digest'),
      snapshot_key: boundedString(body.snapshot_key, 'snapshot_key', 1024),
      snapshot_version_id: boundedString(body.snapshot_version_id, 'snapshot_version_id', 1024),
    };
    if (normalized.snapshot_fence !== normalized.epoch) {
      throw new ApiError(400, 'invalid_snapshot_fence', 'snapshot_fence must equal lease epoch');
    }
    if (normalized.snapshot_version_id === 'null') {
      throw new ApiError(
        400,
        'invalid_snapshot_version',
        'a concrete S3 version_id is required from the successful PUT response'
      );
    }
    const request = submissionDescriptor({ scope, ownerId, body: normalized });
    const requestFingerprint = fingerprint(request);
    const existing = await repository.getCommit(scope, normalized.commit_id);
    if (existing) {
      if (!exactCommit(existing, requestFingerprint, scope, ownerId)) {
        throw conflict('commit_id_conflict', 'commit_id belongs to a different commit request');
      }
      return {
        idempotent: true,
        head: publicHead(existing.head),
        receipt: existing.receipt,
      };
    }

    const claim = await repository.getClaim(scope, normalized.commit_id);
    const expectedClaim = {
      schema: UPLOAD_CLAIM_SCHEMA,
      network: settings.expectedScope.network,
      vault_id: scope.vaultId,
      profile_id: scope.profileId,
      network_id: scope.networkId,
      root_commitment: scope.rootCommitment,
      owner_id: ownerId,
      epoch: normalized.epoch,
      snapshot_fence: normalized.epoch,
      generation: normalized.generation,
      previous_generation: decrementU64(normalized.generation, 'generation'),
      previous_snapshot_fence: normalized.previous_snapshot_fence,
      previous_snapshot_sha256: normalized.previous_snapshot_sha256,
      commit_id: normalized.commit_id,
      snapshot_sha256: claim?.snapshotSha256,
      snapshot_size_bytes: claim?.snapshotSizeBytes,
      mutation_digest: normalized.mutation_digest,
      head_fingerprint: claim?.headFingerprint,
    };
    if (
      !claim ||
      !exactClaim(claim, expectedClaim) ||
      claim.snapshotKey !== normalized.snapshot_key ||
      claim.snapshotBucket !== snapshotStore.bucketName
    ) {
      throw conflict(
        'upload_claim_mismatch',
        'no exact permanent upload claim exists for this commit request'
      );
    }

    await snapshotStore.assertUploadedObject(claim, normalized.snapshot_version_id);
    const preparedAtMs = clock();
    const committedAt = isoTime(preparedAtMs);
    const leaseExpiresAtMs = preparedAtMs + settings.leaseDurationSeconds * 1000;
    const nextHead = withHeadFingerprint({
      ...scope,
      ownerId,
      epoch: normalized.epoch,
      snapshotFence: normalized.epoch,
      generation: normalized.generation,
      previousHash: claim.previousHash,
      headHash: claim.snapshotSha256,
      leaseExpiresAtMs,
      commitId: normalized.commit_id,
      snapshotBucket: claim.snapshotBucket,
      snapshotKey: claim.snapshotKey,
      snapshotVersionId: normalized.snapshot_version_id,
      snapshotSha256: claim.snapshotSha256,
      snapshotSizeBytes: claim.snapshotSizeBytes,
      updatedAt: committedAt,
    });
    const operation = {
      schema: OPERATION_SCHEMA,
      network: settings.expectedScope.network,
      vault_id: scope.vaultId,
      profile_id: scope.profileId,
      network_id: scope.networkId,
      root_commitment: scope.rootCommitment,
      owner_id: ownerId,
      epoch: normalized.epoch,
      generation: normalized.generation,
      snapshot_fence: normalized.epoch,
      previous_generation: claim.previousGeneration,
      previous_snapshot_fence: claim.previousSnapshotFence,
      previous_snapshot_sha256: claim.previousHash,
      commit_id: normalized.commit_id,
      mutation_digest: claim.mutationDigest,
      snapshot_bucket: claim.snapshotBucket,
      snapshot_key: claim.snapshotKey,
      snapshot_version_id: normalized.snapshot_version_id,
      snapshot_sha256: claim.snapshotSha256,
      snapshot_size_bytes: claim.snapshotSizeBytes,
    };
    const commitOperationDigest = operationDigest(operation);
    const receiptPayload = {
      schema: RECEIPT_SCHEMA,
      network: settings.expectedScope.network,
      commit_id: normalized.commit_id,
      vault_id: scope.vaultId,
      profile_id: scope.profileId,
      network_id: scope.networkId,
      root_commitment: scope.rootCommitment,
      owner_id: ownerId,
      epoch: normalized.epoch,
      snapshot_fence: normalized.epoch,
      generation: normalized.generation,
      previous_generation: claim.previousGeneration,
      previous_snapshot_fence: claim.previousSnapshotFence,
      previous_snapshot_sha256: claim.previousHash,
      snapshot_sha256: claim.snapshotSha256,
      mutation_digest: claim.mutationDigest,
      operation_digest: commitOperationDigest,
      snapshot_bucket: claim.snapshotBucket,
      snapshot_key: claim.snapshotKey,
      snapshot_version_id: normalized.snapshot_version_id,
      snapshot_size_bytes: claim.snapshotSizeBytes,
      lease_expires_at_ms: String(leaseExpiresAtMs),
      committed_at_ms: String(preparedAtMs),
      receipt_key_id: receiptSigner.logicalKeyId,
    };
    const receipt = await receiptSigner.sign(receiptPayload);
    if (!sameReceiptScope(receipt, scope)) {
      throw new ApiError(502, 'receipt_scope_mismatch', 'receipt signer returned a foreign scope');
    }
    const commitNow = clock();
    if (leaseExpiresAtMs <= commitNow) {
      throw conflict(
        'commit_window_expired',
        'receipt signing exhausted the lease-extension window before the atomic commit'
      );
    }
    const record = {
      requestFingerprint,
      claimFingerprint: claim.requestFingerprint,
      network: settings.expectedScope.network,
      ...scope,
      ownerId,
      epoch: normalized.epoch,
      generation: normalized.generation,
      previousGeneration: claim.previousGeneration,
      previousSnapshotFence: claim.previousSnapshotFence,
      previousHash: claim.previousHash,
      mutationDigest: claim.mutationDigest,
      operationDigest: commitOperationDigest,
      snapshotFence: normalized.epoch,
      commitId: normalized.commit_id,
      headHash: claim.snapshotSha256,
      snapshotBucket: claim.snapshotBucket,
      snapshotKey: claim.snapshotKey,
      snapshotVersionId: normalized.snapshot_version_id,
      snapshotSha256: claim.snapshotSha256,
      snapshotSizeBytes: claim.snapshotSizeBytes,
      committedAt,
      receipt,
      head: nextHead,
    };
    try {
      const head = await repository.commit({ claim, record, nowMs: commitNow });
      return { idempotent: false, head: publicHead(head), receipt };
    } catch (error) {
      if (!(error instanceof ConditionalConflictError)) throw error;
      const winner = await repository.getCommit(scope, normalized.commit_id);
      if (exactCommit(winner, requestFingerprint, scope, ownerId)) {
        return {
          idempotent: true,
          head: publicHead(winner.head),
          receipt: winner.receipt,
        };
      }
      throw conflict(
        'commit_precondition_failed',
        'HEAD, owner, epoch, generation, predecessor hash, lease or commit_id is no longer current'
      );
    }
  }

  return Object.freeze({
    createChallenge,
    createSession,
    getHead,
    takeover,
    renew,
    createUploadTicket,
    resolveUpload,
    createDownloadTicket,
    commit,
  });
}
