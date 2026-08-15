import {
  jsonPretty,
  loadExampleEnv,
  markdownJson,
  reportDateStamp,
  repoRoot,
  trimString,
  writeValidationArtifacts,
} from './common.mjs';
import {
  applyFeedProviderDefaults,
  getDefaultFeedSymbols,
  getFeedDisplaySymbol,
  getFeedUnitLabel,
} from '../../workers/nitro-worker/src/oracle/feed-registry.js';
import {
  buildProviderRequest,
  fetchProviderJSON,
  resolveProviderPayload,
} from '../../workers/nitro-worker/src/oracle/providers.js';

function extractQuotePrice(data) {
  return data?.price ?? data?.value ?? data?.close ?? data?.data?.amount ?? null;
}

await loadExampleEnv();

const provider = trimString(process.env.MORPHEUS_FEED_PROVIDER || 'twelvedata') || 'twelvedata';
const configuredSymbols = trimString(process.env.MORPHEUS_FEED_SYMBOLS || '')
  .split(',')
  .map((value) => trimString(value))
  .filter(Boolean);
const symbols = configuredSymbols.length > 0 ? configuredSymbols : getDefaultFeedSymbols();
const results = [];

for (const symbol of symbols) {
  const providerPayload = applyFeedProviderDefaults(symbol, provider, {
    provider,
    symbol,
  });
  const { payload: resolvedPayload } = await resolveProviderPayload(providerPayload, {
    fallbackProviderId: provider,
  });
  const request = buildProviderRequest(resolvedPayload);
  if (!request) {
    results.push({ pair: symbol, ok: false, error: 'provider request could not be built' });
    continue;
  }

  try {
    const response = await fetchProviderJSON(request, 20000);
    if (!response.ok) {
      results.push({
        pair: symbol,
        display_symbol: getFeedDisplaySymbol(symbol),
        unit_label: getFeedUnitLabel(symbol) || null,
        provider,
        provider_symbol: request.pair,
        upstream_symbol: request.url,
        ok: false,
        error: response.provider_error?.message || `HTTP ${response.status}`,
      });
      continue;
    }
    const rawPrice = extractQuotePrice(response.data);
    results.push({
      pair: symbol,
      display_symbol: getFeedDisplaySymbol(symbol),
      unit_label: getFeedUnitLabel(symbol) || null,
      provider,
      provider_pair: request.pair,
      request_url: request.url,
      raw_price: rawPrice === null || rawPrice === undefined ? null : String(rawPrice),
      ok: rawPrice !== null && rawPrice !== undefined && rawPrice !== '',
    });
  } catch (error) {
    results.push({
      pair: symbol,
      display_symbol: getFeedDisplaySymbol(symbol),
      unit_label: getFeedUnitLabel(symbol) || null,
      provider,
      provider_pair: request.pair,
      request_url: request.url,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const generatedAt = new Date().toISOString();
const reportJson = {
  generated_at: generatedAt,
  network: trimString(process.env.MORPHEUS_NETWORK || 'testnet') || 'testnet',
  validation: 'feed-source-mappings',
  provider,
  pair_count: results.length,
  success_count: results.filter((item) => item.ok).length,
  failure_count: results.filter((item) => !item.ok).length,
  results,
};

const markdown = [
  '# Feed Source Validation',
  '',
  `Generated: ${generatedAt}`,
  '',
  '## Summary',
  '',
  `- Provider: \`${provider}\``,
  `- Pairs checked: \`${reportJson.pair_count}\``,
  `- Success count: \`${reportJson.success_count}\``,
  `- Failure count: \`${reportJson.failure_count}\``,
  '',
  '## Result Matrix',
  '',
  '| Pair | Provider Pair | Raw Price | Status |',
  '| --- | --- | --- | --- |',
  ...results.map(
    (item) =>
      `| ${item.pair} | ${item.provider_pair || '-'} | ${item.raw_price || '-'} | ${item.ok ? 'ok' : `fail: ${item.error || 'unknown'}`} |`
  ),
  '',
  '## Detailed Results',
  '',
  ...results.flatMap((item) => [`### ${item.pair}`, '', markdownJson(item), '']),
].join('\n');

const artifacts = await writeValidationArtifacts({
  baseName: 'feed-source-validation',
  network: reportJson.network,
  generatedAt,
  jsonReport: reportJson,
  markdownReport: markdown,
});

process.stdout.write(
  jsonPretty({
    ...reportJson,
    ...artifacts,
  })
);
