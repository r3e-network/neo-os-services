#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfiguredFeedPairs } from './lib-feed-freshness.mjs';
import { parseDotEnv } from './lib-env.mjs';
import { trimString } from './lib-strings.mjs';
import {
  readReviewedNetworkRegistrySync,
  resolveReviewedNeoN3Magic,
} from './lib-network-registry.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

export function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {
    network: 'mainnet',
    envFile: '',
    symbols: [],
    batchSize: 5,
    retries: 3,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--network') {
      parsed.network = trimString(argv[index + 1] || parsed.network).toLowerCase();
      index += 1;
    } else if (current === '--env-file') {
      parsed.envFile = trimString(argv[index + 1] || '');
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

export function resolveBackfillNetwork(value) {
  const network = trimString(value).toLowerCase();
  if (network !== 'mainnet' && network !== 'testnet') {
    throw new Error(`--network must be mainnet or testnet, got ${value || '(empty)'}`);
  }
  return network;
}

export function resolveBackfillEnvPath(args, cwd = process.cwd()) {
  if (trimString(args?.envFile)) return path.resolve(cwd, args.envFile);
  const network = resolveBackfillNetwork(args?.network);
  return path.resolve(cwd, 'deploy', 'nitro', `morpheus.${network}.env`);
}

export function assertBackfillNetworkEnv(network, env) {
  const declared = trimString(env?.MORPHEUS_NETWORK).toLowerCase();
  if (declared && declared !== network) {
    throw new Error(`env MORPHEUS_NETWORK=${declared} does not match --network ${network}`);
  }
  const registry = readReviewedNetworkRegistrySync(REPO_ROOT, network);
  const expectedMagic = resolveReviewedNeoN3Magic(registry, network);
  const configuredMagic = trimString(env?.NEO_NETWORK_MAGIC);
  if (configuredMagic && configuredMagic !== expectedMagic) {
    throw new Error(
      `env NEO_NETWORK_MAGIC=${configuredMagic} does not match ${network} (${expectedMagic})`
    );
  }
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
  const network = resolveBackfillNetwork(args.network);
  const envPath = resolveBackfillEnvPath(args);
  const env = parseDotEnv(await fs.readFile(envPath, 'utf8'));
  assertBackfillNetworkEnv(network, env);
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

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
