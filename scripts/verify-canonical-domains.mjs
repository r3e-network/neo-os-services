import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertFreshResponse,
  assertFreshTimestamp,
  assertLatestHeight,
} from './lib/canonical-domain-freshness.mjs';
import {
  readReviewedNetworkRegistrySync,
  resolveReviewedNeoN3Magic,
} from './lib-network-registry.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REVIEWED_N3_MAGIC = Object.fromEntries(
  ['mainnet', 'testnet'].map((network) => [
    network,
    Number(resolveReviewedNeoN3Magic(readReviewedNetworkRegistrySync(REPO_ROOT, network), network)),
  ])
);

const checks = [];
async function probe(name, url, validate, init = {}) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(25_000),
    });
    const evidence = await validate(response);
    checks.push({
      name,
      url,
      ok: true,
      status: response.status,
      elapsedMs: Date.now() - started,
      evidence,
      cache: {
        source: response.headers.get('x-upstream-source'),
        edge: response.headers.get('x-edge-cache'),
        namespace: response.headers.get('x-edge-cache-namespace'),
        cf: response.headers.get('cf-cache-status'),
        warning: response.headers.get('warning'),
        age: response.headers.get('age'),
      },
    });
  } catch (error) {
    checks.push({ name, url, ok: false, elapsedMs: Date.now() - started, error: error.message });
  }
}

const json = async (response) => {
  assert.equal(response.status, 200);
  assertFreshResponse(response);
  return response.json();
};

const assertFuraCachePolicy = (response) => {
  assert.equal(
    response.headers.get('x-edge-cache-namespace'),
    'v2',
    'unexpected Fura edge cache namespace'
  );
};

await Promise.allSettled([
  probe('runtime-mainnet', 'https://runtime.neoos.network/health', async (response) => {
    const body = await json(response);
    assert.equal(body.network, 'mainnet');
    assert.equal(body.ready, true);
    assert.equal(body.checks.compute, true);
    assert.equal(body.checks.signer, true);
    return { network: body.network, ready: body.ready };
  }),
  ...[
    'https://runtime.neoos.network/testnet/health',
    'https://services.neoos.network/runtime/testnet/health',
  ].map((url) =>
    probe('runtime-testnet-refusal', url, async (response) => {
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.error, 'runtime_network_mismatch');
      assert.equal(body.actual_network, 'mainnet');
      return body;
    })
  ),
  ...['mainnet', 'testnet'].map((network) =>
    probe(
      `fura-${network}-identity`,
      `https://fura.neoos.network/${network}`,
      async (response) => {
        const body = await json(response);
        assertFuraCachePolicy(response);
        assert.equal(body.error, undefined);
        assert.equal(body.result.protocol.network, REVIEWED_N3_MAGIC[network]);
        return { network, magic: body.result.protocol.network };
      },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getversion', params: [] }),
      }
    )
  ),
  ...['mainnet', 'testnet'].map((network) =>
    probe(
      `indexer-${network}-status`,
      `https://fura.neoos.network/${network}/status`,
      async (response) => {
        const { data } = await json(response);
        assertFuraCachePolicy(response);
        assert.match(
          response.headers.get('cache-control') || '',
          /(?:^|,)\s*no-store\b/i,
          'readiness must prohibit caching'
        );
        assert.equal(data.network, network);
        assert.equal(data.ready, true);
        assert.equal(data.reason, 'ok');
        assert.ok(Number.isSafeInteger(data.last_indexed_block) && data.last_indexed_block > 0);
        assert.ok(
          Number.isFinite(data.freshness_seconds) &&
            data.freshness_seconds <= data.max_freshness_seconds
        );
        assertFreshTimestamp(Date.parse(data.updated_at));
        assertFreshTimestamp(Date.parse(data.checked_at));
        return data;
      }
    )
  ),
  ...['mainnet', 'testnet'].map((network) =>
    probe(
      `indexer-${network}-blocks`,
      `https://indexer.neoos.network/indexer/v1/networks/${network}/blocks?limit=1`,
      async (response) => {
        const body = await json(response);
        assertFuraCachePolicy(response);
        assert.equal(body.data.length, 1);
        const block = body.data[0];
        assert.equal(block.network, network);
        assert.match(block.hash, /^0x[0-9a-f]{64}$/);
        assert.ok(Number.isSafeInteger(block.block_index) && block.block_index > 0);
        assertFreshTimestamp(block.time_ms);
        return { height: block.block_index, hash: block.hash, timeMs: block.time_ms };
      }
    )
  ),
  ...['https://mcp.neoos.network/healthz', 'https://services.neoos.network/mcp/healthz'].map(
    (url) =>
      probe('mcp-liveness', url, async (response) => {
        await json(response);
        return { reachable: true };
      })
  ),
  probe(
    'mcp-auth-required',
    'https://mcp.neoos.network/mcp',
    async (response) => {
      assert.equal(response.status, 401);
      return { unauthenticatedDenied: true };
    },
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
  ),
  probe(
    'gateway-unknown-route',
    'https://services.neoos.network/unknown/path',
    async (response) => {
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error, 'unknown_service');
    }
  ),
  probe('explorer-redirect', 'https://explorer.neoos.network/', async (response) => {
    assert.ok([301, 302, 307, 308].includes(response.status));
    assert.equal(response.headers.get('location'), 'https://www.neo3scan.com/');
  }),
]);

for (const network of ['mainnet', 'testnet']) {
  const status = checks.find((check) => check.name === `indexer-${network}-status`);
  const blocks = checks.find((check) => check.name === `indexer-${network}-blocks`);
  if (!status.ok || !blocks.ok) continue;
  try {
    assertLatestHeight(blocks.evidence.height, status.evidence.last_indexed_block);
  } catch (error) {
    blocks.ok = false;
    blocks.error = error.message;
  }
}

checks.sort((a, b) => a.name.localeCompare(b.name) || a.url.localeCompare(b.url));
const report = {
  checkedAt: new Date().toISOString(),
  scope: 'canonical-domain-read-only-probes',
  releaseReady: false,
  exclusions: [
    'authenticated Admin login and mutations',
    'authenticated MCP tools',
    'contract migration/deployment',
    'MiniApp/MiniGame functional acceptance',
    'backend deployment provenance',
    'TestNet runtime readiness',
  ],
  ok: checks.every((check) => check.ok),
  passed: checks.filter((check) => check.ok).length,
  total: checks.length,
  checks,
};
if (process.argv[2]) await writeFile(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
