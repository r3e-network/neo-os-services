import { appConfig } from '@/lib/config';
import { badRequest } from '@/lib/api-helpers';
import { isKnownNetworkKey } from '@/lib/networks';
import { parseJsonObjectParam } from '@/lib/provider-configs';
import { fetchOnchainState } from '@/lib/onchain-state';
import { toCanonicalFeedSymbol } from '@/lib/feed-defaults';
import { classifyFeedAge, type FeedAgeClassification } from '@/lib/feed-freshness';

// Re-homed (2026-06): the live price comes from the on-chain MorpheusDataFeed (the
// same contract the box updates), read trustlessly via the shared multi-RPC reader,
// instead of proxying the retired runtime. The degraded envelope + the
// x-morpheus-upstream-status header are preserved so existing consumers keep working;
// ?provider / ?provider_params are still accepted (no-ops for an on-chain read).
function feedUnavailableResponse(symbol: string, provider: string | null, upstreamStatus: number) {
  return Response.json(
    {
      status: 'unavailable',
      degraded: true,
      symbol,
      provider: provider || null,
      error: 'feed_quote_unavailable',
      error_code: 'FEED_QUOTE_UNAVAILABLE',
      upstream_status: upstreamStatus,
    },
    {
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'x-morpheus-upstream-status': String(upstreamStatus),
      },
    }
  );
}

// Staleness envelope (added 2026-08). Until now this route had no age check:
// on 2026-08-17 every mainnet pair was 19+ days old and this handler still
// answered `status:"ok"` with `cache-control: public, max-age=15`, so nothing
// downstream could tell a live price from a fortnight-old one.
//
// It deliberately does NOT carry a top-level `price`. A consumer that reads
// `body.price` without checking `body.status` is the failure mode we are
// closing; the stale numbers stay available for diagnostics under
// `stale_record`, where reading them is an explicit act.
function feedStaleResponse(
  symbol: string,
  provider: string | null,
  record: {
    price_units: string;
    price_display: string;
    price_scale_decimals: number;
    round_id: string;
  },
  age: FeedAgeClassification,
  contract: string
) {
  return Response.json(
    {
      status: 'stale',
      degraded: true,
      symbol,
      provider: provider || null,
      source: 'onchain',
      chain: 'neo_n3',
      contract,
      error: 'feed_quote_stale',
      error_code: 'FEED_QUOTE_STALE',
      upstream_status: 503,
      age_seconds: age.age_seconds,
      stale_after_seconds: age.stale_after_seconds,
      market_closed: age.market_closed,
      timestamp: age.timestamp,
      timestamp_iso: age.timestamp_iso,
      stale_record: {
        price: Number(record.price_display),
        price_units: record.price_units,
        price_display: record.price_display,
        price_scale_decimals: record.price_scale_decimals,
        round_id: record.round_id,
      },
    },
    {
      status: 200,
      headers: {
        // Never let a CDN or browser pin a stale quote for another 15 s.
        'cache-control': 'no-store',
        'x-morpheus-upstream-status': '503',
        'x-morpheus-feed-age-seconds': String(age.age_seconds ?? ''),
        'x-morpheus-feed-stale': '1',
      },
    }
  );
}

export async function GET(request: Request, context: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await context.params;
  const url = new URL(request.url);

  const network = url.searchParams.get('network');
  if (network && !isKnownNetworkKey(network)) {
    return badRequest(`unknown network "${network}"; expected "mainnet" or "testnet"`);
  }

  // Preserve the provider_params validation contract (400 INVALID_PROVIDER_PARAMS).
  try {
    parseJsonObjectParam(url.searchParams.get('provider_params'));
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : String(error),
      400,
      'INVALID_PROVIDER_PARAMS'
    );
  }

  const provider = url.searchParams.get('provider') || appConfig.feedProvider || null;
  const canonical = toCanonicalFeedSymbol(symbol).toUpperCase();

  try {
    const state = await fetchOnchainState(200, network);
    if (state?.neo_n3?.error || !state?.neo_n3?.datafeed) {
      return feedUnavailableResponse(symbol, provider, 503);
    }
    const records = state.neo_n3.datafeed.records || [];
    const record = records.find((entry) => trimUpper(entry.pair) === canonical);
    if (!record || Number(record.price_display) <= 0) {
      return feedUnavailableResponse(symbol, provider, 404);
    }

    // Freshness is a serving-path concern, not just a monitoring one: the box
    // monitor can be down, unenabled or unwatched, and the answer this route
    // gives must still be safe on its own.
    const age = classifyFeedAge(record.timestamp, { pair: record.pair });
    if (age.stale) {
      return feedStaleResponse(symbol, provider, record, age, state.neo_n3.datafeed.contract);
    }

    return Response.json(
      {
        status: 'ok',
        symbol,
        provider,
        source: 'onchain',
        chain: 'neo_n3',
        contract: state.neo_n3.datafeed.contract,
        price: Number(record.price_display),
        price_units: record.price_units,
        price_display: record.price_display,
        price_scale_decimals: record.price_scale_decimals,
        round_id: record.round_id,
        timestamp: Number(record.timestamp),
        timestamp_iso: record.timestamp_iso,
        // Published so a consumer can apply its own, tighter budget without a
        // second round trip.
        age_seconds: age.age_seconds,
        stale_after_seconds: age.stale_after_seconds,
        stale: false,
      },
      {
        headers: {
          'cache-control': 'public, max-age=15',
          'x-morpheus-feed-age-seconds': String(age.age_seconds ?? ''),
          'x-morpheus-feed-stale': '0',
        },
      }
    );
  } catch {
    return feedUnavailableResponse(symbol, provider, 503);
  }
}

function trimUpper(value: unknown) {
  return (typeof value === 'string' ? value.trim() : '').toUpperCase();
}
