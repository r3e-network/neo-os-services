// Startup admission is explicit; request data may never select an authority network.
export function admittedNetwork(value) {
  if (value !== 'mainnet' && value !== 'testnet') {
    throw new TypeError('network must be exactly mainnet or testnet');
  }
  return value;
}
export const ZERO_HASH = '0'.repeat(64);
export const MAX_U64 = 18_446_744_073_709_551_615n;
export const SNAPSHOT_CONTENT_TYPE = 'application/octet-stream';
export const WIRE_SCHEMA = 'neoos/custody-state-wire/v3';
export const HEAD_SCHEMA = 'neoos/custody-state-head/v2';
export const RECEIPT_SCHEMA = 'neoos/custody-state-receipt/v2';
export const CHALLENGE_SCHEMA = 'neoos/custody-state-challenge/v2';
export const UPLOAD_CLAIM_SCHEMA = 'neoos/custody-state-upload-claim/v2';
export const COMMIT_REQUEST_SCHEMA = 'neoos/custody-state-commit-request/v2';
export const OPERATION_SCHEMA = 'neoos/custody-state-operation/v2';
export const REQUEST_PROOF_SCHEMA = 'neoos/custody-state-request-proof/v1';
export const REQUEST_PROOF_ALGORITHM = 'RSA-PSS-SHA256';
export const SNAPSHOT_PREFIX = 'snapshots/v2';
export const SESSION_TOKEN_BYTES = 32;
export const CHALLENGE_NONCE_BYTES = 32;
export const CHALLENGE_ID_BYTES = 24;

export const ENTITY = Object.freeze({
  challenge: 'CHALLENGE',
  session: 'SESSION',
  sessionProof: 'SESSION_PROOF',
  head: 'HEAD',
  claim: 'COMMIT_CLAIM',
  commit: 'COMMIT',
});
