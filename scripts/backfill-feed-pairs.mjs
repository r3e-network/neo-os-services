#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseConfiguredFeedPairs } from './lib-feed-freshness.mjs';
import { parseDotEnv } from './lib-env.mjs';
import { trimString } from './lib-strings.mjs';

function installDefaultFetchTimeout(timeoutMs = 20_000) {
  if (typeof globalThis.fetch !== 'function') return;
  if (globalThis.fetch.__morpheusTimeoutWrapped) return;
  const originalFetch = globalThis.fetch;
  const wrapped = async (input, init = {}) => {
    if (init?.signal) return originalFetch(input, init);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('fetch timed out')), timeoutMs);
    try {
      return await originalFetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  wrapped.__morpheusTimeoutWrapped = true;
  globalThis.fetch = wrapped;
}

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {
    network: 'mainnet',
    symbols: [],
    batchSize: 5,
    retries: 3,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--network') {
      parsed.network = trimString(argv[index + 1] || parsed.network).toLowerCase();
      index += 1;
    } else if (current === '--symbols') {
      parsed.symbols = String(argv[index + 1] || '')
        .split(',')
        .map((entry) => trimString(entry))
        .filter(Boolean);
      index += 1;
    } else if (current === '--batch-size') {
      parsed.batchSize = Number(argv[index + 1] || parsed.batchSize);
      index += 1;
    } else if (current === '--retries') {
      parsed.retries = Number(argv[index + 1] || parsed.retries);
      index += 1;
    }
  }
  return parsed;
}

function chunk(values, size) {
  const out = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const network = args.network === 'testnet' ? 'testnet' : 'mainnet';
  const envPath = path.resolve('deploy', 'nitro', `morpheus.${network}.env`);
  const env = parseDotEnv(await fs.readFile(envPath, 'utf8'));
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }

  installDefaultFetchTimeout();

  const runtimeConfig = JSON.parse(trimString(env.MORPHEUS_RUNTIME_CONFIG_JSON || '{}'));
  const configuredPairs = parseConfiguredFeedPairs(runtimeConfig);
  const targetPairs =
    args.symbols.length > 0
      ? args.symbols.map((entry) => (entry.includes(':') ? entry : `TWELVEDATA:${entry}`))
      : configuredPairs;

  const { handleOracleFeed } = await import('../workers/nitro-worker/src/oracle/feeds.js');

  const results = [];
  for (const symbols of chunk(targetPairs, Math.max(Number(args.batchSize) || 5, 1))) {
    let attempts = 0;
    while (attempts < Math.max(Number(args.retries) || 3, 1)) {
      attempts += 1;
      try {
        const response = await handleOracleFeed({
          network,
          target_chain: 'neo_n3',
          provider: 'twelvedata',
          symbols,
          refresh_onchain_baseline: true,
          force: true,
          wait: true,
        });
        const body = JSON.parse(await response.text());
        const txHashes = [];
        if (body?.batch_tx?.tx_hash) txHashes.push(body.batch_tx.tx_hash);
        if (Array.isArray(body?.batch_tx?.txs)) {
          for (const entry of body.batch_tx.txs) {
            const hash = entry?.tx?.tx_hash || entry?.tx_hash || null;
            if (hash) txHashes.push(hash);
          }
        }
        results.push({
          symbols,
          attempts,
          batch_submitted: body.batch_submitted,
          batch_count: body.batch_count,
          tx_hash: txHashes[0] || null,
          tx_hashes: txHashes,
          submitted: (body.sync_results || [])
            .filter((entry) => entry.relay_status === 'submitted')
            .map((entry) => entry.storage_pair),
          skipped: (body.sync_results || [])
            .filter((entry) => entry.relay_status === 'skipped')
            .map((entry) => ({
              pair: entry.storage_pair,
              reason: entry.skip_reason,
              change_bps: entry.change_bps,
            })),
          errors: body.errors || [],
        });
        break;
      } catch (error) {
        if (attempts >= Math.max(Number(args.retries) || 3, 1)) {
          results.push({
            symbols,
            attempts,
            error: error instanceof Error ? error.message : String(error),
          });
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  console.log(JSON.stringify({ network, total_symbols: targetPairs.length, results }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
