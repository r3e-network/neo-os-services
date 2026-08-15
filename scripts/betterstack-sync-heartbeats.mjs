import { betterStackApi, heartbeatFailUrl, loadBetterStackEnv } from './betterstack-lib.mjs';

await loadBetterStackEnv();

const desired = [
  {
    name: 'morpheus-cron-feed',
    period: 60,
    grace: 120,
    email: true,
  },
  {
    name: 'morpheus-cron-health',
    period: 300,
    grace: 120,
    email: true,
  },
  {
    name: 'morpheus-relayer',
    period: 60,
    grace: 180,
    email: true,
  },
  {
    name: 'morpheus-relayer-feed',
    period: 60,
    grace: 180,
    email: true,
  },
];

const existingResponse = await betterStackApi('/heartbeats?page=1&per_page=100');
const existing = Array.isArray(existingResponse?.data) ? existingResponse.data : [];
const existingByName = new Map(existing.map((row) => [String(row.attributes?.name || ''), row]));

const created = [];
const updated = [];

for (const heartbeat of desired) {
  const payload = {
    name: heartbeat.name,
    period: heartbeat.period,
    grace: heartbeat.grace,
    call: false,
    sms: false,
    email: heartbeat.email,
    push: false,
    paused: false,
  };

  const current = existingByName.get(heartbeat.name);
  if (current) {
    const result = await betterStackApi(`/heartbeats/${current.id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    updated.push({
      id: result?.data?.id || current.id,
      name: heartbeat.name,
      url: result?.data?.attributes?.url || current.attributes?.url || null,
      fail_url: heartbeatFailUrl(result?.data?.attributes?.url || current.attributes?.url || ''),
    });
    continue;
  }

  const result = await betterStackApi('/heartbeats', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  created.push({
    id: result?.data?.id || null,
    name: heartbeat.name,
    url: result?.data?.attributes?.url || null,
    fail_url: heartbeatFailUrl(result?.data?.attributes?.url || ''),
  });
}

const finalResponse = await betterStackApi('/heartbeats?page=1&per_page=100');
const finalRows = Array.isArray(finalResponse?.data) ? finalResponse.data : [];

console.log(
  JSON.stringify(
    {
      created,
      updated,
      total_heartbeats: finalRows.length,
      env_mapping: Object.fromEntries(
        finalRows
          .filter((row) =>
            [
              'morpheus-cron-feed',
              'morpheus-cron-health',
              'morpheus-relayer',
              'morpheus-relayer-feed',
            ].includes(String(row.attributes?.name || ''))
          )
          .flatMap((row) => {
            const name = String(row.attributes?.name || '');
            const url = String(row.attributes?.url || '');
            if (name === 'morpheus-cron-feed') {
              return [
                ['MORPHEUS_BETTERSTACK_CRON_FEED_HEARTBEAT_URL', url],
                ['MORPHEUS_BETTERSTACK_CRON_FEED_FAILURE_URL', heartbeatFailUrl(url)],
              ];
            }
            if (name === 'morpheus-cron-health') {
              return [['MORPHEUS_BETTERSTACK_CRON_HEALTH_HEARTBEAT_URL', url]];
            }
            if (name === 'morpheus-relayer') {
              return [
                ['MORPHEUS_BETTERSTACK_RELAYER_HEARTBEAT_URL', url],
                ['MORPHEUS_BETTERSTACK_RELAYER_FAILURE_URL', heartbeatFailUrl(url)],
              ];
            }
            if (name === 'morpheus-relayer-feed') {
              return [['MORPHEUS_BETTERSTACK_RELAYER_FEED_HEARTBEAT_URL', url]];
            }
            return [];
          })
      ),
    },
    null,
    2
  )
);
