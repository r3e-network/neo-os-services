import {
  constants as cryptoConstants,
  createPublicKey,
  publicEncrypt,
  timingSafeEqual,
} from 'node:crypto';
import { sha256Hex } from './codec.mjs';

function decodeSpki(value) {
  if (
    typeof value !== 'string' ||
    value.length < 16 ||
    value.length > 4096 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error('attested public key is not canonical base64 SPKI DER');
  }
  const der = Buffer.from(value, 'base64');
  if (der.toString('base64') !== value) {
    throw new Error('attested public key base64 is not canonical');
  }
  return der;
}

export function validateAttestedPublicKey(claims) {
  const der = decodeSpki(claims?.publicKeyDerBase64);
  if (sha256Hex(der) !== claims.publicKeySha256) {
    throw new Error('attested public key hash does not match the verified claim');
  }
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  const canonicalDer = key.export({ format: 'der', type: 'spki' });
  if (
    canonicalDer.length !== der.length ||
    !timingSafeEqual(canonicalDer, der) ||
    key.asymmetricKeyType !== 'rsa' ||
    !Number.isInteger(key.asymmetricKeyDetails?.modulusLength) ||
    key.asymmetricKeyDetails.modulusLength !== 3072 ||
    key.asymmetricKeyDetails.publicExponent !== 65_537n
  ) {
    throw new Error(
      'attested session key must be canonical RSA-3072 SPKI with exponent 65537'
    );
  }
  return key;
}

export async function sealSessionToken(token, claims) {
  const key = validateAttestedPublicKey(claims);
  const ciphertext = publicEncrypt(
    {
      key,
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(token, 'ascii')
  );
  return {
    algorithm: 'RSA-OAEP-256',
    keySha256: claims.publicKeySha256,
    ciphertextBase64: ciphertext.toString('base64'),
  };
}
