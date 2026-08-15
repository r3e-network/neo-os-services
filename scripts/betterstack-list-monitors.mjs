import { betterStackApi, loadBetterStackEnv } from './betterstack-lib.mjs';

await loadBetterStackEnv();

const response = await betterStackApi('/monitors?page=1&per_page=100');
const rows = Array.isArray(response?.data) ? response.data : [];

console.log(
  JSON.stringify(
    {
      total_monitors: rows.length,
      monitors: rows.map((row) => ({
        id: row.id,
        name: row.attributes?.pronounceable_name || null,
        url: row.attributes?.url || null,
        monitor_type: row.attributes?.monitor_type || null,
        status: row.attributes?.status || null,
        check_frequency: row.attributes?.check_frequency || null,
      })),
    },
    null,
    2
  )
);
