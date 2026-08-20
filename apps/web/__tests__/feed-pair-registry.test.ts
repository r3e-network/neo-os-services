import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FEED_BASE_SYMBOLS,
  DEFAULT_FEED_SYMBOLS,
  FEED_DESCRIPTORS,
  RETIRED_FEED_PAIRS,
  RETIRED_FEED_SYMBOLS,
  getFeedDescriptor,
  getRetiredFeedPair,
} from '@/lib/feed-defaults';
import { DEFAULT_TRADFI_PAIRS } from '@/lib/feed-freshness';

// The advertised set drives `/api/feeds/status`, so anything listed here is
// counted in the health signal. Advertising a pair the on-chain writer never
// pushes made that signal read "degraded" permanently — which is why nobody
// noticed a 22-day outage hiding inside it. Cross-registry agreement (this list
// vs the pusher's TD_SYMBOLS vs the worker registry) is enforced by
// `scripts/check-feed-pair-registries.mjs`; these tests pin the web side.
describe('advertised feed pair registry', () => {
  it('advertises each pair exactly once', () => {
    expect(new Set(DEFAULT_FEED_BASE_SYMBOLS).size).toBe(DEFAULT_FEED_BASE_SYMBOLS.length);
    expect(DEFAULT_FEED_SYMBOLS.length).toBe(DEFAULT_FEED_BASE_SYMBOLS.length);
  });

  it('has a descriptor with a concrete provider symbol for every advertised pair', () => {
    for (const symbol of DEFAULT_FEED_SYMBOLS) {
      const descriptor = FEED_DESCRIPTORS[symbol];
      expect(descriptor, `${symbol} has no descriptor`).toBeTruthy();
      expect(descriptor.sourceSymbol.length, `${symbol} has an empty sourceSymbol`).toBeGreaterThan(
        0
      );
      expect(descriptor.pair).toBe(symbol);
    }
  });

  it('does not advertise a retired pair', () => {
    for (const pair of Object.keys(RETIRED_FEED_PAIRS)) {
      expect(DEFAULT_FEED_BASE_SYMBOLS as readonly string[]).not.toContain(pair);
      expect(getFeedDescriptor(`TWELVEDATA:${pair}`)).toBeNull();
    }
  });

  it('records why each retired pair was retired and how to reinstate it', () => {
    for (const [pair, entry] of Object.entries(RETIRED_FEED_PAIRS)) {
      expect(entry.pair).toBe(pair);
      // A one-word reason is how "temporarily broken" becomes "permanently stale":
      // the evidence has to survive in the file.
      expect(entry.reason.length, `${pair} needs a real retirement reason`).toBeGreaterThan(40);
      expect(entry.retired_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof entry.reinstate_requires).toBe('string');
    }
  });

  it('resolves retired pairs through the canonical prefix', () => {
    expect(getRetiredFeedPair('TWELVEDATA:COPPER-USD')?.pair).toBe('COPPER-USD');
    expect(getRetiredFeedPair('copper-usd')?.pair).toBe('COPPER-USD');
    expect(getRetiredFeedPair('TWELVEDATA:NEO-USD')).toBeNull();
    expect(RETIRED_FEED_SYMBOLS).toContain('TWELVEDATA:FLM-USD');
  });

  // TwelveData resolved `HG1` to Homag Group AG (a Frankfurt equity in EUR) rather
  // than copper, and `FLM/USD` to FolmCoin rather than Flamingo Finance. Both were
  // publishing the wrong asset under a right-looking name, so both are retired.
  // Re-adding either without fixing the source is a data-integrity regression.
  it('keeps the known wrong-asset mappings retired', () => {
    expect(RETIRED_FEED_PAIRS['COPPER-USD'].reason).toMatch(/Homag/);
    expect(RETIRED_FEED_PAIRS['FLM-USD'].reason).toMatch(/FolmCoin/);
  });

  // A TradFi pair whose market closes gets a widened staleness budget. Widening one
  // for a pair that trades continuously would hide a real crypto outage, so the
  // list must stay a subset of the advertised set and must exclude crypto.
  it('only widens the staleness budget for advertised non-crypto pairs', () => {
    for (const pair of DEFAULT_TRADFI_PAIRS) {
      expect(DEFAULT_FEED_BASE_SYMBOLS as readonly string[]).toContain(pair);
      const descriptor = getFeedDescriptor(`TWELVEDATA:${pair}`);
      expect(descriptor?.category, `${pair} is not a market-hours asset`).not.toBe('Crypto');
    }
  });
});
