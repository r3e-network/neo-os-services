import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseEnvFileAssignments } from '../feed-pusher/lib-feed-network.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

function readRepo(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

const LIVE_MAINNET = Object.freeze({
  cid: '16',
  hostPort: '8787',
  eif: '/opt/morpheus/nitro/morpheus-oracle.eif',
  nitroEnv: '/opt/morpheus/nitro/morpheus-nitro.env',
  signerEnv: '/opt/morpheus/nitro/morpheus-nitro-signer.env',
  feedEnv: '/opt/morpheus/nitro/feed-pusher.env',
  workerEnv: '/opt/morpheus/nitro/nitro-worker.env',
  signerUnit: 'morpheus-nitro-signer.service',
});

test('testnet nitro env example does not reuse live CID, host port, EIF, or signer env', () => {
  const assigned = parseEnvFileAssignments(
    readRepo('deploy/nitro/morpheus-nitro-testnet.env.example')
  );
  assert.equal(assigned.MORPHEUS_NETWORK, 'testnet');
  assert.equal(assigned.MORPHEUS_NITRO_CID, '17');
  assert.equal(assigned.MORPHEUS_NITRO_HOST_PORT, '8789');
  assert.equal(assigned.MORPHEUS_NITRO_EIF, '/opt/morpheus/nitro/morpheus-oracle-testnet.eif');
  assert.equal(
    assigned.MORPHEUS_NITRO_SIGNER_ENV,
    '/opt/morpheus/nitro/morpheus-nitro-signer-testnet.env'
  );
  assert.equal(assigned.MORPHEUS_RUNTIME_URL, 'http://127.0.0.1:8789');
  assert.notEqual(assigned.MORPHEUS_NITRO_CID, LIVE_MAINNET.cid);
  assert.notEqual(assigned.MORPHEUS_NITRO_HOST_PORT, LIVE_MAINNET.hostPort);
  assert.notEqual(assigned.MORPHEUS_NITRO_EIF, LIVE_MAINNET.eif);
  assert.notEqual(assigned.MORPHEUS_NITRO_SIGNER_ENV, LIVE_MAINNET.signerEnv);
});

test('testnet signer env example is network-pinned and does not assign ciphertext values', () => {
  const assigned = parseEnvFileAssignments(
    readRepo('deploy/nitro/morpheus-nitro-signer-testnet.env.example')
  );
  assert.equal(assigned.MORPHEUS_NETWORK, 'testnet');
  assert.equal(assigned.MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64, '');
  assert.equal(assigned.MORPHEUS_UPDATER_NEO_N3_KMS_CIPHERTEXT_BASE64, '');
  assert.equal(assigned.MORPHEUS_ORACLE_VERIFIER_KMS_CIPHERTEXT_BASE64, '');
  assert.match(
    readRepo('deploy/nitro/morpheus-nitro-signer-testnet.env.example'),
    /"network":"testnet"/
  );
});

test('testnet nitro units bind distinct env files and do not PartOf the live signer', () => {
  const signer = readRepo('deploy/systemd/morpheus-nitro-signer-testnet.service');
  const provision = readRepo('deploy/systemd/morpheus-nitro-provision-testnet.service');
  const liveSigner = readRepo('deploy/systemd/morpheus-nitro-signer.service');
  assert.match(signer, /^EnvironmentFile=\/opt\/morpheus\/nitro\/morpheus-nitro-testnet\.env$/m);
  assert.doesNotMatch(signer, new RegExp(LIVE_MAINNET.nitroEnv.replace(/\//g, '\\/')));
  assert.match(
    signer,
    /^ExecStart=\/usr\/bin\/env MORPHEUS_NITRO_ENV=\/opt\/morpheus\/nitro\/morpheus-nitro-testnet\.env \/opt\/neoos\/services\/deploy\/nitro\/start-nitro-signer\.sh$/m
  );
  assert.doesNotMatch(
    signer,
    /^ExecStart=\/opt\/neoos\/services\/deploy\/nitro\/start-nitro-signer\.sh$/m
  );
  assert.doesNotMatch(signer, /^Conflicts=/m);
  assert.match(liveSigner, /^EnvironmentFile=\/opt\/morpheus\/nitro\/morpheus-nitro\.env$/m);
  assert.match(provision, /^PartOf=morpheus-nitro-signer-testnet\.service$/m);
  assert.doesNotMatch(provision, /^PartOf=morpheus-nitro-signer\.service$/m);
  assert.match(provision, /^Environment=MORPHEUS_NITRO_HOST_PORT=8789$/m);
  assert.match(
    provision,
    /^Environment=MORPHEUS_NITRO_SIGNER_ENV=\/opt\/morpheus\/nitro\/morpheus-nitro-signer-testnet\.env$/m
  );
  assert.match(
    provision,
    /^Environment=MORPHEUS_NITRO_FEED_ENV=\/opt\/morpheus\/nitro\/feed-pusher-testnet\.env$/m
  );
  assert.match(
    provision,
    /^Environment=MORPHEUS_NITRO_WORKER_ENV=\/opt\/morpheus\/nitro\/nitro-worker-testnet\.env$/m
  );
  assert.doesNotMatch(provision, new RegExp(LIVE_MAINNET.feedEnv.replace(/\//g, '\\/')));
  assert.doesNotMatch(provision, new RegExp(LIVE_MAINNET.signerEnv.replace(/\//g, '\\/')));
});

test('start-nitro-signer refuses to terminate a non-testnet occupant when testnet-pinned', () => {
  const source = readRepo('deploy/nitro/start-nitro-signer.sh');
  assert.match(
    source,
    /env_file="\$\{MORPHEUS_NITRO_ENV:-\/opt\/morpheus\/nitro\/morpheus-nitro\.env\}"/
  );
  assert.match(source, /MORPHEUS_NITRO_CID:-16/);
  assert.match(source, /MORPHEUS_NITRO_HOST_PORT:-8787/);
  assert.match(source, /existing_name=/);
  assert.match(source, /MORPHEUS_NETWORK:-/);
  assert.match(source, /testnet signer refuses to terminate foreign enclave/);
  assert.match(source, /existing_name\}" != \*testnet\*/);
});

test('docs name the TestNet signer isolation primitive and the live allocator limit', () => {
  const docs = readRepo('docs/TESTNET-FEED-WRITER.md');
  assert.match(docs, /morpheus-nitro-signer-testnet/);
  assert.match(docs, /SIGNER_URL=http:\/\/127\.0\.0\.1:8789/);
  assert.match(docs, /CID 17/);
  assert.match(docs, /allocator/);
  assert.match(docs, /i-0c52851f134db20ee/);
  assert.doesNotMatch(docs, /GET 127\.0\.0\.1:8787\/health/);
});
