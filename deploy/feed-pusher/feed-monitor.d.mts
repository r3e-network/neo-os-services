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

// Runway, alert levels and provider failure (CU-11).
export const OBSERVED_FEE_PER_WRITE_GAS: number;
export const BURN_WINDOW_SEC: number;
export const BURN_MIN_SPAN_SEC: number;
export const BALANCE_SAMPLE_RETENTION_SEC: number;
export const MAX_BALANCE_SAMPLES: number;

export type AlertLevel = 'ok' | 'warning' | 'high' | 'critical';
export const ALERT_LEVELS: readonly AlertLevel[];
export const RUNWAY_ALERT_DAYS: {
  readonly warning: number;
  readonly high: number;
  readonly critical: number;
};

export function maxAlertLevel(levels?: readonly unknown[]): AlertLevel;
export function runwayAlertLevel(runwayDays: number | null | undefined): AlertLevel;

export type BalanceSample = { t: number; gas: number };

export function appendBalanceSample(
  samples: readonly BalanceSample[] | undefined,
  sample: unknown,
  options?: { retentionSec?: number; maxSamples?: number }
): BalanceSample[];

export function parseBalanceHistory(
  raw: unknown,
  target?: { network?: string; updater?: string }
): BalanceSample[];

export type BurnRate = {
  burn_gas_per_day: number | null;
  span_sec: number;
  consumed_gas: number;
  intervals: number;
};

export function computeBurnRate(
  samples: readonly BalanceSample[] | undefined,
  options?: { windowSec?: number; minSpanSec?: number }
): BurnRate;

export type RunwayBasis =
  | 'balance_below_write_fee'
  | 'insufficient_history'
  | 'no_burn_observed'
  | 'observed_burn';

export type RunwayAssessment = {
  balance_gas: number;
  write_fee_gas: number;
  burn_gas_per_day: number | null;
  writes_per_day: number | null;
  burn_window_hours: number | null;
  balance_samples: number;
  runway_days: number | null;
  runway_basis: RunwayBasis;
  alert_level: AlertLevel;
};

export function assessRunway(options: {
  balanceGas: number;
  samples?: readonly BalanceSample[];
  feePerWriteGas?: number;
  windowSec?: number;
  minSpanSec?: number;
}): RunwayAssessment;

export function lastWriteAge(
  rows: readonly { pair: string; age: number; clock_skew?: boolean }[]
): number | null;

export type ProviderFailureClass = { category: string; kind: string; page: boolean };

export type ProviderFailureReport = ProviderFailureClass & {
  reported_at: string;
  age_seconds: number;
  summary: string;
};

export function classifyProviderFailure(category: unknown): ProviderFailureClass | null;

export function assessProviderFailure(
  status: unknown,
  options?: { nowMs?: number; maxAgeSec?: number }
): ProviderFailureReport | null;
