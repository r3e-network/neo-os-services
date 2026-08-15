import { trimString } from './utils.js';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function readString(value) {
  const trimmed = trimString(value);
  return trimmed || null;
}

function getBodyDetail(body) {
  if (typeof body === 'string') {
    return readString(body);
  }
  if (!isPlainObject(body)) {
    return null;
  }
  return (
    readString(body.error) ||
    readString(body.detail) ||
    readString(body.message) ||
    readString(body.reason)
  );
}

function getHealthState(probe) {
  if (!probe?.ok) {
    return 'down';
  }

  const body = isPlainObject(probe.body) ? probe.body : {};
  const normalizedState = (readString(body.status) || readString(body.state) || '').toLowerCase();

  if (['down', 'error', 'failed', 'unhealthy'].includes(normalizedState)) {
    return 'down';
  }
  // Emergency/fallback runtimes answer with status 'ok' plus an explicit
  // degraded flag and reason (e.g. {status:'ok', degraded:true,
  // reason:'runtime_control_plane_disabled'} during a TEE outage), so
  // the status string alone must not certify the runtime as healthy.
  if (body.degraded === true || readString(body.reason)) {
    return 'degraded';
  }
  if (['degraded', 'warning'].includes(normalizedState)) {
    return 'degraded';
  }

  return 'ok';
}

function summarizeRuntimeInfo(probe) {
  const body = isPlainObject(probe?.body) ? probe.body : {};
  const dstack = isPlainObject(body.dstack) ? body.dstack : {};

  return {
    ok: Boolean(probe?.ok),
    statusCode: Number(probe?.status || 0),
    appId: readString(dstack.app_id) || readString(body.app_id),
    composeHash: readString(dstack.compose_hash) || readString(body.compose_hash),
    clientKind: readString(dstack.client_kind) || readString(body.client_kind),
    version: readString(body.version) || readString(dstack.version),
    detail: getBodyDetail(probe?.body),
  };
}

function summarizeRuntimeHealth(probe) {
  return {
    ok: Boolean(probe?.ok),
    statusCode: Number(probe?.status || 0),
    state: getHealthState(probe),
    detail: getBodyDetail(probe?.body),
  };
}

export const PUBLIC_RUNTIME_DISCOVERY_LINKS = Object.freeze({
  catalog: '/api/runtime/catalog',
  workflows: '/api/workflows',
  policies: '/api/policies',
});

export function buildPublicRuntimeCatalogSummary(catalog) {
  const workflows = Array.isArray(catalog?.workflows) ? catalog.workflows : [];

  return {
    envelope: clone(catalog?.envelope || {}),
    topology: clone(catalog?.topology || {}),
    risk: clone(catalog?.risk || {}),
    automation: clone(catalog?.automation || {}),
    workflows: {
      count: workflows.length,
      ids: workflows.map((item) => item.id),
    },
    links: { ...PUBLIC_RUNTIME_DISCOVERY_LINKS },
  };
}

// The /info metadata probe sits behind runtime auth on some deployments: a
// 401/403 there only means the optional metadata is protected, not that the
// runtime is unhealthy, so it must not degrade an otherwise-ok status.
// (The in-TEE status route does not rely on this: it supplies info from static
// config with ok:true, so an unavailable box /info never reaches this path.)
function isNonCriticalInfoAuthFailure(health, info) {
  return health.state === 'ok' && (info.statusCode === 401 || info.statusCode === 403);
}

export function buildPublicRuntimeStatusSnapshot(input) {
  const health = summarizeRuntimeHealth(input?.health || {});
  const info = summarizeRuntimeInfo(input?.info || {});

  let status = 'operational';
  if (health.state === 'down') {
    status = 'down';
  } else if (
    health.state === 'degraded' ||
    (!info.ok && !isNonCriticalInfoAuthFailure(health, info))
  ) {
    status = 'degraded';
  }

  return {
    checkedAt: input?.checkedAt || new Date().toISOString(),
    catalog: buildPublicRuntimeCatalogSummary(input?.catalog || {}),
    runtime: {
      status,
      health,
      info,
    },
  };
}

export function getPublicRuntimeStatusNotes(snapshot) {
  // automation.triggerKinds is sourced from the runtime catalog and is absent
  // on minimal/emergency catalogs (or any catalog summarized from `{}`), so
  // guard the join rather than crashing the public status notes.
  const triggerKinds = Array.isArray(snapshot.catalog.automation.triggerKinds)
    ? snapshot.catalog.automation.triggerKinds
    : [];
  const notes = [
    `Execution: ${snapshot.catalog.topology.executionPlane}`,
    `Risk: ${snapshot.catalog.topology.riskPlane}`,
    `Automation: ${triggerKinds.join(', ')}`,
  ];

  if (snapshot.runtime.info.appId) {
    notes.push(`App ID: ${snapshot.runtime.info.appId}`);
  }

  return notes;
}
