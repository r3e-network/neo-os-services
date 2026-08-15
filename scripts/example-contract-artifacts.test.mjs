import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const gitignorePath = path.join(repoRoot, '.gitignore');

test('example N3 contract build outputs stay ignored and untracked', () => {
  const gitignore = fs.readFileSync(gitignorePath, 'utf8');
  assert.match(gitignore, /^examples\/contracts\/n3\/bin\/$/m);
  assert.match(gitignore, /^examples\/contracts\/n3\/obj\/$/m);

  const tracked = spawnSync(
    'git',
    ['ls-files', 'examples/contracts/n3/bin', 'examples/contracts/n3/obj'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    }
  );

  assert.equal(tracked.status, 0, tracked.stderr || tracked.stdout);
  assert.equal(tracked.stdout.trim(), '');
});

test('N3 examples use buffered raw transaction broadcasts for request flows', () => {
  const script = fs.readFileSync(
    path.join(repoRoot, 'examples/scripts/test-n3-examples.mjs'),
    'utf8'
  );

  assert.match(script, /async function sendBufferedInvocation/);
  assert.match(script, /calculateNetworkFee/);
  assert.match(script, /sendRawTransaction/);
  assert.doesNotMatch(script, /consumer\.invoke\('requestBuiltinProviderPrice'/);
  assert.doesNotMatch(script, /consumer\.invoke\('requestBuiltinCompute'/);
  assert.doesNotMatch(script, /consumer\.invoke\('requestRaw'/);
});

test('N3 example waiters recognize legacy and MiniApp kernel request events', () => {
  const scripts = fs
    .readdirSync(path.join(repoRoot, 'examples/scripts'))
    .filter((fileName) => /^test-n3-.*\.mjs$/.test(fileName));

  assert.ok(scripts.length > 0);
  for (const fileName of scripts) {
    const script = fs.readFileSync(path.join(repoRoot, 'examples/scripts', fileName), 'utf8');
    if (!script.includes('waitForRequestId')) continue;
    assert.match(script, /MiniAppRequestQueued/, fileName);
  }
});

test('examples aggregate test defaults to testnet unless the caller overrides it', () => {
  const script = fs.readFileSync(
    path.join(repoRoot, 'examples/scripts/test-all-examples.mjs'),
    'utf8'
  );

  assert.match(script, /process\.env\.MORPHEUS_NETWORK \|\|= 'testnet'/);
});

test('shared example env loader pins default example runs to testnet before loading .env', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'examples/scripts/common.mjs'), 'utf8');

  assert.match(script, /process\.env\.EXAMPLE_MORPHEUS_NETWORK/);
  assert.match(script, /process\.env\.MORPHEUS_NETWORK = requestedNetwork/);
  assert.match(script, /loadDotEnv\(path\.resolve\(repoRoot, '\.env'\), \{ override: false \}\)/);
});

test('N3 example read helpers retry transient RPC failures', () => {
  const common = fs.readFileSync(path.join(repoRoot, 'examples/scripts/common.mjs'), 'utf8');
  assert.match(common, /export async function withRetries/);
  assert.match(common, /HTTP code 502\|HTTP code 503\|HTTP code 504/);

  const scripts = fs
    .readdirSync(path.join(repoRoot, 'examples/scripts'))
    .filter((fileName) => /^test-n3-.*\.mjs$/.test(fileName));

  assert.ok(scripts.length > 0);
  for (const fileName of scripts) {
    const script = fs.readFileSync(path.join(repoRoot, 'examples/scripts', fileName), 'utf8');
    if (!script.includes('async function invokeRead')) continue;
    assert.match(script, /withRetries\(`invokeRead:/, fileName);
  }
});

test('fulfillment replay validation uses current MiniApp registration model', () => {
  const script = fs.readFileSync(
    path.join(repoRoot, 'examples/scripts/test-n3-fulfillment-replay-isolated.mjs'),
    'utf8'
  );

  assert.match(script, /'registerMiniApp'/);
  assert.match(script, /'grantModuleToMiniApp'/);
  assert.match(script, /'identity\.verify'/);
  assert.match(script, /moduleId: 'identity\.verify'/);
  assert.match(script, /operation: 'neodid_bind'/);
  assert.doesNotMatch(script, /'addAllowedCallback'/);
});

test('AA callback replay validation uses current MiniApp registration model', () => {
  const script = fs.readFileSync(
    path.join(repoRoot, 'examples/scripts/test-n3-aa-callback-replay-boundary.mjs'),
    'utf8'
  );

  assert.match(script, /'registerMiniApp'/);
  assert.match(script, /'grantModuleToMiniApp'/);
  assert.match(script, /'oracle\.fetch'/);
  assert.match(script, /moduleId: 'oracle\.fetch'/);
  assert.match(script, /operation: 'privacy_oracle'/);
  assert.match(script, /MIN_ESCAPE_TIMELOCK_SECONDS = '604800'/);
  assert.match(script, /'computeRegistrationAccountId'/);
  assert.match(script, /n3-privacy-validation\.testnet\.latest\.json/);
  assert.doesNotMatch(script, /'addAllowedCallback'/);
});

test('AA session oracle boundary uses deployed registered consumer and bound account ids', () => {
  const script = fs.readFileSync(
    path.join(repoRoot, 'examples/scripts/test-n3-aa-session-oracle-boundary.mjs'),
    'utf8'
  );

  assert.match(script, /const consumer = \{ hash: consumerHash \}/);
  assert.match(script, /'computeRegistrationAccountId'/);
  assert.match(script, /MIN_ESCAPE_TIMELOCK_SECONDS = '604800'/);
  assert.match(script, /pending_config_timelock/);
  assert.match(script, /getPendingVerifierCallTime/);
  assert.doesNotMatch(script, /'addAllowedCallback'/);
  assert.doesNotMatch(script, /requires-privileged-callback-registration/);
});

test('automation deposit exhaustion uses registered consumer without privileged callback changes', () => {
  const script = fs.readFileSync(
    path.join(repoRoot, 'examples/scripts/test-n3-automation-deposit-exhaustion.mjs'),
    'utf8'
  );

  assert.match(script, /async function deployProbeMiniApp/);
  assert.match(script, /EXAMPLE_CONSUMER_ARTIFACT = 'UserConsumerN3OracleExample'/);
  assert.match(script, /sc\.ContractParam\.hash160\(ZERO_HASH\)/);
  assert.match(script, /'grantModuleToMiniApp'/);
  assert.match(script, /wallet\.generatePrivateKey\(\)\.slice\(0, 40\)/);
  assert.match(script, /hash160ByteArrayParam/);
  assert.match(script, /viaConsumer: false/);
  assert.doesNotMatch(script, /'addAllowedCallback'/);
  assert.doesNotMatch(script, /requires-privileged-callback-registration/);
});

test('automation scheduler has database-backed claim semantics', () => {
  const automation = fs.readFileSync(
    path.join(repoRoot, 'workers/morpheus-relayer/src/automation.js'),
    'utf8'
  );
  const persistence = fs.readFileSync(
    path.join(repoRoot, 'workers/morpheus-relayer/src/persistence.js'),
    'utf8'
  );
  const migration = fs.readFileSync(
    path.join(repoRoot, 'supabase/migrations/0013_automation_processing_claims.sql'),
    'utf8'
  );

  assert.match(automation, /claimAutomationJob/);
  assert.match(automation, /status: 'processing'/);
  assert.match(automation, /status: 'active'[\s\S]*last_error: message/);
  assert.match(persistence, /export async function claimAutomationJob/);
  assert.match(persistence, /returnRepresentation: true/);
  assert.match(migration, /'processing'/);
});
