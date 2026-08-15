import { trimString } from './strings';

/**
 * Developer secret registry domain logic (P0-2).
 *
 * Ciphertext is always client-sealed before it reaches the service, so these
 * helpers only validate shapes/limits — never inspect plaintext (the service
 * never has it). Rotation replaces the ciphertext and bumps key_version.
 */

export const MAX_SECRET_CIPHERTEXT_LENGTH = 256 * 1024; // 256 KiB (large JWTs / JSON patches)
export const MAX_SECRET_NAME_LENGTH = 128;
export const MAX_ENCRYPTION_ALGORITHM_LENGTH = 64;

export function sanitizeSecretName(value: unknown): string {
  // Only string names are meaningful; anything else normalizes to empty so
  // callers can apply a default or reject explicitly.
  const name = typeof value === 'string' ? value : '';
  return trimString(name).slice(0, MAX_SECRET_NAME_LENGTH);
}

/** Validate a client-supplied ciphertext blob. Returns an error or null. */
export function validateSecretCiphertext(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return 'ciphertext is required';
  }
  if (value.length > MAX_SECRET_CIPHERTEXT_LENGTH) {
    return `ciphertext exceeds ${MAX_SECRET_CIPHERTEXT_LENGTH} characters`;
  }
  return null;
}

/**
 * Validate an optional expiry. Accepts null/undefined (no expiry) or an ISO-8601
 * timestamp strictly in the future; rejects anything else.
 */
export function validateSecretExpiry(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return 'expires_at must be an ISO-8601 string or null';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 'expires_at must be a valid ISO-8601 timestamp';
  if (parsed <= Date.now()) return 'expires_at must be in the future';
  return null;
}

/**
 * Validate a client-declared encryption algorithm tag. This is metadata (the
 * ciphertext is client-sealed, never server-decrypted), so the check is a
 * format guard, not an allowlist: non-empty, bounded, safe character set.
 */
export function validateEncryptionAlgorithm(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return 'encryption_algorithm must be a non-empty string';
  }
  if (value.length > MAX_ENCRYPTION_ALGORITHM_LENGTH) {
    return `encryption_algorithm exceeds ${MAX_ENCRYPTION_ALGORITHM_LENGTH} characters`;
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    return 'encryption_algorithm may only contain [a-zA-Z0-9_-]';
  }
  return null;
}

export type SecretRegistryRow = {
  id: string;
  project_id: string;
  name: string;
  target_chain: string;
  encryption_algorithm: string;
  key_version: number;
  ciphertext: string;
  metadata: Record<string, unknown>;
  network: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Public projection: never expose ciphertext in list responses. */
export function toPublicSecretRecord(row: SecretRegistryRow) {
  return {
    secret_ref: row.id,
    name: row.name,
    target_chain: row.target_chain,
    encryption_algorithm: row.encryption_algorithm,
    key_version: row.key_version,
    network: row.network,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
