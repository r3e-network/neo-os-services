#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CANONICAL_CODE_ROOT = '/opt/neoos/services';
export const LEGACY_CODE_ROOTS = ['/opt/neo-morpheus-oracle', '/opt/morpheus/neo-morpheus-oracle'];

const expectedPackageName = '@r3e-network/neo-os-services';

function physicalPath(rootPrefix, logicalPath) {
  return path.join(path.resolve(rootPrefix), logicalPath.replace(/^\/+/, ''));
}

function assertCanonicalCheckout(canonicalPath) {
  const packagePath = path.join(canonicalPath, 'package.json');
  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `canonical NeoOS Services checkout is missing or invalid at ${canonicalPath}: ${error.message}`
    );
  }
  if (packageJson.name !== expectedPackageName) {
    throw new Error(
      `refusing unexpected checkout at ${canonicalPath}: package name is ${JSON.stringify(packageJson.name)}`
    );
  }
}

export function installCompatibilityLinks({ apply = false, rootPrefix = '/' } = {}) {
  const canonicalPath = physicalPath(rootPrefix, CANONICAL_CODE_ROOT);
  assertCanonicalCheckout(canonicalPath);

  const results = [];
  for (const logicalLegacyRoot of LEGACY_CODE_ROOTS) {
    const legacyPath = physicalPath(rootPrefix, logicalLegacyRoot);
    let stat;
    try {
      stat = fs.lstatSync(legacyPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    if (stat?.isSymbolicLink()) {
      const currentTarget = path.resolve(path.dirname(legacyPath), fs.readlinkSync(legacyPath));
      if (currentTarget !== canonicalPath) {
        throw new Error(
          `refusing to replace compatibility link ${legacyPath}; it targets ${currentTarget}`
        );
      }
      results.push({ logicalLegacyRoot, status: 'already-linked' });
      continue;
    }

    if (stat) {
      throw new Error(
        `refusing to overwrite existing non-symlink path ${legacyPath}; archive or migrate it first`
      );
    }

    if (apply) {
      fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
      fs.symlinkSync(canonicalPath, legacyPath, 'dir');
    }
    results.push({ logicalLegacyRoot, status: apply ? 'linked' : 'would-link' });
  }

  return { apply, canonicalPath, results };
}

export function parseArgs(args) {
  const options = { apply: false, rootPrefix: '/' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }
    if (arg === '--root-prefix') {
      const value = args[index + 1];
      if (!value) throw new Error('--root-prefix requires a directory');
      options.rootPrefix = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const result = installCompatibilityLinks(parseArgs(process.argv.slice(2)));
  console.log(`canonical code root: ${result.canonicalPath}`);
  for (const item of result.results) {
    console.log(`${item.status}: ${item.logicalLegacyRoot} -> ${CANONICAL_CODE_ROOT}`);
  }
  if (!result.apply && result.results.some((item) => item.status === 'would-link')) {
    console.log('dry run only; re-run with --apply after stopping affected services');
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
