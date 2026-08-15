#!/usr/bin/env node

import { buildFeedFreshnessReport } from './lib-feed-freshness.mjs';
import { trimString } from './lib-strings.mjs';
import path from 'node:path';

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
      await buildFeedFreshnessReport({
        repoRoot,
        network,
        staleMinutes: Number.isFinite(args.staleMinutes) ? args.staleMinutes : 720,
      })
    );
  }
  console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
