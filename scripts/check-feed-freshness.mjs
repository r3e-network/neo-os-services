import { buildFeedFreshnessReport } from './lib-feed-freshness.mjs';
import { trimString } from './lib-strings.mjs';

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {
    network: trimString(process.env.MORPHEUS_NETWORK || 'testnet') || 'testnet',
    staleMinutes: 180,
    failOnStale: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--network') {
      parsed.network = trimString(argv[index + 1] || parsed.network) || parsed.network;
      index += 1;
      continue;
    }
    if (current === '--stale-minutes') {
      const value = Number(argv[index + 1] || parsed.staleMinutes);
      if (Number.isFinite(value) && value > 0) parsed.staleMinutes = value;
      index += 1;
      continue;
    }
    if (current === '--fail-on-stale') {
      parsed.failOnStale = true;
    }
  }

  return parsed;
}

const args = parseArgs();
const repoRoot = process.cwd();

const report = await buildFeedFreshnessReport({
  repoRoot,
  network: args.network,
  staleMinutes: args.staleMinutes,
});

const summary = {
  network: report.network,
  total: report.total,
  fresh: report.fresh,
  stale: report.stale,
  actionable_stale: report.actionable_stale,
  benign_stale: report.benign_stale,
  stale_minutes: report.stale_minutes,
  stale_by_cadence: report.stale_pairs.reduce((acc, row) => {
    const key = row.cadence || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {}),
  stale_by_reason: report.stale_pairs.reduce((acc, row) => {
    const key = row.stale_reason || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {}),
  sample_pairs: report.rows
    .filter((row) =>
      ['TWELVEDATA:NEO-USD', 'TWELVEDATA:GAS-USD', 'TWELVEDATA:BTC-USD'].includes(row.pair)
    )
    .map((row) => ({
      pair: row.pair,
      round_id: row.round_id,
      iso: row.iso,
      age_min: row.age_min,
      cadence: row.cadence,
      threshold_min: row.threshold_min,
      stale: row.stale,
    })),
  stale_pairs: report.stale_pairs.map((row) => ({
    pair: row.pair,
    iso: row.iso,
    age_min: row.age_min,
    cadence: row.cadence,
    threshold_min: row.threshold_min,
    stale_reason: row.stale_reason,
    actionable: row.actionable,
  })),
};

console.log(JSON.stringify(summary, null, 2));

if (args.failOnStale && report.actionable_stale > 0) {
  process.exitCode = 1;
}
