import { trimString } from './lib-strings.mjs';
import { spawn } from 'node:child_process';
import { loadDotEnv } from './lib-env.mjs';

function hasAny(...keys) {
  return keys.some((key) => trimString(process.env[key]));
}

await loadDotEnv();

function runNodeScript(scriptPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

const shouldRunN3 = Boolean(
  trimString(process.env.CONTRACT_MORPHEUS_ORACLE_HASH) &&
  trimString(process.env.CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH) &&
  hasAny(
    'NEO_N3_WIF',
    'NEO_TESTNET_WIF',
    'MORPHEUS_RELAYER_NEO_N3_WIF',
    'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY'
  )
);
const summary = {
  neo_n3: null,
};

if (shouldRunN3) {
  summary.neo_n3 = await runNodeScript('scripts/smoke-oracle-n3.mjs');
}

console.log(JSON.stringify(summary, null, 2));

if (summary.neo_n3 && summary.neo_n3.code !== 0) {
  process.exitCode = 1;
}
