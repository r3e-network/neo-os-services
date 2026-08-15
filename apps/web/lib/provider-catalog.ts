// Static mirrors of the runtime's built-in catalogs, so apps/web can serve
// /api/providers and /api/neodid/providers WITHOUT proxying the runtime (these
// lists are fixed, network-independent metadata with no secret). The single
// source of truth is the worker; keep these in sync with:
//   - workers/nitro-worker/src/oracle/providers.js  (BUILTIN_PROVIDER_CATALOG)
//   - workers/nitro-worker/src/neodid/index.js       (SUPPORTED_PROVIDERS)
// apps/web (tsconfig allowJs:false) cannot import the worker .js directly.

export interface OracleProvider {
  id: string;
  category: string;
  description: string;
  supports: string[];
  kernel_supports: string[];
  auth: string;
}

export const BUILTIN_PROVIDER_CATALOG: OracleProvider[] = [
  {
    id: 'twelvedata',
    category: 'market-data',
    description:
      'Direct TwelveData market data source for shared fetch/query and resource publication lanes. No aggregation, no smoothing.',
    supports: ['oracle', 'datafeed'],
    kernel_supports: ['oracle.fetch', 'feed.publish'],
    auth: 'apikey',
  },
  {
    id: 'binance-spot',
    category: 'market-data',
    description:
      'Direct Binance spot ticker endpoint for shared fetch/query and resource publication lanes. No aggregation, no smoothing.',
    supports: ['oracle', 'datafeed'],
    kernel_supports: ['oracle.fetch', 'feed.publish'],
    auth: 'none',
  },
  {
    id: 'coinbase-spot',
    category: 'market-data',
    description:
      'Direct Coinbase spot price endpoint for shared fetch/query and resource publication lanes. No aggregation, no smoothing.',
    supports: ['oracle', 'datafeed'],
    kernel_supports: ['oracle.fetch', 'feed.publish'],
    auth: 'none',
  },
];

export interface NeoDidProvider {
  id: string;
  category: string;
  aliases: string[];
  auth_modes: string[];
  claim_types: string[];
  derives_provider_uid_in_tee: boolean;
}

export const NEODID_SUPPORTED_PROVIDERS: NeoDidProvider[] = [
  {
    id: 'web3auth',
    category: 'identity',
    aliases: ['w3a'],
    auth_modes: ['aggregate_oauth', 'mfa'],
    claim_types: ['Web3Auth_PrimaryIdentity', 'Web3Auth_LinkedSocials', 'Web3Auth_VerifiedUser'],
    derives_provider_uid_in_tee: true,
  },
  {
    id: 'twitter',
    category: 'social',
    aliases: [],
    auth_modes: ['oauth'],
    claim_types: ['Twitter_VIP', 'Twitter_Verified', 'Twitter_Followers'],
    derives_provider_uid_in_tee: false,
  },
  {
    id: 'github',
    category: 'social',
    aliases: [],
    auth_modes: ['oauth'],
    claim_types: ['Github_Contributor', 'Github_OrgMember', 'Github_VerifiedUser'],
    derives_provider_uid_in_tee: false,
  },
  {
    id: 'google',
    category: 'social',
    aliases: ['gmail'],
    auth_modes: ['oauth'],
    claim_types: ['Google_Identity', 'Google_Workspace', 'Google_VerifiedEmail'],
    derives_provider_uid_in_tee: false,
  },
  {
    id: 'discord',
    category: 'social',
    aliases: [],
    auth_modes: ['oauth'],
    claim_types: ['Discord_Member'],
    derives_provider_uid_in_tee: false,
  },
  {
    id: 'telegram',
    category: 'social',
    aliases: [],
    auth_modes: ['oauth'],
    claim_types: ['Telegram_Member'],
    derives_provider_uid_in_tee: false,
  },
  {
    id: 'binance',
    category: 'exchange',
    aliases: [],
    auth_modes: ['api', 'oauth'],
    claim_types: ['Binance_KYC', 'Binance_VIP', 'Binance_AssetHolder'],
    derives_provider_uid_in_tee: false,
  },
  {
    id: 'okx',
    category: 'exchange',
    aliases: ['okex'],
    auth_modes: ['api', 'oauth'],
    claim_types: ['OKX_KYC', 'OKX_VIP', 'OKX_AssetHolder'],
    derives_provider_uid_in_tee: false,
  },
  {
    id: 'email',
    category: 'contact',
    aliases: ['mail'],
    auth_modes: ['otp', 'magic_link'],
    claim_types: ['Email_Verified'],
    derives_provider_uid_in_tee: false,
  },
  {
    id: 'generic_oauth',
    category: 'generic',
    aliases: [],
    auth_modes: ['oauth'],
    claim_types: ['Generic_Claim'],
    derives_provider_uid_in_tee: false,
  },
];
