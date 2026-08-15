import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'check-web-consistency.mjs'
);

describe('check-web-consistency', () => {
  it('passes against the repo with every extracted dataset non-empty', async () => {
    const { stdout } = await execFileAsync(process.execPath, [scriptPath]);
    const report = JSON.parse(stdout);

    assert.equal(report.ok, true);
    // Regression: the extractors used to demand one specific quote style while
    // the prettier-formatted sources use the other, so the builtin comparison
    // ran over two EMPTY name sets and passed vacuously (builtins_checked: 0).
    // The guard is only real while its datasets are non-empty.
    assert.ok(
      report.builtins_checked > 0,
      `builtin extraction is empty again (builtins_checked=${report.builtins_checked}); the worker/frontend comparison is vacuous`
    );
    assert.ok(
      report.feed_pairs_checked > 0,
      `feed pair extraction is empty again (feed_pairs_checked=${report.feed_pairs_checked})`
    );
  });
});
