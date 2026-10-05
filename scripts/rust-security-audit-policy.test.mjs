import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (file) => readFileSync(join(root, file), 'utf8');

test('the Rust audit is an executable no-vulnerability release policy', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.equal(packageJson.scripts?.['check:rust:audit'], 'node scripts/check-rust-audit.mjs');

  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /npm run check:rust:audit\s/);
  assert.match(workflow, /node --test scripts\/rust-security-audit-policy\.test\.mjs/);

  const checker = read('scripts/check-rust-audit.mjs');
  assert.doesNotMatch(checker, /--ignore/);
  assert.match(checker, /--deny/);
  assert.doesNotMatch(checker, /--no-fetch/);
  assert.match(checker, /last-updated/);
  assert.match(checker, /REVIEWED_UNMAINTAINED/);
  assert.match(checker, /owner/);
  assert.match(checker, /reason/);
  assert.match(checker, /expiresOn/);
  assert.match(checker, /audit\.toml/);
  assert.match(checker, /vulnerabilities/);

  const review = read('docs/security/RUSTSEC-2023-0071.md');
  assert.match(review, /aws-lc-rs/i);
  assert.doesNotMatch(review, /reviewed exception/i);
  assert.match(review, /no vulnerability exception/i);
});
