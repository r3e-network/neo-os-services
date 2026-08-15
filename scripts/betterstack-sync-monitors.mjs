import { betterStackApi, loadBetterStackEnv } from './betterstack-lib.mjs';

await loadBetterStackEnv();

const desired = [
  {
    pronounceable_name: 'morpheus-oracle-testnet-health',
    url: 'https://oracle.meshmini.app/testnet/health',
    monitor_type: 'expected_status_code',
    expected_status_codes: [200],
    check_frequency: 300,
  },
  {
    pronounceable_name: 'morpheus-oracle-mainnet-health',
    url: 'https://oracle.meshmini.app/mainnet/health',
    monitor_type: 'expected_status_code',
    expected_status_codes: [200],
    check_frequency: 300,
  },
  {
    pronounceable_name: 'morpheus-oracle-testnet-runtime-status',
    url: 'https://oracle.meshmini.app/testnet/api/runtime/status',
    monitor_type: 'expected_status_code',
    expected_status_codes: [200],
    check_frequency: 300,
  },
  {
    pronounceable_name: 'morpheus-oracle-mainnet-runtime-status',
    url: 'https://oracle.meshmini.app/mainnet/api/runtime/status',
    monitor_type: 'expected_status_code',
    expected_status_codes: [200],
    check_frequency: 300,
  },
  {
    pronounceable_name: 'morpheus-edge-testnet-health',
    url: 'https://edge.meshmini.app/testnet/health',
    monitor_type: 'expected_status_code',
    expected_status_codes: [200],
    check_frequency: 300,
  },
  {
    pronounceable_name: 'morpheus-edge-mainnet-health',
    url: 'https://edge.meshmini.app/mainnet/health',
    monitor_type: 'expected_status_code',
    expected_status_codes: [200],
    check_frequency: 300,
  },
  {
    pronounceable_name: 'morpheus-aa-home',
    url: 'https://neo-abstract-account.vercel.app/',
    monitor_type: 'expected_status_code',
    expected_status_codes: [200],
    check_frequency: 300,
  },
  {
    pronounceable_name: 'morpheus-aa-identity',
    url: 'https://neo-abstract-account.vercel.app/identity',
    monitor_type: 'expected_status_code',
    expected_status_codes: [200],
    check_frequency: 300,
  },
];

function buildPayload(spec) {
  return {
    url: spec.url,
    pronounceable_name: spec.pronounceable_name,
    monitor_type: spec.monitor_type,
    expected_status_codes: spec.expected_status_codes || [],
    required_keyword: spec.required_keyword || null,
    email: true,
    sms: false,
    call: false,
    push: false,
    verify_ssl: true,
    follow_redirects: true,
    http_method: 'get',
    request_timeout: 15,
    check_frequency: spec.check_frequency,
    recovery_period: 180,
    confirmation_period: 0,
  };
}

const existingResponse = await betterStackApi('/monitors?page=1&per_page=100');
const existing = Array.isArray(existingResponse?.data) ? existingResponse.data : [];
const existingByName = new Map(
  existing.map((row) => [String(row.attributes?.pronounceable_name || ''), row])
);

const created = [];
const updated = [];

for (const monitor of desired) {
  const payload = buildPayload(monitor);
  const current = existingByName.get(monitor.pronounceable_name);

  if (current) {
    const result = await betterStackApi(`/monitors/${current.id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    updated.push({
      id: result?.data?.id || current.id,
      name: monitor.pronounceable_name,
      url: monitor.url,
      monitor_type: monitor.monitor_type,
    });
    continue;
  }

  const result = await betterStackApi('/monitors', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  created.push({
    id: result?.data?.id || null,
    name: monitor.pronounceable_name,
    url: monitor.url,
    monitor_type: monitor.monitor_type,
  });
}

const finalResponse = await betterStackApi('/monitors?page=1&per_page=100');
const finalRows = Array.isArray(finalResponse?.data) ? finalResponse.data : [];

console.log(
  JSON.stringify(
    {
      created,
      updated,
      total_monitors: finalRows.length,
    },
    null,
    2
  )
);
