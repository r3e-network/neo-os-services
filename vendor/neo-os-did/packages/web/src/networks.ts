import { trimString } from '@r3e-network/neo-os-services-shared/utils';
import testnet from '../../../config/networks/testnet.json';
import mainnet from '../../../config/networks/mainnet.json';

export const networkRegistry = {
  testnet,
  mainnet,
} as const;

export type NetworkKey = keyof typeof networkRegistry;

export function normalizeNetworkKey(value?: string | null): NetworkKey | null {
  const normalized = trimString(value).toLowerCase();
  return normalized === 'mainnet' || normalized === 'testnet' ? normalized : null;
}

export function isKnownNetworkKey(value?: string | null) {
  return normalizeNetworkKey(value) !== null;
}

export function resolveSelectedNetworkKey(selectedEnv?: string | null) {
  return normalizeNetworkKey(selectedEnv) === 'mainnet' ? 'mainnet' : 'testnet';
}

function readSelectedEnv() {
  const raw =
    trimString(process.env.NEXT_PUBLIC_MORPHEUS_NETWORK) ||
    trimString(process.env.MORPHEUS_NETWORK);
  if (!raw) {
    throw new Error(
      `MORPHEUS_NETWORK/NEXT_PUBLIC_MORPHEUS_NETWORK is required but not set. ` +
        `Set to "testnet" or "mainnet". Example: export MORPHEUS_NETWORK=testnet`
    );
  }
  const normalized = normalizeNetworkKey(raw);
  if (!normalized) {
    // Fail fast: a typo like MORPHEUS_NETWORK=mainet must not silently select
    // testnet on what the operator believes is a mainnet deployment.
    throw new Error(
      `Invalid MORPHEUS_NETWORK/NEXT_PUBLIC_MORPHEUS_NETWORK value "${raw}"; expected "mainnet" or "testnet"`
    );
  }
  return normalized;
}

export function getSelectedNetwork(networkOverride?: string | null) {
  const selected = resolveSelectedNetworkKey(networkOverride || readSelectedEnv());
  return networkRegistry[selected];
}

export function getSelectedNetworkKey(networkOverride?: string | null) {
  return resolveSelectedNetworkKey(networkOverride || readSelectedEnv());
}

// Client-side network key: prefer the `?network=` query param when running in the
// browser, otherwise fall back to the env-derived selection (SSR-safe).
export function getBrowserNetworkKey() {
  if (typeof window === 'undefined') return getSelectedNetworkKey();
  const url = new URL(window.location.href);
  return getSelectedNetworkKey(url.searchParams.get('network'));
}
