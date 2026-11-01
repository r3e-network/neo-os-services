import { describe, it } from 'node:test';
import assert from 'node:assert';
import { collectPrices, consensus, median } from './price-sources.mjs';

describe('price-sources', () => {
  describe('median', () => {
    it('computes median of odd-length array', () => {
      assert.strictEqual(median([1, 2, 3]), 2);
      assert.strictEqual(median([10, 5, 8]), 8);
    });

    it('computes median of even-length array', () => {
      assert.strictEqual(median([1, 2, 3, 4]), 2.5);
      assert.strictEqual(median([10, 20, 30, 40]), 25);
    });

    it('handles single value', () => {
      assert.strictEqual(median([42]), 42);
    });
  });

  describe('consensus', () => {
    it('rejects empty quotes', () => {
      const result = consensus([]);
      assert.deepStrictEqual(result, { ok: false, reason: 'no_quote' });
    });

    it('accepts single source', () => {
      const result = consensus([{ source: 'binance', price: 100 }]);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.price, 100);
      assert.deepStrictEqual(result.sources, ['binance']);
      assert.strictEqual(result.consensus, 'single');
    });

    it('accepts cross-checked sources within spread', () => {
      const result = consensus([
        { source: 'binance', price: 100 },
        { source: 'okx', price: 100.5 },
      ]);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.consensus, 'cross_checked');
    });

    it('rejects sources exceeding spread', () => {
      const result = consensus([
        { source: 'binance', price: 100 },
        { source: 'okx', price: 102 },
      ]);
      assert.strictEqual(result.ok, false);
      assert.match(result.reason, /spread_\d+bps/);
    });
  });

  describe('collectPrices', () => {
    it('collects prices from multiple sources', async () => {
      const mockFetch = async () => ({
        ok: true,
        json: async () => ({ price: 100 }),
      });

      const result = await collectPrices(['BTC-USD'], { fetchImpl: mockFetch });
      assert.ok(result.prices['BTC-USD'] !== undefined);
      assert.ok(result.detail['BTC-USD'] !== undefined);
    });

    it('handles fetch failures gracefully', async () => {
      const mockFetch = async () => {
        throw new Error('Network error');
      };

      const result = await collectPrices(['BTC-USD'], { fetchImpl: mockFetch });
      assert.strictEqual(result.rejected['BTC-USD'], 'no_source');
    });

    it('handles mixed success and failure', async () => {
      const mockFetch = async (url) => {
        if (url.includes('binance')) {
          return { ok: true, json: async () => ({ price: 100 }) };
        }
        throw new Error('Not found');
      };

      const result = await collectPrices(['BTC-USD', 'ETH-USD'], { fetchImpl: mockFetch });
      assert.strictEqual(
        Object.keys(result.prices).length + Object.keys(result.rejected).length,
        2
      );
    });
  });
});
