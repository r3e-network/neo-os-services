import test from 'node:test';
import assert from 'node:assert/strict';

const { resolveCapability, resolveRouteName, listCapabilityFeatures } =
  await import('./capabilities.js');

// ---------------------------------------------------------------------------
// Path-based resolution
// ---------------------------------------------------------------------------

test('resolveCapability returns correct capability for every known exact path', () => {
  const cases = [
    ['/keys/derived', 'keys_derived'],
    ['/neodid/providers', 'neodid_providers'],
    ['/neodid/runtime', 'neodid_runtime'],
    ['/neodid/bind', 'neodid_bind'],
    ['/neodid/action-ticket', 'neodid_action_ticket'],
    ['/neodid/recovery-ticket', 'neodid_recovery_ticket'],
    ['/neodid/zklogin-ticket', 'neodid_zklogin_ticket'],
    ['/providers', 'providers'],
    ['/oracle/public-key', 'oracle_public_key'],
    ['/oracle/query', 'oracle_query'],
    ['/oracle/smart-fetch', 'oracle_smart_fetch'],
    ['/feeds/catalog', 'feeds_catalog'],
    ['/feeds/price', 'feeds_price'],
    ['/vrf/random', 'vrf_random'],
    ['/oracle/feed', 'oracle_feed'],
    ['/txproxy/invoke', 'txproxy_invoke'],
    ['/sign/payload', 'sign_payload'],
    ['/relay/transaction', 'relay_transaction'],
    ['/paymaster/authorize', 'paymaster_authorize'],
    ['/compute/functions', 'compute_functions'],
    ['/compute/execute', 'compute_execute'],
    ['/compute/jobs', 'compute_jobs'],
  ];

  for (const [path, expectedId] of cases) {
    const resolved = resolveCapability(path);
    assert.ok(resolved, `expected resolution for ${path}`);
    assert.equal(resolved.capability.id, expectedId, `path ${path}`);
  }
});

test('resolveCapability matches regex patterns for parameterized routes', () => {
  const symbolResolved = resolveCapability('/feeds/price/NEO-USD');
  assert.ok(symbolResolved, 'should resolve /feeds/price/NEO-USD');
  assert.equal(symbolResolved.capability.id, 'feeds_price_symbol');

  const jobResolved = resolveCapability('/compute/jobs/abc-123');
  assert.ok(jobResolved, 'should resolve /compute/jobs/abc-123');
  assert.equal(jobResolved.capability.id, 'compute_jobs_id');
});

test('resolveCapability prefers regex pattern over exact match within same domain', () => {
  // /feeds/price/NEO-USD should match feeds_price_symbol (regex), not feeds_price (exact)
  const feedsSymbol = resolveCapability('/feeds/price/NEO-USD');
  assert.equal(feedsSymbol.capability.id, 'feeds_price_symbol');

  // /feeds/price (no trailing symbol) should match feeds_price (exact)
  const feedsBase = resolveCapability('/feeds/price');
  assert.equal(feedsBase.capability.id, 'feeds_price');

  // /compute/jobs/xyz should match compute_jobs_id (regex), not compute_jobs (exact)
  const jobId = resolveCapability('/compute/jobs/xyz');
  assert.equal(jobId.capability.id, 'compute_jobs_id');

  // /compute/jobs should match compute_jobs (exact)
  const jobsBase = resolveCapability('/compute/jobs');
  assert.equal(jobsBase.capability.id, 'compute_jobs');
});

test('resolveCapability returns null for unknown paths', () => {
  assert.equal(resolveCapability('/unknown/route'), null);
  assert.equal(resolveCapability('/oracle/unknown'), null);
  assert.equal(resolveCapability(''), null);
});

// ---------------------------------------------------------------------------
// Action-based resolution
// ---------------------------------------------------------------------------

test('resolveCapability falls back to action-based matching', () => {
  const feedAction = resolveCapability('/some/random/path', { action: 'oracle_feed' });
  assert.ok(feedAction, 'should resolve by action oracle_feed');
  assert.equal(feedAction.capability.id, 'oracle_feed');
  assert.equal(feedAction.matchedBy, 'action');

  const signAction = resolveCapability('/some/random/path', { action: 'sign_payload' });
  assert.ok(signAction, 'should resolve by action sign_payload');
  assert.equal(signAction.capability.id, 'sign_payload');

  const relayAction = resolveCapability('/some/random/path', { action: 'relay_transaction' });
  assert.ok(relayAction, 'should resolve by action relay_transaction');
  assert.equal(relayAction.capability.id, 'relay_transaction');
});

test('resolveCapability ignores unknown actions', () => {
  assert.equal(resolveCapability('/unknown', { action: 'nonexistent' }), null);
});

// ---------------------------------------------------------------------------
// resolveRouteName
// ---------------------------------------------------------------------------

test('resolveRouteName returns capability id for known paths', () => {
  assert.equal(resolveRouteName('/vrf/random'), 'vrf_random');
  assert.equal(resolveRouteName('/compute/execute'), 'compute_execute');
  assert.equal(resolveRouteName('/paymaster/authorize'), 'paymaster_authorize');
  assert.equal(resolveRouteName('/txproxy/invoke'), 'txproxy_invoke');
  assert.equal(resolveRouteName('/oracle/feed'), 'oracle_feed');
  assert.equal(resolveRouteName('/oracle/query'), 'oracle_query');
  assert.equal(resolveRouteName('/oracle/smart-fetch'), 'oracle_smart_fetch');
  assert.equal(resolveRouteName('/neodid/action-ticket'), 'neodid_action_ticket');
  assert.equal(resolveRouteName('/neodid/recovery-ticket'), 'neodid_recovery_ticket');
  assert.equal(resolveRouteName('/neodid/zklogin-ticket'), 'neodid_zklogin_ticket');
});

test('resolveRouteName returns empty string for unknown paths', () => {
  assert.equal(resolveRouteName('/unknown'), '');
  assert.equal(resolveRouteName(''), '');
});

// ---------------------------------------------------------------------------
// listCapabilityFeatures
// ---------------------------------------------------------------------------

test('listCapabilityFeatures returns non-empty array with expected entries', () => {
  const features = listCapabilityFeatures();
  assert.ok(Array.isArray(features));
  assert.ok(features.length > 0, 'should have at least one feature');

  // Verify some key features are present
  assert.ok(features.includes('oracle/query'), 'features should include oracle/query');
  assert.ok(features.includes('vrf/random'), 'features should include vrf/random');
  assert.ok(
    features.includes('feeds/price/:symbol'),
    'features should include feeds/price/:symbol'
  );
  assert.ok(features.includes('compute/execute'), 'features should include compute/execute');
  assert.ok(features.includes('neodid/bind'), 'features should include neodid/bind');
  assert.ok(
    features.includes('paymaster/authorize'),
    'features should include paymaster/authorize'
  );
});

// ---------------------------------------------------------------------------
// Path prefix tolerance
// ---------------------------------------------------------------------------

test('resolveCapability rejects arbitrary prefixes (SECURITY: no endsWith prefix matching)', () => {
  // A bare endsWith would let /api/v1/vrf/random or /evil/vrf/random reach a
  // sensitive capability; only exact paths and known network prefixes match.
  const arbitrary = resolveCapability('/api/v1/vrf/random');
  assert.equal(arbitrary, null, 'arbitrary prefix must not resolve');
  const evil = resolveCapability('/evil/vrf/random');
  assert.equal(evil, null, 'unrecognized prefix must not resolve');
});

test('resolveCapability accepts known network prefixes', () => {
  const mainnet = resolveCapability('/mainnet/vrf/random');
  assert.ok(mainnet, 'mainnet prefix should resolve');
  assert.equal(mainnet.capability.id, 'vrf_random');
  const testnet = resolveCapability('/testnet/vrf/random');
  assert.ok(testnet, 'testnet prefix should resolve');
  assert.equal(testnet.capability.id, 'vrf_random');
});

test('resolveCapability attaches workflow metadata for catalog-backed routes', () => {
  const oracleQuery = resolveCapability('/oracle/query');
  assert.ok(oracleQuery, 'should resolve oracle query capability');
  assert.equal(oracleQuery.capability.workflow.id, 'oracle.query');
  assert.equal(oracleQuery.capability.workflow.version, 1);

  const paymaster = resolveCapability('/paymaster/authorize');
  assert.ok(paymaster, 'should resolve paymaster capability');
  assert.equal(paymaster.capability.workflow.id, 'paymaster.authorize');

  const providers = resolveCapability('/providers');
  assert.ok(providers, 'should resolve providers capability');
  assert.equal(providers.capability.workflow, undefined);
});
