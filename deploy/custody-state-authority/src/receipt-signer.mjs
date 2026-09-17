import { RECEIPT_SCHEMA } from './constants.mjs';
import { sha256Hex } from './codec.mjs';
import { canonicalReceipt } from './protocol.mjs';

export function createReceiptSigner({ client, keyId, logicalKeyId, SignCommand }) {
  if (!client || !keyId || !logicalKeyId || !SignCommand) {
    throw new TypeError(
      'KMS client, asymmetric key id, logical receipt key id and SignCommand are required'
    );
  }

  async function sign(payload) {
    if (payload?.schema !== RECEIPT_SCHEMA) {
      throw new TypeError(`receipt payload must use ${RECEIPT_SCHEMA}`);
    }
    if (payload.receipt_key_id !== logicalKeyId) {
      throw new TypeError('receipt payload does not name the configured logical receipt key');
    }
    const canonicalPayload = canonicalReceipt(payload);
    const result = await client.send(
      new SignCommand({
        KeyId: keyId,
        Message: canonicalPayload,
        MessageType: 'RAW',
        SigningAlgorithm: 'ECDSA_SHA_256',
      })
    );
    if (!result.Signature || result.Signature.byteLength === 0) {
      throw new Error('KMS Sign returned no signature');
    }
    return {
      ...payload,
      receipt_id: sha256Hex(canonicalPayload),
      payload_base64: canonicalPayload.toString('base64'),
      signature_base64: Buffer.from(result.Signature).toString('base64'),
      kms_key_arn: result.KeyId || keyId,
      signing_algorithm: result.SigningAlgorithm || 'ECDSA_SHA_256',
    };
  }

  return Object.freeze({ logicalKeyId, sign });
}
