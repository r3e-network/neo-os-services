import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { median, trimmedMean, aggregateQuotes } from './aggregation.js';

describe('median', () => {
  it('returns single value unchanged', () => {
    assert.equal(median([42]), 42);
  });

  it('returns average of two middle values for even-length array', () => {
    assert.equal(median([1, 3]), 2);
  });

  it('returns middle value for odd-length array', () => {
    assert.equal(median([1, 5, 9]), 5);
  });

  it('sorts unsorted input', () => {
    assert.equal(median([9, 1, 5]), 5);
  });

  it('throws on empty array', () => {
    assert.throws(() => median([]), /at least one value/);
  });
});

describe('trimmedMean', () => {
  it('returns median when trim removes everything', () => {
    // 2 values, trimPct 0.5 → trimCount = 1, 1*2 >= 2 → fallback to median
    const result = trimmedMean([10, 20], 0.5);
    assert.equal(result, 15);
  });

  it('trims extremes from larger arrays', () => {
    // [1, 2, 3, 4, 100] with trimPct 0.2 → trimCount=1 → [2, 3, 4]
    const result = trimmedMean([1, 2, 3, 4, 100], 0.2);
    assert.equal(result, 3); // (2+3+4)/3
  });

  it('throws on empty array', () => {
    assert.throws(() => trimmedMean([]), /at least one value/);
  });
});

describe('aggregateQuotes', () => {
  const baseQuote = (provider, price) => ({ provider, price, timestamp: Date.now() });

  it('returns single-source for one quote', () => {
    const result = aggregateQuotes([baseQuote('a', 100)]);
    assert.equal(result.price, 100);
    assert.equal(result.confidence, 'single-source');
    assert.deepEqual(result.providers_used, ['a']);
  });

  it('returns mean for two agreeing quotes', () => {
    const result = aggregateQuotes([baseQuote('a', 100), baseQuote('b', 102)]);
    assert.equal(result.price, 101);
    assert.equal(result.confidence, 'medium');
    assert.equal(result.method, 'mean');
  });

  it('rejects divergent two-source quotes', () => {
    const result = aggregateQuotes([baseQuote('a', 100), baseQuote('b', 200)], {
      maxDeviationPct: 25,
    });
    assert.equal(result.confidence, 'low');
    assert.equal(result.providers_rejected.length, 1);
  });

  it('returns median for 3+ agreeing quotes', () => {
    const result = aggregateQuotes([baseQuote('a', 100), baseQuote('b', 101), baseQuote('c', 102)]);
    assert.equal(result.price, 101);
    assert.equal(result.confidence, 'high');
    assert.equal(result.method, 'median');
  });

  it('rejects outlier quotes above maxDeviationPct', () => {
    const result = aggregateQuotes(
      [baseQuote('a', 100), baseQuote('b', 101), baseQuote('c', 102), baseQuote('outlier', 500)],
      { maxDeviationPct: 25 }
    );
    assert.ok(result.providers_rejected.includes('outlier'));
    assert.ok(!result.providers_used.includes('outlier'));
    assert.equal(result.confidence, 'high');
  });

  it('falls back to median when all quotes are rejected', () => {
    const result = aggregateQuotes([baseQuote('a', 1), baseQuote('b', 1000)], {
      maxDeviationPct: 10,
      minProviders: 1,
    });
    // With only 2 quotes diverging > 10%, returns lower
    assert.equal(result.confidence, 'low');
  });

  it('supports trimmed-mean method', () => {
    const result = aggregateQuotes(
      [
        baseQuote('a', 100),
        baseQuote('b', 101),
        baseQuote('c', 102),
        baseQuote('d', 103),
        baseQuote('e', 104),
      ],
      { method: 'trimmed-mean' }
    );
    assert.equal(result.method, 'trimmed-mean');
    assert.ok(result.price > 0);
  });

  it('throws on empty quotes', () => {
    assert.throws(() => aggregateQuotes([]), /at least one quote/);
  });

  it('throws when below minProviders', () => {
    assert.throws(
      () => aggregateQuotes([baseQuote('a', 100)], { minProviders: 2 }),
      /minimum 2 required/
    );
  });

  it('filters out non-finite prices', () => {
    const result = aggregateQuotes([
      baseQuote('a', 100),
      { provider: 'b', price: NaN, timestamp: Date.now() },
    ]);
    assert.equal(result.providers_used.length, 1);
    assert.equal(result.confidence, 'single-source');
  });

  it('median-fallback when all rejected from 3+ sources', () => {
    // 4 prices: median of [1,2,98,99] = (2+98)/2 = 50; all deviate >96% → all rejected
    const result = aggregateQuotes(
      [baseQuote('a', 1), baseQuote('b', 2), baseQuote('c', 98), baseQuote('d', 99)],
      { maxDeviationPct: 0.1 }
    );
    assert.equal(result.method, 'median-fallback');
    assert.equal(result.price, 50); // median of [1, 2, 98, 99]
  });
});
