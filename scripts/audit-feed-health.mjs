#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildFeedHealthReport,
  parseFeedHealthArgs,
  summarizeFeedHealthReports,
} from './lib-feed-health.mjs';

export async function runFeedHealthAudit(
  argv = [],
  {
    cwd = process.cwd(),
    buildReport = buildFeedHealthReport,
    writeStdout = (line) => console.log(line),
    writeStderr = (line) => console.error(line),
  } = {}
) {
  const args = parseFeedHealthArgs(argv);
  const repoRoot = path.resolve(cwd);
  const networks = args.network === 'all' ? ['mainnet', 'testnet'] : [args.network];
  const reports = [];
  for (const network of networks) {
    reports.push(
      await buildReport({
        repoRoot,
        network,
        staleHours: args.staleHours,
        skipAws: args.skipAws,
      })
    );
  }
  const summary = summarizeFeedHealthReports(reports);
  const payload = {
    generated_at: new Date().toISOString(),
    read_only: true,
    chain_writes_performed: false,
    slo_hours: args.staleHours,
    summary,
    reports,
  };
  writeStdout(JSON.stringify(payload, null, 2));
  if (!args.json) {
    for (const report of reports) {
      writeStderr(report.headline);
      for (const cause of report.root_causes || []) {
        writeStderr(`  ${cause.severity.padEnd(12)} ${cause.code} — ${cause.summary}`);
      }
      for (const cause of report.ruled_out || []) {
        writeStderr(`  ruled_out    ${cause.code} — ${cause.summary}`);
      }
      for (const cause of report.live_blockers || []) {
        writeStderr(`  live_blocker ${cause.code} — ${cause.summary}`);
      }
    }
  }
  return { payload, summary, exit_code: summary.exit_code };
}

async function main() {
  const result = await runFeedHealthAudit(process.argv.slice(2));
  process.exitCode = result.exit_code;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
}
