import { trimString } from './lib-strings.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadDotEnv } from './lib-env.mjs';
import { jsonPretty, repoRoot, writeValidationArtifacts } from '../examples/scripts/common.mjs';

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    network: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--network' && next) {
      out.network = trimString(next);
      index += 1;
      continue;
    }
    if (arg.startsWith('--network=')) {
      out.network = trimString(arg.slice('--network='.length));
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCloudflareRateLimited(response) {
  const raw = String(response?.body?.raw || '');
  return (
    response?.status === 429 &&
    (/Error 1027/i.test(raw) ||
      /temporarily rate limited/i.test(raw) ||
      /Cloudflare Workers/i.test(raw))
  );
}

function isSupabaseQuotaRestricted(response) {
  const raw = JSON.stringify(response?.body || {}).toLowerCase();
  return (
    response?.status === 402 ||
    raw.includes('exceed_db_size_quota') ||
    raw.includes('database size quota') ||
    raw.includes('quota exceeded') ||
    raw.includes('payment required')
  );
}

async function writeRateLimitedArtifacts({ generatedAt, network, controlPlaneUrl, accepted }) {
  const jsonReport = {
    generated_at: generatedAt,
    network,
    control_plane_url: controlPlaneUrl,
    route: '/oracle/query',
    accepted,
    status: 'rate_limited',
  };

  const markdownReport = [
    '# Control Plane Smoke',
    '',
    `Date: ${generatedAt}`,
    '',
    '## Scope',
    '',
    'Submit a single `/oracle/query` job through the Cloudflare control plane and wait for the durable job state to reach a terminal status.',
    '',
    '## Result',
    '',
    `- Network: \`${network}\``,
    `- Control plane: \`${controlPlaneUrl}\``,
    `- Accepted status: \`${accepted.status}\``,
    '- Terminal status: `rate_limited`',
    '',
    '## Note',
    '',
    'Cloudflare Workers plan limits blocked the smoke request before job acceptance. This is an operational capacity condition, not a contract or application logic fault.',
    '',
  ].join('\n');

  const artifacts = await writeValidationArtifacts({
    baseName: 'control-plane-smoke',
    network,
    generatedAt,
    jsonReport,
    markdownReport,
  });

  console.log(
    jsonPretty({
      ...artifacts,
      accepted_status: accepted.status,
      terminal_status: 'rate_limited',
    })
  );
}

async function writeSupabaseQuotaArtifacts({ generatedAt, network, controlPlaneUrl, accepted }) {
  const jsonReport = {
    generated_at: generatedAt,
    network,
    control_plane_url: controlPlaneUrl,
    route: '/oracle/query',
    accepted,
    status: 'storage_quota_restricted',
  };

  const markdownReport = [
    '# Control Plane Smoke',
    '',
    `Date: ${generatedAt}`,
    '',
    '## Scope',
    '',
    'Submit a single `/oracle/query` job through the Cloudflare control plane and wait for the durable job state to reach a terminal status.',
    '',
    '## Result',
    '',
    `- Network: \`${network}\``,
    `- Control plane: \`${controlPlaneUrl}\``,
    `- Accepted status: \`${accepted.status}\``,
    '- Terminal status: `storage_quota_restricted`',
    '',
    '## Note',
    '',
    'Supabase rejected the durable job insert because the backing database is over quota. This is a production control-plane blocker: the service cannot accept new queued oracle jobs until storage/quota is restored or the backing store is migrated.',
    '',
  ].join('\n');

  const artifacts = await writeValidationArtifacts({
    baseName: 'control-plane-smoke',
    network,
    generatedAt,
    jsonReport,
    markdownReport,
  });

  console.log(
    jsonPretty({
      ...artifacts,
      accepted_status: accepted.status,
      terminal_status: 'storage_quota_restricted',
    })
  );
}

function resolveNetwork() {
  return trimString(process.env.MORPHEUS_NETWORK || 'testnet') === 'mainnet'
    ? 'mainnet'
    : 'testnet';
}

function resolveControlPlaneUrl(_network) {
  const explicit = trimString(
    process.env.MORPHEUS_CONTROL_PLANE_URL ||
      process.env.NEXT_PUBLIC_MORPHEUS_CONTROL_PLANE_URL ||
      ''
  );
  if (explicit) return explicit.replace(/\/$/, '');
  const defaultDomain = trimString(process.env.MORPHEUS_CONTROL_PLANE_DOMAIN || '');
  if (defaultDomain) return `https://${defaultDomain.replace(/\/$/, '')}`;
  throw new Error('MORPHEUS_CONTROL_PLANE_URL is required');
}

async function loadNetworkRegistry(selectedNetwork) {
  try {
    return JSON.parse(
      await fs.readFile(
        path.resolve(repoRoot, 'config', 'networks', `${selectedNetwork}.json`),
        'utf8'
      )
    );
  } catch {
    return null;
  }
}

function resolveControlPlaneToken() {
  return trimString(
    process.env.MORPHEUS_CONTROL_PLANE_API_KEY ||
      process.env.MORPHEUS_PROVIDER_CONFIG_API_KEY ||
      process.env.MORPHEUS_OPERATOR_API_KEY ||
      process.env.ADMIN_CONSOLE_API_KEY ||
      ''
  );
}

async function callControlPlane(baseUrl, network, token, routePath, payload) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token) {
    headers.set('authorization', `Bearer ${token}`);
    headers.set('x-admin-api-key', token);
  }
  const response = await fetch(`${baseUrl}/${network}${routePath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return {
    status: response.status,
    body,
  };
}

async function fetchJobStatus(baseUrl, network, jobId, token) {
  const headers = new Headers();
  if (token) {
    headers.set('authorization', `Bearer ${token}`);
    headers.set('x-admin-api-key', token);
  }
  const response = await fetch(`${baseUrl}/${network}/jobs/${jobId}`, {
    method: 'GET',
    headers,
  });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return {
    status: response.status,
    body,
  };
}

async function waitForTerminalJob(baseUrl, network, jobId, token, timeoutMs = 180000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = await fetchJobStatus(baseUrl, network, jobId, token);
    const status = trimString(current.body?.status || '');
    if (['succeeded', 'failed', 'dead_lettered', 'cancelled'].includes(status)) {
      return current;
    }
    await sleep(3000);
  }
  throw new Error(`timed out waiting for terminal control-plane job ${jobId}`);
}

const args = parseArgs();
const network =
  trimString(args.network) === 'mainnet'
    ? 'mainnet'
    : trimString(args.network) === 'testnet'
      ? 'testnet'
      : resolveNetwork();
await loadDotEnv(path.resolve(repoRoot, '.env'), { override: false });
await loadDotEnv(path.resolve(repoRoot, 'deploy', 'nitro', `morpheus.${network}.env`), {
  override: false,
});

if (!trimString(process.env.MORPHEUS_CONTROL_PLANE_URL || '')) {
  const networkRegistry = await loadNetworkRegistry(network);
  const registryUrl = trimString(networkRegistry?.nitro?.control_plane_url || '');
  if (registryUrl) process.env.MORPHEUS_CONTROL_PLANE_URL = registryUrl;
}

const controlPlaneUrl = resolveControlPlaneUrl(network);
const controlPlaneToken = resolveControlPlaneToken();
const queryPayload = {
  provider: 'twelvedata',
  symbol: 'TWELVEDATA:NEO-USD',
  json_path: 'price',
  target_chain: 'neo_n3',
  project_slug: trimString(process.env.MORPHEUS_FEED_PROJECT_SLUG || 'demo'),
  dedupe_key: `smoke-control-plane-${network}-${Date.now()}`,
};

let accepted = null;
const acceptanceAttempts = Math.max(
  Number(process.env.MORPHEUS_CONTROL_PLANE_SMOKE_ACCEPT_RETRIES || 4),
  1
);
for (let attempt = 1; attempt <= acceptanceAttempts; attempt += 1) {
  accepted = await callControlPlane(
    controlPlaneUrl,
    network,
    controlPlaneToken,
    '/oracle/query',
    queryPayload
  );
  if (!isCloudflareRateLimited(accepted) || attempt >= acceptanceAttempts) break;
  console.warn(
    `[control-plane-smoke] Cloudflare rate limit while accepting job, retrying (${attempt}/${acceptanceAttempts})...`
  );
  await sleep(5000 * attempt);
}

if (accepted.status !== 202 || !trimString(accepted.body?.id || '')) {
  if (isCloudflareRateLimited(accepted)) {
    const generatedAt = new Date().toISOString();
    await writeRateLimitedArtifacts({
      generatedAt,
      network,
      controlPlaneUrl,
      accepted,
    });
    process.exit(75);
  }
  if (isSupabaseQuotaRestricted(accepted)) {
    const generatedAt = new Date().toISOString();
    await writeSupabaseQuotaArtifacts({
      generatedAt,
      network,
      controlPlaneUrl,
      accepted,
    });
    process.exit(76);
  }
  throw new Error(
    `control plane did not accept job: ${accepted.status} ${JSON.stringify(accepted.body)}`
  );
}

const terminal = await waitForTerminalJob(
  controlPlaneUrl,
  network,
  accepted.body.id,
  controlPlaneToken
);

const generatedAt = new Date().toISOString();
const jsonReport = {
  generated_at: generatedAt,
  network,
  control_plane_url: controlPlaneUrl,
  route: '/oracle/query',
  accepted,
  terminal,
};

const markdownReport = [
  '# Control Plane Smoke',
  '',
  `Date: ${generatedAt}`,
  '',
  '## Scope',
  '',
  'Submit a single `/oracle/query` job through the Cloudflare control plane and wait for the durable job state to reach a terminal status.',
  '',
  '## Result',
  '',
  `- Network: \`${network}\``,
  `- Control plane: \`${controlPlaneUrl}\``,
  `- Accepted status: \`${accepted.status}\``,
  `- Job id: \`${trimString(accepted.body?.id || '')}\``,
  `- Terminal status: \`${trimString(terminal.body?.status || '')}\``,
  '',
].join('\n');

const artifacts = await writeValidationArtifacts({
  baseName: 'control-plane-smoke',
  network,
  generatedAt,
  jsonReport,
  markdownReport,
});

console.log(
  jsonPretty({
    ...artifacts,
    job_id: trimString(accepted.body?.id || ''),
    accepted_status: accepted.status,
    terminal_status: trimString(terminal.body?.status || ''),
  })
);
