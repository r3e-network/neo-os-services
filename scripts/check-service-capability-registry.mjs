import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registryPath = path.resolve(
  repoRoot,
  process.env.NEOOS_SERVICE_CAPABILITY_REGISTRY || 'docs/service-capability-registry.v1.json'
);

const expectedPackages = [
  'api-gateway',
  'oracle-aggregator',
  'price-feed',
  'analytics-api',
  'order-matcher',
  'routing-engine',
];

function fail(message) {
  throw new Error(`service capability registry: ${message}`);
}

function checkRegistry(root = repoRoot, file = registryPath) {
  if (!fs.existsSync(file)) fail(`missing ${path.relative(root, file)}`);
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`invalid JSON: ${error.message}`);
  }

  if (registry.schemaVersion !== 'neoos.service-capability-registry.v1')
    fail('unexpected schemaVersion');
  if (registry.repository !== 'neo-os-services') fail('unexpected repository owner');
  if (registry.status !== 'retired-compatibility-record') {
    fail('registry must be a retired compatibility record');
  }
  if (!Array.isArray(registry.entries) || registry.entries.length !== expectedPackages.length) {
    fail(`expected ${expectedPackages.length} entries`);
  }

  const seen = new Set();
  for (const entry of registry.entries) {
    const packageName = String(entry.id || '').replace(/^neoswap\./, '');
    if (!expectedPackages.includes(packageName)) fail(`unexpected package ${entry.id}`);
    if (seen.has(packageName)) fail(`duplicate package ${packageName}`);
    seen.add(packageName);
    if (entry.legacyPath !== `services/neoswap/${packageName}`)
      fail(`${packageName} has an invalid legacyPath`);
    if (entry.plannedCanonicalPath !== `services/${packageName}`) {
      fail(`${packageName} has an invalid plannedCanonicalPath`);
    }
    if (entry.status !== 'retired') fail(`${packageName} is not retired`);
    if (entry.runtimeEnabled !== false) fail(`${packageName} must not be runtimeEnabled`);
    if (entry.compatibility?.mode !== 'read-only-registry') {
      fail(`${packageName} must use read-only-registry compatibility`);
    }
    if (entry.compatibility?.runtimeAlias !== null)
      fail(`${packageName} must not expose a runtime alias`);
    const evidencePath = entry.compatibility?.evidencePath;
    if (!evidencePath || !fs.existsSync(path.join(root, evidencePath))) {
      fail(`${packageName} must point to tracked compatibility evidence`);
    }
    if (fs.existsSync(path.join(root, entry.legacyPath))) {
      fail(`${entry.legacyPath} must remain absent; registry entries are not runtime aliases`);
    }
  }
  if (seen.size !== expectedPackages.length) fail('package set is incomplete');
  return registry;
}

checkRegistry();
console.log(
  `service capability registry: PASS (${expectedPackages.length} retired NeoSwap entries)`
);

export { checkRegistry };
