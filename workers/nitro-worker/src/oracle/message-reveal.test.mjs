import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import {
  buildRevealStatement,
  recoverRevealSigner,
  addressesEqual,
  isRevealTimestampFresh,
  handleMessageReveal,
  __buildMessageRpcConnectionForTests,
} from './message-reveal.js';

process.env.MORPHEUS_ALLOW_EPHEMERAL_KEY = 'true';
const { ensureOracleKeyMaterial } = await import('./crypto.js');

// Deterministic throwaway test key (not used anywhere live).
const TEST_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const wallet = new ethers.Wallet(TEST_PK);

const REVEAL_CONTRACT = '0xd1906192c2308ae416acda96238ca846ebb83f15';

function withRevealConfig() {
  const saved = {};
  for (const k of ['NEOX_MESSAGE_RPC', 'NEOX_MESSAGE_CONTRACT', 'NEOX_MESSAGE_CHAIN_ID']) {
    saved[k] = process.env[k];
  }
  process.env.NEOX_MESSAGE_RPC = 'https://rpc.example.com';
  process.env.NEOX_MESSAGE_CONTRACT = REVEAL_CONTRACT;
  delete process.env.NEOX_MESSAGE_CHAIN_ID;
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

// Seals plaintext to the oracle's X25519 key the same way frontends do
// (X25519-HKDF-SHA256-AES-256-GCM, info 'morpheus-confidential-payload-v2').
async function sealForOracle(publicKeyBase64, plaintext) {
  const subtle = globalThis.crypto.subtle;
  const recipientPublicKeyBytes = Buffer.from(publicKeyBase64, 'base64');
  const recipientKey = await subtle.importKey(
    'raw',
    recipientPublicKeyBytes,
    { name: 'X25519' },
    false,
    []
  );
  const ephemeralKeyPair = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const ephemeralPublicKeyBytes = new Uint8Array(
    await subtle.exportKey('raw', ephemeralKeyPair.publicKey)
  );
  const sharedSecret = new Uint8Array(
    await subtle.deriveBits(
      { name: 'X25519', public: recipientKey },
      ephemeralKeyPair.privateKey,
      256
    )
  );
  const keyMaterial = await subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
  const info = new Uint8Array([
    ...new TextEncoder().encode('morpheus-confidential-payload-v2'),
    ...ephemeralPublicKeyBytes,
    ...recipientPublicKeyBytes,
  ]);
  const aesKey = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: recipientPublicKeyBytes, info },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const encryptedBytes = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(plaintext))
  );
  const ciphertextBytes = encryptedBytes.slice(0, encryptedBytes.length - 16);
  const tagBytes = encryptedBytes.slice(encryptedBytes.length - 16);
  return Buffer.from(
    JSON.stringify({
      v: 2,
      alg: 'X25519-HKDF-SHA256-AES-256-GCM',
      epk: Buffer.from(ephemeralPublicKeyBytes).toString('base64'),
      iv: Buffer.from(iv).toString('base64'),
      ct: Buffer.from(ciphertextBytes).toString('base64'),
      tag: Buffer.from(tagBytes).toString('base64'),
    })
  ).toString('base64');
}

async function signedRevealPayload(messageId, issuedAt) {
  const statement = buildRevealStatement(47763, REVEAL_CONTRACT, String(messageId), issuedAt);
  const signature = await wallet.signMessage(statement);
  return { chain: 'neox', signature, messageId, issuedAt };
}

test('buildRevealStatement is deterministic and lowercases the contract', () => {
  const a = buildRevealStatement(
    47763,
    '0xABCdef0000000000000000000000000000000001',
    '5',
    1700000000
  );
  const b = buildRevealStatement(
    '47763',
    '0xabcdef0000000000000000000000000000000001',
    5,
    '1700000000'
  );
  assert.equal(a, b);
  assert.ok(a.includes('contract: 0xabcdef0000000000000000000000000000000001'));
  assert.ok(a.includes('message: 5'));
  assert.ok(a.includes('issued: 1700000000'));
});

test('recoverRevealSigner round-trips an EIP-191 signature to the signer', async () => {
  const statement = buildRevealStatement(
    47763,
    '0xd1906192c2308ae416acda96238ca846ebb83f15',
    '7',
    1700000000
  );
  const sig = await wallet.signMessage(statement);
  assert.equal(recoverRevealSigner(statement, sig), wallet.address);
  // tampered statement must NOT recover to the signer
  const tampered = buildRevealStatement(
    47763,
    '0xd1906192c2308ae416acda96238ca846ebb83f15',
    '8',
    1700000000
  );
  assert.notEqual(recoverRevealSigner(tampered, sig), wallet.address);
  // malformed signature returns null rather than throwing
  assert.equal(recoverRevealSigner(statement, '0xdeadbeef'), null);
});

test('addressesEqual compares checksum-insensitively and rejects non-addresses', () => {
  assert.equal(addressesEqual(wallet.address, wallet.address.toLowerCase()), true);
  assert.equal(addressesEqual(wallet.address, '0x0000000000000000000000000000000000000000'), false);
  assert.equal(addressesEqual('', wallet.address), false);
  assert.equal(addressesEqual('not-an-address', 'not-an-address'), false);
});

test('isRevealTimestampFresh enforces the freshness window', () => {
  const now = 1700000000;
  assert.equal(isRevealTimestampFresh(now, now), true);
  assert.equal(isRevealTimestampFresh(now - 300, now), true);
  assert.equal(isRevealTimestampFresh(now + 300, now), true);
  assert.equal(isRevealTimestampFresh(now - 601, now), false);
  assert.equal(isRevealTimestampFresh(now + 601, now), false);
  assert.equal(isRevealTimestampFresh(0, now), false);
});

test('handleMessageReveal rejects malformed requests before any chain access', async () => {
  const now = 1700000000;
  const bad = [
    { chain: 'neo_n3', signature: '0x', messageId: 1, issuedAt: now },
    { chain: 'neox', signature: '0x', messageId: 0, issuedAt: now },
    { chain: 'neox', messageId: 1, issuedAt: now }, // no signature
    { chain: 'neox', signature: 'sig', issuedAt: now }, // no messageId
    { chain: 'neox', signature: 'sig', messageId: 1 }, // no issuedAt
  ];
  for (const payload of bad) {
    const resp = await handleMessageReveal(payload, now);
    assert.equal(resp.status, 400, `expected 400 for ${JSON.stringify(payload)}`);
  }
  // stale timestamp -> 403
  const stale = await handleMessageReveal(
    { chain: 'neox', signature: 'sig', messageId: 1, issuedAt: now - 10_000 },
    now
  );
  assert.equal(stale.status, 403);
});

test('handleMessageReveal returns 503 when the worker is not configured for reveal', async () => {
  // Clear any reveal config so the unconfigured branch is exercised deterministically.
  const saved = {};
  for (const k of ['NEOX_MESSAGE_RPC', 'NEOX_RPC', 'EVM_RPC_URL', 'NEOX_MESSAGE_CONTRACT']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    const now = 1700000000;
    const statement = buildRevealStatement(
      47763,
      '0xd1906192c2308ae416acda96238ca846ebb83f15',
      '1',
      now
    );
    const sig = await wallet.signMessage(statement);
    const resp = await handleMessageReveal(
      { chain: 'neox', signature: sig, messageId: 1, issuedAt: now },
      now
    );
    assert.equal(resp.status, 503);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('handleMessageReveal refuses time-locked messages even for the signed recipient', async () => {
  const restore = withRevealConfig();
  try {
    const now = 1700000000;
    const payload = await signedRevealPayload(9, now);
    const resp = await handleMessageReveal(payload, now, {
      readMessage: async () => ({
        sender: ethers.ZeroAddress,
        recipient: wallet.address,
        envelope: ethers.toUtf8Bytes('never-decrypted'),
        unlockTime: 1700100000n,
        sentAt: 0n,
        revealed: false,
        plaintext: '',
      }),
    });
    assert.equal(resp.status, 403);
    const body = await resp.json();
    assert.match(body.error, /time-locked/i);
  } finally {
    restore();
  }
});

test('handleMessageReveal reveals a recipient-only message (unlockTime == 0)', async () => {
  const restore = withRevealConfig();
  try {
    const now = 1700000000;
    const keyMaterial = await ensureOracleKeyMaterial({});
    const sealed = await sealForOracle(keyMaterial.publicKeyRaw, 'meet me at dawn');
    const payload = await signedRevealPayload(9, now);
    const resp = await handleMessageReveal(payload, now, {
      readMessage: async () => ({
        sender: ethers.ZeroAddress,
        recipient: wallet.address,
        envelope: ethers.toUtf8Bytes(sealed),
        unlockTime: 0n,
        sentAt: 0n,
        revealed: false,
        plaintext: '',
      }),
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.plaintext, 'meet me at dawn');
    assert.equal(body.recipient, wallet.address);
    assert.equal(body.unlockTime, 0);
  } finally {
    restore();
  }
});

test('message rpc connection pins a short read timeout', () => {
  const connection = __buildMessageRpcConnectionForTests('https://rpc.example.com');
  assert.equal(connection.timeout, 10_000);
});
