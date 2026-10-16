import { sha256Hex } from '../src/codec.mjs';
import { ConditionalConflictError } from '../src/errors.mjs';
import { canonicalReceipt } from '../src/protocol.mjs';

export const PCRS = Object.freeze({
  pcr0: '01'.repeat(48),
  pcr1: '02'.repeat(48),
  pcr2: '03'.repeat(48),
});

export const VAULT_ID = '10'.repeat(32);
export const PROFILE_ID = '20'.repeat(32);
export const NETWORK_ID = '30'.repeat(32);
export const ROOT_COMMITMENT = '40'.repeat(32);
export const OWNER_A = `nitro-${'a1'.repeat(32)}`;
export const OWNER_B = `nitro-${'b2'.repeat(32)}`;

export const TEST_CONFIG = Object.freeze({
  challengeTtlSeconds: 120,
  sessionTtlSeconds: 300,
  requestProofMaxSkewSeconds: 30,
  leaseDurationSeconds: 60,
  uploadUrlTtlSeconds: 120,
  maxSnapshotBytes: 67_109_024,
  expectedScope: {
    network: 'testnet',
    vaultId: VAULT_ID,
    profileId: PROFILE_ID,
    networkId: NETWORK_ID,
    rootCommitment: ROOT_COMMITMENT,
  },
  expectedPcrs: PCRS,
});

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

let proofSequence = 0;

export async function testRequestProofVerifier({ expectedMethod, expectedPath, nowMs }) {
  proofSequence += 1;
  const nonceHex = proofSequence.toString(16).padStart(64, '0');
  return {
    nonceHex,
    timestampMs: String(nowMs),
    requestDigest: sha256Hex(`${expectedMethod}\0${expectedPath}\0${nonceHex}`),
    method: expectedMethod,
    path: expectedPath,
    bodySha256: '00'.repeat(32),
  };
}

function exactHead(head, binding, nowMs, leaseMode = 'live', bindFingerprint = true) {
  if (!head) return false;
  const exact =
    head.network === binding.network &&
    head.vaultId === binding.vaultId &&
    head.profileId === binding.profileId &&
    head.networkId === binding.networkId &&
    head.rootCommitment === binding.rootCommitment &&
    head.ownerId === binding.ownerId &&
    head.epoch === binding.epoch &&
    head.snapshotFence === binding.snapshotFence &&
    head.generation === binding.generation &&
    head.headHash === binding.headHash &&
    (!bindFingerprint || head.headFingerprint === binding.headFingerprint);
  if (!exact) return false;
  return leaseMode === 'live' ? head.leaseExpiresAtMs > nowMs : head.leaseExpiresAtMs <= nowMs;
}

export class MemoryRepository {
  challenges = new Map();
  sessions = new Map();
  heads = new Map();
  claims = new Map();
  commits = new Map();
  proofs = new Set();
  calls = [];

  stateId(scope) {
    return `${scope.network}/${scope.vaultId}/${scope.profileId}/${scope.networkId}/${scope.rootCommitment}`;
  }

  commitId(scope, commitId) {
    return `${this.stateId(scope)}/${commitId}`;
  }

  async putChallenge(challenge) {
    if (this.challenges.has(challenge.challengeId)) throw new ConditionalConflictError();
    this.challenges.set(challenge.challengeId, clone(challenge));
  }

  async getChallenge(challengeId) {
    return clone(this.challenges.get(challengeId) || null);
  }

  async consumeChallengeAndCreateSession(challenge, session, nowSeconds) {
    const current = this.challenges.get(challenge.challengeId);
    if (
      !current ||
      current.consumedAt ||
      current.expiresAt <= nowSeconds ||
      current.nonceHex !== challenge.nonceHex ||
      this.sessions.has(session.tokenHash)
    ) {
      throw new ConditionalConflictError();
    }
    current.consumedAt = nowSeconds;
    this.sessions.set(session.tokenHash, clone(session));
  }

  async getSession(tokenHash) {
    return clone(this.sessions.get(tokenHash) || null);
  }

  async consumeSessionProof(session, proof, nowSeconds) {
    const key = `${session.tokenHash}/${proof.nonceHex}`;
    if (session.expiresAt <= nowSeconds || this.proofs.has(key)) {
      throw new ConditionalConflictError();
    }
    this.proofs.add(key);
  }

  async getHead(scope) {
    return clone(this.heads.get(this.stateId(scope)) || null);
  }

  async takeover({ previous, next, nowMs, genesis }) {
    const id = this.stateId(previous);
    const current = this.heads.get(id);
    if (genesis) {
      if (current) throw new ConditionalConflictError();
    } else if (!exactHead(current, previous, nowMs, 'expired')) {
      throw new ConditionalConflictError();
    }
    const updated = current ? { ...current, ...next } : { ...next };
    this.heads.set(id, clone(updated));
    return clone(updated);
  }

  async renew({ binding, nowMs, next }) {
    const id = this.stateId(binding);
    const current = this.heads.get(id);
    if (!exactHead(current, binding, nowMs, 'live')) throw new ConditionalConflictError();
    this.heads.set(id, clone(next));
    return clone(next);
  }

  async claimUpload(claim, nowMs) {
    const binding = {
      ...claim,
      snapshotFence: claim.previousSnapshotFence,
      generation: claim.previousGeneration,
      headHash: claim.previousHash,
    };
    const head = this.heads.get(this.stateId(claim));
    const commitId = this.commitId(claim, claim.commitId);
    if (!exactHead(head, binding, nowMs, 'live') || this.claims.has(commitId)) {
      throw new ConditionalConflictError();
    }
    this.claims.set(commitId, clone(claim));
  }

  async assertHeadBinding(claim, nowMs) {
    const binding = {
      ...claim,
      snapshotFence: claim.previousSnapshotFence,
      generation: claim.previousGeneration,
      headHash: claim.previousHash,
    };
    if (!exactHead(this.heads.get(this.stateId(claim)), binding, nowMs, 'live', false)) {
      throw new ConditionalConflictError();
    }
  }

  async getClaim(scope, commitId) {
    return clone(this.claims.get(this.commitId(scope, commitId)) || null);
  }

  async getCommit(scope, commitId) {
    return clone(this.commits.get(this.commitId(scope, commitId)) || null);
  }

  async commit({ claim, record, nowMs }) {
    this.calls.push({ method: 'commit', commitId: claim.commitId });
    const head = this.heads.get(this.stateId(claim));
    const binding = {
      ...claim,
      snapshotFence: claim.previousSnapshotFence,
      generation: claim.previousGeneration,
      headHash: claim.previousHash,
    };
    const commitId = this.commitId(claim, claim.commitId);
    const storedClaim = this.claims.get(commitId);
    if (
      !exactHead(head, binding, nowMs, 'live', false) ||
      !storedClaim ||
      storedClaim.requestFingerprint !== claim.requestFingerprint ||
      this.commits.has(commitId)
    ) {
      throw new ConditionalConflictError();
    }
    this.commits.set(commitId, clone(record));
    this.heads.set(this.stateId(claim), clone(record.head));
    return clone(record.head);
  }
}

export function seedSession(repository, token, nowMs, overrides = {}) {
  repository.sessions.set(sha256Hex(token), {
    tokenHash: sha256Hex(token),
    network: 'testnet',
    vaultId: VAULT_ID,
    profileId: PROFILE_ID,
    networkId: NETWORK_ID,
    rootCommitment: ROOT_COMMITMENT,
    ownerId: OWNER_A,
    moduleId: 'unit-test-enclave',
    publicKeySha256: 'ab'.repeat(32),
    publicKeyDerBase64: Buffer.from('unit-public-key').toString('base64'),
    pcrs: PCRS,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: Math.floor(nowMs / 1000) + 300,
    ...overrides,
  });
}

export function makeSnapshotStore(clock) {
  const calls = [];
  return {
    bucketName: 'unit-snapshots',
    calls,
    async createUploadTicket(claim, expiresInSeconds, notAfterMs) {
      const boundedSeconds = Math.min(expiresInSeconds, Math.floor((notAfterMs - clock()) / 1000));
      if (boundedSeconds < 1) throw new Error('mock ticket window expired');
      calls.push({
        method: 'ticket',
        claim: clone(claim),
        expiresInSeconds: boundedSeconds,
        notAfterMs,
      });
      return {
        method: 'PUT',
        url: 'https://unit.invalid/upload',
        expires_at: new Date(clock() + boundedSeconds * 1000).toISOString(),
        required_headers: { 'if-none-match': '*' },
      };
    },
    async assertUploadedObject(claim, versionId) {
      calls.push({ method: 'head', claim: clone(claim), versionId });
      return true;
    },
    async resolveUploadedVersion(claim) {
      calls.push({ method: 'resolve', claim: clone(claim) });
      return 'version-1';
    },
    async createDownloadTicket(head, expiresInSeconds, notAfterMs) {
      const boundedSeconds = Math.min(expiresInSeconds, Math.floor((notAfterMs - clock()) / 1000));
      if (boundedSeconds < 1) throw new Error('mock ticket window expired');
      calls.push({
        method: 'download',
        head: clone(head),
        expiresInSeconds: boundedSeconds,
        notAfterMs,
      });
      return {
        method: 'GET',
        url: 'https://unit.invalid/download',
        expires_at: new Date(clock() + boundedSeconds * 1000).toISOString(),
        snapshot: {
          bucket: head.snapshotBucket,
          key: head.snapshotKey,
          version_id: head.snapshotVersionId,
          sha256: head.snapshotSha256,
          size_bytes: head.snapshotSizeBytes,
        },
      };
    },
  };
}

export function makeReceiptSigner() {
  const calls = [];
  return {
    logicalKeyId: 'testnet-receipt-v1',
    calls,
    async sign(payload) {
      calls.push(clone(payload));
      const canonical = canonicalReceipt(payload);
      return {
        ...clone(payload),
        receipt_id: sha256Hex(canonical),
        payload_base64: canonical.toString('base64'),
        signature_base64: Buffer.from('unit-signature').toString('base64'),
        kms_key_arn: 'arn:aws:kms:unit:111122223333:key/receipt',
        signing_algorithm: 'ECDSA_SHA_256',
      };
    },
  };
}

export function deterministicRandom() {
  let counter = 0;
  return (size) => Buffer.alloc(size, ++counter);
}

export async function testSessionSealer(_token, claims) {
  return {
    algorithm: 'RSA-OAEP-256',
    keySha256: claims.publicKeySha256,
    ciphertextBase64: Buffer.from('sealed-unit-session').toString('base64'),
  };
}
