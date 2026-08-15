import { trimString } from '@r3e-network/neo-os-services-shared/utils';
import { getSelectedNetwork, getSelectedNetworkKey } from './networks';
import { publicConfig } from './public-config';

// appConfig carries server credentials (runtime bearer token, control-plane
// API keys), so this module is server-only. The guard substitutes for the
// `server-only` package (not part of this workspace): any accidental client
// bundle import fails loudly instead of shipping secrets to the browser.
// Client components must import lib/public-config instead.
if (typeof window !== 'undefined') {
  throw new Error('lib/config is server-only; import lib/public-config from client components');
}

const selectedNetworkKey = getSelectedNetworkKey();
const selectedNetwork = getSelectedNetwork();

const defaultNeoRpcUrl = selectedNetwork.neo_n3?.rpc_url || '';
const defaultControlPlaneUrl =
  process.env.NODE_ENV === 'production' ? 'https://control.meshmini.app' : '';
const defaultNitroApiUrl = selectedNetwork.nitro?.public_api_url || '';

function networkScopedEnv(baseKey: string) {
  const upper = selectedNetworkKey === 'mainnet' ? 'MAINNET' : 'TESTNET';
  return trimString(process.env[`${baseKey}_${upper}` as keyof NodeJS.ProcessEnv]);
}

const defaultNitroApiCandidates = [
  networkScopedEnv('MORPHEUS_RUNTIME_URL'),
  trimString(process.env.MORPHEUS_RUNTIME_URL),
  networkScopedEnv('NEXT_PUBLIC_MORPHEUS_RUNTIME_URL'),
  trimString(process.env.NEXT_PUBLIC_MORPHEUS_RUNTIME_URL),
  defaultNitroApiUrl,
  `https://oracle.meshmini.app/${selectedNetworkKey}`,
  `https://edge.meshmini.app/${selectedNetworkKey}`,
]
  .map((value) => value.trim())
  .filter(Boolean);

export const appConfig = {
  name: publicConfig.name,
  appUrl: publicConfig.appUrl,
  selectedNetworkKey,
  nitroApiUrl:
    networkScopedEnv('MORPHEUS_RUNTIME_URL') ||
    trimString(process.env.MORPHEUS_RUNTIME_URL) ||
    networkScopedEnv('NEXT_PUBLIC_MORPHEUS_RUNTIME_URL') ||
    trimString(process.env.NEXT_PUBLIC_MORPHEUS_RUNTIME_URL) ||
    defaultNitroApiUrl,
  nitroApiUrls: [...new Set(defaultNitroApiCandidates)],
  // Server-only env names exclusively: a NEXT_PUBLIC_* fallback here would
  // invite operators to configure the runtime bearer secret as a value that
  // Next.js inlines into public client bundles. Only the current
  // MORPHEUS_*/NITRO_* runtime tokens are accepted.
  nitroToken:
    trimString(process.env.MORPHEUS_RUNTIME_TOKEN) ||
    trimString(process.env.NITRO_API_TOKEN) ||
    trimString(process.env.NITRO_SHARED_SECRET) ||
    '',
  controlPlaneUrl:
    process.env.MORPHEUS_CONTROL_PLANE_URL ||
    process.env.NEXT_PUBLIC_MORPHEUS_CONTROL_PLANE_URL ||
    defaultControlPlaneUrl,
  // The credential the backend presents when forwarding to control-plane routes.
  // It must be one the control-plane auth check accepts (operator/admin-console
  // or the runtime token) — NOT the low-privilege provider-config key, which no
  // longer authorizes control-plane execution (audit finding 19/20/30/31/37).
  controlPlaneApiKey:
    process.env.MORPHEUS_CONTROL_PLANE_API_KEY ||
    process.env.MORPHEUS_OPERATOR_API_KEY ||
    process.env.ADMIN_CONSOLE_API_KEY ||
    process.env.NITRO_API_TOKEN ||
    process.env.NITRO_SHARED_SECRET ||
    '',
  feedProjectSlug: process.env.MORPHEUS_FEED_PROJECT_SLUG || 'morpheus',
  feedProvider: process.env.MORPHEUS_FEED_PROVIDER || 'twelvedata',
  supabaseUrl: publicConfig.supabaseUrl,
  supabaseAnonKey: publicConfig.supabaseAnonKey,
  neoRpcUrl: process.env.NEO_RPC_URL || defaultNeoRpcUrl,
};
