#!/usr/bin/env node

import { trimString } from './lib-strings.mjs';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { loadDotEnv, parseDotEnv } from './lib-env.mjs';

function parseArgs(argv = []) {
  const out = {
    preset: 'oracle_query',
    levels: [1, 2, 4, 8, 16],
    stageDurationMs: 10000,
    cooldownMs: 2000,
    successThreshold: 0.99,
    p95ThresholdMs: 2000,
    targetUrl: '',
    network: '',
    outputDir: path.resolve('docs', 'reports'),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--preset' && next) out.preset = next;
    else if (arg.startsWith('--preset=')) out.preset = arg.slice('--preset='.length);
    else if (arg === '--levels' && next)
      out.levels = next
        .split(',')
        .map((v) => Number(v.trim()))
        .filter(Number.isFinite);
    else if (arg.startsWith('--levels='))
      out.levels = arg
        .slice('--levels='.length)
        .split(',')
        .map((v) => Number(v.trim()))
        .filter(Number.isFinite);
    else if (arg === '--duration-ms' && next) out.stageDurationMs = Number(next);
    else if (arg.startsWith('--duration-ms='))
      out.stageDurationMs = Number(arg.slice('--duration-ms='.length));
    else if (arg === '--cooldown-ms' && next) out.cooldownMs = Number(next);
    else if (arg.startsWith('--cooldown-ms='))
      out.cooldownMs = Number(arg.slice('--cooldown-ms='.length));
    else if (arg === '--target-url' && next) out.targetUrl = next;
    else if (arg.startsWith('--target-url=')) out.targetUrl = arg.slice('--target-url='.length);
    else if (arg === '--network' && next) out.network = next;
    else if (arg.startsWith('--network=')) out.network = arg.slice('--network='.length);
    else if (arg === '--output-dir' && next) out.outputDir = path.resolve(next);
    else if (arg.startsWith('--output-dir='))
      out.outputDir = path.resolve(arg.slice('--output-dir='.length));
    else if (arg === '--success-threshold' && next) out.successThreshold = Number(next);
    else if (arg.startsWith('--success-threshold='))
      out.successThreshold = Number(arg.slice('--success-threshold='.length));
    else if (arg === '--p95-threshold-ms' && next) out.p95ThresholdMs = Number(next);
    else if (arg.startsWith('--p95-threshold-ms='))
      out.p95ThresholdMs = Number(arg.slice('--p95-threshold-ms='.length));
  }

  return out;
}

function loadLocalEnv(filePath) {
  try {
    return parseDotEnv(fsSync.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function resolveBaseUrl(explicitTargetUrl, network) {
  if (trimString(explicitTargetUrl)) return trimString(explicitTargetUrl).replace(/\/$/, '');
  const localEnv = loadLocalEnv(path.resolve('.env.local'));
  if (network === 'mainnet' && trimString(localEnv.MORPHEUS_MAINNET_CUSTOM_DOMAIN)) {
    return `https://${trimString(localEnv.MORPHEUS_MAINNET_CUSTOM_DOMAIN).replace(/^https?:\/\//, '')}`;
  }
  if (network === 'testnet' && trimString(localEnv.MORPHEUS_TESTNET_CUSTOM_DOMAIN)) {
    return `https://${trimString(localEnv.MORPHEUS_TESTNET_CUSTOM_DOMAIN).replace(/^https?:\/\//, '')}`;
  }
  return `https://oracle.meshmini.app/${network === 'testnet' ? 'testnet' : 'mainnet'}`;
}

function buildPresetFactory(name, _network) {
  const requestId = () => `${name}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const targetChain = 'neo_n3';

  const factories = {
    feeds_price: () => ({
      path: '/feeds/price',
      body: {
        symbol: 'NEO-USD',
        provider: 'twelvedata',
      },
    }),
    oracle_query: () => ({
      path: '/oracle/query',
      body: {
        request_id: requestId(),
        target_chain: targetChain,
        provider: 'twelvedata',
        symbol: 'NEO-USD',
        json_path: 'price',
      },
    }),
    oracle_smart_fetch: () => ({
      path: '/oracle/smart-fetch',
      body: {
        request_id: requestId(),
        target_chain: targetChain,
        provider: 'twelvedata',
        symbol: 'NEO-USD',
        json_path: 'price',
        script: 'function process(value){ return value.price || value.extracted_value || value; }',
      },
    }),
    compute_builtin: () => ({
      path: '/compute/execute',
      body: {
        request_id: requestId(),
        target_chain: targetChain,
        mode: 'builtin',
        function: 'math.modexp',
        input: { base: '2', exponent: '10', modulus: '17' },
      },
    }),
  };

  const factory = factories[name];
  if (!factory) {
    throw new Error(`unsupported preset: ${name}`);
  }
  return factory;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function summarizeErrors(errors = []) {
  const counts = new Map();
  for (const error of errors) {
    const key = trimString(error) || 'unknown';
    counts.set(key, Number(counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 10)
    .map(([message, count]) => ({ message, count }));
}

async function sleep(ms) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runStage({ baseUrl, authToken, concurrency, durationMs, presetFactory }) {
  const startedAt = Date.now();
  const deadline = startedAt + durationMs;
  const latencies = [];
  const statusCounts = new Map();
  const errors = [];
  let completed = 0;

  async function workerLoop() {
    while (Date.now() < deadline) {
      const request = presetFactory();
      const requestStartedAt = Date.now();
      try {
        const response = await fetch(`${baseUrl}${request.path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${authToken}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(request.body),
        });
        const latencyMs = Date.now() - requestStartedAt;
        latencies.push(latencyMs);
        completed += 1;
        statusCounts.set(response.status, Number(statusCounts.get(response.status) || 0) + 1);
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          errors.push(payload?.error || payload?.message || `HTTP ${response.status}`);
        }
      } catch (error) {
        const latencyMs = Date.now() - requestStartedAt;
        latencies.push(latencyMs);
        completed += 1;
        statusCounts.set('network_error', Number(statusCounts.get('network_error') || 0) + 1);
        errors.push(String(error?.message || error));
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => workerLoop()));

  const okCount = Number(statusCounts.get(200) || 0);
  const total = completed;
  const successRate = total > 0 ? okCount / total : 0;
  return {
    concurrency,
    duration_ms: durationMs,
    total_requests: total,
    ok_requests: okCount,
    success_rate: successRate,
    throughput_rps: total > 0 ? total / (durationMs / 1000) : 0,
    latency_ms: {
      min: latencies.length ? Math.min(...latencies) : 0,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: latencies.length ? Math.max(...latencies) : 0,
    },
    statuses: Object.fromEntries(statusCounts),
    top_errors: summarizeErrors(errors),
  };
}

function deriveRecommendation(stages, { successThreshold, p95ThresholdMs }) {
  const lossless = stages.filter(
    (stage) =>
      stage.success_rate >= successThreshold &&
      Number(stage.statuses['network_error'] || 0) === 0 &&
      Number(stage.statuses[503] || 0) === 0 &&
      Number(stage.statuses[500] || 0) === 0 &&
      Number(stage.statuses[400] || 0) === 0
  );
  const latencyComfort = lossless.filter((stage) => stage.latency_ms.p95 <= p95ThresholdMs);
  const steady = lossless.length ? lossless[lossless.length - 1].concurrency : 0;
  const comfort = latencyComfort.length ? latencyComfort[latencyComfort.length - 1].concurrency : 0;
  const firstWarning = stages.find(
    (stage) =>
      stage.success_rate < successThreshold ||
      stage.latency_ms.p95 > p95ThresholdMs ||
      Number(stage.statuses[400] || 0) > 0 ||
      Number(stage.statuses[503] || 0) > 0 ||
      Number(stage.statuses['network_error'] || 0) > 0
  );
  return {
    recommended_lossless_concurrency: steady,
    recommended_latency_concurrency: comfort,
    first_warning_concurrency: firstWarning?.concurrency || null,
    success_threshold: successThreshold,
    p95_threshold_ms: p95ThresholdMs,
  };
}

function deriveSuggestedEnv(preset, recommendation) {
  const lossless = String(recommendation.recommended_lossless_concurrency || 0);
  const comfort = String(recommendation.recommended_latency_concurrency || 0);
  switch (preset) {
    case 'oracle_query':
      return {
        MORPHEUS_MAX_INFLIGHT_ORACLE_QUERY: lossless,
        MORPHEUS_MAX_INFLIGHT_ORACLE_SMART_FETCH: comfort || lossless,
      };
    case 'oracle_smart_fetch':
      return {
        MORPHEUS_MAX_INFLIGHT_ORACLE_SMART_FETCH: lossless,
      };
    case 'compute_builtin':
      return {
        MORPHEUS_MAX_INFLIGHT_COMPUTE_EXECUTE: lossless,
      };
    default:
      return {};
  }
}

async function writeArtifacts({ outputDir, preset, network, report }) {
  await fs.mkdir(outputDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const base = `oracle-stress-${preset}.${network}.${date}`;
  const jsonPath = path.join(outputDir, `${base}.json`);
  const mdPath = path.join(outputDir, `${base}.md`);
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

  const markdown = [
    `# Oracle Stress ${preset} ${network} ${date}`,
    '',
    `- base_url: \`${report.base_url}\``,
    `- preset: \`${preset}\``,
    `- capacity_profile: \`${report.capacity_profile}\``,
    `- levels: \`${report.levels.join(',')}\``,
    `- recommended lossless concurrency: \`${report.recommendation.recommended_lossless_concurrency}\``,
    `- recommended latency concurrency: \`${report.recommendation.recommended_latency_concurrency}\``,
    `- first warning concurrency: \`${report.recommendation.first_warning_concurrency ?? 'none'}\``,
    '',
    '| Concurrency | Success | RPS | p50 | p95 | p99 | 503 | 429 | Network |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.stages.map(
      (stage) =>
        `| ${stage.concurrency} | ${(stage.success_rate * 100).toFixed(2)}% | ${stage.throughput_rps.toFixed(2)} | ${stage.latency_ms.p50} | ${stage.latency_ms.p95} | ${stage.latency_ms.p99} | ${stage.statuses[503] || 0} | ${stage.statuses[429] || 0} | ${stage.statuses.network_error || 0} |`
    ),
    '',
  ].join('\n');

  await fs.writeFile(mdPath, `${markdown}\n`);
  return { jsonPath, mdPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const network =
    trimString(args.network || process.env.MORPHEUS_NETWORK || 'testnet').toLowerCase() ===
    'mainnet'
      ? 'mainnet'
      : 'testnet';
  await loadDotEnv(path.resolve('.env.local'), { override: false });
  await loadDotEnv(path.resolve('.env'), { override: false });

  const authToken = trimString(process.env.MORPHEUS_RUNTIME_TOKEN || '');
  if (!authToken) {
    throw new Error('MORPHEUS_RUNTIME_TOKEN or NITRO_API_TOKEN is required');
  }

  const baseUrl = resolveBaseUrl(args.targetUrl, network);
  const presetFactory = buildPresetFactory(args.preset, network);

  const stages = [];
  for (const concurrency of args.levels) {
    const stage = await runStage({
      baseUrl,
      authToken,
      concurrency,
      durationMs: args.stageDurationMs,
      presetFactory,
    });
    stages.push(stage);
    await sleep(args.cooldownMs);
  }

  const report = {
    generated_at: new Date().toISOString(),
    base_url: baseUrl,
    network,
    capacity_profile:
      network === 'mainnet'
        ? 'mainnet-production-higher-capacity'
        : 'testnet-validation-lower-capacity',
    preset: args.preset,
    levels: args.levels,
    stage_duration_ms: args.stageDurationMs,
    cooldown_ms: args.cooldownMs,
    stages,
    recommendation: deriveRecommendation(stages, {
      successThreshold: args.successThreshold,
      p95ThresholdMs: args.p95ThresholdMs,
    }),
  };
  report.suggested_env = deriveSuggestedEnv(args.preset, report.recommendation);

  const artifacts = await writeArtifacts({
    outputDir: args.outputDir,
    preset: args.preset,
    network,
    report,
  });

  console.log(JSON.stringify({ ...report, artifacts }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
