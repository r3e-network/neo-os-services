import { betterStackApi, loadBetterStackEnv } from './betterstack-lib.mjs';
import { inspectWebCronEnv } from './lib-web-cron-env.mjs';

await loadBetterStackEnv();

const [response, webCronEnv] = await Promise.all([
  betterStackApi('/heartbeats?page=1&per_page=100'),
  inspectWebCronEnv({ env: {} }),
]);
const rows = Array.isArray(response?.data) ? response.data : [];
const includeUrls = process.argv.includes('--include-urls');

console.log(
  JSON.stringify(
    {
      total_heartbeats: rows.length,
      web_cron_env: webCronEnv,
      heartbeats: rows.map((row) => ({
        id: row.id,
        name: row.attributes?.name || null,
        ...(includeUrls ? { url: row.attributes?.url || null } : {}),
        period: row.attributes?.period || null,
        grace: row.attributes?.grace || null,
        status: row.attributes?.status || null,
        team_name: row.attributes?.team_name || null,
      })),
    },
    null,
    2
  )
);
