#!/usr/bin/env node
// Capture (or verify) the engine parity goldens — the behavioral safety net for
// the miniapp game-engine single-source pipeline.
//
//   node scripts/capture-miniapp-engine-goldens.mjs          # write goldens
//   node scripts/capture-miniapp-engine-goldens.mjs --check  # diff live vs goldens
//
// The goldens (workers/nitro-worker/src/game/engine-parity.goldens.json) freeze
// each engine wrapper's behavior — fixed 32-byte seeds -> initial-state hash;
// scripted op sequences -> per-op state/view hashes, replay hash, canonical
// score. Capture them from the REVIEWED engines before swapping an engine to
// its generated twin; afterwards `--check` (and engine-parity.test.mjs) must
// stay green, or the swap changed behavior.
//
// Override the goldens path with ENGINE_PARITY_GOLDENS (used by tests).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gameDir = path.join(repoRoot, 'workers', 'nitro-worker', 'src', 'game');
const goldensPath = process.env.ENGINE_PARITY_GOLDENS
  ? path.resolve(process.env.ENGINE_PARITY_GOLDENS)
  : path.join(gameDir, 'engine-parity.goldens.json');

const { loadWrappers, runAllVectors, vectorPlans } = await import(
  pathToFileURL(path.join(gameDir, 'parity-vectors.mjs')).href
);

// Walk two structured outcomes and return a list of precise divergence paths.
function diffOutcomes(expected, actual, trail, diffs) {
  if (typeof expected !== typeof actual) {
    diffs.push(`${trail}: type ${typeof expected} -> ${typeof actual}`);
    return;
  }
  if (expected === null || typeof expected !== 'object') {
    if (expected !== actual)
      diffs.push(`${trail}: ${JSON.stringify(expected)} -> ${JSON.stringify(actual)}`);
    return;
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) {
    diffs.push(`${trail}: array shape changed`);
    return;
  }
  if (Array.isArray(expected)) {
    if (expected.length !== actual.length) {
      diffs.push(`${trail}: length ${expected.length} -> ${actual.length}`);
      return;
    }
    for (let i = 0; i < expected.length; i += 1) {
      diffOutcomes(expected[i], actual[i], `${trail}[${i}]`, diffs);
    }
    return;
  }
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of [...keys].sort()) {
    if (!(key in expected)) diffs.push(`${trail}.${key}: added (${JSON.stringify(actual[key])})`);
    else if (!(key in actual))
      diffs.push(`${trail}.${key}: removed (was ${JSON.stringify(expected[key])})`);
    else diffOutcomes(expected[key], actual[key], `${trail}.${key}`, diffs);
  }
}

async function main() {
  const check = process.argv.includes('--check');
  const wrappers = await loadWrappers();
  const plans = vectorPlans();
  const results = runAllVectors(wrappers, plans);

  if (!check) {
    const body = {
      tool: 'scripts/capture-miniapp-engine-goldens.mjs',
      surface: 'workers/nitro-worker/src/game/wrappers ABI (deal/applyOp/applyUndo/replay/score)',
      note: 'Frozen behavior of the reviewed engines. Regenerate only with a reviewed rule change; engine-parity.test.mjs asserts the live tree reproduces these vectors.',
      engines: results,
    };
    fs.writeFileSync(goldensPath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    const count = Object.values(results).reduce((n, r) => n + r.vectors.length, 0);
    console.log(
      `Captured ${count} parity vectors for ${Object.keys(results).length} engines -> ${path.relative(repoRoot, goldensPath)}`
    );
    return;
  }

  if (!fs.existsSync(goldensPath)) {
    throw new Error(`missing goldens: ${goldensPath} (run without --check first)`);
  }
  const expected = JSON.parse(fs.readFileSync(goldensPath, 'utf8')).engines;

  let failed = false;
  for (const [appId, result] of Object.entries(results)) {
    const exp = expected[appId];
    if (!exp) {
      console.error(`✖ ${appId}: no goldens recorded`);
      failed = true;
      continue;
    }
    const diffs = [];
    diffOutcomes(exp, result, appId, diffs);
    if (diffs.length > 0) {
      failed = true;
      console.error(`✖ ${appId}: ${diffs.length} divergence(s)`);
      for (const line of diffs.slice(0, 12)) console.error(`    ${line}`);
      if (diffs.length > 12) console.error(`    … and ${diffs.length - 12} more`);
    } else {
      console.log(`✔ ${appId}: ${result.vectors.length} vector(s) identical`);
    }
  }
  for (const appId of Object.keys(expected)) {
    if (!results[appId]) {
      console.error(`✖ ${appId}: goldens recorded but engine no longer runs`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
  else console.log('All engine parity vectors match the goldens.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
