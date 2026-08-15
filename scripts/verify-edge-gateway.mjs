#!/usr/bin/env node

const baseUrl = String(process.env.MORPHEUS_EDGE_URL || 'https://edge.meshmini.app')
  .trim()
  .replace(/\/$/, '');
const paymasterDappId = String(process.env.MORPHEUS_PAYMASTER_DAPP_ID || '').trim();

if (!paymasterDappId) {
  console.error('MORPHEUS_PAYMASTER_DAPP_ID is required for the edge paymaster probe.');
  process.exit(1);
}

async function readJson(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  };
}

async function main() {
  const health = await readJson('/health');
  const providers = await readJson('/providers');
  const paymasterTurnstileProbe = await readJson('/paymaster/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      network: 'testnet',
      target_chain: 'neo_n3',
      account_id: '0x0c3146e78efc42bfb7d4cc2e06e3efd063c01c56',
      dapp_id: paymasterDappId,
      target_contract: '0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2',
      method: 'executeUserOp',
      estimated_gas_units: 120000,
      operation_hash: '0x' + '11'.repeat(32),
    }),
  });

  console.log(
    JSON.stringify(
      {
        baseUrl,
        health: {
          status: health.status,
          edge: health.headers['x-morpheus-edge'] || null,
          route: health.headers['x-morpheus-route'] || null,
          cacheControl: health.headers['cache-control'] || null,
        },
        providers: {
          status: providers.status,
          count: Array.isArray(providers.body?.providers) ? providers.body.providers.length : null,
          cacheControl: providers.headers['cache-control'] || null,
        },
        paymasterTurnstileProbe: {
          status: paymasterTurnstileProbe.status,
          body: paymasterTurnstileProbe.body,
        },
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
