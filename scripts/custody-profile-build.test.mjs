import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadAllowlist } from '../deploy/nitro/host-egress-proxy.mjs';

const script = await fs.readFile(new URL('../deploy/nitro/build-custody-eif.sh', import.meta.url), 'utf8');
const dockerfile = await fs.readFile(new URL('../deploy/nitro/Dockerfile.signer', import.meta.url), 'utf8');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neoos-profile-build-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'deploy/nitro'), { recursive: true });
  await fs.mkdir(path.join(root, 'mock-bin'));
  const build = path.join(root, 'deploy/nitro/build-custody-eif.sh');
  const profile = path.join(root, 'deploy/nitro/custody-vault-profile.json');
  const log = path.join(root, 'docker-calls.jsonl');
  await fs.writeFile(build, script);
  await fs.writeFile(path.join(root, 'mock-bin/docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PROFILE_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'image' && args[1] === 'inspect') console.log('sha256:fixture-image');
if (args[0] === 'run') console.log(JSON.stringify({
  schema: 'neoos/custody-profile-build-identity/v1', environment: 'testnet',
  file_sha256: process.env.PROFILE_TEST_IMAGE_DIGEST,
  required_egress: [{address: 'custody.example.test', port: 443}]
}));
`, { mode: 0o755 });
  await fs.writeFile(path.join(root, 'mock-bin/nitro-cli'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(args[args.indexOf('--output-file') + 1], 'fake-eif-for-command-flow-test');
console.log(JSON.stringify({Measurements:{PCR0:'11'.repeat(48), PCR1:'22'.repeat(48), PCR2:'33'.repeat(48), HashAlgorithm:'SHA384'}}));
`, { mode: 0o755 });
  return {
    root, profile, log,
    run(extra = {}, flags = ['--no-eif']) {
      return spawnSync('bash', [build, ...flags], { encoding: 'utf8', env: {
        ...process.env, PATH: `${path.join(root, 'mock-bin')}:${process.env.PATH}`,
        MORPHEUS_NETWORK: 'testnet', PROFILE_TEST_LOG: log, ...extra,
        MORPHEUS_RELEASE: 'profile-test', MORPHEUS_CUSTODY_EIF: path.join(root, 'test.eif'),
        NITRO_CLI_ARTIFACTS: path.join(root, 'artifacts'), NITRO_CLI_BLOBS: path.join(root, 'blobs'),
      } });
    },
  };
}

test('custody build refuses absent, symlinked and non-TestNet profile input before Docker', async t => {
  const f = await fixture(t);
  assert.notEqual(f.run().status, 0);
  await assert.rejects(fs.access(f.log));
  await fs.writeFile(path.join(f.root, 'other.json'), '{}');
  await fs.symlink(path.join(f.root, 'other.json'), f.profile);
  assert.notEqual(f.run().status, 0);
  await assert.rejects(fs.access(f.log));
  assert.match(f.run({ MORPHEUS_NETWORK: 'mainnet' }).stderr, /TestNet-only/);
});

test('both independent builds receive the same profile digest and validate the measured image', async t => {
  const f = await fixture(t);
  const bytes = '{}';
  const digest = createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(f.profile, bytes);
  const result = f.run({ PROFILE_TEST_IMAGE_DIGEST: digest }, ['--no-eif', '--verify-reproducible']);
  assert.equal(result.status, 0, result.stderr);
  const calls = (await fs.readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  const builds = calls.filter(args => args[0] === 'build');
  assert.equal(builds.length, 2);
  for (const args of builds) assert.ok(args.includes(`CUSTODY_PROFILE_FILE_SHA256=${digest}`));
  assert.ok(builds[1].includes('--no-cache'));
  const validate = calls.find(args => args[0] === 'run');
  assert.deepEqual(validate.slice(-4), ['sha256:fixture-image', 'validate-vault-profile', '/app/config/custody-vault-profile.json', 'testnet']);
  assert.ok(validate.includes('none'));
});

test('build refuses a profile identity different from the selected file', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.profile, '{}');
  assert.notEqual(f.run({ PROFILE_TEST_IMAGE_DIGEST: '00'.repeat(32) }).status, 0);
});

test('measurement command flow emits matching profile identity and exact proxy destinations', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.profile, '{}');
  const digest = createHash('sha256').update('{}').digest('hex');
  const result = f.run({ PROFILE_TEST_IMAGE_DIGEST: digest }, []);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(await fs.readFile(path.join(f.root, 'deploy/nitro/measurements/profile-test.json')));
  assert.equal(manifest.vault_profile.file_sha256, digest);
  const allowed = loadAllowlist(path.join(f.root, 'deploy/nitro/measurements/profile-test.egress.yaml'));
  assert.deepEqual([...allowed], ['custody.example.test:443']);
});

test('Docker validates the copied file and measures a read-only runtime profile', () => {
  assert.match(dockerfile, /COPY deploy\/nitro\/custody-vault-profile\.json \/build\/custody-vault-profile\.json/);
  assert.match(dockerfile, /sha256sum -c -/);
  assert.match(dockerfile, /signer_service validate-vault-profile \/build\/custody-vault-profile\.json testnet/);
  assert.match(dockerfile, /COPY --from=custodybuild \/build\/custody-vault-profile\.json \/app\/config\/custody-vault-profile\.json/);
  assert.match(dockerfile, /RUN chmod 0444 \/app\/config\/custody-vault-profile\.json/);
  assert.match(dockerfile, /ENV SIGNER_SERVICE_VAULT_PROFILE_FILE=\/app\/config\/custody-vault-profile\.json/);
});
