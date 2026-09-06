import { assertCredentialDomainsDistinct } from '@r3e-network/neo-os-services-shared/credential-separation';
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
const isProduction = process.env.NODE_ENV === 'production';

// Production must not reuse one secret across runtime, workflow, operator,
// relayer, signing, relay, or custody domains. Deploy checkers enforce the
// same table; this runtime assert closes the gap when env slips past them.
if (isProduction) {
  assertCredentialDomainsDistinct(process.env, {
    messagePrefix: 'production credentials must be pairwise distinct across trust domains',
  });
}

const defaultNeoRpcUrl = selectedNetwork.neo_n3?.rpc_url || '';
const defaultControlPlaneUrl = isProduction ? 'https://control.meshmini.app' : '';
const defaultNitroApiUrl = selectedNetwork.nitro?.public_api_url || '';

function networkScopedEnv(baseKey: string) {
  const upper = selectedNetworkKey === 'mainnet' ? 'MAINNET' : 'TESTNET';
  const segments = baseKey.split('_');
  const morpheusIndex = segments.indexOf('MORPHEUS');
  const prefixed =
    morpheusIndex >= 0
      ? [...segments.slice(0, morpheusIndex + 1), upper, ...segments.slice(morpheusIndex + 1)].join(
          '_'
        )
      : '';
  return (
    trimString(process.env[`${baseKey}_${upper}` as keyof NodeJS.ProcessEnv]) ||
    trimString(process.env[prefixed as keyof NodeJS.ProcessEnv])
  );
}

function isHostSignerEnvName(name: string) {
  const upper = name.toUpperCase();
  return (
    /(?:^|_)WIF(?:_|$)/.test(upper) ||
    (/(?:^|_)(?:PRIVATE_KEY|PK)(?:_|$)/.test(upper) && /(NEO|NEOX|EVM|MORPHEUS|SIGNER)/.test(upper))
  );
}

const configuredHostSignerEnvNames = Object.entries(process.env)
  .filter(([name, value]) => isHostSignerEnvName(name) && trimString(value))
  .map(([name]) => name)
  .sort();
if (isProduction && configuredHostSignerEnvNames.length > 0) {
  throw new Error(
    'host signing key configuration is forbidden in the production web/control-plane process; ' +
      `use custody/enclave signing instead (configured: ${configuredHostSignerEnvNames.join(', ')})`
  );
}

const serverNitroApiCandidates = [
  networkScopedEnv('MORPHEUS_RUNTIME_URL'),
  trimString(process.env.MORPHEUS_RUNTIME_URL),
]
  .map((value) => value.trim())
  .filter(Boolean);
const publicNitroApiCandidates = [
  ...serverNitroApiCandidates,
  networkScopedEnv('NEXT_PUBLIC_MORPHEUS_RUNTIME_URL'),
  trimString(process.env.NEXT_PUBLIC_MORPHEUS_RUNTIME_URL),
  defaultNitroApiUrl,
  `https://oracle.meshmini.app/${selectedNetworkKey}`,
  `https://edge.meshmini.app/${selectedNetworkKey}`,
]
  .map((value) => value.trim())
  .filter(Boolean);
const defaultNitroApiCandidates = [
  ...serverNitroApiCandidates,
  ...(isProduction ? [] : publicNitroApiCandidates),
];
const runtimeCredentialValues = [
  process.env.MORPHEUS_RUNTIME_TOKEN,
  process.env.NITRO_API_TOKEN,
  process.env.NITRO_SHARED_SECRET,
]
  .map((value) => trimString(value))
  .filter(Boolean);
const nitroToken = runtimeCredentialValues[0] || '';
const controlPlaneApiKey =
  [process.env.MORPHEUS_CONTROL_PLANE_API_KEY, process.env.MORPHEUS_OPERATOR_API_KEY]
    .map((value) => trimString(value))
    .find((value) => value && !runtimeCredentialValues.includes(value)) || '';

export const appConfig = {
  name: publicConfig.name,
  appUrl: publicConfig.appUrl,
  selectedNetworkKey,
  nitroApiUrl: serverNitroApiCandidates[0] || (isProduction ? '' : publicNitroApiCandidates[0]),
  nitroApiUrls: [...new Set(defaultNitroApiCandidates)],
  // Only routes explicitly classified as non-confidential may consume these
  // public/registry candidates.
  publicNitroApiUrls: [...new Set(publicNitroApiCandidates)],
  // Server-only env names exclusively: a NEXT_PUBLIC_* fallback here would
  // invite operators to configure the runtime bearer secret as a value that
  // Next.js inlines into public client bundles. Only the current
  // MORPHEUS_*/NITRO_* runtime tokens are accepted.
  nitroToken,
  controlPlaneUrl:
    process.env.MORPHEUS_CONTROL_PLANE_URL ||
    process.env.NEXT_PUBLIC_MORPHEUS_CONTROL_PLANE_URL ||
    defaultControlPlaneUrl,
  // The credential the backend presents to the Cloudflare control plane. Nitro
  // runtime credentials are deliberately excluded: data-plane access must not
  // imply workflow/control-plane authority.
  controlPlaneApiKey,
  feedProjectSlug: process.env.MORPHEUS_FEED_PROJECT_SLUG || 'morpheus',
  feedProvider: process.env.MORPHEUS_FEED_PROVIDER || 'twelvedata',
  supabaseUrl: publicConfig.supabaseUrl,
  supabaseAnonKey: publicConfig.supabaseAnonKey,
  neoRpcUrl: process.env.NEO_RPC_URL || defaultNeoRpcUrl,
};
