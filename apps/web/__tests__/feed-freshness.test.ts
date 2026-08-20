import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Regression suite for the 2026-07-29 → 2026-08-17 mainnet feed outage.
//
// The feed itself died because the updater wallet ran out of GAS. What made it
// last 19 days is that nothing in the serving path compared a record's age to
// anything. These tests pin the policy that closes that hole, and — critically —
// pin it AGAINST the box monitor's own budget, so the two can never drift apart
// again without a red test.

const FEED_FRESHNESS = '../lib/feed-freshness';

// Observed live on 2026-08-17: getLatest("TWELVEDATA:BTC-USD") -> ts 1785285991.
const OUTAGE_RECORD_TIMESTAMP = 1785285991;
const OUTAGE_OBSERVED_NOW_MS = 1786938568_000;

// A Wednesday and a Saturday, both UTC, for the TradFi market-closed widening.
const WEEKDAY_MS = Date.UTC(2026, 7, 12, 12, 0, 0); // 2026-08-12, Wed
const WEEKEND_MS = Date.UTC(2026, 7, 15, 12, 0, 0); // 2026-08-15, Sat

const FRESHNESS_ENV = [
  'MORPHEUS_FEED_MAX_STALE_SEC',
  'MORPHEUS_FEED_STALE_AFTER_SEC',
  'MORPHEUS_FEED_TRADFI_PAIRS',
  'MORPHEUS_FEED_TRADFI_WEEKEND_AGE_SEC',
  'MORPHEUS_FEED_TRADFI_HOLIDAYS',
];

describe('feed freshness policy', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    for (const name of FRESHNESS_ENV) vi.stubEnv(name, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to the 2700s budget the repo already documents', async () => {
    const { feedStaleAfterSeconds } = await import(FEED_FRESHNESS);
    expect(feedStaleAfterSeconds()).toBe(2700);
  });

  it('agrees with deploy/feed-pusher/feed-monitor.mjs on every pair and both market states', async () => {
    // If someone retunes one side of this, THIS test is what fails — rather
    // than the public API and the box monitor silently disagreeing about what
    // "stale" means, which is how the outage stayed invisible.
    vi.stubEnv('FEED_MONITOR_SKIP_MAIN', '1');
    const monitor = await import('../../../deploy/feed-pusher/feed-monitor.mjs');
    const { staleAfterSecondsForPair } = await import(FEED_FRESHNESS);

    for (const nowMs of [WEEKDAY_MS, WEEKEND_MS]) {
      const date = new Date(nowMs);
      for (const bare of ['BTC-USD', 'NEO-USD', 'EUR-USD', 'WTI-USD', 'CNY-USD']) {
        expect(staleAfterSecondsForPair(bare, date)).toBe(monitor.staleAgeLimit(bare, date));
        // The chain stores the provider-prefixed pair; the monitor strips it.
        // Both spellings must land on the same budget.
        expect(staleAfterSecondsForPair(`TWELVEDATA:${bare}`, date)).toBe(
          monitor.staleAgeLimit(bare, date)
        );
      }
    }
  });

  it('widens the window for TradFi pairs only while the market is closed', async () => {
    const { staleAfterSecondsForPair } = await import(FEED_FRESHNESS);
    expect(staleAfterSecondsForPair('TWELVEDATA:EUR-USD', new Date(WEEKEND_MS))).toBe(270000);
    expect(staleAfterSecondsForPair('TWELVEDATA:EUR-USD', new Date(WEEKDAY_MS))).toBe(2700);
    // Crypto never widens.
    expect(staleAfterSecondsForPair('TWELVEDATA:BTC-USD', new Date(WEEKEND_MS))).toBe(2700);
  });

  it('flags the exact record that was served as ok for 19 days', async () => {
    const { classifyFeedAge } = await import(FEED_FRESHNESS);
    const age = classifyFeedAge(OUTAGE_RECORD_TIMESTAMP, {
      pair: 'TWELVEDATA:BTC-USD',
      nowMs: OUTAGE_OBSERVED_NOW_MS,
    });

    expect(age.stale).toBe(true);
    expect(age.age_seconds).toBe(1652577);
    expect(age.stale_after_seconds).toBe(2700);
    expect(age.timestamp_iso).toBe('2026-07-29T00:46:31.000Z');
  });

  it('accepts a record inside its budget', async () => {
    const { classifyFeedAge } = await import(FEED_FRESHNESS);
    const nowMs = WEEKDAY_MS;
    const age = classifyFeedAge(Math.floor(nowMs / 1000) - 300, {
      pair: 'TWELVEDATA:BTC-USD',
      nowMs,
    });
    expect(age.stale).toBe(false);
    expect(age.age_seconds).toBe(300);
  });

  it('is stale exactly one second past the budget, fresh exactly at it', async () => {
    const { classifyFeedAge } = await import(FEED_FRESHNESS);
    const nowSec = Math.floor(WEEKDAY_MS / 1000);
    const at = classifyFeedAge(nowSec - 2700, { pair: 'BTC-USD', nowMs: WEEKDAY_MS });
    const past = classifyFeedAge(nowSec - 2701, { pair: 'BTC-USD', nowMs: WEEKDAY_MS });
    expect(at.stale).toBe(false);
    expect(past.stale).toBe(true);
  });

  it('fails closed on an unusable or future timestamp', async () => {
    const { classifyFeedAge } = await import(FEED_FRESHNESS);
    for (const value of [0, -1, 'abc', null, undefined, NaN]) {
      const age = classifyFeedAge(value, { pair: 'BTC-USD', nowMs: WEEKDAY_MS });
      expect(age.stale).toBe(true);
      expect(age.age_seconds).toBeNull();
    }
    // A future-dated record is a clock/pusher fault, not freshness.
    const future = classifyFeedAge(Math.floor(WEEKDAY_MS / 1000) + 600, {
      pair: 'BTC-USD',
      nowMs: WEEKDAY_MS,
    });
    expect(future.stale).toBe(true);
  });

  it('honours an operator override of the budget', async () => {
    vi.stubEnv('MORPHEUS_FEED_STALE_AFTER_SEC', '60');
    const { classifyFeedAge, feedStaleAfterSeconds } = await import(FEED_FRESHNESS);
    expect(feedStaleAfterSeconds()).toBe(60);
    expect(
      classifyFeedAge(Math.floor(WEEKDAY_MS / 1000) - 120, { pair: 'BTC-USD', nowMs: WEEKDAY_MS })
        .stale
    ).toBe(true);
  });

  it('ignores a non-positive or unparseable override rather than disabling the check', async () => {
    for (const bad of ['0', '-5', 'soon', '']) {
      vi.resetModules();
      vi.stubEnv('MORPHEUS_FEED_STALE_AFTER_SEC', bad);
      const { feedStaleAfterSeconds } = await import(FEED_FRESHNESS);
      expect(feedStaleAfterSeconds()).toBe(2700);
    }
  });
});
