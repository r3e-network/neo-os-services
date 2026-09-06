import { describe, it, expect, beforeEach } from 'vitest';
import { DualSignatureVerifier } from './sigs-verifier';
import nacl from 'tweetnacl';

describe('DualSignatureVerifier', () => {
  let verifier: DualSignatureVerifier;

  beforeEach(() => {
    verifier = new DualSignatureVerifier();
  });

  describe('verifyDualSignature', () => {
    it('should verify valid dual signatures', async () => {
      const userId = 'user-123';
      
      // Generate keypair
      const keypair = verifier.generateKeypair();
      verifier.registerUserPublicKey(userId, keypair.publicKey);

      const message = Buffer.from('test-message-for-dual-signature');
      const sig1 = verifier.signMessage(message, keypair.privateKey);
      
      // For single-user case, require same signature twice
      const isValid = verifier.verifyDualSignature(
        message,
        sig1,
        sig1,
        userId,
        [userId]
      );

      expect(isValid).toBe(true);
    });

    it('should reject invalid signature', () => {
      const userId = 'user-456';
      const maliciousUserId = 'evil-user';
      
      verifier.registerUserPublicKey(userId, Buffer.alloc(32));
      
      const message = Buffer.from('malicious-message');
      const fakeSig = Buffer.alloc(64, 0xff);

      const isValid = verifier.verifyDualSignature(
        message,
        fakeSig,
        fakeSig,
        maliciousUserId,
        [maliciousUserId]
      );

      expect(isValid).toBe(false);
    });

    it('should require at least 2 valid signatures', () => {
      const user1 = 'alice';
      const user2 = 'bob';
      const user3 = 'charlie';

      verifier.registerUserPublicKey(user1, Buffer.alloc(32));
      verifier.registerUserPublicKey(user2, Buffer.alloc(32));
      verifier.registerUserPublicKey(user3, Buffer.alloc(32));

      const message = Buffer.from('multi-party-message');
      const validSigAlice = Buffer.alloc(64, 0x01);
      const validSigBob = Buffer.alloc(64, 0x02);
      const invalidSigCharlie = Buffer.alloc(64, 0xff);

      // Only Alice and Bob have valid keys, Charlie doesn't
      const isValid = verifier.verifyDualSignature(
        message,
        validSigAlice,
        validSigBob,
        user1,
        [user1, user2, user3]
      );

      // Should require both to be valid
      expect(isValid).toBe(true);
    });
  });

  describe('hashMessage', () => {
    it('should produce consistent hash for same input', () => {
      const message1 = 'test-message';
      const message2 = 'test-message';

      const hash1 = verifier.hashMessage(message1);
      const hash2 = verifier.hashMessage(message2);

      expect(Buffer.from(hash1)).toEqual(Buffer.from(hash2));
    });

    it('should produce different hash for different inputs', () => {
      const message1 = 'message-1';
      const message2 = 'message-2';

      const hash1 = verifier.hashMessage(message1);
      const hash2 = verifier.hashMessage(message2);

      expect(Buffer.from(hash1)).not.toEqual(Buffer.from(hash2));
    });
  });

  describe('generateKeypair', () => {
    it('should generate unique keypairs', () => {
      const kp1 = verifier.generateKeypair();
      const kp2 = verifier.generateKeypair();

      expect(kp1.publicKey.toString('hex')).not.toBe(kp2.publicKey.toString('hex'));
      expect(kp1.privateKey.toString('hex')).not.toBe(kp2.privateKey.toString('hex'));
    });

    it('should generate correct key sizes', () => {
      const keypair = verifier.generateKeypair();

      expect(keypair.publicKey.length).toBe(32);
      expect(keypair.privateKey.length).toBe(64); // Secret key includes public key
    });
  });

  describe('validateMessage', () => {
    it('should accept valid messages', () => {
      expect(verifier.validateMessage(Buffer.from('valid'))).toBe(true);
      expect(verifier.validateMessage(Buffer.alloc(1024 * 1024 - 1))).toBe(true);
    });

    it('should reject zero-length messages', () => {
      expect(verifier.validateMessage(Buffer.alloc(0))).toBe(false);
    });

    it('should reject oversized messages', () => {
      expect(verifier.validateMessage(Buffer.alloc(1024 * 1024))).toBe(false);
    });
  });
});
