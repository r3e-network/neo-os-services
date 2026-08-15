#!/usr/bin/env node

import { trimString } from './lib-strings.mjs';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeBaseUrl(baseUrl) {
  const normalized = trimString(baseUrl);
  assert(normalized, 'public runtime api base url is required');
  return normalized.replace(/\/+$/, '');
}

function buildExpectedStatusCatalog(catalog) {
  return {
    envelope: catalog.envelope,
    topology: catalog.topology,
    risk: catalog.risk,
    automation: catalog.automation,
    workflows: {
      count: catalog.workflows.length,
      ids: catalog.workflows.map((item) => item.id),
    },
    links: {
      catalog: '/api/runtime/catalog',
      workflows: '/api/workflows',
      policies: '/api/policies',
    },
  };
}

export function validatePublicRuntimeApiContract({ catalog, status }) {
  assert(isPlainObject(catalog), 'runtime catalog payload must be an object');
  assert(isPlainObject(status), 'runtime status payload must be an object');

  assert(trimString(catalog?.envelope?.version), 'runtime catalog envelope version is required');
  assert(isPlainObject(catalog.topology), 'runtime catalog topology is required');
  assert(isPlainObject(catalog.risk), 'runtime catalog risk block is required');
  assert(isPlainObject(catalog.automation), 'runtime catalog automation block is required');
  assert(Array.isArray(catalog.workflows), 'runtime catalog workflows must be an array');
  assert(
    catalog.workflows.some((item) => item?.id === 'automation.upkeep'),
    'runtime catalog must include automation.upkeep'
  );
  assert(
    Array.isArray(catalog.automation.triggerKinds) &&
      catalog.automation.triggerKinds.includes('interval'),
    'runtime catalog automation triggerKinds must include interval'
  );

  const expectedStatusCatalog = buildExpectedStatusCatalog(catalog);
  assert(isPlainObject(status.catalog), 'runtime status catalog summary is required');
  assert(
    trimString(status?.catalog?.envelope?.version) ===
      trimString(expectedStatusCatalog.envelope.version),
    'runtime status envelope version must match runtime catalog envelope version'
  );
  assert(
    trimString(status?.catalog?.topology?.executionPlane) ===
      trimString(expectedStatusCatalog.topology.executionPlane),
    'runtime status topology executionPlane must match runtime catalog topology executionPlane'
  );
  assert(
    trimString(status?.catalog?.topology?.riskPlane) ===
      trimString(expectedStatusCatalog.topology.riskPlane),
    'runtime status topology riskPlane must match runtime catalog topology riskPlane'
  );
  assert(
    Number(status?.catalog?.workflows?.count) === expectedStatusCatalog.workflows.count,
    'runtime status workflow count must match runtime catalog workflow count'
  );
  assert(
    Array.isArray(status?.catalog?.workflows?.ids) &&
      status.catalog.workflows.ids.includes('automation.upkeep'),
    'runtime status workflow ids must include automation.upkeep'
  );
  assert(
    trimString(status?.catalog?.links?.catalog) === expectedStatusCatalog.links.catalog,
    'runtime status must expose /api/runtime/catalog discovery link'
  );

  assert(isPlainObject(status.runtime), 'runtime status block is required');
  assert(
    ['operational', 'degraded', 'down'].includes(trimString(status.runtime.status)),
    'runtime status must be one of operational, degraded, or down'
  );
  assert(isPlainObject(status.runtime.health), 'runtime health block is required');
  assert(isPlainObject(status.runtime.info), 'runtime info block is required');

  return {
    envelopeVersion: expectedStatusCatalog.envelope.version,
    workflowCount: expectedStatusCatalog.workflows.count,
    runtimeStatus: trimString(status.runtime.status),
    executionPlane: trimString(expectedStatusCatalog.topology.executionPlane),
    riskPlane: trimString(expectedStatusCatalog.topology.riskPlane),
    automationTriggerKinds: [...expectedStatusCatalog.automation.triggerKinds],
  };
}

async function readJsonResponse(response, url) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${url} failed with HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `GET ${url} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function checkPublicRuntimeApi(baseUrl, fetchImpl = fetch) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const catalogUrl = `${normalizedBaseUrl}/api/runtime/catalog`;
  const statusUrl = `${normalizedBaseUrl}/api/runtime/status`;

  const [catalogResponse, statusResponse] = await Promise.all([
    fetchImpl(catalogUrl, { headers: { accept: 'application/json' } }),
    fetchImpl(statusUrl, { headers: { accept: 'application/json' } }),
  ]);

  const [catalog, status] = await Promise.all([
    readJsonResponse(catalogResponse, catalogUrl),
    readJsonResponse(statusResponse, statusUrl),
  ]);

  const summary = validatePublicRuntimeApiContract({ catalog, status });
  return {
    baseUrl: normalizedBaseUrl,
    catalogUrl,
    statusUrl,
    ...summary,
  };
}

async function main() {
  const baseUrl = process.argv[2] || process.env.MORPHEUS_PUBLIC_API_URL || '';
  const summary = await checkPublicRuntimeApi(baseUrl);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
