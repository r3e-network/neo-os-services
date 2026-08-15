import { trimString } from './lib-strings.mjs';
import path from 'node:path';
import { loadDotEnv } from './lib-env.mjs';

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {
    network: trimString(process.env.MORPHEUS_NETWORK || 'testnet') || 'testnet',
    ltRequestId: null,
    apply: false,
    statuses: [
      'queued',
      'queued_backpressure',
      'retry_scheduled',
      'failure_callback_retry_scheduled',
      'processing',
      'retrying',
    ],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--network') {
      parsed.network = trimString(argv[i + 1] || parsed.network) || parsed.network;
      i += 1;
      continue;
    }
    if (arg === '--lt-request-id') {
      parsed.ltRequestId = Number(argv[i + 1] || '');
      i += 1;
      continue;
    }
    if (arg === '--statuses') {
      parsed.statuses = String(argv[i + 1] || '')
        .split(',')
        .map((item) => trimString(item))
        .filter(Boolean);
      i += 1;
      continue;
    }
    if (arg === '--apply') {
      parsed.apply = true;
    }
  }
  return parsed;
}

function getSupabaseConfig() {
  const baseUrl = trimString(
    process.env.SUPABASE_URL ||
      process.env.NEXT_PUBLIC_SUPABASE_URL ||
      process.env.morpheus_SUPABASE_URL ||
      ''
  );
  const apiKey = trimString(
    process.env.SUPABASE_SECRET_KEY ||
      process.env.morpheus_SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.morpheus_SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_KEY ||
      ''
  );
  if (!baseUrl || !apiKey) {
    throw new Error('SUPABASE_URL and a Supabase secret/service-role key are required');
  }
  return {
    restUrl: `${baseUrl.replace(/\/$/, '')}/rest/v1`,
    apiKey,
  };
}

async function supabaseFetch(url, options = {}) {
  const { apiKey } = getSupabaseConfig();
  return fetch(url, {
    ...options,
    headers: {
      apikey: apiKey,
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
}

async function loadJobs({ network, ltRequestId, statuses }) {
  const { restUrl } = getSupabaseConfig();
  const url = new URL(`${restUrl}/morpheus_relayer_jobs`);
  url.searchParams.set(
    'select',
    'event_key,request_id,status,attempts,last_error,created_at,updated_at,chain'
  );
  url.searchParams.set('network', `eq.${network}`);
  url.searchParams.set('chain', 'eq.neo_n3');
  url.searchParams.set('status', `in.(${statuses.join(',')})`);
  if (Number.isFinite(ltRequestId)) {
    url.searchParams.set('request_id', `lt.${Math.trunc(ltRequestId)}`);
  }
  url.searchParams.set('order', 'request_id.asc');
  url.searchParams.set('limit', '5000');
  const response = await supabaseFetch(url);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`morpheus_relayer_jobs GET failed: ${response.status} ${text}`);
  }
  return text ? JSON.parse(text) : [];
}

async function patchJob(network, eventKey, fields) {
  const { restUrl } = getSupabaseConfig();
  const url = new URL(`${restUrl}/morpheus_relayer_jobs`);
  url.searchParams.set('event_key', `eq.${eventKey}`);
  url.searchParams.set('network', `eq.${network}`);
  const response = await supabaseFetch(url, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `morpheus_relayer_jobs PATCH failed for ${eventKey}: ${response.status} ${text}`
    );
  }
}

const args = parseArgs();
await loadDotEnv(path.resolve('deploy', 'nitro', `morpheus.${args.network}.env`), {
  override: false,
});
await loadDotEnv();

if (!Number.isFinite(args.ltRequestId)) {
  throw new Error('--lt-request-id is required');
}

const jobs = await loadJobs(args);
const summary = {
  network: args.network,
  lt_request_id: args.ltRequestId,
  statuses: args.statuses,
  matched: jobs.length,
  apply: args.apply,
  preview: jobs.slice(0, 20).map((job) => ({
    request_id: job.request_id,
    status: job.status,
    attempts: job.attempts,
    event_key: job.event_key,
    last_error: trimString(job.last_error || '').slice(0, 120) || null,
  })),
};

if (!args.apply) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const nowIso = new Date().toISOString();
for (const job of jobs) {
  await patchJob(args.network, job.event_key, {
    status: 'stale_quarantined',
    next_retry_at: null,
    completed_at: nowIso,
    updated_at: nowIso,
    last_error: `testnet stale backlog quarantined on ${nowIso}: ${trimString(job.last_error || 'legacy open relayer job')}`,
  });
}

console.log(
  JSON.stringify(
    {
      ...summary,
      quarantined: jobs.length,
    },
    null,
    2
  )
);
