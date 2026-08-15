import {
  betterStackTelemetryApi,
  loadBetterStackTelemetryEnv,
} from './betterstack-telemetry-lib.mjs';

await loadBetterStackTelemetryEnv();

const desired = [
  {
    name: 'morpheus-operations-http',
    platform: 'http',
    data_region: 'germany',
  },
];

const existingResponse = await betterStackTelemetryApi('/sources?page=1&per_page=100');
const existing = Array.isArray(existingResponse?.data) ? existingResponse.data : [];
const existingByName = new Map(existing.map((row) => [String(row.attributes?.name || ''), row]));

const created = [];
const updated = [];

for (const source of desired) {
  const current = existingByName.get(source.name);
  if (current) {
    const result = await betterStackTelemetryApi(`/sources/${current.id}`, {
      method: 'PATCH',
      body: JSON.stringify(source),
    });
    updated.push({
      id: result?.data?.id || current.id,
      name: source.name,
      ingesting_host:
        result?.data?.attributes?.ingesting_host || current.attributes?.ingesting_host || null,
      token: result?.data?.attributes?.token || current.attributes?.token || null,
    });
    continue;
  }

  const result = await betterStackTelemetryApi('/sources', {
    method: 'POST',
    body: JSON.stringify(source),
  });
  created.push({
    id: result?.data?.id || null,
    name: source.name,
    ingesting_host: result?.data?.attributes?.ingesting_host || null,
    token: result?.data?.attributes?.token || null,
  });
}

const finalResponse = await betterStackTelemetryApi('/sources?page=1&per_page=100');
const finalRows = Array.isArray(finalResponse?.data) ? finalResponse.data : [];
const operationsSource = finalRows.find(
  (row) => String(row.attributes?.name || '') === 'morpheus-operations-http'
);

console.log(
  JSON.stringify(
    {
      created,
      updated,
      total_sources: finalRows.length,
      env_mapping: operationsSource
        ? {
            MORPHEUS_BETTERSTACK_LOG_INGESTING_HOST:
              operationsSource.attributes?.ingesting_host || '',
            MORPHEUS_BETTERSTACK_LOG_SOURCE_TOKEN: operationsSource.attributes?.token || '',
          }
        : {},
    },
    null,
    2
  )
);
