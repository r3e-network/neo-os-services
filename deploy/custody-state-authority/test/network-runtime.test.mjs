import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { createCustodyStateAuthority } from '../src/authority.mjs';
import { fingerprint, sha256Hex } from '../src/codec.mjs';
import { canonicalReceipt } from '../src/protocol.mjs';
import {
  MemoryRepository,
  TEST_CONFIG,
  OWNER_A,
  deterministicRandom,
  makeReceiptSigner,
  makeSnapshotStore,
  seedSession,
  testRequestProofVerifier,
  testSessionSealer,
} from './helpers.mjs';

const NOW = 1_800_000_000_000;
const TOKEN = 'A'.repeat(43);
const ZERO = '0'.repeat(64);
const otherNetwork = (network) => (network === 'mainnet' ? 'testnet' : 'mainnet');

function fixture(network, overrides = {}) {
  const config = structuredClone(TEST_CONFIG);
  config.expectedScope.network = network;
  const repository = overrides.repository || new MemoryRepository();
  const receiptSigner = makeReceiptSigner();
  const snapshotStore = makeSnapshotStore(() => NOW);
  const counts = { attestation: 0, proof: 0 };
  const publicKey = Buffer.from('unit-public-key').toString('base64');
  const ownerId = `nitro-${sha256Hex(Buffer.from(publicKey, 'base64'))}`;
  const authority = createCustodyStateAuthority({
    config,
    repository,
    receiptSigner,
    snapshotStore,
    clock: () => NOW,
    randomBytes: deterministicRandom(),
    sealSessionToken: testSessionSealer,
    verifyRequestProof: async (args) => {
      counts.proof++;
      return testRequestProofVerifier(args);
    },
    verifyAttestation: async ({ expected }) => {
      counts.attestation++;
      return {
        verified: true,
        claims: {
          nonceHex: expected.nonceHex,
          userDataHex: expected.userDataHex,
          pcrs: expected.pcrs,
          moduleId: 'unit-enclave',
          publicKeyDerBase64: publicKey,
          publicKeySha256: sha256Hex(Buffer.from(publicKey, 'base64')),
        },
      };
    },
  });
  const scope = { ...config.expectedScope };
  const request = { vaultId: scope.vaultId, profileId: scope.profileId, token: TOKEN };
  const challengeInput = {
    vault_id: scope.vaultId,
    profile_id: scope.profileId,
    network_id: scope.networkId,
    root_commitment: scope.rootCommitment,
    owner_id: ownerId,
  };
  seedSession(repository, TOKEN, NOW, scope);
  return {
    authority,
    config,
    scope,
    repository,
    receiptSigner,
    snapshotStore,
    counts,
    request,
    challengeInput,
  };
}

async function prepare(f) {
  const head = await f.authority.takeover({
    ...f.request,
    input: {
      owner_id: OWNER_A,
      previous_owner_id: null,
      epoch: '0',
      snapshot_fence: '0',
      generation: '0',
      snapshot_sha256: ZERO,
      head_fingerprint: ZERO,
    },
  });
  const upload = await f.authority.createUploadTicket({
    ...f.request,
    input: {
      commit_id: 'network-commit',
      owner_id: OWNER_A,
      epoch: head.epoch,
      snapshot_fence: head.epoch,
      previous_snapshot_fence: head.snapshot_fence,
      generation: '1',
      previous_snapshot_sha256: ZERO,
      head_fingerprint: head.head_fingerprint,
      mutation_digest: '51'.repeat(32),
      snapshot_sha256: '11'.repeat(32),
      snapshot_size_bytes: 4096,
    },
  });
  const input = {
    commit_id: upload.commit_id,
    owner_id: OWNER_A,
    epoch: head.epoch,
    snapshot_fence: head.epoch,
    previous_snapshot_fence: head.snapshot_fence,
    generation: '1',
    previous_snapshot_sha256: ZERO,
    mutation_digest: '51'.repeat(32),
    snapshot_key: upload.snapshot.key,
    snapshot_version_id: 'version-1',
  };
  return { head, upload, input };
}

for (const network of ['testnet', 'mainnet']) {
  test(`${network}: immutable admission survives caller config mutation`, async () => {
    const f = fixture(network);
    f.config.expectedScope.network = otherNetwork(network);
    f.config.expectedScope.networkId = 'ff'.repeat(32);
    const challenge = await f.authority.createChallenge(f.challengeInput);
    assert.equal(challenge.network, network);
    const session = await f.authority.createSession({
      challenge_id: challenge.challenge_id,
      attestation_document: 'fixture',
    });
    assert.equal(session.network, network);
    assert.equal(session.network_id, f.scope.networkId);
  });

  test(`${network}: complete durable flow binds receipts and replay to admitted context`, async () => {
    const f = fixture(network);
    const { head, input } = await prepare(f);
    assert.equal(head.network, network);
    const committed = await f.authority.commit({ ...f.request, input });
    assert.equal(committed.head.network, network);
    assert.equal(committed.receipt.network, network);
    assert.equal(committed.receipt.receipt_id, sha256Hex(canonicalReceipt(committed.receipt)));
    const replay = await f.authority.commit({ ...f.request, input });
    assert.equal(replay.idempotent, true);
    assert.deepEqual(replay.receipt, committed.receipt);
    assert.equal(f.receiptSigner.calls.length, 1);
    const current = await f.authority.getHead(f.request);
    const binding = {
      owner_id: OWNER_A,
      epoch: current.epoch,
      snapshot_fence: current.snapshot_fence,
      generation: current.generation,
      snapshot_sha256: current.snapshot_sha256,
      head_fingerprint: current.head_fingerprint,
    };
    await f.authority.createDownloadTicket({ ...f.request, input: binding });
    await f.authority.renew({ ...f.request, input: binding });
  });

  for (const field of ['network', 'vaultId', 'profileId', 'networkId', 'rootCommitment']) {
    test(`${network}: foreign challenge ${field} stops before attestation`, async () => {
      const f = fixture(network);
      const challenge = await f.authority.createChallenge(f.challengeInput);
      const row = f.repository.challenges.get(challenge.challenge_id);
      row[field] = field === 'network' ? otherNetwork(network) : 'ff'.repeat(32);
      await assert.rejects(
        f.authority.createSession({
          challenge_id: challenge.challenge_id,
          attestation_document: 'fixture',
        }),
        { code: 'scope_not_authorized' }
      );
      assert.equal(f.counts.attestation, 0);
    });
    test(`${network}: foreign session ${field} stops before proof consumption`, async () => {
      const f = fixture(network);
      f.repository.sessions.get(sha256Hex(TOKEN))[field] =
        field === 'network' ? otherNetwork(network) : 'ff'.repeat(32);
      await assert.rejects(f.authority.getHead(f.request), { code: 'session_scope_mismatch' });
      assert.equal(f.counts.proof, 0);
      assert.equal(f.repository.proofs.size, 0);
    });
  }

  for (const part of ['record', 'head', 'receipt']) {
    test(`${network}: rejects foreign ${part} on idempotent receipt replay`, async () => {
      const f = fixture(network);
      const { input } = await prepare(f);
      await f.authority.commit({ ...f.request, input });
      const record = [...f.repository.commits.values()][0];
      (part === 'record' ? record : record[part]).network = otherNetwork(network);
      await assert.rejects(f.authority.commit({ ...f.request, input }), {
        code: 'commit_id_conflict',
      });
      assert.equal(f.receiptSigner.calls.length, 1);
    });
  }

  test(`${network}: rejects foreign signer receipt before atomic persistence`, async () => {
    const f = fixture(network);
    const { input } = await prepare(f);
    const sign = f.receiptSigner.sign;
    f.receiptSigner.sign = (payload) => sign({ ...payload, network: otherNetwork(network) });
    await assert.rejects(f.authority.commit({ ...f.request, input }), {
      code: 'receipt_scope_mismatch',
    });
    assert.equal(f.repository.commits.size, 0);
  });

  test(`${network}: foreign HEAD cannot be relabelled for read or download`, async () => {
    const f = fixture(network);
    const { input } = await prepare(f);
    const { head } = await f.authority.commit({ ...f.request, input });
    [...f.repository.heads.values()][0].network = otherNetwork(network);
    await assert.rejects(f.authority.getHead(f.request), { code: 'head_not_initialized' });
    await assert.rejects(
      f.authority.createDownloadTicket({
        ...f.request,
        input: {
          owner_id: OWNER_A,
          epoch: head.epoch,
          snapshot_fence: head.snapshot_fence,
          generation: head.generation,
          snapshot_sha256: head.snapshot_sha256,
          head_fingerprint: head.head_fingerprint,
        },
      }),
      { code: 'download_precondition_failed' }
    );
    assert.equal(f.snapshotStore.calls.filter((call) => call.method === 'download').length, 0);
  });
}

test('missing, unknown and noncanonical admission has no default', () => {
  for (const network of [undefined, null, '', 'MainNet', 'mainnet ', ' testnet', 'private', 1]) {
    assert.throws(() => fixture(network), /network/);
  }
});

test('TestNet challenge and canonical receipt preserve pre-change bytes', async () => {
  const f = fixture('testnet');
  const challenge = await f.authority.createChallenge(f.challengeInput);
  const { input } = await prepare(f);
  const { head, receipt } = await f.authority.commit({ ...f.request, input });
  // These values are captured on the unmodified production base, before the fix.
  assert.equal(
    fingerprint(challenge),
    '7fb2f83f9cf1813893ba89376627617da9b4a6dd6f9ea4062b480b602bd1c889'
  );
  assert.equal(
    head.head_fingerprint,
    'ff587136fa045a38c2ed6918ebbb180b8520ddea08689384895feb4f6ff7771a'
  );
  assert.equal(
    sha256Hex(canonicalReceipt(receipt)),
    '625e5c485a4046c95233cea509796f7eb60821109680bb31a485487e98d84d30'
  );
});

test('both authorities run concurrently without sharing HEAD, claims or receipt replay', async () => {
  const main = fixture('mainnet');
  const testnet = fixture('testnet');
  // Deliberately reuse every non-network scope/id and share durable maps.
  for (const field of ['heads', 'claims', 'commits'])
    main.repository[field] = testnet.repository[field];
  const [mainPrepared, testPrepared] = await Promise.all([prepare(main), prepare(testnet)]);
  assert.notEqual(mainPrepared.upload.snapshot.key, testPrepared.upload.snapshot.key);
  const [mainResult, testResult] = await Promise.all([
    main.authority.commit({ ...main.request, input: mainPrepared.input }),
    testnet.authority.commit({ ...testnet.request, input: testPrepared.input }),
  ]);
  assert.equal(mainResult.receipt.network, 'mainnet');
  assert.equal(testResult.receipt.network, 'testnet');
  assert.notEqual(mainResult.receipt.receipt_id, testResult.receipt.receipt_id);
  assert.equal(main.repository.heads.size, 2);
  assert.equal(main.repository.claims.size, 2);
  assert.equal(main.repository.commits.size, 2);
  const replays = await Promise.all([
    main.authority.commit({ ...main.request, input: mainPrepared.input }),
    testnet.authority.commit({ ...testnet.request, input: testPrepared.input }),
  ]);
  assert.deepEqual(
    replays.map((r) => r.receipt.network),
    ['mainnet', 'testnet']
  );
  assert.ok(replays.every((r) => r.idempotent));
});

function foreignSignedEnvelope(receipt, network) {
  const bytes = canonicalReceipt({ ...receipt, network: otherNetwork(network) });
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const signature = sign('sha256', bytes, privateKey);
  assert.ok(verify('sha256', bytes, publicKey, signature));
  // The public wrapper still names the admitted context; only the signed bytes are foreign.
  return {
    ...receipt,
    receipt_id: sha256Hex(bytes),
    payload_base64: bytes.toString('base64'),
    signature_base64: signature.toString('base64'),
  };
}

for (const network of ['mainnet', 'testnet']) {
  test(`${network}: reject foreign signed bytes hidden by an admitted receipt wrapper`, async () => {
    const f = fixture(network);
    const { input } = await prepare(f);
    const signReceipt = f.receiptSigner.sign;
    f.receiptSigner.sign = async (payload) =>
      foreignSignedEnvelope(await signReceipt(payload), network);
    await assert.rejects(f.authority.commit({ ...f.request, input }), {
      code: 'receipt_scope_mismatch',
    });
    assert.equal(f.repository.commits.size, 0);
  });

  test(`${network}: reject foreign signed bytes hidden in a cached receipt wrapper`, async () => {
    const f = fixture(network);
    const { input } = await prepare(f);
    await f.authority.commit({ ...f.request, input });
    const record = [...f.repository.commits.values()][0];
    record.receipt = foreignSignedEnvelope(record.receipt, network);
    await assert.rejects(f.authority.commit({ ...f.request, input }), {
      code: 'commit_id_conflict',
    });
    assert.equal(f.receiptSigner.calls.length, 1);
  });
}
