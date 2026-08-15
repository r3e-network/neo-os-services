import { loadDotEnv } from './lib-env.mjs';
import { trimString } from './lib-strings.mjs';

await loadDotEnv('.env.local');
await loadDotEnv('.env');

const apiKey = trimString(process.env.CHECKLY_API_KEY);
const accountId = trimString(process.env.CHECKLY_ACCOUNT_ID);
const projectName = trimString(process.env.CHECKLY_PROJECT_NAME || 'meshmini');

if (!apiKey || !accountId) {
  console.error('Missing CHECKLY_API_KEY or CHECKLY_ACCOUNT_ID.');
  process.exit(1);
}

const baseHeaders = {
  'X-Checkly-Account': accountId,
  Authorization: `Bearer ${apiKey}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

async function api(pathname, init = {}) {
  const response = await fetch(`https://api.checklyhq.com/v1${pathname}`, {
    ...init,
    headers: {
      ...baseHeaders,
      ...(init.headers || {}),
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(JSON.stringify(payload || { status: response.status }, null, 2));
  }
  return payload;
}

function statusAssertion(target) {
  return {
    source: 'STATUS_CODE',
    comparison: 'EQUALS',
    target: String(target),
    property: '',
    regex: '',
  };
}

function jsonAssertion(property, comparison, target = '') {
  return {
    source: 'JSON_BODY',
    comparison,
    target: String(target),
    property,
    regex: '',
  };
}

function textAssertion(comparison, target) {
  return {
    source: 'TEXT_BODY',
    comparison,
    target: String(target),
    property: '',
    regex: '',
  };
}

const desiredChecks = [
  {
    name: 'morpheus-oracle-testnet-health',
    url: 'https://oracle.meshmini.app/testnet/health',
    frequency: 120,
    assertions: [statusAssertion(200), jsonAssertion('$.status', 'EQUALS', 'ok')],
  },
  {
    name: 'morpheus-oracle-mainnet-health',
    url: 'https://oracle.meshmini.app/mainnet/health',
    frequency: 120,
    assertions: [statusAssertion(200), jsonAssertion('$.status', 'EQUALS', 'ok')],
  },
  {
    name: 'morpheus-oracle-testnet-runtime-catalog',
    url: 'https://oracle.meshmini.app/testnet/api/runtime/catalog',
    frequency: 360,
    assertions: [
      statusAssertion(200),
      jsonAssertion('$.envelope.version', 'NOT_EMPTY'),
      jsonAssertion('$.automation.workflowId', 'EQUALS', 'automation.upkeep'),
    ],
  },
  {
    name: 'morpheus-oracle-testnet-runtime-status',
    url: 'https://oracle.meshmini.app/testnet/api/runtime/status',
    frequency: 120,
    assertions: [
      statusAssertion(200),
      jsonAssertion('$.catalog.links.catalog', 'EQUALS', '/api/runtime/catalog'),
      jsonAssertion('$.runtime.health.state', 'NOT_EMPTY'),
    ],
  },
  {
    name: 'morpheus-oracle-mainnet-runtime-catalog',
    url: 'https://oracle.meshmini.app/mainnet/api/runtime/catalog',
    frequency: 360,
    assertions: [
      statusAssertion(200),
      jsonAssertion('$.envelope.version', 'NOT_EMPTY'),
      jsonAssertion('$.automation.workflowId', 'EQUALS', 'automation.upkeep'),
    ],
  },
  {
    name: 'morpheus-oracle-mainnet-runtime-status',
    url: 'https://oracle.meshmini.app/mainnet/api/runtime/status',
    frequency: 120,
    assertions: [
      statusAssertion(200),
      jsonAssertion('$.catalog.links.catalog', 'EQUALS', '/api/runtime/catalog'),
      jsonAssertion('$.runtime.health.state', 'NOT_EMPTY'),
    ],
  },
  {
    name: 'morpheus-oracle-testnet-public-key',
    url: 'https://oracle.meshmini.app/testnet/oracle/public-key',
    frequency: 120,
    assertions: [
      statusAssertion(200),
      jsonAssertion('$.algorithm', 'EQUALS', 'X25519-HKDF-SHA256-AES-256-GCM'),
    ],
  },
  {
    name: 'morpheus-oracle-testnet-providers',
    url: 'https://oracle.meshmini.app/testnet/providers',
    frequency: 360,
    assertions: [statusAssertion(200), jsonAssertion('$.providers', 'NOT_EMPTY')],
  },
  {
    name: 'morpheus-oracle-testnet-feed-catalog',
    url: 'https://oracle.meshmini.app/testnet/feeds/catalog',
    frequency: 360,
    assertions: [statusAssertion(200), jsonAssertion('$.pairs', 'NOT_EMPTY')],
  },
  {
    name: 'morpheus-oracle-testnet-neodid-providers',
    url: 'https://oracle.meshmini.app/testnet/neodid/providers',
    frequency: 360,
    assertions: [statusAssertion(200), jsonAssertion('$.providers', 'NOT_EMPTY')],
  },
  {
    name: 'morpheus-oracle-testnet-info',
    url: 'https://oracle.meshmini.app/testnet/info',
    frequency: 120,
    assertions: [statusAssertion(200), jsonAssertion('$.dstack.app_id', 'NOT_EMPTY')],
  },
  {
    name: 'morpheus-oracle-mainnet-public-key',
    url: 'https://oracle.meshmini.app/mainnet/oracle/public-key',
    frequency: 120,
    assertions: [
      statusAssertion(200),
      jsonAssertion('$.algorithm', 'EQUALS', 'X25519-HKDF-SHA256-AES-256-GCM'),
    ],
  },
  {
    name: 'morpheus-oracle-mainnet-providers',
    url: 'https://oracle.meshmini.app/mainnet/providers',
    frequency: 360,
    assertions: [statusAssertion(200), jsonAssertion('$.providers', 'NOT_EMPTY')],
  },
  {
    name: 'morpheus-oracle-mainnet-feed-catalog',
    url: 'https://oracle.meshmini.app/mainnet/feeds/catalog',
    frequency: 360,
    assertions: [statusAssertion(200), jsonAssertion('$.pairs', 'NOT_EMPTY')],
  },
  {
    name: 'morpheus-oracle-mainnet-neodid-providers',
    url: 'https://oracle.meshmini.app/mainnet/neodid/providers',
    frequency: 360,
    assertions: [statusAssertion(200), jsonAssertion('$.providers', 'NOT_EMPTY')],
  },
  {
    name: 'morpheus-oracle-mainnet-info',
    url: 'https://oracle.meshmini.app/mainnet/info',
    frequency: 120,
    assertions: [statusAssertion(200), jsonAssertion('$.dstack.app_id', 'NOT_EMPTY')],
  },
  {
    name: 'morpheus-control-testnet-health-auth-gate',
    url: 'https://control.meshmini.app/testnet/health',
    frequency: 120,
    assertions: [statusAssertion(401), textAssertion('CONTAINS', 'unauthorized')],
  },
  {
    name: 'morpheus-control-mainnet-health-auth-gate',
    url: 'https://control.meshmini.app/mainnet/health',
    frequency: 120,
    assertions: [statusAssertion(401), textAssertion('CONTAINS', 'unauthorized')],
  },
  {
    name: 'morpheus-edge-testnet-health',
    url: 'https://edge.meshmini.app/testnet/health',
    frequency: 120,
    assertions: [statusAssertion(200), jsonAssertion('$.status', 'EQUALS', 'ok')],
  },
  {
    name: 'morpheus-edge-mainnet-health',
    url: 'https://edge.meshmini.app/mainnet/health',
    frequency: 120,
    assertions: [statusAssertion(200), jsonAssertion('$.status', 'EQUALS', 'ok')],
  },
  {
    name: 'morpheus-edge-testnet-public-key',
    url: 'https://edge.meshmini.app/testnet/oracle/public-key',
    frequency: 120,
    assertions: [
      statusAssertion(200),
      jsonAssertion('$.algorithm', 'EQUALS', 'X25519-HKDF-SHA256-AES-256-GCM'),
    ],
  },
  {
    name: 'morpheus-edge-testnet-providers',
    url: 'https://edge.meshmini.app/testnet/providers',
    frequency: 360,
    assertions: [statusAssertion(200), jsonAssertion('$.providers', 'NOT_EMPTY')],
  },
  {
    name: 'morpheus-edge-testnet-feed-catalog',
    url: 'https://edge.meshmini.app/testnet/feeds/catalog',
    frequency: 360,
    assertions: [statusAssertion(200), jsonAssertion('$.pairs', 'NOT_EMPTY')],
  },
  {
    name: 'morpheus-edge-testnet-neodid-providers',
    url: 'https://edge.meshmini.app/testnet/neodid/providers',
    frequency: 360,
    assertions: [statusAssertion(200), jsonAssertion('$.providers', 'NOT_EMPTY')],
  },
  {
    name: 'morpheus-edge-testnet-info',
    url: 'https://edge.meshmini.app/testnet/info',
    frequency: 120,
    assertions: [statusAssertion(200), jsonAssertion('$.dstack.app_id', 'NOT_EMPTY')],
  },
  {
    name: 'morpheus-edge-mainnet-public-key',
    url: 'https://edge.meshmini.app/mainnet/oracle/public-key',
    frequency: 120,
    assertions: [
      statusAssertion(200),
      jsonAssertion('$.algorithm', 'EQUALS', 'X25519-HKDF-SHA256-AES-256-GCM'),
    ],
  },
  {
    name: 'morpheus-edge-mainnet-providers',
    url: 'https://edge.meshmini.app/mainnet/providers',
    frequency: 360,
    assertions: [statusAssertion(200), jsonAssertion('$.providers', 'NOT_EMPTY')],
  },
  {
    name: 'morpheus-edge-mainnet-feed-catalog',
    url: 'https://edge.meshmini.app/mainnet/feeds/catalog',
    frequency: 360,
    assertions: [statusAssertion(200), jsonAssertion('$.pairs', 'NOT_EMPTY')],
  },
  {
    name: 'morpheus-edge-mainnet-neodid-providers',
    url: 'https://edge.meshmini.app/mainnet/neodid/providers',
    frequency: 360,
    assertions: [statusAssertion(200), jsonAssertion('$.providers', 'NOT_EMPTY')],
  },
  {
    name: 'morpheus-edge-mainnet-info',
    url: 'https://edge.meshmini.app/mainnet/info',
    frequency: 120,
    assertions: [statusAssertion(200), jsonAssertion('$.dstack.app_id', 'NOT_EMPTY')],
  },
];

function buildApiPayload(spec) {
  return {
    name: spec.name,
    checkType: 'API',
    activated: true,
    muted: false,
    shouldFail: false,
    frequency: spec.frequency,
    locations: ['us-east-1'],
    degradedResponseTime: 5000,
    maxResponseTime: 20000,
    tags: [projectName, 'morpheus', 'api'],
    request: {
      method: 'GET',
      url: spec.url,
      followRedirects: true,
      skipSSL: false,
      body: '',
      bodyType: 'NONE',
      headers: [],
      queryParameters: [],
      assertions: spec.assertions,
    },
  };
}

const existing = await api('/checks?limit=100');
const existingByName = new Map(
  (Array.isArray(existing) ? existing : []).map((check) => [String(check.name || ''), check])
);

const created = [];
const updated = [];

for (const spec of desiredChecks) {
  const payload = buildApiPayload(spec);
  const existingCheck = existingByName.get(spec.name);

  if (existingCheck) {
    const check = await api(`/checks/${existingCheck.id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    updated.push({
      name: spec.name,
      id: check?.id || existingCheck.id,
      frequency: spec.frequency,
    });
    continue;
  }

  const check = await api('/checks/api', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  created.push({
    name: spec.name,
    id: check?.id || null,
    url: spec.url,
    frequency: spec.frequency,
  });
}

console.log(
  JSON.stringify(
    {
      account_id: accountId,
      project_name: projectName,
      created,
      updated,
      total_checks_after: desiredChecks.length,
    },
    null,
    2
  )
);
