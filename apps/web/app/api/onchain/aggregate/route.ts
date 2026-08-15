import { z } from 'zod';

import { isKnownNetworkKey } from '@/lib/networks';
import { fetchOnchainState } from '@/lib/onchain-state';
import { buildRuntimeStatusSnapshotForNetwork } from '@/lib/runtime-status';
import { toCanonicalFeedSymbol } from '@/lib/feed-defaults';
import { DEFAULT_PAIRS } from '@/lib/onchain-data';
import { BUILTIN_PROVIDER_CATALOG } from '@/lib/provider-catalog';
import { getDashboardNetworkConfig } from '@/components/dashboard/networkSelection';
import type { OnchainRecord } from '@/lib/dashboard-types';

/**
 * Input validation schema for the dashboard aggregate endpoint.
 *
 * - network: optional mainnet/testnet selector
 * - pairs: optional comma-separated list of feed symbols
 * - limit: optional on-chain record limit (1-200, default 50)
 */
const aggregateQuerySchema = z.object({
  network: z
    .string()
    .transform((value) => value.trim())
    .optional(),
  pairs: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((symbol) => toCanonicalFeedSymbol(symbol))
        .filter(Boolean)
    )
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function normalizePairKey(symbol: string): string {
  return toCanonicalFeedSymbol(symbol).toUpperCase();
}

function buildQuoteMap(
  onchainState: Awaited<ReturnType<typeof fetchOnchainState>>,
  requestedPairs: string[]
): Record<string, unknown> {
  const records = onchainState?.neo_n3?.datafeed?.records || [];
  const recordByPair = new Map<string, OnchainRecord>();
  for (const record of records) {
    const key = normalizePairKey(record.pair);
    if (!recordByPair.has(key)) {
      recordByPair.set(key, record as OnchainRecord);
    }
  }

  const quotes: Record<string, unknown> = {};
  for (const pair of requestedPairs) {
    const key = normalizePairKey(pair);
    const record = recordByPair.get(key);
    if (record && Number(record.price_display) > 0) {
      quotes[key] = {
        pair: key,
        status: 'ok',
        source: 'onchain',
        chain: 'neo_n3',
        price: Number(record.price_display),
        price_units: record.price_units,
        price_display: record.price_display,
        timestamp: Number(record.timestamp),
        timestamp_iso: record.timestamp_iso,
      };
    } else {
      quotes[key] = {
        pair: key,
        status: 'unavailable',
        source: 'onchain',
        price: null,
      };
    }
  }
  return quotes;
}

function generateRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Aggregate dashboard data into a single read-only response.
 *
 * Combines on-chain state, runtime status, batched on-chain quotes, the static
 * provider catalog, and the selected network configuration. Short-lived cache
 * headers let Vercel/Next.js collapse concurrent dashboard polls while keeping
 * data fresh enough for monitoring.
 */
export async function GET(request: Request) {
  const requestId = generateRequestId();
  const url = new URL(request.url);

  const parseResult = aggregateQuerySchema.safeParse({
    network: url.searchParams.get('network') ?? undefined,
    pairs: url.searchParams.get('pairs') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });

  if (!parseResult.success) {
    const issues = parseResult.error.issues.map((issue) => ({
      path: issue.path,
      message: issue.message,
    }));
    return Response.json(
      { error: 'Invalid query parameters', issues },
      {
        status: 400,
        headers: {
          'x-request-id': requestId,
          'cache-control': 'no-store',
        },
      }
    );
  }

  const { network, pairs, limit } = parseResult.data;

  if (network && !isKnownNetworkKey(network)) {
    return Response.json(
      { error: `unknown network "${network}"; expected "mainnet" or "testnet"` },
      {
        status: 400,
        headers: {
          'x-request-id': requestId,
          'cache-control': 'no-store',
        },
      }
    );
  }

  const requestedPairs = pairs && pairs.length > 0 ? pairs : DEFAULT_PAIRS;

  try {
    const [onchainState, runtimeStatus, providers, networkConfig] = await Promise.all([
      fetchOnchainState(limit, network),
      buildRuntimeStatusSnapshotForNetwork(network),
      Promise.resolve(BUILTIN_PROVIDER_CATALOG),
      Promise.resolve(getDashboardNetworkConfig(network)),
    ]);

    const quotes = buildQuoteMap(onchainState, requestedPairs);

    const body = {
      onchainState,
      runtimeStatus,
      quotes,
      providers,
      networkConfig,
      generated_at: new Date().toISOString(),
    };

    return Response.json(body, {
      status: 200,
      headers: {
        'cache-control': 'public, s-maxage=5, stale-while-revalidate=10',
        'x-request-id': requestId,
      },
    });
  } catch {
    return Response.json(
      { error: 'Failed to aggregate dashboard data' },
      {
        status: 500,
        headers: {
          'x-request-id': requestId,
          'cache-control': 'no-store',
        },
      }
    );
  }
}
