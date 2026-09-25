export const MORPHEUS_DID_METHOD = 'morpheus';
export const MORPHEUS_NEODID_NETWORK = 'neo_n3';
export const MORPHEUS_NEODID_SERVICE = 'neodid';
export const MORPHEUS_NEODID_DID_CONTEXT = [
  'https://www.w3.org/ns/did/v1',
  'https://w3id.org/security/suites/jws-2020/v1',
] as const;

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
