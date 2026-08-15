import { badRequest } from '@/lib/api-helpers';
import { getSelectedNetwork, getSelectedNetworkKey, isKnownNetworkKey } from '@/lib/networks';
import { readNeoN3Contract } from '@/lib/onchain-state';
import { trimString } from '@/lib/strings';

// The oracle's confidential-payload encryption key is X25519-HKDF-SHA256-AES-256-GCM.
const DEFAULT_ALGORITHM = 'X25519-HKDF-SHA256-AES-256-GCM';

function readNetwork(request: Request) {
  return new URL(request.url).searchParams.get('network');
}

// Re-homed (2026-06): the oracle public keys are published ON-CHAIN by the enclave
// (the private X25519 half never leaves the TEE), so apps/web serves them with a
// trustless read of the deployed MorpheusOracle kernel instead of proxying the
// retired runtime. The browser X25519 helper (lib/browser-encryption.ts) consumes
// `public_key` as the base64 key, so the contract preserves that field.
// IMPORTANT: read the CANONICAL kernel the box actually signs against (the one in
// config/networks, whose oracleVerificationPublicKey matches the box /health
// verifier) — never a stale sibling deployment, or clients would seal to a key the
// box cannot decrypt.
export async function GET(request: Request) {
  const network = readNetwork(request);
  if (network && !isKnownNetworkKey(network)) {
    return badRequest(`unknown network "${network}"; expected "mainnet" or "testnet"`);
  }

  const selected = getSelectedNetwork(network);
  const networkKey = getSelectedNetworkKey(network);
  const oracleHash = trimString(selected.neo_n3?.contracts?.morpheus_oracle);

  try {
    if (!oracleHash) throw new Error('morpheus_oracle contract is not configured for this network');

    const [encKey, algorithm, keyVersion, verifier] = await Promise.all([
      readNeoN3Contract(network, oracleHash, 'oracleEncryptionPublicKey'),
      readNeoN3Contract(network, oracleHash, 'oracleEncryptionAlgorithm'),
      readNeoN3Contract(network, oracleHash, 'oracleEncryptionKeyVersion'),
      readNeoN3Contract(network, oracleHash, 'oracleVerificationPublicKey'),
    ]);

    const publicKey = trimString(encKey);
    const source = {
      network: networkKey,
      chain: 'neo_n3',
      oracle_contract: oracleHash,
      method: 'oracleEncryptionPublicKey',
    };

    if (!publicKey) {
      // The kernel has no encryption key registered yet (e.g. mainnet today, version
      // 0). Degrade honestly rather than hand clients a wrong/empty key.
      return Response.json(
        {
          available: false,
          degraded: true,
          public_key: null,
          algorithm: trimString(algorithm) || DEFAULT_ALGORITHM,
          key_version: String(keyVersion ?? '0'),
          verification_public_key: trimString(verifier) || null,
          key_source: 'onchain-unset',
          error: 'oracle_public_key_unavailable',
          message: 'oracle encryption public key is not published on the on-chain kernel yet',
          source,
        },
        { status: 200, headers: { 'cache-control': 'public, max-age=30' } }
      );
    }

    return Response.json(
      {
        available: true,
        degraded: false,
        public_key: publicKey,
        algorithm: trimString(algorithm) || DEFAULT_ALGORITHM,
        key_version: String(keyVersion ?? '0'),
        verification_public_key: trimString(verifier) || null,
        key_source: 'neo_n3_contract',
        source,
      },
      { status: 200, headers: { 'cache-control': 'public, max-age=30' } }
    );
  } catch (error) {
    // RPC/read failure across all candidate nodes — keep the graceful 200 degraded
    // contract so consumers don't hard-fail.
    return Response.json(
      {
        available: false,
        degraded: true,
        public_key: null,
        algorithm: DEFAULT_ALGORITHM,
        key_source: 'unavailable',
        error: 'oracle_public_key_unavailable',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 200, headers: { 'cache-control': 'no-store' } }
    );
  }
}
