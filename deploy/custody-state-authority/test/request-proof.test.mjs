import assert from 'node:assert/strict';
import { constants as cryptoConstants, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { createCustodyStateAuthority } from '../src/authority.mjs';
import { sha256Hex } from '../src/codec.mjs';
import { REQUEST_PROOF_SCHEMA } from '../src/constants.mjs';
import { canonicalRequestProof } from '../src/protocol.mjs';
import { verifySessionRequestProof } from '../src/request-proof.mjs';
import {
  MemoryRepository,
  PROFILE_ID,
  TEST_CONFIG,
  VAULT_ID,
  deterministicRandom,
  makeReceiptSigner,
  makeSnapshotStore,
  seedSession,
  testSessionSealer,
} from './helpers.mjs';

const NOW = 1_800_000_000_000;
const TOKEN = 'P'.repeat(43);
const PATH = `/v1/vaults/${VAULT_ID}/profiles/${PROFILE_ID}/head`;
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const publicDer = publicKey.export({ format: 'der', type: 'spki' });
const keyHash = sha256Hex(publicDer);

function proofFor({
  method = 'GET',
  path = PATH,
  tokenHash = sha256Hex(TOKEN),
  timestampMs = String(NOW),
  nonceHex = '81'.repeat(32),
  body = Buffer.alloc(0),
} = {}) {
  const bodySha256 = sha256Hex(body);
  const canonical = canonicalRequestProof({
    schema: REQUEST_PROOF_SCHEMA,
    method,
    path,
    session_token_sha256: tokenHash,
    timestamp_ms: timestampMs,
    nonce: nonceHex,
    body_sha256: bodySha256,
  });
  const signature = sign('sha256', canonical, {
    key: privateKey,
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
  });
  return {
    method,
    path,
    timestampMs,
    nonceHex,
    bodySha256,
    signatureBase64: signature.toString('base64'),
  };
}

function session() {
  return {
    tokenHash: sha256Hex(TOKEN),
    publicKeySha256: keyHash,
    publicKeyDerBase64: publicDer.toString('base64'),
  };
}

test('request proof binds route, body, token, timestamp and the attested RSA key', () => {
  const proof = proofFor();
  const verified = verifySessionRequestProof({
    session: session(),
    tokenHash: sha256Hex(TOKEN),
    proof,
    nowMs: NOW,
    maximumClockSkewSeconds: 30,
    expectedMethod: 'GET',
    expectedPath: PATH,
  });
  assert.equal(verified.nonceHex, proof.nonceHex);
  assert.equal(verified.bodySha256, sha256Hex(Buffer.alloc(0)));
  assert.equal(verified.requestDigest.length, 64);

  for (const mutation of [
    { proof: { ...proof, path: `${PATH}-other` } },
    { proof: { ...proof, bodySha256: '92'.repeat(32) } },
    { tokenHash: '93'.repeat(32), proof },
    { proof: { ...proof, nonceHex: '94'.repeat(32) } },
    { proof: { ...proof, signatureBase64: Buffer.alloc(384).toString('base64') } },
    { proof: proofFor({ timestampMs: String(NOW + 30_001) }) },
  ]) {
    assert.throws(
      () =>
        verifySessionRequestProof({
          session: session(),
          tokenHash: mutation.tokenHash || sha256Hex(TOKEN),
          proof: mutation.proof,
          nowMs: NOW,
          maximumClockSkewSeconds: 30,
          expectedMethod: 'GET',
          expectedPath: PATH,
        }),
      (error) => error.code === 'invalid_request_proof'
    );
  }
  assert.throws(
    () =>
      verifySessionRequestProof({
        session: session(),
        tokenHash: sha256Hex(TOKEN),
        proof: proofFor({ timestampMs: String(NOW - 30_001) }),
        nowMs: NOW,
        maximumClockSkewSeconds: 30,
        expectedMethod: 'GET',
        expectedPath: PATH,
      }),
    (error) => error.code === 'invalid_request_proof'
  );
});

test('authority consumes a request nonce before entering business logic', async () => {
  const repository = new MemoryRepository();
  const snapshotStore = makeSnapshotStore(() => NOW);
  const authority = createCustodyStateAuthority({
    repository,
    snapshotStore,
    receiptSigner: makeReceiptSigner(),
    randomBytes: deterministicRandom(),
    clock: () => NOW,
    config: TEST_CONFIG,
    sealSessionToken: testSessionSealer,
  });
  seedSession(repository, TOKEN, NOW, {
    ownerId: `nitro-${keyHash}`,
    publicKeySha256: keyHash,
    publicKeyDerBase64: publicDer.toString('base64'),
  });
  const request = {
    vaultId: VAULT_ID,
    profileId: PROFILE_ID,
    token: TOKEN,
    proof: proofFor(),
  };
  await assert.rejects(
    authority.getHead(request),
    (error) => error.code === 'head_not_initialized'
  );
  await assert.rejects(
    authority.getHead(request),
    (error) => error.code === 'invalid_request_proof'
  );
  const concurrent = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      authority.getHead({ ...request, proof: proofFor({ nonceHex: '82'.repeat(32) }) })
    )
  );
  const codes = concurrent.map((result) => result.reason?.code);
  assert.equal(codes.filter((code) => code === 'head_not_initialized').length, 1);
  assert.equal(codes.filter((code) => code === 'invalid_request_proof').length, 3);
});
