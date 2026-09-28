// The Neo X tools that sign and send transactions used to fall back to
// NEOX_NET=neox-mainnet (and a mainnet RPC) when the variable was unset, so a
// forgotten variable meant a mainnet write. Each must now refuse to start
// without an explicit network, before it reads a key or opens a provider.
//
// NEOX_RPC points at a closed local port so that no run of this test can reach
// a real node, whatever the scripts do.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const TOOLS = [
  ['deploy.mjs', ['MorpheusOracleEVM']],
  ['oracle-admin.mjs', ['info']],
  ['validate-dice.mjs', []],
  ['validate-http.mjs', []],
  ['validate-vrf.mjs', []],
  ['neox-fulfiller.mjs', []],
];

function run(script, args, environment) {
  return spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env.PATH ?? '',
      NEOX_RPC: 'http://127.0.0.1:9',
      // Lets the fulfiller past its development-only opt-in, where the
      // network is read; production still exits 78 before that (see
      // neox-fulfiller.test.mjs).
      NODE_ENV: 'development',
      MORPHEUS_ALLOW_INSECURE_HOST_EVM_SIGNER: 'true',
      ...environment,
    },
  });
}

for (const [script, args] of TOOLS) {
  test(`${script} refuses to run without NEOX_NET`, () => {
    const result = run(script, args, {});
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /NEOX_NET is required/);
  });

  test(`${script} refuses an unreviewed NEOX_NET`, () => {
    const result = run(script, args, { NEOX_NET: 'neox-staging' });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /unsupported EVM network label: neox-staging/);
  });
}
