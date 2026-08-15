#!/usr/bin/env node

import {
  buildWorkspaceValidationData,
  writeWorkspaceValidationSecretsEnvFile,
} from './lib-workspace-validation-context.mjs';

function parseArgs(argv) {
  let network = 'testnet';
  let writeSecretEnvFile = false;
  let secretEnvFilePath = '';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === 'mainnet' || arg === 'testnet') {
      network = arg;
      continue;
    }
    if (arg === '--write-secret-env-file') {
      writeSecretEnvFile = true;
      const next = argv[index + 1] || '';
      if (next && !next.startsWith('--')) {
        secretEnvFilePath = next;
        index += 1;
      }
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { network, writeSecretEnvFile, secretEnvFilePath };
}

function main() {
  const { network, writeSecretEnvFile, secretEnvFilePath } = parseArgs(process.argv.slice(2));
  const { publicContext, secretEnv } = buildWorkspaceValidationData({ network });

  if (writeSecretEnvFile) {
    publicContext.secretsEnvFile = writeWorkspaceValidationSecretsEnvFile(
      secretEnv,
      secretEnvFilePath
    );
  }

  process.stdout.write(`${JSON.stringify(publicContext, null, 2)}\n`);
}

main();
