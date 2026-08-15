import test from 'node:test';
import assert from 'node:assert/strict';

import runtimeCatalog from '../../../apps/web/public/morpheus-runtime-catalog.json' with { type: 'json' };
import {
  buildPublicRuntimeCatalogSummary,
  buildPublicRuntimeStatusSnapshot,
  getPublicRuntimeStatusNotes,
} from './public-runtime.js';

test('buildPublicRuntimeCatalogSummary preserves canonical discovery links and workflow ids', () => {
  const summary = buildPublicRuntimeCatalogSummary(runtimeCatalog);

  assert.equal(summary.envelope.version, runtimeCatalog.envelope.version);
  assert.equal(summary.topology.executionPlane, 'tee_runtime');
  assert.equal(summary.risk.observer, 'independent_observer');
  assert.equal(summary.workflows.count, runtimeCatalog.workflows.length);
  assert.ok(summary.workflows.ids.includes('automation.upkeep'));
  assert.deepEqual(summary.links, {
    catalog: '/api/runtime/catalog',
    workflows: '/api/workflows',
    policies: '/api/policies',
  });
});

test('buildPublicRuntimeStatusSnapshot combines origin probes into an operational public snapshot', () => {
  const snapshot = buildPublicRuntimeStatusSnapshot({
    catalog: runtimeCatalog,
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
          compose_hash: 'compose-hash-123',
          client_kind: 'dstack',
        },
      },
    },
  });

  assert.equal(snapshot.catalog.envelope.version, runtimeCatalog.envelope.version);
  assert.equal(snapshot.catalog.workflows.count, runtimeCatalog.workflows.length);
  assert.equal(snapshot.catalog.links.catalog, '/api/runtime/catalog');
  assert.equal(snapshot.runtime.status, 'operational');
  assert.equal(snapshot.runtime.health.state, 'ok');
  assert.equal(snapshot.runtime.info.appId, 'app-123');
  assert.equal(snapshot.runtime.info.composeHash, 'compose-hash-123');
});

test('buildPublicRuntimeStatusSnapshot reports the emergency shim payload as degraded despite status ok', () => {
  // Exact live payload served by the emergency fallback runtime during a TEE
  // outage: HTTP 200 + status 'ok' but explicitly degraded with a reason.
  const snapshot = buildPublicRuntimeStatusSnapshot({
    catalog: runtimeCatalog,
    checkedAt: '2026-06-11T00:00:00.000Z',
    health: {
      ok: true,
      status: 200,
      body: {
        status: 'ok',
        degraded: true,
        reason: 'runtime_control_plane_disabled',
      },
    },
    info: {
      ok: true,
      status: 200,
      body: { version: 'emergency-vercel-runtime' },
    },
  });

  assert.equal(snapshot.runtime.status, 'degraded');
  assert.equal(snapshot.runtime.health.state, 'degraded');
  assert.equal(snapshot.runtime.health.detail, 'runtime_control_plane_disabled');
});

test('buildPublicRuntimeStatusSnapshot keeps a down status string authoritative over the degraded flag', () => {
  const snapshot = buildPublicRuntimeStatusSnapshot({
    catalog: runtimeCatalog,
    checkedAt: '2026-06-11T00:00:00.000Z',
    health: {
      ok: true,
      status: 200,
      body: { status: 'down', degraded: true, reason: 'runtime offline' },
    },
    info: {
      ok: false,
      status: 503,
      body: { error: 'runtime info unavailable' },
    },
  });

  assert.equal(snapshot.runtime.status, 'down');
  assert.equal(snapshot.runtime.health.state, 'down');
});

test('buildPublicRuntimeStatusSnapshot reports degraded when info is unavailable but health is ok', () => {
  const snapshot = buildPublicRuntimeStatusSnapshot({
    catalog: runtimeCatalog,
    checkedAt: '2026-04-10T00:00:00.000Z',
    health: {
      ok: true,
      status: 200,
      body: { status: 'ok' },
    },
    info: {
      ok: false,
      status: 503,
      body: { error: 'runtime info unavailable' },
    },
  });

  assert.equal(snapshot.runtime.status, 'degraded');
  assert.equal(snapshot.runtime.info.ok, false);
  assert.equal(snapshot.runtime.info.detail, 'runtime info unavailable');
});

test('buildPublicRuntimeStatusSnapshot keeps the runtime operational when info metadata is auth-protected', () => {
  // /info can sit behind runtime auth: a 401/403 there only means the optional
  // metadata is protected, not that the runtime is unhealthy.
  const snapshot = buildPublicRuntimeStatusSnapshot({
    catalog: runtimeCatalog,
    checkedAt: '2026-04-10T00:00:00.000Z',
    health: {
      ok: true,
      status: 200,
      body: { status: 'ok' },
    },
    info: {
      ok: false,
      status: 401,
      body: { error: 'unauthorized' },
    },
  });

  assert.equal(snapshot.runtime.status, 'operational');
  assert.equal(snapshot.runtime.health.state, 'ok');
  assert.equal(snapshot.runtime.info.ok, false);
  assert.equal(snapshot.runtime.info.detail, 'unauthorized');
});

test('buildPublicRuntimeStatusSnapshot reports the runtime down when the health probe is unavailable', () => {
  const snapshot = buildPublicRuntimeStatusSnapshot({
    catalog: runtimeCatalog,
    checkedAt: '2026-04-10T00:00:00.000Z',
    health: {
      ok: false,
      status: 503,
      body: { error: 'upstream unavailable' },
    },
    info: {
      ok: true,
      status: 200,
      body: {
        dstack: {
          app_id: 'app-123',
        },
      },
    },
  });

  assert.equal(snapshot.runtime.status, 'down');
  assert.equal(snapshot.runtime.health.state, 'down');
  assert.equal(snapshot.runtime.health.detail, 'upstream unavailable');
});

test('getPublicRuntimeStatusNotes builds the public status notes from catalog and runtime info', () => {
  const snapshot = buildPublicRuntimeStatusSnapshot({
    catalog: runtimeCatalog,
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
        dstack: {
          app_id: 'app-123',
        },
      },
    },
  });

  assert.deepEqual(getPublicRuntimeStatusNotes(snapshot), [
    'Execution: tee_runtime',
    'Risk: independent_observer',
    'Automation: interval, threshold',
    'App ID: app-123',
  ]);
});

test('getPublicRuntimeStatusNotes tolerates a catalog without automation.triggerKinds', () => {
  // A minimal/emergency catalog summarizes to automation:{} (no triggerKinds).
  // The notes builder must not crash on the missing array.
  const snapshot = buildPublicRuntimeStatusSnapshot({
    catalog: {},
    checkedAt: '2026-06-14T00:00:00.000Z',
    health: { ok: true, status: 200, body: { status: 'ok' } },
    info: { ok: true, status: 200, body: {} },
  });

  assert.deepEqual(snapshot.catalog.automation, {});

  const notes = getPublicRuntimeStatusNotes(snapshot);
  assert.deepEqual(notes, ['Execution: undefined', 'Risk: undefined', 'Automation: ']);
});
