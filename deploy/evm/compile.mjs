#!/usr/bin/env node
// Compile a Solidity contract under contracts-evm/ with solc 0.8.35.
// Usage: node deploy/evm/compile.mjs MorpheusOracleEVM
//   -> writes contracts-evm/build/<Name>.abi.json + <Name>.bin
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const name = process.argv[2];
if (!name) {
  console.error('usage: compile.mjs <ContractName>');
  process.exit(1);
}
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
  console.error(`invalid contract name: ${name}`);
  process.exit(1);
}

const SOURCE_ROOT = resolve(ROOT, 'contracts-evm');
const BUILD_ROOT = resolve(process.env.MORPHEUS_EVM_BUILD_DIR || resolve(SOURCE_ROOT, 'build'));

function collectSources(directory, prefix = '') {
  const sources = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'build' || entry.name === 'cache' || entry.name === 'test') continue;
      Object.assign(sources, collectSources(absolute, relative));
    } else if (entry.isFile() && entry.name.endsWith('.sol')) {
      sources[relative] = { content: readFileSync(absolute, 'utf8') };
    }
  }
  return sources;
}

const sources = collectSources(SOURCE_ROOT);
const sourceName = `${name}.sol`;
if (!sources[sourceName]) {
  console.error(`contract source not found: ${sourceName}`);
  process.exit(1);
}
const solc = require('solc');

const input = {
  language: 'Solidity',
  // Include every local source so solc can resolve relative imports without a
  // network-backed import callback. The output remains limited to the named
  // contract below.
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'paris', // Neo X EVM compatibility (no PUSH0 / cancun opcodes)
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === 'error');
if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage);
  process.exit(1);
}
for (const w of out.errors || []) console.warn(w.formattedMessage);

const c = out.contracts[sourceName]?.[name];
if (!c) {
  console.error(`contract not found in compiler output: ${name}`);
  process.exit(1);
}
mkdirSync(BUILD_ROOT, { recursive: true });
writeFileSync(resolve(BUILD_ROOT, `${name}.abi.json`), `${JSON.stringify(c.abi, null, 2)}\n`);
writeFileSync(resolve(BUILD_ROOT, `${name}.bin`), c.evm.bytecode.object);
console.log(
  `compiled ${name}: ${c.evm.bytecode.object.length / 2} bytes, ${c.abi.length} abi entries`
);
