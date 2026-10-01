import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (file) => readFileSync(join(root, file), 'utf8');

test('the reviewed RSA advisory has an explicit, executable audit policy', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.equal(packageJson.scripts?.['check:rust:audit'], 'node scripts/check-rust-audit.mjs');

  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /npm run check:rust:audit\s/);
  assert.match(workflow, /node --test scripts\/rust-security-audit-policy\.test\.mjs/);

  const checker = read('scripts/check-rust-audit.mjs');
  assert.match(checker, /RUSTSEC-2023-0071/g);
  assert.match(checker, /--ignore/);
  assert.match(checker, /--deny/);
  assert.doesNotMatch(checker, /--no-fetch/);
  assert.match(checker, /last-updated/);
  assert.match(checker, /EXPECTED_UNMAINTAINED/);
  assert.match(checker, /vulnerabilities/);

  const review = read('docs/security/RUSTSEC-2023-0071.md');
  assert.match(review, /No fixed upgrade is available/i);
  assert.match(review, /decrypt_blinded/);
  assert.match(review, /new_blinded_with_salt/);
});
