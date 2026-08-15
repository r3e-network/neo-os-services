import { loadDotEnv } from './lib-env.mjs';
import { trimString } from './lib-strings.mjs';

function parseArgs(argv = []) {
  const options = {
    limit: 20,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === '--limit' && argv[i + 1]) {
      options.limit = Math.max(1, Number(argv[i + 1]) || options.limit);
      i += 1;
    }
  }

  return options;
}

await loadDotEnv('.env.local');
await loadDotEnv('.env');

const apiKey = trimString(process.env.CHECKLY_API_KEY);
const accountId = trimString(process.env.CHECKLY_ACCOUNT_ID);

if (!apiKey || !accountId) {
  console.error(
    'Missing CHECKLY_API_KEY or CHECKLY_ACCOUNT_ID. Set them in .env.local or process env.'
  );
  process.exit(1);
}

const options = parseArgs(process.argv.slice(2));
const response = await fetch('https://api.checklyhq.com/v1/checks?limit=100', {
  headers: {
    'X-Checkly-Account': accountId,
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  },
});

const payload = await response.json().catch(() => null);
if (!response.ok) {
  console.error(
    JSON.stringify(payload || { error: `Checkly API failed (${response.status})` }, null, 2)
  );
  process.exit(1);
}

const checks = Array.isArray(payload) ? payload : [];
console.log(
  JSON.stringify(
    {
      account_id: accountId,
      total_checks: checks.length,
      checks: checks.slice(0, options.limit).map((check) => ({
        id: check.id || null,
        name: check.name || null,
        type: check.checkType || check.type || null,
        activated: check.activated ?? null,
        locations: Array.isArray(check.locations) ? check.locations : [],
        tags: Array.isArray(check.tags) ? check.tags : [],
      })),
    },
    null,
    2
  )
);
