/**
 * The EIF build scripts are the only thing that ever re-derives a PCR set.
 *
 * Until these tests existed, the reproducibility check was opt-in: a plain
 * `bash build-enclave-eif.sh` printed a warning saying the PCR0 it had just
 * written into a committed manifest was never re-derived, and then wrote it
 * anyway. These drive both scripts end to end against stub `docker` and
 * `nitro-cli` binaries and assert the inverted default: verification runs
 * unless the operator asks for it not to, the manifest records which happened,
 * and a drifting PCR set is refused instead of committed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateManifestSchema } from '../../scripts/check-nitro-measurements.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const schema = JSON.parse(
  readFileSync(join(repoRoot, 'deploy/nitro/measurements/manifest.schema.json'), 'utf8')
);

const PROFILE = {
  schema: 'neoos/custody-vault-profile/v1',
  environment: 'testnet',
  required_egress: [{ address: 'kms.us-east-1.amazonaws.com', port: 443 }],
};

/**
 * A stub `docker` and `nitro-cli`. PCR0 is derived from the image tag when
 * STUB_PCR_DRIFT is set, which is what a non-reproducible Dockerfile looks
 * like: the from-scratch rebuild lands on a different measurement.
 */
function stubBin(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'docker'),
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  build)
    tag=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "-t" ]; then tag="$2"; fi
      shift
    done
    echo "stub docker build -> $tag"
    ;;
  image)
    case "\${2:-}" in
      inspect) echo "sha256:$(printf '%s' "\${4:-}" | shasum -a 256 | awk '{print $1}')" ;;
      rm) : ;;
    esac
    ;;
  run)
    printf '{"schema":"neoos/custody-profile-build-identity/v1","environment":"testnet","file_sha256":"%s","required_egress":[{"address":"kms.us-east-1.amazonaws.com","port":443}]}\\n' "\${STUB_PROFILE_SHA256:-}"
    ;;
esac
`
  );
  writeFileSync(
    join(dir, 'nitro-cli'),
    `#!/usr/bin/env bash
set -euo pipefail
uri=""
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --docker-uri) uri="$2" ;;
    --output-file) out="$2" ;;
  esac
  shift
done
seed="fixed"
if [ -n "\${STUB_PCR_DRIFT:-}" ]; then seed="$uri"; fi
pcr0="$(printf '%s-0' "$seed" | shasum -a 384 | awk '{print $1}')"
pcr1="$(printf '%s-1' "$seed" | shasum -a 384 | awk '{print $1}')"
pcr2="$(printf '%s-2' "$seed" | shasum -a 384 | awk '{print $1}')"
if [ -n "$out" ]; then mkdir -p "$(dirname "$out")"; printf 'stub-eif' > "$out"; fi
printf '{"Measurements":{"HashAlgorithm":"Sha384 { ... }","PCR0":"%s","PCR1":"%s","PCR2":"%s"}}\\n' "$pcr0" "$pcr1" "$pcr2"
`
  );
  for (const name of ['docker', 'nitro-cli']) chmodSync(join(dir, name), 0o755);
  return dir;
}

/** A throwaway tree holding just the script under test and its inputs. */
function workspace(script) {
  const root = mkdtempSync(join(tmpdir(), 'eif-build-'));
  const nitro = join(root, 'deploy', 'nitro');
  mkdirSync(join(nitro, 'measurements'), { recursive: true });
  copyFileSync(join(repoRoot, 'deploy/nitro', script), join(nitro, script));
  chmodSync(join(nitro, script), 0o755);
  copyFileSync(
    join(repoRoot, 'deploy/nitro/measurements/manifest.schema.json'),
    join(nitro, 'measurements', 'manifest.schema.json')
  );
  const profileBody = `${JSON.stringify(PROFILE, null, 2)}\n`;
  writeFileSync(join(nitro, 'custody-vault-profile.json'), profileBody);
  const profileSha = createHash('sha256').update(profileBody).digest('hex');
  const bin = stubBin(join(root, 'stub-bin'));
  return { root, nitro, bin, profileSha };
}

const ORACLE_ENV = {
  SIGNER_SERVICE_URL: 'http://127.0.0.1:8788',
  SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID: 'role-oracle-verifier',
  SIGNER_ROLE_UPDATER_KEY_ID: 'role-updater',
  SIGNER_ROLE_RELAYER_KEY_ID: 'role-relayer',
  SIGNER_ROLE_WORKER_KEY_ID: 'role-worker',
  SIGNER_ROLE_NEOX_UPDATER_KEY_ID: 'role-neox-updater',
  SIGNER_ROLE_NEOX_VERIFIER_KEY_ID: 'role-neox-verifier',
};

function runBuild(script, { args = [], env = {}, release }) {
  const ws = workspace(script);
  const eifDir = join(ws.root, 'eif');
  const result = spawnSync('bash', [join(ws.nitro, script), ...args], {
    cwd: ws.root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: {
      PATH: `${ws.bin}:${process.env.PATH}`,
      HOME: ws.root,
      MORPHEUS_RELEASE: release,
      MORPHEUS_NETWORK: 'testnet',
      NITRO_CLI_ARTIFACTS: join(ws.root, 'artifacts'),
      NITRO_CLI_BLOBS: join(ws.root, 'blobs'),
      MORPHEUS_NITRO_EIF: join(eifDir, 'oracle.eif'),
      MORPHEUS_CUSTODY_EIF: join(eifDir, 'custody.eif'),
      STUB_PROFILE_SHA256: ws.profileSha,
      ...env,
    },
  });
  assert.ifError(result.error);
  const manifestPath = join(ws.nitro, 'measurements', `${release}.json`);
  return {
    ...result,
    ws,
    manifestPath,
    manifest: existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null,
    output: `${result.stdout}${result.stderr}`,
  };
}

for (const [script, env, appId] of [
  ['build-enclave-eif.sh', ORACLE_ENV, 'morpheus-oracle'],
  ['build-custody-eif.sh', {}, 'morpheus-custody'],
]) {
  test(`${script}: verifies reproducibility by default and records that it did`, () => {
    const run = runBuild(script, { env, release: `${appId}-default` });
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /identical PCR0\/PCR1\/PCR2 across two from-scratch builds/);
    assert.ok(run.manifest, `no manifest written: ${run.output}`);
    assert.equal(run.manifest.reproducible_verified, true);
    assert.equal(run.manifest.app_id, appId);
  });

  test(`${script}: --allow-unverified is the only way to skip, and it is recorded`, () => {
    const run = runBuild(script, {
      env,
      args: ['--allow-unverified'],
      release: `${appId}-unverified`,
    });
    assert.equal(run.status, 0, run.output);
    assert.doesNotMatch(run.output, /two from-scratch builds/);
    assert.match(run.output, /--allow-unverified/);
    assert.ok(run.manifest, `no manifest written: ${run.output}`);
    assert.equal(run.manifest.reproducible_verified, false);
  });

  test(`${script}: a PCR set that drifts between builds is refused, not committed`, () => {
    const run = runBuild(script, {
      env: { ...env, STUB_PCR_DRIFT: '1' },
      release: `${appId}-drift`,
    });
    assert.notEqual(run.status, 0, run.output);
    assert.match(run.output, /NOT reproducible/);
    assert.equal(run.manifest, null, 'a non-reproducible build must not leave a manifest behind');
  });

  test(`${script}: the manifest it writes satisfies manifest.schema.json`, () => {
    const run = runBuild(script, { env, release: `${appId}-schema` });
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(validateManifestSchema(run.manifest, schema), []);
    assert.equal(
      run.manifest.hash_algorithm,
      'SHA384',
      'nitro-cli prints the algorithm in Rust Debug form; the manifest must normalise it'
    );
  });

  test(`${script}: an unknown flag is still refused`, () => {
    const run = runBuild(script, { env, args: ['--yolo'], release: `${appId}-bad-flag` });
    assert.equal(run.status, 2, run.output);
    assert.match(run.output, /unknown argument/);
  });

  test(`${script}: --verify-reproducible stays accepted for existing runbooks`, () => {
    const run = runBuild(script, {
      env,
      args: ['--verify-reproducible'],
      release: `${appId}-explicit`,
    });
    assert.equal(run.status, 0, run.output);
    assert.equal(run.manifest.reproducible_verified, true);
  });
}

test('build-enclave-eif.sh still refuses to build without the custody trust anchors', () => {
  const run = runBuild('build-enclave-eif.sh', { release: 'oracle-no-anchors' });
  assert.equal(run.status, 2, run.output);
  assert.match(run.output, /SIGNER_ROLE_\*_KEY_ID/);
});

test('build-custody-eif.sh writes the egress allowlist beside the manifest', () => {
  const run = runBuild('build-custody-eif.sh', { release: 'custody-egress' });
  assert.equal(run.status, 0, run.output);
  const files = readdirSync(join(run.ws.nitro, 'measurements'));
  assert.ok(files.includes('custody-egress.egress.yaml'), files.join(', '));
});
