import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');

function runRenderer(args) {
  return spawnSync(process.execPath, ['scripts/render-nitro-env.mjs', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '' },
  });
}

// A scratch directory removed when the test ends (the renderer writes 0600
// provisioning files into it).
function scratchDir(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// Synthetic, non-secret inputs: printable tokens and base64 "ciphertexts".
const RUNTIME_TOKEN = 'render-test-runtime-token-0123456789abcdef';
const RUNTIME_TOKEN_CIPHERTEXT = Buffer.from('runtime-token-envelope').toString('base64');
const CUSTODY_TOKEN_CIPHERTEXT = Buffer.from('custody-caller-envelope').toString('base64');
const COMPLETE_SOURCE_LINES = [
  `MORPHEUS_RUNTIME_TOKEN=${RUNTIME_TOKEN}`,
  `MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64=${RUNTIME_TOKEN_CIPHERTEXT}`,
  `SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64=${CUSTODY_TOKEN_CIPHERTEXT}`,
];

test('render-nitro-env defaults to pinned-only signer resolution', (t) => {
  const directory = scratchDir(t, 'render-nitro-env-');
  const source = path.join(directory, 'empty.env');
  fs.writeFileSync(source, '', 'utf8');

  const result = runRenderer([
    '--network',
    'mainnet',
    '--source',
    source,
    '--output-dir',
    directory,
    '--allow-missing',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const signerPath = path.join(directory, 'morpheus-nitro-signer.env');
  const rendered = fs.readFileSync(signerPath, 'utf8');
  const relayerPath = path.join(directory, 'neo-os-relayer.env');
  const relayer = fs.readFileSync(relayerPath, 'utf8');
  assert.match(rendered, /^MORPHEUS_ALLOW_UNPINNED_SIGNERS=false$/m);
  assert.match(rendered, /^SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64=$/m);
  // The retired Neo N3 signer ciphertexts are neither required nor rendered.
  assert.doesNotMatch(rendered, /NEO_N3_KMS_CIPHERTEXT|ORACLE_VERIFIER_KMS_CIPHERTEXT/);
  assert.doesNotMatch(rendered, /_WIF(?:_|=)/);
  assert.doesNotMatch(rendered, /_PRIVATE_KEY(?:_|=)/);
  assert.match(relayer, /^NODE_ENV=production$/m);
  assert.match(relayer, /^MORPHEUS_ACTIVE_CHAINS=neo_n3$/m);
  assert.match(relayer, /^MORPHEUS_RELAYER_MODE=requests_only$/m);
  assert.match(relayer, /^MORPHEUS_AUTOMATION_ENABLED=false$/m);
  assert.match(relayer, /^MORPHEUS_FEED_SYNC_ENABLED=false$/m);
  assert.match(relayer, /^MORPHEUS_RELAYER_INSTANCE_ID=$/m);
  assert.match(relayer, /^MORPHEUS_RELAYER_ENCLAVE_FULFILL=true$/m);
  assert.match(relayer, /^MORPHEUS_RELAYER_ENCLAVE_FULFILL_URL=http:\/\/127\.0\.0\.1:8787$/m);
  assert.match(relayer, /^CONTRACT_MORPHEUS_DATAFEED_HASH_MAINNET=$/m);
  assert.match(relayer, /^CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET=$/m);
  assert.match(relayer, /^NEO_RPC_URLS_MAINNET=$/m);
  assert.match(relayer, /^SIGNER_ROLE_NEOX_UPDATER_KEY_ID=$/m);
  assert.match(relayer, /^SIGNER_ROLE_NEOX_VERIFIER_KEY_ID=$/m);
  assert.match(relayer, /^MORPHEUS_RELAYER_NEOX_CHAIN_ID=47763$/m);
  assert.match(relayer, /^MORPHEUS_RELAYER_NEOX_ORACLE=$/m);
  assert.match(relayer, /^MORPHEUS_RELAYER_NEOX_FEED_GAS_LIMIT=2000000$/m);
  assert.doesNotMatch(relayer, /_WIF(?:_|=)|_PRIVATE_KEY(?:_|=)/);
  // NTFS carries no POSIX permission bits (writeFileSync's mode is ignored and
  // stat reports 0o666), so only a POSIX filesystem can confirm the renderer's
  // 0o600 request on signer material landed.
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(signerPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(relayerPath).mode & 0o777, 0o600);
  }
});

test('render-nitro-env binds the staged NeoX identity to the selected network', (t) => {
  const directory = scratchDir(t, 'render-nitro-neox-chain-');
  const source = path.join(directory, 'empty.env');
  fs.writeFileSync(source, '', 'utf8');

  const result = runRenderer([
    '--network',
    'testnet',
    '--source',
    source,
    '--output-dir',
    directory,
    '--allow-missing',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const relayer = fs.readFileSync(path.join(directory, 'neo-os-relayer.env'), 'utf8');
  assert.match(relayer, /^MORPHEUS_RELAYER_NEOX_CHAIN_ID=12227332$/m);
  // The TestNet relayer calls the TestNet frontier where the template puts it,
  // not the live mainnet bridge on 8787.
  const template = fs.readFileSync(
    path.join(repoRoot, 'deploy/nitro/morpheus-nitro-testnet.env.example'),
    'utf8'
  );
  const templateUrl = template.match(/^MORPHEUS_RUNTIME_URL=(.+)$/m)?.[1];
  assert.equal(templateUrl, 'http://127.0.0.1:8791');
  assert.match(relayer, new RegExp(`^MORPHEUS_RUNTIME_URL=${templateUrl}$`, 'm'));
  assert.match(relayer, new RegExp(`^MORPHEUS_RELAYER_ENCLAVE_FULFILL_URL=${templateUrl}$`, 'm'));
});

test('render-nitro-env preserves validated production chain and lane selection', (t) => {
  const directory = scratchDir(t, 'render-nitro-lanes-');
  const source = path.join(directory, 'lanes.env');
  fs.writeFileSync(
    source,
    [
      'MORPHEUS_ACTIVE_CHAINS=neo_n3,neox',
      'MORPHEUS_RELAYER_MODE=combined',
      'MORPHEUS_FEED_SYNC_ENABLED=true',
      'MORPHEUS_FEED_SYMBOLS=BTCUSD,NEOUSD',
      'MORPHEUS_AUTOMATION_ENABLED=true',
    ].join('\n'),
    'utf8'
  );

  const result = runRenderer([
    '--network',
    'mainnet',
    '--source',
    source,
    '--output-dir',
    directory,
    '--allow-missing',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const relayer = fs.readFileSync(path.join(directory, 'neo-os-relayer.env'), 'utf8');
  assert.match(relayer, /^MORPHEUS_ACTIVE_CHAINS=neo_n3,neox$/m);
  assert.match(relayer, /^MORPHEUS_RELAYER_MODE=combined$/m);
  assert.match(relayer, /^MORPHEUS_FEED_SYNC_ENABLED=true$/m);
  assert.match(relayer, /^MORPHEUS_FEED_SYMBOLS=BTCUSD,NEOUSD$/m);
  assert.match(relayer, /^MORPHEUS_AUTOMATION_ENABLED=false$/m);
  assert.match(relayer, /state\.mainnet\.combined\.json/);
});

test('render-nitro-env never copies plaintext signer material into provisioning output', (t) => {
  const directory = scratchDir(t, 'render-nitro-plaintext-');
  const source = path.join(directory, 'legacy.env');
  fs.writeFileSync(
    source,
    [
      'MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET=plaintext-updater-secret',
      'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY_MAINNET=plaintext-verifier-secret',
    ].join('\n'),
    'utf8'
  );

  const result = runRenderer([
    '--network',
    'mainnet',
    '--source',
    source,
    '--output-dir',
    directory,
    '--allow-missing',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const rendered = fs.readFileSync(path.join(directory, 'morpheus-nitro-signer.env'), 'utf8');
  assert.doesNotMatch(rendered, /plaintext-updater-secret|plaintext-verifier-secret/);
  assert.doesNotMatch(rendered, /_WIF(?:_|=)|_PRIVATE_KEY(?:_|=)/);
});

test('render-nitro-env rejects a missing runtime token by default', (t) => {
  const directory = scratchDir(t, 'render-nitro-token-');
  const source = path.join(directory, 'empty.env');
  fs.writeFileSync(source, '', 'utf8');

  const result = runRenderer([
    '--network',
    'mainnet',
    '--source',
    source,
    '--output-dir',
    directory,
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing runtime authorization token/);
  assert.equal(fs.existsSync(path.join(directory, 'morpheus-nitro-signer.env')), false);
});

test('render-nitro-env rejects a plaintext runtime token without its KMS envelope', (t) => {
  const directory = scratchDir(t, 'render-nitro-kms-token-');
  const source = path.join(directory, 'runtime.env');
  fs.writeFileSync(source, 'MORPHEUS_RUNTIME_TOKEN=a-secure-runtime-token-value\n', 'utf8');

  const result = runRenderer([
    '--network',
    'mainnet',
    '--source',
    source,
    '--output-dir',
    directory,
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing KMS-sealed runtime authorization token/);
  assert.equal(fs.existsSync(path.join(directory, 'morpheus-nitro-signer.env')), false);
});

test('render-nitro-env renders a complete frontier input from the runtime and custody envelopes alone', (t) => {
  // Before: exit 2 "missing KMS-sealed Nitro signer material" unless the two
  // retired Neo N3 ciphertexts were present, and the custody caller envelope that
  // start-nitro-signer.sh requires was never rendered at all.
  const directory = scratchDir(t, 'render-nitro-complete-');
  const source = path.join(directory, 'complete.env');
  fs.writeFileSync(source, COMPLETE_SOURCE_LINES.join('\n'), 'utf8');

  const result = runRenderer([
    '--network',
    'mainnet',
    '--source',
    source,
    '--output-dir',
    directory,
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.kms_ciphertexts, {
    MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64: true,
    SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64: true,
  });
  assert.deepEqual(report.retired_inputs_ignored, []);

  const signerPath = path.join(directory, 'morpheus-nitro-signer.env');
  const rendered = fs.readFileSync(signerPath, 'utf8');
  assert.match(rendered, new RegExp(`^MORPHEUS_RUNTIME_TOKEN=${RUNTIME_TOKEN}$`, 'm'));
  assert.match(
    rendered,
    new RegExp(`^MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64=${RUNTIME_TOKEN_CIPHERTEXT}$`, 'm')
  );
  assert.match(
    rendered,
    new RegExp(`^SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64=${CUSTODY_TOKEN_CIPHERTEXT}$`, 'm')
  );
  assert.doesNotMatch(rendered, /NEO_N3_KMS_CIPHERTEXT|ORACLE_VERIFIER_KMS_CIPHERTEXT/);

  // The rendered file is what start-nitro-signer.sh consumes: read it back with
  // the start script's own Node-free helpers and run its base64 input checks.
  // (neoos_require_printable_token is left out: its {8,512} bound exceeds BSD
  // grep's 255 repetition limit, so it rejects every token on a macOS dev box.)
  const probe = spawnSync(
    'bash',
    [
      '-c',
      [
        'set -euo pipefail',
        'source deploy/nitro/lib/provisioning.sh',
        'f="$1"',
        'token="$(neoos_first_env_value "$f" MORPHEUS_RUNTIME_TOKEN NITRO_SIGNER_TOKEN NITRO_API_TOKEN NITRO_SHARED_SECRET)"',
        'runtime_ct="$(neoos_env_value "$f" MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64)"',
        'signer_ct="$(neoos_env_value "$f" SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64)"',
        'neoos_require_base64 "$runtime_ct" MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64',
        'neoos_require_base64 "$signer_ct" SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64',
        'printf "%s\\n" "$token" "$runtime_ct" "$signer_ct"',
      ].join('\n'),
      'probe',
      signerPath,
    ],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(probe.stdout.trim().split('\n'), [
    RUNTIME_TOKEN,
    RUNTIME_TOKEN_CIPHERTEXT,
    CUSTODY_TOKEN_CIPHERTEXT,
  ]);
});

test('render-nitro-env refuses to render without the custody caller envelope', (t) => {
  const directory = scratchDir(t, 'render-nitro-custody-');
  const source = path.join(directory, 'no-custody.env');
  fs.writeFileSync(source, COMPLETE_SOURCE_LINES.slice(0, 2).join('\n'), 'utf8');

  const result = runRenderer([
    '--network',
    'mainnet',
    '--source',
    source,
    '--output-dir',
    directory,
  ]);
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stderr);
  assert.equal(report.reason, 'missing KMS-sealed custody caller token');
  assert.equal(report.required, 'SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64');
  assert.equal(fs.existsSync(path.join(directory, 'morpheus-nitro-signer.env')), false);
});

test('render-nitro-env reports retired Neo N3 signer ciphertexts by name and never renders them', (t) => {
  const directory = scratchDir(t, 'render-nitro-retired-');
  const source = path.join(directory, 'retired.env');
  fs.writeFileSync(
    source,
    [
      ...COMPLETE_SOURCE_LINES,
      'MORPHEUS_UPDATER_NEO_N3_KMS_CIPHERTEXT_BASE64=cmV0aXJlZC11cGRhdGVy',
      'MORPHEUS_ORACLE_VERIFIER_KMS_CIPHERTEXT_BASE64=cmV0aXJlZC12ZXJpZmllcg==',
    ].join('\n'),
    'utf8'
  );

  const result = runRenderer([
    '--network',
    'testnet',
    '--source',
    source,
    '--output-dir',
    directory,
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.retired_inputs_ignored, [
    'MORPHEUS_UPDATER_NEO_N3_KMS_CIPHERTEXT_BASE64',
    'MORPHEUS_ORACLE_VERIFIER_KMS_CIPHERTEXT_BASE64',
  ]);
  assert.doesNotMatch(result.stdout, /cmV0aXJlZC/, 'names only, never values');
  const rendered = fs.readFileSync(path.join(directory, 'morpheus-nitro-signer.env'), 'utf8');
  assert.doesNotMatch(rendered, /NEO_N3_KMS_CIPHERTEXT|ORACLE_VERIFIER_KMS_CIPHERTEXT|cmV0aXJlZC/);
});

test('render-nitro-env refuses a KMS envelope the start script would reject as non-base64', (t) => {
  const directory = scratchDir(t, 'render-nitro-base64-');
  const source = path.join(directory, 'malformed.env');
  fs.writeFileSync(
    source,
    [
      ...COMPLETE_SOURCE_LINES.slice(0, 2),
      'SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64=not base64!',
    ].join('\n'),
    'utf8'
  );

  const result = runRenderer([
    '--network',
    'mainnet',
    '--source',
    source,
    '--output-dir',
    directory,
    '--allow-missing',
  ]);
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stderr);
  assert.equal(report.reason, 'KMS ciphertext is not base64');
  assert.deepEqual(report.malformed, ['SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64']);
  assert.equal(fs.existsSync(path.join(directory, 'morpheus-nitro-signer.env')), false);
});
