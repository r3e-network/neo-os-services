#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  buildFeedRegistryDriftReport,
  summarizeFeedRegistryDrift,
} from './lib-feed-registry-drift.mjs';
import { trimString } from './lib-strings.mjs';

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {
    network: 'all',
    staleMinutes: 720,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--network') {
      parsed.network = trimString(argv[index + 1] || parsed.network).toLowerCase();
      index += 1;
    } else if (current === '--stale-minutes') {
      parsed.staleMinutes = Number(argv[index + 1] || parsed.staleMinutes);
      index += 1;
    }
  }
  return parsed;
}

async function main() {
  const args = parseArgs();
  const repoRoot = path.resolve(process.cwd());
  const networks =
    args.network === 'all'
      ? ['mainnet', 'testnet']
      : [args.network === 'mainnet' ? 'mainnet' : 'testnet'];
  const reports = [];
  for (const network of networks) {
    reports.push(
      await buildFeedRegistryDriftReport({
        repoRoot,
        network,
        staleMinutes: Number.isFinite(args.staleMinutes) ? args.staleMinutes : 720,
      })
    );
  }
  const summary = summarizeFeedRegistryDrift(reports);
  const reportPath = path.resolve(
    repoRoot,
    process.env.FEED_REGISTRY_DRIFT_REPORT_PATH || 'docs/reports/feed-registry-drift-latest.json'
  );
  const persisted = {
    generated_at: new Date().toISOString(),
    read_only: true,
    chain_writes_performed: false,
    summary: {
      ...summary,
      reports: undefined,
    },
    reports: summary.reports,
  };
  delete persisted.summary.reports;
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
  console.error(`[feed-registry-drift] report: ${path.relative(repoRoot, reportPath)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
