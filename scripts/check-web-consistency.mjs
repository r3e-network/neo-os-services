import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPublicRuntimeCatalog } from './lib-public-runtime-catalog.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function read(relativePath) {
  return fs.readFile(path.resolve(repoRoot, relativePath), 'utf8');
}

// Every extractor below accepts BOTH quote styles: the web sources are
// prettier-formatted to single quotes while older revisions (and JSON-ish
// worker literals) used double quotes; a quote-style-only reformat must never
// silently empty a dataset and turn its comparison into a vacuous pass.
function extractBuiltinNames(sourceText) {
  return [...sourceText.matchAll(/name:\s*(['"])([^'"]+)\1/g)].map((match) => match[2]);
}

function extractQuotedArrayStrings(sourceText, arrayName) {
  const blockMatch = sourceText.match(
    new RegExp(`(?:export\\s+)?const ${arrayName} = \\[(.*?)\\]`, 's')
  );
  if (!blockMatch) return [];
  return [...blockMatch[1].matchAll(/(['"])([^'"]+)\1/g)].map((match) => match[2]);
}

function extractFrontendFeedSymbols(sourceText) {
  const direct = extractQuotedArrayStrings(sourceText, 'DEFAULT_FEED_SYMBOLS');
  if (direct.length > 0) return direct;

  const baseSymbols = extractQuotedArrayStrings(sourceText, 'DEFAULT_FEED_BASE_SYMBOLS');
  if (baseSymbols.length === 0) return [];

  // Base symbols without their provider prefix are useless for comparison, so
  // a failed prefix match is a hard error rather than a silent '' fallback.
  const prefixMatch = sourceText.match(
    /export const CANONICAL_FEED_PROVIDER_PREFIX = (['"])([^'"]+)\1;/
  );
  assert(
    prefixMatch,
    'failed to parse CANONICAL_FEED_PROVIDER_PREFIX from apps/web/lib/feed-defaults.ts'
  );
  return baseSymbols.map((symbol) => `${prefixMatch[2]}${symbol}`);
}

function normalizeFeedSymbolForComparison(symbol) {
  return String(symbol || '').replace(/^[A-Z0-9-]+:/, '');
}

function extractFeedRegistryPairs(sourceText) {
  const blockMatch = sourceText.match(/export const DEFAULT_FEED_PAIRS = \{(.*?)\n\};/s);
  if (!blockMatch) return [];
  return [...blockMatch[1].matchAll(/(['"])([A-Z0-9-]+)\1:\s*\{/g)].map((match) => match[2]);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const publicRuntimeCatalog = loadPublicRuntimeCatalog();
const publicWorkflowIds = new Set(publicRuntimeCatalog.workflows.map((item) => item.id));

assert(
  publicRuntimeCatalog.envelope.version === '2026-04-tee-v1',
  'public runtime catalog must expose the canonical result envelope version'
);
assert(
  publicWorkflowIds.has('automation.upkeep'),
  'public runtime catalog must include automation.upkeep'
);
assert(
  publicWorkflowIds.has('paymaster.authorize'),
  'public runtime catalog must include paymaster.authorize'
);
assert(
  publicRuntimeCatalog.workflows.every((item) => !('confidentialSteps' in item)),
  'public runtime catalog must not expose confidential execution step details'
);

const [
  docsDataText,
  workerComputeText,
  onchainDataText,
  networksLibText,
  feedDefaultsText,
  workerFeedRegistryText,
  mainnetConfigText,
  testnetConfigText,
  oracleDocsText,
  quickstartDocsText,
  apiReferenceDocsText,
  datafeedsDocsText,
  neodidDocsText,
  docsLayoutText,
  docsNavigationText,
  neodidDidSpecText,
  docsIndexText,
  architectureDocsText,
  networksDocsText,
  computeDocsText,
  verifierDocsText,
  userGuideText,
  deploymentDocText,
] = await Promise.all([
  read('apps/web/lib/docs-data.ts'),
  read('workers/nitro-worker/src/compute/index.js'),
  read('apps/web/lib/onchain-data.ts'),
  read('apps/web/lib/networks.ts'),
  read('apps/web/lib/feed-defaults.ts'),
  read('workers/nitro-worker/src/oracle/feed-registry.js'),
  read('config/networks/mainnet.json'),
  read('config/networks/testnet.json'),
  read('apps/web/app/docs/oracle/page.tsx'),
  read('apps/web/app/docs/quickstart/page.tsx'),
  read('apps/web/app/docs/api-reference/page.tsx'),
  read('apps/web/app/docs/datafeeds/page.tsx'),
  read('apps/web/app/docs/neodid/page.tsx'),
  read('apps/web/app/docs/layout.tsx'),
  read('apps/web/lib/docs-navigation.ts'),
  read('docs/NEODID_DID_METHOD.md'),
  read('apps/web/app/docs/page.tsx'),
  read('apps/web/app/docs/architecture/page.tsx'),
  read('apps/web/app/docs/networks/page.tsx'),
  read('apps/web/app/docs/compute/page.tsx'),
  read('apps/web/app/docs/verifier/page.tsx'),
  read('docs/USER_GUIDE.md'),
  read('docs/DEPLOYMENT.md'),
]);

const frontendBuiltinNames = new Set(extractBuiltinNames(docsDataText));
const workerBuiltinNames = new Set(extractBuiltinNames(workerComputeText));

// Guard against extractor rot: empty sets would make the missing/extra
// comparison below pass vacuously, exactly the failure mode that previously
// hid behind a quote-style mismatch.
assert(
  frontendBuiltinNames.size > 0,
  'failed to parse frontend builtin names from apps/web/lib/docs-data.ts'
);
assert(
  workerBuiltinNames.size > 0,
  'failed to parse worker builtin names from workers/nitro-worker/src/compute/index.js'
);

const missingBuiltinNames = [...workerBuiltinNames].filter(
  (name) => !frontendBuiltinNames.has(name)
);
const extraBuiltinNames = [...frontendBuiltinNames].filter((name) => !workerBuiltinNames.has(name));

assert(
  missingBuiltinNames.length === 0,
  `frontend docs are missing builtins: ${missingBuiltinNames.join(', ')}`
);
assert(
  extraBuiltinNames.length === 0,
  `frontend docs contain unknown builtins: ${extraBuiltinNames.join(', ')}`
);

const frontendFeedSymbols = extractFrontendFeedSymbols(feedDefaultsText);
const workerFeedPairs = extractFeedRegistryPairs(workerFeedRegistryText);

assert(frontendFeedSymbols.length > 0, 'failed to parse frontend default feed symbols');
assert(workerFeedPairs.length > 0, 'failed to parse worker feed registry pairs');
assert(
  JSON.stringify(frontendFeedSymbols.map(normalizeFeedSymbolForComparison)) ===
    JSON.stringify(workerFeedPairs.map(normalizeFeedSymbolForComparison)),
  `frontend feed symbols do not match worker feed registry.\nfrontend=${frontendFeedSymbols.join(',')}\nworker=${workerFeedPairs.join(',')}`
);

const mainnetConfig = JSON.parse(mainnetConfigText);
const testnetConfig = JSON.parse(testnetConfigText);

assert(
  networksLibText.includes('import testnet') && networksLibText.includes('import mainnet'),
  'apps/web/lib/networks.ts must import both testnet and mainnet registries'
);
assert(
  onchainDataText.includes('getSelectedNetwork') &&
    onchainDataText.includes('selectedNetwork.neo_n3?.contracts?.morpheus_oracle'),
  'apps/web/lib/onchain-data.ts must resolve contracts from the selected network registry'
);
assert(
  onchainDataText.includes('selectedNetwork.neo_n3?.examples?.oracle_callback_consumer'),
  'apps/web/lib/onchain-data.ts must expose the selected-network example consumer'
);
assert(
  onchainDataText.includes('selectedNetwork.nitro?.public_api_url'),
  'apps/web/lib/onchain-data.ts must expose the selected-network Nitro endpoint'
);

assert(
  onchainDataText.includes('DEFAULT_FEED_SYMBOLS'),
  'apps/web/lib/onchain-data.ts should source default pairs from apps/web/lib/feed-defaults.ts'
);

const forbiddenFragments = [
  'morpheus.network/api/oracle/public-key',
  'Type of request ("provider", "url", "builtin")',
  'GetLatestPrice(',
  'Trigger feed publication',
];

const combinedWebDocsText = [
  oracleDocsText,
  quickstartDocsText,
  apiReferenceDocsText,
  datafeedsDocsText,
  neodidDocsText,
].join('\n');

const liveAddressFragments = [
  mainnetConfig.neo_n3.contracts.morpheus_oracle,
  mainnetConfig.neo_n3.contracts.morpheus_datafeed,
  testnetConfig.neo_n3.contracts.morpheus_oracle,
  testnetConfig.neo_n3.contracts.morpheus_datafeed,
].filter(Boolean);

for (const fragment of forbiddenFragments) {
  assert(
    !combinedWebDocsText.includes(fragment),
    `web docs still contain stale fragment: ${fragment}`
  );
}
for (const fragment of liveAddressFragments) {
  assert(
    !combinedWebDocsText.includes(fragment),
    `web docs should not hardcode live address ${fragment}; use the shared network registry`
  );
}

const requiredNeoDidFragments = [
  'did:morpheus:neo_n3:service:neodid',
  '/api/neodid/resolve',
  '/launchpad/neodid-resolver',
  'NeoDIDRegistry',
];

for (const fragment of requiredNeoDidFragments) {
  assert(
    neodidDocsText.includes(fragment),
    `apps/web/app/docs/neodid/page.tsx is missing required NeoDID fragment: ${fragment}`
  );
}

assert(
  `${docsLayoutText}\n${docsNavigationText}`.includes('/docs/r/NEODID_DID_METHOD'),
  'web docs navigation must link the NeoDID DID method spec'
);
assert(
  neodidDidSpecText.includes('did:morpheus:neo_n3:service:neodid'),
  'docs/NEODID_DID_METHOD.md must include the canonical service DID'
);
assert(
  neodidDidSpecText.includes('GET /api/neodid/resolve?did=<did>'),
  'docs/NEODID_DID_METHOD.md must document the resolver endpoint'
);
assert(
  userGuideText.includes('## 5. NeoDID Usage'),
  'docs/USER_GUIDE.md must include the NeoDID usage section'
);
assert(
  userGuideText.includes('/launchpad/neodid-resolver'),
  'docs/USER_GUIDE.md must reference the NeoDID resolver entrypoint'
);
assert(
  deploymentDocText.includes('NEXT_PUBLIC_WEB3AUTH_CLIENT_ID') &&
    deploymentDocText.includes('WEB3AUTH_CLIENT_SECRET'),
  'docs/DEPLOYMENT.md must document the required Web3Auth deployment variables'
);
assert(
  deploymentDocText.includes('NeoDIDRegistry') &&
    deploymentDocText.includes('nitro.request-hub.toml') &&
    deploymentDocText.includes('nitro.feed-hub.toml'),
  'docs/DEPLOYMENT.md must document NeoDID anchors and both role-split Nitro descriptors'
);
const versionedDocsText = [
  docsIndexText,
  architectureDocsText,
  networksDocsText,
  oracleDocsText,
  computeDocsText,
  datafeedsDocsText,
  verifierDocsText,
  neodidDocsText,
  docsLayoutText,
].join('\n');

assert(
  !versionedDocsText.includes('v1.0.2'),
  'core docs pages still contain stale v1.0.2 version markers'
);
assert(
  !versionedDocsText.includes('v1.0.3') && !versionedDocsText.includes('REVISION 1.0.3'),
  'core docs pages should not expose stale hard-coded v1.0.3 markers'
);
assert(
  versionedDocsText.includes('CURRENT DESIGN'),
  'core docs pages should expose a stable current-design marker'
);

console.log(
  JSON.stringify(
    {
      ok: true,
      builtins_checked: workerBuiltinNames.size,
      feed_pairs_checked: frontendFeedSymbols.length,
      network_registries_checked: 2,
      stale_fragments_checked: forbiddenFragments.length,
      neodid_fragments_checked: requiredNeoDidFragments.length,
      version_markers_checked: 3,
      extended_doc_checks: 5,
    },
    null,
    2
  )
);
