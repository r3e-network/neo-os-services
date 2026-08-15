async function fetchOracleKey() {
  const response = await fetch('/api/oracle/public-key');
  if (!response.ok) {
    throw new Error(`failed to fetch oracle key: ${response.status}`);
  }
  return response.json();
}

function decodeBase64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBytesToBase64(bytesLike) {
  const bytes = bytesLike instanceof Uint8Array ? bytesLike : new Uint8Array(bytesLike);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function encryptWithOracleKey(publicKeyBase64, plaintext) {
  const recipientPublicKeyBytes = decodeBase64ToBytes(publicKeyBase64);
  const recipientKey = await crypto.subtle.importKey(
    'raw',
    recipientPublicKeyBytes,
    { name: 'X25519' },
    false,
    []
  );
  const ephemeralKeyPair = await crypto.subtle.generateKey({ name: 'X25519' }, true, [
    'deriveBits',
  ]);
  const ephemeralPublicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', ephemeralKeyPair.publicKey)
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'X25519', public: recipientKey },
      ephemeralKeyPair.privateKey,
      256
    )
  );
  const keyMaterial = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, [
    'deriveKey',
  ]);
  const info = new Uint8Array([
    ...new TextEncoder().encode('morpheus-confidential-payload-v2'),
    ...ephemeralPublicKeyBytes,
    ...recipientPublicKeyBytes,
  ]);
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: recipientPublicKeyBytes,
      info,
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedBytes = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      new TextEncoder().encode(plaintext)
    )
  );
  const ciphertextBytes = encryptedBytes.slice(0, encryptedBytes.length - 16);
  const tagBytes = encryptedBytes.slice(encryptedBytes.length - 16);
  return btoa(
    JSON.stringify({
      v: 2,
      alg: 'X25519-HKDF-SHA256-AES-256-GCM',
      epk: encodeBytesToBase64(ephemeralPublicKeyBytes),
      iv: encodeBytesToBase64(iv),
      ct: encodeBytesToBase64(ciphertextBytes),
      tag: encodeBytesToBase64(tagBytes),
    })
  );
}

async function encryptSecretOnly(secretText) {
  const oracleKey = await fetchOracleKey();
  return encryptWithOracleKey(oracleKey.public_key, secretText);
}

async function encryptConfidentialJsonPatch(patchObject) {
  const oracleKey = await fetchOracleKey();
  return encryptWithOracleKey(oracleKey.public_key, JSON.stringify(patchObject));
}

// Example usage:
// const encryptedToken = await encryptSecretOnly("Bearer my-private-api-token");
// const encryptedPayload = await encryptConfidentialJsonPatch({
//   mode: "builtin",
//   function: "math.modexp",
//   input: { base: "2", exponent: "10", modulus: "17" },
//   target_chain: "neo_n3"
// });
