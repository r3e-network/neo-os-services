/**
 * Price aggregation engine for multi-source oracle feeds.
 *
 * Provides median, trimmed mean, and deviation-based outlier rejection
 * inspired by Chainlink CRE aggregation pipelines.
 */

export function median(values) {
  if (!values.length) throw new Error('median requires at least one value');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function trimmedMean(values, trimPct = 0.1) {
  if (!values.length) throw new Error('trimmedMean requires at least one value');
  const sorted = [...values].sort((a, b) => a - b);
  const trimCount = Math.floor(sorted.length * trimPct);
  if (trimCount * 2 >= sorted.length) return median(sorted);
  const trimmed = sorted.slice(trimCount, sorted.length - trimCount);
  return trimmed.reduce((sum, v) => sum + v, 0) / trimmed.length;
}

// C2 — the minimum number of independent providers that must contribute to a
// canonical aggregated record before it is anchored. A single-source value is
// exactly the integrity gap the canonical record closes, so it must never be
// written from fewer than two providers.
export const CANONICAL_AGGREGATE_MIN_PROVIDERS = 2;

/**
 * The number of DISTINCT providers that actually contributed to the published
 * price. C2 — deduplicating is essential: a misconfiguration like
 * MORPHEUS_FEED_PROVIDERS="twelvedata,twelvedata" would otherwise produce a
 * providers_used array of length 2 from a SINGLE source, masquerading as a
 * multi-provider aggregate. Counting unique ids closes that masquerade.
 */
export function countDistinctProviders(aggregation) {
  if (!aggregation || typeof aggregation !== 'object') return 0;
  if (!Array.isArray(aggregation.providers_used)) return 0;
  const distinct = new Set();
  for (const provider of aggregation.providers_used) {
    const id = String(provider == null ? '' : provider)
      .trim()
      .toLowerCase();
    if (id) distinct.add(id);
  }
  return distinct.size;
}

/**
 * Whether an aggregation result is backed by at least `minProviders` independent
 * sources. Uses the count of DISTINCT quotes that actually contributed to the
 * published price (providers_used), so neither a divergent two-source result that
 * collapses to a single survivor NOR a duplicated provider id qualifies as a
 * multi-provider aggregate.
 */
export function meetsMinProviders(aggregation, minProviders = CANONICAL_AGGREGATE_MIN_PROVIDERS) {
  if (!aggregation || typeof aggregation !== 'object') return false;
  return countDistinctProviders(aggregation) >= minProviders;
}

export function aggregateQuotes(
  quotes,
  { method = 'median', maxDeviationPct = 25, minProviders = 1 } = {}
) {
  if (!Array.isArray(quotes) || quotes.length === 0) {
    throw new Error('aggregateQuotes requires at least one quote');
  }

  const validQuotes = quotes.filter(
    (q) => q.price !== null && q.price !== undefined && Number.isFinite(Number(q.price))
  );

  if (validQuotes.length === 0) {
    throw new Error('no valid quotes to aggregate');
  }

  if (validQuotes.length < minProviders) {
    throw new Error(
      `only ${validQuotes.length} providers available, minimum ${minProviders} required`
    );
  }

  const prices = validQuotes.map((q) => Number(q.price));

  // Single source — return as-is
  if (prices.length === 1) {
    return {
      price: prices[0],
      method: 'single-source',
      providers_used: [validQuotes[0].provider],
      providers_rejected: [],
      deviation_pct: 0,
      confidence: 'single-source',
    };
  }

  // Two sources — average with deviation check
  if (prices.length === 2) {
    const avg = (prices[0] + prices[1]) / 2;
    const deviation = (Math.abs(prices[0] - prices[1]) / avg) * 100;
    if (deviation > maxDeviationPct) {
      // Can't determine which is the outlier with 2 sources — return the lower-priced one
      const idx = prices[0] <= prices[1] ? 0 : 1;
      return {
        price: prices[idx],
        method: 'two-source-divergent',
        providers_used: [validQuotes[idx].provider],
        providers_rejected: validQuotes.filter((_, i) => i !== idx).map((q) => q.provider),
        deviation_pct: Math.round(deviation * 100) / 100,
        confidence: 'low',
      };
    }
    return {
      price: avg,
      method: 'mean',
      providers_used: validQuotes.map((q) => q.provider),
      providers_rejected: [],
      deviation_pct: Math.round(deviation * 100) / 100,
      confidence: 'medium',
    };
  }

  // 3+ sources — median with outlier rejection
  const med = median(prices);
  const rejected = [];
  const kept = [];

  for (let i = 0; i < prices.length; i++) {
    const deviation = med > 0 ? (Math.abs(prices[i] - med) / med) * 100 : 0;
    if (deviation > maxDeviationPct) {
      rejected.push(validQuotes[i]);
    } else {
      kept.push(validQuotes[i]);
    }
  }

  // If all rejected, fall back to median of all
  if (kept.length === 0) {
    return {
      price: med,
      method: 'median-fallback',
      providers_used: validQuotes.map((q) => q.provider),
      providers_rejected: [],
      deviation_pct: 0,
      confidence: 'low',
    };
  }

  const keptPrices = kept.map((q) => Number(q.price));
  const aggregatedPrice = method === 'trimmed-mean' ? trimmedMean(keptPrices) : median(keptPrices);

  // Compute deviation among kept quotes
  const keptMed = median(keptPrices);
  const maxDeviation = keptPrices.reduce((max, p) => {
    const dev = keptMed > 0 ? (Math.abs(p - keptMed) / keptMed) * 100 : 0;
    return Math.max(max, dev);
  }, 0);

  let confidence;
  if (kept.length >= 3) confidence = 'high';
  else if (kept.length === 2) confidence = 'medium';
  else confidence = 'low';

  return {
    price: aggregatedPrice,
    method: method === 'trimmed-mean' ? 'trimmed-mean' : 'median',
    providers_used: kept.map((q) => q.provider),
    providers_rejected: rejected.map((q) => q.provider),
    deviation_pct: Math.round(maxDeviation * 100) / 100,
    confidence,
  };
}
