import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildPublicRuntimeStatusSnapshot } from '../packages/shared/src/public-runtime.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const runtimeCatalog = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, 'apps', 'web', 'public', 'morpheus-runtime-catalog.json'),
    'utf8'
  )
);

function buildStatusSnapshot(catalog) {
  return buildPublicRuntimeStatusSnapshot({
    catalog,
    checkedAt: '2026-04-10T00:00:00.000Z',
    health: {
      ok: true,
      status: 200,
      body: { status: 'ok' },
    },
    info: {
      ok: true,
      status: 200,
      body: {
        version: '1.2.3',
        dstack: {
          app_id: 'app-123',
          compose_hash: 'compose-123',
          client_kind: 'dstack',
        },
      },
    },
  });
}

test('validatePublicRuntimeApiContract accepts a valid runtime catalog and status pair', async () => {
  const { validatePublicRuntimeApiContract } = await import('./check-public-runtime-api.mjs');

  const summary = validatePublicRuntimeApiContract({
    catalog: runtimeCatalog,
    status: buildStatusSnapshot(runtimeCatalog),
  });

  assert.equal(summary.envelopeVersion, runtimeCatalog.envelope.version);
  assert.equal(summary.runtimeStatus, 'operational');
  assert.equal(summary.executionPlane, runtimeCatalog.topology.executionPlane);
  assert.equal(summary.workflowCount, runtimeCatalog.workflows.length);
});

test('validatePublicRuntimeApiContract rejects envelope drift between catalog and status', async () => {
  const { validatePublicRuntimeApiContract } = await import('./check-public-runtime-api.mjs');

  const status = buildStatusSnapshot(runtimeCatalog);
  status.catalog.envelope = { version: 'drifted-version' };

  assert.throws(
    () => validatePublicRuntimeApiContract({ catalog: runtimeCatalog, status }),
    /envelope version/i
  );
});

test('validatePublicRuntimeApiContract rejects catalogs missing automation.upkeep', async () => {
  const { validatePublicRuntimeApiContract } = await import('./check-public-runtime-api.mjs');

  const invalidCatalog = {
    ...runtimeCatalog,
    workflows: runtimeCatalog.workflows.filter((item) => item.id !== 'automation.upkeep'),
  };

  assert.throws(
    () =>
      validatePublicRuntimeApiContract({
        catalog: invalidCatalog,
        status: buildStatusSnapshot(runtimeCatalog),
      }),
    /automation\.upkeep/i
  );
});

test('validatePublicRuntimeApiContract rejects unknown runtime status values', async () => {
  const { validatePublicRuntimeApiContract } = await import('./check-public-runtime-api.mjs');

  const status = buildStatusSnapshot(runtimeCatalog);
  status.runtime.status = 'mystery';

  assert.throws(
    () => validatePublicRuntimeApiContract({ catalog: runtimeCatalog, status }),
    /runtime status/i
  );
});
