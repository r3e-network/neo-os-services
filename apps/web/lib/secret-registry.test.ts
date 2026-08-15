import { describe, expect, it } from 'vitest';

import {
  MAX_SECRET_CIPHERTEXT_LENGTH,
  sanitizeSecretName,
  toPublicSecretRecord,
  validateEncryptionAlgorithm,
  validateSecretCiphertext,
  validateSecretExpiry,
  type SecretRegistryRow,
} from './secret-registry';

const baseRow: SecretRegistryRow = {
  id: '9f1b4c9e-0000-4000-8000-000000000001',
  project_id: 'project-1',
  name: 'api-token',
  target_chain: 'neo_n3',
  encryption_algorithm: 'client-supplied-ciphertext',
  key_version: 1,
  ciphertext: 'SEALED-CIPHERTEXT',
  metadata: {},
  network: 'mainnet',
  expires_at: null,
  created_at: '2026-08-13T00:00:00.000Z',
  updated_at: '2026-08-13T00:00:00.000Z',
};

describe('secret name sanitation', () => {
  it('trims and caps length', () => {
    expect(sanitizeSecretName('  api-token  ')).toBe('api-token');
    expect(sanitizeSecretName('x'.repeat(500)).length).toBeLessThanOrEqual(128);
  });

  it('normalizes non-string names to empty so callers can default or reject', () => {
    expect(sanitizeSecretName(123)).toBe('');
    expect(sanitizeSecretName(null)).toBe('');
    expect(sanitizeSecretName({ name: 'x' })).toBe('');
  });
});

describe('ciphertext validation', () => {
  it('rejects empty and non-string', () => {
    expect(validateSecretCiphertext('')).toMatch(/required/);
    expect(validateSecretCiphertext(undefined)).toMatch(/required/);
    expect(validateSecretCiphertext(123)).toMatch(/required/);
  });

  it('accepts a normal ciphertext and enforces the cap', () => {
    expect(validateSecretCiphertext('abc')).toBeNull();
    expect(validateSecretCiphertext('x'.repeat(MAX_SECRET_CIPHERTEXT_LENGTH + 1))).toMatch(
      /exceeds/
    );
  });
});

describe('encryption algorithm validation', () => {
  it('accepts a safe tag and rejects empty/unsafe values', () => {
    expect(validateEncryptionAlgorithm('client-supplied-ciphertext')).toBeNull();
    expect(validateEncryptionAlgorithm('x25519-hkdf-sha256-aes-256-gcm')).toBeNull();
    expect(validateEncryptionAlgorithm('')).toMatch(/non-empty/);
    expect(validateEncryptionAlgorithm('bad chars!')).toMatch(/only contain/);
    expect(validateEncryptionAlgorithm('x'.repeat(65))).toMatch(/exceeds/);
  });
});

describe('expiry validation', () => {
  it('accepts null/empty as no expiry', () => {
    expect(validateSecretExpiry(null)).toBeNull();
    expect(validateSecretExpiry(undefined)).toBeNull();
    expect(validateSecretExpiry('')).toBeNull();
  });

  it('rejects past or malformed timestamps', () => {
    expect(validateSecretExpiry('2020-01-01T00:00:00.000Z')).toMatch(/future/);
    expect(validateSecretExpiry('not-a-date')).toMatch(/ISO-8601/);
  });

  it('accepts a future timestamp', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(validateSecretExpiry(future)).toBeNull();
  });
});

describe('public projection', () => {
  it('never exposes ciphertext', () => {
    const record = toPublicSecretRecord(baseRow);
    expect(record.secret_ref).toBe(baseRow.id);
    expect(record.key_version).toBe(1);
    expect(record).not.toHaveProperty('ciphertext');
    expect(record).not.toHaveProperty('project_id');
  });
});
