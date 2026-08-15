import {
  betterStackTelemetryApi,
  loadBetterStackTelemetryEnv,
} from './betterstack-telemetry-lib.mjs';

await loadBetterStackTelemetryEnv();

const response = await betterStackTelemetryApi('/sources?page=1&per_page=100');
const rows = Array.isArray(response?.data) ? response.data : [];

console.log(
  JSON.stringify(
    {
      total_sources: rows.length,
      sources: rows.map((row) => ({
        id: row.id,
        name: row.attributes?.name || null,
        platform: row.attributes?.platform || null,
        ingesting_host: row.attributes?.ingesting_host || null,
        token_present: Boolean(row.attributes?.token),
        team_name: row.attributes?.team_name || null,
      })),
    },
    null,
    2
  )
);
