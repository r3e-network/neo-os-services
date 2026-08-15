import { getPublicWorkflowCatalog } from './workflow-runtime';
import { buildPublicRuntimeStatusSnapshot } from '@r3e-network/neo-os-services-shared/public-runtime';
import { fetchBoxHealth, buildStaticRuntimeInfo } from './runtime-health';

/**
 * Build the public runtime status snapshot from trustless sources — the
 * attested box /health (liveness), the configured enclave identity, and the
 * static workflow catalog. Extracted from the route handler so it can be
 * reused by the dashboard aggregate endpoint without duplicating logic.
 */
export async function buildRuntimeStatusSnapshotForNetwork(
  networkOverride?: string | null
): Promise<ReturnType<typeof buildPublicRuntimeStatusSnapshot>> {
  const checkedAt = new Date().toISOString();
  const catalog = getPublicWorkflowCatalog() as { envelope?: { version?: string } };
  const version = catalog?.envelope?.version || null;

  const boxHealth = await fetchBoxHealth(networkOverride);
  return buildPublicRuntimeStatusSnapshot({
    catalog,
    checkedAt,
    health: { ok: boxHealth.ok, status: boxHealth.status, body: boxHealth.body },
    info: { ok: true, status: 200, body: buildStaticRuntimeInfo(version, networkOverride) },
  });
}
