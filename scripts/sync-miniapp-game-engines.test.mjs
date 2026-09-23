// Drift guard for the miniapp game-engine single-source pipeline
// (scripts/sync-miniapp-game-engines.mjs).
//
//   1. Re-runs the sync in a temp dir and asserts the checked-in generated
//      engines (workers/nitro-worker/src/game/engines/<name>.js) are byte
//      identical — a hand edit or an un-synced upstream change fails here.
//   2. Asserts the generated sudoku-data output stays semantically identical
//      to its TS twin (BASE_GRID/MASKS).
//   3. Re-runs the behavioral parity goldens (same vectors as
//      workers/nitro-worker/src/game/engine-parity.test.mjs).
//
// Tests 1-2 need the sibling minigames repo (and its esbuild); they self-gate
// with t.skip when it is unavailable (set MINIGAMES_ROOT to override). Test 3
// only uses checked-in files and always runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { driftReport, ENGINE_SOURCES, runEsbuild } from './sync-miniapp-game-engines.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const configuredRoot = process.env.MINIGAMES_ROOT || process.env.MINIAPPS_ROOT;
const minigamesRoot = configuredRoot
  ? path.resolve(configuredRoot)
  : path.resolve(repoRoot, '..', 'neo-os-minigames');
const esbuildCli = path.join(minigamesRoot, 'node_modules', 'esbuild', 'bin', 'esbuild');
const gameDir = path.join(repoRoot, 'workers', 'nitro-worker', 'src', 'game');

function minigamesAvailable(t) {
  if (!fs.existsSync(path.join(minigamesRoot, 'package.json'))) {
    t.skip(`minigames repo not found at ${minigamesRoot} (set MINIGAMES_ROOT)`);
    return false;
  }
  const missingSources = ENGINE_SOURCES.filter(
    (entry) => !fs.existsSync(path.join(minigamesRoot, entry.source))
  );
  if (missingSources.length > 0) {
    t.skip(`minigames source tree not available at ${minigamesRoot}/apps`);
    return false;
  }
  if (!fs.existsSync(esbuildCli)) {
    t.skip(`esbuild not available at ${esbuildCli}`);
    return false;
  }
  return true;
}

test('checked-in generated engines match a fresh sync', (t) => {
  if (!minigamesAvailable(t)) return;
  const { drifted, manifest } = driftReport({ minigamesRoot });
  assert.ok(manifest.length > 0, 'sync produced no engines');
  assert.deepStrictEqual(drifted, [], 'generated engine drift detected');
});

test('generated sudoku-data.js stays semantically identical to its TS twin', async (t) => {
  if (!minigamesAvailable(t)) return;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sudoku-data-guard-'));
  try {
    const outFile = path.join(tmpDir, 'sudoku-data.mjs');
    runEsbuild(
      esbuildCli,
      [
        'apps/sudoku/src/logic/sudoku-data.ts',
        '--format=esm',
        '--platform=node',
        '--bundle',
        `--outfile=${outFile}`,
      ],
      minigamesRoot
    );
    const upstream = await import(pathToFileURL(outFile).href);
    const local = await import(pathToFileURL(path.join(gameDir, 'engines', 'sudoku-data.js')).href);
    assert.deepStrictEqual(
      { BASE_GRID: local.BASE_GRID, MASKS: local.MASKS },
      { BASE_GRID: upstream.BASE_GRID, MASKS: upstream.MASKS },
      'sudoku-data.js drifted from apps/sudoku/src/logic/sudoku-data.ts'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('engine parity goldens still reproduce from the checked-in tree', async () => {
  const { loadWrappers, runAllVectors } = await import(
    pathToFileURL(path.join(gameDir, 'parity-vectors.mjs')).href
  );
  const goldens = JSON.parse(
    fs.readFileSync(path.join(gameDir, 'engine-parity.goldens.json'), 'utf8')
  );
  const wrappers = await loadWrappers();
  const results = runAllVectors(wrappers);
  assert.deepStrictEqual(results, goldens.engines);
});
