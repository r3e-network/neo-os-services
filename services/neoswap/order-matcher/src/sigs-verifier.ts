// Dual Signature Verification for trading authorization

import nacl from 'tweetnacl';
import { sha512 } from '@noble/hashes/sha512';

export class DualSignatureVerifier {
  private verifierKeys: Map<string, Buffer> = new Map(); // userId -> publicKey

  registerUserPublicKey(userId: string, publicKey: Buffer): void {
    this.verifierKeys.set(userId.toLowerCase(), publicKey);
  }

  removeUserPublicKey(userId: string): boolean {
    return this.verifierKeys.delete(userId.toLowerCase());
  }

  /**
   * Verify dual-signature authorization
   * Required for trades exceeding threshold amounts
   */
  verifyDualSignature(
    message: Buffer,
    sig1: Buffer,
    sig2: Buffer,
    userId: string,
    requiredSigners: string[]
  ): boolean {
    const userIdLower = userId.toLowerCase();
    
    // Check if user is in required signers
    if (!requiredSigners.includes(userIdLower)) {
      throw new Error('User not authorized to initiate transaction');
    }

    // Get public keys for all required signers
    const signaturesVerified: Set<string> = new Set();
    let signerCount = 0;

    for (const signerId of requiredSigners) {
      const publicKey = this.verifierKeys.get(signerId);
      
      if (!publicKey) {
        console.warn(`No public key found for signer: ${signerId}`);
        continue;
      }

      // Check if any signature matches this signer
      const sigToVerify = signerId === userId ? sig1 : sig2;
      
      try {
        const valid = nacl.sign.detached.verify(message, sigToVerify, publicKey);
        if (valid) {
          signaturesVerified.add(signerId);
          signerCount++;
        }
      } catch (error) {
        console.error(`Signature verification failed for ${signerId}:`, error);
      }
    }

    // Require at least 2 valid signatures
    return signerCount >= 2 && signaturesVerified.size >= 2;
  }

  /**
   * Hash message before signing
   */
  hashMessage(message: string | Buffer): Uint8Array {
    const msgBuffer = typeof message === 'string' 
      ? Buffer.from(message, 'utf-8')
      : Buffer.from(message);
    
    return sha512(msgBuffer);
  }

  /**
   * Generate key pair for a new user
   */
  generateKeypair(): { privateKey: Buffer; publicKey: Buffer } {
    const keypair = nacl.box.keyPair();
    
    return {
      privateKey: Buffer.from(keypair.secretKey),
      publicKey: Buffer.from(keypair.publicKey),
    };
  }

  /**
   * Sign message with user's private key
   */
  signMessage(message: Buffer, privateKey: Buffer): Buffer {
    return Buffer.from(nacl.sign.detached(message, privateKey));
  }

  /**
   * Validate message format before signing
   */
  validateMessage(message: Buffer): boolean {
    // Message should be > 0 bytes and < 1MB
    return message.length > 0 && message.length < 1024 * 1024;
  }
}
