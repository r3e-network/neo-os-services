import { describe, expect, it } from 'vitest';

import {
  MAX_SECRET_CIPHERTEXT_LENGTH,
  buildSecretMetadata,
  normalizeBindingHash160,
  sanitizeSecretName,
  toPublicSecretRecord,
  validateEncryptionAlgorithm,
  validateSecretBinding,
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

// ===========================================================================
// SVC-C-5: the encryption label (bound_requester / bound_callback_contract) is
// what stops a leaked `secret_ref` from being spendable out of context. The
// enclave read path only enforces a binding when the stored row carries one,
// so the write path must own those keys outright.
// ===========================================================================

describe('secret binding metadata (SVC-C-5)', () => {
  const REQUESTER = '0x' + 'ab'.repeat(20);
  const CALLBACK = '0x' + 'cd'.repeat(20);

  it('normalizes a hash160 and rejects anything that is not one', () => {
    expect(normalizeBindingHash160('AB'.repeat(20))).toBe(REQUESTER);
    expect(normalizeBindingHash160(REQUESTER)).toBe(REQUESTER);
    expect(normalizeBindingHash160('anything-non-hash160')).toBe('');
    expect(normalizeBindingHash160('0x' + 'ab'.repeat(19))).toBe('');
    expect(normalizeBindingHash160(null)).toBe('');
    expect(normalizeBindingHash160(undefined)).toBe('');
    expect(normalizeBindingHash160({})).toBe('');
    expect(normalizeBindingHash160(['ab'.repeat(20)])).toBe('');
  });

  it('caller metadata cannot override the computed binding', () => {
    const built = buildSecretMetadata({
      callerMetadata: {
        bound_requester: 'anything-non-hash160',
        bound_callback_contract: 'also-garbage',
        note: 'kept',
      },
      source: 'api.confidential.store',
      network: 'mainnet',
      requester: REQUESTER,
      callbackContract: CALLBACK,
    });
    expect(built.metadata.bound_requester).toBe(REQUESTER);
    expect(built.metadata.bound_callback_contract).toBe(CALLBACK);
    expect(built.metadata.note).toBe('kept');
    expect(built.metadata.source).toBe('api.confidential.store');
    expect(built.boundRequester).toBe(REQUESTER);
  });

  it('caller metadata cannot invent a binding the server did not compute', () => {
    const built = buildSecretMetadata({
      callerMetadata: { bound_requester: REQUESTER, bound_callback_contract: CALLBACK },
      source: 'api.registry.secrets.post',
    });
    expect(built.metadata).not.toHaveProperty('bound_requester');
    expect(built.metadata).not.toHaveProperty('bound_callback_contract');
    expect(built.boundRequester).toBe('');
    expect(built.boundCallbackContract).toBe('');
  });

  it('does not mutate the caller-supplied metadata object', () => {
    const caller = { bound_requester: 'garbage', keep: 1 };
    buildSecretMetadata({ callerMetadata: caller, source: 's', requester: REQUESTER });
    expect(caller.bound_requester).toBe('garbage');
  });

  it('ignores non-object caller metadata instead of throwing', () => {
    expect(buildSecretMetadata({ callerMetadata: [1, 2], source: 's' }).metadata).toEqual({
      source: 's',
    });
    expect(buildSecretMetadata({ callerMetadata: null, source: 's' }).metadata).toEqual({
      source: 's',
    });
  });

  it('requires at least one binding on mainnet and stays permissive on testnet', () => {
    expect(validateSecretBinding('mainnet', '', '')).toMatch(/bound/);
    expect(validateSecretBinding('mainnet', REQUESTER, '')).toBeNull();
    expect(validateSecretBinding('mainnet', '', CALLBACK)).toBeNull();
    expect(validateSecretBinding('testnet', '', '')).toBeNull();
  });
});
