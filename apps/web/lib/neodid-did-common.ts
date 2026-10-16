export const MORPHEUS_DID_METHOD = 'morpheus';
export const MORPHEUS_NEODID_NETWORK = 'neo_n3';
export const MORPHEUS_NEODID_SERVICE = 'neodid';
export const MORPHEUS_NEODID_DID_CONTEXT = [
  'https://www.w3.org/ns/did/v1',
  'https://w3id.org/security/suites/jws-2020/v1',
] as const;

// Stable DID-resolution error codes. Callers and tests compare against these
// constants; never string-match the literals at call sites. `invalidDid` is the
// W3C DID Resolution shape this resolver already used. `invalidVerificationKey`
// is the NeoDID code for a present verification key that is not a usable
// compressed P-256 point (malformed encoding or off the curve): bad data, not a
// server fault. A genuine internal fault is distinguishable in logs — it is a
// 500 rather than this 400 refusal.
export const DID_RESOLUTION_ERROR_INVALID_DID = 'invalidDid';
export const DID_RESOLUTION_ERROR_INVALID_VERIFICATION_KEY = 'invalidVerificationKey';

export type DidResolutionErrorCode =
  | typeof DID_RESOLUTION_ERROR_INVALID_DID
  | typeof DID_RESOLUTION_ERROR_INVALID_VERIFICATION_KEY;

function trimSegment(value: string) {
  return String(value || '').trim();
}

export function encodeDidSegment(value: string) {
  return encodeURIComponent(trimSegment(value));
}

export function buildNeoDidServiceDid(service = MORPHEUS_NEODID_SERVICE) {
  return `did:${MORPHEUS_DID_METHOD}:${MORPHEUS_NEODID_NETWORK}:service:${encodeDidSegment(service.toLowerCase())}`;
}

export function buildNeoDidVaultDid(vaultHash160: string) {
  const normalized = trimSegment(vaultHash160).replace(/^0x/i, '').toLowerCase();
  return `did:${MORPHEUS_DID_METHOD}:${MORPHEUS_NEODID_NETWORK}:vault:${normalized}`;
}

export function buildNeoDidAaDid(accountId: string) {
  return `did:${MORPHEUS_DID_METHOD}:${MORPHEUS_NEODID_NETWORK}:aa:${encodeDidSegment(accountId)}`;
}

export const DEFAULT_NEODID_SERVICE_DID = buildNeoDidServiceDid();
export const DEFAULT_NEODID_VAULT_DID = buildNeoDidVaultDid(
  '6d0656f6dd91469db1c90cc1e574380613f43738'
);
export const DEFAULT_NEODID_AA_DID = process.env.NEXT_PUBLIC_MORPHEUS_NEODID_AA_ACCOUNT_ID
  ? buildNeoDidAaDid(process.env.NEXT_PUBLIC_MORPHEUS_NEODID_AA_ACCOUNT_ID)
  : '';
