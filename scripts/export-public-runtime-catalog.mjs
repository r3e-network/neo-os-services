#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { format, resolveConfig } from 'prettier';
import { loadPublicRuntimeCatalog } from './lib-public-runtime-catalog.mjs';

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

async function main() {
  const { outputFile } = parseArgs(process.argv.slice(2));
  const catalog = loadPublicRuntimeCatalog();
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const prettierConfig =
    (await resolveConfig(path.join(repoRoot, 'apps/web/public/morpheus-runtime-catalog.json'))) ||
    {};
  const serialized = await format(JSON.stringify(catalog, null, 2), {
    ...prettierConfig,
    parser: 'json',
  });

  if (outputFile) {
    fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
    fs.writeFileSync(path.resolve(outputFile), serialized, 'utf8');
  }

  process.stdout.write(serialized);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
