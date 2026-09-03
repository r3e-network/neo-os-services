#!/usr/bin/env node
/**
 * Freeze and verify the JavaScript parity baseline under `baselines/js-parity/`.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two JS trees are the behavioural oracle for the Rust ports:
 *
 *   workers/nitro-worker    — the 11 game wrappers, whose sha256 IS `engineHash`
 *                             (pinned in `crates/morpheus-compute/src/game/
 *                             registry.rs` ENGINE_MANIFEST) and whose recorded
 *                             op logs produced `engine-parity.goldens.json`.
 *   workers/morpheus-relayer — `router.js` / `neox.js`, the oracle behind the 8
 *                             consensus vector families exported by
 *                             `scripts/export-rust-vectors.mjs`.
 *
 * Both trees are scheduled for deletion in T05. Deleting them deletes the ONLY
 * reproducible evidence that the Rust ports are faithful:
 *
 *   - the 11 `engineHash` literals become un-rederivable — nothing in the repo
 *     could ever prove (or disprove) them again;
 *   - `export-rust-vectors.mjs --check` stops being able to regenerate its
 *     vectors from the JS oracle, so the gate degrades into comparing a
 *     committed file with a copy of itself.
 *
 * Freezing the sources byte-for-byte here keeps both guarantees alive forever.
 * The baseline is the permanent anchor; the live trees become optional inputs.
 *
 * USAGE
 *   node scripts/freeze-js-parity-baseline.mjs             # re-freeze from the live sources
 *   node scripts/freeze-js-parity-baseline.mjs --check     # verify (exit 1 on drift)
 *   node scripts/freeze-js-parity-baseline.mjs --check --verbose
 *
 * INVARIANTS CHECKED BY `--check`
 *   1. MANIFEST.sha256 lists EXACTLY the frozen assets (no missing, no extras).
 *   2. Every frozen asset hashes to its manifest entry. This one holds forever,
 *      including after the live JS trees are deleted — it is the invariant that
 *      survives T05.
 *   3. While a live source still exists, the frozen copy is byte-identical to
 *      it. This is the drift alarm: edit a wrapper without re-freezing and it
 *      fires here, in `cargo test` (see
 *      `crates/morpheus-compute/src/game/parity.rs`) and in CI.
 *   4. Mirror pairs that must stay byte-identical (the engine goldens live in
 *      two places today) really are identical.
 *
 * Re-freezing is REFUSED when a live source is gone unless `--force` is passed,
 * so a run after T05 can never silently blank the baseline.
 *
 * The manifest is `sha256sum -c` compatible:
 *   cd baselines/js-parity && sha256sum -c MANIFEST.sha256
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineDir = path.join(repoRoot, 'baselines', 'js-parity');

/**
 * The frozen asset table.
 *
 * `frozen` — path relative to `baselines/js-parity/`.
 * `source` — path relative to the repo root, i.e. the LIVE production file.
 * `why`    — what breaks if this asset is lost.
 */
const ASSETS = [
  {
    frozen: 'engine-parity.goldens.json',
    source: 'workers/nitro-worker/src/game/engine-parity.goldens.json',
    why: '112KB of recorded per-op view/state hashes + replay + score outcomes; the only proof the 11 Rust engines equal the JS engines.',
  },
  {
    frozen: 'stable-stringify-vectors.mjs',
    source: 'packages/shared/src/stable-stringify-vectors.mjs',
    why: 'The pinned stableStringify golden vectors. packages/shared survives T05, but freezing keeps the export script independent of it.',
  },
  ...[
    'aim.wrapper.js',
    'arrow.wrapper.js',
    'color.wrapper.js',
    'flappy.wrapper.js',
    'game2048.wrapper.js',
    'jump.wrapper.js',
    'merge.wrapper.js',
    'pet.wrapper.js',
    'sheep.wrapper.js',
    'snake.wrapper.js',
    'sudoku.wrapper.js',
  ].map((file) => ({
    frozen: path.posix.join('wrappers', file),
    source: `workers/nitro-worker/src/game/wrappers/${file}`,
    why: 'sha256 of this file (CRLF-normalized) IS the engineHash literal in registry.rs. Lose the file and the pin can never be re-derived.',
  })),
  {
    frozen: 'oracle/router.js',
    source: 'workers/morpheus-relayer/src/router.js',
    why: 'JS oracle for the fulfillment_digest / fulfillment_envelope / worker_payload vector families.',
  },
  {
    frozen: 'oracle/neox.js',
    source: 'workers/morpheus-relayer/src/neox.js',
    why: 'JS oracle for the neox_digest vector family.',
  },
  {
    frozen: 'oracle/lib/strings.js',
    source: 'workers/morpheus-relayer/src/lib/strings.js',
    why: 'Relative import of router.js (strict trimString / normalizeRequestType / strip0x) — the closure needed to run the oracle after the relayer tree is deleted.',
  },
];

/**
 * Pairs that must stay byte-identical. The goldens are duplicated in the
 * compute crate because `include_str!` needs them inside the crate; the two
 * copies diverging would mean the Rust parity driver tests a different corpus
 * than the JS recorder produced.
 */
const MIRRORS = [
  {
    left: 'workers/nitro-worker/src/game/engine-parity.goldens.json',
    right: 'crates/morpheus-compute/src/game/engine-parity.goldens.json',
  },
];

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function readIfPresent(root, relativePath) {
  const absolute = path.join(root, relativePath);
  if (!existsSync(absolute)) return null;
  return readFileSync(absolute);
}

function manifestPath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function buildManifest() {
  const lines = [
    '# Frozen JS parity baseline — DO NOT EDIT BY HAND.',
    '#',
    `# Generated by scripts/${path.basename(fileURLToPath(import.meta.url))}.`,
    '# Regenerate with: node scripts/freeze-js-parity-baseline.mjs',
    '# Verify with:     node scripts/freeze-js-parity-baseline.mjs --check',
    '#',
    '# Paths are relative to baselines/js-parity/, so this file is also usable as:',
    '#   cd baselines/js-parity && sha256sum -c MANIFEST.sha256',
    '#',
    '# These assets are the permanent anchor for `engineHash` and for the 8',
    '# consensus vector families. Reformatting them changes their sha256 and',
    '# silently invalidates every pin derived from them — which is why',
    '# baselines/ is listed in .prettierignore and in the eslint ignorePatterns.',
  ];
  for (const asset of ASSETS) {
    const bytes = readFileSync(path.join(baselineDir, asset.frozen));
    lines.push(`${sha256(bytes)}  ${manifestPath(asset.frozen)}`);
  }
  return `${lines.join('\n')}\n`;
}

function freeze({ verbose }) {
  const missing = ASSETS.filter(
    (asset) => !existsSync(path.join(repoRoot, asset.source))
  );
  if (missing.length > 0) {
    throw new Error(
      `refusing to re-freeze: ${missing.length} live source(s) are gone ` +
        `(${missing.map((a) => a.source).join(', ')}).\n` +
        'Re-freezing would blank the baseline. Pass --force only if the JS trees ' +
        'were intentionally retired AND every remaining asset is still present.'
    );
  }

  for (const asset of ASSETS) {
    const target = path.join(baselineDir, asset.frozen);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(repoRoot, asset.source), target);
    if (verbose) console.log(`froze ${manifestPath(asset.frozen)} <- ${asset.source}`);
  }

  writeFileSync(path.join(baselineDir, 'MANIFEST.sha256'), buildManifest());
  console.log(
    `froze ${ASSETS.length} asset(s) into baselines/js-parity/ and wrote MANIFEST.sha256`
  );
}

/**
 * Verify the baseline. Returns the list of failures (empty === healthy) so the
 * Rust-migration gate can import this instead of spawning a process.
 */
export function verifyJsParityBaseline(root = repoRoot) {
  const failures = [];
  const base = path.join(root, 'baselines', 'js-parity');

  if (!existsSync(base)) {
    return ['baselines/js-parity: frozen baseline directory is missing'];
  }

  const manifestFile = path.join(base, 'MANIFEST.sha256');
  if (!existsSync(manifestFile)) {
    return ['baselines/js-parity/MANIFEST.sha256: frozen baseline manifest is missing'];
  }

  const manifest = new Map();
  for (const rawLine of readFileSync(manifestFile, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([0-9a-f]{64})\s\s(.+)$/.exec(line);
    if (!match) {
      failures.push(`baselines/js-parity/MANIFEST.sha256: unparseable line: ${line}`);
      continue;
    }
    manifest.set(match[2], match[1]);
  }

  const expected = new Set(ASSETS.map((asset) => manifestPath(asset.frozen)));
  for (const entry of expected) {
    if (!manifest.has(entry)) {
      failures.push(`baselines/js-parity/MANIFEST.sha256: missing entry for ${entry}`);
    }
  }
  for (const entry of manifest.keys()) {
    if (!expected.has(entry)) {
      failures.push(
        `baselines/js-parity/MANIFEST.sha256: unexpected entry ${entry} (unknown frozen asset)`
      );
    }
  }

  let liveSourcesPresent = 0;
  for (const asset of ASSETS) {
    const key = manifestPath(asset.frozen);
    const frozenBytes = readIfPresent(base, asset.frozen);
    if (frozenBytes === null) {
      failures.push(`baselines/js-parity/${key}: frozen asset is missing`);
      continue;
    }
    const frozenHash = sha256(frozenBytes);
    const pinned = manifest.get(key);
    if (pinned && frozenHash !== pinned) {
      failures.push(
        `baselines/js-parity/${key}: frozen asset drifted from MANIFEST.sha256 ` +
          `(expected ${pinned}, got ${frozenHash})`
      );
    }

    const liveBytes = readIfPresent(root, asset.source);
    if (liveBytes === null) continue;
    liveSourcesPresent += 1;
    if (sha256(liveBytes) !== frozenHash) {
      failures.push(
        `baselines/js-parity/${key}: frozen copy no longer matches its live source ` +
          `${asset.source} — re-run node scripts/freeze-js-parity-baseline.mjs`
      );
    }
  }

  for (const mirror of MIRRORS) {
    const left = readIfPresent(root, mirror.left);
    const right = readIfPresent(root, mirror.right);
    if (left === null || right === null) continue;
    if (sha256(left) !== sha256(right)) {
      failures.push(`${mirror.left} and ${mirror.right} must stay byte-identical`);
    }
  }

  if (failures.length === 0) {
    console.log(
      `frozen JS parity baseline verified: ${ASSETS.length} asset(s), ` +
        `${liveSourcesPresent} live source(s) still compared`
    );
  }
  return failures;
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const verbose = args.includes('--verbose');

  if (check) {
    const failures = verifyJsParityBaseline(repoRoot);
    if (failures.length > 0) {
      console.error('Frozen JS parity baseline check failed:');
      for (const failure of failures) console.error(`- ${failure}`);
      process.exitCode = 1;
      return;
    }
    return;
  }

  freeze({ verbose });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
