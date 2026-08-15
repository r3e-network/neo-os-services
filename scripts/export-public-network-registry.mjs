#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { loadPublicNetworkRegistry } from './lib-public-network-registry.mjs';

function parseArgs(argv) {
  let outputFile = '';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') {
      outputFile = argv[index + 1] || '';
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { outputFile };
}

function main() {
  const { outputFile } = parseArgs(process.argv.slice(2));
  const registry = loadPublicNetworkRegistry();
  const serialized = JSON.stringify(registry, null, 2) + '\n';

  if (outputFile) {
    fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
    fs.writeFileSync(path.resolve(outputFile), serialized, 'utf8');
  }

  process.stdout.write(serialized);
}

main();
