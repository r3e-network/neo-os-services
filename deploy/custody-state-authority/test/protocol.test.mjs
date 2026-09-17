import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  canonicalOperation,
  canonicalReceipt,
  canonicalRequestProof,
  operationDigest,
} from '../src/protocol.mjs';

const vectorPath = new URL('./fixtures/protocol-v2.json', import.meta.url);

test('v2 operation and receipt canonical bytes match the cross-language golden vector', async () => {
  const vector = JSON.parse(await readFile(vectorPath, 'utf8'));
  const operation = canonicalOperation(vector.operation);
  const receipt = canonicalReceipt(vector.receipt);
  const requestProof = canonicalRequestProof(vector.request_proof);

  assert.equal(requestProof.toString('hex'), vector.request_proof_canonical_hex);
  assert.equal(
    createHash('sha256').update(requestProof).digest('hex'),
    vector.request_proof_sha256
  );
  assert.equal(operation.toString('hex'), vector.operation_canonical_hex);
  assert.equal(operationDigest(vector.operation), vector.operation_sha256);
  assert.equal(receipt.toString('hex'), vector.receipt_canonical_hex);
  assert.equal(createHash('sha256').update(receipt).digest('hex'), vector.receipt_sha256);
  assert.equal(vector.receipt.operation_digest, vector.operation_sha256);
});

test('canonical protocol rejects reordered semantic fields expressed with noncanonical counters', async () => {
  const vector = JSON.parse(await readFile(vectorPath, 'utf8'));
  assert.throws(
    () => canonicalOperation({ ...vector.operation, epoch: '07' }),
    /canonical u64 decimal string/
  );
  assert.throws(
    () =>
      canonicalReceipt({
        ...vector.receipt,
        vault_id: `A${vector.receipt.vault_id.slice(1)}`,
      }),
    /lowercase SHA-256 hex string/
  );
});
