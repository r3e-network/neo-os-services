import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  saveFeedState,
  loadFeedState,
  resetFeedStateCache,
  getFeedStateWriteFailureCount,
  __resetFeedStateWriteFailureCountForTests,
} from './feed-state.js';

const originalFeedStatePath = process.env.MORPHEUS_FEED_STATE_PATH;
const originalBootstrap = process.env.MORPHEUS_FEED_BOOTSTRAP_SUPABASE_ENABLED;
const originalNetwork = process.env.MORPHEUS_NETWORK;

test.afterEach(() => {
  resetFeedStateCache();
  __resetFeedStateWriteFailureCountForTests();
  if (originalFeedStatePath === undefined) delete process.env.MORPHEUS_FEED_STATE_PATH;
  else process.env.MORPHEUS_FEED_STATE_PATH = originalFeedStatePath;
  if (originalBootstrap === undefined) delete process.env.MORPHEUS_FEED_BOOTSTRAP_SUPABASE_ENABLED;
  else process.env.MORPHEUS_FEED_BOOTSTRAP_SUPABASE_ENABLED = originalBootstrap;
  if (originalNetwork === undefined) delete process.env.MORPHEUS_NETWORK;
  else process.env.MORPHEUS_NETWORK = originalNetwork;
});

test('saveFeedState writes the baseline atomically and round-trips from disk (F9)', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'morpheus-feed-state-f9-'));
  process.env.MORPHEUS_FEED_STATE_PATH = path.join(tempDir, 'feed-state.json');
  process.env.MORPHEUS_FEED_BOOTSTRAP_SUPABASE_ENABLED = 'false';
  process.env.MORPHEUS_NETWORK = 'testnet';
  __resetFeedStateWriteFailureCountForTests();

  const scope = { network: 'testnet', targetChain: 'neo_n3' };
  const state = { records: { 'TWELVEDATA:NEO-USD': { price: '2.5', round_id: '9' } } };
  await saveFeedState(state, scope);

  // No leftover temp files in the directory after an atomic rename.
  const entries = await fs.readdir(tempDir);
  assert.ok(
    entries.every((name) => !name.endsWith('.tmp')),
    `expected no leftover temp files, found: ${entries.join(', ')}`
  );

  resetFeedStateCache();
  const reloaded = await loadFeedState(scope);
  assert.equal(reloaded.records['TWELVEDATA:NEO-USD'].price, '2.5');
  assert.equal(reloaded.records['TWELVEDATA:NEO-USD'].round_id, '9');
  assert.equal(getFeedStateWriteFailureCount(), 0);
});

test('saveFeedState records a write failure when the path is unwritable (F9)', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'morpheus-feed-state-f9-fail-'));
  // Point the state path at a location whose parent is a file, not a directory,
  // so mkdir/writeFile fail deterministically.
  const blockingFile = path.join(tempDir, 'blocker');
  await fs.writeFile(blockingFile, 'not-a-directory', 'utf8');
  process.env.MORPHEUS_FEED_STATE_PATH = path.join(blockingFile, 'nested', 'feed-state.json');
  process.env.MORPHEUS_FEED_BOOTSTRAP_SUPABASE_ENABLED = 'false';
  process.env.MORPHEUS_NETWORK = 'testnet';
  __resetFeedStateWriteFailureCountForTests();

  const before = getFeedStateWriteFailureCount();
  // Must not throw — persistence is best-effort — but must increment the counter.
  await saveFeedState(
    { records: { 'TWELVEDATA:NEO-USD': { price: '2.5' } } },
    { network: 'testnet', targetChain: 'neo_n3' }
  );
  assert.equal(getFeedStateWriteFailureCount(), before + 1);
});
