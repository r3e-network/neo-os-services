#!/usr/bin/env node
/** Verify the hermetic NeoDID snapshot and optional sibling checkout parity. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const pin = JSON.parse(readFileSync(join(root, 'vendor/neo-os-did.pin.json'), 'utf8'));
if (pin.schemaVersion !== 1 || !pin.repository || !/^[0-9a-f]{40}$/.test(pin.commit)) {
  throw new Error('invalid NeoDID vendor pin');
}
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
for (const entry of pin.files) {
  const vendor = join(root, entry.vendor);
  if (!existsSync(vendor)) throw new Error(`missing vendored NeoDID file: ${entry.vendor}`);
  const actual = digest(vendor);
  if (actual !== entry.sha256) {
    throw new Error(`NeoDID vendor drift: ${entry.vendor} expected ${entry.sha256} got ${actual}`);
  }
}
const siblingCandidates = process.env.NEOOS_DID_CHECKOUT
  ? [resolve(process.env.NEOOS_DID_CHECKOUT)]
  : [resolve(root, '..', 'neo-os-did'), resolve(root, '..', '..', 'neo-os-did')];
const sibling = siblingCandidates.find((candidate) => existsSync(join(candidate, '.git')));
if (sibling) {
  let head;
  try {
    head = execFileSync('git', ['-C', sibling, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(`could not read NeoDID sibling checkout: ${error.message}`);
  }
  if (head !== pin.commit) throw new Error(`NeoDID sibling drift: expected ${pin.commit}, got ${head}`);
  for (const entry of pin.files) {
    const source = join(sibling, entry.source);
    if (!existsSync(source)) throw new Error(`missing NeoDID sibling source: ${entry.source}`);
    const actual = digest(source);
    if (actual !== entry.sha256) throw new Error(`NeoDID source/vendor mismatch: ${entry.source}`);
  }
}
console.log(JSON.stringify({ repository: pin.repository, commit: pin.commit, files: pin.files.length, siblingChecked: Boolean(sibling) }));
