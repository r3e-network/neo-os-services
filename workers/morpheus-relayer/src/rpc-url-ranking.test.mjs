import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_NEO_N3_RPC_URLS,
  resolveAllowLocalClaimDuringBackoff,
  resolveDurableQueueFailClosed,
  rpcUrlRank,
  requireHttpsRpcUrls,
  uniqueRankedRpcUrls,
} from './config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// Parse the Rust port's DEFAULT_NEO_N3_RPC_URLS literal straight out of the
// source so the two tables cannot drift: a cleartext seed re-added on either
// side must fail this file. Deliberately source-level rather than a generated
// artifact — the point is to catch a hand edit to either table.
function parseRustDefaultRpcUrls() {
  const source = readFileSync(path.join(repoRoot, 'crates/neo-os-core/src/config.rs'), 'utf8');
  const start = source.indexOf('pub static DEFAULT_NEO_N3_RPC_URLS');
  assert.notEqual(
    start,
    -1,
    'DEFAULT_NEO_N3_RPC_URLS not found in crates/neo-os-core/src/config.rs'
  );
  const open = source.indexOf('= &[', start);
  assert.notEqual(open, -1, 'DEFAULT_NEO_N3_RPC_URLS literal is not in the expected `= &[` form');
  const end = source.indexOf('\n];', open);
  assert.notEqual(end, -1, 'DEFAULT_NEO_N3_RPC_URLS literal is unterminated');
  const block = source.slice(open, end);

  const table = {};
  for (const [, network, body] of block.matchAll(
    /\(\s*"([a-z0-9_]+)"\s*,\s*&\[([\s\S]*?)\]\s*,?\s*\)/g
  )) {
    table[network] = [...body.matchAll(/"([^"]*)"/g)].map(([, url]) => url);
  }
  assert.ok(
    Object.keys(table).length > 0,
    'failed to parse any network out of the Rust DEFAULT_NEO_N3_RPC_URLS literal'
  );
  return table;
}

function readRegistryRpcUrls(network) {
  const registry = JSON.parse(
    readFileSync(path.join(repoRoot, 'config/networks', `${network}.json`), 'utf8')
  );
  return {
    rpcUrl: registry.neo_n3?.rpc_url ?? '',
    rpcUrls: registry.neo_n3?.rpc_urls ?? [],
  };
}

// Regression for the plaintext-RPC preference finding: the relayer must never
// rank a cleartext http:// endpoint ahead of an available https:// endpoint,
// otherwise consensus-adjacent reads/broadcasts run over MITM-able transport by
// default. Previously http://seed*.neo.org ranked first (rank 0).

test('https endpoints outrank plaintext http endpoints', () => {
  assert.ok(
    rpcUrlRank('https://api.n3index.dev/mainnet') < rpcUrlRank('http://seed1.neo.org:10332')
  );
  assert.ok(
    rpcUrlRank('https://mainnet1.neo.coz.io:443') < rpcUrlRank('http://seed2.neo.org:10332')
  );
  // The former special-cased http seeds must no longer win.
  assert.equal(rpcUrlRank('http://seed1.neo.org:10332'), 2);
  assert.equal(rpcUrlRank('https://anything.example'), 0);
});

test('uniqueRankedRpcUrls puts every https endpoint before any http endpoint', () => {
  const ranked = uniqueRankedRpcUrls([
    'http://seed1.neo.org:10332',
    'https://api.n3index.dev/mainnet',
    'http://seed2.neo.org:10332',
    'https://mainnet1.neo.coz.io:443',
  ]);
  const firstHttp = ranked.findIndex((url) => url.startsWith('http://'));
  const lastHttps = ranked.reduce(
    (acc, url, index) => (url.startsWith('https://') ? index : acc),
    -1
  );
  assert.ok(
    firstHttp === -1 || lastHttps < firstHttp,
    'no http:// endpoint precedes an https:// one'
  );
  // De-duplication and membership are preserved.
  assert.equal(new Set(ranked).size, ranked.length);
  assert.ok(ranked.includes('https://api.n3index.dev/mainnet'));
  assert.ok(ranked.includes('http://seed1.neo.org:10332'));
});

// Ranking alone is not a control: uniqueRankedRpcUrls only DEMOTES http:// to
// last place, so any cleartext endpoint that survives in a shipped list is
// still dialed once every https:// node is unreachable — precisely the state an
// on-path attacker who can drop traffic can force. The only real control is
// that no cleartext endpoint is configured anywhere in the merge order. These
// gates enforce that on the two shipped fallback tables and on the registry
// SSOT that resolveNeoN3RpcUrls merges AHEAD of them.

test('the JS fallback RPC table is https-only', () => {
  for (const [network, urls] of Object.entries(DEFAULT_NEO_N3_RPC_URLS)) {
    for (const url of urls) {
      assert.ok(
        url.startsWith('https://'),
        `DEFAULT_NEO_N3_RPC_URLS.${network} contains a non-https endpoint: ${url}`
      );
    }
  }
});

test('the Rust fallback RPC table is https-only and identical to the JS table', () => {
  const rust = parseRustDefaultRpcUrls();

  for (const [network, urls] of Object.entries(rust)) {
    for (const url of urls) {
      assert.ok(
        url.startsWith('https://'),
        `Rust DEFAULT_NEO_N3_RPC_URLS ${network} contains a non-https endpoint: ${url}`
      );
    }
  }

  // Same networks, same URLs, same order — the Rust relayer must resolve the
  // identical fallback list the JS oracle does.
  assert.deepEqual(
    Object.keys(rust).sort(),
    Object.keys(DEFAULT_NEO_N3_RPC_URLS).sort(),
    'JS and Rust fallback tables cover different networks'
  );
  for (const network of Object.keys(DEFAULT_NEO_N3_RPC_URLS)) {
    assert.deepEqual(
      rust[network],
      DEFAULT_NEO_N3_RPC_URLS[network],
      `JS and Rust fallback tables disagree for ${network}`
    );
  }
});

test('the network registry SSOT lists no cleartext RPC endpoint', () => {
  for (const network of ['mainnet', 'testnet']) {
    const { rpcUrl, rpcUrls } = readRegistryRpcUrls(network);
    assert.ok(
      !rpcUrl.startsWith('http://'),
      `config/networks/${network}.json neo_n3.rpc_url is cleartext: ${rpcUrl}`
    );
    for (const url of rpcUrls) {
      assert.ok(
        !url.startsWith('http://'),
        `config/networks/${network}.json neo_n3.rpc_urls contains a cleartext endpoint: ${url}`
      );
    }
    // Fail closed, not open: an empty list is acceptable, a cleartext one is not.
    assert.ok(
      Array.isArray(rpcUrls),
      `config/networks/${network}.json neo_n3.rpc_urls must be a list`
    );
  }
});

test('configured RPC resolution rejects an explicit cleartext endpoint', () => {
  assert.throws(
    () => requireHttpsRpcUrls(['https://good.rpc', 'http://cleartext.rpc'], 'Neo N3 testnet RPC'),
    /Neo N3 testnet RPC requires HTTPS RPC endpoints.*http:\/\/cleartext\.rpc/i
  );
});

test('production ignores the local durable-claim backoff opt-in', () => {
  assert.equal(
    resolveAllowLocalClaimDuringBackoff({ nodeEnv: 'production', requested: true }),
    false
  );
  assert.equal(
    resolveAllowLocalClaimDuringBackoff({ nodeEnv: 'development', requested: true }),
    true
  );
});

test('production forces the durable queue to fail closed', () => {
  assert.equal(resolveDurableQueueFailClosed({ nodeEnv: 'production', requested: false }), true);
  assert.equal(resolveDurableQueueFailClosed({ nodeEnv: 'development', requested: false }), false);
});
