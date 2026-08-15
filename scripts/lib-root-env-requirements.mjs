import { trimString } from './lib-strings.mjs';
// Shared requirement lists for scripts/check-root-env.mjs.
//
// Each group is an alias list: ONE non-empty value satisfies the group. The
// names must mirror what each consumer ACTUALLY reads, otherwise the checker
// reports green for configuration the app silently ignores:
// - apps/web resolves network-scoped runtime URLs via networkScopedEnv
//   (apps/web/lib/config.ts, apps/web/lib/nitro.ts), i.e. the SUFFIX form
//   MORPHEUS_RUNTIME_URL_{MAINNET,TESTNET} plus the unscoped
//   MORPHEUS_RUNTIME_URL / NEXT_PUBLIC_MORPHEUS_RUNTIME_URL. The web app never
//   reads the infix MORPHEUS_{MAINNET,TESTNET}_RUNTIME_URL names (those belong
//   to ops scripts), so they may not satisfy the web groups.
// - The runtime bearer token aliases mirror appConfig.nitroToken.
// - Supabase aliases mirror apps/web/lib/public-config.ts (browser) and
//   apps/web/lib/server-supabase.ts (server).

export const WEB_RUNTIME_URL_KEYS = [
  'MORPHEUS_RUNTIME_URL',
  'MORPHEUS_RUNTIME_URL_MAINNET',
  'MORPHEUS_RUNTIME_URL_TESTNET',
  'NEXT_PUBLIC_MORPHEUS_RUNTIME_URL',
  'NEXT_PUBLIC_MORPHEUS_RUNTIME_URL_MAINNET',
  'NEXT_PUBLIC_MORPHEUS_RUNTIME_URL_TESTNET',
];

const WEB_RUNTIME_TOKEN_KEYS = ['MORPHEUS_RUNTIME_TOKEN', 'NITRO_API_TOKEN', 'NITRO_SHARED_SECRET'];

export const ROOT_ENV_REQUIRED_GROUPS = {
  web_public: [
    ['NEXT_PUBLIC_APP_NAME'],
    ['NEXT_PUBLIC_APP_URL'],
    WEB_RUNTIME_URL_KEYS,
    ['NEXT_PUBLIC_SUPABASE_URL'],
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY'],
  ],
  web_server: [
    WEB_RUNTIME_URL_KEYS,
    ['SUPABASE_URL', 'morpheus_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'],
    [
      'SUPABASE_SECRET_KEY',
      'morpheus_SUPABASE_SECRET_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'morpheus_SUPABASE_SERVICE_ROLE_KEY',
    ],
    WEB_RUNTIME_TOKEN_KEYS,
    ['MORPHEUS_NETWORK'],
    ['NEO_RPC_URL'],
    ['NEO_NETWORK_MAGIC'],
    ['CONTRACT_MORPHEUS_ORACLE_HASH'],
    ['CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH'],
  ],
  feed_ops: [
    ['MORPHEUS_FEED_PROVIDER'],
    ['MORPHEUS_FEED_PROJECT_SLUG'],
    ['MORPHEUS_CRON_SECRET'],
    ['MORPHEUS_FEED_SYMBOLS'],
  ],
  n3_scripts: [
    [
      'NEO_N3_WIF',
      'NEO_TESTNET_WIF',
      'MORPHEUS_RELAYER_NEO_N3_WIF',
      'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY',
    ],
  ],
};

export const ROOT_ENV_OPTIONAL_GROUPS = {
  admin_api: [['MORPHEUS_PROVIDER_CONFIG_API_KEY', 'ADMIN_CONSOLE_API_KEY']],
  feed_sync: [
    ['MORPHEUS_FEED_PROVIDERS'],
    ['MORPHEUS_FEED_CHANGE_THRESHOLD_BPS'],
    ['MORPHEUS_FEED_MIN_UPDATE_INTERVAL_MS'],
  ],
  oracle_verifier: [['MORPHEUS_ORACLE_VERIFIER_WIF', 'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY']],
};

export function getGroupValue(env, keys) {
  for (const key of keys) {
    const value = trimString(env[key]);
    if (value) return value;
  }
  return '';
}

// Returns { [section]: ['KEY_A | KEY_B', ...] } for every unsatisfied group.
export function evaluateRootEnvRequirements(env, groups = ROOT_ENV_REQUIRED_GROUPS) {
  const missing = {};
  for (const [section, sectionGroups] of Object.entries(groups)) {
    missing[section] = sectionGroups
      .filter((keys) => !getGroupValue(env, keys))
      .map((keys) => keys.join(' | '));
  }
  return missing;
}
