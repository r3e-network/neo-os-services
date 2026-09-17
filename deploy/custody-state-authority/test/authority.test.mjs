import assert from 'node:assert/strict';
import test from 'node:test';
import { createCustodyStateAuthority } from '../src/authority.mjs';
import { sha256Hex } from '../src/codec.mjs';
import { ZERO_HASH } from '../src/constants.mjs';
import {
  MemoryRepository,
  NETWORK_ID,
  OWNER_A,
  OWNER_B,
  PCRS,
  PROFILE_ID,
  ROOT_COMMITMENT,
  TEST_CONFIG,
  VAULT_ID,
  deterministicRandom,
  makeReceiptSigner,
  makeSnapshotStore,
  seedSession,
  testSessionSealer,
  testRequestProofVerifier,
} from './helpers.mjs';

const TOKEN_A = 'A'.repeat(43);
const TOKEN_B = 'B'.repeat(43);
const SNAPSHOT_SHA = '11'.repeat(32);
const MUTATION_DIGEST = '51'.repeat(32);

function fixture({ verifyAttestation, verifyRequestProof, now = 1_800_000_000_000 } = {}) {
  const time = { now };
  const clock = () => time.now;
  const repository = new MemoryRepository();
  const snapshotStore = makeSnapshotStore(clock);
  const receiptSigner = makeReceiptSigner();
  const options = {
    repository,
    snapshotStore,
    receiptSigner,
    randomBytes: deterministicRandom(),
    clock,
    config: TEST_CONFIG,
    sealSessionToken: testSessionSealer,
    verifyRequestProof: verifyRequestProof || testRequestProofVerifier,
  };
  if (verifyAttestation) options.verifyAttestation = verifyAttestation;
  const authority = createCustodyStateAuthority(options);
  return { authority, repository, snapshotStore, receiptSigner, time };
}

function challengeInput(ownerId = OWNER_A) {
  return {
    vault_id: VAULT_ID,
    profile_id: PROFILE_ID,
    network_id: NETWORK_ID,
    root_commitment: ROOT_COMMITMENT,
    owner_id: ownerId,
  };
}

test('request verifier cannot bypass authentication by returning no proof', async () => {
  for (const value of [null, undefined, false]) {
    const { authority, repository, time } = fixture({ verifyRequestProof: async () => value });
    seedSession(repository, TOKEN_A, time.now);
    await assert.rejects(
      authority.getHead({ vaultId: VAULT_ID, profileId: PROFILE_ID, token: TOKEN_A }),
      (error) => error.code === 'invalid_request_proof'
    );
  }
});

function genesisInput(ownerId = OWNER_A) {
  return {
    owner_id: ownerId,
    previous_owner_id: null,
    epoch: '0',
    snapshot_fence: '0',
    generation: '0',
    snapshot_sha256: ZERO_HASH,
    head_fingerprint: ZERO_HASH,
  };
}

function uploadInput(head, overrides = {}) {
  return {
    commit_id: 'commit-1',
    owner_id: head.owner_id,
    epoch: head.epoch,
    snapshot_fence: head.epoch,
    previous_snapshot_fence: head.snapshot_fence,
    generation: String(BigInt(head.generation) + 1n),
    previous_snapshot_sha256: head.snapshot_sha256,
    head_fingerprint: head.head_fingerprint,
    mutation_digest: MUTATION_DIGEST,
    snapshot_sha256: SNAPSHOT_SHA,
    snapshot_size_bytes: 4096,
    ...overrides,
  };
}

function commitInput(upload, ownerId, epoch) {
  return {
    commit_id: upload.commit_id,
    owner_id: ownerId,
    epoch,
    snapshot_fence: upload.snapshot_fence,
    previous_snapshot_fence: upload.previous_snapshot_fence,
    generation: upload.generation,
    previous_snapshot_sha256: upload.previous_snapshot_sha256,
    mutation_digest: upload.mutation_digest,
    snapshot_key: upload.snapshot.key,
    snapshot_version_id: 'version-1',
  };
}

async function expectCode(promise, code, statusCode) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (statusCode) assert.equal(error.statusCode, statusCode);
    return true;
  });
}

test('production attestation gate rejects malformed evidence without consuming challenge', async () => {
  const { authority, repository } = fixture();
  const challenge = await authority.createChallenge(challengeInput());
  await expectCode(
    authority.createSession({
      challenge_id: challenge.challenge_id,
      attestation_document: 'syntactically-opaque-document',
    }),
    'nitro_attestation_rejected',
    403
  );
  assert.equal(repository.sessions.size, 0);
  assert.equal(repository.challenges.get(challenge.challenge_id).consumedAt, undefined);
});

test('challenge issuance is restricted to the authority deployment scope', async () => {
  const { authority, repository } = fixture();
  for (const override of [
    { vault_id: '91'.repeat(32) },
    { profile_id: '92'.repeat(32) },
    { network_id: '93'.repeat(32) },
    { root_commitment: '94'.repeat(32) },
  ]) {
    await expectCode(
      authority.createChallenge({ ...challengeInput(), ...override }),
      'scope_not_authorized',
      403
    );
  }
  assert.equal(repository.challenges.size, 0);
});

test('session issuance consumes one challenge only after exact verified claims', async () => {
  let expected;
  const publicKeyDerBase64 = Buffer.from('unit-public-key').toString('base64');
  const publicKeySha256 = sha256Hex(Buffer.from(publicKeyDerBase64, 'base64'));
  const ownerId = `nitro-${publicKeySha256}`;
  const { authority, repository } = fixture({
    async verifyAttestation(request) {
      expected = request.expected;
      return {
        verified: true,
        claims: {
          nonceHex: request.expected.nonceHex,
          userDataHex: request.expected.userDataHex,
          pcrs: request.expected.pcrs,
          moduleId: 'unit-enclave',
          publicKeySha256,
          publicKeyDerBase64,
        },
      };
    },
  });
  const challenge = await authority.createChallenge(challengeInput(ownerId));
  const session = await authority.createSession({
    challenge_id: challenge.challenge_id,
    attestation_document: 'verified-fixture',
  });
  assert.equal(session.owner_id, ownerId);
  assert.equal(session.network_id, NETWORK_ID);
  assert.equal(session.root_commitment, ROOT_COMMITMENT);
  assert.equal(session.request_header, 'x-custody-session');
  assert.equal(session.session_token, undefined);
  assert.deepEqual(expected.pcrs, PCRS);
  assert.equal(repository.sessions.size, 1);
  await expectCode(
    authority.createSession({
      challenge_id: challenge.challenge_id,
      attestation_document: 'verified-fixture',
    }),
    'challenge_expired_or_unknown',
    401
  );
});

test('upload status rechecks the live owner lease after S3 resolution', async () => {
  const { authority, repository, snapshotStore, time } = fixture();
  seedSession(repository, TOKEN_A, time.now);
  const scope = { vaultId: VAULT_ID, profileId: PROFILE_ID, token: TOKEN_A };
  const genesis = await authority.takeover({ ...scope, input: genesisInput() });
  const upload = await authority.createUploadTicket({ ...scope, input: uploadInput(genesis) });
  const request = { ...scope, input: { commit_id: upload.commit_id, owner_id: OWNER_A } };
  snapshotStore.resolveUploadedVersion = async () => 'exact-version';
  assert.equal((await authority.resolveUpload(request)).snapshot.version_id, 'exact-version');
  snapshotStore.resolveUploadedVersion = async () => {
    time.now += TEST_CONFIG.leaseDurationSeconds * 1000;
    return 'exact-version';
  };
  await assert.rejects(
    authority.resolveUpload(request),
    (error) => error.code === 'upload_status_precondition_failed'
  );
});

test('epoch takeover preserves the committed snapshot fence and exact version recovery', async () => {
  const { authority, repository, snapshotStore, receiptSigner, time } = fixture();
  seedSession(repository, TOKEN_A, time.now);
  const genesis = await authority.takeover({
    vaultId: VAULT_ID,
    profileId: PROFILE_ID,
    token: TOKEN_A,
    input: genesisInput(),
  });
  assert.equal(genesis.epoch, '1');
  assert.equal(genesis.snapshot_fence, '0');
  assert.equal(genesis.generation, '0');

  const upload = await authority.createUploadTicket({
    vaultId: VAULT_ID,
    profileId: PROFILE_ID,
    token: TOKEN_A,
    input: uploadInput(genesis),
  });
  assert.equal(upload.idempotent, false);
  assert.equal(upload.snapshot_fence, '1');
  assert.equal(upload.previous_snapshot_fence, '0');
  assert.equal(upload.snapshot.sha256, SNAPSHOT_SHA);

  time.now += 1_000;
  const renewed = await authority.renew({
    vaultId: VAULT_ID,
    profileId: PROFILE_ID,
    token: TOKEN_A,
    input: {
      owner_id: OWNER_A,
      epoch: '1',
      snapshot_fence: '0',
      generation: '0',
      snapshot_sha256: ZERO_HASH,
      head_fingerprint: genesis.head_fingerprint,
    },
  });
  assert.notEqual(renewed.head_fingerprint, genesis.head_fingerprint);

  const submitted = commitInput(upload, OWNER_A, '1');
  const committed = await authority.commit({
    vaultId: VAULT_ID,
    profileId: PROFILE_ID,
    token: TOKEN_A,
    input: submitted,
  });
  assert.equal(committed.idempotent, false);
  assert.equal(committed.head.generation, '1');
  assert.equal(committed.head.snapshot_fence, '1');
  assert.equal(committed.head.snapshot_sha256, SNAPSHOT_SHA);
  assert.equal(committed.head.snapshot.version_id, 'version-1');
  assert.equal(committed.receipt.previous_snapshot_fence, '0');
  assert.equal(receiptSigner.calls.length, 1);
  assert.equal(snapshotStore.calls.filter((call) => call.method === 'head').length, 1);

  const replay = await authority.commit({
    vaultId: VAULT_ID,
    profileId: PROFILE_ID,
    token: TOKEN_A,
    input: submitted,
  });
  assert.equal(replay.idempotent, true);
  assert.deepEqual(replay.receipt, committed.receipt);
  assert.equal(receiptSigner.calls.length, 1);
  assert.equal(snapshotStore.calls.filter((call) => call.method === 'head').length, 1);

  time.now += TEST_CONFIG.leaseDurationSeconds * 1000 + 1;
  await expectCode(
    authority.createDownloadTicket({
      vaultId: VAULT_ID,
      profileId: PROFILE_ID,
      token: TOKEN_A,
      input: {
        owner_id: OWNER_A,
        epoch: '1',
        snapshot_fence: '1',
        generation: '1',
        snapshot_sha256: SNAPSHOT_SHA,
        head_fingerprint: committed.head.head_fingerprint,
      },
    }),
    'download_precondition_failed',
    409
  );

  seedSession(repository, TOKEN_B, time.now, { ownerId: OWNER_B });
  const takeover = await authority.takeover({
    vaultId: VAULT_ID,
    profileId: PROFILE_ID,
    token: TOKEN_B,
    input: {
      owner_id: OWNER_B,
      previous_owner_id: OWNER_A,
      epoch: '1',
      snapshot_fence: '1',
      generation: '1',
      snapshot_sha256: SNAPSHOT_SHA,
      head_fingerprint: committed.head.head_fingerprint,
    },
  });
  assert.equal(takeover.epoch, '2');
  assert.equal(takeover.snapshot_fence, '1');
  assert.equal(takeover.generation, '1');

  const download = await authority.createDownloadTicket({
    vaultId: VAULT_ID,
    profileId: PROFILE_ID,
    token: TOKEN_B,
    input: {
      owner_id: OWNER_B,
      epoch: '2',
      snapshot_fence: '1',
      generation: '1',
      snapshot_sha256: SNAPSHOT_SHA,
      head_fingerprint: takeover.head_fingerprint,
    },
  });
  assert.equal(download.method, 'GET');
  assert.deepEqual(download.snapshot, {
    bucket: 'unit-snapshots',
    key: upload.snapshot.key,
    version_id: 'version-1',
    sha256: SNAPSHOT_SHA,
    size_bytes: 4096,
  });
  assert.equal(snapshotStore.calls.filter((call) => call.method === 'download').length, 1);

  await expectCode(
    authority.commit({
      vaultId: VAULT_ID,
      profileId: PROFILE_ID,
      token: TOKEN_B,
      input: { ...submitted, owner_id: OWNER_B, snapshot_version_id: 'different-version' },
    }),
    'commit_id_conflict',
    409
  );
});

test('unknown transaction results recover through permanent claim and commit records', async () => {
  const { authority, repository, receiptSigner, time } = fixture();
  seedSession(repository, TOKEN_A, time.now);
  const genesis = await authority.takeover({
    vaultId: VAULT_ID,
    profileId: PROFILE_ID,
    token: TOKEN_A,
    input: genesisInput(),
  });

  const claimUpload = repository.claimUpload.bind(repository);
  let loseClaimResponse = true;
  repository.claimUpload = async (...args) => {
    await claimUpload(...args);
    if (loseClaimResponse) {
      loseClaimResponse = false;
      const error = new Error('claim response lost after commit');
      error.name = 'TimeoutError';
      throw error;
    }
  };
  const request = {
    vaultId: VAULT_ID,
    profileId: PROFILE_ID,
    token: TOKEN_A,
    input: uploadInput(genesis),
  };
  await assert.rejects(authority.createUploadTicket(request), { name: 'TimeoutError' });
  const upload = await authority.createUploadTicket(request);
  assert.equal(upload.idempotent, true);
  assert.equal(repository.claims.size, 1);

  const persistCommit = repository.commit.bind(repository);
  let loseCommitResponse = true;
  repository.commit = async (...args) => {
    const head = await persistCommit(...args);
    if (loseCommitResponse) {
      loseCommitResponse = false;
      const error = new Error('commit response lost after commit');
      error.name = 'TimeoutError';
      throw error;
    }
    return head;
  };
  const submitted = commitInput(upload, OWNER_A, genesis.epoch);
  await assert.rejects(
    authority.commit({
      vaultId: VAULT_ID,
      profileId: PROFILE_ID,
      token: TOKEN_A,
      input: submitted,
    }),
    { name: 'TimeoutError' }
  );
  const stored = await repository.getCommit(
    {
      vaultId: VAULT_ID,
      profileId: PROFILE_ID,
      networkId: NETWORK_ID,
      rootCommitment: ROOT_COMMITMENT,
    },
    upload.commit_id
  );
  const replay = await authority.commit({
    vaultId: VAULT_ID,
    profileId: PROFILE_ID,
    token: TOKEN_A,
    input: submitted,
  });
  assert.equal(replay.idempotent, true);
  assert.deepEqual(replay.receipt, stored.receipt);
  assert.equal(repository.commits.size, 1);
  assert.equal(receiptSigner.calls.length, 1);
});

test('commit fails closed when receipt signing consumes its lease extension window', async () => {
  const { authority, repository, receiptSigner, time } = fixture();
  seedSession(repository, TOKEN_A, time.now);
  const genesis = await authority.takeover({
    vaultId: VAULT_ID,
    profileId: PROFILE_ID,
    token: TOKEN_A,
    input: genesisInput(),
  });
  const upload = await authority.createUploadTicket({
    vaultId: VAULT_ID,
    profileId: PROFILE_ID,
    token: TOKEN_A,
    input: uploadInput(genesis),
  });
  const sign = receiptSigner.sign.bind(receiptSigner);
  receiptSigner.sign = async (payload) => {
    const receipt = await sign(payload);
    time.now += TEST_CONFIG.leaseDurationSeconds * 1000;
    return receipt;
  };

  await expectCode(
    authority.commit({
      vaultId: VAULT_ID,
      profileId: PROFILE_ID,
      token: TOKEN_A,
      input: commitInput(upload, OWNER_A, genesis.epoch),
    }),
    'commit_window_expired',
    409
  );
  assert.equal(repository.commits.size, 0);
  assert.equal(repository.calls.filter((call) => call.method === 'commit').length, 0);
});

test('stale generation, hash, snapshot fence and owner operations fail closed', async () => {
  const { authority, repository, time } = fixture();
  seedSession(repository, TOKEN_A, time.now);
  const genesis = await authority.takeover({
    vaultId: VAULT_ID,
    profileId: PROFILE_ID,
    token: TOKEN_A,
    input: genesisInput(),
  });
  await expectCode(
    authority.createUploadTicket({
      vaultId: VAULT_ID,
      profileId: PROFILE_ID,
      token: TOKEN_A,
      input: uploadInput(genesis, {
        commit_id: 'stale-commit',
        previous_snapshot_sha256: 'ff'.repeat(32),
      }),
    }),
    'upload_precondition_failed',
    409
  );
  await expectCode(
    authority.createUploadTicket({
      vaultId: VAULT_ID,
      profileId: PROFILE_ID,
      token: TOKEN_A,
      input: uploadInput(genesis, {
        commit_id: 'stale-fence',
        previous_snapshot_fence: '1',
      }),
    }),
    'upload_precondition_failed',
    409
  );

  time.now += TEST_CONFIG.leaseDurationSeconds * 1000 + 1;
  seedSession(repository, TOKEN_B, time.now, { ownerId: OWNER_B });
  const takeover = await authority.takeover({
    vaultId: VAULT_ID,
    profileId: PROFILE_ID,
    token: TOKEN_B,
    input: {
      owner_id: OWNER_B,
      previous_owner_id: OWNER_A,
      epoch: '1',
      snapshot_fence: '0',
      generation: '0',
      snapshot_sha256: ZERO_HASH,
      head_fingerprint: genesis.head_fingerprint,
    },
  });
  assert.equal(takeover.owner_id, OWNER_B);
  assert.equal(takeover.epoch, '2');
  assert.equal(takeover.snapshot_fence, '0');

  await expectCode(
    authority.renew({
      vaultId: VAULT_ID,
      profileId: PROFILE_ID,
      token: TOKEN_A,
      input: {
        owner_id: OWNER_A,
        epoch: '1',
        snapshot_fence: '0',
        generation: '0',
        snapshot_sha256: ZERO_HASH,
        head_fingerprint: genesis.head_fingerprint,
      },
    }),
    'renew_precondition_failed',
    409
  );
});

test('request shape, owner substitution and cross-binding reads are rejected', async () => {
  const { authority, repository, time } = fixture();
  seedSession(repository, TOKEN_A, time.now);
  await expectCode(
    authority.createChallenge({ ...challengeInput(), permissive: true }),
    'invalid_request_shape',
    400
  );
  await expectCode(
    authority.takeover({
      vaultId: VAULT_ID,
      profileId: PROFILE_ID,
      token: TOKEN_A,
      input: genesisInput(OWNER_B),
    }),
    'session_scope_mismatch',
    403
  );

  await authority.takeover({
    vaultId: VAULT_ID,
    profileId: PROFILE_ID,
    token: TOKEN_A,
    input: genesisInput(),
  });
  const crossBindingToken = 'C'.repeat(43);
  seedSession(repository, crossBindingToken, time.now, { networkId: '99'.repeat(32) });
  await expectCode(
    authority.getHead({
      vaultId: VAULT_ID,
      profileId: PROFILE_ID,
      token: crossBindingToken,
    }),
    'head_not_initialized',
    404
  );
});
