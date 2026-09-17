// Type surface for the pure helpers feed-monitor.mjs exports.
//
// feed-monitor.mjs is plain Node ESM deployed verbatim to the oracle box and is
// deliberately not part of any TS build. This declaration exists so the web
// app's freshness suite can import `staleAgeLimit` and assert that the served
// API and the box monitor agree on the staleness budget
// (apps/web/__tests__/feed-freshness.test.ts). Keep it in sync with the
// module's `export function` list.

export type FeedMonitorRow = { pair: string; ts: number; age: number; clock_skew: boolean };

export type FeedMonitorDecode = {
  ok: boolean;
  reason: string | null;
  rows: FeedMonitorRow[];
  record_count: number;
  decoded_count: number;
  undecodable_count: number;
};

export function parseAllRecords(result: unknown, now: number): FeedMonitorDecode;

export function isMarketClosed(date: Date, options?: { tradfiHolidays?: Set<string> }): boolean;

export function staleAgeLimit(
  pair: string,
  date: Date,
  options?: {
    maxAge?: number;
    tradfiPairs?: Set<string>;
    tradfiWeekendAge?: number;
    tradfiHolidays?: Set<string>;
  }
): number;

export function renderPromText(rows: FeedMonitorRow[], gas: number, network?: string): string;
