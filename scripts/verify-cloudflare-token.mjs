#!/usr/bin/env node

function trimString(value) {
  return String(value || '').trim();
}

async function api(pathname, token) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    throw new Error(payload?.errors?.[0]?.message || `Cloudflare API failed: ${pathname}`);
  }
  return payload.result;
}

async function main() {
  const token = trimString(process.env.CLOUDFLARE_API_TOKEN);
  if (!token) {
    console.error('CLOUDFLARE_API_TOKEN is required');
    process.exit(1);
  }

  const [verify, accounts, zones] = await Promise.all([
    api('/user/tokens/verify', token),
    api('/accounts', token).catch(() => []),
    api('/zones?per_page=50', token).catch(() => []),
  ]);

  const summary = {
    token: {
      id: verify.id,
      status: verify.status,
    },
    accounts: Array.isArray(accounts)
      ? accounts.map((entry) => ({ id: entry.id, name: entry.name }))
      : [],
    zones: Array.isArray(zones)
      ? zones.map((entry) => ({
          id: entry.id,
          name: entry.name,
          account_id: entry.account?.id || null,
          account_name: entry.account?.name || null,
          permissions: entry.permissions || [],
        }))
      : [],
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
